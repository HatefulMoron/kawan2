import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { KawanDb } from "./db.js";
import {
  branchTouchesKawanDir,
  commitsAhead,
  commitsBehindMain,
  getHeadSha,
  getSessionDiff,
  isWorkingTreeClean,
  runRepoChecks,
  syncBranchWithMain,
} from "./git.js";
import type { MergeQueueManager } from "./merge-queue.js";
import type { SessionManager } from "./sessions.js";
import { deriveTaskTitle } from "./sessions.js";
import type {
  ActiveReviewerInfo,
  ConversationRow,
  IssueRow,
  IssueStatus,
  LandRow,
  MessageRow,
  SerializedIssue,
  SerializedLand,
  SessionRow,
  UserRow,
} from "./types.js";
import { serializeLand, serializeMessage } from "./types.js";
import type { KawanWsServer } from "./ws.js";

export class IssueManager {
  private readonly dataDir: string;
  private readonly db: KawanDb;
  private readonly wsServer: KawanWsServer;
  private readonly sessionManager: SessionManager;
  private readonly mergeQueue: MergeQueueManager;
  private readonly disableSandbox: boolean;
  private closed = false;
  private activeReviewers = new Map<string, Map<string, ActiveReviewerInfo>>();
  private activeReviewerRuns = new Set<Promise<void>>();
  private runningChecks = new Map<string, Promise<void>>();

  constructor(opts: {
    dataDir: string;
    db: KawanDb;
    wsServer: KawanWsServer;
    sessionManager: SessionManager;
    mergeQueue: MergeQueueManager;
    disableSandbox?: boolean;
  }) {
    this.dataDir = opts.dataDir;
    this.db = opts.db;
    this.wsServer = opts.wsServer;
    this.sessionManager = opts.sessionManager;
    this.mergeQueue = opts.mergeQueue;
    this.disableSandbox = Boolean(opts.disableSandbox);

    this.sessionManager.setIssueHandlers({
      createIssue: async (session, input) => {
        const res = this.createIssue({
          title: input.title,
          bodyMd: input.body_md,
          ownerId: input.owner_id,
          implementerBotId: input.implementer_bot_id,
          parentIssueId: input.parent_issue_id,
          actingBotId: session.bot_id,
        });
        return { issue: res.issue };
      },
      updateIssue: async (session, input) => {
        const issue = this.updateIssue(input.issue_ref, {
          title: input.title,
          body_md: input.body_md,
          implementer_bot_id: input.implementer_bot_id,
          parent_issue_id: input.parent_issue_id,
          actingBotId: session.bot_id,
        });
        return { issue };
      },
      listIssues: (status) => {
        return {
          issues: this.listIssues(status ? { status: status as IssueStatus } : undefined),
        };
      },
      askOwner: async (session, question) => {
        return await this.handleAskOwner(session, question);
      },
      syncWithMain: async (session) => {
        const issue = this.db.getIssueBySessionId(session.id);
        if (!issue) {
          throw new Error("sync_with_main is only available inside an issue session");
        }
        return await this.syncWithMain(issue.id, { fromWorkerTool: true });
      },
      bindWorkerSession: (issueId, botId, sessionId) => {
        this.bindWorkerSession(issueId, botId, sessionId);
      },
      startReadOnlyReview: async (input) => {
        return await this.startReadOnlyReview(input);
      },
      onIssueWorkerTurnCompleted: async (issue, session) => {
        await this.onWorkerTurnCompleted(issue, session);
      },
    });

    this.mergeQueue.setIssueSyncCallback((land) => {
      this.onLandStatusChanged(land);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const issueIds = [...this.activeReviewers.keys()];
    await Promise.all(issueIds.map((id) => this.cancelActiveReviewers(id)));
    await Promise.allSettled([...this.activeReviewerRuns, ...this.runningChecks.values()]);
  }

  serializeIssue(issue: IssueRow): SerializedIssue {
    const base = this.db.serializeIssue(issue);
    const reviewersMap = this.activeReviewers.get(issue.id);
    return {
      ...base,
      active_reviewers: reviewersMap ? [...reviewersMap.values()] : [],
    };
  }

  private async cancelActiveReviewers(issueId: string): Promise<void> {
    const active = this.activeReviewers.get(issueId);
    if (!active || active.size === 0) {
      this.activeReviewers.delete(issueId);
      return;
    }
    const sessionIds = [...active.keys()];
    this.activeReviewers.delete(issueId);
    await Promise.allSettled(sessionIds.map((sid) => this.sessionManager.stopSession(sid)));
    const refreshed = this.db.getIssue(issueId);
    if (refreshed && !this.closed) {
      this.broadcastIssue(this.serializeIssue(refreshed));
    }
  }

  resolveIssueRef(ref: string | number): IssueRow {
    if (typeof ref === "number" && Number.isFinite(ref)) {
      const byNum = this.db.getIssueByNumber(Math.floor(ref));
      if (byNum) return byNum;
    }
    const raw = String(ref ?? "").trim();
    const cleaned = raw.startsWith("#") ? raw.slice(1) : raw;
    if (/^\d+$/.test(cleaned)) {
      const byNum = this.db.getIssueByNumber(Number.parseInt(cleaned, 10));
      if (byNum) return byNum;
    }
    const byId = this.db.getIssue(raw);
    if (byId) return byId;
    throw new Error(`Issue not found: ${ref}`);
  }

  private defaultOwnerId(preferred?: string | null): string {
    if (preferred) {
      const u = this.db.getUser(preferred);
      if (u && u.kind === "human") return u.id;
    }
    const admin = this.db.listUsers("human").find((u) => u.role === "admin");
    if (admin) return admin.id;
    const firstHuman = this.db.listUsers("human")[0];
    if (firstHuman) return firstHuman.id;
    const firstUser = this.db.listUsers()[0];
    if (!firstUser) throw new Error("No users exist in host database");
    return firstUser.id;
  }

  private buildIssueConvPayload(conv: ConversationRow, userId?: string) {
    const lastSeq = conv.next_seq - 1;
    const lastRead = userId ? this.db.getReadCursor(userId, conv.id) : 0;
    return {
      ...conv,
      last_seq: lastSeq,
      last_read_seq: lastRead,
      unread_count: Math.max(0, lastSeq - lastRead),
      members: this.db.listMembers(conv.id).map((m) => ({
        id: m.id,
        kind: m.kind,
        name: m.name,
        role: m.role,
      })),
    };
  }

  private broadcastIssue(issue: SerializedIssue): void {
    this.wsServer.broadcast({ type: "issue.update", issue });
  }

  private postHostNote(
    conv: ConversationRow,
    bot: UserRow,
    body: string,
    attachmentIds: string[] = [],
  ): MessageRow {
    const msg = this.db.appendMessage({
      conversationId: conv.id,
      authorId: bot.id,
      body,
      attachmentIds,
    });
    // Host-authored notices bypass routing: they are never sent to a bot.
    this.wsServer.broadcastToConversation(conv, {
      type: "message.new",
      message: serializeMessage(msg),
      author: { id: bot.id, kind: "bot", name: bot.name },
    });
    return msg;
  }

  private async refreshGitMetrics(issue: IssueRow): Promise<{
    issue: IssueRow;
    clean: boolean;
    headSha: string | null;
  }> {
    const sess = issue.active_session_id ? this.db.getSession(issue.active_session_id) : null;
    const settings = this.db.getHostSettings();
    if (!sess?.clone_path || !existsSync(sess.clone_path) || !settings.repo?.bare_path) {
      return { issue, clean: true, headSha: null };
    }
    const defaultBranch = settings.repo.default_branch;
    const [clean, ahead, behind, headSha, touchesKawan] = await Promise.all([
      isWorkingTreeClean(sess.clone_path),
      commitsAhead(sess.clone_path, defaultBranch),
      commitsBehindMain(settings.repo.bare_path, sess.clone_path, defaultBranch),
      getHeadSha(sess.clone_path),
      branchTouchesKawanDir(sess.clone_path, defaultBranch),
    ]);

    const changed =
      ahead !== issue.commits_ahead ||
      behind !== issue.behind_main ||
      Boolean(touchesKawan) !== Boolean(issue.touches_kawan);

    if (changed) {
      const updated = this.db.updateIssue(issue.id, {
        commits_ahead: ahead,
        behind_main: behind,
        touches_kawan: touchesKawan,
      })!;
      this.broadcastIssue(this.serializeIssue(updated));
      return { issue: updated, clean, headSha };
    }
    return { issue, clean, headSha };
  }

  createIssue(input: {
    title: string;
    bodyMd?: string;
    ownerId?: string | null;
    implementerBotId?: string | null;
    parentIssueId?: string | null;
    actingBotId?: string | null;
  }): { issue: SerializedIssue; conversation: ConversationRow } {
    const title = input.title.trim();
    if (!title) throw new Error("Issue title is required");

    const ownerId = this.defaultOwnerId(input.ownerId);
    const implBotId = input.implementerBotId?.trim() || null;
    if (implBotId) {
      const impl = this.db.getUser(implBotId);
      if (!impl || impl.kind !== "bot") {
        throw new Error(`Implementer bot not found: ${implBotId}`);
      }
    }

    const parentId = input.parentIssueId ? this.resolveIssueRef(input.parentIssueId).id : null;
    const memberIds = new Set<string>(this.db.listUsers().map((u) => u.id));
    if (implBotId) memberIds.add(implBotId);
    if (input.actingBotId) memberIds.add(input.actingBotId);

    const { issueRow, conv } = this.db.transaction(() => {
      const num = this.db.nextIssueNumber();
      const conversation = this.db.createConversation({
        kind: "issue",
        name: `issue-${num}`,
        topic: title,
        memberIds: [...memberIds],
      });
      const created = this.db.createIssue({
        number: num,
        conversationId: conversation.id,
        title,
        bodyMd: input.bodyMd ?? "",
        status: "open",
        ownerId,
        implementerBotId: implBotId,
        parentIssueId: parentId,
      });
      return { issueRow: created, conv: conversation };
    });

    const serialized = this.serializeIssue(issueRow);
    this.wsServer.broadcastToConversation(conv, {
      type: "conversation.new",
      conversation: this.buildIssueConvPayload(conv),
    });
    this.broadcastIssue(serialized);
    return { issue: serialized, conversation: conv };
  }

  listIssues(filter?: { status?: IssueStatus; ownerId?: string }): SerializedIssue[] {
    return this.db.listIssues(filter).map((i) => this.serializeIssue(i));
  }

  updateIssue(
    issueRef: string | number,
    patch: {
      title?: string;
      body_md?: string;
      owner_id?: string;
      implementer_bot_id?: string | null;
      parent_issue_id?: string | null;
      actingBotId?: string | null;
    },
  ): SerializedIssue {
    const existing = this.resolveIssueRef(issueRef);
    const nextTitle = patch.title !== undefined ? patch.title.trim() : existing.title;
    if (!nextTitle) throw new Error("Issue title cannot be empty");

    if (patch.owner_id !== undefined && !this.db.getUser(patch.owner_id)) {
      throw new Error(`Owner not found: ${patch.owner_id}`);
    }
    if (patch.implementer_bot_id) {
      const impl = this.db.getUser(patch.implementer_bot_id);
      if (!impl || impl.kind !== "bot") {
        throw new Error(`Implementer bot not found: ${patch.implementer_bot_id}`);
      }
      this.db.addMember(existing.conversation_id, impl.id);
    } else if (patch.actingBotId) {
      this.db.addMember(existing.conversation_id, patch.actingBotId);
    }
    const parentId =
      patch.parent_issue_id === undefined
        ? existing.parent_issue_id
        : patch.parent_issue_id === null || patch.parent_issue_id === ""
          ? null
          : this.resolveIssueRef(patch.parent_issue_id).id;

    const updated = this.db.transaction(() => {
      const row = this.db.updateIssue(existing.id, {
        title: nextTitle,
        body_md: patch.body_md,
        owner_id: patch.owner_id,
        implementer_bot_id: patch.implementer_bot_id,
        parent_issue_id: parentId,
      })!;
      if (patch.title !== undefined) {
        this.db.updateConversationTopic(existing.conversation_id, nextTitle);
      }
      return row;
    });

    const serialized = this.serializeIssue(updated);
    this.broadcastIssue(serialized);
    return serialized;
  }

  bindWorkerSession(issueId: string, botId: string, sessionId: string): void {
    const issue = this.db.getIssue(issueId);
    if (!issue) return;
    this.db.addMember(issue.conversation_id, botId);
    const updated = this.db.updateIssue(issue.id, {
      implementer_bot_id: botId,
      active_session_id: sessionId,
      behind_main: 0,
      commits_ahead: 0,
      checks_status: "none",
      checks_sha: null,
      checks_summary: null,
      checks_json: null,
      checks_artifact_id: null,
      touches_kawan: false,
      needs_input_question: null,
    })!;
    this.broadcastIssue(this.serializeIssue(updated));
  }

  async openIssue(issueRef: string | number, userId: string) {
    let issue = this.resolveIssueRef(issueRef);
    const conv = this.db.getConversation(issue.conversation_id);
    if (!conv) throw new Error(`Conversation missing for issue #${issue.number}`);

    const refreshed = await this.refreshGitMetrics(issue);
    issue = refreshed.issue;

    if (
      issue.status === "open" &&
      refreshed.clean &&
      issue.commits_ahead >= 1 &&
      refreshed.headSha &&
      refreshed.headSha !== issue.checks_sha &&
      !this.runningChecks.has(issue.id)
    ) {
      void this.runImplicitChecks(issue.id).catch(() => {});
    }

    const sess = issue.active_session_id ? this.db.getSession(issue.active_session_id) : null;
    const lastSeq = conv.next_seq - 1;
    const cursor = this.db.markConversationRead(userId, conv.id, lastSeq);
    const unreadCount = Math.max(0, lastSeq - cursor.last_read_seq);
    this.wsServer.broadcast(
      {
        type: "read_cursor.update",
        conversation_id: conv.id,
        last_read_seq: cursor.last_read_seq,
        unread_count: unreadCount,
      },
      (u) => u.id === userId,
    );

    const members = this.db.listMembers(conv.id).map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name,
      role: m.role,
    }));
    const messages = this.db.listMessages(conv.id, 0);
    const decisions = this.db.listDecisions(conv.id, 0);
    const sessions = this.db
      .listSessions({ conversationId: conv.id })
      .map((s) => this.sessionManager.serializePublicSession(s));
    const convArtifacts = this.db.listArtifacts({ conversationId: conv.id });
    const sessArtifacts = sess ? this.db.listArtifacts({ sessionId: sess.id }) : [];
    const seenArt = new Set<string>();
    const artifacts = [...convArtifacts, ...sessArtifacts].filter((a) => {
      if (seenArt.has(a.id)) return false;
      seenArt.add(a.id);
      return true;
    });
    const lands = this.db.listLands({ conversationId: conv.id }).map(serializeLand);

    return {
      issue: this.serializeIssue(issue),
      conversation: {
        ...conv,
        last_seq: lastSeq,
        last_read_seq: cursor.last_read_seq,
        unread_count: unreadCount,
      },
      members,
      messages,
      decisions,
      sessions,
      artifacts,
      lands,
    };
  }

  private async onWorkerTurnCompleted(issue: IssueRow, session: SessionRow): Promise<void> {
    if (this.closed) return;
    if (issue.active_session_id !== session.id) return;

    const refreshed = await this.refreshGitMetrics(issue);
    let current = refreshed.issue;
    if (current.status !== "open") return;

    if (
      refreshed.clean &&
      current.commits_ahead >= 1 &&
      refreshed.headSha &&
      refreshed.headSha !== current.checks_sha
    ) {
      await this.runImplicitChecks(current.id);
      if (this.closed) return;
      current = this.db.getIssue(current.id) ?? current;
      const conv = this.db.getConversation(current.conversation_id);
      const bot = this.db.getUser(session.bot_id);
      if (conv && bot) {
        const aheadLabel = `${current.commits_ahead} commit${current.commits_ahead === 1 ? "" : "s"} ahead`;
        if (current.checks_status === "passed") {
          this.postHostNote(
            conv,
            bot,
            `Checkpoint: ${aheadLabel} · Checks passed (${current.checks_summary ?? "ok"}).`,
            current.checks_artifact_id ? [current.checks_artifact_id] : [],
          );
        } else if (current.checks_status === "failed") {
          this.postHostNote(
            conv,
            bot,
            `Checkpoint: ${aheadLabel} · Checks failed (${current.checks_summary ?? "failed"}).`,
            current.checks_artifact_id ? [current.checks_artifact_id] : [],
          );
        } else {
          this.postHostNote(conv, bot, `Checkpoint: ${aheadLabel}.`);
        }
      }
    }
  }

  async runImplicitChecks(issueId: string): Promise<void> {
    const existing = this.runningChecks.get(issueId);
    if (existing) {
      return await existing;
    }

    const promise = (async () => {
      if (this.closed) return;
      const issue = this.db.getIssue(issueId);
      if (!issue || issue.status !== "open" || !issue.active_session_id) return;

      const sess = this.db.getSession(issue.active_session_id);
      const settings = this.db.getHostSettings();
      if (!sess?.clone_path || !existsSync(sess.clone_path) || !settings.repo?.bare_path) return;
      const bot = this.db.getUser(sess.bot_id);
      if (!bot) return;

      const clean = await isWorkingTreeClean(sess.clone_path);
      if (!clean) return;
      const [ahead, behind, headSha, touchesKawan] = await Promise.all([
        commitsAhead(sess.clone_path, settings.repo.default_branch),
        commitsBehindMain(settings.repo.bare_path, sess.clone_path, settings.repo.default_branch),
        getHeadSha(sess.clone_path),
        branchTouchesKawanDir(sess.clone_path, settings.repo.default_branch),
      ]);
      if (ahead < 1 || !headSha) return;

      const runningRow = this.db.updateIssue(issue.id, {
        commits_ahead: ahead,
        behind_main: behind,
        touches_kawan: touchesKawan,
        checks_status: "running",
      })!;
      if (!this.closed) {
        this.broadcastIssue(this.serializeIssue(runningRow));
      }

      const checkRes = await runRepoChecks({
        workdir: sess.clone_path,
        verifyCommand: settings.verify_command,
        sandboxEnabled: Boolean(bot.sandbox_enabled),
        sandboxNetwork: Boolean(bot.sandbox_network),
        disableSandbox: this.disableSandbox,
        allowUnconfigured: true,
      });

      if (this.closed) return;
      const conv = this.db.getConversation(issue.conversation_id);

      if (checkRes.source === "none") {
        const updated = this.db.updateIssue(issue.id, {
          checks_status: "none",
          checks_sha: headSha,
          checks_summary: null,
          checks_json: null,
          checks_artifact_id: null,
        })!;
        this.broadcastIssue(this.serializeIssue(updated));
        return;
      }

      let artifactId: string | null = null;
      if (checkRes.combined_output.trim()) {
        const art = this.sessionManager.createTextArtifact({
          content: checkRes.combined_output,
          filename: `checks-${headSha.slice(0, 7)}.log`,
          sessionId: sess.id,
          conversationId: issue.conversation_id,
        });
        artifactId = art.id;
        if (conv) {
          this.wsServer.broadcastToConversation(conv, { type: "artifact.new", artifact: art });
        }
      }

      const updated = this.db.updateIssue(issue.id, {
        checks_status: checkRes.ok ? "passed" : "failed",
        checks_sha: headSha,
        checks_summary: checkRes.summary,
        checks_json: JSON.stringify(checkRes.checks),
        checks_artifact_id: artifactId,
      })!;
      this.broadcastIssue(this.serializeIssue(updated));
    })().finally(() => {
      if (this.runningChecks.get(issueId) === promise) {
        this.runningChecks.delete(issueId);
      }
    });

    this.runningChecks.set(issueId, promise);
    await promise;
  }

  async startReadOnlyReview(input: {
    issueRef: string | number;
    bot: UserRow;
    focus?: string | null;
  }): Promise<{ session_id: string; issue_id: string; number: number; status: string }> {
    const issue = this.resolveIssueRef(input.issueRef);
    if (issue.status !== "open") {
      throw new Error(`Issue #${issue.number} is ${issue.status}; only open issues can be reviewed`);
    }
    const sess = issue.active_session_id ? this.db.getSession(issue.active_session_id) : null;
    if (!sess || !sess.clone_path || !existsSync(sess.clone_path)) {
      throw new Error(`Issue #${issue.number} does not have an active branch clone to review yet`);
    }
    const settings = this.db.getHostSettings();
    if (!settings.repo?.bare_path) {
      throw new Error("Repository is not configured");
    }

    const conv = this.db.getConversation(issue.conversation_id);
    if (!conv) throw new Error(`Conversation missing for issue #${issue.number}`);
    this.db.addMember(conv.id, input.bot.id);

    const implBot = issue.implementer_bot_id ? this.db.getUser(issue.implementer_bot_id) : null;
    const focusLine = input.focus?.trim() ? `Review focus: ${input.focus.trim()}` : "Review focus: General code quality, correctness, edge cases, and spec alignment.";

    const diff = await getSessionDiff({
      barePath: settings.repo.bare_path,
      defaultBranch: settings.repo.default_branch,
      clonePath: sess.clone_path,
    });
    const diffExcerpt = diff.available
      ? diff.files
          .slice(0, 12)
          .map(
            (f) =>
              `### ${f.path} (${f.status}, +${f.insertions}/-${f.deletions})\n\`\`\`diff\n${f.patch.slice(0, 2000)}\n\`\`\``,
          )
          .join("\n\n")
      : `Diff unavailable (${diff.note ?? "no commits yet"}).`;

    let checkExcerpt = "";
    if (issue.checks_status === "failed" && issue.checks_artifact_id) {
      const art = this.db.getArtifact(issue.checks_artifact_id);
      if (art) {
        const p = join(this.dataDir, "artifacts", art.sha256);
        if (existsSync(p)) {
          checkExcerpt = `\n\nLatest check log excerpt:\n\`\`\`\n${readFileSync(p, "utf8").slice(-1500)}\n\`\`\``;
        }
      }
    }

    const systemPrompt = [
      `You are ${input.bot.name}, acting as a read-only code reviewer for Issue #${issue.number}: "${issue.title}".`,
      focusLine,
      "Constraints:",
      "- You are running inside a READ-ONLY view of the implementer branch clone (no bash/edit/write tools).",
      "- You can inspect files cleanly via read/grep/find/ls and inspect kawan://issue.md and kawan://soul.md.",
      "- Post your concrete findings (or concise sign-off if everything looks solid) directly to the issue room via report(text, artifact?) or a direct reply.",
      implBot && implBot.id !== input.bot.id
        ? `- Address @${implBot.name} when requesting concrete code changes so they see your feedback and can fix it on their branch.`
        : "- Be concrete and reference file paths, behaviors, and edge cases.",
    ].join("\n");

    const recentMsgs = this.db.listRecentMessages(conv.id, 10).map((m) => {
      const u = this.db.getUser(m.author_id);
      return `${u?.name ?? "user"}: ${m.body}`;
    });

    const promptText = [
      `# Read-only review request for Issue #${issue.number}: ${issue.title}`,
      focusLine,
      `Branch: ${sess.branch ?? "(local)"} (${issue.commits_ahead} commit${issue.commits_ahead === 1 ? "" : "s"} ahead of ${settings.repo.default_branch})`,
      `Latest checks: ${issue.checks_status}${issue.checks_summary ? ` (${issue.checks_summary})` : ""}${checkExcerpt}`,
      "",
      "Check kawan://issue.md for the full current Markdown specification.",
      "",
      "## Branch Diff",
      diffExcerpt,
      "",
      ...(recentMsgs.length > 0 ? ["## Recent Discussion", ...recentMsgs, ""] : []),
      "Inspect any files needed in the repo and post your review directly into this room.",
    ].join("\n");

    let resolveCreated!: (sid: string) => void;
    let rejectCreated!: (err: Error) => void;
    const createdPromise = new Promise<string>((resolve, reject) => {
      resolveCreated = resolve;
      rejectCreated = reject;
    });

    let createdSid: string | null = null;
    const runPromise = (async () => {
      try {
        await this.sessionManager.runReviewerSession({
          bot: input.bot,
          issue,
          round: 1,
          focus: input.focus?.trim() || null,
          clonePath: sess.clone_path!,
          systemPrompt,
          promptText,
          onSessionCreated: (sid) => {
            createdSid = sid;
            let map = this.activeReviewers.get(issue.id);
            if (!map) {
              map = new Map();
              this.activeReviewers.set(issue.id, map);
            }
            map.set(sid, {
              session_id: sid,
              bot_id: input.bot.id,
              bot_name: input.bot.name,
              focus: input.focus?.trim() || null,
            });
            const latest = this.db.getIssue(issue.id);
            if (latest && !this.closed) {
              this.broadcastIssue(this.serializeIssue(latest));
            }
            resolveCreated(sid);
          },
        });
      } catch (err) {
        if (!createdSid) {
          rejectCreated(err instanceof Error ? err : new Error(String(err)));
        }
        if (!this.closed) {
          this.wsServer.broadcastToConversation(conv, {
            type: "error",
            conversation_id: conv.id,
            ...(createdSid ? { session_id: createdSid } : {}),
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (createdSid) {
          const map = this.activeReviewers.get(issue.id);
          if (map?.delete(createdSid) && map.size === 0) {
            this.activeReviewers.delete(issue.id);
          }
          const latest = this.db.getIssue(issue.id);
          if (latest && !this.closed) {
            this.broadcastIssue(this.serializeIssue(latest));
          }
        }
      }
    })();

    const tracked = runPromise.finally(() => {
      this.activeReviewerRuns.delete(tracked);
    });
    this.activeReviewerRuns.add(tracked);

    const sessionId = await createdPromise;
    return {
      session_id: sessionId,
      issue_id: issue.id,
      number: issue.number,
      status: "running",
    };
  }

  async promoteSessionToIssue(params: {
    sessionId: string;
    title?: string;
    bodyMd?: string;
    ownerId?: string;
  }): Promise<{ issue: SerializedIssue; conversation: ConversationRow }> {
    const existing = this.db.getIssueBySessionId(params.sessionId);
    if (existing) {
      const conv = this.db.getConversation(existing.conversation_id)!;
      return { issue: this.serializeIssue(existing), conversation: conv };
    }

    const session = this.db.getSession(params.sessionId);
    if (!session || session.kind !== "worker") {
      throw new Error(`Worker session not found: ${params.sessionId}`);
    }
    const bot = this.db.getUser(session.bot_id);
    if (!bot) throw new Error(`Bot not found for session: ${session.bot_id}`);

    const originConvId = session.conversation_id;
    const originThreadId = session.thread_id;
    const lands = this.db.listLands({ sessionId: session.id });
    const latestLand = lands.at(-1) ?? null;

    const derivedStatus: IssueStatus =
      latestLand?.status === "landed" || session.status === "landed" ? "landed" : "open";

    const title = params.title?.trim() || deriveTaskTitle(session.task, session.title);
    const bodyMd = params.bodyMd !== undefined ? params.bodyMd : (session.task ?? "");
    const ownerId = this.defaultOwnerId(params.ownerId);
    const memberIds = new Set<string>(this.db.listUsers().map((u) => u.id));
    memberIds.add(session.bot_id);

    const settings = this.db.getHostSettings();
    let behindMain = 0;
    let aheadMain = 0;
    let touchesKawan = false;
    let clean = false;
    if (
      session.clone_path &&
      existsSync(session.clone_path) &&
      settings.repo?.bare_path &&
      derivedStatus === "open"
    ) {
      [clean, aheadMain, behindMain, touchesKawan] = await Promise.all([
        isWorkingTreeClean(session.clone_path),
        commitsAhead(session.clone_path, settings.repo.default_branch),
        commitsBehindMain(settings.repo.bare_path, session.clone_path, settings.repo.default_branch),
        branchTouchesKawanDir(session.clone_path, settings.repo.default_branch),
      ]);
    }

    const { issueRow, conv, updatedSession, updatedLands } = this.db.transaction(() => {
      const num = this.db.nextIssueNumber();
      const conversation = this.db.createConversation({
        kind: "issue",
        name: `issue-${num}`,
        topic: title,
        memberIds: [...memberIds],
      });
      const created = this.db.createIssue({
        number: num,
        conversationId: conversation.id,
        title,
        bodyMd,
        status: derivedStatus,
        ownerId,
        implementerBotId: session.bot_id,
        activeSessionId: session.id,
        behindMain,
        commitsAhead: aheadMain,
        touchesKawan,
      });
      const sessUpd = this.db.updateSession(session.id, {
        conversation_id: conversation.id,
        thread_id: null,
      })!;
      const landUpdates: LandRow[] = [];
      for (const l of lands) {
        const lu = this.db.updateLand(l.id, {
          issue_id: created.id,
          ...(l.status !== "landed"
            ? { conversation_id: conversation.id, thread_id: null }
            : {}),
        })!;
        landUpdates.push(lu);
      }
      return { issueRow: created, conv: conversation, updatedSession: sessUpd, updatedLands: landUpdates };
    });

    this.wsServer.broadcastToConversation(conv, {
      type: "conversation.new",
      conversation: this.buildIssueConvPayload(conv),
    });
    this.wsServer.broadcast({
      type: "session.update",
      session: this.sessionManager.serializePublicSession(updatedSession),
    });
    for (const lu of updatedLands) {
      this.wsServer.broadcast({ type: "land.update", land: serializeLand(lu) });
    }

    this.postHostNote(
      conv,
      bot,
      `Promoted worker session (\`${session.branch ?? session.id.slice(0, 8)}\`) into Issue #${issueRow.number}.`,
    );
    if (originConvId) {
      const originConv = this.db.getConversation(originConvId);
      if (originConv) {
        const msg = this.db.appendMessage({
          conversationId: originConv.id,
          authorId: bot.id,
          threadId: originThreadId,
          body: `Promoted "${title}" to Issue #${issueRow.number}. Continue collaboration in #${issueRow.number}.`,
        });
        this.wsServer.broadcastToConversation(originConv, {
          type: "message.new",
          message: msg,
          author: { id: bot.id, kind: "bot", name: bot.name },
        });
      }
    }

    const serialized = this.serializeIssue(issueRow);
    this.broadcastIssue(serialized);
    if (derivedStatus === "open" && clean && aheadMain >= 1) {
      void this.runImplicitChecks(issueRow.id).catch(() => {});
    }
    return { issue: serialized, conversation: conv };
  }

  async syncWithMain(
    issueRef: string | number,
    opts?: { fromWorkerTool?: boolean },
  ): Promise<{
    ok: boolean;
    behind_before: number;
    behind_after: number;
    error?: string;
    issue: SerializedIssue;
  }> {
    let issue = this.resolveIssueRef(issueRef);
    const settings = this.db.getHostSettings();
    if (!settings.repo?.bare_path) {
      throw new Error("Repository is not configured");
    }
    const sess = issue.active_session_id ? this.db.getSession(issue.active_session_id) : null;
    if (!sess || !sess.clone_path || !existsSync(sess.clone_path)) {
      throw new Error("No active worker clone to sync with main");
    }
    if (!opts?.fromWorkerTool && sess.status === "running") {
      throw new Error("Stop the active turn before syncing with main");
    }

    const res = await syncBranchWithMain({
      barePath: settings.repo.bare_path,
      clonePath: sess.clone_path,
      defaultBranch: settings.repo.default_branch,
    });
    const [ahead, touchesKawan] = await Promise.all([
      commitsAhead(sess.clone_path, settings.repo.default_branch),
      branchTouchesKawanDir(sess.clone_path, settings.repo.default_branch),
    ]);
    issue = this.db.updateIssue(issue.id, {
      behind_main: res.behindAfter,
      commits_ahead: ahead,
      touches_kawan: touchesKawan,
    })!;
    const serialized = this.serializeIssue(issue);
    this.broadcastIssue(serialized);

    const conv = this.db.getConversation(issue.conversation_id);
    const bot = this.db.getUser(sess.bot_id);
    if (conv && bot) {
      const text = res.ok
        ? res.behindBefore === 0
          ? `Branch is already up to date with \`${settings.repo.default_branch}\`.`
          : `Synced with \`${settings.repo.default_branch}\` (rebased ${res.behindBefore} commit${res.behindBefore === 1 ? "" : "s"} cleanly).`
        : `Sync with \`${settings.repo.default_branch}\` failed cleanly without mutating working tree: ${res.error ?? "merge conflict"}`;
      this.postHostNote(conv, bot, text);
    }

    if (res.ok && res.behindBefore > 0 && ahead >= 1 && issue.status === "open") {
      void this.runImplicitChecks(issue.id).catch(() => {});
    }

    return {
      ok: res.ok,
      behind_before: res.behindBefore,
      behind_after: res.behindAfter,
      error: res.error,
      issue: serialized,
    };
  }

  /**
   * Issue room **Propose**: the same proposal path as everywhere else, with
   * `lands.issue_id` set. It creates or amends the issue branch's proposal; it
   * never enqueues. A human (or auto mode) accepts it from #merge-queue.
   */
  async proposeIssue(issueRef: string | number): Promise<{
    issue: SerializedIssue;
    land: SerializedLand;
    message: MessageRow;
    created: boolean;
  }> {
    const issue = this.resolveIssueRef(issueRef);
    if (issue.status !== "open") {
      throw new Error(`Issue #${issue.number} is ${issue.status}, not open`);
    }
    const settings = this.db.getHostSettings();
    if (!settings.repo?.bare_path) {
      throw new Error("Repository is not configured");
    }
    const sess = issue.active_session_id ? this.db.getSession(issue.active_session_id) : null;
    if (!sess || !sess.clone_path || !existsSync(sess.clone_path) || !sess.branch) {
      throw new Error(`Issue #${issue.number} has no active branch to propose`);
    }
    if (sess.status === "running") {
      throw new Error("Wait for the active worker turn to finish (or Stop it) before proposing");
    }
    const clean = await isWorkingTreeClean(sess.clone_path);
    if (!clean) {
      throw new Error("Worker clone has uncommitted changes; commit before proposing");
    }
    const ahead = await commitsAhead(sess.clone_path, settings.repo.default_branch);
    if (ahead < 1) {
      throw new Error(
        `Branch has 0 commits ahead of ${settings.repo.default_branch}; commit changes before proposing`,
      );
    }

    await this.cancelActiveReviewers(issue.id);

    const touchesKawan = await branchTouchesKawanDir(sess.clone_path, settings.repo.default_branch);
    const updatedIssue = this.db.updateIssue(issue.id, {
      commits_ahead: ahead,
      touches_kawan: touchesKawan,
    })!;
    this.broadcastIssue(this.serializeIssue(updatedIssue));

    const summary =
      sess.last_report?.trim() || `Implements #${issue.number}: ${issue.title}`;
    const result = await this.mergeQueue.proposeLand({
      sessionId: sess.id,
      bodyMd: summary,
      title: `#${issue.number} ${issue.title}`,
      issueId: issue.id,
    });

    const latest = this.db.getIssue(issue.id) ?? updatedIssue;
    return {
      issue: this.serializeIssue(latest),
      land: serializeLand(result.land),
      message: result.message,
      created: result.created,
    };
  }

  async handleAskOwner(
    session: SessionRow,
    question: string,
  ): Promise<{ issue_id: string; number: number; status: IssueStatus }> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error("question cannot be empty");
    const issue = this.db.getIssueBySessionId(session.id);
    if (!issue) {
      throw new Error("ask_owner can only be called from an issue session");
    }
    const bot = this.db.getUser(session.bot_id);
    if (!bot) throw new Error("Bot not found");
    const owner = this.db.getUser(issue.owner_id);
    const conv = this.db.getConversation(issue.conversation_id);
    if (!conv) throw new Error("Issue conversation not found");

    const updated = this.db.updateIssue(issue.id, {
      needs_input_question: trimmed,
    })!;
    this.sessionManager.markTurnReported(session.id);
    this.postHostNote(conv, bot, `@${owner?.name ?? "owner"}: ${trimmed}`);
    this.broadcastIssue(this.serializeIssue(updated));
    return { issue_id: updated.id, number: updated.number, status: updated.status };
  }

  tryRouteNeedsInputReply(
    conversation: ConversationRow,
    message: MessageRow,
    author: UserRow,
  ): boolean {
    if (conversation.kind !== "issue" || author.kind !== "human") return false;
    const issue = this.db.getIssueByConversationId(conversation.id);
    if (!issue || issue.status !== "open" || !issue.needs_input_question || !issue.active_session_id) {
      return false;
    }
    if (author.id !== issue.owner_id && author.role !== "admin") {
      return false;
    }
    const sess = this.db.getSession(issue.active_session_id);
    if (!sess || !sess.clone_path || !existsSync(sess.clone_path)) {
      return false;
    }

    const updated = this.db.updateIssue(issue.id, {
      needs_input_question: null,
    })!;
    this.broadcastIssue(this.serializeIssue(updated));

    const prompt = [
      `[Owner ${author.name} answered your question in Issue #${updated.number}]:`,
      message.body,
      "",
      "Continue implementation cleanly based on the owner's guidance.",
    ].join("\n");
    void this.sessionManager.resumeIssueWorker(sess.id, prompt).catch((err) => {
      this.wsServer.broadcastToConversation(conversation, {
        type: "error",
        conversation_id: conversation.id,
        session_id: sess.id,
        message: err instanceof Error ? err.message : String(err),
      });
    });
    return true;
  }

  async stopIssue(issueRef: string | number): Promise<SerializedIssue> {
    const issue = this.resolveIssueRef(issueRef);
    await this.cancelActiveReviewers(issue.id);
    if (issue.active_session_id) {
      await this.sessionManager.stopWorkerSession(issue.active_session_id);
    }
    const refreshed = this.db.getIssue(issue.id)!;
    const serialized = this.serializeIssue(refreshed);
    this.broadcastIssue(serialized);
    return serialized;
  }

  async closeIssue(issueRef: string | number, abandon = false): Promise<SerializedIssue> {
    const issue = this.resolveIssueRef(issueRef);
    await this.cancelActiveReviewers(issue.id);
    if (issue.active_session_id) {
      const lands = this.db.listLands({ sessionId: issue.active_session_id });
      for (const l of lands) {
        if (
          l.status === "queued" ||
          l.status === "rebasing" ||
          l.status === "verifying" ||
          l.status === "paused"
        ) {
          await this.mergeQueue.removeFromQueue(l.id);
        }
      }
      await this.sessionManager.stopWorkerSession(issue.active_session_id);
      const sess = this.db.getSession(issue.active_session_id);
      if (sess?.clone_path && (abandon || issue.status !== "landed")) {
        rmSync(sess.clone_path, { recursive: true, force: true });
      }
    }

    const updated = this.db.updateIssue(issue.id, {
      status: "closed",
      needs_input_question: null,
    })!;
    const conv = this.db.getConversation(updated.conversation_id);
    const botId = updated.implementer_bot_id ?? this.db.listUsers("bot")[0]?.id;
    const bot = botId ? this.db.getUser(botId) : null;
    if (conv && bot) {
      this.postHostNote(
        conv,
        bot,
        abandon
          ? `Abandoned and closed Issue #${updated.number} (worker clone cleaned up).`
          : `Closed Issue #${updated.number}.`,
      );
    }
    const serialized = this.serializeIssue(updated);
    this.broadcastIssue(serialized);
    return serialized;
  }

  onLandStatusChanged(land: LandRow): void {
    if (!land.issue_id) return;
    const issue = this.db.getIssue(land.issue_id);
    if (!issue || issue.status === "closed") return;

    if (land.status === "landed") {
      if (issue.status !== "landed") {
        const updated = this.db.updateIssue(issue.id, {
          status: "landed",
          behind_main: 0,
          needs_input_question: null,
        })!;
        this.broadcastIssue(this.serializeIssue(updated));
        if (!this.closed) {
          this.sendPostLandingSoulDigest(updated, land);
        }
      }
      return;
    }

    if (issue.status !== "open") {
      const updated = this.db.updateIssue(issue.id, { status: "open" })!;
      this.broadcastIssue(this.serializeIssue(updated));
    } else {
      this.broadcastIssue(this.serializeIssue(issue));
    }
  }

  private sendPostLandingSoulDigest(issue: IssueRow, land: LandRow): void {
    if (!issue.implementer_bot_id) return;
    const implBot = this.db.getUser(issue.implementer_bot_id);
    if (!implBot || implBot.kind !== "bot") return;
    const conv = this.db.getConversation(issue.conversation_id);
    if (!conv) return;
    const settings = this.db.getHostSettings();
    if (!settings.roles.default || Object.keys(settings.providers).length === 0) return;

    const sess = issue.active_session_id ? this.db.getSession(issue.active_session_id) : null;
    const recentBotNotes = this.db
      .listRecentMessages(conv.id, 12)
      .filter((m) => {
        const u = this.db.getUser(m.author_id);
        return u?.kind === "bot" && !m.body.startsWith("Checkpoint:") && !m.body.startsWith("Enqueued Issue #");
      })
      .map((m) => {
        const u = this.db.getUser(m.author_id);
        return `- @${u?.name ?? "bot"}: ${m.body.replace(/\s+/g, " ").slice(0, 200)}`;
      });
    const discussionSummary =
      recentBotNotes.length > 0
        ? recentBotNotes.join("\n")
        : "(Direct land with no extra bot review discussion)";
    const specExcerpt = issue.body_md ? issue.body_md.slice(0, 600) : "(None)";
    const checkSummary = land.pause_reason
      ? `Had merge-queue pause (${land.pause_reason}: ${land.error ?? ""}).`
      : "Clean rebase & checks passed.";

    const digestPrompt = [
      `[post-land-soul-digest for Issue #${issue.number}: "${issue.title}"]`,
      `Outcome: Landed cleanly via ${land.trigger}${land.landed_sha ? ` (${land.landed_sha.slice(0, 10)})` : ""}.`,
      `Specification:\n${specExcerpt}`,
      `Final implementation report:\n${sess?.last_report ?? "(None)"}`,
      `Issue collaboration & review notes:\n${discussionSummary}`,
      `Verification & landing: ${checkSummary}`,
      "",
      "Review kawan://soul.md. If this issue uncovered any durable repository facts, build/test conventions, or human/workflow preferences worth carrying into future issues, update your soul with `soul_replace` or `soul_write` (staying under 4 KB). When finished (or if nothing durable needs adding), output exactly: NO_REPLY",
    ].join("\n");

    this.sessionManager.enqueueSoulDigest({
      bot: implBot,
      conversation: conv,
      digestPrompt,
    });
  }
}

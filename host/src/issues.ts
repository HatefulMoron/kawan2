import { existsSync, rmSync } from "node:fs";
import type { KawanDb } from "./db.js";
import {
  branchTouchesKawanDir,
  commitsAhead,
  commitsBehindMain,
  isWorkingTreeClean,
  runRepoChecks,
  syncBranchWithMain,
} from "./git.js";
import type { MergeQueueManager } from "./merge-queue.js";
import type { SessionManager } from "./sessions.js";
import { deriveTaskTitle } from "./sessions.js";
import type {
  CheckRunItem,
  ConversationRow,
  IssueRow,
  IssueStatus,
  LandingMode,
  LandRow,
  MessageRow,
  SerializedIssue,
  SessionRow,
  UserRow,
} from "./types.js";
import { serializeLand } from "./types.js";
import type { KawanWsServer } from "./ws.js";

export interface IssueReviewerInput {
  bot_id: string;
  focus?: string | null;
}

export class IssueManager {
  private readonly dataDir: string;
  private readonly db: KawanDb;
  private readonly wsServer: KawanWsServer;
  private readonly sessionManager: SessionManager;
  private readonly mergeQueue: MergeQueueManager;
  private readonly disableSandbox: boolean;

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
          autoStartReview: input.auto_start_review,
          landingMode: input.landing_mode,
          maxRounds: input.max_rounds,
          actingBotId: session.bot_id,
        });
        return { issue: res.issue };
      },
      updateIssue: async (session, input) => {
        const issue = this.updateIssue(input.issue_ref, {
          title: input.title,
          body_md: input.body_md,
          owner_id: input.owner_id,
          implementer_bot_id: input.implementer_bot_id,
          parent_issue_id: input.parent_issue_id,
          auto_start_review: input.auto_start_review,
          landing_mode: input.landing_mode,
          max_rounds: input.max_rounds,
          actingBotId: session.bot_id,
        });
        return { issue };
      },
      listIssues: (status) => {
        return {
          issues: this.db.listIssues(status ? { status: status as IssueStatus } : undefined).map((i) =>
            this.db.serializeIssue(i),
          ),
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
    });

    this.mergeQueue.setIssueSyncCallback((land) => {
      this.onLandStatusChanged(land);
    });
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

  private postHostNote(conv: ConversationRow, bot: UserRow, body: string, artifactId?: string | null): MessageRow {
    const msg = this.db.appendMessage({
      conversationId: conv.id,
      authorId: bot.id,
      body,
      artifactId: artifactId ?? null,
    });
    this.wsServer.broadcastToConversation(conv, {
      type: "message.new",
      message: msg,
      author: { id: bot.id, kind: "bot", name: bot.name },
    });
    return msg;
  }

  createIssue(input: {
    title: string;
    bodyMd?: string;
    ownerId?: string | null;
    implementerBotId?: string | null;
    parentIssueId?: string | null;
    autoStartReview?: boolean;
    landingMode?: LandingMode;
    maxRounds?: number;
    reviewers?: IssueReviewerInput[];
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
    const settings = this.db.getHostSettings();
    const defaultLandingMode: LandingMode =
      input.landingMode ?? settings.merge_queue?.default_landing_mode ?? "manual";

    const humans = this.db.listUsers("human").map((u) => u.id);
    const botMembers = new Set<string>();
    if (implBotId) {
      botMembers.add(implBotId);
    } else if (input.actingBotId) {
      botMembers.add(input.actingBotId);
    } else {
      for (const b of this.db.listUsers("bot")) {
        botMembers.add(b.id);
      }
    }
    for (const r of input.reviewers ?? []) {
      if (this.db.getUser(r.bot_id)?.kind === "bot") {
        botMembers.add(r.bot_id);
      }
    }

    const { issueRow, conv } = this.db.transaction(() => {
      const num = this.db.nextIssueNumber();
      const conversation = this.db.createConversation({
        kind: "issue",
        name: `issue-${num}`,
        topic: title,
        memberIds: [...humans, ...botMembers],
      });
      const created = this.db.createIssue({
        number: num,
        conversationId: conversation.id,
        title,
        bodyMd: input.bodyMd ?? "",
        status: "backlog",
        ownerId,
        implementerBotId: implBotId,
        autoStartReview: Boolean(input.autoStartReview),
        landingMode: defaultLandingMode,
        maxRounds: Math.max(1, input.maxRounds ?? 3),
        parentIssueId: parentId,
      });
      if (input.reviewers) {
        this.db.setIssueReviewers(
          created.id,
          input.reviewers.map((r) => ({ botId: r.bot_id, focus: r.focus ?? null })),
        );
      }
      return { issueRow: created, conv: conversation };
    });

    const serialized = this.db.serializeIssue(issueRow);
    this.wsServer.broadcastToConversation(conv, {
      type: "conversation.new",
      conversation: this.buildIssueConvPayload(conv),
    });
    this.broadcastIssue(serialized);
    return { issue: serialized, conversation: conv };
  }

  listIssues(filter?: { status?: IssueStatus; ownerId?: string }): SerializedIssue[] {
    return this.db.listIssues(filter).map((i) => this.db.serializeIssue(i));
  }

  updateIssue(
    issueRef: string | number,
    patch: {
      title?: string;
      body_md?: string;
      owner_id?: string;
      implementer_bot_id?: string | null;
      parent_issue_id?: string | null;
      auto_start_review?: boolean;
      landing_mode?: LandingMode;
      max_rounds?: number;
      reviewers?: IssueReviewerInput[];
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
        auto_start_review: patch.auto_start_review,
        landing_mode: patch.landing_mode,
        max_rounds: patch.max_rounds !== undefined ? Math.max(1, patch.max_rounds) : undefined,
      })!;
      if (patch.title !== undefined) {
        this.db.updateConversationTopic(existing.conversation_id, nextTitle);
      }
      if (patch.reviewers) {
        this.db.setIssueReviewers(
          existing.id,
          patch.reviewers.map((r) => ({ botId: r.bot_id, focus: r.focus ?? null })),
        );
        for (const r of patch.reviewers) {
          if (this.db.getUser(r.bot_id)?.kind === "bot") {
            this.db.addMember(existing.conversation_id, r.bot_id);
          }
        }
      }
      return row;
    });

    const serialized = this.db.serializeIssue(updated);
    this.broadcastIssue(serialized);
    return serialized;
  }

  async openIssue(issueRef: string | number, userId: string) {
    let issue = this.resolveIssueRef(issueRef);
    const conv = this.db.getConversation(issue.conversation_id);
    if (!conv) throw new Error(`Conversation missing for issue #${issue.number}`);

    const sess = issue.active_session_id ? this.db.getSession(issue.active_session_id) : null;
    const settings = this.db.getHostSettings();
    if (sess?.clone_path && existsSync(sess.clone_path) && settings.repo?.bare_path) {
      const behind = await commitsBehindMain(
        settings.repo.bare_path,
        sess.clone_path,
        settings.repo.default_branch,
      );
      if (behind !== issue.behind_main) {
        issue = this.db.updateIssue(issue.id, { behind_main: behind })!;
        this.broadcastIssue(this.db.serializeIssue(issue));
      }
    }

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
      issue: this.db.serializeIssue(issue),
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

  async assignAndRun(params: {
    issueRef: string | number;
    implementerBotId?: string;
    ownerId?: string;
    autoStartReview?: boolean;
    landingMode?: LandingMode;
    maxRounds?: number;
    reviewers?: IssueReviewerInput[];
    prompt?: string;
  }): Promise<{ issue: SerializedIssue; session: Omit<SessionRow, "token"> }> {
    let issue = this.resolveIssueRef(params.issueRef);
    const implBotId =
      params.implementerBotId?.trim() ||
      issue.implementer_bot_id ||
      this.db.listUsers("bot")[0]?.id;
    if (!implBotId) throw new Error("Implementer bot is required");
    const bot = this.db.getUser(implBotId);
    if (!bot || bot.kind !== "bot") throw new Error(`Bot not found: ${implBotId}`);

    const settings = this.db.getHostSettings();
    if (!settings.repo?.bare_path) {
      throw new Error("Cannot run issue before a repository is configured");
    }

    this.db.addMember(issue.conversation_id, bot.id);
    if (params.reviewers) {
      this.db.setIssueReviewers(
        issue.id,
        params.reviewers.map((r) => ({ botId: r.bot_id, focus: r.focus ?? null })),
      );
      for (const r of params.reviewers) {
        if (this.db.getUser(r.bot_id)?.kind === "bot") {
          this.db.addMember(issue.conversation_id, r.bot_id);
        }
      }
    }

    issue = this.db.updateIssue(issue.id, {
      owner_id: params.ownerId,
      implementer_bot_id: bot.id,
      auto_start_review: params.autoStartReview,
      landing_mode: params.landingMode,
      max_rounds: params.maxRounds !== undefined ? Math.max(1, params.maxRounds) : undefined,
      status: "implementing",
      needs_input_question: null,
    })!;

    const conv = this.db.getConversation(issue.conversation_id)!;
    const existingSess = issue.active_session_id ? this.db.getSession(issue.active_session_id) : null;
    let workerSession: SessionRow;
    if (
      existingSess &&
      existingSess.bot_id === bot.id &&
      existingSess.clone_path &&
      existsSync(existingSess.clone_path) &&
      existingSess.status !== "landed" &&
      existingSess.status !== "archived"
    ) {
      const promptText =
        params.prompt?.trim() ||
        `Resume work on Issue #${issue.number}: ${issue.title}\n\n${issue.body_md}`;
      await this.sessionManager.resumeIssueWorker(existingSess.id, promptText);
      workerSession = this.db.getSession(existingSess.id)!;
    } else {
      workerSession = await this.sessionManager.launchIssueImplementer({
        issue,
        bot,
        extraPrompt: params.prompt,
      });
      issue = this.db.updateIssue(issue.id, {
        active_session_id: workerSession.id,
        behind_main: 0,
      })!;
    }

    this.postHostNote(
      conv,
      bot,
      `Assigned Issue #${issue.number} to @${bot.name} — starting implementation.`,
    );
    const serialized = this.db.serializeIssue(issue);
    this.broadcastIssue(serialized);
    return {
      issue: serialized,
      session: this.sessionManager.serializePublicSession(workerSession),
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
      return { issue: this.db.serializeIssue(existing), conversation: conv };
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

    let derivedStatus: IssueStatus = "implementing";
    if (latestLand?.status === "landed" || session.status === "landed") {
      derivedStatus = "landed";
    } else if (
      latestLand &&
      (latestLand.status === "queued" ||
        latestLand.status === "rebasing" ||
        latestLand.status === "verifying" ||
        latestLand.status === "paused")
    ) {
      derivedStatus = "queued";
    } else if (latestLand?.status === "requested" || session.status === "review_requested") {
      derivedStatus = "ready_to_land";
    }

    const title = params.title?.trim() || deriveTaskTitle(session.task, session.title);
    const bodyMd = params.bodyMd !== undefined ? params.bodyMd : (session.task ?? "");
    const ownerId = this.defaultOwnerId(params.ownerId);
    const humans = this.db.listUsers("human").map((u) => u.id);

    const settings = this.db.getHostSettings();
    let behindMain = 0;
    if (
      session.clone_path &&
      existsSync(session.clone_path) &&
      settings.repo?.bare_path &&
      derivedStatus !== "landed"
    ) {
      behindMain = await commitsBehindMain(
        settings.repo.bare_path,
        session.clone_path,
        settings.repo.default_branch,
      );
    }

    const { issueRow, conv, updatedSession, updatedLands } = this.db.transaction(() => {
      const num = this.db.nextIssueNumber();
      const conversation = this.db.createConversation({
        kind: "issue",
        name: `issue-${num}`,
        topic: title,
        memberIds: [...humans, session.bot_id],
      });
      const created = this.db.createIssue({
        number: num,
        conversationId: conversation.id,
        title,
        bodyMd,
        status: derivedStatus,
        ownerId,
        implementerBotId: session.bot_id,
        landingMode: settings.merge_queue?.default_landing_mode ?? "manual",
        activeSessionId: session.id,
        behindMain,
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

    const serialized = this.db.serializeIssue(issueRow);
    this.broadcastIssue(serialized);
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
    issue = this.db.updateIssue(issue.id, { behind_main: res.behindAfter })!;
    const serialized = this.db.serializeIssue(issue);
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

    return {
      ok: res.ok,
      behind_before: res.behindBefore,
      behind_after: res.behindAfter,
      error: res.error,
      issue: serialized,
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
      status: "needs_input",
      needs_input_question: trimmed,
    })!;
    this.sessionManager.markTurnReported(session.id);
    this.postHostNote(conv, bot, `@${owner?.name ?? "owner"}: ${trimmed}`);
    this.broadcastIssue(this.db.serializeIssue(updated));
    return { issue_id: updated.id, number: updated.number, status: updated.status };
  }

  tryRouteNeedsInputReply(
    conversation: ConversationRow,
    message: MessageRow,
    author: UserRow,
  ): boolean {
    if (conversation.kind !== "issue" || author.kind !== "human") return false;
    const issue = this.db.getIssueByConversationId(conversation.id);
    if (!issue || issue.status !== "needs_input" || !issue.active_session_id) {
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
      status: "implementing",
      needs_input_question: null,
    })!;
    this.broadcastIssue(this.db.serializeIssue(updated));

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

  async startReviewCycle(issueRef: string | number): Promise<{
    issue: SerializedIssue;
    ok: boolean;
    checks: CheckRunItem[];
    land?: ReturnType<typeof serializeLand>;
  }> {
    let issue = this.resolveIssueRef(issueRef);
    const settings = this.db.getHostSettings();
    if (!settings.repo?.bare_path) {
      throw new Error("Repository is not configured");
    }
    const sess = issue.active_session_id ? this.db.getSession(issue.active_session_id) : null;
    if (!sess || !sess.clone_path || !existsSync(sess.clone_path)) {
      throw new Error("Issue does not have an active worker clone yet");
    }
    if (sess.status === "running") {
      throw new Error("Wait for the current worker turn to finish or Stop it before starting review");
    }
    const clean = await isWorkingTreeClean(sess.clone_path);
    if (!clean) {
      throw new Error("Worker clone has uncommitted changes; commit before starting review");
    }
    const ahead = await commitsAhead(sess.clone_path, settings.repo.default_branch);
    if (ahead < 1) {
      throw new Error(
        `Issue branch has 0 commits ahead of ${settings.repo.default_branch}; commit changes first`,
      );
    }

    const conv = this.db.getConversation(issue.conversation_id)!;
    const bot = this.db.getUser(sess.bot_id)!;
    issue = this.db.updateIssue(issue.id, {
      status: "verifying",
      current_round: Math.max(1, issue.current_round),
      needs_input_question: null,
    })!;
    this.broadcastIssue(this.db.serializeIssue(issue));

    const checkRes = await runRepoChecks({
      workdir: sess.clone_path,
      verifyCommand: settings.verify_command,
      sandboxEnabled: Boolean(bot.sandbox_enabled),
      sandboxNetwork: Boolean(bot.sandbox_network),
      disableSandbox: this.disableSandbox,
    });
    const touchesKawan = await branchTouchesKawanDir(sess.clone_path, settings.repo.default_branch);

    if (!checkRes.ok) {
      const failArt = this.sessionManager.createTextArtifact({
        content: checkRes.combined_output,
        filename: "checks-failure.log",
        sessionId: sess.id,
        conversationId: conv.id,
      });
      this.wsServer.broadcastToConversation(conv, { type: "artifact.new", artifact: failArt });

      issue = this.db.updateIssue(issue.id, { status: "implementing" })!;
      this.postHostNote(
        conv,
        bot,
        `Pre-review verification failed (${checkRes.summary}) — returning to implementer to fix.`,
        failArt.id,
      );
      const serialized = this.db.serializeIssue(issue);
      this.broadcastIssue(serialized);

      void this.sessionManager.resumeIssueWorker(
        sess.id,
        [
          `[Pre-review checks failed (${checkRes.summary})]`,
          checkRes.combined_output,
          "",
          "Fix the failing checks cleanly, commit on your branch, and call report(summary).",
        ].join("\n"),
      );

      return { issue: serialized, ok: false, checks: checkRes.checks };
    }

    // Create or refresh land request linked to this issue
    const existingLand = this.db
      .listLands({ sessionId: sess.id })
      .find(
        (l) =>
          l.status === "requested" ||
          l.status === "failed" ||
          l.status === "removed",
      );
    const landRow = existingLand
      ? this.db.updateLand(existingLand.id, {
          status: "requested",
          issue_id: issue.id,
          conversation_id: conv.id,
          thread_id: null,
          checks_json: JSON.stringify(checkRes.checks),
          touches_kawan: touchesKawan ? 1 : 0,
          verify_output: checkRes.combined_output,
          error: null,
        })!
      : (() => {
          const created = this.db.createLand({
            sessionId: sess.id,
            conversationId: conv.id,
            issueId: issue.id,
          });
          return this.db.updateLand(created.id, {
            checks_json: JSON.stringify(checkRes.checks),
            touches_kawan: touchesKawan ? 1 : 0,
            verify_output: checkRes.combined_output,
          })!;
        })();

    const updatedSess = this.db.updateSession(sess.id, { status: "review_requested" })!;
    issue = this.db.updateIssue(issue.id, { status: "ready_to_land" })!;

    const kawanWarn = touchesKawan
      ? " (Modifies `.kawan/` checks — manual approval required before landing.)"
      : "";
    this.postHostNote(
      conv,
      bot,
      `Checks passed (${checkRes.summary}). Ready to approve land into \`${settings.repo.default_branch}\`.${kawanWarn}`,
    );

    const serializedLand = serializeLand(landRow);
    const serializedIssue = this.db.serializeIssue(issue);
    this.wsServer.broadcast({ type: "session.update", session: this.sessionManager.serializePublicSession(updatedSess) });
    this.wsServer.broadcast({ type: "land.update", land: serializedLand });
    this.broadcastIssue(serializedIssue);

    return { issue: serializedIssue, ok: true, checks: checkRes.checks, land: serializedLand };
  }

  returnToCollaborate(issueRef: string | number): SerializedIssue {
    const existing = this.resolveIssueRef(issueRef);
    if (existing.status === "landed" || existing.status === "closed" || existing.status === "queued") {
      throw new Error(`Cannot return issue #${existing.number} in status ${existing.status} to collaborate`);
    }
    const updated = this.db.updateIssue(existing.id, {
      status: "implementing",
      needs_input_question: null,
    })!;
    const conv = this.db.getConversation(updated.conversation_id);
    const botId = updated.implementer_bot_id ?? this.db.listUsers("bot")[0]?.id;
    const bot = botId ? this.db.getUser(botId) : null;
    if (conv && bot) {
      this.postHostNote(conv, bot, `Returned Issue #${updated.number} to Collaborate.`);
    }
    const serialized = this.db.serializeIssue(updated);
    this.broadcastIssue(serialized);
    return serialized;
  }

  async stopIssue(issueRef: string | number): Promise<SerializedIssue> {
    const issue = this.resolveIssueRef(issueRef);
    if (issue.active_session_id) {
      await this.sessionManager.stopWorkerSession(issue.active_session_id);
    }
    const refreshed = this.db.getIssue(issue.id)!;
    const serialized = this.db.serializeIssue(refreshed);
    this.broadcastIssue(serialized);
    return serialized;
  }

  async closeIssue(issueRef: string | number, abandon = false): Promise<SerializedIssue> {
    const issue = this.resolveIssueRef(issueRef);
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
    const serialized = this.db.serializeIssue(updated);
    this.broadcastIssue(serialized);
    return serialized;
  }

  onLandStatusChanged(land: LandRow): void {
    if (!land.issue_id) return;
    const issue = this.db.getIssue(land.issue_id);
    if (!issue || issue.status === "closed") return;

    let nextStatus: IssueStatus | null = null;
    if (
      land.status === "queued" ||
      land.status === "rebasing" ||
      land.status === "verifying" ||
      land.status === "paused"
    ) {
      nextStatus = "queued";
    } else if (land.status === "landed") {
      nextStatus = "landed";
    } else if (land.status === "failed") {
      nextStatus = "implementing";
    } else if (land.status === "requested" || land.status === "removed") {
      nextStatus = "ready_to_land";
    }
    if (!nextStatus || nextStatus === issue.status) return;

    const updated = this.db.updateIssue(issue.id, {
      status: nextStatus,
      ...(nextStatus === "landed" ? { behind_main: 0, needs_input_question: null } : {}),
    })!;
    this.broadcastIssue(this.db.serializeIssue(updated));
  }
}

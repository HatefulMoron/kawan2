import { existsSync, rmSync } from "node:fs";
import type { KawanDb } from "./db.js";
import {
  branchTouchesKawanDir,
  commitsAhead,
  commitsBehindMain,
  getSessionDiff,
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
  HostSettings,
  IssueReviewRow,
  IssueReviewerRow,
  IssueRow,
  IssueStatus,
  LandingMode,
  LandRow,
  MessageRow,
  ReviewVerdict,
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

interface ReviewerRunState {
  issueId: string;
  round: number;
  slotId: string;
  botId: string;
  focus: string | null;
  submitted?: IssueReviewRow;
  notesMd?: string;
}

export class IssueManager {
  private readonly dataDir: string;
  private readonly db: KawanDb;
  private readonly wsServer: KawanWsServer;
  private readonly sessionManager: SessionManager;
  private readonly mergeQueue: MergeQueueManager;
  private readonly disableSandbox: boolean;
  private closed = false;
  private runningReviewCycles = new Set<string>();
  private activeCycleTokens = new Map<string, symbol>();
  private pendingAutoReview = new Map<string, { nextRound: number }>();
  private consecutiveCheckFails = new Map<string, number>();
  private activeReviewerSessions = new Map<string, Set<string>>();
  private reviewerRunState = new Map<string, ReviewerRunState>();

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
      submitReview: async (session, input) => {
        return await this.handleSubmitReview(session, input);
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
    const issueIds = new Set<string>([
      ...this.runningReviewCycles,
      ...this.activeReviewerSessions.keys(),
    ]);
    await Promise.all([...issueIds].map((id) => this.cancelActiveReviewers(id)));
  }

  private async cancelActiveReviewers(issueId: string): Promise<void> {
    this.pendingAutoReview.delete(issueId);
    const active = this.activeReviewerSessions.get(issueId);
    if (!active || active.size === 0) {
      this.activeReviewerSessions.delete(issueId);
      return;
    }
    this.activeReviewerSessions.delete(issueId);
    await Promise.allSettled([...active].map((sid) => this.sessionManager.stopSession(sid)));
  }

  private async handleSubmitReview(
    session: SessionRow,
    input: { verdict: ReviewVerdict; summary: string; notes_md?: string },
  ): Promise<{ review: IssueReviewRow }> {
    const state = this.reviewerRunState.get(session.id);
    if (!state) {
      throw new Error("Reviewer session is no longer active");
    }
    if (state.submitted) {
      return { review: state.submitted };
    }
    const issue = this.db.getIssue(state.issueId);
    if (!issue) {
      throw new Error("Issue no longer exists");
    }
    let notesArtifactId: string | null = null;
    const cleanNotes = input.notes_md?.trim() || "";
    if (cleanNotes) {
      const conv = this.db.getConversation(issue.conversation_id);
      const art = this.sessionManager.createTextArtifact({
        content: cleanNotes,
        filename: `review-r${state.round}-${state.slotId.slice(0, 6)}.md`,
        mimeType: "text/markdown",
        sessionId: session.id,
        conversationId: issue.conversation_id,
      });
      notesArtifactId = art.id;
      if (conv) {
        this.wsServer.broadcastToConversation(conv, { type: "artifact.new", artifact: art });
      }
    }

    const review = this.db.createIssueReview({
      issueId: state.issueId,
      round: state.round,
      reviewerSlotId: state.slotId,
      sessionId: session.id,
      verdict: input.verdict,
      summary: input.summary.trim(),
      notesArtifactId,
    });
    state.submitted = review;
    if (cleanNotes) {
      state.notesMd = cleanNotes;
    }
    this.broadcastIssue(this.db.serializeIssue(this.db.getIssue(issue.id)!));
    return { review };
  }

  private async onWorkerTurnCompleted(issue: IssueRow, session: SessionRow): Promise<void> {
    if (this.closed) return;
    if (issue.status !== "implementing" || session.status !== "idle") return;
    if (this.runningReviewCycles.has(issue.id)) return;

    const pending = this.pendingAutoReview.get(issue.id);
    const shouldAutoFirstPass = !pending && Boolean(issue.auto_start_review) && issue.current_round === 0;
    if (!pending && !shouldAutoFirstPass) return;

    const settings = this.db.getHostSettings();
    if (!settings.repo?.bare_path || !session.clone_path || !existsSync(session.clone_path)) {
      return;
    }
    const clean = await isWorkingTreeClean(session.clone_path);
    const ahead = clean ? await commitsAhead(session.clone_path, settings.repo.default_branch) : 0;
    if (!clean || ahead < 1) {
      // Implementer paused cleanly without committing new code (or left dirty state); stay in Collaborate
      this.pendingAutoReview.delete(issue.id);
      return;
    }

    this.pendingAutoReview.delete(issue.id);
    await this.startReviewCycle(issue.id, { round: pending?.nextRound, isAuto: true });
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

  async startReviewCycle(
    issueRef: string | number,
    opts?: { round?: number; isAuto?: boolean },
  ): Promise<{
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
    if (this.runningReviewCycles.has(issue.id)) {
      throw new Error("A review cycle is already in progress for this issue");
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
    const prevReviews = this.db.listIssueReviews(issue.id);
    const maxRecordedRound = prevReviews.reduce((m, r) => Math.max(m, r.round), 0);
    const round = opts?.round ?? Math.max(1, maxRecordedRound + 1);

    const cycleToken = Symbol(`review-${issue.id}-${round}`);
    this.runningReviewCycles.add(issue.id);
    this.activeCycleTokens.set(issue.id, cycleToken);
    let handedToBackgroundReviewers = false;

    try {
      issue = this.db.updateIssue(issue.id, {
        status: "verifying",
        current_round: round,
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

      if (this.closed || this.activeCycleTokens.get(issue.id) !== cycleToken) {
        return { issue: this.db.serializeIssue(this.db.getIssue(issue.id)!), ok: false, checks: checkRes.checks };
      }

      const reviewers = this.db.listIssueReviewers(issue.id);

      if (!checkRes.ok) {
        const failArt = this.sessionManager.createTextArtifact({
          content: checkRes.combined_output,
          filename: "checks-failure.log",
          sessionId: sess.id,
          conversationId: conv.id,
        });
        this.wsServer.broadcastToConversation(conv, { type: "artifact.new", artifact: failArt });

        const autoLoopEnabled = reviewers.length > 0 || Boolean(issue.auto_start_review);
        if (autoLoopEnabled) {
          const fails = (this.consecutiveCheckFails.get(issue.id) ?? 0) + 1;
          this.consecutiveCheckFails.set(issue.id, fails);
          if (fails >= 2) {
            const owner = this.db.getUser(issue.owner_id);
            const q =
              "Pre-review verification checks failed twice in a row. Inspect `checks-failure.log` and reply with guidance or fix manually.";
            issue = this.db.updateIssue(issue.id, {
              status: "needs_input",
              needs_input_question: q,
            })!;
            this.pendingAutoReview.delete(issue.id);
            this.postHostNote(conv, bot, `@${owner?.name ?? "owner"}: ${q}`, failArt.id);
            const serialized = this.db.serializeIssue(issue);
            this.broadcastIssue(serialized);
            return { issue: serialized, ok: false, checks: checkRes.checks };
          }
          this.pendingAutoReview.set(issue.id, { nextRound: round });
        }

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

      this.consecutiveCheckFails.delete(issue.id);

      if (reviewers.length === 0) {
        const finalized = await this.finalizeApprovedReviewCycle({
          issue,
          sess,
          conv,
          implBot: bot,
          settings,
          checkRes,
          touchesKawan,
        });
        return { issue: finalized.issue, ok: true, checks: checkRes.checks, land: finalized.land };
      }

      issue = this.db.updateIssue(issue.id, {
        status: "reviewing",
        current_round: round,
        needs_input_question: null,
      })!;
      const serialized = this.db.serializeIssue(issue);
      this.broadcastIssue(serialized);
      this.postHostNote(
        conv,
        bot,
        `Checks passed (${checkRes.summary}). Starting Review Round ${round}/${issue.max_rounds} with ${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}.`,
      );

      handedToBackgroundReviewers = true;
      void this.runParallelReviewers({
        issueId: issue.id,
        cycleToken,
        round,
        sess,
        conv,
        implBot: bot,
        reviewers,
        checkRes,
        touchesKawan,
      });

      return { issue: serialized, ok: true, checks: checkRes.checks };
    } finally {
      if (!handedToBackgroundReviewers && this.activeCycleTokens.get(issue.id) === cycleToken) {
        this.runningReviewCycles.delete(issue.id);
        this.activeCycleTokens.delete(issue.id);
      }
    }
  }

  private async runParallelReviewers(params: {
    issueId: string;
    cycleToken: symbol;
    round: number;
    sess: SessionRow;
    conv: ConversationRow;
    implBot: UserRow;
    reviewers: IssueReviewerRow[];
    checkRes: { summary: string; combined_output: string };
    touchesKawan: boolean;
  }): Promise<void> {
    try {
      const settings = this.db.getHostSettings();
      const issue = this.db.getIssue(params.issueId);
      if (
        !issue ||
        this.closed ||
        !params.sess.clone_path ||
        !existsSync(params.sess.clone_path) ||
        !settings.repo?.bare_path
      ) {
        return;
      }

      const diff = await getSessionDiff({
        clonePath: params.sess.clone_path,
        defaultBranch: settings.repo.default_branch,
      });
      let diffText = "(No diff available)";
      if (diff.available) {
        const chunks: string[] = [];
        let total = 0;
        for (const f of diff.files) {
          const block = `### ${f.path} [${f.status}] (+${f.insertions}/-${f.deletions})\n\`\`\`diff\n${f.patch}\n\`\`\``;
          if (total + block.length > 20_000) {
            chunks.push("\n... (remaining files truncated)");
            break;
          }
          chunks.push(block);
          total += block.length;
        }
        diffText = chunks.join("\n\n") || "(Empty diff)";
      }

      const priorReviews = this.db
        .listIssueReviews(issue.id)
        .filter((r) => r.round < params.round);
      const priorSection =
        priorReviews.length > 0
          ? priorReviews
              .map(
                (r) =>
                  `- Round ${r.round} (${r.verdict}): ${r.summary}`,
              )
              .join("\n")
          : "(None)";

      const activeSet = new Set<string>();
      this.activeReviewerSessions.set(issue.id, activeSet);

      const results = await Promise.all(
        params.reviewers.map(async (slot) => {
          const reviewerBot = this.db.getUser(slot.bot_id) ?? params.implBot;
          const focusLine = slot.focus?.trim()
            ? `Your assigned review focus: ${slot.focus.trim()}`
            : "Review holistically for correctness, edge cases, and maintainability.";
          const roundGuidance =
            params.round >= 2
              ? `This is Review Round ${params.round} of ${issue.max_rounds}. Strictly verify whether prior blocking findings were resolved and check for regressions. Do NOT raise new style nits or scope creep.`
              : "Focus on real bugs, missing requirements, edge cases, and test coverage rather than stylistic nitpicks.";

          const systemPrompt = [
            `You are read-only code reviewer @${reviewerBot.name} for Issue #${issue.number}: "${issue.title}".`,
            focusLine,
            roundGuidance,
            "Rules:",
            "- You are in a READ-ONLY workspace with no edit/write/bash commit rights.",
            "- Inspect additional repository files read-only only if needed.",
            "- Finish by calling submit_review(verdict, summary, notes_md?) with verdict 'approve', 'request_changes', or 'needs_owner'.",
          ].join("\n");

          const promptText = [
            `# Review Request: Issue #${issue.number} — ${issue.title} (Round ${params.round}/${issue.max_rounds})`,
            "",
            "## Specification",
            issue.body_md || "(No markdown specification provided.)",
            "",
            "## Implementer's Summary",
            params.sess.last_report || "(No explicit report text.)",
            "",
            "## Pre-Review Checks",
            params.checkRes.summary,
            "",
            "## Prior Review Rounds",
            priorSection,
            "",
            "## Branch Diff vs Default Branch",
            diffText,
          ].join("\n");

          let createdSessionId = "";
          let notesMd: string | undefined;
          let submitted: IssueReviewRow | undefined;

          try {
            const turn = await this.sessionManager.runReviewerSession({
              bot: reviewerBot,
              issue,
              round: params.round,
              focus: slot.focus,
              clonePath: params.sess.clone_path!,
              systemPrompt,
              promptText,
              onSessionCreated: (sid) => {
                createdSessionId = sid;
                activeSet.add(sid);
                this.reviewerRunState.set(sid, {
                  issueId: issue.id,
                  round: params.round,
                  slotId: slot.id,
                  botId: reviewerBot.id,
                  focus: slot.focus,
                });
              },
            });

            if (createdSessionId) {
              const st = this.reviewerRunState.get(createdSessionId);
              submitted = st?.submitted;
              notesMd = st?.notesMd;
            }

            if (
              !submitted &&
              !this.closed &&
              !turn.aborted &&
              this.activeCycleTokens.get(issue.id) === params.cycleToken
            ) {
              const fallbackSummary = turn.errorMessage
                ? `Reviewer failed: ${turn.errorMessage}`
                : turn.assistantText.trim() || "Reviewer ended turn without submitting a structured verdict.";
              submitted = this.db.createIssueReview({
                issueId: issue.id,
                round: params.round,
                reviewerSlotId: slot.id,
                sessionId: createdSessionId || null,
                verdict: "needs_owner",
                summary: fallbackSummary.slice(0, 600),
              });
            }
          } finally {
            if (createdSessionId) {
              activeSet.delete(createdSessionId);
              this.reviewerRunState.delete(createdSessionId);
            }
          }

          return {
            slot,
            reviewerBot,
            review: submitted,
            notesMd,
          };
        }),
      );

      this.activeReviewerSessions.delete(issue.id);
      if (this.closed || this.activeCycleTokens.get(issue.id) !== params.cycleToken) {
        return;
      }

      const current = this.db.getIssue(issue.id);
      if (!current || current.status !== "reviewing" || current.current_round !== params.round) {
        return;
      }

      for (const item of results) {
        if (!item.review) continue;
        const focusTag = item.slot.focus?.trim() ? ` · ${item.slot.focus.trim()}` : "";
        const verdictTag =
          item.review.verdict === "approve"
            ? "APPROVED"
            : item.review.verdict === "request_changes"
              ? "CHANGES REQUESTED"
              : "NEEDS OWNER";
        this.postHostNote(
          params.conv,
          item.reviewerBot,
          `[Round ${params.round}/${current.max_rounds}${focusTag}] ${verdictTag}: ${item.review.summary}`,
          item.review.notes_artifact_id,
        );
      }

      const reviews = results.map((r) => r.review).filter((r): r is IssueReviewRow => Boolean(r));
      const needsOwner = reviews.filter((r) => r.verdict === "needs_owner");
      const changesRequested = results.filter((r) => r.review?.verdict === "request_changes");

      if (needsOwner.length > 0) {
        const owner = this.db.getUser(current.owner_id);
        const question = needsOwner.map((r) => r.summary).join(" | ");
        const updated = this.db.updateIssue(current.id, {
          status: "needs_input",
          needs_input_question: question,
        })!;
        this.postHostNote(
          params.conv,
          params.implBot,
          `@${owner?.name ?? "owner"}: Reviewer escalated to owner in Round ${params.round}: ${question}`,
        );
        this.broadcastIssue(this.db.serializeIssue(updated));
        return;
      }

      if (changesRequested.length === 0 && reviews.length === params.reviewers.length) {
        await this.finalizeApprovedReviewCycle({
          issue: current,
          sess: params.sess,
          conv: params.conv,
          implBot: params.implBot,
          settings,
          checkRes: params.checkRes,
          touchesKawan: params.touchesKawan,
        });
        return;
      }

      // Some reviewer requested changes
      if (params.round >= current.max_rounds) {
        const owner = this.db.getUser(current.owner_id);
        const q = `Reached max review rounds (${params.round}/${current.max_rounds}) with changes still requested. Reply with guidance to revise, or click Return to Collaborate.`;
        const updated = this.db.updateIssue(current.id, {
          status: "needs_input",
          needs_input_question: q,
        })!;
        this.postHostNote(params.conv, params.implBot, `@${owner?.name ?? "owner"}: ${q}`);
        this.broadcastIssue(this.db.serializeIssue(updated));
        return;
      }

      const feedbackBlocks = changesRequested.map((item, idx) => {
        const focusLabel = item.slot.focus?.trim() ? ` (${item.slot.focus.trim()})` : "";
        const notes = item.notesMd ? `\nNotes:\n${item.notesMd}` : "";
        return `${idx + 1}. @${item.reviewerBot.name}${focusLabel}: ${item.review!.summary}${notes}`;
      });
      const revisionPrompt = [
        `[Review Round ${params.round}/${current.max_rounds} — Changes Requested for Issue #${current.number}]`,
        feedbackBlocks.join("\n\n"),
        "",
        "Address every requested change cleanly in your branch clone, run verification, commit, and call report(summary).",
      ].join("\n");

      const nextRound = params.round + 1;
      this.pendingAutoReview.set(current.id, { nextRound });
      const revisedIssue = this.db.updateIssue(current.id, {
        status: "implementing",
        needs_input_question: null,
      })!;
      this.postHostNote(
        params.conv,
        params.implBot,
        `Review Round ${params.round}/${current.max_rounds} requested changes — resuming @${params.implBot.name} for revision (next: Round ${nextRound}).`,
      );
      this.broadcastIssue(this.db.serializeIssue(revisedIssue));

      void this.sessionManager.resumeIssueWorker(params.sess.id, revisionPrompt).catch((err) => {
        if (!this.closed) {
          this.wsServer.broadcastToConversation(params.conv, {
            type: "error",
            conversation_id: params.conv.id,
            session_id: params.sess.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    } finally {
      if (this.activeCycleTokens.get(params.issueId) === params.cycleToken) {
        this.runningReviewCycles.delete(params.issueId);
        this.activeCycleTokens.delete(params.issueId);
      }
    }
  }

  private async finalizeApprovedReviewCycle(params: {
    issue: IssueRow;
    sess: SessionRow;
    conv: ConversationRow;
    implBot: UserRow;
    settings: HostSettings;
    checkRes: { summary: string; combined_output: string; checks?: CheckRunItem[] };
    touchesKawan: boolean;
  }): Promise<{ issue: SerializedIssue; land: ReturnType<typeof serializeLand> }> {
    const existingLand = this.db
      .listLands({ sessionId: params.sess.id })
      .find(
        (l) =>
          l.status === "requested" ||
          l.status === "failed" ||
          l.status === "removed",
      );
    const landRow = existingLand
      ? this.db.updateLand(existingLand.id, {
          status: "requested",
          issue_id: params.issue.id,
          conversation_id: params.conv.id,
          thread_id: null,
          checks_json: JSON.stringify(params.checkRes.checks ?? []),
          touches_kawan: params.touchesKawan ? 1 : 0,
          verify_output: params.checkRes.combined_output,
          error: null,
        })!
      : (() => {
          const created = this.db.createLand({
            sessionId: params.sess.id,
            conversationId: params.conv.id,
            issueId: params.issue.id,
          });
          return this.db.updateLand(created.id, {
            checks_json: JSON.stringify(params.checkRes.checks ?? []),
            touches_kawan: params.touchesKawan ? 1 : 0,
            verify_output: params.checkRes.combined_output,
          })!;
        })();

    const updatedSess = this.db.updateSession(params.sess.id, { status: "review_requested" })!;
    this.wsServer.broadcast({
      type: "session.update",
      session: this.sessionManager.serializePublicSession(updatedSess),
    });

    const wantsAutoLand = params.issue.landing_mode === "auto";
    const canAutoLand = wantsAutoLand && !params.touchesKawan && !this.closed;

    if (canAutoLand) {
      this.wsServer.broadcast({ type: "land.update", land: serializeLand(landRow) });
      this.postHostNote(
        params.conv,
        params.implBot,
        `Checks (${params.checkRes.summary}) and reviews passed — auto-enqueueing Issue #${params.issue.number} onto the Merge Queue.`,
      );
      const enqueued = await this.mergeQueue.enqueueLand({
        landId: landRow.id,
        approvedBy: params.issue.owner_id,
        trigger: "auto_land",
        waitForSettlement: false,
      });
      const latestIssue = this.db.getIssue(params.issue.id)!;
      return { issue: this.db.serializeIssue(latestIssue), land: enqueued.land };
    }

    const updatedIssue = this.db.updateIssue(params.issue.id, {
      status: "ready_to_land",
      needs_input_question: null,
    })!;
    const kawanWarn = params.touchesKawan
      ? wantsAutoLand
        ? " (Modifies `.kawan/` checks — auto-land downgraded to manual approval.)"
        : " (Modifies `.kawan/` checks — manual approval required before landing.)"
      : "";
    const defaultBranch = params.settings.repo?.default_branch ?? "main";
    this.postHostNote(
      params.conv,
      params.implBot,
      `Checks passed (${params.checkRes.summary}). Ready to approve land into \`${defaultBranch}\`.${kawanWarn}`,
    );

    const serializedLand = serializeLand(landRow);
    const serializedIssue = this.db.serializeIssue(updatedIssue);
    this.wsServer.broadcast({ type: "land.update", land: serializedLand });
    this.broadcastIssue(serializedIssue);

    return { issue: serializedIssue, land: serializedLand };
  }

  returnToCollaborate(issueRef: string | number): SerializedIssue {
    const existing = this.resolveIssueRef(issueRef);
    if (existing.status === "landed" || existing.status === "closed" || existing.status === "queued") {
      throw new Error(`Cannot return issue #${existing.number} in status ${existing.status} to collaborate`);
    }
    this.activeCycleTokens.delete(existing.id);
    this.runningReviewCycles.delete(existing.id);
    this.consecutiveCheckFails.delete(existing.id);
    void this.cancelActiveReviewers(existing.id);
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
    this.activeCycleTokens.delete(issue.id);
    this.runningReviewCycles.delete(issue.id);
    await this.cancelActiveReviewers(issue.id);
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
    this.activeCycleTokens.delete(issue.id);
    this.runningReviewCycles.delete(issue.id);
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

    if (nextStatus === "landed" && !this.closed) {
      this.sendPostLandingSoulDigest(updated, land);
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
    const reviews = this.db.listIssueReviews(issue.id);
    const reviewSummary =
      reviews.length > 0
        ? reviews.map((r) => `- Round ${r.round} (${r.verdict}): ${r.summary}`).join("\n")
        : "(Direct land with no extra reviewer rounds)";
    const specExcerpt = issue.body_md ? issue.body_md.slice(0, 600) : "(None)";
    const checkSummary = land.pause_reason
      ? `Had merge-queue pause (${land.pause_reason}: ${land.error ?? ""}).`
      : "Clean rebase & checks passed.";

    const digestPrompt = [
      `[post-land-soul-digest for Issue #${issue.number}: "${issue.title}"]`,
      `Outcome: Landed cleanly via ${land.trigger}${land.landed_sha ? ` (${land.landed_sha.slice(0, 10)})` : ""}.`,
      `Specification:\n${specExcerpt}`,
      `Final implementation report:\n${sess?.last_report ?? "(None)"}`,
      `Review findings:\n${reviewSummary}`,
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

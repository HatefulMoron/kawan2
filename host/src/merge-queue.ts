import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { KawanDb } from "./db.js";
import {
  branchTouchesKawanDir,
  commitsAhead,
  commitsBehindMain,
  finalizeLandingPush,
  isWorkingTreeClean,
  prepareLandingClone,
  runGit,
  runRepoChecks,
} from "./git.js";
import type { SessionManager } from "./sessions.js";
import { deriveTaskTitle } from "./sessions.js";
import type {
  CheckRunItem,
  ConversationRow,
  LandRow,
  LandingMode,
  MergeConflictPolicy,
  MessageRow,
  ProposalCard,
  SerializedLand,
  SessionRow,
  UserRow,
} from "./types.js";
import { OPEN_LAND_STATUSES, serializeLand, serializeMessage } from "./types.js";
import type { KawanWsServer } from "./ws.js";

export interface MergeQueueSnapshot {
  conversation_id: string;
  settings: {
    bot_id: string | null;
    default_landing_mode: LandingMode;
    conflict_policy: MergeConflictPolicy;
    paused: boolean;
  };
  /** Open proposals awaiting a human **Merge** (or auto mode). */
  proposed: ProposalCard[];
  head: SerializedLand | null;
  queued: SerializedLand[];
  paused_land: SerializedLand | null;
  recent_landed: SerializedLand[];
}

export interface ProposeLandInput {
  sessionId: string;
  bodyMd: string;
  title?: string | null;
  attachmentIds?: string[];
  issueId?: string | null;
}

export interface ProposeLandResult {
  land: LandRow;
  message: MessageRow;
  title: string;
  created: boolean;
  status: string;
}

export class MergeQueueManager {
  private readonly dataDir: string;
  private readonly db: KawanDb;
  private readonly wsServer: KawanWsServer;
  private readonly sessionManager: SessionManager;
  private readonly disableSandbox: boolean;

  private lockChain: Promise<void> = Promise.resolve();
  private loopRunning = false;
  private closed = false;
  private settlementWaiters = new Map<string, Array<(land: LandRow) => void>>();
  private onIssueLandSync?: (land: LandRow) => void;
  /** Branch metrics for proposal rows; refreshed whenever we evaluate a proposal. */
  private proposalMetrics = new Map<string, { commitsAhead: number; behindMain: number }>();

  constructor(opts: {
    dataDir: string;
    db: KawanDb;
    wsServer: KawanWsServer;
    sessionManager: SessionManager;
    disableSandbox?: boolean;
  }) {
    this.dataDir = opts.dataDir;
    this.db = opts.db;
    this.wsServer = opts.wsServer;
    this.sessionManager = opts.sessionManager;
    this.disableSandbox = Boolean(opts.disableSandbox);

    this.sessionManager.setQueueHandlers({
      resumeAndLand: (queueSession, summary) => this.handleBotResumeAndLand(queueSession, summary),
      ejectToImplementer: (queueSession, reason) =>
        this.handleBotEjectToImplementer(queueSession, reason),
    });
    this.sessionManager.setProposalHandlers({
      propose: (input) =>
        this.proposeLand({
          sessionId: input.sessionId,
          bodyMd: input.bodyMd,
          title: input.title,
          attachmentIds: input.attachmentIds,
        }),
      withdraw: (input) => this.withdrawBranchProposal(input.sessionId, input.by, input.reason),
    });
  }

  setIssueSyncCallback(cb: (land: LandRow) => void): void {
    this.onIssueLandSync = cb;
  }

  private emitLandUpdate(land: LandRow): void {
    this.wsServer.broadcast({ type: "land.update", land: serializeLand(land) });
    if (this.onIssueLandSync) {
      this.onIssueLandSync(land);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.resolveAllPendingWaiters();
    await this.lockChain.catch(() => {});
  }

  private withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockChain.then(fn, fn);
    this.lockChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private resolveWaiters(land: LandRow): void {
    const list = this.settlementWaiters.get(land.id);
    if (!list || list.length === 0) return;
    this.settlementWaiters.delete(land.id);
    for (const resolve of list) {
      resolve(land);
    }
  }

  private resolveAllPendingWaiters(): void {
    for (const [landId, list] of [...this.settlementWaiters.entries()]) {
      const latest = this.db.getLand(landId);
      if (latest) {
        this.settlementWaiters.delete(landId);
        for (const resolve of list) resolve(latest);
      }
    }
  }

  private effectiveQueueBotId(): string | null {
    const settings = this.db.getHostSettings();
    const configured = settings.merge_queue?.bot_id;
    if (configured) {
      const bot = this.db.getUser(configured);
      if (bot && bot.kind === "bot") return bot.id;
    }
    const firstBot = this.db.listUsers("bot")[0];
    return firstBot ? firstBot.id : null;
  }

  ensureConversation(): ConversationRow {
    const existed = Boolean(this.db.getMergeQueueConversation());
    const humans = this.db.listUsers("human").map((u) => u.id);
    const botId = this.effectiveQueueBotId();
    const memberIds = botId ? [...humans, botId] : humans;
    const conv = this.db.ensureMergeQueueConversation(memberIds);
    this.db.syncMergeQueueBotMember(conv.id, botId);
    if (!existed) {
      const payload = {
        ...conv,
        last_seq: conv.next_seq - 1,
        last_read_seq: 0,
        unread_count: 0,
        members: this.db.listMembers(conv.id).map((m) => ({
          id: m.id,
          kind: m.kind,
          name: m.name,
          role: m.role,
        })),
      };
      this.wsServer.broadcastToConversation(conv, {
        type: "conversation.new",
        conversation: payload,
      });
    }
    return conv;
  }

  getSnapshot(): MergeQueueSnapshot {
    const conv = this.ensureConversation();
    const settings = this.db.getHostSettings();
    const botId = this.effectiveQueueBotId();
    const activeQueue = this.db.listQueuedLands();
    const head = activeQueue[0] ? serializeLand(activeQueue[0]) : null;
    const pausedLand =
      activeQueue.map(serializeLand).find((l) => l.status === "paused") ?? null;
    const recentLanded = this.db
      .listLands()
      .filter((l) => l.status === "landed")
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 10)
      .map(serializeLand);
    const proposed = this.db
      .listProposedLands()
      .map((land) => this.buildProposalCard(land))
      .filter((card): card is ProposalCard => card !== null);

    return {
      conversation_id: conv.id,
      settings: {
        bot_id: botId,
        default_landing_mode: settings.merge_queue?.default_landing_mode ?? "manual",
        conflict_policy: settings.merge_queue?.conflict_policy ?? "pause_on_issue",
        paused: Boolean(settings.merge_queue?.paused || pausedLand),
      },
      proposed,
      head,
      queued: activeQueue.map(serializeLand),
      paused_land: pausedLand,
      recent_landed: recentLanded,
    };
  }

  private buildProposalCard(land: LandRow): ProposalCard | null {
    if (!land.message_id) return null;
    const message = this.db.getMessage(land.message_id);
    if (!message) return null;
    const author = this.db.getUser(message.author_id);
    if (!author) return null;
    const session = this.db.getSession(land.session_id);
    const issue = land.issue_id ? this.db.getIssue(land.issue_id) : null;
    const metrics = this.proposalMetrics.get(land.id);
    let checks: CheckRunItem[] = [];
    if (land.checks_json) {
      try {
        const parsed = JSON.parse(land.checks_json);
        if (Array.isArray(parsed)) checks = parsed as CheckRunItem[];
      } catch {
        checks = [];
      }
    }
    return {
      land: serializeLand(land),
      message: serializeMessage(message),
      author: { id: author.id, kind: author.kind, name: author.name },
      session_title: session?.title ?? null,
      checks,
      commits_ahead: metrics?.commitsAhead ?? issue?.commits_ahead ?? 0,
      behind_main: metrics?.behindMain ?? issue?.behind_main ?? 0,
      issue_number: issue?.number ?? null,
      updated_at: land.updated_at,
    };
  }

  broadcastSnapshot(): void {
    this.wsServer.broadcast({
      type: "merge_queue.update",
      queue: this.getSnapshot(),
    });
  }

  configure(patch: {
    bot_id?: string | null;
    default_landing_mode?: LandingMode;
    conflict_policy?: MergeConflictPolicy;
  }): MergeQueueSnapshot {
    const settings = this.db.getHostSettings();
    const prev = settings.merge_queue ?? {};
    let nextBotId = prev.bot_id ?? null;
    if (patch.bot_id !== undefined) {
      if (patch.bot_id === null || patch.bot_id === "") {
        nextBotId = null;
      } else {
        const bot = this.db.getUser(patch.bot_id);
        if (!bot || bot.kind !== "bot") {
          throw new Error(`Queue bot not found: ${patch.bot_id}`);
        }
        nextBotId = bot.id;
      }
    }
    settings.merge_queue = {
      bot_id: nextBotId,
      default_landing_mode:
        patch.default_landing_mode ?? prev.default_landing_mode ?? "manual",
      conflict_policy:
        patch.conflict_policy ?? prev.conflict_policy ?? "pause_on_issue",
      paused: Boolean(prev.paused),
    };
    this.db.saveHostSettings(settings);
    this.ensureConversation();
    const snap = this.getSnapshot();
    this.wsServer.broadcast({ type: "merge_queue.update", queue: snap });
    return snap;
  }

  private setPausedFlag(paused: boolean): void {
    const settings = this.db.getHostSettings();
    settings.merge_queue = {
      ...(settings.merge_queue ?? {}),
      paused,
    };
    this.db.saveHostSettings(settings);
  }

  pauseQueue(): MergeQueueSnapshot {
    this.setPausedFlag(true);
    this.resolveAllPendingWaiters();
    const snap = this.getSnapshot();
    this.wsServer.broadcast({ type: "merge_queue.update", queue: snap });
    return snap;
  }

  resumeQueue(): MergeQueueSnapshot {
    const queue = this.db.listQueuedLands();
    const head = queue[0];
    if (head && head.status === "paused") {
      // Unpausing a paused head re-queues it so processLoop picks up cleanly
      const updated = this.db.updateLand(head.id, {
        status: "queued",
        pause_reason: null,
        error: null,
      })!;
      this.emitLandUpdate(updated);
    }
    this.setPausedFlag(false);
    this.broadcastSnapshot();
    void this.kickLoop();
    return this.getSnapshot();
  }

  // ---- Proposals: create / amend, accept, withdraw ----

  private findOpenLand(sessionId: string): LandRow | null {
    const open = this.db
      .listLands({ sessionId })
      .filter((l) => OPEN_LAND_STATUSES.includes(l.status));
    return open.length > 0 ? open[open.length - 1] : null;
  }

  private proposalTitle(land: LandRow, session: SessionRow): string {
    const issue = land.issue_id ? this.db.getIssue(land.issue_id) : null;
    if (issue) return `#${issue.number} ${issue.title}`;
    return deriveTaskTitle(session.task, session.title);
  }

  private postHostNotice(
    conversation: ConversationRow | null,
    bot: UserRow | null,
    body: string,
    threadId: string | null = null,
  ): void {
    if (!conversation || !bot) return;
    const msg = this.db.appendMessage({
      conversationId: conversation.id,
      authorId: bot.id,
      threadId,
      body,
    });
    // Host-authored notices are broadcast directly and never routed to bots.
    this.wsServer.broadcastToConversation(conversation, {
      type: "message.new",
      message: serializeMessage(msg),
      author: { id: bot.id, kind: bot.kind, name: bot.name },
    });
  }

  /**
   * Create or amend the branch's proposal. The proposal is an ordinary message in
   * #merge-queue plus a `lands` row in state `proposed`; the message body is the
   * changelog of record. Calling this again on the same branch rewrites that same
   * message and row instead of opening a second proposal.
   */
  async proposeLand(input: ProposeLandInput): Promise<ProposeLandResult> {
    const bodyMd = input.bodyMd.trim();
    if (!bodyMd) throw new Error("proposal summary cannot be empty");

    const session = this.db.getSession(input.sessionId);
    if (!session) throw new Error(`Session not found: ${input.sessionId}`);
    if (!session.clone_path || !existsSync(session.clone_path)) {
      throw new Error("Worker clone directory is missing");
    }
    const settings = this.db.getHostSettings();
    const repo = settings.repo;
    if (!repo?.bare_path) throw new Error("Repository is not configured");

    const { stdout: branchOut } = await runGit([
      "-C",
      session.clone_path,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const currentBranch = branchOut.trim();
    if (session.branch && currentBranch !== session.branch) {
      throw new Error(
        `Currently on branch '${currentBranch}'; commits must be on your assigned session branch '${session.branch}'.`,
      );
    }
    if (!(await isWorkingTreeClean(session.clone_path))) {
      throw new Error(
        "Working tree has uncommitted changes; run git add && git commit before proposing",
      );
    }
    const ahead = await commitsAhead(session.clone_path, repo.default_branch);
    if (ahead < 1) {
      throw new Error(
        `Branch ${session.branch ?? currentBranch} has 0 commits ahead of ${repo.default_branch}; commit changes before proposing`,
      );
    }

    const bot = this.db.getUser(session.bot_id);
    if (!bot) throw new Error("Bot not found");
    const issue =
      (input.issueId ? this.db.getIssue(input.issueId) : null) ??
      this.db.getIssueBySessionId(session.id) ??
      (session.conversation_id ? this.db.getIssueByConversationId(session.conversation_id) : null);
    const origin = issue
      ? this.db.getConversation(issue.conversation_id)
      : session.conversation_id
        ? this.db.getConversation(session.conversation_id)
        : null;
    const mqConv = this.ensureConversation();
    const touchesKawan = await branchTouchesKawanDir(session.clone_path, repo.default_branch);
    const attachmentIds = input.attachmentIds ?? [];
    const existing = this.findOpenLand(session.id);

    let land: LandRow;
    let message: MessageRow;
    let title: string;
    const created = !existing;

    if (existing) {
      const existingMessage = existing.message_id ? this.db.getMessage(existing.message_id) : null;
      message = existingMessage
        ? this.db.updateProposalMessage(existingMessage.id, {
            body: bodyMd,
            // An amendment without evidence keeps the attachments already on the
            // proposal; the orchestrator has no way to re-supply them by id.
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          })
        : this.db.createProposalMessage({
            conversationId: mqConv.id,
            authorId: bot.id,
            body: bodyMd,
            attachmentIds,
          });
      const reopen = existing.status === "failed";
      const previousAttachmentIds = new Set(
        (existingMessage?.attachments ?? []).map((a) => a.id),
      );
      land = this.db.updateLand(existing.id, {
        status: reopen ? "proposed" : existing.status,
        message_id: message.id,
        conversation_id: origin?.id ?? existing.conversation_id,
        thread_id: session.thread_id,
        issue_id: issue?.id ?? existing.issue_id,
        touches_kawan: touchesKawan ? 1 : 0,
        checks_json: issue?.checks_json ?? existing.checks_json,
        queue_position: reopen ? null : existing.queue_position,
        // A fresh evaluation follows, so stale reopen failure text is cleared;
        // a paused/queued item keeps the reason the head card shows.
        error: reopen ? null : existing.error,
      })!;
      title = input.title?.trim() || this.proposalTitle(land, session);
      this.proposalMetrics.set(land.id, {
        commitsAhead: ahead,
        behindMain: issue?.behind_main ?? this.proposalMetrics.get(land.id)?.behindMain ?? 0,
      });
      // Mirror the create branch so `message.*` stays truthful for live consumers.
      this.wsServer.broadcastToConversation(mqConv, {
        type: "message.new",
        message: serializeMessage(message),
        author: { id: bot.id, kind: bot.kind, name: bot.name },
      });
      for (const attachment of message.attachments) {
        if (previousAttachmentIds.has(attachment.id)) continue;
        this.wsServer.broadcastToConversation(mqConv, {
          type: "artifact.new",
          artifact: attachment,
        });
      }
      this.emitLandUpdate(land);
      this.broadcastSnapshot();
      this.postHostNotice(origin, bot, `Proposal updated: ${title}`, session.thread_id);
      void this.evaluateProposal(land.id);
    } else {
      message = this.db.createProposalMessage({
        conversationId: mqConv.id,
        authorId: bot.id,
        body: bodyMd,
        attachmentIds,
      });
      land = this.db.createLand({
        sessionId: session.id,
        conversationId: origin?.id ?? mqConv.id,
        threadId: session.thread_id,
        messageId: message.id,
        issueId: issue?.id ?? null,
        trigger: "proposal",
      });
      land = this.db.updateLand(land.id, {
        touches_kawan: touchesKawan ? 1 : 0,
        checks_json: issue?.checks_json ?? null,
      })!;
      title = input.title?.trim() || this.proposalTitle(land, session);
      this.proposalMetrics.set(land.id, {
        commitsAhead: ahead,
        behindMain: issue?.behind_main ?? 0,
      });

      this.wsServer.broadcastToConversation(mqConv, {
        type: "message.new",
        message: serializeMessage(message),
        author: { id: bot.id, kind: bot.kind, name: bot.name },
      });
      for (const attachment of message.attachments) {
        this.wsServer.broadcastToConversation(mqConv, {
          type: "artifact.new",
          artifact: attachment,
        });
      }
      this.emitLandUpdate(land);
      this.broadcastSnapshot();
      this.postHostNotice(origin, bot, `Proposed for merge: ${title} → Merge Queue`, session.thread_id);
      void this.evaluateProposal(land.id);
    }

    return { land, message, title, created, status: land.status };
  }

  /** Warm the proposal rows' branch metrics (they are not persisted). */
  async refreshProposalMetrics(): Promise<void> {
    const repo = this.db.getHostSettings().repo;
    if (!repo?.bare_path) return;
    for (const land of this.db.listProposedLands()) {
      const session = this.db.getSession(land.session_id);
      if (this.closed) return;
      if (!session?.clone_path || !existsSync(session.clone_path)) continue;
      const [ahead, behind] = await Promise.all([
        commitsAhead(session.clone_path, repo.default_branch).catch(() => 0),
        commitsBehindMain(repo.bare_path, session.clone_path, repo.default_branch).catch(() => 0),
      ]);
      this.proposalMetrics.set(land.id, { commitsAhead: ahead, behindMain: behind });
    }
    if (!this.closed) this.broadcastSnapshot();
  }

  private withdrawBranchProposal(
    sessionId: string,
    by: string,
    reason?: string | null,
  ): Promise<MergeQueueSnapshot> {
    const land = this.findOpenLand(sessionId);
    if (!land) throw new Error("This branch has no open proposal to withdraw");
    return this.withdrawProposal(land.id, by, reason ?? undefined);
  }

  /** Pull an open proposal back: `withdrawn`, out of the train, never landed. */
  async withdrawProposal(
    landId: string,
    by: string,
    reason?: string,
  ): Promise<MergeQueueSnapshot> {
    return await this.withQueueLock(async () => {
      const land = this.db.getLand(landId);
      if (!land) throw new Error(`Proposal not found: ${landId}`);
      if (land.status === "landed") throw new Error("Proposal has already landed");
      if (land.status === "withdrawn") return this.getSnapshot();

      if (land.queue_session_id) {
        await this.sessionManager.stopSession(land.queue_session_id);
      }
      rmSync(join(this.dataDir, "workspaces", `landing-${land.id}`), {
        recursive: true,
        force: true,
      });
      const wasPaused = land.status === "paused";
      const trimmedReason = reason?.trim() ?? "";
      const updated = this.db.updateLand(land.id, {
        status: "withdrawn",
        queue_position: null,
        pause_reason: null,
        error: trimmedReason || null,
      })!;
      this.emitLandUpdate(updated);

      const session = this.db.getSession(land.session_id);
      if (
        session &&
        session.status !== "landed" &&
        session.status !== "stopped" &&
        session.status !== "running"
      ) {
        const idle = this.db.updateSession(session.id, { status: "idle" })!;
        this.wsServer.broadcast({
          type: "session.update",
          session: this.sessionManager.serializePublicSession(idle),
        });
      }

      if (wasPaused) {
        this.setPausedFlag(false);
      }
      const bot = session ? this.db.getUser(session.bot_id) : null;
      const title = session ? this.proposalTitle(updated, session) : "proposal";
      const actor = this.db.getUser(by);
      const actorSuffix = actor && actor.kind === "human" ? ` by @${actor.name}` : "";
      this.postHostNotice(
        this.db.getConversation(land.conversation_id),
        bot,
        trimmedReason
          ? `Proposal withdrawn${actorSuffix}: ${title} — ${trimmedReason}`
          : `Proposal withdrawn${actorSuffix}: ${title}`,
        land.thread_id,
      );

      this.resolveWaiters(updated);
      this.broadcastSnapshot();
      setImmediate(() => {
        void this.kickLoop();
      });
      return this.getSnapshot();
    });
  }

  /**
   * Trial-run a fresh proposal: rebase a throwaway clone and run the repo checks
   * so the proposal row can show honest check pills and commit counts. Under
   * `default_landing_mode: "auto"` a clean proposal is accepted straight into the
   * train; under `manual` it stays in `proposed` for a human **Merge**.
   */
  private async evaluateProposal(landId: string): Promise<void> {
    if (this.closed) return;
    const land = this.db.getLand(landId);
    if (!land || land.status !== "proposed") return;
    const session = this.db.getSession(land.session_id);
    const bot = session ? this.db.getUser(session.bot_id) : null;
    const settings = this.db.getHostSettings();
    const repo = settings.repo;
    if (
      !session?.clone_path ||
      !session.branch ||
      !existsSync(session.clone_path) ||
      !bot?.signing_key_path ||
      !repo?.bare_path
    ) {
      return;
    }

    const landingDir = join(this.dataDir, "workspaces", `proposal-${land.id}`);
    let prep;
    try {
      prep = await prepareLandingClone({
        barePath: repo.bare_path,
        clonePath: session.clone_path,
        branchName: session.branch,
        defaultBranch: repo.default_branch,
        botName: bot.name,
        botEmail: bot.email ?? `${bot.name.toLowerCase()}@kawan.local`,
        signingKeyPath: bot.signing_key_path,
        landingDir,
      });
    } catch (err) {
      prep = {
        ok: false,
        baseSha: "",
        // The trial never ran, so the persisted `.kawan/` guard stands: clearing it
        // here would silently drop the second-confirmation requirement.
        touchesKawan: land.touches_kawan === 1,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const [ahead, behind] = await Promise.all([
      commitsAhead(session.clone_path, repo.default_branch).catch(() => 0),
      commitsBehindMain(repo.bare_path, session.clone_path, repo.default_branch).catch(() => 0),
    ]);
    this.proposalMetrics.set(land.id, { commitsAhead: ahead, behindMain: behind });

    let checks: CheckRunItem[] = [];
    let verifyOutput = "";
    let checksOk = false;
    if (prep.ok) {
      try {
        const res = await runRepoChecks({
          workdir: landingDir,
          verifyCommand: settings.verify_command,
          sandboxEnabled: Boolean(bot.sandbox_enabled),
          sandboxNetwork: Boolean(bot.sandbox_network),
          disableSandbox: this.disableSandbox,
        });
        checks = res.checks;
        verifyOutput = res.combined_output;
        checksOk = res.ok;
      } catch (err) {
        prep = {
          ...prep,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    rmSync(landingDir, { recursive: true, force: true });
    if (this.closed) return;

    const current = this.db.getLand(land.id);
    if (!current || current.status !== "proposed") {
      this.broadcastSnapshot();
      return;
    }
    const updated = this.db.updateLand(land.id, {
      base_sha: prep.ok ? prep.baseSha : current.base_sha,
      touches_kawan: prep.touchesKawan || current.touches_kawan === 1 ? 1 : 0,
      checks_json: checks.length > 0 ? JSON.stringify(checks) : current.checks_json,
      verify_output: verifyOutput || current.verify_output,
      error: prep.ok ? null : (prep.error ?? "Rebase onto the default branch failed"),
    })!;
    this.emitLandUpdate(updated);
    this.broadcastSnapshot();

    const mode = this.db.getHostSettings().merge_queue?.default_landing_mode ?? "manual";
    if (mode !== "auto" || !prep.ok || !checksOk || prep.touchesKawan) return;
    await this.acceptWhenIdle(land.id);
  }

  /** Auto mode must not yank the branch out from under a still-running worker turn. */
  private async acceptWhenIdle(landId: string): Promise<void> {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (this.closed) return;
      const land = this.db.getLand(landId);
      if (!land || land.status !== "proposed") return;
      const session = this.db.getSession(land.session_id);
      if (!session || session.status !== "running") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    if (this.closed) return;
    const land = this.db.getLand(landId);
    if (!land || land.status !== "proposed") return;
    try {
      await this.acceptProposal(landId, {
        by: null,
        trigger: "auto_land",
        waitForSettlement: false,
      });
    } catch {
      // Leave the proposal in `proposed`; a human Merge will surface the reason.
    }
  }

  /**
   * Human **Merge** (or auto mode): `proposed` → `queued`, then the train starts in
   * queue order exactly as before. Accepting needs no separate approval step.
   */
  async acceptProposal(
    landId: string,
    params: {
      by: string | null;
      trigger?: "manual_approve" | "auto_land";
      waitForSettlement?: boolean;
    },
  ): Promise<{ land: SerializedLand; session: Omit<SessionRow, "token"> }> {
    const land = this.db.getLand(landId);
    if (!land) throw new Error(`Proposal not found: ${landId}`);
    if (land.status !== "proposed" && land.status !== "failed") {
      throw new Error(`Proposal ${land.id} is already ${land.status}`);
    }

    const session = this.db.getSession(land.session_id);
    if (!session || !session.clone_path || !session.branch) {
      throw new Error("Worker session or clone missing for proposal");
    }
    if (!existsSync(session.clone_path)) {
      throw new Error(`Worker clone no longer exists: ${session.clone_path}`);
    }
    const bot = this.db.getUser(session.bot_id);
    if (!bot || !bot.signing_key_path) {
      throw new Error("Bot or bot signing key not found");
    }
    const settings = this.db.getHostSettings();
    if (!settings.repo?.bare_path) {
      throw new Error("Repository is not configured");
    }

    // Stop live worker process cleanly so no concurrent edits happen after accepting
    await this.sessionManager.stopProcessOnly(session.id);

    const queuePos = this.db.nextQueuePosition();
    const queuedLand = this.db.updateLand(land.id, {
      status: "queued",
      approved_by: params.by,
      trigger: params.trigger ?? "manual_approve",
      queue_position: queuePos,
      pause_reason: null,
      error: null,
    })!;
    this.emitLandUpdate(queuedLand);
    this.broadcastSnapshot();

    const waitForSettlement = params.waitForSettlement ?? false;
    const isPausedNow = Boolean(this.db.getHostSettings().merge_queue?.paused);
    if (!waitForSettlement || isPausedNow) {
      void this.kickLoop();
      const latestSession = this.db.getSession(session.id) ?? session;
      return {
        land: serializeLand(queuedLand),
        session: this.sessionManager.serializePublicSession(latestSession),
      };
    }

    const settledPromise = new Promise<LandRow>((resolveSettled) => {
      const existing = this.settlementWaiters.get(land.id) ?? [];
      existing.push(resolveSettled);
      this.settlementWaiters.set(land.id, existing);
    });
    void this.kickLoop();
    const settled = await settledPromise;
    const latestSession = this.db.getSession(session.id) ?? session;
    return {
      land: serializeLand(settled),
      session: this.sessionManager.serializePublicSession(latestSession),
    };
  }

  async kickLoop(): Promise<void> {
    if (this.loopRunning || this.closed) return;
    this.loopRunning = true;
    try {
      await this.withQueueLock(async () => {
        while (!this.closed) {
          const settings = this.db.getHostSettings();
          if (settings.merge_queue?.paused) break;
          const queue = this.db.listQueuedLands();
          const head = queue[0];
          if (!head || head.status === "paused") break;
          await this.processHeadUnsafe(head.id);
        }
      });
    } finally {
      this.loopRunning = false;
    }
  }

  private async processHeadUnsafe(landId: string): Promise<void> {
    const land = this.db.getLand(landId);
    if (!land || land.status === "landed" || land.status === "withdrawn" || land.status === "failed") {
      return;
    }
    const session = this.db.getSession(land.session_id);
    const bot = session ? this.db.getUser(session.bot_id) : null;
    const settings = this.db.getHostSettings();
    const repo = settings.repo;

    if (!session || !session.clone_path || !session.branch || !existsSync(session.clone_path) || !bot?.signing_key_path || !repo?.bare_path) {
      const failedLand = this.db.updateLand(land.id, {
        status: "failed",
        queue_position: null,
        error: "Session clone, bot signing key, or repository missing",
      })!;
      if (session) {
        const fs = this.db.updateSession(session.id, { status: "failed" })!;
        this.wsServer.broadcast({ type: "session.update", session: this.sessionManager.serializePublicSession(fs) });
      }
      this.wsServer.broadcast({ type: "land.update", land: serializeLand(failedLand) });
      this.resolveWaiters(failedLand);
      this.broadcastSnapshot();
      return;
    }

    const landingDir = join(this.dataDir, "workspaces", `landing-${land.id}`);
    const rebasing = this.db.updateLand(land.id, {
      status: "rebasing",
      pause_reason: null,
      error: null,
    })!;
    this.emitLandUpdate(rebasing);
    this.broadcastSnapshot();

    let prep;
    try {
      prep = await prepareLandingClone({
        barePath: repo.bare_path,
        clonePath: session.clone_path,
        branchName: session.branch,
        defaultBranch: repo.default_branch,
        botName: bot.name,
        botEmail: bot.email ?? `${bot.name.toLowerCase()}@kawan.local`,
        signingKeyPath: bot.signing_key_path,
        landingDir,
      });
    } catch (err) {
      prep = {
        ok: false,
        baseSha: "",
        // Same guard as the trial: keep what the row already knows on failure.
        touchesKawan: land.touches_kawan === 1,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const taskTitle = deriveTaskTitle(session.task, session.title);

    if (!prep.ok) {
      await this.pauseHeadOnFriction({
        land: rebasing,
        session,
        bot,
        landingDir,
        baseSha: prep.baseSha,
        touchesKawan: prep.touchesKawan,
        pauseReason: "rebase_conflict",
        errorText: prep.error ?? `Rebase onto ${repo.default_branch} failed`,
        verifyOutput: prep.error ?? "",
        checks: [],
        taskTitle,
      });
      return;
    }

    const verifying = this.db.updateLand(land.id, {
      status: "verifying",
      base_sha: prep.baseSha,
      touches_kawan: prep.touchesKawan ? 1 : 0,
    })!;
    this.emitLandUpdate(verifying);
    this.broadcastSnapshot();

    const checkRes = await runRepoChecks({
      workdir: landingDir,
      verifyCommand: settings.verify_command,
      sandboxEnabled: Boolean(bot.sandbox_enabled),
      sandboxNetwork: Boolean(bot.sandbox_network),
      disableSandbox: this.disableSandbox,
    });

    const checksWithArtifacts: CheckRunItem[] = [];
    const mqConv = this.ensureConversation();
    for (const item of checkRes.checks) {
      let artifactId: string | null = null;
      if (!item.ok && item.output.trim()) {
        const art = this.sessionManager.createTextArtifact({
          content: item.output,
          filename: `check-${item.name}.log`,
          sessionId: session.id,
          conversationId: mqConv.id,
        });
        artifactId = art.id;
      }
      checksWithArtifacts.push({ ...item, artifact_id: artifactId });
    }

    if (!checkRes.ok) {
      const firstFail = checkRes.checks.find((c) => !c.ok);
      const errText = `Verification failed (${firstFail?.name ?? "check"} exit ${firstFail?.exit_code ?? "null"}):\n${checkRes.combined_output}`;
      await this.pauseHeadOnFriction({
        land: verifying,
        session,
        bot,
        landingDir,
        baseSha: prep.baseSha,
        touchesKawan: prep.touchesKawan,
        pauseReason: "checks_failed",
        errorText: errText,
        verifyOutput: checkRes.combined_output,
        checks: checksWithArtifacts,
        taskTitle,
      });
      return;
    }

    // Fast-path: clean rebase + all checks passed -> push & clean up without Queue Bot turn
    await this.finishSuccessfulLand({
      land: verifying,
      session,
      bot,
      landingDir,
      defaultBranch: repo.default_branch,
      barePath: repo.bare_path,
      baseSha: prep.baseSha,
      checks: checksWithArtifacts,
      verifyOutput: checkRes.combined_output,
      touchesKawan: prep.touchesKawan,
      taskTitle,
    });
  }

  private async finishSuccessfulLand(params: {
    land: LandRow;
    session: SessionRow;
    bot: UserRow;
    landingDir: string;
    defaultBranch: string;
    barePath: string;
    baseSha: string;
    checks: CheckRunItem[];
    verifyOutput: string;
    touchesKawan: boolean;
    taskTitle: string;
    note?: string;
    callerQueueSessionId?: string;
  }): Promise<LandRow> {
    const landedSha = await finalizeLandingPush({
      landingDir: params.landingDir,
      barePath: params.barePath,
      defaultBranch: params.defaultBranch,
    });
    rmSync(params.landingDir, { recursive: true, force: true });
    if (params.session.clone_path) {
      rmSync(params.session.clone_path, { recursive: true, force: true });
    }

    const landed = this.db.updateLand(params.land.id, {
      status: "landed",
      base_sha: params.baseSha,
      landed_sha: landedSha,
      verify_output: params.verifyOutput,
      checks_json: JSON.stringify(params.checks),
      touches_kawan: params.touchesKawan ? 1 : 0,
      pause_reason: null,
      error: null,
      queue_position: null,
    })!;
    const updatedSession = this.db.updateSession(params.session.id, { status: "landed" })!;
    if (landed.queue_session_id) {
      if (landed.queue_session_id === params.callerQueueSessionId) {
        this.sessionManager.markStopAfterTurn(landed.queue_session_id);
      } else {
        await this.sessionManager.stopSession(landed.queue_session_id);
      }
    }
    this.setPausedFlag(false);
    this.emitLandUpdate(landed);
    this.wsServer.broadcast({
      type: "session.update",
      session: this.sessionManager.serializePublicSession(updatedSession),
    });

    const originConv = this.db.getConversation(landed.conversation_id);
    if (originConv) {
      const msg = this.db.appendMessage({
        conversationId: originConv.id,
        authorId: params.bot.id,
        threadId: landed.thread_id,
        body: params.note
          ? `Landed "${params.taskTitle}" on \`${params.defaultBranch}\` (${params.note}).`
          : `Landed "${params.taskTitle}" on \`${params.defaultBranch}\`.`,
      });
      this.wsServer.broadcastToConversation(originConv, {
        type: "message.new",
        message: msg,
        author: { id: params.bot.id, kind: "bot", name: params.bot.name },
      });
    }

    this.resolveWaiters(landed);
    this.broadcastSnapshot();
    return landed;
  }

  private async pauseHeadOnFriction(params: {
    land: LandRow;
    session: SessionRow;
    bot: UserRow;
    landingDir: string;
    baseSha: string;
    touchesKawan: boolean;
    pauseReason: string;
    errorText: string;
    verifyOutput: string;
    checks: CheckRunItem[];
    taskTitle: string;
  }): Promise<void> {
    this.setPausedFlag(true);
    const mqConv = this.ensureConversation();
    const queueBotId = this.effectiveQueueBotId();
    const queueBot = queueBotId ? this.db.getUser(queueBotId) : params.bot;

    let incidentArtId: string | null = null;
    if (params.errorText.trim()) {
      const art = this.sessionManager.createTextArtifact({
        content: params.errorText,
        filename: "merge-failure.log",
        sessionId: params.session.id,
        conversationId: mqConv.id,
      });
      incidentArtId = art.id;
      this.wsServer.broadcastToConversation(mqConv, {
        type: "artifact.new",
        artifact: art,
      });
    }

    const originLabel = (() => {
      const c = this.db.getConversation(params.land.conversation_id);
      return c?.kind === "channel" ? `#${c.name ?? "channel"}` : "DM";
    })();
    const reasonLabel =
      params.pauseReason === "rebase_conflict"
        ? "rebase conflict"
        : "post-rebase verification failed";
    const firstLine = params.errorText.split(/\r?\n/).find((l) => l.trim().length > 0) ?? reasonLabel;

    let incidentMsgId = params.land.queue_thread_id;
    if (queueBot && !incidentMsgId) {
      const msg = this.db.appendMessage({
        conversationId: mqConv.id,
        authorId: queueBot.id,
        body: `Paused Merge Queue on "${params.taskTitle}" (${originLabel} · ${reasonLabel}).\n${firstLine}`,
        attachmentIds: incidentArtId ? [incidentArtId] : [],
      });
      incidentMsgId = msg.id;
      this.wsServer.broadcastToConversation(mqConv, {
        type: "message.new",
        message: serializeMessage(msg),
        author: { id: queueBot.id, kind: "bot", name: queueBot.name },
      });
    }

    const originConv = this.db.getConversation(params.land.conversation_id);
    if (originConv) {
      const msg = this.db.appendMessage({
        conversationId: originConv.id,
        authorId: params.bot.id,
        threadId: params.land.thread_id,
        body: `Merge queue paused for "${params.taskTitle}" — reconcile in #merge-queue:\n${params.errorText}`,
      });
      this.wsServer.broadcastToConversation(originConv, {
        type: "message.new",
        message: msg,
        author: { id: params.bot.id, kind: "bot", name: params.bot.name },
      });
    }

    let pausedLand = this.db.updateLand(params.land.id, {
      status: "paused",
      base_sha: params.baseSha || params.land.base_sha,
      pause_reason: params.pauseReason,
      error: params.errorText,
      verify_output: params.verifyOutput,
      checks_json: JSON.stringify(params.checks),
      touches_kawan: params.touchesKawan ? 1 : 0,
      queue_thread_id: incidentMsgId ?? null,
    })!;

    this.emitLandUpdate(pausedLand);
    this.resolveWaiters(pausedLand);
    this.resolveAllPendingWaiters();
    this.broadcastSnapshot();

    if (queueBot) {
      const policy = this.db.getHostSettings().merge_queue?.conflict_policy ?? "pause_on_issue";
      const qSess = await this.sessionManager.ensureQueueSession({
        bot: queueBot,
        land: pausedLand,
        mqConv,
        incidentThreadId: incidentMsgId ?? null,
        landingDir: params.landingDir,
        taskTitle: params.taskTitle,
      });
      pausedLand = this.db.updateLand(pausedLand.id, { queue_session_id: qSess.id })!;
      this.emitLandUpdate(pausedLand);
      this.broadcastSnapshot();

      const diagnosticPrompt = [
        `Merge Queue #${pausedLand.queue_position ?? 1} paused on "${params.taskTitle}" (${reasonLabel}).`,
        `Conflict policy: ${policy}.`,
        "",
        "Error / check output:",
        params.errorText,
        "",
        policy === "auto_resolve_trivial"
          ? "Inspect the landing repository. If it is a small, clean, unambiguous conflict or quick fix, resolve it, complete any rebase (`git add` and `git rebase --continue` without --skip unless certain), and call `resume_and_land(summary)`. If anything is semantically ambiguous or needs human judgment, post a concise diagnosis explaining the conflict/failure and wait for human instructions in this #merge-queue thread."
          : "Inspect the landing repository and explain clearly in 2-4 sentences what conflicted or failed, and ask the human how to reconcile (or offer to send it back to the implementer). Do NOT modify files or call `resume_and_land` until a human instructs you in this thread.",
      ].join("\n");

      // Fire and forget so synchronous enqueueing/locks aren't blocked by Queue Bot turn
      void this.sessionManager.runQueueTurn(qSess.id, diagnosticPrompt);
    }
  }

  tryRouteIncidentMessage(
    conversation: ConversationRow,
    message: MessageRow,
    author: UserRow,
  ): boolean {
    if (conversation.kind !== "merge_queue" || author.kind !== "human") return false;
    const activeQueue = this.db.listQueuedLands();
    const paused =
      (message.thread_id
        ? activeQueue.find(
            (l) => l.status === "paused" && l.queue_thread_id === message.thread_id,
          )
        : undefined) ?? activeQueue.find((l) => l.status === "paused");

    if (!paused || !paused.queue_session_id) return false;
    const qSess = this.db.getSession(paused.queue_session_id);
    if (!qSess || !qSess.clone_path || !existsSync(qSess.clone_path)) return false;

    const bot = this.db.getUser(qSess.bot_id);
    if (!bot) return false;

    const prompt = [
      `[${author.name} in #merge-queue]`,
      message.body,
      "",
      "Apply the human's reconciliation guidance in this landing clone if requested. Once conflicts are staged/resolved (`git rebase --continue` completed with clean working tree), call `resume_and_land(summary)` to re-run verification checks and land, or call `eject_to_implementer(reason)` if the branch should be sent back to the implementer.",
    ].join("\n");
    void this.sessionManager.runQueueTurn(qSess.id, prompt);
    return true;
  }

  private async handleBotResumeAndLand(
    queueSession: SessionRow,
    summary?: string,
  ): Promise<{ landed_sha: string; checks: CheckRunItem[] }> {
    return await this.withQueueLock(async () => {
      const land = this.db
        .listQueuedLands()
        .find((l) => l.queue_session_id === queueSession.id || l.status === "paused");
      if (!land) throw new Error("No paused merge queue item found for this session");

      const landingDir = queueSession.clone_path;
      if (!landingDir || !existsSync(landingDir)) {
        throw new Error("Landing workspace is no longer present");
      }
      const settings = this.db.getHostSettings();
      const repo = settings.repo;
      if (!repo?.bare_path) throw new Error("Repository is not configured");
      const workerSession = this.db.getSession(land.session_id);
      const bot = this.db.getUser(queueSession.bot_id);
      if (!workerSession || !bot) throw new Error("Worker session or bot not found");

      // Check for unresolved conflicts or active rebase
      if (existsSync(join(landingDir, ".git", "rebase-merge")) || existsSync(join(landingDir, ".git", "rebase-apply"))) {
        throw new Error("Git rebase is still in progress; finish `git rebase --continue` first.");
      }

      const verifying = this.db.updateLand(land.id, { status: "verifying" })!;
      this.emitLandUpdate(verifying);
      this.broadcastSnapshot();

      const checkRes = await runRepoChecks({
        workdir: landingDir,
        verifyCommand: settings.verify_command,
        sandboxEnabled: Boolean(bot.sandbox_enabled),
        sandboxNetwork: Boolean(bot.sandbox_network),
        disableSandbox: this.disableSandbox,
      });
      const checks = checkRes.checks;
      if (!checkRes.ok) {
        const pausedAgain = this.db.updateLand(land.id, {
          status: "paused",
          pause_reason: "checks_failed",
          error: checkRes.combined_output,
          verify_output: checkRes.combined_output,
          checks_json: JSON.stringify(checks),
        })!;
        this.emitLandUpdate(pausedAgain);
        this.broadcastSnapshot();
        throw new Error(`Checks failed (${checkRes.summary}):\n${checkRes.combined_output}`);
      }

      const taskTitle = deriveTaskTitle(workerSession.task, workerSession.title);
      const landed = await this.finishSuccessfulLand({
        land: verifying,
        session: workerSession,
        bot,
        landingDir,
        defaultBranch: repo.default_branch,
        barePath: repo.bare_path,
        baseSha: verifying.base_sha ?? "",
        checks,
        verifyOutput: checkRes.combined_output,
        touchesKawan: Boolean(verifying.touches_kawan),
        taskTitle,
        note: summary?.trim() || "reconciled by Queue Bot",
        callerQueueSessionId: queueSession.id,
      });

      const mqConv = this.ensureConversation();
      const noteMsg = this.db.appendMessage({
        conversationId: mqConv.id,
        authorId: bot.id,
        threadId: landed.queue_thread_id,
        body: summary?.trim()
          ? `Reconciled and landed "${taskTitle}": ${summary.trim()}`
          : `Reconciled and landed "${taskTitle}" on \`${repo.default_branch}\`.`,
      });
      this.wsServer.broadcastToConversation(mqConv, {
        type: "message.new",
        message: noteMsg,
        author: { id: bot.id, kind: "bot", name: bot.name },
      });

      setImmediate(() => {
        void this.kickLoop();
      });

      return { landed_sha: landed.landed_sha ?? "", checks };
    });
  }

  private async handleBotEjectToImplementer(
    queueSession: SessionRow,
    reason: string,
  ): Promise<{ land_id: string; status: string }> {
    const land = this.db
      .listQueuedLands()
      .find((l) => l.queue_session_id === queueSession.id || l.status === "paused");
    if (!land) throw new Error("No paused merge queue item found");
    await this.ejectLand(land.id, reason, queueSession.id);
    return { land_id: land.id, status: "proposed" };
  }

  async retryLand(landId?: string): Promise<MergeQueueSnapshot> {
    return await this.withQueueLock(async () => {
      const target =
        (landId ? this.db.getLand(landId) : this.db.listQueuedLands()[0]) ?? null;
      if (!target) throw new Error("No queued or paused merge item to retry");
      if (target.queue_session_id) {
        await this.sessionManager.stopSession(target.queue_session_id);
      }
      rmSync(join(this.dataDir, "workspaces", `landing-${target.id}`), {
        recursive: true,
        force: true,
      });
      const requeued = this.db.updateLand(target.id, {
        status: "queued",
        pause_reason: null,
        error: null,
      })!;
      this.emitLandUpdate(requeued);
      this.setPausedFlag(false);
      this.broadcastSnapshot();
      setImmediate(() => {
        void this.kickLoop();
      });
      return this.getSnapshot();
    });
  }

  async ejectLand(
    landId: string,
    reason = "Sent back to implementer",
    callerQueueSessionId?: string,
  ): Promise<MergeQueueSnapshot> {
    return await this.withQueueLock(async () => {
      const land = this.db.getLand(landId);
      if (!land) throw new Error(`Land not found: ${landId}`);
      if (land.queue_session_id) {
        if (land.queue_session_id === callerQueueSessionId) {
          this.sessionManager.markStopAfterTurn(land.queue_session_id);
        } else {
          await this.sessionManager.stopSession(land.queue_session_id);
        }
      }
      rmSync(join(this.dataDir, "workspaces", `landing-${land.id}`), {
        recursive: true,
        force: true,
      });
      const updated = this.db.updateLand(land.id, {
        status: "proposed",
        queue_position: null,
        pause_reason: null,
        error: reason,
      })!;
      this.emitLandUpdate(updated);

      const worker = this.db.getSession(land.session_id);
      if (worker && worker.status !== "landed") {
        const idle = this.db.updateSession(worker.id, { status: "idle" })!;
        this.wsServer.broadcast({
          type: "session.update",
          session: this.sessionManager.serializePublicSession(idle),
        });
        const bot = this.db.getUser(worker.bot_id);
        const originConv = this.db.getConversation(land.conversation_id);
        if (bot && originConv) {
          const taskTitle = deriveTaskTitle(worker.task, worker.title);
          const msg = this.db.appendMessage({
            conversationId: originConv.id,
            authorId: bot.id,
            threadId: land.thread_id,
            body: `Sent "${taskTitle}" back to implementer from merge queue: ${reason}`,
          });
          this.wsServer.broadcastToConversation(originConv, {
            type: "message.new",
            message: msg,
            author: { id: bot.id, kind: "bot", name: bot.name },
          });
        }
      }

      const mqConv = this.ensureConversation();
      const botId = this.effectiveQueueBotId();
      const bot = botId ? this.db.getUser(botId) : null;
      if (bot && land.queue_thread_id) {
        const msg = this.db.appendMessage({
          conversationId: mqConv.id,
          authorId: bot.id,
          threadId: land.queue_thread_id,
          body: `Returned item to implementer and resumed queue: ${reason}`,
        });
        this.wsServer.broadcastToConversation(mqConv, {
          type: "message.new",
          message: msg,
          author: { id: bot.id, kind: "bot", name: bot.name },
        });
      }

      this.setPausedFlag(false);
      this.resolveWaiters(updated);
      this.broadcastSnapshot();
      setImmediate(() => {
        void this.kickLoop();
      });
      return this.getSnapshot();
    });
  }

  async removeFromQueue(landId: string): Promise<MergeQueueSnapshot> {
    return await this.withQueueLock(async () => {
      const land = this.db.getLand(landId);
      if (!land) throw new Error(`Land not found: ${landId}`);
      if (land.status === "landed") {
        throw new Error("Land has already landed");
      }
      if (land.queue_session_id) {
        await this.sessionManager.stopSession(land.queue_session_id);
      }
      rmSync(join(this.dataDir, "workspaces", `landing-${land.id}`), {
        recursive: true,
        force: true,
      });

      const wasPaused = land.status === "paused";
      const restored = this.db.updateLand(land.id, {
        status: "proposed",
        queue_position: null,
        pause_reason: null,
        error: null,
      })!;
      this.emitLandUpdate(restored);

      const worker = this.db.getSession(land.session_id);
      if (worker && worker.status !== "landed") {
        const idle = this.db.updateSession(worker.id, { status: "idle" })!;
        this.wsServer.broadcast({
          type: "session.update",
          session: this.sessionManager.serializePublicSession(idle),
        });
      }

      if (wasPaused) {
        this.setPausedFlag(false);
      }
      this.resolveWaiters(restored);
      this.broadcastSnapshot();
      setImmediate(() => {
        void this.kickLoop();
      });
      return this.getSnapshot();
    });
  }
}

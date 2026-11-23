import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { KawanDb } from "./db.js";
import { finalizeLandingPush, prepareLandingClone, runRepoChecks } from "./git.js";
import type { SessionManager } from "./sessions.js";
import { deriveTaskTitle } from "./sessions.js";
import type {
  CheckRunItem,
  ConversationRow,
  LandRow,
  LandingMode,
  MergeConflictPolicy,
  MessageRow,
  SerializedLand,
  SessionRow,
  UserRow,
} from "./types.js";
import { serializeLand } from "./types.js";
import type { KawanWsServer } from "./ws.js";

export interface MergeQueueSnapshot {
  conversation_id: string;
  settings: {
    bot_id: string | null;
    default_landing_mode: LandingMode;
    conflict_policy: MergeConflictPolicy;
    paused: boolean;
  };
  head: SerializedLand | null;
  queued: SerializedLand[];
  paused_land: SerializedLand | null;
  recent_landed: SerializedLand[];
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

    return {
      conversation_id: conv.id,
      settings: {
        bot_id: botId,
        default_landing_mode: settings.merge_queue?.default_landing_mode ?? "manual",
        conflict_policy: settings.merge_queue?.conflict_policy ?? "pause_on_issue",
        paused: Boolean(settings.merge_queue?.paused || pausedLand),
      },
      head,
      queued: activeQueue.map(serializeLand),
      paused_land: pausedLand,
      recent_landed: recentLanded,
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
      this.wsServer.broadcast({ type: "land.update", land: serializeLand(updated) });
    }
    this.setPausedFlag(false);
    this.broadcastSnapshot();
    void this.kickLoop();
    return this.getSnapshot();
  }

  async enqueueLand(params: {
    landId?: string;
    sessionId?: string;
    approvedBy: string;
    trigger?: "manual_approve" | "auto_land";
    waitForSettlement?: boolean;
  }): Promise<{ land: SerializedLand; session: Omit<SessionRow, "token"> }> {
    let land: LandRow | null = null;
    if (params.landId) {
      land = this.db.getLand(params.landId);
    } else if (params.sessionId) {
      const list = this.db.listLands({ sessionId: params.sessionId });
      land =
        [...list]
          .reverse()
          .find((l) => l.status === "requested" || l.status === "failed" || l.status === "removed") ??
        null;
    }
    if (!land) throw new Error("Land request not found");
    if (
      land.status === "landed" ||
      land.status === "queued" ||
      land.status === "rebasing" ||
      land.status === "verifying" ||
      land.status === "paused"
    ) {
      throw new Error(`Land ${land.id} is already ${land.status}`);
    }

    const session = this.db.getSession(land.session_id);
    if (!session || !session.clone_path || !session.branch) {
      throw new Error("Worker session or clone missing for land");
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

    // Stop live worker process cleanly so no concurrent edits happen after queueing
    await this.sessionManager.stopProcessOnly(session.id);

    const queuePos = this.db.nextQueuePosition();
    const queuedLand = this.db.updateLand(land.id, {
      status: "queued",
      approved_by: params.approvedBy,
      trigger: params.trigger ?? "manual_approve",
      queue_position: queuePos,
      pause_reason: null,
      error: null,
    })!;
    this.wsServer.broadcast({ type: "land.update", land: serializeLand(queuedLand) });
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

    const settledPromise = new Promise<LandRow>((resolve) => {
      const existing = this.settlementWaiters.get(land.id) ?? [];
      existing.push(resolve);
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
    if (!land || land.status === "landed" || land.status === "removed" || land.status === "failed") {
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
    this.wsServer.broadcast({ type: "land.update", land: serializeLand(rebasing) });
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
        touchesKawan: false,
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
    this.wsServer.broadcast({ type: "land.update", land: serializeLand(verifying) });
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
    this.wsServer.broadcast({ type: "land.update", land: serializeLand(landed) });
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
        artifactId: incidentArtId,
      });
      incidentMsgId = msg.id;
      if (incidentArtId) {
        this.db.linkArtifactMessage(incidentArtId, msg.id);
      }
      this.wsServer.broadcastToConversation(mqConv, {
        type: "message.new",
        message: msg,
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

    this.wsServer.broadcast({ type: "land.update", land: serializeLand(pausedLand) });
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
      this.wsServer.broadcast({ type: "land.update", land: serializeLand(pausedLand) });
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
      this.wsServer.broadcast({ type: "land.update", land: serializeLand(verifying) });
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
        this.wsServer.broadcast({ type: "land.update", land: serializeLand(pausedAgain) });
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
    return { land_id: land.id, status: "failed" };
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
      this.wsServer.broadcast({ type: "land.update", land: serializeLand(requeued) });
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
        status: "failed",
        queue_position: null,
        pause_reason: null,
        error: reason,
      })!;
      this.wsServer.broadcast({ type: "land.update", land: serializeLand(updated) });

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
        status: "requested",
        queue_position: null,
        pause_reason: null,
        error: null,
      })!;
      this.wsServer.broadcast({ type: "land.update", land: serializeLand(restored) });

      const worker = this.db.getSession(land.session_id);
      if (worker && worker.status !== "landed") {
        const reviewed = this.db.updateSession(worker.id, { status: "review_requested" })!;
        this.wsServer.broadcast({
          type: "session.update",
          session: this.sessionManager.serializePublicSession(reviewed),
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

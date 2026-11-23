import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KawanDb } from "./db.js";
import {
  commitsAhead,
  createSessionClone,
  ensureAllowedSigners,
  getBranchHead,
  getSessionDiff,
  isWorkingTreeClean,
  landBranch,
  removeClone,
  runGit,
} from "./git.js";
import { composeSpawnSpec, materializeSessionAgentDir } from "./spawn.js";
import { filterSoulForWorker } from "./soul.js";
import type {
  ArtifactRow,
  ConversationRow,
  LandRow,
  MessageRow,
  SessionDiffSummary,
  SessionRow,
  UserRow,
} from "./types.js";
import { serializeLand } from "./types.js";
import type { KawanWsServer } from "./ws.js";

export interface QueueToolHandlers {
  resumeAndLand(session: SessionRow, summary?: string): Promise<unknown>;
  ejectToImplementer(session: SessionRow, reason: string): Promise<unknown>;
}

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const EXTENSION_ENTRY_PATH = resolve(
  fileURLToPath(new URL("./extension/index.ts", import.meta.url)),
);

export function deriveTaskTitle(
  task: string | null | undefined,
  explicitTitle?: string | null,
): string {
  const cleanExplicit = explicitTitle?.replace(/\s+/g, " ").trim();
  if (cleanExplicit) return cleanExplicit.slice(0, 64);
  const firstLine =
    (task ?? "")
      .split(/\r?\n/)[0]
      ?.replace(/\s+/g, " ")
      .trim() ?? "";
  if (!firstLine) return "Worker task";
  if (firstLine.length <= 48) return firstLine;
  return `${firstLine.slice(0, 45).trimEnd()}...`;
}

export interface PiTurnResult {
  assistantText: string;
  errorMessage: string | null;
  aborted: boolean;
}

export class PiRpcProcess {
  readonly cwd: string;
  readonly env: Record<string, string>;
  private readonly command: string;
  private readonly args: string[];
  private child: ChildProcess | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrChunks: string[] = [];
  private reqCounter = 0;
  private pending = new Map<
    string,
    { resolve: (data: any) => void; reject: (err: Error) => void }
  >();
  private eventListeners = new Set<(ev: any) => void>();
  private exitError: Error | null = null;
  private closed = false;

  constructor(spec: { command: string; args: string[]; cwd: string; env: Record<string, string> }) {
    this.command = spec.command;
    this.args = spec.args;
    this.cwd = spec.cwd;
    this.env = spec.env;
  }

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrChunks.push(chunk.toString("utf8"));
      if (this.stderrChunks.length > 100) {
        this.stderrChunks.shift();
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
      while (true) {
        const nl = this.stdoutBuffer.indexOf(0x0a);
        if (nl === -1) break;
        const line = this.stdoutBuffer
          .subarray(0, nl)
          .toString("utf8")
          .replace(/\r$/, "");
        this.stdoutBuffer = this.stdoutBuffer.subarray(nl + 1);
        if (line.trim().length > 0) {
          this.handleLine(line);
        }
      }
    });

    child.once("exit", (code, signal) => {
      const err = new Error(
        `pi exited (code=${code}, signal=${signal}): ${this.getStderr().slice(-600)}`,
      );
      this.exitError = err;
      this.child = null;
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
      this.emit({ type: "_process_exit", error: err.message });
    });

    child.once("error", (err) => {
      this.exitError = err;
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
      this.emit({ type: "_process_exit", error: err.message });
    });

    // Quick startup check
    await new Promise((r) => setTimeout(r, 80));
    if (this.exitError) {
      throw this.exitError;
    }
  }

  get isAlive(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.closed);
  }

  getStderr(): string {
    return this.stderrChunks.join("");
  }

  onEvent(listener: (ev: any) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private emit(ev: any): void {
    for (const listener of this.eventListeners) {
      try {
        listener(ev);
      } catch {
        // ignore listener error
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed.type === "response" && typeof parsed.id === "string") {
      const entry = this.pending.get(parsed.id);
      if (entry) {
        this.pending.delete(parsed.id);
        if (parsed.success) {
          entry.resolve(parsed.data);
        } else {
          entry.reject(new Error(parsed.error || `${parsed.command} failed`));
        }
      }
      return;
    }
    this.emit(parsed);
  }

  sendCommand(type: string, payload: Record<string, unknown> = {}): Promise<any> {
    if (!this.child || !this.child.stdin || this.exitError) {
      return Promise.reject(this.exitError ?? new Error("pi process is not running"));
    }
    const id = `rpc-${++this.reqCounter}`;
    const line = `${JSON.stringify({ id, type, ...payload })}\n`;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.child!.stdin!.write(line, "utf8", (err) => {
        if (err) {
          this.pending.delete(id);
          rejectPromise(err);
        }
      });
    });
  }

  async getState(): Promise<{
    sessionFile?: string;
    sessionId: string;
    isStreaming: boolean;
  }> {
    return await this.sendCommand("get_state");
  }

  async getEntries(since?: string): Promise<{ entries: any[]; leafId: string | null }> {
    return await this.sendCommand("get_entries", since ? { since } : {});
  }

  async steer(message: string): Promise<void> {
    await this.sendCommand("steer", { message });
  }

  async runPrompt(message: string, timeoutMs = 180_000): Promise<PiTurnResult> {
    let lastAssistantText = "";
    let errorMessage: string | null = null;
    let settled = false;

    const settledPromise = new Promise<{ aborted: boolean }>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        unsub();
        rejectPromise(new Error(`pi turn timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsub = this.onEvent((ev) => {
        if (ev.type === "message_end" && ev.message?.role === "assistant") {
          const msg = ev.message;
          if (msg.stopReason === "error" || msg.errorMessage) {
            errorMessage = msg.errorMessage || "LLM provider error";
          } else {
            errorMessage = null;
          }
          if (Array.isArray(msg.content)) {
            const texts = msg.content
              .filter((c: any) => c.type === "text" && typeof c.text === "string")
              .map((c: any) => c.text);
            if (texts.length > 0) {
              lastAssistantText = texts.join("\n").trim();
            }
          }
        } else if (ev.type === "auto_retry_end") {
          if (ev.success === true) {
            errorMessage = null;
          } else if (ev.success === false) {
            errorMessage = ev.finalError || errorMessage || "Auto-retry failed";
          }
        } else if (ev.type === "extension_error") {
          errorMessage = `Extension error (${ev.event}): ${ev.error}`;
        } else if (ev.type === "agent_settled") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsub();
          resolvePromise({ aborted: Boolean(ev.aborted) });
        } else if (ev.type === "_process_exit") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsub();
          rejectPromise(new Error(ev.error || "pi exited during turn"));
        }
      });

      this.sendCommand("prompt", { message, streamingBehavior: "followUp" })
        .then((data) => {
          if (data?.disposition === "handled" && !settled) {
            settled = true;
            clearTimeout(timer);
            unsub();
            resolvePromise({ aborted: false });
          }
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsub();
          rejectPromise(err instanceof Error ? err : new Error(String(err)));
        });
    });

    const { aborted } = await settledPromise;
    return { assistantText: lastAssistantText, errorMessage, aborted };
  }

  async stop(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;

    await new Promise<void>((resolvePromise) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolvePromise();
      };
      child.once("exit", finish);
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      const termTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
      }, 800);
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        finish();
      }, 2000);
    });
    this.child = null;
  }
}

export interface SoulHandlers {
  getContext(session: SessionRow): { contextFiles: Array<{ path: string; content: string }> };
  soulReplace(
    session: SessionRow,
    params: { anchor: string; text: string },
  ): unknown;
  soulWrite(session: SessionRow, params: { document: string }): unknown;
}

export function serializeSession(session: SessionRow): Omit<SessionRow, "token"> {
  const { token: _token, ...pub } = session;
  return pub;
}

export class SessionManager {
  readonly dataDir: string;
  readonly socketPath: string;
  private readonly db: KawanDb;
  private readonly wsServer: KawanWsServer;
  private readonly disableSandbox: boolean;
  private readonly soulHandlers?: SoulHandlers;
  private queueHandlers?: QueueToolHandlers;
  private socketServer: NetServer | null = null;
  private processes = new Map<string, PiRpcProcess>();
  private orchQueues = new Map<string, Promise<void>>();
  private queueTurnChains = new Map<string, Promise<void>>();
  private pendingDismissNotes = new Map<string, string[]>();
  private closed = false;
  private stopAfterTurn = new Set<string>();
  private activeContexts = new Map<
    string,
    {
      conversationId: string;
      threadId: string | null;
      triggerMessageId?: string | null;
      spawnedThreadId?: string | null;
      spawnedSessionId?: string | null;
      reportedInTurn: boolean;
      sourceWorkerId?: string | null;
      spawnIntent?: { explicitWorkStart: "yes" | "no"; workRequest: "yes" | "no" };
    }
  >();
  private workerRuns = new Map<string, Promise<void>>();

  constructor(opts: {
    dataDir: string;
    db: KawanDb;
    wsServer: KawanWsServer;
    disableSandbox?: boolean;
    soulHandlers?: SoulHandlers;
  }) {
    this.dataDir = opts.dataDir;
    this.db = opts.db;
    this.wsServer = opts.wsServer;
    this.disableSandbox = Boolean(opts.disableSandbox);
    this.soulHandlers = opts.soulHandlers;
    this.socketPath = join(opts.dataDir, "host.sock");
  }

  async start(): Promise<void> {
    rmSync(this.socketPath, { force: true });
    this.socketServer = createServer((conn) => this.handleUnixConnection(conn));
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.socketServer!.once("error", rejectPromise);
      this.socketServer!.listen(this.socketPath, () => resolvePromise());
    });
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    const procs = [...this.processes.values()];
    this.processes.clear();
    await Promise.all(procs.map((p) => p.stop()));
    await Promise.allSettled([
      ...this.orchQueues.values(),
      ...this.queueTurnChains.values(),
      ...this.workerRuns.values(),
    ]);
    if (this.socketServer) {
      await new Promise<void>((resolvePromise) => {
        this.socketServer!.close(() => resolvePromise());
      });
      this.socketServer = null;
    }
    rmSync(this.socketPath, { force: true });
  }

  setQueueHandlers(handlers: QueueToolHandlers): void {
    this.queueHandlers = handlers;
  }

  markStopAfterTurn(sessionId: string): void {
    this.stopAfterTurn.add(sessionId);
    const ctx = this.activeContexts.get(sessionId);
    if (ctx) {
      ctx.reportedInTurn = true;
    }
  }

  serializePublicSession(session: SessionRow): Omit<SessionRow, "token"> {
    return serializeSession(session);
  }

  createTextArtifact(input: {
    content: string;
    filename: string;
    mimeType?: string;
    sessionId?: string | null;
    conversationId?: string | null;
    messageId?: string | null;
  }): ArtifactRow {
    const bytes = Buffer.from(input.content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactPath = join(this.dataDir, "artifacts", sha256);
    if (!existsSync(artifactPath)) {
      writeFileSync(artifactPath, bytes, { mode: 0o644 });
    }
    return this.db.createArtifact({
      sha256,
      mimeType: input.mimeType ?? (input.filename.endsWith(".md") ? "text/markdown" : "text/plain"),
      byteSize: bytes.byteLength,
      filename: input.filename,
      sessionId: input.sessionId ?? null,
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
    });
  }

  async stopProcessOnly(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId);
    if (proc) {
      this.processes.delete(sessionId);
      await proc.stop();
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId);
    if (proc) {
      this.processes.delete(sessionId);
      await proc.stop();
    }
    const existing = this.db.getSession(sessionId);
    if (
      existing &&
      (existing.status === "running" ||
        existing.status === "idle" ||
        existing.status === "pending_approval")
    ) {
      const updated = this.db.updateSession(sessionId, { status: "stopped" })!;
      this.wsServer.broadcast({ type: "session.update", session: serializeSession(updated) });
    }
  }

  async stopBotSessions(botId: string): Promise<void> {
    const sessions = this.db.listSessions({ botId });
    await Promise.all(sessions.map((s) => this.stopSession(s.id)));
  }

  private handleUnixConnection(conn: Socket): void {
    let buf = Buffer.alloc(0);
    conn.on("error", () => {
      // Ignore abrupt ECONNRESET/EPIPE when a child pi process exits mid-request
    });
    conn.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
        buf = buf.subarray(nl + 1);
        if (line.trim().length > 0) {
          void this.handleUnixLine(conn, line);
        }
      }
    });
  }

  private async handleUnixLine(conn: Socket, line: string): Promise<void> {
    const safeWrite = (payload: unknown) => {
      if (!conn.destroyed && conn.writable) {
        conn.write(`${JSON.stringify(payload)}\n`);
      }
    };
    let req: { id?: string; token?: string; tool?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      safeWrite({ ok: false, error: "Invalid JSON" });
      return;
    }

    const id = req.id;
    try {
      if (!req.token) throw new Error("Missing session token");
      const session = this.db.getSessionByToken(req.token);
      if (!session) throw new Error("Invalid session token");
      const result = await this.executeHostTool(session, req.tool ?? "", req.params ?? {});
      safeWrite({ id, ok: true, result });
    } catch (err) {
      safeWrite({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async executeHostTool(
    session: SessionRow,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (tool) {
      case "get_context": {
        if (this.soulHandlers) {
          return this.soulHandlers.getContext(session);
        }
        const contextFiles: Array<{ path: string; content: string }> = [];
        if (session.kind === "orchestrator") {
          const soul = this.db.getLatestSoul(session.bot_id);
          if (soul) {
            contextFiles.push({ path: "kawan://soul.md", content: soul.content });
          }
          const workers = this.db.listSessions({ botId: session.bot_id, kind: "worker" });
          if (workers.length > 0) {
            const lines = workers.map(
              (w) => `- ${w.id} [${w.status}] (${w.branch ?? "no-branch"}): ${w.task ?? ""} — ${w.last_report ?? "no report yet"}`,
            );
            contextFiles.push({
              path: "kawan://sessions.md",
              content: `## Active & recent worker sessions\n\n${lines.join("\n")}\n`,
            });
          }
        } else if (session.soul_snapshot) {
          contextFiles.push({ path: "kawan://soul.md", content: session.soul_snapshot });
        }
        return { contextFiles };
      }

      case "spawn_session": {
        if (session.kind !== "orchestrator") {
          throw new Error("Only the orchestrator session can spawn worker sessions");
        }
        const task = typeof params.task === "string" ? params.task.trim() : "";
        if (!task) throw new Error("task is required");
        const title = typeof params.title === "string" ? params.title.trim() : undefined;
        const inThread = typeof params.in_thread === "boolean" ? params.in_thread : undefined;
        return await this.spawnWorker(session, task, title, inThread);
      }

      case "message_session": {
        if (session.kind !== "orchestrator") {
          throw new Error("Only the orchestrator session can call message_session");
        }
        const targetId = typeof params.session_id === "string" ? params.session_id.trim() : "";
        const message = typeof params.message === "string" ? params.message.trim() : "";
        if (!targetId) throw new Error("session_id is required");
        if (!message) throw new Error("message is required");
        return await this.messageWorkerSession(session, targetId, message);
      }

      case "session_status": {
        if (session.kind !== "orchestrator") {
          throw new Error("Only the orchestrator session can call session_status");
        }
        const workers = this.db.listSessions({ botId: session.bot_id, kind: "worker" });
        return {
          sessions: workers.map((w) => ({
            id: w.id,
            title: w.title,
            status: w.status,
            branch: w.branch,
            task: w.task,
            last_report: w.last_report,
            conversation_id: w.conversation_id,
            thread_id: w.thread_id,
            updated_at: w.updated_at,
          })),
        };
      }

      case "report": {
        const text = typeof params.text === "string" ? params.text : "";
        if (!text.trim()) throw new Error("report text cannot be empty");
        const artifactParam =
          params.artifact && typeof params.artifact === "object"
            ? (params.artifact as { filename?: string; mime_type?: string; base64?: string })
            : undefined;
        const inThread = typeof params.in_thread === "boolean" ? params.in_thread : undefined;
        return await this.handleReport(session, text, artifactParam, inThread);
      }

      case "land_request": {
        if (session.kind !== "worker") {
          throw new Error("Only worker sessions can call land_request");
        }
        const summary = typeof params.summary === "string" ? params.summary : "";
        return await this.handleLandRequest(session, summary);
      }

      case "resume_and_land": {
        if (session.kind !== "queue") {
          throw new Error("Only merge queue sessions can call resume_and_land");
        }
        if (!this.queueHandlers) {
          throw new Error("Merge queue handlers are not registered");
        }
        const summary = typeof params.summary === "string" ? params.summary : undefined;
        return await this.queueHandlers.resumeAndLand(session, summary);
      }

      case "eject_to_implementer": {
        if (session.kind !== "queue") {
          throw new Error("Only merge queue sessions can call eject_to_implementer");
        }
        if (!this.queueHandlers) {
          throw new Error("Merge queue handlers are not registered");
        }
        const reason = typeof params.reason === "string" ? params.reason.trim() : "";
        if (!reason) throw new Error("reason is required");
        return await this.queueHandlers.ejectToImplementer(session, reason);
      }

      case "soul_replace": {
        if (session.kind !== "orchestrator") {
          throw new Error("Only orchestrator sessions can modify the soul");
        }
        if (!this.soulHandlers) {
          throw new Error("Soul editing is not enabled");
        }
        return this.soulHandlers.soulReplace(session, {
          anchor: String(params.anchor ?? ""),
          text: String(params.text ?? ""),
        });
      }

      case "soul_write": {
        if (session.kind !== "orchestrator") {
          throw new Error("Only orchestrator sessions can modify the soul");
        }
        if (!this.soulHandlers) {
          throw new Error("Soul editing is not enabled");
        }
        return this.soulHandlers.soulWrite(session, {
          document: String(params.document ?? ""),
        });
      }

      default:
        throw new Error(`Unknown host tool: ${tool}`);
    }
  }

  private buildOrchestratorSystemPrompt(bot: UserRow): string {
    return [
      `You are ${bot.name}, an AI engineering orchestrator inside Kawan.`,
      bot.persona ? `Persona: ${bot.persona}` : "Persona: Helpful, concise software engineer.",
      `Only you speak in chat for ${bot.name}. Worker sessions run quietly in isolated clones and never post directly to humans.`,
      "Host tools:",
      "- spawn_session(title?, task, in_thread?): delegate repository inspection, coding, tests, and git commits to a worker session. Pass a short 3-6 word `title` for the Tasks UI. Each worker already has its own clone, dedicated branch, bash/file tools, report(), and land_request(). Do NOT tell workers to create a new branch or push to origin.",
      "- message_session(session_id, message): answer a worker's question or steer an existing worker directly.",
      "- session_status(): inspect your child worker sessions.",
      "- report(text, artifact?, in_thread?): post a message or attach evidence/reports into the active conversation.",
      "- soul_replace(anchor, text) and soul_write(document): maintain durable project knowledge in your soul (injected each turn at kawan://soul.md).",
      "Thread & formatting guidance:",
      "- Casual top-level channel Q&A defaults to a regular top-level channel reply. Use a thread (`in_thread: true` on `report()`, or the default on `spawn_session` in channels) when delegating a task or having a multi-turn discussion that belongs grouped under the triggering message, or pass `in_thread: false` to reply top-level in the channel. When a human writes inside a thread, stay in that thread.",
      "- Prefer concise plain prose in chat (usually 1-3 sentences) rather than long markdown walls or nested bullet lists.",
      "- When a task produces detailed multi-file breakdowns, verification logs, or lengthy technical notes, prefer attaching those details as an expandable `report.md` artifact via `report(short_summary, { filename: 'report.md', mime_type: 'text/markdown', content: full_details })` while keeping the chat message brief. For simple tasks or quick answers, a brief reply alone is fine.",
      "Workflow rules:",
      "- Do not pretend to inspect or edit files directly — delegate repository work via spawn_session().",
      "- When delegating, reply with at most one brief acknowledgement (e.g. 'On it.') or output NO_REPLY — live task status is already shown in the Tasks UI.",
      "- When a worker calls you with a question you can answer from conversation context or kawan://soul.md, reply to it directly with message_session(session_id, answer) and output NO_REPLY. Only ask the human in chat if you do not know.",
      "- When a worker finishes or requests landing, post ONE concise human-friendly summary of what changed and how it was verified (and note it is ready for review/approval if awaiting land). Never mention internal session IDs, git branch names, commit hashes, or git plumbing ('working tree clean', 'not pushed') unless explicitly asked.",
      "- Always check kawan://soul.md before claiming you do not know a project fact — durable project facts learned in earlier sessions live there.",
      "- If you receive an internal [worker-report] notice and nothing needs to be posted to humans, output exactly: NO_REPLY",
    ].join("\n");
  }

  private buildWorkerSystemPrompt(bot: UserRow, _session: SessionRow): string {
    return [
      `You are a worker agent for ${bot.name} inside an isolated git clone.`,
      `Task: ${_session.task}`,
      "Instructions:",
      "1. Inspect the repository, make the requested changes or collect the requested information, and verify your work.",
      "2. You report ONLY to your orchestrator — your assistant text, report(), and land_request() calls are never shown directly to humans.",
      "3. If blocked on an ambiguity or need human input, call `report(question)` and stop your turn so your orchestrator can answer or ask humans.",
      "4. For code changes meant to land on the default branch, commit on your current branch (`git add` && `git commit`), verify cleanly (`git status`), and call `land_request(summary)` with a concise summary of what changed and how it was verified. Do NOT create/switch branches and do NOT run `git push`.",
      "5. Call `report(text, artifact?)` if you are answering a read-only question, sharing findings, or attaching an evidence artifact.",
    ].join("\n");
  }

  private async ensureOrchestratorProcess(bot: UserRow, session: SessionRow): Promise<PiRpcProcess> {
    const existing = this.processes.get(session.id);
    if (existing && existing.isAlive) return existing;

    const settings = this.db.getHostSettings();
    const sessionBase = join(this.dataDir, "sessions", session.id);
    const agentDir = join(sessionBase, "agent");
    const sessionDir = join(sessionBase, "pi-sessions");
    const cwd = join(sessionBase, "work");
    mkdirSync(cwd, { recursive: true });
    materializeSessionAgentDir(agentDir, settings);

    const spec = composeSpawnSpec({
      role: "orchestrator",
      bot,
      settings,
      agentDir,
      sessionDir,
      cwd,
      socketPath: this.socketPath,
      extensionPath: EXTENSION_ENTRY_PATH,
      sessionToken: session.token,
      systemPrompt: this.buildOrchestratorSystemPrompt(bot),
      piSessionFile: session.pi_session_file,
      disableSandbox: this.disableSandbox,
    });

    const proc = new PiRpcProcess(spec);
    await proc.start();
    if (this.closed) {
      await proc.stop();
      throw new Error("Host is shutting down");
    }
    this.processes.set(session.id, proc);

    try {
      const state = await proc.getState();
      this.db.updateSession(session.id, {
        agent_dir: agentDir,
        pi_session_file: state.sessionFile ?? session.pi_session_file,
      });
    } catch {
      // non-fatal
    }

    return proc;
  }

  private buildQueueSystemPrompt(bot: UserRow, taskTitle: string): string {
    return [
      `You are ${bot.name}, acting as the Merge Queue Bot for "${taskTitle}".`,
      "You run inside the isolated landing clone after an attempted rebase onto the default branch.",
      "Your messages go ONLY to #merge-queue (inside the active incident thread).",
      "Tools:",
      "- bash/read/edit/write to inspect conflicts or fix broken checks in this landing clone.",
      "- report(text, artifact?): post updates into the #merge-queue incident thread.",
      "- resume_and_land(summary?): re-run repository checks in this clone and fast-forward onto the default branch.",
      "- eject_to_implementer(reason): return the change to the implementer worker and unpause the queue for later items.",
      "Rules:",
      "- Under policy 'pause_on_issue', diagnose the conflict or failing check concisely (2-4 sentences) and wait for human guidance before altering code or calling resume_and_land.",
      "- Under policy 'auto_resolve_trivial', only auto-resolve small, unambiguous merge conflicts; otherwise pause and ask humans in this thread.",
    ].join("\n");
  }

  async dispatch(params: {
    bot: UserRow;
    destination: string;
    conversation: ConversationRow;
    threadId: string | null;
    messages: MessageRow[];
    spawnIntent?: { explicitWorkStart: "yes" | "no"; workRequest: "yes" | "no" };
  }): Promise<void> {
    if (params.destination === "orchestrator") {
      this.enqueueOrchestratorPrompt(
        params.bot,
        params.conversation,
        params.threadId,
        params.messages,
        false,
        undefined,
        undefined,
        params.spawnIntent,
      );
      return;
    }

    if (params.destination.startsWith("session:")) {
      const workerId = params.destination.slice("session:".length);
      await this.dispatchToWorker(params.bot, workerId, params.conversation, params.messages);
    }
  }

  private publishOrchestratorMessage(params: {
    bot: UserRow;
    conversation: ConversationRow;
    threadId: string | null;
    body: string;
    artifactRow?: ArtifactRow | null;
    sourceWorkerId?: string | null;
  }): MessageRow {
    let artifactRow = params.artifactRow ?? null;
    if (!artifactRow && params.sourceWorkerId) {
      const unlinked = this.db
        .listArtifacts({ sessionId: params.sourceWorkerId })
        .filter((a) => !a.message_id);
      artifactRow = unlinked[unlinked.length - 1] ?? null;
    }

    const posted = this.db.appendMessage({
      conversationId: params.conversation.id,
      authorId: params.bot.id,
      threadId: params.threadId,
      body: params.body,
      artifactId: artifactRow?.id ?? null,
    });

    if (artifactRow) {
      this.db.linkArtifactMessage(artifactRow.id, posted.id);
      const refreshedArt = this.db.getArtifact(artifactRow.id);
      if (refreshedArt) {
        this.wsServer.broadcastToConversation(params.conversation, {
          type: "artifact.new",
          artifact: refreshedArt,
        });
      }
    }

    if (params.sourceWorkerId) {
      const pendingLand = this.db
        .listLands({ sessionId: params.sourceWorkerId })
        .filter((l) => (l.status === "requested" || l.status === "failed") && !l.message_id)
        .pop();
      if (pendingLand) {
        const updatedLand = this.db.updateLand(pendingLand.id, { message_id: posted.id })!;
        this.wsServer.broadcast({ type: "land.update", land: serializeLand(updatedLand) });
      }
    }

    this.wsServer.broadcastToConversation(params.conversation, {
      type: "message.new",
      message: posted,
      author: { id: params.bot.id, kind: "bot", name: params.bot.name },
    });
    return posted;
  }

  private enqueueOrchestratorPrompt(
    bot: UserRow,
    conversation: ConversationRow,
    threadId: string | null,
    messages: MessageRow[],
    _isInternalNotice = false,
    promptOverride?: string,
    sourceWorkerId?: string | null,
    spawnIntent?: { explicitWorkStart: "yes" | "no"; workRequest: "yes" | "no" },
  ): void {
    const prev = this.orchQueues.get(bot.id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        if (this.closed) return;
        const freshBot = this.db.getUser(bot.id);
        if (!freshBot) return;
        const orch = this.db.getActiveOrchestratorSession(bot.id);
        if (!orch) return;

        const runningOrch = this.db.updateSession(orch.id, { status: "running" })!;
        this.wsServer.broadcast({ type: "session.update", session: serializeSession(runningOrch) });

        const proc = await this.ensureOrchestratorProcess(freshBot, runningOrch);

        const triggerMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
        const targetThreadId = threadId ?? null;

        this.activeContexts.set(orch.id, {
          conversationId: conversation.id,
          threadId: targetThreadId,
          triggerMessageId,
          spawnedThreadId: null,
          spawnedSessionId: null,
          reportedInTurn: false,
          sourceWorkerId: sourceWorkerId ?? null,
          spawnIntent,
        });

        let promptText =
          promptOverride ??
          this.formatHumanBatchPrompt(conversation, targetThreadId, messages);
        const dismissNotes = this.pendingDismissNotes.get(freshBot.id);
        if (dismissNotes && dismissNotes.length > 0) {
          this.pendingDismissNotes.delete(freshBot.id);
          promptText = `${dismissNotes.join("\n")}\n\n${promptText}`;
        }

        try {
          const turn = await proc.runPrompt(promptText);
          try {
            const st = await proc.getState();
            const entries = await proc.getEntries();
            this.db.updateSession(orch.id, {
              pi_session_file: st.sessionFile ?? runningOrch.pi_session_file,
              last_entry_id: entries.leafId,
            });
          } catch {
            // ignore state sync errors
          }

          const ctx = this.activeContexts.get(orch.id);
          this.activeContexts.delete(orch.id);

          if (turn.errorMessage) {
            this.wsServer.broadcastToConversation(conversation, {
              type: "error",
              conversation_id: conversation.id,
              bot_id: freshBot.id,
              message: `Orchestrator error: ${turn.errorMessage}`,
            });
          } else if (
            !ctx?.reportedInTurn &&
            turn.assistantText &&
            turn.assistantText.trim() !== "NO_REPLY"
          ) {
            this.publishOrchestratorMessage({
              bot: freshBot,
              conversation,
              threadId: ctx?.spawnedThreadId ?? targetThreadId,
              body: turn.assistantText.trim(),
              sourceWorkerId: ctx?.sourceWorkerId,
            });
          }
        } catch (err) {
          this.activeContexts.delete(orch.id);
          if (!this.closed) {
            this.wsServer.broadcastToConversation(conversation, {
              type: "error",
              conversation_id: conversation.id,
              bot_id: freshBot.id,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        } finally {
          if (!this.closed) {
            const latestOrch = this.db.getSession(orch.id);
            if (latestOrch && latestOrch.status === "running") {
              const idle = this.db.updateSession(orch.id, { status: "idle" })!;
              this.wsServer.broadcast({ type: "session.update", session: serializeSession(idle) });
            }
          }
        }
      });

    this.orchQueues.set(bot.id, next);
  }

  private formatHumanBatchPrompt(
    conversation: ConversationRow,
    threadId: string | null,
    messages: MessageRow[],
  ): string {
    const label =
      conversation.kind === "dm" ? "DM" : `#${conversation.name ?? "channel"}`;
    const scope =
      conversation.kind === "dm"
        ? ""
        : threadId
          ? `, in thread ${threadId}`
          : ", top-level";
    const lines = messages.map((m) => {
      const author = this.db.getUser(m.author_id);
      return `${author?.name ?? "human"}: ${m.body}`;
    });
    return [
      `[Conversation: ${label} (${conversation.id})${scope}]`,
      ...lines,
    ].join("\n");
  }

  private async spawnWorker(
    orchSession: SessionRow,
    task: string,
    explicitTitle?: string,
    inThread?: boolean,
  ): Promise<{
    session_id: string;
    title: string;
    status: string;
    thread_id: string | null;
    message?: string;
  }> {
    const bot = this.db.getUser(orchSession.bot_id);
    if (!bot || bot.kind !== "bot") {
      throw new Error("Bot no longer exists");
    }
    const settings = this.db.getHostSettings();
    if (!settings.repo?.bare_path || !existsSync(settings.repo.bare_path)) {
      throw new Error("Cannot spawn session: no repository is attached");
    }
    const ctx = this.activeContexts.get(orchSession.id);
    if (!ctx) {
      throw new Error("No active conversation context for orchestrator");
    }
    if (!bot.signing_key_path) {
      throw new Error("Bot is missing SSH signing key");
    }

    const explicitStart = ctx.spawnIntent?.explicitWorkStart ?? "yes";
    const workReq = ctx.spawnIntent?.workRequest ?? "yes";
    if (explicitStart === "no" && workReq === "no") {
      throw new Error(
        "Blocked: the user has not asked to start repository work (work_request=no). Reply conversationally without calling spawn_session or proposing a task.",
      );
    }

    const conv = this.db.getConversation(ctx.conversationId);
    const workerThreadId =
      inThread === false
        ? null
        : ctx.threadId
          ? ctx.threadId
          : inThread === true
            ? (ctx.triggerMessageId ?? null)
            : conv?.kind === "channel"
              ? (ctx.triggerMessageId ?? null)
              : null;
    if (workerThreadId) {
      ctx.spawnedThreadId = workerThreadId;
    }

    const sessionId = randomUUID();
    const title = deriveTaskTitle(task, explicitTitle);
    const latestSoul = this.db.getLatestSoul(bot.id);
    const soulSnapshot = latestSoul ? filterSoulForWorker(latestSoul.content) : null;

    if (explicitStart === "no") {
      const pending = this.db.createSession({
        id: sessionId,
        botId: bot.id,
        parentSessionId: orchSession.id,
        kind: "worker",
        conversationId: ctx.conversationId,
        threadId: workerThreadId,
        title,
        task,
        status: "pending_approval",
        soulSnapshot,
      });
      ctx.spawnedSessionId = pending.id;
      this.wsServer.broadcast({ type: "session.update", session: serializeSession(pending) });
      return {
        session_id: pending.id,
        title,
        status: "pending_approval",
        thread_id: workerThreadId,
        message: "Proposal card created awaiting user confirmation ([Start] / [Dismiss]).",
      };
    }

    const workerSession = await this.launchWorkerCloneAndProcess({
      sessionId,
      bot,
      parentSessionId: orchSession.id,
      conversationId: ctx.conversationId,
      threadId: workerThreadId,
      title,
      task,
      soulSnapshot,
    });
    ctx.spawnedSessionId = workerSession.id;

    return { session_id: workerSession.id, title, status: "running", thread_id: workerThreadId };
  }

  private async launchWorkerCloneAndProcess(params: {
    sessionId: string;
    bot: UserRow;
    parentSessionId: string | null;
    conversationId: string | null;
    threadId: string | null;
    title: string;
    task: string;
    soulSnapshot: string | null;
    existingRow?: SessionRow;
  }): Promise<SessionRow> {
    const settings = this.db.getHostSettings();
    if (!settings.repo?.bare_path || !existsSync(settings.repo.bare_path)) {
      throw new Error("Cannot spawn session: no repository is attached");
    }
    if (!params.bot.signing_key_path) {
      throw new Error("Bot is missing SSH signing key");
    }

    const branch = `kawan/${params.sessionId}`;
    const clonePath = join(this.dataDir, "workspaces", params.sessionId);
    const sessionBase = join(this.dataDir, "sessions", params.sessionId);
    const agentDir = join(sessionBase, "agent");
    const sessionDir = join(sessionBase, "pi-sessions");

    await createSessionClone({
      barePath: settings.repo.bare_path,
      clonePath,
      defaultBranch: settings.repo.default_branch,
      branchName: branch,
      botName: params.bot.name,
      botEmail: params.bot.email ?? `${params.bot.name.toLowerCase()}@kawan.local`,
      signingKeyPath: params.bot.signing_key_path,
    });
    ensureAllowedSigners(this.dataDir, this.db.listUsers("bot"));
    materializeSessionAgentDir(agentDir, settings);

    const workerSession = params.existingRow
      ? this.db.updateSession(params.sessionId, {
          status: "running",
          branch,
          clone_path: clonePath,
          agent_dir: agentDir,
          last_report: null,
        })!
      : this.db.createSession({
          id: params.sessionId,
          botId: params.bot.id,
          parentSessionId: params.parentSessionId,
          kind: "worker",
          conversationId: params.conversationId,
          threadId: params.threadId,
          title: params.title,
          task: params.task,
          status: "running",
          branch,
          clonePath,
          agentDir,
          soulSnapshot: params.soulSnapshot,
        });
    this.wsServer.broadcast({ type: "session.update", session: serializeSession(workerSession) });

    const spec = composeSpawnSpec({
      role: "worker",
      bot: params.bot,
      settings,
      agentDir,
      sessionDir,
      cwd: clonePath,
      socketPath: this.socketPath,
      extensionPath: EXTENSION_ENTRY_PATH,
      sessionToken: workerSession.token,
      systemPrompt: this.buildWorkerSystemPrompt(params.bot, workerSession),
      disableSandbox: this.disableSandbox,
    });

    const proc = new PiRpcProcess(spec);
    await proc.start();
    const latestBeforeRun = this.db.getSession(workerSession.id);
    if (this.closed || !latestBeforeRun || latestBeforeRun.status === "stopped") {
      await proc.stop();
      return latestBeforeRun ?? workerSession;
    }
    this.processes.set(workerSession.id, proc);
    try {
      const st = await proc.getState();
      const updated = this.db.updateSession(workerSession.id, {
        pi_session_file: st.sessionFile ?? null,
      })!;
      this.wsServer.broadcast({ type: "session.update", session: serializeSession(updated) });
    } catch {
      // non-fatal
    }

    const runPromise = this.runWorkerTurn(proc, workerSession, params.bot, params.task);
    this.workerRuns.set(workerSession.id, runPromise);
    return this.db.getSession(workerSession.id)!;
  }

  async confirmPendingSession(sessionId: string): Promise<{ session: Omit<SessionRow, "token"> }> {
    const existing = this.db.getSession(sessionId);
    if (!existing) throw new Error(`Session not found: ${sessionId}`);
    if (existing.status !== "pending_approval") {
      throw new Error(`Session ${sessionId} is ${existing.status}, not awaiting confirmation`);
    }
    const bot = this.db.getUser(existing.bot_id);
    if (!bot || bot.kind !== "bot") throw new Error("Bot no longer exists");
    const task = existing.task ?? "";
    const title = deriveTaskTitle(task, existing.title);
    const updated = await this.launchWorkerCloneAndProcess({
      sessionId: existing.id,
      bot,
      parentSessionId: existing.parent_session_id,
      conversationId: existing.conversation_id,
      threadId: existing.thread_id,
      title,
      task,
      soulSnapshot: existing.soul_snapshot,
      existingRow: existing,
    });
    return { session: serializeSession(updated) };
  }

  async dismissPendingSession(sessionId: string): Promise<{ session: Omit<SessionRow, "token"> }> {
    const existing = this.db.getSession(sessionId);
    if (!existing) throw new Error(`Session not found: ${sessionId}`);
    if (existing.status !== "pending_approval") {
      throw new Error(`Session ${sessionId} is not pending approval`);
    }
    const updated = this.db.updateSession(sessionId, {
      status: "stopped",
      last_report: "Dismissed by user",
    })!;
    this.wsServer.broadcast({ type: "session.update", session: serializeSession(updated) });
    const title = deriveTaskTitle(updated.task, updated.title);
    const list = this.pendingDismissNotes.get(updated.bot_id) ?? [];
    list.push(
      `[Host note: The user dismissed your proposed task "${title}". Do not re-propose or spawn it unless the user explicitly asks to start it.]`,
    );
    this.pendingDismissNotes.set(updated.bot_id, list);
    return { session: serializeSession(updated) };
  }

  async stopWorkerSession(sessionId: string): Promise<{ session: Omit<SessionRow, "token"> }> {
    const existing = this.db.getSession(sessionId);
    if (!existing) throw new Error(`Session not found: ${sessionId}`);
    if (existing.status === "pending_approval") {
      return await this.dismissPendingSession(sessionId);
    }
    const proc = this.processes.get(sessionId);
    if (proc) {
      this.processes.delete(sessionId);
      await proc.stop();
    }
    const updated = this.db.updateSession(sessionId, {
      status: "stopped",
      last_report: existing.status === "landed" ? existing.last_report : "Stopped by user",
    })!;
    this.wsServer.broadcast({ type: "session.update", session: serializeSession(updated) });
    return { session: serializeSession(updated) };
  }

  async ensureQueueSession(params: {
    bot: UserRow;
    land: LandRow;
    mqConv: ConversationRow;
    incidentThreadId: string | null;
    landingDir: string;
    taskTitle: string;
  }): Promise<SessionRow> {
    if (params.land.queue_session_id) {
      const existing = this.db.getSession(params.land.queue_session_id);
      if (existing && existing.status !== "archived") {
        return existing;
      }
    }
    const session = this.db.createSession({
      botId: params.bot.id,
      kind: "queue",
      conversationId: params.mqConv.id,
      threadId: params.incidentThreadId,
      title: `Reconcile: ${params.taskTitle}`,
      task: `Reconcile merge queue failure for ${params.taskTitle}`,
      status: "idle",
      clonePath: params.landingDir,
    });
    this.wsServer.broadcast({ type: "session.update", session: serializeSession(session) });
    return session;
  }

  async runQueueTurn(sessionId: string, promptText: string): Promise<void> {
    const prev = this.queueTurnChains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        if (this.closed) return;
        const session = this.db.getSession(sessionId);
        if (!session || session.kind !== "queue" || !session.clone_path || !existsSync(session.clone_path)) {
          return;
        }
        const bot = this.db.getUser(session.bot_id);
        const mqConv = session.conversation_id
          ? this.db.getConversation(session.conversation_id)
          : this.db.getMergeQueueConversation();
        if (!bot || !mqConv) return;

        const running = this.db.updateSession(session.id, { status: "running" })!;
        this.wsServer.broadcast({ type: "session.update", session: serializeSession(running) });

        try {
          let proc = this.processes.get(session.id);
          if (!proc || !proc.isAlive) {
            const settings = this.db.getHostSettings();
            const sessionBase = join(this.dataDir, "sessions", session.id);
            const agentDir = join(sessionBase, "agent");
            const sessionDir = join(sessionBase, "pi-sessions");
            materializeSessionAgentDir(agentDir, settings);

            const spec = composeSpawnSpec({
              role: "queue",
              bot,
              settings,
              agentDir,
              sessionDir,
              cwd: session.clone_path,
              socketPath: this.socketPath,
              extensionPath: EXTENSION_ENTRY_PATH,
              sessionToken: session.token,
              systemPrompt: this.buildQueueSystemPrompt(bot, session.title ?? "Merge queue item"),
              piSessionFile: session.pi_session_file,
              disableSandbox: this.disableSandbox,
            });
            proc = new PiRpcProcess(spec);
            await proc.start();
            if (this.closed) {
              await proc.stop();
              return;
            }
            this.processes.set(session.id, proc);
          }

          this.activeContexts.set(session.id, {
            conversationId: mqConv.id,
            threadId: session.thread_id,
            reportedInTurn: false,
          });

          const turn = await proc.runPrompt(promptText);
          if (this.closed) {
            this.activeContexts.delete(session.id);
            return;
          }
          try {
            const st = await proc.getState();
            const entries = await proc.getEntries();
            this.db.updateSession(session.id, {
              pi_session_file: st.sessionFile ?? session.pi_session_file,
              last_entry_id: entries.leafId,
            });
          } catch {
            // ignore
          }

          const ctx = this.activeContexts.get(session.id);
          this.activeContexts.delete(session.id);

          const afterSession = this.db.getSession(session.id);
          if (!afterSession || afterSession.status === "stopped") {
            return;
          }
          if (turn.errorMessage) {
            this.wsServer.broadcastToConversation(mqConv, {
              type: "error",
              conversation_id: mqConv.id,
              session_id: session.id,
              message: `Queue bot error: ${turn.errorMessage}`,
            });
          } else if (
            !ctx?.reportedInTurn &&
            turn.assistantText &&
            turn.assistantText.trim() !== "NO_REPLY"
          ) {
            this.publishOrchestratorMessage({
              bot,
              conversation: mqConv,
              threadId: session.thread_id,
              body: turn.assistantText.trim(),
            });
          }
        } catch (err) {
          this.activeContexts.delete(session.id);
          if (!this.closed) {
            this.wsServer.broadcastToConversation(mqConv, {
              type: "error",
              conversation_id: mqConv.id,
              session_id: session.id,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        } finally {
          if (!this.closed) {
            if (this.stopAfterTurn.delete(session.id)) {
              await this.stopSession(session.id);
            } else {
              const latest = this.db.getSession(session.id);
              if (latest && latest.status === "running") {
                const idle = this.db.updateSession(session.id, { status: "idle" })!;
                this.wsServer.broadcast({ type: "session.update", session: serializeSession(idle) });
              }
            }
          }
        }
      });
    this.queueTurnChains.set(sessionId, next);
    await next;
  }

  private async runWorkerTurn(
    proc: PiRpcProcess,
    session: SessionRow,
    bot: UserRow,
    promptText: string,
  ): Promise<void> {
    const conv = session.conversation_id
      ? this.db.getConversation(session.conversation_id)
      : null;

    this.activeContexts.set(session.id, {
      conversationId: session.conversation_id ?? "",
      threadId: session.thread_id,
      reportedInTurn: false,
    });

    try {
      const turn = await proc.runPrompt(promptText);
      try {
        const st = await proc.getState();
        const entries = await proc.getEntries();
        this.db.updateSession(session.id, {
          pi_session_file: st.sessionFile ?? session.pi_session_file,
          last_entry_id: entries.leafId,
        });
      } catch {
        // ignore
      }

      const ctx = this.activeContexts.get(session.id);
      this.activeContexts.delete(session.id);

      const latest = this.db.getSession(session.id) ?? session;
      if (this.closed || latest.status === "stopped") {
        return;
      }
      if (turn.errorMessage) {
        const failed = this.db.updateSession(session.id, { status: "failed" })!;
        this.wsServer.broadcast({ type: "session.update", session: serializeSession(failed) });
        if (conv) {
          this.wsServer.broadcastToConversation(conv, {
            type: "error",
            conversation_id: conv.id,
            session_id: session.id,
            message: `Worker ${session.id.slice(0, 8)} failed: ${turn.errorMessage}`,
          });
        }
        return;
      }

      if (!ctx?.reportedInTurn && turn.assistantText) {
        const updatedReport = this.db.updateSession(session.id, {
          last_report: turn.assistantText.trim(),
        })!;
        this.wsServer.broadcast({ type: "session.update", session: serializeSession(updatedReport) });
      }

      const refreshed = this.db.getSession(session.id)!;
      if (refreshed.status === "stopped") {
        return;
      }
      if (refreshed.status === "running") {
        const idle = this.db.updateSession(session.id, { status: "idle" })!;
        this.wsServer.broadcast({ type: "session.update", session: serializeSession(idle) });
      }

      const reportSummary = refreshed.last_report ?? turn.assistantText;
      if (conv && (reportSummary || refreshed.status === "review_requested")) {
        const taskTitle = deriveTaskTitle(refreshed.task, refreshed.title);
        const workerArtifacts = this.db
          .listArtifacts({ sessionId: session.id })
          .map((a) => a.filename ?? a.mime_type);
        const pendingLand = this.db
          .listLands({ sessionId: session.id })
          .find((l) => l.status === "requested" || l.status === "failed");
        const statusNote = pendingLand
          ? `status=${refreshed.status}, land_approval=pending`
          : `status=${refreshed.status}`;
        const artifactNote =
          workerArtifacts.length > 0 ? `\nArtifacts attached: ${workerArtifacts.join(", ")}` : "";

        this.enqueueOrchestratorPrompt(
          bot,
          conv,
          refreshed.thread_id,
          [],
          true,
          [
            `[worker-report for "${taskTitle}" (session_id=${session.id}, ${statusNote})]${artifactNote}`,
            reportSummary || "(Worker submitted committed changes for review without extra text.)",
            "",
            "Remember: ONLY you represent the bot in chat (this report was not shown to humans).",
            "- If the worker asked a question you can answer from conversation context or kawan://soul.md, call `message_session(session_id, answer)` and output NO_REPLY.",
            "- If you need human input to unblock the worker, ask concisely in chat.",
            "- If the worker completed the task or requested landing (`land_approval=pending`), share ONE concise human-friendly summary (prefer 1-3 sentences of plain prose; mention it is ready for review/approval if pending). If there are detailed multi-file changes or verification logs worth inspecting, you can attach them via `report(summary, { filename: 'report.md', mime_type: 'text/markdown', content: details })` so they open in an expandable report card. Omit internal session IDs, branch names, commit hashes, and git plumbing.",
            "- If a durable project fact, agreement, or decision was uncovered, save it via `soul_replace` or `soul_write`.",
          ].join("\n"),
          session.id,
        );
      }
    } catch (err) {
      this.activeContexts.delete(session.id);
      if (this.closed) {
        return;
      }
      const latest = this.db.getSession(session.id);
      if (latest?.status === "stopped") {
        return;
      }
      const failed = this.db.updateSession(session.id, { status: "failed" });
      if (failed) {
        this.wsServer.broadcast({ type: "session.update", session: serializeSession(failed) });
      }
      if (conv) {
        this.wsServer.broadcastToConversation(conv, {
          type: "error",
          conversation_id: conv.id,
          session_id: session.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async messageWorkerSession(
    orchSession: SessionRow,
    workerId: string,
    message: string,
  ): Promise<{ session_id: string; status: string }> {
    const bot = this.db.getUser(orchSession.bot_id);
    if (!bot || bot.kind !== "bot") {
      throw new Error("Bot no longer exists");
    }
    const worker = this.db.getSession(workerId);
    if (!worker || worker.kind !== "worker" || worker.bot_id !== bot.id) {
      throw new Error(`Worker session not found: ${workerId}`);
    }
    await this.sendPromptToWorker(bot, worker, `[orchestrator]: ${message}`);
    return { session_id: worker.id, status: "running" };
  }

  private async dispatchToWorker(
    bot: UserRow,
    workerId: string,
    conversation: ConversationRow,
    messages: MessageRow[],
  ): Promise<void> {
    const worker = this.db.getSession(workerId);
    if (!worker || worker.kind !== "worker") {
      throw new Error(`Worker session not found: ${workerId}`);
    }
    const promptText = this.formatHumanBatchPrompt(conversation, worker.thread_id, messages);
    await this.sendPromptToWorker(bot, worker, promptText);
  }

  private async sendPromptToWorker(
    bot: UserRow,
    worker: SessionRow,
    promptText: string,
  ): Promise<void> {
    if (!worker.clone_path || !existsSync(worker.clone_path)) {
      throw new Error(`Worker clone is no longer available for session ${worker.id}`);
    }

    let proc = this.processes.get(worker.id);
    if (!proc || !proc.isAlive) {
      const settings = this.db.getHostSettings();
      const sessionBase = join(this.dataDir, "sessions", worker.id);
      const agentDir = join(sessionBase, "agent");
      const sessionDir = join(sessionBase, "pi-sessions");
      materializeSessionAgentDir(agentDir, settings);

      const spec = composeSpawnSpec({
        role: "worker",
        bot,
        settings,
        agentDir,
        sessionDir,
        cwd: worker.clone_path,
        socketPath: this.socketPath,
        extensionPath: EXTENSION_ENTRY_PATH,
        sessionToken: worker.token,
        systemPrompt: this.buildWorkerSystemPrompt(bot, worker),
        piSessionFile: worker.pi_session_file,
        disableSandbox: this.disableSandbox,
      });
      proc = new PiRpcProcess(spec);
      await proc.start();
      this.processes.set(worker.id, proc);
    }

    const state = await proc.getState();
    if (state.isStreaming) {
      await proc.steer(promptText);
    } else {
      const running = this.db.updateSession(worker.id, { status: "running" })!;
      this.wsServer.broadcast({ type: "session.update", session: serializeSession(running) });
      const runPromise = this.runWorkerTurn(proc, running, bot, promptText);
      this.workerRuns.set(worker.id, runPromise);
    }
  }

  private async handleReport(
    session: SessionRow,
    text: string,
    artifactInput?: { filename?: string; mime_type?: string; base64?: string },
    inThread?: boolean,
  ): Promise<{ message_id: string | null; artifact_id: string | null }> {
    const bot = this.db.getUser(session.bot_id);
    if (!bot) throw new Error("Bot not found");

    const ctx = this.activeContexts.get(session.id);
    const conversationId = ctx?.conversationId || session.conversation_id;
    const effectiveThreadId =
      session.kind === "worker" || session.kind === "queue"
        ? (ctx ? ctx.threadId : session.thread_id)
        : inThread === true
          ? (ctx?.threadId ?? ctx?.spawnedThreadId ?? ctx?.triggerMessageId ?? null)
          : inThread === false
            ? null
            : (ctx?.spawnedThreadId ?? ctx?.threadId ?? null);
    if (!conversationId) {
      throw new Error("No target conversation for report");
    }
    const conv = this.db.getConversation(conversationId);
    if (!conv) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    if (ctx) {
      ctx.reportedInTurn = true;
    }

    let artifactRow: ArtifactRow | null = null;
    if (artifactInput?.base64) {
      const bytes = Buffer.from(artifactInput.base64, "base64");
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
        throw new Error(`Artifact exceeds 10 MB limit (${bytes.byteLength} bytes)`);
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const artifactPath = join(this.dataDir, "artifacts", sha256);
      if (!existsSync(artifactPath)) {
        writeFileSync(artifactPath, bytes, { mode: 0o644 });
      }
      artifactRow = this.db.createArtifact({
        sha256,
        mimeType: artifactInput.mime_type || "text/plain",
        byteSize: bytes.byteLength,
        filename: artifactInput.filename ?? null,
        sessionId:
          session.kind === "orchestrator"
            ? (ctx?.sourceWorkerId ?? session.id)
            : session.id,
        conversationId: conv.id,
      });
      if (session.kind === "worker") {
        this.wsServer.broadcastToConversation(conv, {
          type: "artifact.new",
          artifact: artifactRow,
        });
      }
    }

    const updatedSession = this.db.updateSession(session.id, { last_report: text })!;
    this.wsServer.broadcast({ type: "session.update", session: serializeSession(updatedSession) });

    if (session.kind === "worker") {
      return {
        message_id: null,
        artifact_id: artifactRow?.id ?? null,
      };
    }

    const msg = this.publishOrchestratorMessage({
      bot,
      conversation: conv,
      threadId: effectiveThreadId,
      body: text,
      artifactRow,
      sourceWorkerId: ctx?.sourceWorkerId,
    });

    return {
      message_id: msg.id,
      artifact_id: artifactRow?.id ?? null,
    };
  }

  async handleLandRequest(session: SessionRow, summary: string): Promise<{
    land_id: string;
    status: string;
    branch: string | null;
  }> {
    if (!session.clone_path || !existsSync(session.clone_path)) {
      throw new Error("Worker clone directory is missing");
    }
    const settings = this.db.getHostSettings();
    if (!settings.repo) {
      throw new Error("Repository is not configured");
    }
    const { stdout: currentBranchOut } = await runGit([
      "-C",
      session.clone_path,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const currentBranch = currentBranchOut.trim();
    if (session.branch && currentBranch !== session.branch) {
      throw new Error(
        `Currently on branch '${currentBranch}'; commits must be on your assigned session branch '${session.branch}'.`,
      );
    }
    const clean = await isWorkingTreeClean(session.clone_path);
    if (!clean) {
      throw new Error(
        "Working tree has uncommitted changes; run git add && git commit before calling land_request",
      );
    }
    const ahead = await commitsAhead(session.clone_path, settings.repo.default_branch);
    if (ahead < 1) {
      throw new Error(
        `Branch ${session.branch} has 0 commits ahead of ${settings.repo.default_branch}; commit changes before calling land_request`,
      );
    }

    const existing = this.db
      .listLands({ sessionId: session.id })
      .find(
        (l) =>
          l.status === "requested" ||
          l.status === "queued" ||
          l.status === "rebasing" ||
          l.status === "verifying" ||
          l.status === "paused",
      );
    if (existing) {
      return { land_id: existing.id, status: existing.status, branch: session.branch };
    }

    const land = this.db.createLand({
      sessionId: session.id,
      conversationId: session.conversation_id!,
      threadId: session.thread_id,
    });
    const trimmedSummary = summary.trim();
    const updated = this.db.updateSession(session.id, {
      status: "review_requested",
      ...(trimmedSummary ? { last_report: trimmedSummary } : {}),
    })!;
    this.wsServer.broadcast({ type: "session.update", session: serializeSession(updated) });
    this.wsServer.broadcast({ type: "land.update", land: serializeLand(land) });

    const ctx = this.activeContexts.get(session.id);
    if (ctx) ctx.reportedInTurn = true;

    return { land_id: land.id, status: land.status, branch: updated.branch };
  }

  async approveLand(params: {
    landId?: string;
    sessionId?: string;
    approvedBy: string;
  }): Promise<{ land: LandRow; session: Omit<SessionRow, "token"> }> {
    let land: LandRow | null = null;
    if (params.landId) {
      land = this.db.getLand(params.landId);
    } else if (params.sessionId) {
      const list = this.db.listLands({ sessionId: params.sessionId });
      land = [...list].reverse().find((l) => l.status === "requested" || l.status === "failed") ?? null;
    }
    if (!land) throw new Error("Land request not found");
    if (land.status === "landed" || land.status === "verifying") {
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
    if (!settings.verify_command || !settings.verify_command.trim()) {
      throw new Error("verify_command is not configured in host settings");
    }

    // Stop live worker process cleanly before landing/cleaning clone
    const liveProc = this.processes.get(session.id);
    if (liveProc) {
      this.processes.delete(session.id);
      await liveProc.stop();
    }

    let verifying = this.db.updateLand(land.id, {
      status: "verifying",
      approved_by: params.approvedBy,
      error: null,
    })!;
    this.wsServer.broadcast({ type: "land.update", land: verifying });

    const conv = this.db.getConversation(land.conversation_id);
    const landingDir = join(this.dataDir, "workspaces", `landing-${land.id}`);
    const result = await landBranch({
      barePath: settings.repo.bare_path,
      clonePath: session.clone_path,
      branchName: session.branch,
      defaultBranch: settings.repo.default_branch,
      verifyCommand: settings.verify_command,
      botName: bot.name,
      botEmail: bot.email ?? `${bot.name.toLowerCase()}@kawan.local`,
      signingKeyPath: bot.signing_key_path,
      landingDir,
    });

    const taskTitle = deriveTaskTitle(session.task, session.title);

    if (result.ok) {
      removeClone(session.clone_path);
      const landed = this.db.updateLand(land.id, {
        status: "landed",
        base_sha: result.baseSha,
        landed_sha: result.landedSha ?? null,
        verify_output: result.verifyOutput,
        error: null,
      })!;
      const updatedSession = this.db.updateSession(session.id, { status: "landed" })!;
      this.wsServer.broadcast({ type: "land.update", land: landed });
      this.wsServer.broadcast({ type: "session.update", session: serializeSession(updatedSession) });
      if (conv) {
        const msg = this.db.appendMessage({
          conversationId: conv.id,
          authorId: bot.id,
          threadId: land.thread_id,
          body: `Landed "${taskTitle}" on \`${settings.repo.default_branch}\`.`,
        });
        this.wsServer.broadcastToConversation(conv, {
          type: "message.new",
          message: msg,
          author: { id: bot.id, kind: "bot", name: bot.name },
        });
      }
      return { land: landed, session: serializeSession(updatedSession) };
    }

    const failedLand = this.db.updateLand(land.id, {
      status: "failed",
      base_sha: result.baseSha,
      verify_output: result.verifyOutput,
      error: result.error ?? "Land failed",
    })!;
    const failedSession = this.db.updateSession(session.id, { status: "failed" })!;
    this.wsServer.broadcast({ type: "land.update", land: failedLand });
    this.wsServer.broadcast({ type: "session.update", session: serializeSession(failedSession) });
    if (conv) {
      const msg = this.db.appendMessage({
        conversationId: conv.id,
        authorId: bot.id,
        threadId: land.thread_id,
        body: `Land blocked for "${taskTitle}":\n${result.error ?? result.verifyOutput}`,
      });
      this.wsServer.broadcastToConversation(conv, {
        type: "message.new",
        message: msg,
        author: { id: bot.id, kind: "bot", name: bot.name },
      });
    }
    return { land: failedLand, session: serializeSession(failedSession) };
  }

  getArtifactPayload(artifactId: string): { artifact: ArtifactRow; base64: string; mime_type: string } {
    const artifact = this.db.getArtifact(artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    if (artifact.byte_size > MAX_ARTIFACT_BYTES) {
      throw new Error("Artifact exceeds 10 MB limit");
    }
    const diskPath = join(this.dataDir, "artifacts", artifact.sha256);
    if (!existsSync(diskPath)) {
      throw new Error(`Artifact bytes missing on disk: ${artifact.sha256}`);
    }
    const bytes = readFileSync(diskPath);
    return {
      artifact,
      base64: bytes.toString("base64"),
      mime_type: artifact.mime_type,
    };
  }

  async openSessionDetail(sessionId: string): Promise<{
    session: Omit<SessionRow, "token">;
    artifacts: ArtifactRow[];
    lands: ReturnType<KawanDb["listLands"]>;
    entries: any[];
  }> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    let entries: any[] = [];
    const liveProc = this.processes.get(sessionId);
    if (liveProc && liveProc.isAlive) {
      try {
        const res = await liveProc.getEntries();
        entries = res.entries;
      } catch {
        entries = [];
      }
    } else if (session.pi_session_file && existsSync(session.pi_session_file)) {
      const raw = readFileSync(session.pi_session_file, "utf8");
      entries = raw
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    }

    return {
      session: serializeSession(session),
      artifacts: this.db.listArtifacts({ sessionId }),
      lands: this.db.listLands({ sessionId }),
      entries,
    };
  }

  async getSessionDiff(sessionId: string): Promise<SessionDiffSummary> {
    const session = this.db.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const repo = this.db.getHostSettings().repo;
    const latestLand = this.db.listLands({ sessionId }).at(-1);
    return await getSessionDiff({
      barePath: repo?.bare_path,
      defaultBranch: repo?.default_branch,
      clonePath: session.clone_path,
      baseSha: latestLand?.base_sha,
      landedSha: latestLand?.landed_sha,
    });
  }
}

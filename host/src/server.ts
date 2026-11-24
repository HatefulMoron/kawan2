import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { ensureBootstrapToken } from "./auth.js";
import { KawanDb } from "./db.js";
import {
  DecisionFixtureStore,
  fetchWithRetry,
  formatFetchError,
  routeMessage,
  testDecisionModel,
  type DecisionMode,
} from "./decisions.js";
import { attachRepository, ensureHostSshKey, generateBotKeypair } from "./git.js";
import { IssueManager } from "./issues.js";
import { MergeQueueManager } from "./merge-queue.js";
import { serializeSession, SessionManager, type SoulHandlers } from "./sessions.js";
import { createSoulHandlers, INITIAL_SOUL_DOCUMENT } from "./soul.js";
import type {
  ConversationRow,
  DecisionRow,
  HostSettings,
  IssueStatus,
  LandingMode,
  MergeConflictPolicy,
  MessageRow,
  ModelDefinition,
  ProviderSettings,
  UserRow,
} from "./types.js";
import { computeSetupStatus, KawanWsServer, type CommandHandler } from "./ws.js";

export interface DispatchEvent {
  bot: UserRow;
  destination: string;
  conversation: ConversationRow;
  threadId: string | null;
  messages: MessageRow[];
  redirectedFrom?: string;
  spawnIntent?: { explicitWorkStart: "yes" | "no"; workRequest: "yes" | "no" };
}

export interface StartHostOptions {
  dataDir: string;
  host?: string;
  port?: number;
  hostNamespace?: string;
  recordProtocolPath?: string;
  decisionMode?: DecisionMode;
  decisionFixturePath?: string;
  disableSandbox?: boolean;
  holdTimeoutMs?: number;
  soulHandlers?: SoulHandlers;
  onDispatch?: (event: DispatchEvent) => Promise<void> | void;
  quiet?: boolean;
}

export interface KawanHost {
  dataDir: string;
  host: string;
  port: number;
  url: string;
  bootstrapToken: string | null;
  db: KawanDb;
  wsServer: KawanWsServer;
  sessionManager: SessionManager;
  httpServer: HttpServer;
  close(): Promise<void>;
}

export function buildPiModelsJson(settings: HostSettings): { providers: Record<string, unknown> } {
  const providers: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(settings.providers)) {
    providers[name] = {
      baseUrl: p.baseUrl,
      api: p.api,
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      ...(p.authHeader !== undefined ? { authHeader: p.authHeader } : {}),
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        ...(m.api ? { api: m.api } : {}),
        ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
        reasoning: Boolean(m.reasoning),
        input: m.input ?? ["text"],
        cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow ?? 128000,
        maxTokens: m.maxTokens ?? 16384,
        ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
        ...(m.compat ? { compat: m.compat } : {}),
      })),
    };
  }
  return { providers };
}

export function materializeHostModelsJson(dataDir: string, settings: HostSettings): string {
  const modelsPath = join(dataDir, "models.json");
  writeFileSync(modelsPath, `${JSON.stringify(buildPiModelsJson(settings), null, 2)}\n`, {
    mode: 0o600,
  });
  return modelsPath;
}

function maskSettings(settings: HostSettings, hostPubkey: string, db: KawanDb, isAdmin: boolean) {
  const providers: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(settings.providers)) {
    providers[name] = {
      baseUrl: p.baseUrl,
      api: p.api,
      authHeader: Boolean(p.authHeader),
      ...(isAdmin ? { apiKeyConfigured: Boolean(p.apiKey) } : {}),
      models: p.models,
    };
  }
  return {
    ...(isAdmin ? { host_ssh_pubkey: hostPubkey } : {}),
    repo: settings.repo
      ? {
          url: settings.repo.url,
          default_branch: settings.repo.default_branch,
          bare_path: settings.repo.bare_path,
          ...(isAdmin ? { https_token_configured: Boolean(settings.repo.https_token) } : {}),
        }
      : null,
    verify_command: settings.verify_command ?? null,
    merge_queue: settings.merge_queue ?? null,
    providers,
    roles: {
      default: settings.roles.default ?? null,
      decision: settings.roles.decision
        ? {
            provider: settings.roles.decision.provider,
            baseUrl: settings.roles.decision.baseUrl,
            model: settings.roles.decision.model,
            ...(isAdmin ? { apiKeyConfigured: Boolean(settings.roles.decision.apiKey) } : {}),
          }
        : null,
    },
    setup: computeSetupStatus(db),
  };
}

function serializeBot(db: KawanDb, bot: UserRow) {
  const orch = db.getActiveOrchestratorSession(bot.id);
  return {
    id: bot.id,
    kind: bot.kind,
    name: bot.name,
    email: bot.email,
    persona: bot.persona,
    model: bot.model,
    thinking_level: bot.thinking_level,
    sandbox_enabled: Boolean(bot.sandbox_enabled),
    sandbox_network: Boolean(bot.sandbox_network),
    signing_pubkey: bot.signing_pubkey,
    orchestrator_session_id: orch?.id ?? null,
    orchestrator_status: orch?.status ?? "not_started",
    created_at: bot.created_at,
  };
}

async function testLlmCompletion(
  provider: ProviderSettings,
  modelDef: ModelDefinition,
): Promise<{ ok: boolean; latency_ms: number; sample?: string; error?: string }> {
  const start = Date.now();
  const baseUrl = (modelDef.baseUrl ?? provider.baseUrl).replace(/\/+$/, "");
  const api = modelDef.api ?? provider.api;

  try {
    if (api === "anthropic-messages") {
      const url = baseUrl.endsWith("/messages") ? baseUrl : `${baseUrl}/messages`;
      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: {
            "x-api-key": provider.apiKey ?? "",
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelDef.id,
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply with ok." }],
          }),
        },
        { timeoutMs: 20_000, maxAttempts: 3, baseDelayMs: 400 },
      );
      if (!res.ok) {
        return { ok: false, latency_ms: Date.now() - start, error: `${res.status}: ${await res.text()}` };
      }
      const data = (await res.json()) as any;
      const text = data?.content?.[0]?.text ?? "ok";
      return { ok: true, latency_ms: Date.now() - start, sample: String(text).slice(0, 80) };
    }

    const url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model: modelDef.id,
      messages: [{ role: "user", content: "Reply with ok." }],
      max_tokens: 16,
    };
    if (modelDef.compat?.thinkingFormat === "deepseek") {
      body.thinking = { type: "disabled" };
    }
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      { timeoutMs: 20_000, maxAttempts: 3, baseDelayMs: 400 },
    );
    if (!res.ok) {
      return { ok: false, latency_ms: Date.now() - start, error: `${res.status}: ${await res.text()}` };
    }
    const data = (await res.json()) as any;
    const text = data?.choices?.[0]?.message?.content ?? "ok";
    return { ok: true, latency_ms: Date.now() - start, sample: String(text).slice(0, 80) };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      error: formatFetchError(err),
    };
  }
}

export async function startHost(opts: StartHostOptions): Promise<KawanHost> {
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 0;
  const decisionMode: DecisionMode = opts.decisionMode ?? "live";
  const fixtureStore = opts.decisionFixturePath
    ? new DecisionFixtureStore(opts.decisionFixturePath)
    : undefined;

  mkdirSync(opts.dataDir, { recursive: true });
  mkdirSync(join(opts.dataDir, "workspaces"), { recursive: true });
  mkdirSync(join(opts.dataDir, "artifacts"), { recursive: true });
  mkdirSync(join(opts.dataDir, "keys"), { recursive: true });
  mkdirSync(join(opts.dataDir, "sessions"), { recursive: true });

  const hostKey = await ensureHostSshKey(opts.dataDir);
  const db = new KawanDb(join(opts.dataDir, "kawan.db"));
  const bootstrapToken = ensureBootstrapToken(db);

  const httpServer = createServer((_req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("WebSocket required\n");
  });
  const wss = new WebSocketServer({ server: httpServer });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(requestedPort, host, () => resolve());
  });

  const addr = httpServer.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Unexpected server address");
  }
  const actualPort = addr.port;
  const hostAddress = `${host}:${actualPort}`;
  const url = `ws://${hostAddress}`;

  let wsServer!: KawanWsServer;
  let sessionManager!: SessionManager;
  let mergeQueue!: MergeQueueManager;
  let issueManager!: IssueManager;

  const dispatchEvent = async (ev: DispatchEvent): Promise<void> => {
    if (opts.onDispatch) {
      await opts.onDispatch(ev);
    } else {
      await sessionManager.dispatch(ev);
    }
  };

  const parsedEnvHold = Number(process.env.KAWAN_HOLD_TIMEOUT_MS ?? 10_000);
  const holdTimeoutMs =
    opts.holdTimeoutMs !== undefined
      ? Math.max(0, opts.holdTimeoutMs)
      : Number.isFinite(parsedEnvHold)
        ? Math.max(0, parsedEnvHold)
        : 10_000;
  const holdTimers = new Map<string, NodeJS.Timeout>();
  const holdKey = (conversationId: string, botId: string): string => `${conversationId}:${botId}`;

  const cancelHoldTimer = (conversationId: string, botId: string): void => {
    const key = holdKey(conversationId, botId);
    const existing = holdTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      holdTimers.delete(key);
    }
  };

  const flushHeldBatch = async (conversationId: string, botId: string): Promise<void> => {
    cancelHoldTimer(conversationId, botId);
    const stillHeld = db.listHeldDecisions(conversationId, botId);
    if (stillHeld.length === 0) return;

    const conv = db.getConversation(conversationId);
    const bot = db.getUser(botId);
    if (!conv || !bot) return;

    const destination = stillHeld[stillHeld.length - 1].destination;
    const batchId = stillHeld.length > 1 ? randomUUID() : null;
    const updated = db.markDecisionsDispatched(
      stillHeld.map((h) => h.id),
      batchId,
    );
    for (const decision of updated) {
      wsServer.broadcastToConversation(conv, { type: "decision.new", decision });
    }
    if (destination !== "none") {
      const lastDec = stillHeld[stillHeld.length - 1];
      const lastMsg = lastDec.message;
      await dispatchEvent({
        bot,
        destination,
        conversation: conv,
        threadId: lastMsg.thread_id,
        messages: stillHeld.map((h) => h.message),
        spawnIntent: {
          explicitWorkStart: lastDec.explicit_work_start === "yes" ? "yes" : "no",
          workRequest: lastDec.work_request === "yes" ? "yes" : "no",
        },
      });
    }
  };

  const scheduleHoldTimer = (conversationId: string, botId: string, delayMs: number): void => {
    cancelHoldTimer(conversationId, botId);
    const key = holdKey(conversationId, botId);
    const timer = setTimeout(() => {
      holdTimers.delete(key);
      void flushHeldBatch(conversationId, botId).catch((err) => {
        if (!opts.quiet) {
          console.error("[kawan-host] hold timer flush error:", err);
        }
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
    holdTimers.set(key, timer);
  };

  const extraHandlers: Record<string, CommandHandler> = {
    "settings.read": (_req, client) => {
      const settings = db.getHostSettings();
      return maskSettings(settings, hostKey.pubkey, db, client.user.role === "admin");
    },

    "settings.update": async (req, client) => {
      if (client.user.role !== "admin") {
        throw new Error("Only admins can update host settings");
      }
      const settings = db.getHostSettings();

      if (req.repo && typeof req.repo === "object") {
        const r = req.repo as { url?: string; default_branch?: string; https_token?: string };
        const repoUrl = typeof r.url === "string" ? r.url : settings.repo?.url ?? "";
        const defaultBranch =
          typeof r.default_branch === "string" ? r.default_branch : settings.repo?.default_branch ?? "main";
        const httpsToken =
          r.https_token !== undefined ? (r.https_token || undefined) : settings.repo?.https_token;
        try {
          const attached = await attachRepository(opts.dataDir, {
            url: repoUrl,
            defaultBranch,
            httpsToken,
          });
          settings.repo = {
            ...attached,
            ...(httpsToken ? { https_token: httpsToken } : {}),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          client.emitError(msg, { scope: "settings.repo" });
          throw new Error(msg);
        }
      }

      if (typeof req.verify_command === "string") {
        settings.verify_command = req.verify_command;
      }

      if (req.merge_queue && typeof req.merge_queue === "object") {
        const mq = req.merge_queue as {
          bot_id?: string | null;
          default_landing_mode?: LandingMode;
          conflict_policy?: MergeConflictPolicy;
        };
        const prevMq = settings.merge_queue ?? {};
        settings.merge_queue = {
          bot_id: mq.bot_id !== undefined ? mq.bot_id : prevMq.bot_id ?? null,
          default_landing_mode:
            mq.default_landing_mode ?? prevMq.default_landing_mode ?? "manual",
          conflict_policy: mq.conflict_policy ?? prevMq.conflict_policy ?? "pause_on_issue",
          paused: Boolean(prevMq.paused),
        };
      }

      if (req.providers && typeof req.providers === "object") {
        const incomingProviders = req.providers as Record<string, ProviderSettings>;
        for (const [name, p] of Object.entries(incomingProviders)) {
          const prev = settings.providers[name];
          const apiKey =
            p.apiKey === undefined ? prev?.apiKey : p.apiKey === "" ? undefined : p.apiKey;
          settings.providers[name] = {
            baseUrl: p.baseUrl,
            api: p.api,
            ...(apiKey ? { apiKey } : {}),
            ...(p.authHeader !== undefined ? { authHeader: p.authHeader } : {}),
            models: Array.isArray(p.models)
              ? p.models.map((m) => ({
                  ...m,
                  name: m.name || m.id,
                  cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: m.contextWindow ?? 128000,
                  maxTokens: m.maxTokens ?? 16384,
                }))
              : [],
          };
        }
      }

      if (req.roles && typeof req.roles === "object") {
        const roles = req.roles as HostSettings["roles"];
        if (roles.default) {
          settings.roles.default = roles.default;
        }
        if (roles.decision) {
          const prev = settings.roles.decision;
          const apiKey =
            roles.decision.apiKey === undefined
              ? prev?.apiKey
              : roles.decision.apiKey === ""
                ? undefined
                : roles.decision.apiKey;
          settings.roles.decision = {
            provider: roles.decision.provider ?? "subq",
            baseUrl: roles.decision.baseUrl,
            model: roles.decision.model,
            ...(apiKey ? { apiKey } : {}),
          };
        }
      }

      db.saveHostSettings(settings);
      materializeHostModelsJson(opts.dataDir, settings);
      if (req.merge_queue && mergeQueue) {
        mergeQueue.ensureConversation();
        mergeQueue.broadcastSnapshot();
      }
      return maskSettings(settings, hostKey.pubkey, db, true);
    },

    "models.test": async (_req, client) => {
      if (client.user.role !== "admin") {
        throw new Error("Only admins can test models");
      }
      const settings = db.getHostSettings();

      let defaultResult: { ok: boolean; latency_ms: number; sample?: string; error?: string };
      if (!settings.roles.default) {
        defaultResult = { ok: false, latency_ms: 0, error: "Default model role is not configured" };
      } else {
        const prov = settings.providers[settings.roles.default.provider];
        const modelDef = prov?.models.find((m) => m.id === settings.roles.default!.model);
        if (!prov || !modelDef) {
          defaultResult = {
            ok: false,
            latency_ms: 0,
            error: `Model ${settings.roles.default.provider}/${settings.roles.default.model} not found in providers`,
          };
        } else {
          defaultResult = await testLlmCompletion(prov, modelDef);
        }
      }

      let decisionResult: { ok: boolean; latency_ms: number; sample?: unknown; error?: string };
      if (!settings.roles.decision) {
        decisionResult = { ok: false, latency_ms: 0, error: "Decision model role is not configured" };
      } else {
        decisionResult = await testDecisionModel(settings.roles.decision);
      }

      return { default: defaultResult, decision: decisionResult };
    },

    "bot.list": () => {
      return {
        bots: db.listUsers("bot").map((b) => serializeBot(db, b)),
      };
    },

    "bot.create": async (req, client) => {
      if (client.user.role !== "admin") {
        throw new Error("Only admins can create bots");
      }
      const setup = computeSetupStatus(db);
      if (!setup.has_repo) {
        throw new Error("Cannot create bot before a repository is attached in settings");
      }
      if (!setup.has_models) {
        throw new Error("Cannot create bot before default LLM models are configured in settings");
      }
      if (!setup.has_decision_model) {
        throw new Error("Cannot create bot before the decision model is configured in settings");
      }

      const name = String(req.name ?? "").trim();
      if (!name) throw new Error("Bot name is required");
      if (db.listUsers("bot").some((b) => b.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`Bot already exists: ${name}`);
      }

      const settings = db.getHostSettings();
      const defaultRole = settings.roles.default!;
      const model =
        typeof req.model === "string" && req.model.trim()
          ? req.model.trim()
          : `${defaultRole.provider}/${defaultRole.model}`;
      const thinkingLevel =
        typeof req.thinking_level === "string" && req.thinking_level.trim()
          ? req.thinking_level.trim()
          : defaultRole.thinking_level ?? "medium";
      const persona = typeof req.persona === "string" ? req.persona : null;
      const sandboxEnabled = req.sandbox_enabled === undefined ? true : Boolean(req.sandbox_enabled);
      const sandboxNetwork = req.sandbox_network === undefined ? true : Boolean(req.sandbox_network);

      const botId = randomUUID();
      const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "bot";
      const email = typeof req.email === "string" && req.email.trim() ? req.email.trim() : `${slug}@kawan.local`;
      const keys = await generateBotKeypair(opts.dataDir, botId, email);

      const { bot, session } = db.transaction(() => {
        const createdBot = db.createUser({
          id: botId,
          kind: "bot",
          role: "member",
          name,
          email,
          persona,
          model,
          thinking_level: thinkingLevel,
          sandbox_enabled: sandboxEnabled,
          sandbox_network: sandboxNetwork,
          signing_key_path: keys.signingKeyPath,
          signing_pubkey: keys.signingPubkey,
        });
        db.insertSoulRevision({
          botId: createdBot.id,
          revision: 1,
          content: INITIAL_SOUL_DOCUMENT,
          diff: "+ Initial soul document",
          authorSessionId: null,
        });
        const orch = db.createSession({
          botId: createdBot.id,
          kind: "orchestrator",
          status: "not_started",
        });
        return { bot: createdBot, session: orch };
      });

      const botPayload = serializeBot(db, bot);
      if (!settings.merge_queue?.bot_id) {
        const latestSettings = db.getHostSettings();
        latestSettings.merge_queue = {
          ...(latestSettings.merge_queue ?? {}),
          bot_id: bot.id,
        };
        db.saveHostSettings(latestSettings);
      }
      if (mergeQueue) {
        mergeQueue.ensureConversation();
        mergeQueue.broadcastSnapshot();
      }
      for (const openIssue of db.listIssues({ status: "open" })) {
        db.addMember(openIssue.conversation_id, bot.id);
      }
      wsServer.broadcast({ type: "bot.update", bot: botPayload });
      return { bot: botPayload, session: serializeSession(session) };
    },

    "bot.update": async (req, client) => {
      if (client.user.role !== "admin") {
        throw new Error("Only admins can update bots");
      }
      const botId = String(req.bot_id ?? "");
      const existing = db.getUser(botId);
      if (!existing || existing.kind !== "bot") {
        throw new Error(`Bot not found: ${botId}`);
      }

      const nextPersona =
        req.persona !== undefined ? (req.persona === null ? null : String(req.persona)) : existing.persona;
      const personaChanged = req.persona !== undefined && nextPersona !== existing.persona;
      const nextModel =
        typeof req.model === "string" && req.model.trim() ? req.model.trim() : undefined;
      const nextThinking =
        typeof req.thinking_level === "string" && req.thinking_level.trim()
          ? req.thinking_level.trim()
          : undefined;
      const nextSandboxEnabled =
        req.sandbox_enabled !== undefined ? Boolean(req.sandbox_enabled) : undefined;
      const nextSandboxNetwork =
        req.sandbox_network !== undefined ? Boolean(req.sandbox_network) : undefined;
      const runtimeChanged =
        (nextModel !== undefined && nextModel !== existing.model) ||
        (nextThinking !== undefined && nextThinking !== existing.thinking_level) ||
        (nextSandboxEnabled !== undefined &&
          nextSandboxEnabled !== Boolean(existing.sandbox_enabled)) ||
        (nextSandboxNetwork !== undefined &&
          nextSandboxNetwork !== Boolean(existing.sandbox_network));
      const prevOrch =
        personaChanged || runtimeChanged ? db.getActiveOrchestratorSession(botId) : null;

      const { bot, session } = db.transaction(() => {
        const updated = db.updateBot(botId, {
          name: typeof req.name === "string" && req.name.trim() ? req.name.trim() : undefined,
          persona: req.persona !== undefined ? nextPersona : undefined,
          model: nextModel,
          thinking_level: nextThinking,
          sandbox_enabled: nextSandboxEnabled,
          sandbox_network: nextSandboxNetwork,
        })!;

        let activeOrch = db.getActiveOrchestratorSession(botId);
        if (personaChanged) {
          if (activeOrch) {
            db.updateSession(activeOrch.id, { status: "archived" });
          }
          activeOrch = db.createSession({
            botId,
            kind: "orchestrator",
            status: "not_started",
          });
        }
        return { bot: updated, session: activeOrch };
      });

      if ((personaChanged || runtimeChanged) && prevOrch) {
        await sessionManager.stopSession(prevOrch.id);
      }

      const botPayload = serializeBot(db, bot);
      wsServer.broadcast({ type: "bot.update", bot: botPayload });
      if (personaChanged && session) {
        wsServer.broadcast({ type: "session.update", session: serializeSession(session) });
      }
      return { bot: botPayload, session: session ? serializeSession(session) : null };
    },

    "session.list": (req) => {
      const botId = typeof req.bot_id === "string" ? req.bot_id : undefined;
      const conversationId =
        typeof req.conversation_id === "string" ? req.conversation_id : undefined;
      return {
        sessions: db.listSessions({ botId, conversationId }).map(serializeSession),
      };
    },

    "session.open": async (req) => {
      const sessionId = String(req.session_id ?? "");
      if (!sessionId) throw new Error("session_id is required");
      return await sessionManager.openSessionDetail(sessionId);
    },

    "artifact.get": (req) => {
      const artifactId = String(req.artifact_id ?? req.id ?? "");
      if (!artifactId) throw new Error("artifact_id is required");
      return sessionManager.getArtifactPayload(artifactId);
    },

    "land.merge": async (req, client) => {
      const landId = String(req.land_id ?? "").trim();
      if (!landId) throw new Error("land_id is required");
      return await mergeQueue.acceptProposal(landId, {
        by: client.user.id,
        trigger: "manual_approve",
        waitForSettlement: req.async !== true,
      });
    },

    "land.withdraw": async (req, client) => {
      const landId = String(req.land_id ?? "").trim();
      if (!landId) throw new Error("land_id is required");
      const reason = typeof req.reason === "string" && req.reason.trim() ? req.reason.trim() : undefined;
      return { queue: await mergeQueue.withdrawProposal(landId, client.user.id, reason) };
    },

    "session.confirm": async (req) => {
      const sessionId = String(req.session_id ?? "").trim();
      if (!sessionId) throw new Error("session_id is required");
      return await sessionManager.confirmPendingSession(sessionId);
    },

    "session.dismiss": async (req) => {
      const sessionId = String(req.session_id ?? "").trim();
      if (!sessionId) throw new Error("session_id is required");
      return await sessionManager.dismissPendingSession(sessionId);
    },

    "session.stop": async (req) => {
      const sessionId = String(req.session_id ?? "").trim();
      if (!sessionId) throw new Error("session_id is required");
      return await sessionManager.stopWorkerSession(sessionId);
    },

    "merge_queue.read": () => {
      return { queue: mergeQueue.getSnapshot() };
    },

    "merge_queue.configure": (req, client) => {
      if (client.user.role !== "admin") {
        throw new Error("Only admins can configure the merge queue");
      }
      const queue = mergeQueue.configure({
        bot_id: req.bot_id === undefined ? undefined : (req.bot_id as string | null),
        default_landing_mode:
          req.default_landing_mode === "auto" || req.default_landing_mode === "manual"
            ? req.default_landing_mode
            : undefined,
        conflict_policy:
          req.conflict_policy === "pause_on_issue" || req.conflict_policy === "auto_resolve_trivial"
            ? req.conflict_policy
            : undefined,
      });
      return { queue };
    },

    "merge_queue.pause": () => {
      return { queue: mergeQueue.pauseQueue() };
    },

    "merge_queue.resume": () => {
      return { queue: mergeQueue.resumeQueue() };
    },

    "merge_queue.retry": async (req) => {
      const landId = typeof req.land_id === "string" ? req.land_id : undefined;
      return { queue: await mergeQueue.retryLand(landId) };
    },

    "merge_queue.eject": async (req) => {
      const landId = String(req.land_id ?? "").trim();
      if (!landId) throw new Error("land_id is required");
      const reason = typeof req.reason === "string" && req.reason.trim() ? req.reason.trim() : "Sent back to implementer";
      return { queue: await mergeQueue.ejectLand(landId, reason) };
    },

    "merge_queue.remove": async (req) => {
      const landId = String(req.land_id ?? "").trim();
      if (!landId) throw new Error("land_id is required");
      return { queue: await mergeQueue.removeFromQueue(landId) };
    },

    "decision.redirect": async (req, client) => {
      const decisionId = String(req.decision_id ?? "");
      const destination = String(req.destination ?? "").trim();
      if (!decisionId) throw new Error("decision_id is required");
      if (!destination) throw new Error("destination is required");

      const existing = db.getDecision(decisionId);
      if (!existing) throw new Error(`Decision not found: ${decisionId}`);

      if (destination !== "none" && destination !== "orchestrator") {
        if (!destination.startsWith("session:")) {
          throw new Error(`Invalid destination: ${destination}`);
        }
        const sessId = destination.slice("session:".length);
        const sess = db.getSession(sessId);
        if (!sess || sess.bot_id !== existing.bot_id) {
          throw new Error(`Worker session not found for bot: ${sessId}`);
        }
      }

      const previousDestination = existing.destination;
      const updated = db.redirectDecision(decisionId, destination, client.user.id)!;
      if (db.listHeldDecisions(updated.conversation_id, updated.bot_id).length === 0) {
        cancelHoldTimer(updated.conversation_id, updated.bot_id);
      }
      const conv = db.getConversation(updated.conversation_id)!;
      wsServer.broadcastToConversation(conv, { type: "decision.new", decision: updated });

      if (destination !== "none") {
        const bot = db.getUser(updated.bot_id);
        const msg = db.getMessage(updated.message_id);
        if (bot && msg) {
          await dispatchEvent({
            bot,
            destination,
            conversation: conv,
            threadId: msg.thread_id,
            messages: [msg],
            redirectedFrom: previousDestination,
          });
        }
      }
      return { decision: updated };
    },

    "session.diff": async (req) => {
      const sessionId = String(req.session_id ?? "").trim();
      if (!sessionId) throw new Error("session_id is required");
      const diff = await sessionManager.getSessionDiff(sessionId);
      return { session_id: sessionId, diff };
    },

    "issue.list": (req) => {
      const status = typeof req.status === "string" && req.status.trim() ? (req.status.trim() as IssueStatus) : undefined;
      const ownerId = typeof req.owner_id === "string" && req.owner_id.trim() ? req.owner_id.trim() : undefined;
      return { issues: issueManager.listIssues({ status, ownerId }) };
    },

    "issue.create": (req, client) => {
      const title = String(req.title ?? "").trim();
      if (!title) throw new Error("title is required");
      return issueManager.createIssue({
        title,
        bodyMd: typeof req.body_md === "string" ? req.body_md : "",
        ownerId: typeof req.owner_id === "string" ? req.owner_id : client.user.id,
        implementerBotId:
          typeof req.implementer_bot_id === "string" ? req.implementer_bot_id : null,
        parentIssueId: typeof req.parent_issue_id === "string" ? req.parent_issue_id : null,
      });
    },

    "issue.open": async (req, client) => {
      const ref = (req.issue_id ?? req.number ?? "") as string | number;
      if (!ref) throw new Error("issue_id or number is required");
      return await issueManager.openIssue(ref, client.user.id);
    },

    "issue.update": (req) => {
      const ref = (req.issue_id ?? req.number ?? "") as string | number;
      if (!ref) throw new Error("issue_id or number is required");
      const issue = issueManager.updateIssue(ref, {
        title: typeof req.title === "string" ? req.title : undefined,
        body_md: typeof req.body_md === "string" ? req.body_md : undefined,
        owner_id: typeof req.owner_id === "string" ? req.owner_id : undefined,
        implementer_bot_id:
          req.implementer_bot_id === undefined
            ? undefined
            : (req.implementer_bot_id as string | null),
        parent_issue_id:
          req.parent_issue_id === undefined ? undefined : (req.parent_issue_id as string | null),
      });
      return { issue };
    },

    "issue.promote": async (req, client) => {
      const sessionId = String(req.session_id ?? "").trim();
      if (!sessionId) throw new Error("session_id is required");
      return await issueManager.promoteSessionToIssue({
        sessionId,
        title: typeof req.title === "string" ? req.title : undefined,
        bodyMd: typeof req.body_md === "string" ? req.body_md : undefined,
        ownerId: typeof req.owner_id === "string" ? req.owner_id : client.user.id,
      });
    },

    "issue.sync_main": async (req) => {
      const ref = (req.issue_id ?? req.number ?? "") as string | number;
      if (!ref) throw new Error("issue_id or number is required");
      return await issueManager.syncWithMain(ref);
    },

    "issue.propose": async (req) => {
      const ref = (req.issue_id ?? req.number ?? "") as string | number;
      if (!ref) throw new Error("issue_id or number is required");
      return await issueManager.proposeIssue(ref);
    },

    "issue.stop": async (req) => {
      const ref = (req.issue_id ?? req.number ?? "") as string | number;
      if (!ref) throw new Error("issue_id or number is required");
      return { issue: await issueManager.stopIssue(ref) };
    },

    "issue.close": async (req) => {
      const ref = (req.issue_id ?? req.number ?? "") as string | number;
      if (!ref) throw new Error("issue_id or number is required");
      return { issue: await issueManager.closeIssue(ref, Boolean(req.abandon)) };
    },
  };

  const routeIncomingMessage = async ({
    conversation,
    message,
    author,
  }: {
    conversation: ConversationRow;
    message: MessageRow;
    author: UserRow;
  }): Promise<void> => {
    if (conversation.kind === "merge_queue" && author.kind !== "human") return;
    if (
      author.kind === "human" &&
      conversation.kind === "merge_queue" &&
      mergeQueue.tryRouteIncidentMessage(conversation, message, author)
    ) {
      return;
    }
    if (
      author.kind === "human" &&
      conversation.kind === "issue" &&
      issueManager.tryRouteNeedsInputReply(conversation, message, author)
    ) {
      return;
    }
    const members = db.listMembers(conversation.id);
    const bots = members.filter((m) => m.kind === "bot");
    if (bots.length === 0) return;

    const settings = db.getHostSettings();
    const decisionConfig = settings.roles.decision;

    for (const bot of bots) {
      if (bot.id === author.id) continue;
      if (!decisionConfig?.baseUrl || !decisionConfig?.model || !decisionConfig?.apiKey) {
        wsServer.broadcastToConversation(conversation, {
          type: "error",
          conversation_id: conversation.id,
          message_id: message.id,
          bot_id: bot.id,
          message: `Bot ${bot.name} cannot route message: decision model is not configured`,
        });
        continue;
      }

      const recentRows = db.listRecentMessages(conversation.id, 15).filter((m) => m.id !== message.id);
      const recentMessages = recentRows.map((m) => {
        const u = db.getUser(m.author_id);
        return {
          message: m,
          authorName: u?.name ?? "unknown",
          authorKind: u?.kind ?? "human",
        };
      });
      const heldRows = db.listHeldDecisions(conversation.id, bot.id);
      const heldMessages = heldRows.map((h) => {
        const u = db.getUser(h.message.author_id);
        return {
          message: h.message,
          authorName: u?.name ?? "unknown",
        };
      });
      const activeSessions = db.listActiveWorkerSessions(bot.id, conversation.id);

      let result;
      try {
        result = await routeMessage({
          decisionConfig,
          bot,
          conversation,
          incomingMessage: message,
          incomingAuthor: author,
          recentMessages,
          heldMessages,
          activeSessions,
          mode: decisionMode,
          fixtureStore,
        });
      } catch (err) {
        wsServer.broadcastToConversation(conversation, {
          type: "error",
          conversation_id: conversation.id,
          message_id: message.id,
          bot_id: bot.id,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const shouldDispatchNow =
        result.destination !== "none" && result.readiness === "dispatch";
      const isHeld = result.destination !== "none" && result.readiness === "hold";
      const heldBatchId =
        shouldDispatchNow && heldRows.length > 0 ? randomUUID() : null;
      const holdExpiresAt = isHeld && holdTimeoutMs > 0 ? Date.now() + holdTimeoutMs : null;

      let updatedHeld: DecisionRow[] = [];
      const decision = db.transaction(() => {
        if (shouldDispatchNow && heldRows.length > 0) {
          updatedHeld = db.markDecisionsDispatched(
            heldRows.map((h) => h.id),
            heldBatchId,
          );
        } else if (isHeld && heldRows.length > 0) {
          updatedHeld = db.updateHeldExpiry(
            heldRows.map((h) => h.id),
            holdExpiresAt,
          );
        }
        return db.createDecision({
          conversationId: conversation.id,
          messageId: message.id,
          botId: bot.id,
          decisionType: "route_message",
          destination: result.destination,
          readiness: result.readiness,
          confidence: result.confidence,
          reason: result.reason,
          rawJson: result.rawJson,
          heldBatchId,
          dispatched: !isHeld,
          holdExpiresAt,
          explicitWorkStart: result.explicitWorkStart,
          workRequest: result.workRequest,
        });
      });

      wsServer.broadcastToConversation(conversation, {
        type: "decision.new",
        decision,
      });
      for (const hd of updatedHeld) {
        wsServer.broadcastToConversation(conversation, {
          type: "decision.new",
          decision: hd,
        });
      }

      if (isHeld && holdTimeoutMs > 0) {
        scheduleHoldTimer(conversation.id, bot.id, holdTimeoutMs);
      }

      if (shouldDispatchNow) {
        cancelHoldTimer(conversation.id, bot.id);
        const batchMessages = [...heldRows.map((h) => h.message), message];
        await dispatchEvent({
          bot,
          destination: result.destination,
          conversation,
          threadId: message.thread_id,
          messages: batchMessages,
          spawnIntent: {
            explicitWorkStart: result.explicitWorkStart,
            workRequest: result.workRequest,
          },
        });
      }
    }
  };

  wsServer = new KawanWsServer(wss, {
    db,
    hostNamespace: opts.hostNamespace ?? hostAddress,
    hostAddress,
    recordProtocolPath: opts.recordProtocolPath,
    extraHandlers,
    onMessageCreated: routeIncomingMessage,
  });

  sessionManager = new SessionManager({
    dataDir: opts.dataDir,
    db,
    wsServer,
    disableSandbox: opts.disableSandbox,
    soulHandlers: opts.soulHandlers ?? createSoulHandlers(db),
  });
  sessionManager.setBotMessageCallback(routeIncomingMessage);
  await sessionManager.start();
  mergeQueue = new MergeQueueManager({
    dataDir: opts.dataDir,
    db,
    wsServer,
    sessionManager,
    disableSandbox: opts.disableSandbox,
  });
  issueManager = new IssueManager({
    dataDir: opts.dataDir,
    db,
    wsServer,
    sessionManager,
    mergeQueue,
    disableSandbox: opts.disableSandbox,
  });
  mergeQueue.ensureConversation();
  void mergeQueue.kickLoop();
  void mergeQueue.refreshProposalMetrics();

  if (holdTimeoutMs > 0) {
    const grouped = new Map<string, { conversationId: string; botId: string; expiresAt: number }>();
    const now = Date.now();
    for (const h of db.listAllHeldDecisions()) {
      const key = holdKey(h.conversation_id, h.bot_id);
      const exp = h.hold_expires_at ?? now;
      const prev = grouped.get(key);
      if (!prev || exp > prev.expiresAt) {
        grouped.set(key, { conversationId: h.conversation_id, botId: h.bot_id, expiresAt: exp });
      }
    }
    for (const item of grouped.values()) {
      scheduleHoldTimer(item.conversationId, item.botId, Math.max(0, item.expiresAt - now));
    }
  }

  if (!opts.quiet) {
    if (bootstrapToken) {
      console.log(`kawan ready — connect to ${url} — bootstrap token ${bootstrapToken}`);
    } else {
      console.log(`kawan ready — connect to ${url}`);
    }
  }

  return {
    dataDir: opts.dataDir,
    host,
    port: actualPort,
    url,
    bootstrapToken,
    db,
    wsServer,
    sessionManager,
    httpServer,
    async close(): Promise<void> {
      for (const timer of holdTimers.values()) {
        clearTimeout(timer);
      }
      holdTimers.clear();
      await issueManager.close();
      await mergeQueue.close();
      await sessionManager.stopAll();
      await new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      });
      db.close();
    },
  };
}

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { ensureBootstrapToken } from "./auth.js";
import { KawanDb } from "./db.js";
import {
  DecisionFixtureStore,
  routeMessage,
  testDecisionModel,
  type DecisionMode,
} from "./decisions.js";
import { attachRepository, ensureHostSshKey, generateBotKeypair } from "./git.js";
import { serializeSession, SessionManager, type SoulHandlers } from "./sessions.js";
import { createSoulHandlers, INITIAL_SOUL_DOCUMENT } from "./soul.js";
import type {
  ConversationRow,
  HostSettings,
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
      const res = await fetch(url, {
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
        signal: AbortSignal.timeout(20_000),
      });
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
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
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
      error: err instanceof Error ? err.message : String(err),
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

  const dispatchEvent = async (ev: DispatchEvent): Promise<void> => {
    if (opts.onDispatch) {
      await opts.onDispatch(ev);
    } else {
      await sessionManager.dispatch(ev);
    }
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
      const sandboxNetwork = req.sandbox_network === undefined ? false : Boolean(req.sandbox_network);

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
      const prevOrch = personaChanged ? db.getActiveOrchestratorSession(botId) : null;

      const { bot, session } = db.transaction(() => {
        const updated = db.updateBot(botId, {
          name: typeof req.name === "string" && req.name.trim() ? req.name.trim() : undefined,
          persona: req.persona !== undefined ? nextPersona : undefined,
          model: typeof req.model === "string" && req.model.trim() ? req.model.trim() : undefined,
          thinking_level:
            typeof req.thinking_level === "string" && req.thinking_level.trim()
              ? req.thinking_level.trim()
              : undefined,
          sandbox_enabled:
            req.sandbox_enabled !== undefined ? Boolean(req.sandbox_enabled) : undefined,
          sandbox_network:
            req.sandbox_network !== undefined ? Boolean(req.sandbox_network) : undefined,
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

      if (personaChanged && prevOrch) {
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

    "land.approve": async (req, client) => {
      const landId = typeof req.land_id === "string" ? req.land_id : undefined;
      const sessionId = typeof req.session_id === "string" ? req.session_id : undefined;
      if (!landId && !sessionId) {
        throw new Error("land_id or session_id is required");
      }
      return await sessionManager.approveLand({
        landId,
        sessionId,
        approvedBy: client.user.id,
      });
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
  };

  wsServer = new KawanWsServer(wss, {
    db,
    hostNamespace: opts.hostNamespace ?? hostAddress,
    hostAddress,
    recordProtocolPath: opts.recordProtocolPath,
    extraHandlers,
    onMessageCreated: async ({ conversation, message, author }) => {
      if (author.kind !== "human") return;
      const members = db.listMembers(conversation.id);
      const bots = members.filter((m) => m.kind === "bot");
      if (bots.length === 0) return;

      const settings = db.getHostSettings();
      const decisionConfig = settings.roles.decision;

      for (const bot of bots) {
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

        const decision = db.transaction(() => {
          if (shouldDispatchNow && heldRows.length > 0) {
            db.markDecisionsDispatched(heldRows.map((h) => h.id));
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
          });
        });

        wsServer.broadcastToConversation(conversation, {
          type: "decision.new",
          decision,
        });

        if (shouldDispatchNow) {
          const batchMessages = [...heldRows.map((h) => h.message), message];
          await dispatchEvent({
            bot,
            destination: result.destination,
            conversation,
            threadId: message.thread_id,
            messages: batchMessages,
          });
        }
      }
    },
  });

  sessionManager = new SessionManager({
    dataDir: opts.dataDir,
    db,
    wsServer,
    disableSandbox: opts.disableSandbox,
    soulHandlers: opts.soulHandlers ?? createSoulHandlers(db),
  });
  await sessionManager.start();

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

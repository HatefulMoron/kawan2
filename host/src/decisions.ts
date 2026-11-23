import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ConversationRow,
  DecisionReadiness,
  DecisionRoleSettings,
  MessageRow,
  SessionRow,
  UserRow,
} from "./types.js";

export type DecisionMode = "live" | "record" | "replay";

export interface DecisionChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, DecisionChoiceAnswer>;
}

export interface RouteMessageInput {
  decisionConfig: DecisionRoleSettings;
  bot: UserRow;
  conversation: ConversationRow;
  incomingMessage: MessageRow;
  incomingAuthor: UserRow;
  recentMessages: Array<{ message: MessageRow; authorName: string; authorKind: string }>;
  heldMessages: Array<{ message: MessageRow; authorName: string }>;
  activeSessions: SessionRow[];
  mode: DecisionMode;
  fixtureStore?: DecisionFixtureStore;
}

export interface RouteMessageResult {
  destination: string;
  readiness: DecisionReadiness;
  explicitWorkStart: "yes" | "no";
  workRequest: "yes" | "no";
  confidence: number;
  reason: string;
  rawJson: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function normalizePayloadForFixture(payload: unknown): {
  normalized: unknown;
  idMap: Map<string, string>;
} {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  let counter = 0;

  const replaceString = (s: string): string =>
    s.replace(UUID_RE, (match) => {
      const lower = match.toLowerCase();
      let token = forward.get(lower);
      if (!token) {
        token = `uuid_${counter++}`;
        forward.set(lower, token);
        reverse.set(token, match);
      }
      return token;
    });

  const walk = (val: unknown): unknown => {
    if (typeof val === "string") return replaceString(val);
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        out[replaceString(k)] = walk(v);
      }
      return out;
    }
    return val;
  };

  return { normalized: walk(payload), idMap: reverse };
}

function restoreUuids(text: string, reverseMap: Map<string, string>): string {
  let out = text;
  for (const [token, uuid] of reverseMap.entries()) {
    out = out.split(token).join(uuid);
  }
  return out;
}

export class DecisionFixtureStore {
  private readonly path: string;
  private entries: Record<string, SystemOneResponse> = {};

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, SystemOneResponse>;
      this.entries = parsed ?? {};
    }
  }

  private hashKey(normalizedPayload: unknown): string {
    return createHash("sha256").update(JSON.stringify(normalizedPayload)).digest("hex").slice(0, 24);
  }

  get(payload: unknown): { response: SystemOneResponse; idMap: Map<string, string> } | null {
    const { normalized, idMap } = normalizePayloadForFixture(payload);
    const key = this.hashKey(normalized);
    const hit = this.entries[key];
    if (!hit) return null;
    const restored = JSON.parse(restoreUuids(JSON.stringify(hit), idMap)) as SystemOneResponse;
    return { response: restored, idMap };
  }

  set(payload: unknown, response: SystemOneResponse): void {
    const { normalized, idMap } = normalizePayloadForFixture(payload);
    const key = this.hashKey(normalized);
    let serialized = JSON.stringify(response);
    for (const [token, uuid] of idMap.entries()) {
      serialized = serialized.replace(new RegExp(uuid, "gi"), token);
    }
    this.entries[key] = JSON.parse(serialized) as SystemOneResponse;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.entries, null, 2)}\n`, "utf8");
  }
}

export function resolveSystemOneUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/systemone")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/systemone`;
  return `${trimmed}/v1/systemone`;
}

const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504, 529]);

/** Format an Error/fetch failure including nested `cause` or `AggregateError` details. */
export function formatFetchError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: any } | null)?.cause;
  if (!cause || typeof cause !== "object") {
    return base;
  }

  const parts: string[] = [];
  if (Array.isArray(cause.errors)) {
    for (const inner of cause.errors) {
      const code = typeof inner?.code === "string" ? inner.code : "";
      const addr = typeof inner?.address === "string" ? inner.address : "";
      const msg = typeof inner?.message === "string" ? inner.message : "";
      const piece = code && addr ? `${code} ${addr}` : code || msg;
      if (piece && piece !== base && !parts.includes(piece)) {
        parts.push(piece);
      }
    }
  }

  if (parts.length === 0) {
    const code = typeof cause.code === "string" ? cause.code : "";
    const msg = typeof cause.message === "string" ? cause.message : "";
    const piece =
      code && msg && msg !== code ? `${code}: ${msg}` : code || msg;
    if (piece && piece !== base) {
      parts.push(piece);
    }
  }

  return parts.length > 0 ? `${base} (${parts.join(", ")})` : base;
}

/** Run `fetch` with a per-attempt timeout and linear backoff retries on transport errors. */
export async function fetchWithRetry(
  url: string,
  init: Omit<RequestInit, "signal">,
  opts?: {
    timeoutMs?: number;
    maxAttempts?: number;
    baseDelayMs?: number;
    retryStatuses?: Set<number>;
  },
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const maxAttempts = opts?.maxAttempts ?? 4;
  const baseDelayMs = opts?.baseDelayMs ?? 400;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (opts?.retryStatuses?.has(res.status) && attempt < maxAttempts) {
        await res.arrayBuffer().catch(() => {});
        await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
        continue;
      }
      return res;
    } catch (err) {
      const code = (err as { code?: unknown; cause?: { code?: unknown } } | null)?.code
        ?? (err as { cause?: { code?: unknown } } | null)?.cause?.code;
      if (code === "ERR_INVALID_URL" || attempt >= maxAttempts) {
        throw new Error(formatFetchError(err));
      }
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
    }
  }

  throw new Error("fetch failed after retries");
}

export async function callSystemOne(
  config: DecisionRoleSettings,
  body: { model: string; state: unknown; questions: Record<string, unknown> },
  opts?: { timeoutMs?: number; maxAttempts?: number; baseDelayMs?: number },
): Promise<SystemOneResponse> {
  const url = resolveSystemOneUrl(config.baseUrl);
  let res: Response;
  try {
    res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      {
        timeoutMs: opts?.timeoutMs ?? 30_000,
        maxAttempts: opts?.maxAttempts ?? 4,
        baseDelayMs: opts?.baseDelayMs ?? 400,
        retryStatuses: RETRYABLE_HTTP_STATUSES,
      },
    );
  } catch (err) {
    throw new Error(`Decision model call failed: ${formatFetchError(err)}`);
  }

  if (res.ok) {
    return (await res.json()) as SystemOneResponse;
  }

  const rawText = await res.text();
  let msg = `${res.status} ${res.statusText}`;
  try {
    const parsed = JSON.parse(rawText) as {
      detail?: { error_type?: string; message?: string };
      error?: { message?: string };
    };
    if (parsed.detail) {
      msg = `${res.status} ${parsed.detail.error_type ?? "error"}: ${parsed.detail.message ?? rawText}`;
    } else if (parsed.error?.message) {
      msg = `${res.status}: ${parsed.error.message}`;
    }
  } catch {
    if (rawText) msg = `${res.status}: ${rawText}`;
  }
  throw new Error(`Decision model call failed: ${msg}`);
}

export function buildRouteMessagePayload(input: {
  model: string;
  bot: Pick<UserRow, "name" | "persona">;
  conversation: Pick<ConversationRow, "kind" | "name" | "topic">;
  incomingMessage: Pick<MessageRow, "body" | "thread_id">;
  incomingAuthor: Pick<UserRow, "name" | "kind">;
  recentMessages: Array<{ authorName: string; authorKind: string; threadId: string | null; body: string }>;
  heldMessages: Array<{ authorName: string; body: string }>;
  activeSessions: Array<Pick<SessionRow, "id" | "status" | "task" | "thread_id" | "last_report">>;
}): { model: string; state: Record<string, unknown>; questions: Record<string, unknown> } {
  const threadSession = input.incomingMessage.thread_id
    ? input.activeSessions.find((s) => s.thread_id === input.incomingMessage.thread_id)
    : undefined;

  const destinationCriteria: Record<string, string> = {
    none:
      "Chatter between humans, social talk, simple acknowledgements ('thanks', 'got it', 'lgtm', 'cool'), or messages unrelated to the bot and unrelated to any active worker session.",
    orchestrator:
      "Messages directed to the bot (by @mention, bot name, DM, or completing a held fragment to the bot) asking a new question, giving a new task, requesting status, or talking generally to the bot rather than steering one specific active worker session.",
  };

  for (const s of input.activeSessions) {
    const key = `session:${s.id}`;
    const threadHint =
      threadSession?.id === s.id
        ? " The incoming message is a reply inside this worker session's thread."
        : "";
    destinationCriteria[key] =
      `Messages replying to, steering, answering a question from, or giving follow-up feedback specifically for active worker session ${s.id} (task: ${s.task ?? "unspecified"}, status: ${s.status}).${threadHint}`;
  }

  const state: Record<string, unknown> = {
    bot: {
      name: input.bot.name,
      persona: input.bot.persona ?? "Software engineering assistant",
    },
    conversation: {
      kind: input.conversation.kind,
      name: input.conversation.name ?? "dm",
      topic: input.conversation.topic ?? null,
    },
    active_worker_sessions: input.activeSessions.map((s) => ({
      destination_id: `session:${s.id}`,
      status: s.status,
      task: s.task,
      last_report: s.last_report,
    })),
    recent_messages: input.recentMessages.map((m) => ({
      author: m.authorName,
      kind: m.authorKind,
      in_thread: m.threadId !== null,
      body: m.body,
    })),
    held_messages_waiting_for_completion: input.heldMessages.map((m) => ({
      author: m.authorName,
      body: m.body,
    })),
    incoming_message: {
      author: input.incomingAuthor.name,
      ...(input.incomingAuthor.kind === "bot" ? { author_kind: "bot" } : {}),
      in_thread: input.incomingMessage.thread_id !== null,
      in_session_thread: threadSession ? `session:${threadSession.id}` : null,
      body: input.incomingMessage.body,
    },
  };

  const convLabel =
    input.conversation.kind === "dm"
      ? "a direct message with the bot"
      : input.conversation.kind === "issue"
        ? `issue room ${input.conversation.name ?? "#issue"}`
        : `#${input.conversation.name ?? "channel"}`;
  const issueRoutingHint =
    input.conversation.kind === "issue" && input.activeSessions.length > 0
      ? " In an issue room with an active implementer session, implementation feedback, review findings, or steering for that bot belongs to session:<id>, while unrelated chatter stays none."
      : "";
  const botChatterHint =
    input.incomingAuthor.kind === "bot"
      ? " Note: incoming_message is from another bot, not a human. Choose 'none' for polite acknowledgements, status confirmations, sign-offs, or approvals ('looks good', 'LGTM', 'thanks', 'done', 'fixed') that do not require action or reply from this bot. Route to this bot (or its active worker session:<id>) when the other bot raises concrete review findings, asks a direct question, or explicitly @mentions this bot for work or feedback."
      : "";

  const questions = {
    destination: {
      type: "choice",
      instructions:
        `Decide whether incoming_message (from ${input.incomingAuthor.name} in ${convLabel}) belongs to no one (none), the bot's orchestrator (orchestrator), or a specific active worker session (session:<id>). ` +
        `Note: in a DM with the bot, messages are normally for the bot unless purely social closing remarks like 'thanks'. ` +
        `If held_messages_waiting_for_completion is non-empty and incoming_message completes the thought, route to the bot.${issueRoutingHint}${botChatterHint}`,
      criteria: destinationCriteria,
    },
    readiness: {
      type: "choice",
      instructions:
        "Decide whether to dispatch now or hold incoming_message briefly to wait for an immediate follow-up message. " +
        "Hold ONLY when incoming_message is an incomplete opening fragment or lead-in addressed to the bot that clearly implies another message is immediately following (such as '@bot hey', '@bot quick question', 'one sec', or 'can you check something?'). " +
        "Self-contained conversational questions or check-ins (such as '@bot what's up?', '@bot how are you?', '@bot are you there?') should dispatch immediately. " +
        "If held_messages_waiting_for_completion already has a fragment and incoming_message supplies the request, choose dispatch. " +
        "If destination is none, choose dispatch.",
      criteria: {
        dispatch:
          "A self-contained message, conversational check-in, question, request, or feedback is present (alone or combined with held_messages_waiting_for_completion), or destination is none.",
        hold:
          "An incomplete bare ping or dangling lead-in addressed to the bot (like '@bot hey' or '@bot quick question') where the user clearly hasn't sent their actual message yet.",
      },
    },
    explicit_work_start: {
      type: "choice",
      instructions:
        "Decide whether incoming_message is a direct, unambiguous instruction telling the bot to begin implementing, editing, or modifying the repository right now (such as '@bot fix the flaky header test', '@bot please add hello.txt and commit it', or '@bot go ahead and add that flag'). Choose 'no' for questions, status checks, brainstorming, hypotheticals, greetings, or indirect remarks lacking a clear imperative to start work now. If destination is none, choose 'no'.",
      criteria: {
        yes: "Direct, explicit imperative or clear go-ahead telling the bot to start repository changes right now.",
        no: "Anything not explicitly commanding the bot to start work now (questions, brainstorming, hypotheticals, indirect observations, greetings, or destination=none).",
      },
    },
    work_request: {
      type: "choice",
      instructions:
        "Decide strictly whether incoming_message is asking or expecting the bot to take on a concrete repository task right now (either explicitly OR phrased politely/indirectly, such as '@bot the CI build is flaky, could you take a look?' or '@bot this button looks broken'). MUST be 'no' for questions about how code works, status queries, greetings ('what's up?'), brainstorming, future possibilities, or hypotheticals ('what would it take to...', 'should we eventually...', 'what do you think about...'). If destination is none, choose 'no'.",
      criteria: {
        yes: "User is asking or expecting the bot to perform a concrete repository task or fix right now (explicitly or politely/indirectly).",
        no: "Questions, status checks, brainstorming, hypotheticals, social chat, human-to-human discussion, or anything without a request to perform concrete work.",
      },
    },
  };

  return { model: input.model, state, questions };
}

export async function routeMessage(input: RouteMessageInput): Promise<RouteMessageResult> {
  const payload = buildRouteMessagePayload({
    model: input.decisionConfig.model,
    bot: input.bot,
    conversation: input.conversation,
    incomingMessage: input.incomingMessage,
    incomingAuthor: input.incomingAuthor,
    recentMessages: input.recentMessages.map((r) => ({
      authorName: r.authorName,
      authorKind: r.authorKind,
      threadId: r.message.thread_id,
      body: r.message.body,
    })),
    heldMessages: input.heldMessages.map((h) => ({
      authorName: h.authorName,
      body: h.message.body,
    })),
    activeSessions: input.activeSessions,
  });

  let response: SystemOneResponse;
  if (input.mode === "replay" && input.decisionConfig.provider !== "stub") {
    if (!input.fixtureStore) {
      throw new Error("Replay decision mode requested without a fixture store");
    }
    const hit = input.fixtureStore.get(payload);
    if (!hit) {
      throw new Error("No recorded decision fixture found for routing request");
    }
    response = hit.response;
  } else {
    response = await callSystemOne(input.decisionConfig, payload);
    if (input.mode === "record" && input.fixtureStore && input.decisionConfig.provider !== "stub") {
      input.fixtureStore.set(payload, response);
    }
  }

  const destAns = response.answers?.destination;
  const readyAns = response.answers?.readiness;
  if (!destAns || !readyAns) {
    throw new Error(`Unexpected decision response shape: ${JSON.stringify(response)}`);
  }

  const destination = destAns.choice;
  const readiness: DecisionReadiness =
    destination === "none" ? "dispatch" : readyAns.choice === "hold" ? "hold" : "dispatch";
  const rawExplicit = response.answers?.explicit_work_start?.choice;
  const rawWorkReq = response.answers?.work_request?.choice;
  const explicitWorkStart: "yes" | "no" =
    destination !== "none" && rawExplicit === "yes" ? "yes" : "no";
  const workRequest: "yes" | "no" =
    destination !== "none" && (explicitWorkStart === "yes" || rawWorkReq === "yes") ? "yes" : "no";
  const confidence = Number(destAns.confidence ?? 0);
  const reason = `destination=${destination} (${(confidence * 100).toFixed(0)}%), readiness=${readiness} (${(Number(readyAns.confidence ?? 0) * 100).toFixed(0)}%), explicit=${explicitWorkStart}, request=${workRequest}`;

  return {
    destination,
    readiness,
    explicitWorkStart,
    workRequest,
    confidence,
    reason,
    rawJson: JSON.stringify(response),
  };
}

export async function testDecisionModel(
  config: DecisionRoleSettings,
): Promise<{ ok: boolean; latency_ms: number; sample?: { destination: string; readiness: string }; error?: string }> {
  const start = Date.now();
  try {
    const payload = buildRouteMessagePayload({
      model: config.model,
      bot: { name: "kawan", persona: "Engineering assistant" },
      conversation: { kind: "channel", name: "general", topic: null },
      incomingMessage: { body: "@kawan please check why the unit tests are failing", thread_id: null },
      incomingAuthor: { name: "alice", kind: "human" },
      recentMessages: [],
      heldMessages: [],
      activeSessions: [],
    });
    const res = await callSystemOne(config, payload);
    const dest = res.answers?.destination?.choice;
    const ready = res.answers?.readiness?.choice;
    const explicitStart = res.answers?.explicit_work_start?.choice;
    const workReq = res.answers?.work_request?.choice;
    if (!dest || !ready || !explicitStart || !workReq) {
      return {
        ok: false,
        latency_ms: Date.now() - start,
        error: `Invalid answer space returned: ${JSON.stringify(res)}`,
      };
    }
    return {
      ok: true,
      latency_ms: Date.now() - start,
      sample: { destination: dest, readiness: ready },
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

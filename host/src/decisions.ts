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

export async function callSystemOne(
  config: DecisionRoleSettings,
  body: { model: string; state: unknown; questions: Record<string, unknown> },
): Promise<SystemOneResponse> {
  const url = resolveSystemOneUrl(config.baseUrl);
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      return (await res.json()) as SystemOneResponse;
    }

    const rawText = await res.text();
    let msg = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(rawText) as { detail?: { error_type?: string; message?: string }; error?: { message?: string } };
      if (parsed.detail) {
        msg = `${res.status} ${parsed.detail.error_type ?? "error"}: ${parsed.detail.message ?? rawText}`;
      } else if (parsed.error?.message) {
        msg = `${res.status}: ${parsed.error.message}`;
      }
    } catch {
      if (rawText) msg = `${res.status}: ${rawText}`;
    }

    const retryable = res.status === 429 || res.status === 503 || res.status === 529;
    if (retryable && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
      continue;
    }
    throw new Error(`Decision model call failed: ${msg}`);
  }

  throw new Error("Decision model call failed after retries");
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
      in_thread: input.incomingMessage.thread_id !== null,
      in_session_thread: threadSession ? `session:${threadSession.id}` : null,
      body: input.incomingMessage.body,
    },
  };

  const questions = {
    destination: {
      type: "choice",
      instructions:
        `Decide whether incoming_message (from ${input.incomingAuthor.name} in ${
          input.conversation.kind === "dm" ? "a direct message with the bot" : `#${input.conversation.name ?? "channel"}`
        }) belongs to no one (none), the bot's orchestrator (orchestrator), or a specific active worker session (session:<id>). ` +
        `Note: in a DM with the bot, messages are normally for the bot unless purely social closing remarks like 'thanks'. ` +
        `If held_messages_waiting_for_completion is non-empty and incoming_message completes the thought, route to the bot.`,
      criteria: destinationCriteria,
    },
    readiness: {
      type: "choice",
      instructions:
        "Decide whether to dispatch now or hold incoming_message to wait for the next message. " +
        "Hold ONLY when the user sent an incomplete opening fragment/ping addressed to the bot (such as '@bot hey', '@bot quick question', 'hey @bot', 'one sec', or 'can you check something?') without stating the actual request yet. " +
        "If held_messages_waiting_for_completion already has a fragment and incoming_message supplies the request, choose dispatch. " +
        "If destination is none, choose dispatch.",
      criteria: {
        dispatch:
          "Actionable request/question/feedback is present (alone or combined with held_messages_waiting_for_completion), or destination is none.",
        hold:
          "Incomplete greeting, ping, or dangling lead-in addressed to the bot that lacks the actual request/question and should wait for the user's next message.",
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
  const confidence = Number(destAns.confidence ?? 0);
  const reason = `destination=${destination} (${(confidence * 100).toFixed(0)}%), readiness=${readiness} (${(Number(readyAns.confidence ?? 0) * 100).toFixed(0)}%)`;

  return {
    destination,
    readiness,
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
    if (!dest || !ready) {
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

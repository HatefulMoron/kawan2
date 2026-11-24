import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DecisionFixtureStore,
  routeMessage,
  type DecisionMode,
} from "../src/decisions.js";

interface RoutingCase {
  id: string;
  botName: string;
  conversation: { kind: "channel" | "dm"; name: string };
  activeSessions: Array<{
    id: string;
    status: string;
    task: string;
    thread_id: string | null;
    last_report: string | null;
  }>;
  recentMessages: Array<{ author: string; kind: string; threadId: string | null; body: string }>;
  heldMessages: Array<{ author: string; body: string }>;
  incoming: {
    author: string;
    inThread: boolean;
    matchesThreadSessionId?: string;
    body: string;
  };
  expected: {
    destination: string;
    readiness: "dispatch" | "hold";
    explicit_work_start?: "yes" | "no";
    work_request?: "yes" | "no";
  };
}

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2));
  const isLive = argv.has("--live") || process.env.KAWAN_LIVE === "1";
  const isRecord = argv.has("--record") || process.env.KAWAN_RECORD === "1";
  const mode: DecisionMode = isRecord ? "record" : isLive ? "live" : "replay";

  const casesPath = resolve("test/routing-cases.json");
  const fixturePath = resolve("fixtures/decisions/routing-cases.json");
  const cases = JSON.parse(readFileSync(casesPath, "utf8")) as RoutingCase[];
  const fixtureStore = new DecisionFixtureStore(fixturePath);

  const apiKey = process.env.SUBQ_API_KEY ?? "";
  if (mode !== "replay" && !apiKey) {
    throw new Error("SUBQ_API_KEY is required when running routing harness in --live or --record mode");
  }
  const decisionConfig = {
    provider: "subq",
    baseUrl: process.env.SUBQ_BASE_URL ?? "https://api.subq.ai/v1",
    model: process.env.SUBQ_MODEL ?? "subq-snap-1.2",
    apiKey: apiKey || "replay",
  };

  let destMatches = 0;
  let readyMatches = 0;
  let explicitMatches = 0;
  let explicitTotal = 0;
  let requestMatches = 0;
  let requestTotal = 0;
  let exactMatches = 0;
  const disagreements: string[] = [];

  for (const c of cases) {
    const threadId = c.incoming.matchesThreadSessionId
      ? c.activeSessions.find((s) => s.id === c.incoming.matchesThreadSessionId)?.thread_id ?? "thread-x"
      : c.incoming.inThread
        ? "thread-other"
        : null;

    const result = await routeMessage({
      decisionConfig,
      bot: {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "bot",
        role: "member",
        name: c.botName,
        email: `${c.botName}@kawan.local`,
        persona: "Helpful software engineering assistant",
        model: "lithosai/deepseek-ai/DeepSeek-V4.1-Flash",
        thinking_level: "medium",
        sandbox_enabled: 1,
        sandbox_network: 0,
        signing_key_path: null,
        signing_pubkey: null,
        created_at: 0,
      },
      conversation: {
        id: "00000000-0000-4000-8000-000000000002",
        kind: c.conversation.kind,
        name: c.conversation.name,
        topic: null,
        next_seq: 1,
        created_at: 0,
      },
      incomingMessage: {
        id: "00000000-0000-4000-8000-000000000003",
        conversation_id: "00000000-0000-4000-8000-000000000002",
        seq: 1,
        author_id: "00000000-0000-4000-8000-000000000004",
        thread_id: threadId,
        body: c.incoming.body,
        attachments: [],
        created_at: 0,
      },
      incomingAuthor: {
        id: "00000000-0000-4000-8000-000000000004",
        kind: "human",
        role: "admin",
        name: c.incoming.author,
        email: null,
        persona: null,
        model: null,
        thinking_level: null,
        sandbox_enabled: 0,
        sandbox_network: 0,
        signing_key_path: null,
        signing_pubkey: null,
        created_at: 0,
      },
      recentMessages: c.recentMessages.map((m, idx) => ({
        message: {
          id: `00000000-0000-4000-8000-0000000001${String(idx).padStart(2, "0")}`,
          conversation_id: "00000000-0000-4000-8000-000000000002",
          seq: idx + 1,
          author_id: "00000000-0000-4000-8000-000000000004",
          thread_id: m.threadId,
          body: m.body,
          attachments: [],
          created_at: 0,
        },
        authorName: m.author,
        authorKind: m.kind,
      })),
      heldMessages: c.heldMessages.map((h, idx) => ({
        message: {
          id: `00000000-0000-4000-8000-0000000002${String(idx).padStart(2, "0")}`,
          conversation_id: "00000000-0000-4000-8000-000000000002",
          seq: idx + 1,
          author_id: "00000000-0000-4000-8000-000000000004",
          thread_id: null,
          body: h.body,
          attachments: [],
          created_at: 0,
        },
        authorName: h.author,
      })),
      activeSessions: c.activeSessions.map((s) => ({
        id: s.id,
        bot_id: "00000000-0000-4000-8000-000000000001",
        parent_session_id: null,
        kind: "worker",
        conversation_id: "00000000-0000-4000-8000-000000000002",
        thread_id: s.thread_id,
        title: null,
        task: s.task,
        status: s.status as any,
        branch: `kawan/${s.id}`,
        clone_path: null,
        agent_dir: null,
        pi_session_file: null,
        last_entry_id: null,
        last_report: s.last_report,
        soul_snapshot: null,
        token: `tok-${s.id}`,
        created_at: 0,
        updated_at: 0,
      })),
      mode,
      fixtureStore,
    });

    const dOk = result.destination === c.expected.destination;
    const rOk = result.readiness === c.expected.readiness;
    const eOk =
      !c.expected.explicit_work_start ||
      result.explicitWorkStart === c.expected.explicit_work_start;
    const wOk =
      !c.expected.work_request || result.workRequest === c.expected.work_request;
    if (dOk) destMatches += 1;
    if (rOk) readyMatches += 1;
    if (c.expected.explicit_work_start) {
      explicitTotal += 1;
      if (eOk) explicitMatches += 1;
    }
    if (c.expected.work_request) {
      requestTotal += 1;
      if (wOk) requestMatches += 1;
    }
    if (dOk && rOk && eOk && wOk) {
      exactMatches += 1;
    } else {
      disagreements.push(
        `  - ${c.id}: expected (dest=${c.expected.destination}, ready=${c.expected.readiness}, explicit=${c.expected.explicit_work_start ?? "*"}, req=${c.expected.work_request ?? "*"}), got (dest=${result.destination}, ready=${result.readiness}, explicit=${result.explicitWorkStart}, req=${result.workRequest}) [${result.reason}]`,
      );
    }
  }

  const total = cases.length;
  const accuracy = (exactMatches / total) * 100;
  console.log(
    `Routing harness (${mode}): ${exactMatches}/${total} exact (${accuracy.toFixed(1)}%), ` +
      `destination ${destMatches}/${total}, readiness ${readyMatches}/${total}, ` +
      `explicit ${explicitMatches}/${explicitTotal}, work_request ${requestMatches}/${requestTotal}`,
  );
  if (disagreements.length > 0) {
    console.log("Disagreements:\n" + disagreements.join("\n"));
  }
  assert.ok(accuracy >= 80, `Routing accuracy ${accuracy.toFixed(1)}% is below 80%`);
}

void main();

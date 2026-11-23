import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { KawanDb } from "../src/db.js";
import type { DecisionMode } from "../src/decisions.js";
import { startHost } from "../src/server.js";
import {
  filterSoulForWorker,
  INITIAL_SOUL_DOCUMENT,
  replaceSoul,
  writeSoul,
} from "../src/soul.js";
import { createFixtureBareRepo, TestKeyPair, WsTestClient } from "./helpers.js";
import { startStubProvider } from "./stub-provider.js";

test("Slice 5 unit: soul_replace & soul_write invariants (ambiguous anchor, empty delete, 4KB cap, headings, worker filter)", () => {
  const dir = mkdtempSync(join(tmpdir(), "kawan-soul-unit-"));
  const db = new KawanDb(join(dir, "kawan.db"));
  try {
    const bot = db.createUser({ kind: "bot", role: "member", name: "kawan" });
    db.insertSoulRevision({
      botId: bot.id,
      revision: 1,
      content: INITIAL_SOUL_DOCUMENT,
      diff: "+ initial",
      authorSessionId: null,
    });

    // Missing anchor rejected
    assert.throws(
      () =>
        replaceSoul(db, {
          botId: bot.id,
          anchor: "THIS ANCHOR DOES NOT EXIST",
          text: "replacement",
          authorSessionId: "sess-1",
        }),
      /Anchor not found/,
    );

    // soul_write rejecting missing required heading
    assert.throws(
      () =>
        writeSoul(db, {
          botId: bot.id,
          document: "## Working agreements\n\n## Project facts\n\n## Decisions\n",
          authorSessionId: "sess-1",
        }),
      /Missing required section heading '## Preferences'/,
    );

    // Ambiguous anchor rejected WITHOUT mutating DB
    const withDupes = `${INITIAL_SOUL_DOCUMENT}\n- shared-marker\n- shared-marker\n`;
    const r2 = writeSoul(db, {
      botId: bot.id,
      document: withDupes,
      authorSessionId: "sess-1",
    });
    assert.equal(r2.revision, 2);

    assert.throws(
      () =>
        replaceSoul(db, {
          botId: bot.id,
          anchor: "- shared-marker",
          text: "- unique",
          authorSessionId: "sess-2",
        }),
      /Ambiguous anchor/,
    );
    assert.equal(db.getLatestSoul(bot.id)!.revision, 2, "Ambiguous replace must not bump revision");
    assert.equal(db.getLatestSoul(bot.id)!.content, withDupes);

    // Exact unique replace including special `$&` / `$$` chars works literally
    const r3 = replaceSoul(db, {
      botId: bot.id,
      anchor: "- Repository facts discovered during sessions go here.",
      text: "- Price token is $$100 and $& literal.",
      authorSessionId: "sess-3",
    });
    assert.equal(r3.revision, 3);
    assert.ok(db.getLatestSoul(bot.id)!.content.includes("$$100 and $& literal."));

    // Empty text deletes matched line cleanly
    const r4 = replaceSoul(db, {
      botId: bot.id,
      anchor: "\n- shared-marker\n- shared-marker\n",
      text: "\n",
      authorSessionId: "sess-4",
    });
    assert.equal(r4.revision, 4);
    assert.equal(db.getLatestSoul(bot.id)!.content.includes("shared-marker"), false);

    // Exceeding 4096 bytes rejected loudly
    assert.throws(
      () =>
        replaceSoul(db, {
          botId: bot.id,
          anchor: "- Key architectural choices and tradeoffs go here.",
          text: "x".repeat(4200),
          authorSessionId: "sess-5",
        }),
      /4096-byte cap/,
    );
    assert.throws(
      () =>
        writeSoul(db, {
          botId: bot.id,
          document: `${INITIAL_SOUL_DOCUMENT}\n${"y".repeat(4200)}`,
          authorSessionId: "sess-5",
        }),
      /4096-byte cap/,
    );

    // Worker filter includes only Working agreements & Project facts
    const filtered = filterSoulForWorker(db.getLatestSoul(bot.id)!.content);
    assert.ok(filtered.includes("## Working agreements"));
    assert.ok(filtered.includes("## Project facts"));
    assert.equal(filtered.includes("## Decisions"), false);
    assert.equal(filtered.includes("## Preferences"), false);

    // Revision history captures author_session_id and diff
    const revs = db.listSoulRevisions(bot.id);
    assert.equal(revs.length, 4);
    assert.equal(revs[2].author_session_id, "sess-3");
    assert.ok(revs[2].diff.includes("+ - Price token"));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Slice 5 e2e: worker fact reaches orchestrator's next run via soul (not scrollback)", async () => {
  const isLive = process.env.KAWAN_LIVE === "1";
  const isRecord = process.env.KAWAN_RECORD === "1";
  const decisionMode: DecisionMode = isRecord ? "record" : isLive ? "live" : "replay";

  const subqKey = process.env.SUBQ_API_KEY ?? (decisionMode === "replay" ? "replay-subq-key" : "");
  const lithosKey = process.env.LITHOSAI_API_KEY ?? "";
  const useLiveLlm = isLive && Boolean(lithosKey);
  if (decisionMode !== "replay" && !subqKey) {
    throw new Error("SUBQ_API_KEY required for live/record mode");
  }

  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({
    "README.md": "# Memory Fixture\n",
    "BUILD_NOTES.txt":
      "The secret integration test command is: ./scripts/run-emerald-check.sh\n",
  });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-slice5-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");
  const protocolPath = resolve("fixtures/protocol/slice5.jsonl");
  rmSync(protocolPath, { force: true });

  stub.setHandler((reqBody) => {
    const msgs = reqBody.messages ?? [];
    const sysText = String(msgs[0]?.content ?? "");
    const lastMsg = msgs[msgs.length - 1];
    const hasToolResult = lastMsg?.role === "tool";
    const lastUserMsg = [...msgs].reverse().find((m: any) => m.role === "user");
    const lastUserText = JSON.stringify(lastUserMsg?.content ?? "");

    if (sysText.includes("AI engineering orchestrator")) {
      // Fresh run in #ops: read directly from injected kawan://soul.md in system prompt
      if (lastUserText.includes("#ops")) {
        const match = sysText.match(/\.\/scripts\/[a-z0-9-]+\.sh/);
        if (!match) {
          return { text: "I could not find the integration test command in kawan://soul.md." };
        }
        return { text: `From my soul document: ${match[0]}` };
      }

      if (lastUserText.includes("[worker-report")) {
        if (!hasToolResult) {
          return {
            toolCalls: [
              {
                name: "soul_replace",
                arguments: {
                  anchor: "- Repository facts discovered during sessions go here.",
                  text: "- Integration test command: ./scripts/run-emerald-check.sh",
                },
              },
            ],
          };
        }
        return { text: "NO_REPLY" };
      }

      if (!hasToolResult) {
        return {
          toolCalls: [
            {
              name: "spawn_session",
              arguments: {
                task: "Read BUILD_NOTES.txt and call report(text) with its contents.",
              },
            },
          ],
        };
      }
      return { text: "Spawned worker to inspect BUILD_NOTES.txt." };
    }

    // Worker turns: read BUILD_NOTES.txt and report it
    const toolMsgs = msgs.filter((m: any) => m.role === "tool");
    if (toolMsgs.length === 0) {
      return {
        toolCalls: [{ name: "read", arguments: { path: "BUILD_NOTES.txt" } }],
      };
    }
    if (toolMsgs.length === 1) {
      return {
        toolCalls: [
          {
            name: "report",
            arguments: {
              text: "BUILD_NOTES.txt states: The secret integration test command is ./scripts/run-emerald-check.sh",
            },
          },
        ],
      };
    }
    return { text: "Reported BUILD_NOTES.txt." };
  });

  const host = await startHost({
    dataDir,
    quiet: true,
    disableSandbox: true,
    decisionMode,
    decisionFixturePath: resolve("fixtures/decisions/slice5.json"),
    recordProtocolPath: protocolPath,
  });

  try {
    const admin = await WsTestClient.connect(host.url);
    await admin.bootstrap(host.bootstrapToken!, "alice", adminKey);

    const llmBaseUrl = useLiveLlm
      ? (process.env.LITHOSAI_BASE_URL ?? "https://api.lithosai.cloud/v1")
      : stub.baseUrl;
    const llmModel = useLiveLlm
      ? (process.env.LITHOSAI_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash")
      : "stub-model";
    const llmApiKey = useLiveLlm ? lithosKey : "stub-key";
    const thinking = useLiveLlm ? (process.env.LITHOSAI_THINKING ?? "medium") : "off";
    const decisionBaseUrl =
      decisionMode === "replay"
        ? "https://api.subq.ai/v1"
        : (process.env.SUBQ_BASE_URL ?? "https://api.subq.ai/v1");
    const decisionModel = process.env.SUBQ_MODEL ?? "subq-snap-1.2";

    await admin.request("settings.update", {
      repo: { url: repo.barePath, default_branch: repo.defaultBranch },
      verify_command: "true",
      providers: {
        lithosai: {
          baseUrl: llmBaseUrl,
          api: "openai-completions",
          apiKey: llmApiKey,
          models: [
            {
              id: llmModel,
              name: llmModel,
              reasoning: useLiveLlm,
              contextWindow: 1048576,
              maxTokens: 393216,
              thinkingLevelMap: { minimal: null, low: "low", medium: "high", high: "high", xhigh: null, max: "max" },
              compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true, maxTokensField: "max_tokens" },
            },
          ],
        },
      },
      roles: {
        default: { provider: "lithosai", model: llmModel, thinking_level: thinking },
        decision: { provider: "subq", baseUrl: decisionBaseUrl, model: decisionModel, apiKey: subqKey },
      },
    });

    const createdBot = await admin.request<{ bot: any }>("bot.create", {
      name: "kawan",
      persona:
        "Practical engineering orchestrator. Delegate repo inspection via spawn_session. When workers report project facts, record them into your soul via soul_replace or soul_write.",
      sandbox_enabled: false,
    });
    const botId = createdBot.bot.id;

    const convs = await admin.request<{ conversations: Array<{ id: string; name: string }> }>(
      "conversation.list",
    );
    const generalId = convs.conversations.find((c) => c.name === "general")!.id;
    await admin.request("conversation.add_member", { conversation_id: generalId, user_id: botId });

    const waitTimeout = useLiveLlm ? 90_000 : 20_000;
    await admin.request("message.send", {
      conversation_id: generalId,
      body: "@kawan please have a worker read BUILD_NOTES.txt, report back, and save the integration test command into your soul.",
    });

    // Wait until soul is updated in SQLite with run-emerald-check.sh and orchestrator settles
    const soulDeadline = Date.now() + waitTimeout;
    let updatedSoul = host.db.getLatestSoul(botId)!;
    while (
      (!updatedSoul.content.includes("run-emerald-check.sh") ||
        host.db.getActiveOrchestratorSession(botId)?.status === "running") &&
      Date.now() < soulDeadline
    ) {
      await new Promise((r) => setTimeout(r, 200));
      updatedSoul = host.db.getLatestSoul(botId)!;
    }
    assert.ok(
      updatedSoul.revision >= 2 && updatedSoul.content.includes("run-emerald-check.sh"),
      `Expected soul to be updated with run-emerald-check.sh, got rev=${updatedSoul.revision}: ${updatedSoul.content}`,
    );

    // Archive old orchestrator pi session (zero old scrollback!) and open brand-new channel #ops
    const oldOrchId = host.db.getActiveOrchestratorSession(botId)!.id;
    await admin.request("bot.update", {
      bot_id: botId,
      persona:
        "Practical engineering orchestrator. Answer project questions using kawan://soul.md.",
    });
    const newOrch = host.db.getActiveOrchestratorSession(botId)!;
    assert.notEqual(newOrch.id, oldOrchId);
    assert.equal(newOrch.status, "not_started");

    const opsChan = await admin.request<{ conversation: { id: string } }>("conversation.create", {
      kind: "channel",
      name: "ops",
    });
    const opsId = opsChan.conversation.id;
    await admin.request("conversation.add_member", { conversation_id: opsId, user_id: botId });

    const recallReplyWait = admin.waitForNextFrame(
      (f) =>
        f.type === "message.new" &&
        f.message?.conversation_id === opsId &&
        f.author?.kind === "bot",
      waitTimeout,
    );
    await admin.request("message.send", {
      conversation_id: opsId,
      body: "@kawan what is the secret integration test command for this project?",
    });

    const recallFrame = await recallReplyWait;
    assert.match(
      recallFrame.message.body,
      /run-emerald-check\.sh/,
      `Fresh orchestrator in #ops must recall command via soul, got: ${recallFrame.message.body}`,
    );

    admin.close();
  } finally {
    await host.close();
    await stub.close();
    repo.cleanup();
    adminKey.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

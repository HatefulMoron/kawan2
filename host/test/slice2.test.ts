import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { DecisionMode } from "../src/decisions.js";
import { startHost, type DispatchEvent } from "../src/server.js";
import { createFixtureBareRepo, TestKeyPair, WsTestClient } from "./helpers.js";
import { startStubProvider } from "./stub-provider.js";

test("Slice 2: settings, models, bots, SubQ Snap routing (dispatch/hold/none), redirect, error visibility", async () => {
  const isLive = process.env.KAWAN_LIVE === "1";
  const isRecord = process.env.KAWAN_RECORD === "1";
  const decisionMode: DecisionMode = isRecord ? "record" : isLive ? "live" : "replay";

  const subqKey = process.env.SUBQ_API_KEY ?? (decisionMode === "replay" ? "replay-subq-key" : "");
  const lithosKey = process.env.LITHOSAI_API_KEY ?? "";
  if (decisionMode !== "replay" && !subqKey) {
    throw new Error("SUBQ_API_KEY must be set when KAWAN_LIVE=1 or KAWAN_RECORD=1");
  }

  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo();
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-slice2-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");
  const protocolPath = resolve("fixtures/protocol/slice2.jsonl");
  rmSync(protocolPath, { force: true });

  const dispatches: DispatchEvent[] = [];
  const host = await startHost({
    dataDir,
    quiet: true,
    decisionMode,
    decisionFixturePath: resolve("fixtures/decisions/slice2.json"),
    recordProtocolPath: protocolPath,
    onDispatch: (ev) => {
      dispatches.push(ev);
    },
  });

  try {
    const admin = await WsTestClient.connect(host.url);
    await admin.bootstrap(host.bootstrapToken!, "alice", adminKey);

    // 1. Creating a bot before repo & models are configured is blocked
    await assert.rejects(
      admin.request("bot.create", { name: "kawan" }),
      /repository is attached/i,
    );

    // 2. Bad branch attachment returns verbatim git error & emits error frame
    const badErrWait = admin.waitForNextFrame((f) => f.type === "error" && f.scope === "settings.repo");
    await assert.rejects(
      admin.request("settings.update", {
        repo: { url: repo.barePath, default_branch: "nonexistent-branch" },
      }),
    );
    const badErrFrame = await badErrWait;
    assert.ok(badErrFrame.message.length > 0);

    // 3. Attach fixture repo & verify settings.read masks secrets
    const useLiveLlm = isLive && Boolean(lithosKey);
    const llmBaseUrl = useLiveLlm
      ? (process.env.LITHOSAI_BASE_URL ?? "https://api.lithosai.cloud/v1")
      : stub.baseUrl;
    const llmModel = useLiveLlm
      ? (process.env.LITHOSAI_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash")
      : "stub-model";
    const llmApiKey = useLiveLlm ? lithosKey : "stub-secret-key-do-not-leak";
    const decisionBaseUrl =
      decisionMode === "replay" ? "https://api.subq.ai/v1" : (process.env.SUBQ_BASE_URL ?? "https://api.subq.ai/v1");
    const decisionModel = process.env.SUBQ_MODEL ?? "subq-snap-1.2";

    await admin.request("settings.update", {
      repo: { url: repo.barePath, default_branch: repo.defaultBranch, https_token: "secret-repo-token" },
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
              reasoning: true,
              contextWindow: 1048576,
              maxTokens: 393216,
              thinkingLevelMap: { minimal: null, low: "low", medium: "high", high: "high", xhigh: null, max: "max" },
              compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true, maxTokensField: "max_tokens" },
            },
          ],
        },
      },
      roles: {
        default: { provider: "lithosai", model: llmModel, thinking_level: "medium" },
        decision: { provider: "subq", baseUrl: decisionBaseUrl, model: decisionModel, apiKey: subqKey },
      },
    });

    // Materialized models.json exists on disk
    assert.ok(existsSync(join(dataDir, "models.json")));

    // settings.read must mask all secrets
    const readBack = await admin.request<any>("settings.read");
    const serialized = JSON.stringify(readBack);
    assert.equal(readBack.providers.lithosai.apiKeyConfigured, true);
    assert.equal(readBack.roles.decision.apiKeyConfigured, true);
    assert.equal(readBack.repo.https_token_configured, true);
    assert.ok(!serialized.includes(llmApiKey), "LLM API key leaked in settings.read");
    assert.ok(!serialized.includes(subqKey), "SubQ API key leaked in settings.read");
    assert.ok(!serialized.includes("secret-repo-token"), "HTTPS token leaked in settings.read");
    assert.ok(readBack.host_ssh_pubkey.startsWith("ssh-ed25519 "));

    // 4. models.test succeeds for default (stub or live) and decision (when live)
    if (decisionMode !== "replay") {
      const testRes = await admin.request<any>("models.test");
      assert.equal(testRes.default.ok, true, testRes.default.error);
      assert.equal(testRes.decision.ok, true, testRes.decision.error);
    } else {
      // Point decision temporarily to stub for deterministic models.test check, then restore
      await admin.request("settings.update", {
        roles: { decision: { provider: "stub", baseUrl: stub.systemOneBaseUrl, model: "stub-snap", apiKey: "stub" } },
      });
      const testRes = await admin.request<any>("models.test");
      assert.equal(testRes.default.ok, true, testRes.default.error);
      assert.equal(testRes.decision.ok, true, testRes.decision.error);

      // Verify inline failure when provider fails
      stub.setHandler(() => ({ status: 500, errorBody: { error: { message: "boom" } } }));
      const failTest = await admin.request<any>("models.test");
      assert.equal(failTest.default.ok, false);
      assert.match(failTest.default.error, /500/);
      stub.setHandler(() => ({ text: "ok" }));

      await admin.request("settings.update", {
        roles: { decision: { provider: "subq", baseUrl: decisionBaseUrl, model: decisionModel, apiKey: subqKey } },
      });
    }

    // 5. Create bot & test persona edit archives root session while keeping channel messages untouched
    const createdBot = await admin.request<{ bot: any; session: any }>("bot.create", {
      name: "kawan",
      persona: "Concise coding assistant",
    });
    const botId = createdBot.bot.id;
    const firstOrchId = createdBot.session.id;
    assert.equal(createdBot.bot.orchestrator_status, "not_started");
    assert.ok(createdBot.bot.signing_pubkey.startsWith("ssh-ed25519 "));

    const convs = await admin.request<{ conversations: Array<{ id: string; name: string }> }>("conversation.list");
    const generalId = convs.conversations.find((c) => c.name === "general")!.id;
    await admin.request("conversation.add_member", { conversation_id: generalId, user_id: botId });

    // Edit persona -> old root orchestrator archived, new one created
    const updatedBot = await admin.request<{ bot: any; session: any }>("bot.update", {
      bot_id: botId,
      persona: "Thorough senior engineer",
    });
    assert.notEqual(updatedBot.session.id, firstOrchId);
    assert.equal(updatedBot.session.status, "not_started");
    assert.equal(host.db.getSession(firstOrchId)?.status, "archived");

    // 6a. Addressed message walks the orchestrator dispatch path
    const d1Wait = admin.waitForNextFrame((f) => f.type === "decision.new");
    const m1 = await admin.request<{ message: { id: string } }>("message.send", {
      conversation_id: generalId,
      body: "@kawan please add a hello.txt file to the repo",
    });
    const d1Frame = await d1Wait;
    assert.equal(d1Frame.decision.message_id, m1.message.id);
    assert.equal(d1Frame.decision.destination, "orchestrator");
    assert.equal(d1Frame.decision.readiness, "dispatch");
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].messages.length, 1);

    // 6b. Fragment is held, then dispatches together with its successor
    const d2Wait = admin.waitForNextFrame((f) => f.type === "decision.new");
    const m2 = await admin.request<{ message: { id: string } }>("message.send", {
      conversation_id: generalId,
      body: "@kawan hey",
    });
    const d2Frame = await d2Wait;
    assert.equal(d2Frame.decision.message_id, m2.message.id);
    assert.equal(d2Frame.decision.destination, "orchestrator");
    assert.equal(d2Frame.decision.readiness, "hold");
    assert.equal(d2Frame.decision.dispatched, 0);
    assert.equal(dispatches.length, 1, "held fragment must NOT dispatch yet");

    const d3Wait = admin.waitForNextFrame((f) => f.type === "decision.new");
    const m3 = await admin.request<{ message: { id: string } }>("message.send", {
      conversation_id: generalId,
      body: "can you inspect why tests are failing?",
    });
    const d3Frame = await d3Wait;
    assert.equal(d3Frame.decision.message_id, m3.message.id);
    assert.equal(d3Frame.decision.destination, "orchestrator");
    assert.equal(d3Frame.decision.readiness, "dispatch");
    assert.equal(dispatches.length, 2, "follow-up should dispatch held batch + new message");
    assert.deepEqual(
      dispatches[1].messages.map((m) => m.id),
      [m2.message.id, m3.message.id],
    );

    // 6c. Human aside is routed to none and not dispatched
    const d4Wait = admin.waitForNextFrame((f) => f.type === "decision.new");
    const m4 = await admin.request<{ message: { id: string } }>("message.send", {
      conversation_id: generalId,
      body: "alice: grabbing coffee, back in 10 mins",
    });
    const d4Frame = await d4Wait;
    assert.equal(d4Frame.decision.message_id, m4.message.id);
    assert.equal(d4Frame.decision.destination, "none");
    assert.equal(dispatches.length, 2);

    // 7. Redirecting the `none` decision sends it to orchestrator immediately
    const redirWait = admin.waitForNextFrame(
      (f) => f.type === "decision.new" && f.decision?.id === d4Frame.decision.id,
    );
    await admin.request("decision.redirect", {
      decision_id: d4Frame.decision.id,
      destination: "orchestrator",
    });
    const redirFrame = await redirWait;
    assert.equal(redirFrame.decision.destination, "orchestrator");
    assert.equal(redirFrame.decision.redirected_from, "none");
    assert.equal(dispatches.length, 3);

    // 8. Missing/failing decision model produces a loud error frame in conversation
    await admin.request("settings.update", {
      roles: {
        decision: { provider: "stub", baseUrl: stub.systemOneBaseUrl, model: "stub-snap", apiKey: "bad" },
      },
    });
    stub.setSystemOneHandler(() => ({
      status: 401,
      body: { detail: { error_type: "authentication_error", message: "Invalid key" } },
    }));
    const errWait = admin.waitForNextFrame(
      (f) => f.type === "error" && f.conversation_id === generalId,
    );
    await admin.request("message.send", {
      conversation_id: generalId,
      body: "@kawan ping",
    });
    const errFrame = await errWait;
    assert.match(errFrame.message, /401/);

    // Verify protocol fixture has no leaked secrets
    const protoContent = readFileSync(protocolPath, "utf8");
    assert.ok(!protoContent.includes(llmApiKey));
    assert.ok(!protoContent.includes("secret-repo-token"));

    admin.close();
  } finally {
    await host.close();
    await stub.close();
    repo.cleanup();
    adminKey.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { DecisionMode } from "../src/decisions.js";
import { commitsAhead, ensureAllowedSigners, verifyCommitSignature } from "../src/git.js";
import { startHost } from "../src/server.js";
import { createFixtureBareRepo, TestKeyPair, WsTestClient } from "./helpers.js";
import { startStubProvider } from "./stub-provider.js";

test("Slice 3: orchestrator spawns worker, worker commits signed change and posts artifact", async () => {
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
    "README.md": "# Kawan Fixture\n\nSimple test repository.\n",
  });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-slice3-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");
  const protocolPath = resolve("fixtures/protocol/slice3.jsonl");
  rmSync(protocolPath, { force: true });

  // Scripted stub provider turns (used in deterministic mode when LITHOSAI_API_KEY / KAWAN_LIVE!=1)
  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    const hasToolResult = lastMsg?.role === "tool";
    const lastUserMsg = [...msgs].reverse().find((m: any) => m.role === "user");
    const lastUserText = JSON.stringify(lastUserMsg?.content ?? "");

    const isOrch = sysText.includes("AI engineering orchestrator");
    if (isOrch) {
      if (lastUserText.includes("[worker-report")) {
        return { text: "Created hello.txt containing 'hello kawan' and attached it." };
      }
      if (!hasToolResult) {
        return {
          toolCalls: [
            {
              name: "spawn_session",
              arguments: {
                title: "Add hello.txt",
                task: "Create a file named hello.txt containing 'hello kawan', commit it with git, and call report with a text artifact.",
              },
            },
          ],
        };
      }
      return { text: "On it." };
    }

    // Worker turns:
    // 1. write hello.txt + commit via bash
    // 2. call report with artifact
    // 3. final message
    const toolMessages = msgs.filter((m: any) => m.role === "tool");
    if (toolMessages.length === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: {
              command: "printf 'hello kawan\\n' > hello.txt && git add hello.txt && git commit -m 'Add hello.txt'",
            },
          },
        ],
      };
    }
    if (toolMessages.length === 1) {
      return {
        toolCalls: [
          {
            name: "report",
            arguments: {
              text: "Added hello.txt and committed it on branch.",
              artifact: {
                filename: "hello.txt",
                mime_type: "text/plain",
                content: "hello kawan\n",
              },
            },
          },
        ],
      };
    }
    return { text: "Done — hello.txt committed and artifact posted." };
  });

  const host = await startHost({
    dataDir,
    quiet: true,
    disableSandbox: true,
    decisionMode,
    decisionFixturePath: resolve("fixtures/decisions/slice3.json"),
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
      decisionMode === "replay" ? "https://api.subq.ai/v1" : (process.env.SUBQ_BASE_URL ?? "https://api.subq.ai/v1");
    const decisionModel = process.env.SUBQ_MODEL ?? "subq-snap-1.2";

    await admin.request("settings.update", {
      repo: { url: repo.barePath, default_branch: repo.defaultBranch },
      verify_command: "test -f hello.txt",
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
      persona: "Practical engineering orchestrator. Always delegate repository work via spawn_session.",
      sandbox_enabled: false,
    });
    const botId = createdBot.bot.id;

    const convs = await admin.request<{ conversations: Array<{ id: string; name: string }> }>("conversation.list");
    const generalId = convs.conversations.find((c) => c.name === "general")!.id;
    await admin.request("conversation.add_member", { conversation_id: generalId, user_id: botId });

    const waitTimeout = useLiveLlm ? 90_000 : 20_000;
    const artifactWait = admin.waitForNextFrame(
      (f) => f.type === "artifact.new" || f.type === "error",
      waitTimeout,
    );
    const workerSessionWait = admin.waitForNextFrame(
      (f) => (f.type === "session.update" && f.session?.kind === "worker") || f.type === "error",
      waitTimeout,
    );

    const orchMsgWait = admin.waitForNextFrame(
      (f) =>
        f.type === "message.new" &&
        f.author?.kind === "bot" &&
        typeof f.message?.body === "string" &&
        f.message.body.includes("Created hello.txt"),
      waitTimeout,
    );

    const sent = await admin.request<{ message: { id: string } }>("message.send", {
      conversation_id: generalId,
      body: "@kawan please create a file named hello.txt containing 'hello kawan', commit it on the worker branch, and call report with a text artifact containing the file content.",
    });

    const workerEv = await workerSessionWait;
    assert.notEqual(workerEv.type, "error", `Unexpected WS error: ${workerEv.message}`);
    const workerId = workerEv.session.id as string;
    assert.equal(workerEv.session.branch, `kawan/${workerId}`);

    // Wait for artifact to arrive AND orchestrator wrap-up message
    const artifactEv = await artifactWait;
    assert.notEqual(artifactEv.type, "error", `Unexpected WS error: ${artifactEv.message}`);
    const artifactId = artifactEv.artifact.id as string;

    if (!useLiveLlm) {
      const wrapMsg = await orchMsgWait;
      assert.equal(wrapMsg.message.artifact_id, artifactId);
    }

    // Wait until worker finishes running
    const deadline = Date.now() + waitTimeout;
    let workerRow = host.db.getSession(workerId)!;
    while (workerRow.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      workerRow = host.db.getSession(workerId)!;
    }
    assert.notEqual(workerRow.status, "failed", "Worker session should not fail");
    assert.notEqual(workerRow.status, "running", "Worker session should settle");

    // Wait briefly for orchestrator internal worker-report turn to settle too
    const orchDeadline = Date.now() + 30_000;
    let orchRow = host.db.getActiveOrchestratorSession(botId)!;
    while (orchRow.status === "running" && Date.now() < orchDeadline) {
      await new Promise((r) => setTimeout(r, 200));
      orchRow = host.db.getActiveOrchestratorSession(botId)!;
    }

    if (!useLiveLlm) {
      const convMsgs = host.db.listMessages(generalId);
      assert.ok(
        !convMsgs.some((m) => m.body === "Added hello.txt and committed it on branch."),
        "Worker report() must not post directly into chat",
      );
      assert.equal(workerRow.title, "Add hello.txt");
    }

    // Structural checks:
    // 1. Decision row exists for message
    const decisions = host.db.listDecisions(generalId);
    const dec = decisions.find((d) => d.message_id === sent.message.id);
    assert.ok(dec);
    assert.equal(dec.destination, "orchestrator");
    assert.equal(dec.readiness, "dispatch");

    // 2. Worker committed at least 1 commit ahead of default branch, signed by bot
    assert.ok(workerRow.clone_path);
    const ahead = await commitsAhead(workerRow.clone_path!, repo.defaultBranch);
    assert.ok(ahead >= 1, `Expected worker to commit >= 1 commit, got ${ahead}`);

    const allowedSigners = ensureAllowedSigners(dataDir, host.db.listUsers("bot"));
    const sigOk = await verifyCommitSignature(workerRow.clone_path!, "HEAD", allowedSigners);
    assert.equal(sigOk, true, "Worker commit must be validly SSH-signed by the bot");

    // 3. artifact.get returns matching content & sha256
    const fetched = await admin.request<{ artifact: any; base64: string; mime_type: string }>(
      "artifact.get",
      { artifact_id: artifactId },
    );
    const bytes = Buffer.from(fetched.base64, "base64");
    const actualSha = createHash("sha256").update(bytes).digest("hex");
    assert.equal(actualSha, fetched.artifact.sha256);
    assert.ok(bytes.byteLength > 0);

    // 4. session.list & session.open work
    const sessList = await admin.request<{ sessions: any[] }>("session.list", { bot_id: botId });
    assert.ok(sessList.sessions.some((s) => s.id === workerId));

    const detail = await admin.request<{ session: any; artifacts: any[]; entries: any[] }>(
      "session.open",
      { session_id: workerId },
    );
    assert.equal(detail.session.id, workerId);
    assert.ok(detail.artifacts.some((a) => a.id === artifactId));
    assert.ok(detail.entries.length > 0, "Expected persisted pi session entries");

    admin.close();
  } finally {
    await host.close();
    await stub.close();
    repo.cleanup();
    adminKey.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Slice 3: worker question routes to orchestrator via message_session without leaking into chat", async () => {
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo();
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-slice3-msg-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  stub.setHandler((reqBody) => {
    const msgs = reqBody.messages ?? [];
    const sysText = JSON.stringify(msgs[0] ?? "");
    const lastMsg = msgs[msgs.length - 1];
    const hasToolResult = lastMsg?.role === "tool";
    const lastUserText = JSON.stringify(
      [...msgs].reverse().find((m: any) => m.role === "user")?.content ?? "",
    );

    if (sysText.includes("AI engineering orchestrator")) {
      if (lastUserText.includes("Should config use JSON or YAML?")) {
        if (!hasToolResult) {
          const match = lastUserText.match(/session_id=([0-9a-f-]+)/);
          return {
            toolCalls: [
              {
                name: "message_session",
                arguments: {
                  session_id: match?.[1] ?? "",
                  message: "Use JSON format.",
                },
              },
            ],
          };
        }
        return { text: "NO_REPLY" };
      }
      if (lastUserText.includes("[worker-report")) {
        return { text: "Added config.json using JSON format as requested." };
      }
      if (!hasToolResult) {
        return {
          toolCalls: [
            {
              name: "spawn_session",
              arguments: {
                title: "Create config file",
                task: "Create a config file (ask orchestrator whether JSON or YAML if needed).",
              },
            },
          ],
        };
      }
      return { text: "On it." };
    }

    const toolMsgs = msgs.filter((m: any) => m.role === "tool");
    if (toolMsgs.length === 0) {
      return {
        toolCalls: [
          {
            name: "report",
            arguments: { text: "Should config use JSON or YAML?" },
          },
        ],
      };
    }
    if (lastUserText.includes("Use JSON format")) {
      return { text: "Created config.json with JSON format." };
    }
    return { text: "Waiting for orchestrator answer." };
  });

  const host = await startHost({
    dataDir,
    quiet: true,
    disableSandbox: true,
    decisionMode: "live",
  });

  try {
    const admin = await WsTestClient.connect(host.url);
    await admin.bootstrap(host.bootstrapToken!, "alice", adminKey);
    await admin.request("settings.update", {
      repo: { url: repo.barePath, default_branch: repo.defaultBranch },
      verify_command: "true",
      providers: {
        stub: {
          baseUrl: stub.baseUrl,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [{ id: "stub-model", name: "stub-model", reasoning: false, contextWindow: 128000, maxTokens: 16384 }],
        },
      },
      roles: {
        default: { provider: "stub", model: "stub-model", thinking_level: "off" },
        decision: { provider: "stub", baseUrl: stub.systemOneBaseUrl, model: "stub-snap", apiKey: "stub-key" },
      },
    });

    const created = await admin.request<{ bot: any }>("bot.create", {
      name: "kawan",
      persona: "Orchestrator",
      sandbox_enabled: false,
    });
    const convs = await admin.request<{ conversations: Array<{ id: string; name: string }> }>("conversation.list");
    const generalId = convs.conversations.find((c) => c.name === "general")!.id;
    await admin.request("conversation.add_member", { conversation_id: generalId, user_id: created.bot.id });

    const finalMsgWait = admin.waitForNextFrame(
      (f) =>
        f.type === "message.new" &&
        f.author?.kind === "bot" &&
        typeof f.message?.body === "string" &&
        f.message.body.includes("Added config.json"),
      25_000,
    );
    await admin.request("message.send", {
      conversation_id: generalId,
      body: "@kawan create config file using JSON",
    });

    const finalFrame = await finalMsgWait;
    assert.equal(finalFrame.message.body, "Added config.json using JSON format as requested.");
    const msgs = host.db.listMessages(generalId);
    assert.ok(
      !msgs.some((m) => m.body.includes("Should config use JSON or YAML?")),
      "Worker internal question must go through orchestrator, not chat",
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

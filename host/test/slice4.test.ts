import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { DecisionMode } from "../src/decisions.js";
import { ensureAllowedSigners, verifyCommitSignature } from "../src/git.js";
import { startHost } from "../src/server.js";
import { createFixtureBareRepo, TestKeyPair, WsTestClient } from "./helpers.js";
import { startStubProvider } from "./stub-provider.js";

const execFileAsync = promisify(execFile);

test("Slice 4: passing verify lands signed commit onto bare repo; failing verify blocks land and reports verbatim", async () => {
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
    "README.md": "# Land Fixture\n",
  });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-slice4-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");
  const protocolPath = resolve("fixtures/protocol/slice4.jsonl");
  rmSync(protocolPath, { force: true });

  // Stub provider handles pass scenario & fail scenario cleanly
  let scenarioPhase: "pass" | "fail" = "pass";
  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    const hasToolResult = lastMsg?.role === "tool";
    const lastUserText = JSON.stringify(
      [...msgs].reverse().find((m: any) => m.role === "user")?.content ?? "",
    );

    if (sysText.includes("AI engineering orchestrator")) {
      if (lastUserText.includes("[worker-report")) {
        return { text: "NO_REPLY" };
      }
      if (!hasToolResult) {
        return {
          toolCalls: [
            {
              name: "spawn_session",
              arguments: {
                task:
                  scenarioPhase === "pass"
                    ? "Create land_ok.txt containing 'ready', commit it, and call report then land_request."
                    : "Create bad_change.txt containing 'broken', commit it, and call report then land_request.",
              },
            },
          ],
        };
      }
      return { text: "Spawned worker to prepare the change." };
    }

    const toolCallsMade = msgs.filter((m: any) => m.role === "tool").length;
    if (toolCallsMade === 0) {
      const file = scenarioPhase === "pass" ? "land_ok.txt" : "bad_change.txt";
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: {
              command: `printf 'ready\\n' > ${file} && git add ${file} && git commit -m 'Add ${file}'`,
            },
          },
        ],
      };
    }
    if (toolCallsMade === 1) {
      return {
        toolCalls: [
          {
            name: "report",
            arguments: { text: "Committed change and verified locally." },
          },
        ],
      };
    }
    if (toolCallsMade === 2) {
      return {
        toolCalls: [
          {
            name: "land_request",
            arguments: { summary: "Ready for approval" },
          },
        ],
      };
    }
    return { text: "Land requested." };
  });

  const host = await startHost({
    dataDir,
    quiet: true,
    disableSandbox: true,
    decisionMode,
    decisionFixturePath: resolve("fixtures/decisions/slice4.json"),
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
      verify_command: "test -f land_ok.txt",
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
      persona: "Practical engineering orchestrator. Always delegate via spawn_session.",
      sandbox_enabled: false,
    });
    const botId = createdBot.bot.id;

    const convs = await admin.request<{ conversations: Array<{ id: string; name: string }> }>(
      "conversation.list",
    );
    const generalId = convs.conversations.find((c) => c.name === "general")!.id;
    await admin.request("conversation.add_member", { conversation_id: generalId, user_id: botId });

    const waitTimeout = useLiveLlm ? 90_000 : 20_000;

    // --- PART A: Passing verification lands commit onto bare repo ---
    const landReq1Wait = admin.waitForNextFrame(
      (f) => (f.type === "land.update" && f.land?.status === "requested") || f.type === "error",
      waitTimeout,
    );
    await admin.request("message.send", {
      conversation_id: generalId,
      body: "@kawan please create a file named land_ok.txt containing 'ready', commit it with git, and call land_request so I can approve landing it.",
    });

    const landReq1 = await landReq1Wait;
    assert.notEqual(landReq1.type, "error", `Unexpected error: ${landReq1.message}`);
    const land1Id = landReq1.land.id as string;
    const worker1Id = landReq1.land.session_id as string;
    const worker1ClonePath = host.db.getSession(worker1Id)!.clone_path!;
    assert.ok(existsSync(worker1ClonePath));

    const landedWait = admin.waitForNextFrame(
      (f) => f.type === "land.update" && f.land?.id === land1Id && f.land?.status === "landed",
      20_000,
    );
    const approveRes1 = await admin.request<{ land: any; session: any }>("land.approve", {
      land_id: land1Id,
    });
    await landedWait;
    assert.equal(approveRes1.land.status, "landed");
    assert.equal(approveRes1.session.status, "landed");
    assert.equal(approveRes1.land.base_sha, repo.initialHead);
    assert.ok(approveRes1.land.landed_sha);

    // Verify bare repo head moved and its parent is previous head
    const barePath = host.db.getHostSettings().repo!.bare_path;
    const { stdout: newHeadOut } = await execFileAsync(
      "git",
      ["--git-dir", barePath, "rev-parse", `refs/heads/${repo.defaultBranch}`],
      { timeout: 10_000 },
    );
    assert.equal(newHeadOut.trim(), approveRes1.land.landed_sha);

    const { stdout: parentOut } = await execFileAsync(
      "git",
      ["--git-dir", barePath, "rev-parse", `${approveRes1.land.landed_sha}^1`],
      { timeout: 10_000 },
    );
    assert.equal(parentOut.trim(), approveRes1.land.base_sha);

    // Verify SSH signature on landed commit in bare repository
    const allowedSigners = ensureAllowedSigners(dataDir, host.db.listUsers("bot"));
    const sigOk = await verifyCommitSignature(barePath, approveRes1.land.landed_sha, allowedSigners);
    assert.equal(sigOk, true, "Landed commit in bare repo must pass SSH signature verification");

    // Verify worker clone was cleaned up after landing
    assert.equal(existsSync(worker1ClonePath), false, "Worker clone should be removed after land");

    // Wait for any orchestrator turn to settle before Part B
    const orchWaitDeadline = Date.now() + 30_000;
    while (host.db.getActiveOrchestratorSession(botId)?.status === "running" && Date.now() < orchWaitDeadline) {
      await new Promise((r) => setTimeout(r, 150));
    }

    // --- PART B: Failing verification blocks land and posts verbatim output ---
    scenarioPhase = "fail";
    await admin.request("settings.update", {
      verify_command: "sh -c 'echo \"FAIL: lint check broken at line 42\" >&2; exit 1'",
    });

    const failChan = await admin.request<{ conversation: { id: string } }>("conversation.create", {
      kind: "channel",
      name: "failing-check",
    });
    const failChanId = failChan.conversation.id;
    await admin.request("conversation.add_member", { conversation_id: failChanId, user_id: botId });

    const landReq2Wait = admin.waitForNextFrame(
      (f) => (f.type === "land.update" && f.land?.status === "requested") || f.type === "error",
      waitTimeout,
    );
    await admin.request("message.send", {
      conversation_id: failChanId,
      body: "@kawan please create a file named bad_change.txt containing 'broken', commit it with git, and call land_request so I can test verification.",
    });

    const landReq2 = await landReq2Wait;
    assert.notEqual(landReq2.type, "error", `Unexpected error: ${landReq2.message}`);
    const land2Id = landReq2.land.id as string;
    const worker2Id = landReq2.land.session_id as string;
    const worker2ClonePath = host.db.getSession(worker2Id)!.clone_path!;

    const failMsgWait = admin.waitForNextFrame(
      (f) =>
        f.type === "message.new" &&
        typeof f.message?.body === "string" &&
        f.message.body.includes("FAIL: lint check broken at line 42"),
      20_000,
    );
    const approveRes2 = await admin.request<{ land: any; session: any }>("land.approve", {
      land_id: land2Id,
    });
    assert.equal(approveRes2.land.status, "failed");
    assert.equal(approveRes2.session.status, "failed");
    await failMsgWait;

    // Bare repo head MUST remain unchanged at approveRes1.land.landed_sha
    const { stdout: headAfterFail } = await execFileAsync(
      "git",
      ["--git-dir", barePath, "rev-parse", `refs/heads/${repo.defaultBranch}`],
      { timeout: 10_000 },
    );
    assert.equal(headAfterFail.trim(), approveRes1.land.landed_sha);
    assert.equal(existsSync(worker2ClonePath), true, "Failed worker clone should remain for inspection");

    admin.close();
  } finally {
    await host.close();
    await stub.close();
    repo.cleanup();
    adminKey.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

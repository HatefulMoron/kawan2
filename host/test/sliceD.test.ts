import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { DecisionMode } from "../src/decisions.js";
import { startHost } from "../src/server.js";
import { createFixtureBareRepo, TestKeyPair, WsTestClient } from "./helpers.js";
import { startStubProvider } from "./stub-provider.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

test("Slice D: bot-to-bot routing everywhere, read-only multi-reviewers, .kawan/* safety flag, and silent Soul Digest", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({
    "README.md": "# Slice D Bot-to-Bot Repo\n",
    ".kawan/checks/01-check.sh": "#!/bin/sh\ntest -f app.txt\n",
  });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceD-bot2bot-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  const snapCalls: Array<{ bot: string; author: string; authorKind?: string; conv: string; body: string }> = [];
  const reviewerToolSets: string[][] = [];

  stub.setSystemOneHandler((reqBody) => {
    const botName = String(reqBody?.state?.bot?.name ?? "");
    const inc = reqBody?.state?.incoming_message ?? {};
    const convKind = String(reqBody?.state?.conversation?.kind ?? "");
    const activeSessions = reqBody?.state?.active_worker_sessions ?? [];
    const body = String(inc.body ?? "");

    snapCalls.push({
      bot: botName,
      author: String(inc.author ?? ""),
      authorKind: inc.author_kind,
      conv: convKind,
      body,
    });

    // Polite sign-offs / acks from bots go to 'none'
    const lower = body.toLowerCase();
    const isAck = lower.includes("lgtm") || lower.includes("looks solid") || lower.includes("thanks") || lower.includes("updated app.txt");
    if (isAck) {
      return {
        status: 200,
        body: {
          model: "stub-snap",
          answers: {
            destination: { type: "choice", choice: "none", confidence: 0.99 },
            readiness: { type: "choice", choice: "dispatch", confidence: 0.99 },
            explicit_work_start: { type: "choice", choice: "no", confidence: 0.99 },
            work_request: { type: "choice", choice: "no", confidence: 0.99 },
          },
        },
      };
    }

    const mentioned = body.includes(`@${botName}`);
    if (!mentioned) {
      return {
        status: 200,
        body: {
          model: "stub-snap",
          answers: {
            destination: { type: "choice", choice: "none", confidence: 0.99 },
            readiness: { type: "choice", choice: "dispatch", confidence: 0.99 },
            explicit_work_start: { type: "choice", choice: "no", confidence: 0.99 },
            work_request: { type: "choice", choice: "no", confidence: 0.99 },
          },
        },
      };
    }

    const activeWorker = activeSessions[0]?.destination_id ?? null;
    const destination =
      convKind === "issue" && activeWorker && !body.includes("review")
        ? activeWorker
        : "orchestrator";

    return {
      status: 200,
      body: {
        model: "stub-snap",
        answers: {
          destination: { type: "choice", choice: destination, confidence: 0.99 },
          readiness: { type: "choice", choice: "dispatch", confidence: 0.99 },
          explicit_work_start: { type: "choice", choice: "yes", confidence: 0.99 },
          work_request: { type: "choice", choice: "yes", confidence: 0.99 },
        },
      },
    };
  });

  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    const lastUser = JSON.stringify([...msgs].reverse().find((m: any) => m.role === "user")?.content ?? "");

    if (sysText.includes("acting as a read-only code reviewer")) {
      if (lastMsg?.role === "tool") return { text: "NO_REPLY" };
      const toolNames = (reqBody.tools ?? []).map((t: any) => t.function?.name).filter(Boolean);
      reviewerToolSets.push(toolNames);

      if (sysText.includes("You are rev1")) {
        return {
          toolCalls: [
            {
              name: "report",
              arguments: { text: "Looks solid on correctness, LGTM." },
            },
          ],
        };
      }
      return {
        toolCalls: [
          {
            name: "report",
            arguments: {
              text: "@coder please update app.txt to v2 sentinel and add .kawan/checks/02-lint.sh.",
            },
          },
        ],
      };
    }

    if (sysText.includes("AI engineering orchestrator")) {
      if (lastUser.includes("[post-land-soul-digest")) {
        if (lastMsg?.role !== "tool") {
          return {
            toolCalls: [
              {
                name: "soul_replace",
                arguments: {
                  anchor: "- Repository facts discovered during sessions go here.",
                  text:
                    "- Repository facts discovered during sessions go here.\n" +
                    "- Always write v2 sentinel in app.txt before landing.",
                },
              },
            ],
          };
        }
        return { text: "NO_REPLY" };
      }

      if (sysText.includes("You are coder")) {
        if (lastUser.includes("ask @rev1")) {
          return { text: "@rev1 what style rule should I follow?" };
        }
        if (lastUser.includes("implement app.txt")) {
          if (lastMsg?.role !== "tool") {
            return {
              toolCalls: [
                {
                  name: "spawn_session",
                  arguments: { title: "Implement app.txt", task: "Create app.txt with v1 and commit." },
                },
              ],
            };
          }
          return { text: "NO_REPLY" };
        }
        return { text: "NO_REPLY" };
      }

      if (sysText.includes("You are rev1")) {
        if (lastUser.includes("style rule")) {
          return { text: "@coder use 2-space indent, thanks!" };
        }
        if (lastMsg?.role !== "tool") {
          return {
            toolCalls: [{ name: "review_issue", arguments: { focus: "Correctness" } }],
          };
        }
        return { text: "NO_REPLY" };
      }

      if (sysText.includes("You are rev2")) {
        // Test spawn_session fallback on an issue already owned by @coder -> launches read-only reviewer!
        if (lastMsg?.role !== "tool") {
          return {
            toolCalls: [
              {
                name: "spawn_session",
                arguments: { title: "Error handling", task: "Review error handling and checks." },
              },
            ],
          };
        }
        return { text: "NO_REPLY" };
      }
      return { text: "NO_REPLY" };
    }

    // Collaborative implementer worker (@coder)
    const isRevisionFromRev2 = JSON.stringify(msgs).includes(".kawan/checks/02-lint.sh");
    const lastUserIdx = msgs.map((m: any) => m.role).lastIndexOf("user");
    const toolCallsSinceUser = msgs.slice(lastUserIdx).filter((m: any) => m.role === "tool").length;

    if (!isRevisionFromRev2) {
      if (toolCallsSinceUser === 0) {
        return {
          toolCalls: [
            {
              name: "bash",
              arguments: { command: "printf 'v1\\n' > app.txt && git add app.txt && git commit -m 'Add app.txt v1'" },
            },
          ],
        };
      }
      if (toolCallsSinceUser === 1) {
        return { toolCalls: [{ name: "report", arguments: { text: "Implemented v1" } }] };
      }
      return { text: "NO_REPLY" };
    }

    if (toolCallsSinceUser === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: {
              command:
                "printf 'v2\\n' > app.txt && printf '#!/bin/sh\\ntrue\\n' > .kawan/checks/02-lint.sh && chmod +x .kawan/checks/02-lint.sh && git add app.txt .kawan/checks/02-lint.sh && git commit -m 'Update app.txt to v2 and add lint check'",
            },
          },
        ],
      };
    }
    if (toolCallsSinceUser === 1) {
      return {
        toolCalls: [{ name: "report", arguments: { text: "Updated app.txt to v2 per review" } }],
      };
    }
    return { text: "NO_REPLY" };
  });

  const host = await startHost({ dataDir, quiet: true, decisionMode, disableSandbox: true });
  let alice: WsTestClient | null = null;
  try {
    alice = await WsTestClient.connect(host.url);
    await alice.bootstrap(host.bootstrapToken!, "alice", adminKey);
    const convs = await alice.request<{ conversations: Array<{ id: string; name: string }> }>(
      "conversation.list",
    );
    const generalId = convs.conversations.find((c) => c.name === "general")!.id;

    await alice.request("settings.update", {
      repo: { url: repo.barePath, default_branch: repo.defaultBranch },
      providers: {
        stub: {
          baseUrl: stub.baseUrl,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [{ id: "stub-model", name: "stub-model" }],
        },
      },
      roles: {
        default: { provider: "stub", model: "stub-model", thinking_level: "off" },
        decision: { provider: "stub", baseUrl: stub.systemOneBaseUrl, model: "stub-snap", apiKey: "stub-key" },
      },
    });

    const coderRes = await alice.request<{ bot: { id: string } }>("bot.create", {
      name: "coder",
      persona: "Implementer",
      sandbox_enabled: false,
    });
    const rev1Res = await alice.request<{ bot: { id: string } }>("bot.create", {
      name: "rev1",
      persona: "Reviewer 1",
      sandbox_enabled: false,
    });
    const rev2Res = await alice.request<{ bot: { id: string } }>("bot.create", {
      name: "rev2",
      persona: "Reviewer 2",
      sandbox_enabled: false,
    });
    await alice.request("conversation.add_member", { conversation_id: generalId, user_id: coderRes.bot.id });
    await alice.request("conversation.add_member", { conversation_id: generalId, user_id: rev1Res.bot.id });

    // Make .kawan/checks/01-check.sh executable in bare repo
    const hostBare = join(dataDir, "repo.git");
    const chmodWork = mkdtempSync(join(tmpdir(), "kawan-chmod-"));
    try {
      await git(["clone", "--branch", repo.defaultBranch, hostBare, chmodWork]);
      await git(["config", "user.name", "Admin"], chmodWork);
      await git(["config", "user.email", "admin@kawan.local"], chmodWork);
      await git(["update-index", "--chmod=+x", ".kawan/checks/01-check.sh"], chmodWork);
      await git(["commit", "-m", "Make check executable"], chmodWork);
      await git(["push", "origin", repo.defaultBranch], chmodWork);
    } finally {
      rmSync(chmodWork, { recursive: true, force: true });
    }

    // 1. Bot-to-bot messaging in #general channel
    const rev1ReplyWait = alice.waitForNextFrame(
      (f) =>
        f.type === "message.new" &&
        f.message?.conversation_id === generalId &&
        f.author?.name === "rev1" &&
        String(f.message?.body).includes("use 2-space indent"),
      15_000,
    );
    await alice.request("message.send", {
      conversation_id: generalId,
      body: "@coder please ask @rev1 what style rule applies",
    });
    await rev1ReplyWait;
    assert.ok(
      snapCalls.some(
        (c) => c.bot === "rev1" && c.author === "coder" && c.authorKind === "bot" && c.conv === "channel",
      ),
      "Bot-to-bot message in channel must reach @rev1's SubQ Snap with author_kind='bot'",
    );
    assert.ok(
      !snapCalls.some((c) => c.bot === c.author),
      "A bot must never route its own messages",
    );

    // 2. Chat-driven Issue implementation + multi-reviewer loop via bot-to-bot routing
    const created = await alice.request<{
      issue: { id: string; number: number; conversation_id: string };
    }>("issue.create", {
      title: "Ship v2 app sentinel",
      body_md: "## Goal\nWrite `app.txt` and satisfy correctness + error handling reviews.",
    });
    const issueId = created.issue.id;
    const convId = created.issue.conversation_id;

    const firstPassChecksWait = alice.waitForNextFrame(
      (f) =>
        f.type === "issue.update" &&
        f.issue?.id === issueId &&
        f.issue?.commits_ahead === 1 &&
        f.issue?.checks_status === "passed",
      25_000,
    );
    await alice.request("message.send", {
      conversation_id: convId,
      body: "@coder implement app.txt now",
    });
    await firstPassChecksWait;

    // Human @mentions two reviewers in chat; @rev2 requests changes -> @coder sees bot message and fixes + touches .kawan/!
    let sawLiveReviewer = false;
    const stopWatch = alice.waitForNextFrame((f) => {
      if (f.type === "issue.update" && f.issue?.id === issueId && (f.issue?.active_reviewers?.length ?? 0) > 0) {
        sawLiveReviewer = true;
      }
      return (
        f.type === "issue.update" &&
        f.issue?.id === issueId &&
        f.issue?.touches_kawan === true &&
        f.issue?.commits_ahead === 2 &&
        f.issue?.checks_status === "passed"
      );
    }, 30_000);

    await alice.request("message.send", {
      conversation_id: convId,
      body: "@rev1 @rev2 please review this",
    });
    const revisedEv = await stopWatch;
    assert.equal(revisedEv.issue.touches_kawan, true);
    assert.ok(sawLiveReviewer, "active_reviewers must broadcast live while reviewer sessions run");

    // Verify reviewers had read-only tools + report (NO bash/edit/write/submit_review)
    assert.equal(reviewerToolSets.length, 2);
    for (const tools of reviewerToolSets) {
      assert.ok(tools.includes("report"), "reviewer must expose report");
      assert.ok(!tools.includes("submit_review"), "reviewer must not expose removed submit_review");
      assert.ok(!tools.includes("bash"), "reviewer must exclude bash");
      assert.ok(!tools.includes("edit"), "reviewer must exclude edit");
      assert.ok(!tools.includes("write"), "reviewer must exclude write");
    }

    // Verify Checkpoint host note did NOT enter SubQ Snap
    assert.ok(
      !snapCalls.some((c) => c.body.startsWith("Checkpoint:")),
      "Host checkpoint notes must NEVER re-enter SubQ Snap",
    );

    // Human clicks direct Land -> lands cleanly -> post-land Soul Digest updates @coder's soul.md
    const landedWait = alice.waitForNextFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.status === "landed",
      25_000,
    );
    await alice.request("issue.land", { issue_id: issueId });
    await landedWait;

    const landedApp = await git(["show", `refs/heads/${repo.defaultBranch}:app.txt`], hostBare);
    assert.equal(landedApp, "v2");

    const msgCountBeforeDigestCheck = host.db.listMessages(convId).length;
    const deadline = Date.now() + 10_000;
    let soulUpdated = false;
    while (Date.now() < deadline) {
      const soul = host.db.getLatestSoul(coderRes.bot.id);
      if (soul && soul.content.includes("Always write v2 sentinel in app.txt before landing.")) {
        soulUpdated = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(soulUpdated, "Post-landing Soul Digest must update @coder's soul.md via orchestrator");
    assert.equal(
      host.db.listMessages(convId).length,
      msgCountBeforeDigestCheck,
      "Silent Soul Digest must not clutter the issue conversation",
    );
  } finally {
    await alice?.close();
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
    repo.cleanup();
    adminKey.cleanup();
    await stub.close();
  }
});

test("Slice D: single-bot self-review via review_issue and blocking land_request on issue workers", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({ "README.md": "# Single Bot Self Review\n" });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceD-singlebot-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  let sawLandRequestError = false;
  let sawUpdatedSpecInReviewer = false;

  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    const lastUser = JSON.stringify([...msgs].reverse().find((m: any) => m.role === "user")?.content ?? "");

    if (sysText.includes("acting as a read-only code reviewer")) {
      if (sysText.includes("Include audit trail") || JSON.stringify(msgs).includes("Include audit trail")) {
        sawUpdatedSpecInReviewer = true;
      }
      if (lastMsg?.role === "tool") return { text: "NO_REPLY" };
      return {
        toolCalls: [
          {
            name: "report",
            arguments: { text: "Self-review note: missing audit trail log entry." },
          },
        ],
      };
    }

    if (sysText.includes("AI engineering orchestrator")) {
      if (lastUser.includes("review")) {
        if (lastMsg?.role !== "tool") {
          return {
            toolCalls: [{ name: "review_issue", arguments: { focus: "Spec compliance" } }],
          };
        }
        return { text: "NO_REPLY" };
      }
      if (lastMsg?.role !== "tool") {
        return {
          toolCalls: [
            { name: "spawn_session", arguments: { title: "Write work.txt", task: "Create work.txt and commit." } },
          ],
        };
      }
      return { text: "NO_REPLY" };
    }

    // Worker tries land_request -> must be rejected cleanly inside an issue session!
    const lastTool = [...msgs].reverse().find((m: any) => m.role === "tool");
    if (lastTool && JSON.stringify(lastTool).includes("cannot call land_request")) {
      sawLandRequestError = true;
      return {
        toolCalls: [{ name: "report", arguments: { text: "Committed work.txt cleanly." } }],
      };
    }
    const toolCount = msgs.filter((m: any) => m.role === "tool").length;
    if (toolCount === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: { command: "printf 'work\\n' > work.txt && git add work.txt && git commit -m 'Add work.txt'" },
          },
        ],
      };
    }
    if (toolCount === 1) {
      return {
        toolCalls: [{ name: "land_request", arguments: { summary: "trying land_request" } }],
      };
    }
    return { text: "NO_REPLY" };
  });

  const host = await startHost({ dataDir, quiet: true, decisionMode, disableSandbox: true });
  let alice: WsTestClient | null = null;
  try {
    alice = await WsTestClient.connect(host.url);
    await alice.bootstrap(host.bootstrapToken!, "alice", adminKey);
    await alice.request("settings.update", {
      repo: { url: repo.barePath, default_branch: repo.defaultBranch },
      providers: {
        stub: {
          baseUrl: stub.baseUrl,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [{ id: "stub-model", name: "stub-model" }],
        },
      },
      roles: {
        default: { provider: "stub", model: "stub-model", thinking_level: "off" },
        decision: { provider: "stub", baseUrl: stub.systemOneBaseUrl, model: "stub-snap", apiKey: "stub-key" },
      },
    });
    await alice.request("bot.create", { name: "kawan", persona: "Solo engineer", sandbox_enabled: false });

    const created = await alice.request<{ issue: { id: string; conversation_id: string } }>("issue.create", {
      title: "Solo self-review check",
      body_md: "Write work.txt.",
    });
    const issueId = created.issue.id;
    const convId = created.issue.conversation_id;

    // Newly created bot after issue creation also joins open issue conversation automatically
    const secondBot = await alice.request<{ bot: { id: string } }>("bot.create", {
      name: "helper",
      persona: "Helper",
      sandbox_enabled: false,
    });
    assert.ok(
      host.db.isMember(convId, secondBot.bot.id),
      "Newly created bots must automatically join open issue rooms",
    );

    const committedWait = alice.waitForNextFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.commits_ahead === 1,
      20_000,
    );
    await alice.request("message.send", { conversation_id: convId, body: "@kawan write work.txt now" });
    await committedWait;
    assert.equal(sawLandRequestError, true, "land_request must be rejected cleanly inside issue sessions");

    // Edit spec live, then ask @kawan to self-review -> review_issue spawns fresh read-only reviewer seeing updated spec!
    await alice.request("issue.update", { issue_id: issueId, body_md: "Write work.txt.\nInclude audit trail." });
    const reviewMsgWait = alice.waitForNextFrame(
      (f) =>
        f.type === "message.new" &&
        f.message?.conversation_id === convId &&
        String(f.message?.body).includes("missing audit trail"),
      20_000,
    );
    await alice.request("message.send", { conversation_id: convId, body: "@kawan review your work against the updated spec" });
    await reviewMsgWait;
    assert.equal(sawUpdatedSpecInReviewer, true, "Read-only reviewer must see updated kawan://issue.md");
  } finally {
    await alice?.close();
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
    repo.cleanup();
    adminKey.cleanup();
    await stub.close();
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

test("Slice D: parallel N-reviewers, auto_start_review, Round 2 anti-bikeshedding, auto_land, and post-land Soul Digest", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({
    "README.md": "# Slice D Multi-Reviewer Repo\n",
    ".kawan/checks/01-check.sh": "#!/bin/sh\ntest -f app.txt\n",
  });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceD-full-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  const reviewerToolSets: string[][] = [];
  const reviewerPrompts: Array<{ sys: string; user: string }> = [];

  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];

    if (sysText.includes("AI engineering orchestrator")) {
      const fullText = JSON.stringify(msgs);
      if (fullText.includes("[post-land-soul-digest")) {
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
      return { text: "NO_REPLY" };
    }

    if (sysText.includes("You are read-only code reviewer")) {
      const toolNames = (reqBody.tools ?? []).map((t: any) => t.function?.name).filter(Boolean);
      reviewerToolSets.push(toolNames);
      const userPrompt = JSON.stringify(
        [...msgs].reverse().find((m: any) => m.role === "user")?.content ?? "",
      );
      reviewerPrompts.push({ sys: String(reqBody.messages?.[0]?.content ?? ""), user: userPrompt });

      if (lastMsg?.role === "tool") {
        return { text: "Review submitted." };
      }

      if (sysText.includes("Error handling")) {
        if (sysText.includes("Review Round 2")) {
          return {
            toolCalls: [
              {
                name: "submit_review",
                arguments: {
                  verdict: "approve",
                  summary: "Round 2 verified v2 sentinel and zero regressions.",
                },
              },
            ],
          };
        }
        return {
          toolCalls: [
            {
              name: "submit_review",
              arguments: {
                verdict: "request_changes",
                summary: "Please update app.txt to v2 sentinel before auto-land.",
                notes_md: "## Round 1 Review Notes\nChange `v1` -> `v2` inside `app.txt`.",
              },
            },
          ],
        };
      }

      return {
        toolCalls: [
          {
            name: "submit_review",
            arguments: {
              verdict: "approve",
              summary: "Correctness verified cleanly.",
            },
          },
        ],
      };
    }

    // Collaborative implementer worker
    const isRevision = JSON.stringify(msgs).includes("[Review Round 1/");
    const toolCallsSinceUser = msgs
      .slice(msgs.map((m: any) => m.role).lastIndexOf("user"))
      .filter((m: any) => m.role === "tool").length;

    if (!isRevision) {
      if (toolCallsSinceUser === 0) {
        return {
          toolCalls: [
            {
              name: "bash",
              arguments: {
                command: "printf 'v1\\n' > app.txt && git add app.txt && git commit -m 'Add app.txt v1'",
              },
            },
          ],
        };
      }
      if (toolCallsSinceUser === 1) {
        return {
          toolCalls: [{ name: "report", arguments: { text: "Implemented v1" } }],
        };
      }
      return { text: "NO_REPLY" };
    }

    if (toolCallsSinceUser === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: {
              command: "printf 'v2\\n' > app.txt && git add app.txt && git commit -m 'Update app.txt to v2'",
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

    // Ensure .kawan/checks/01-check.sh is executable in bare repo clone
    await host.db.listUsers();
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
    const botRes = await alice.request<{ bot: { id: string } }>("bot.create", {
      name: "kawan",
      persona: "Orchestrator",
      sandbox_enabled: false,
    });
    const botId = botRes.bot.id;

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

    const created = await alice.request<{
      issue: { id: string; number: number; conversation_id: string };
    }>("issue.create", {
      title: "Ship v2 app sentinel",
      body_md: "## Goal\nWrite `app.txt` and satisfy correctness + error handling reviews.",
    });
    const issueId = created.issue.id;
    const convId = created.issue.conversation_id;

    const landedWait = alice.waitForNextFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.status === "landed",
      28_000,
    );

    await alice.request("issue.assign", {
      issue_id: issueId,
      implementer_bot_id: botId,
      auto_start_review: true,
      landing_mode: "auto",
      max_rounds: 3,
      reviewers: [
        { bot_id: botId, focus: "Correctness" },
        { bot_id: botId, focus: "Error handling" },
      ],
    });

    const landedEv = await landedWait;
    assert.equal(landedEv.issue.status, "landed");
    assert.equal(landedEv.issue.current_round, 2);
    assert.equal(landedEv.issue.reviewers.length, 2);
    assert.equal(landedEv.issue.reviews.length, 4);

    // Verify reviewers ran read-only without bash/edit/write/report and with submit_review
    assert.ok(reviewerToolSets.length >= 4);
    for (const tools of reviewerToolSets) {
      assert.ok(tools.includes("submit_review"), "reviewer must expose submit_review");
      assert.ok(!tools.includes("bash"), "reviewer must exclude bash");
      assert.ok(!tools.includes("edit"), "reviewer must exclude edit");
      assert.ok(!tools.includes("write"), "reviewer must exclude write");
      assert.ok(!tools.includes("report"), "reviewer must not expose report");
    }

    // Verify Round 2 prompt carries anti-bikeshedding instruction
    const r2Prompt = reviewerPrompts.find(
      (p) => p.sys.includes("Error handling") && p.sys.includes("Review Round 2"),
    );
    assert.ok(r2Prompt, "Round 2 Error handling reviewer must receive Round 2 anti-bikeshedding prompt");
    assert.ok(r2Prompt.sys.includes("Do NOT raise new style nits"));
    assert.ok(r2Prompt.user.includes("Round 1 (request_changes)"));

    // Verify auto_land trigger on lands table and v2 content on bare repo
    const lands = host.db.listLands({ sessionId: landedEv.issue.active_session_id });
    assert.equal(lands[0].trigger, "auto_land");
    assert.equal(lands[0].status, "landed");

    const landedApp = await git(["show", `refs/heads/${repo.defaultBranch}:app.txt`], hostBare);
    assert.equal(landedApp, "v2");

    // Verify post-landing Soul Digest updates bot soul cleanly without adding extra messages to #1
    const msgCountBeforeDigestCheck = host.db.listMessages(convId).length;
    const deadline = Date.now() + 10_000;
    let soulUpdated = false;
    while (Date.now() < deadline) {
      const soul = host.db.getLatestSoul(botId);
      if (soul && soul.content.includes("Always write v2 sentinel in app.txt before landing.")) {
        soulUpdated = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(soulUpdated, "Post-landing Soul Digest must update bot's soul.md via orchestrator");
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

test("Slice D: round cap circuit breaker pauses for owner, Return to Collaborate works, and needs_owner escalates", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({ "README.md": "# Round Cap Repo\n" });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceD-cap-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  let reviewerVerdict: "request_changes" | "needs_owner" = "request_changes";
  let reviewCalls = 0;

  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];

    if (sysText.includes("AI engineering orchestrator")) {
      return { text: "NO_REPLY" };
    }

    if (sysText.includes("You are read-only code reviewer")) {
      if (lastMsg?.role === "tool") return { text: "Done." };
      reviewCalls += 1;
      if (reviewerVerdict === "needs_owner") {
        return {
          toolCalls: [
            {
              name: "submit_review",
              arguments: {
                verdict: "needs_owner",
                summary: "Should we drop legacy compat flag before landing?",
              },
            },
          ],
        };
      }
      return {
        toolCalls: [
          {
            name: "submit_review",
            arguments: {
              verdict: "request_changes",
              summary: `Blocking concern in attempt ${reviewCalls}`,
            },
          },
        ],
      };
    }

    // Worker: on initial assign or revision, commit a dummy change
    const toolCallsSinceUser = msgs
      .slice(msgs.map((m: any) => m.role).lastIndexOf("user"))
      .filter((m: any) => m.role === "tool").length;
    if (toolCallsSinceUser === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: {
              command: `echo "$(date +%s%N)" >> work.txt && git add work.txt && git commit -m 'Work commit'`,
            },
          },
        ],
      };
    }
    if (toolCallsSinceUser === 1) {
      return {
        toolCalls: [{ name: "report", arguments: { text: "Committed update" } }],
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
      verify_command: "true",
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
    const botRes = await alice.request<{ bot: { id: string } }>("bot.create", {
      name: "kawan",
      persona: "Orchestrator",
      sandbox_enabled: false,
    });
    const botId = botRes.bot.id;

    const created = await alice.request<{ issue: { id: string } }>("issue.create", {
      title: "Exercise round cap",
      body_md: "Test circuit breaker at max_rounds = 2.",
    });
    const issueId = created.issue.id;

    const circuitBreakerWait = alice.waitForNextFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.status === "needs_input",
      25_000,
    );

    await alice.request("issue.assign", {
      issue_id: issueId,
      implementer_bot_id: botId,
      auto_start_review: true,
      max_rounds: 2,
      reviewers: [{ bot_id: botId, focus: "Strictness" }],
    });

    const tripped = await circuitBreakerWait;
    assert.equal(tripped.issue.current_round, 2);
    assert.equal(reviewCalls, 2);
    assert.ok(String(tripped.issue.needs_input_question).includes("Reached max review rounds (2/2)"));

    // Return to Collaborate -> implementing -> trigger manual review where reviewer returns needs_owner
    const returned = await alice.request<{ issue: { status: string } }>("issue.return_to_collaborate", {
      issue_id: issueId,
    });
    assert.equal(returned.issue.status, "implementing");

    reviewerVerdict = "needs_owner";
    const needsOwnerWait = alice.waitForNextFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.status === "needs_input",
      20_000,
    );
    await alice.request("issue.start_review", { issue_id: issueId });
    const escalated = await needsOwnerWait;
    assert.equal(
      escalated.issue.needs_input_question,
      "Should we drop legacy compat flag before landing?",
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

test("Slice D: .kawan/* modification safety guard downgrades auto_land to manual approval", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({ "README.md": "# Kawan Guard Repo\n" });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceD-kawan-guard-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];

    if (sysText.includes("AI engineering orchestrator")) {
      return { text: "NO_REPLY" };
    }
    if (sysText.includes("You are read-only code reviewer")) {
      if (lastMsg?.role === "tool") return { text: "Done." };
      return {
        toolCalls: [
          {
            name: "submit_review",
            arguments: { verdict: "approve", summary: "New check script looks safe." },
          },
        ],
      };
    }

    const toolCallsSinceUser = msgs
      .slice(msgs.map((m: any) => m.role).lastIndexOf("user"))
      .filter((m: any) => m.role === "tool").length;
    if (toolCallsSinceUser === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: {
              command:
                "mkdir -p .kawan/checks && printf '#!/bin/sh\\ntrue\\n' > .kawan/checks/02-lint.sh && chmod +x .kawan/checks/02-lint.sh && git add .kawan && git commit -m 'Add lint check'",
            },
          },
        ],
      };
    }
    if (toolCallsSinceUser === 1) {
      return {
        toolCalls: [{ name: "report", arguments: { text: "Added .kawan/checks/02-lint.sh" } }],
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
    const botRes = await alice.request<{ bot: { id: string } }>("bot.create", {
      name: "kawan",
      persona: "Orchestrator",
      sandbox_enabled: false,
    });
    const botId = botRes.bot.id;

    const created = await alice.request<{
      issue: { id: string; conversation_id: string };
    }>("issue.create", {
      title: "Add CI lint script",
      body_md: "Modify `.kawan/checks` so safety downgrade triggers.",
    });
    const issueId = created.issue.id;
    const convId = created.issue.conversation_id;

    const readyWait = alice.waitForNextFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.status === "ready_to_land",
      25_000,
    );

    await alice.request("issue.assign", {
      issue_id: issueId,
      implementer_bot_id: botId,
      auto_start_review: true,
      landing_mode: "auto",
      reviewers: [{ bot_id: botId, focus: "CI safety" }],
    });

    const readyEv = await readyWait;
    await new Promise((r) => setTimeout(r, 150));

    const current = host.db.getIssue(issueId)!;
    assert.equal(current.status, "ready_to_land", ".kawan/* modification must block auto-land");
    const lands = host.db.listLands({ sessionId: readyEv.issue.active_session_id });
    assert.equal(lands[0].touches_kawan, 1);
    assert.equal(lands[0].status, "requested");
    assert.ok(
      host.db
        .listMessages(convId)
        .some((m) => m.body.includes("auto-land downgraded to manual approval")),
    );

    const landedWait = alice.waitForNextFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.status === "landed",
      25_000,
    );
    await alice.request("land.approve", { land_id: lands[0].id, async: true });
    await landedWait;
    assert.equal(existsSync(join(dataDir, "repo.git")), true);
  } finally {
    await alice?.close();
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
    repo.cleanup();
    adminKey.cleanup();
    await stub.close();
  }
});

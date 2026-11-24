import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function seedRepoCommit(
  barePath: string,
  defaultBranch: string,
  files: Array<{ path: string; content: string; executable?: boolean }>,
  commitMessage: string,
): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "kawan-sliceC-seed-"));
  try {
    await git(["clone", "--branch", defaultBranch, barePath, work]);
    await git(["config", "user.name", "Repo Admin"], work);
    await git(["config", "user.email", "admin@kawan.local"], work);
    for (const f of files) {
      const full = join(work, f.path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, f.content, "utf8");
      if (f.executable) chmodSync(full, 0o755);
      await git(["add", f.path], work);
    }
    await git(["commit", "-m", commitMessage], work);
    await git(["push", "origin", defaultBranch], work);
    return await git(["rev-parse", "HEAD"], work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("Slice C: issue.md live injection, chat-first spawn, and unconfigured checks status 'none'", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({ "README.md": "# Issue Authoring\n" });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceC-author-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  const seenContexts: Array<{ role: string; text: string }> = [];

  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    const allPromptText = JSON.stringify(msgs);

    if (sysText.includes("AI engineering orchestrator")) {
      seenContexts.push({ role: "orchestrator", text: sysText });
      const lastUser = JSON.stringify([...msgs].reverse().find((m: any) => m.role === "user")?.content ?? "");
      if (lastUser.includes("start work on this")) {
        if (lastMsg?.role !== "tool") {
          return {
            toolCalls: [
              {
                name: "spawn_session",
                arguments: { title: "Create hello file", task: "Add hello.txt and commit on the issue branch." },
              },
            ],
          };
        }
        return { text: "Started implementing on the issue branch." };
      }

      if (lastMsg?.role !== "tool") {
        return {
          toolCalls: [
            {
              name: "create_issue",
              arguments: { title: "Add caching layer", body_md: "## Goal\nInitial caching spec." },
            },
          ],
        };
      }
      const toolResults = msgs.filter((m: any) => m.role === "tool");
      if (toolResults.length === 1) {
        return {
          toolCalls: [
            {
              name: "update_issue",
              arguments: { issue_ref: "#1", body_md: "## Goal\nUpdated caching spec with LRU eviction." },
            },
          ],
        };
      }
      if (toolResults.length === 2) {
        return { toolCalls: [{ name: "list_issues", arguments: {} }] };
      }
      return { text: "Created Issue #1 and updated its specification." };
    }

    // Issue worker
    seenContexts.push({ role: "worker", text: `${sysText}\n${allPromptText}` });
    const toolCount = msgs.filter((m: any) => m.role === "tool").length;
    if (toolCount === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: { command: "printf 'hello\\n' > hello.txt && git add hello.txt && git commit -m 'Add hello.txt'" },
          },
        ],
      };
    }
    if (toolCount === 1) {
      return {
        toolCalls: [{ name: "report", arguments: { text: "Committed hello.txt on issue branch." } }],
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
    const botRes = await alice.request<{ bot: { id: string } }>("bot.create", {
      name: "kawan",
      persona: "Orchestrator",
      sandbox_enabled: false,
    });
    await alice.request("conversation.add_member", { conversation_id: generalId, user_id: botRes.bot.id });

    const issueCreatedWait = alice.waitForFrame(
      (f) => f.type === "issue.update" && f.issue?.number === 1,
      15_000,
    );
    const replyWait = alice.waitForFrame(
      (f) =>
        f.type === "message.new" &&
        f.author?.kind === "bot" &&
        String(f.message?.body).includes("Created Issue #1"),
      15_000,
    );

    await alice.request("message.send", {
      conversation_id: generalId,
      body: "@kawan draft an issue for adding a caching layer",
    });

    await issueCreatedWait;
    await replyWait;

    const listed = await alice.request<{
      issues: Array<{ id: string; number: number; title: string; body_md: string; status: string; conversation_id: string }>;
    }>("issue.list");
    assert.equal(listed.issues.length, 1);
    const issue1 = listed.issues[0];
    assert.equal(issue1.status, "open");
    assert.equal(issue1.title, "Add caching layer");
    assert.ok(issue1.body_md.includes("LRU eviction"));

    const opened = await alice.request<{
      issue: { id: string; number: number; status: string };
      conversation: { kind: string; name: string };
    }>("issue.open", { issue_id: issue1.id });
    assert.equal(opened.issue.status, "open");
    assert.equal(opened.conversation.kind, "issue");
    assert.equal(opened.conversation.name, "issue-1");

    const updated = await alice.request<{ issue: { body_md: string } }>("issue.update", {
      issue_id: issue1.id,
      body_md: "## Goal\nHuman-edited markdown spec.",
    });
    assert.equal(updated.issue.body_md, "## Goal\nHuman-edited markdown spec.");

    // Trigger implementation via @kawan in issue room -> verify dynamic kawan://issue.md + checks='none'
    const workerCommitWait = alice.waitForNextFrame(
      (f) =>
        f.type === "issue.update" &&
        f.issue?.id === issue1.id &&
        f.issue?.commits_ahead === 1 &&
        f.issue?.checks_sha !== null,
      25_000,
    );
    await alice.request("message.send", {
      conversation_id: issue1.conversation_id,
      body: "@kawan start work on this",
    });

    const afterCommit = await workerCommitWait;
    assert.equal(afterCommit.issue.status, "open");
    assert.equal(afterCommit.issue.checks_status, "none", "Unconfigured repo must keep checks_status='none'");
    assert.ok(
      seenContexts.some((c) => c.role === "orchestrator" && c.text.includes("Human-edited markdown spec.")),
      "Orchestrator must receive updated kawan://issue.md dynamically",
    );
    assert.ok(
      seenContexts.some((c) => c.role === "worker" && c.text.includes("Human-edited markdown spec.")),
      "Worker must receive updated kawan://issue.md dynamically",
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

test("Slice C: chat-first spawn gate, ask_owner (open), implicit check fail (no auto-retry), sync_main, fix -> pass, issue.propose + land.merge", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({ "README.md": "# Collaborative Issue Repo\n" });
  await seedRepoCommit(
    repo.barePath,
    repo.defaultBranch,
    [{ path: ".kawan/checks/01-check.sh", content: "#!/bin/sh\ngrep -q '^PASS$' ready.txt\n", executable: true }],
    "Add ready check",
  );

  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceC-collab-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  let snapMode: "hold_proposal" | "to_worker" = "hold_proposal";
  stub.setSystemOneHandler((reqBody) => {
    const incoming = reqBody?.state?.incoming_message?.body ?? "";
    const activeSessions = reqBody?.state?.active_worker_sessions ?? [];
    if (snapMode === "hold_proposal" && activeSessions.length === 0) {
      return {
        status: 200,
        body: {
          model: "stub-snap",
          answers: {
            destination: { type: "choice", choice: "orchestrator", confidence: 0.99 },
            readiness: { type: "choice", choice: "dispatch", confidence: 0.99 },
            explicit_work_start: { type: "choice", choice: "no", confidence: 0.96 },
            work_request: { type: "choice", choice: "yes", confidence: 0.95 },
          },
        },
      };
    }
    const targetSession = activeSessions[0]?.destination_id ?? "orchestrator";
    const dest = incoming.includes("@kawan") ? targetSession : "none";
    return {
      status: 200,
      body: {
        model: "stub-snap",
        answers: {
          destination: { type: "choice", choice: dest, confidence: 0.99 },
          readiness: { type: "choice", choice: "dispatch", confidence: 0.99 },
          explicit_work_start: { type: "choice", choice: "yes", confidence: 0.99 },
          work_request: { type: "choice", choice: "yes", confidence: 0.99 },
        },
      },
    };
  });

  let stage: "ask" | "draft_ready" | "fix_pass" = "ask";
  let workerTurns = 0;

  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    if (sysText.includes("AI engineering orchestrator")) {
      if (lastMsg?.role !== "tool") {
        return {
          toolCalls: [
            {
              name: "spawn_session",
              arguments: { title: "Configure ready sentinel", task: "Implement ready.txt cleanly." },
            },
          ],
        };
      }
      return { text: "Proposed branch work for Issue #1." };
    }

    const lastUserIdx = msgs.map((m: any) => m.role).lastIndexOf("user");
    const toolCallsSinceUser = msgs.slice(lastUserIdx).filter((m: any) => m.role === "tool").length;
    if (toolCallsSinceUser === 0) workerTurns += 1;

    if (stage === "ask") {
      if (lastMsg?.role !== "tool") {
        return {
          toolCalls: [
            {
              name: "ask_owner",
              arguments: { question: "Should ready.txt say PASS or READY?" },
            },
          ],
        };
      }
      stage = "draft_ready";
      return { text: "Asked owner." };
    }

    if (stage === "draft_ready") {
      if (toolCallsSinceUser === 0) {
        return {
          toolCalls: [
            {
              name: "bash",
              arguments: { command: "printf 'READY\\n' > ready.txt && git add ready.txt && git commit -m 'Draft ready.txt'" },
            },
          ],
        };
      }
      if (toolCallsSinceUser === 1) {
        return {
          toolCalls: [
            {
              name: "report",
              arguments: {
                text: "First draft ready for check",
                artifacts: [{ filename: "notes.txt", mime_type: "text/plain", content: "wrote READY\n" }],
              },
            },
          ],
        };
      }
      stage = "fix_pass";
      return { text: "NO_REPLY" };
    }

    // stage === "fix_pass"
    if (toolCallsSinceUser === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: { command: "printf 'PASS\\n' > ready.txt && git add ready.txt && git commit -m 'Set ready.txt to PASS'" },
          },
        ],
      };
    }
    if (toolCallsSinceUser === 1) {
      return {
        toolCalls: [{ name: "report", arguments: { text: "Fixed ready.txt to PASS and committed." } }],
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
    await alice.request("bot.create", {
      name: "kawan",
      persona: "Orchestrator",
      sandbox_enabled: false,
    });

    const created = await alice.request<{ issue: { id: string; number: number; status: string; conversation_id: string } }>(
      "issue.create",
      { title: "Configure ready sentinel", body_md: "Write ready.txt cleanly." },
    );
    assert.equal(created.issue.status, "open");
    const issueId = created.issue.id;
    const issueConvId = created.issue.conversation_id;

    // Polite / tentative request holds behind [Start] [Dismiss] proposal card
    const pendingWait = alice.waitForNextFrame(
      (f) => f.type === "session.update" && f.session?.status === "pending_approval",
      15_000,
    );
    await alice.request("message.send", {
      conversation_id: issueConvId,
      body: "@kawan could you maybe take a look at implementing ready.txt?",
    });
    const pendingEv = await pendingWait;
    const workerId = pendingEv.session.id as string;

    // Confirm -> binds branch to issue -> worker calls ask_owner -> stays 'open' with needs_input_question
    snapMode = "to_worker";
    const needsInputWait = alice.waitForNextFrame(
      (f) =>
        f.type === "issue.update" &&
        f.issue?.id === issueId &&
        f.issue?.needs_input_question === "Should ready.txt say PASS or READY?",
      20_000,
    );
    const askIdleWait = alice.waitForNextFrame(
      (f) => f.type === "session.update" && f.session?.id === workerId && f.session?.status === "idle",
      20_000,
    );
    await alice.request("session.confirm", { session_id: workerId });
    const niEv = await needsInputWait;
    assert.equal(niEv.issue.status, "open");
    await askIdleWait;

    const issueRow = host.db.listIssues().find((i) => i.id === issueId)!;
    assert.equal(issueRow.status, "open");
    assert.ok(issueRow.needs_input_question);

    // Owner reply in issue room bypasses SubQ Snap -> worker commits READY -> implicit check FAILS with NO auto-retry!
    const decisionsBefore = host.db.listDecisions(issueConvId).length;
    const checkFailedWait = alice.waitForNextFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.checks_status === "failed",
      25_000,
    );
    const workerIdle1 = alice.waitForNextFrame(
      (f) => f.type === "session.update" && f.session?.id === workerId && f.session?.status === "idle",
      25_000,
    );

    await alice.request("message.send", {
      conversation_id: issueConvId,
      body: "Go ahead with PASS",
    });

    await workerIdle1;
    const failedEv = await checkFailedWait;
    assert.equal(failedEv.issue.status, "open");
    assert.equal(failedEv.issue.commits_ahead, 1);
    assert.ok(failedEv.issue.checks_artifact_id, "Failing implicit check must attach log artifact");
    assert.equal(host.db.listDecisions(issueConvId).length, decisionsBefore, "needs_input owner reply must bypass SubQ Snap");

    const turnsAfterFail = workerTurns;
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(workerTurns, turnsAfterFail, "Failing implicit check must NEVER auto-retry the implementer");

    // Push upstream commit -> issue.open detects behind_main -> issue.sync_main rebases cleanly
    const hostBareRepo = join(dataDir, "repo.git");
    await seedRepoCommit(
      hostBareRepo,
      repo.defaultBranch,
      [{ path: "upstream.txt", content: "upstream change\n" }],
      "Upstream commit",
    );

    const openBehind = await alice.request<{ issue: { behind_main: number } }>("issue.open", {
      issue_id: issueId,
    });
    assert.equal(openBehind.issue.behind_main, 1);

    const synced = await alice.request<{
      ok: boolean;
      behind_before: number;
      behind_after: number;
      issue: { behind_main: number };
    }>("issue.sync_main", { issue_id: issueId });
    assert.equal(synced.ok, true);
    assert.equal(synced.behind_before, 1);
    assert.equal(synced.behind_after, 0);
    assert.equal(synced.issue.behind_main, 0);

    // Human asks @kawan to fix ready.txt -> routes directly to worker -> commits PASS -> implicit check passes!
    const checkPassedWait = alice.waitForNextFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.checks_status === "passed",
      25_000,
    );
    await alice.request("message.send", {
      conversation_id: issueConvId,
      body: "@kawan please update ready.txt to PASS",
    });
    const passedEv = await checkPassedWait;
    assert.equal(passedEv.issue.status, "open");
    assert.equal(passedEv.issue.checks_status, "passed");

    // One-click issue.propose -> proposal in #merge-queue -> land.merge lands cleanly
    const proposedRes = await alice.request<{
      land: { id: string; issue_id: string; status: string };
      message: { id: string; conversation_id: string };
      created: boolean;
    }>("issue.propose", { issue_id: issueId });
    assert.equal(proposedRes.land.issue_id, issueId);
    assert.equal(proposedRes.land.status, "proposed");
    assert.equal(proposedRes.created, true);
    assert.equal(host.db.getLand(proposedRes.land.id)!.message_id, proposedRes.message.id);

    const landedIssueWait = alice.waitForNextFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.status === "landed",
      25_000,
    );
    const mergedRes = await alice.request<{ land: { status: string } }>("land.merge", {
      land_id: proposedRes.land.id,
    });
    assert.equal(mergedRes.land.status, "landed");
    await landedIssueWait;

    const landedContent = await git(["show", `refs/heads/${repo.defaultBranch}:ready.txt`], hostBareRepo);
    assert.equal(landedContent, "PASS");
  } finally {
    await alice?.close();
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
    repo.cleanup();
    adminKey.cleanup();
    await stub.close();
  }
});

test("Slice C: Promote to Issue, Stop, and Abandon/Close", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({ "README.md": "# Promote & Escape Repo\n" });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceC-promote-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    const lastUserText = JSON.stringify(
      [...msgs].reverse().find((m: any) => m.role === "user")?.content ?? "",
    );

    if (sysText.includes("AI engineering orchestrator")) {
      if (lastUserText.includes("[worker-report")) {
        return { text: "Prepared adhoc.txt for review." };
      }
      if (lastMsg?.role !== "tool") {
        return {
          toolCalls: [
            {
              name: "spawn_session",
              arguments: {
                title: "Ad-hoc change",
                task: "Write adhoc.txt, commit it, attach report, and call propose_merge.",
              },
            },
          ],
        };
      }
      return { text: "On it." };
    }

    const toolCount = msgs.filter((m: any) => m.role === "tool").length;
    if (toolCount === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: { command: "printf 'adhoc\\n' > adhoc.txt && git add adhoc.txt && git commit -m 'Add adhoc.txt'" },
          },
        ],
      };
    }
    if (toolCount === 1) {
      return {
        toolCalls: [
          {
            name: "report",
            arguments: {
              text: "Committed adhoc.txt",
              artifacts: [{ filename: "adhoc-report.txt", mime_type: "text/plain", content: "adhoc\n" }],
            },
          },
        ],
      };
    }
    if (toolCount === 2) {
      return { toolCalls: [{ name: "propose_merge", arguments: { summary_md: "Added adhoc.txt for the promote flow." } }] };
    }
    return { text: "Done." };
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
    const botRes = await alice.request<{ bot: { id: string } }>("bot.create", {
      name: "kawan",
      persona: "Orchestrator",
      sandbox_enabled: false,
    });
    await alice.request("conversation.add_member", { conversation_id: generalId, user_id: botRes.bot.id });

    const landWait = alice.waitForFrame((f) => f.type === "land.update" && f.land?.status === "proposed", 25_000);
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan add adhoc.txt now" });
    const landFrame = await landWait;
    const workerId = landFrame.land.session_id as string;
    const workerBefore = host.db.getSession(workerId)!;
    assert.ok(workerBefore.clone_path && existsSync(workerBefore.clone_path));

    // Promote to Issue
    const promoted = await alice.request<{
      issue: { id: string; number: number; status: string; active_session_id: string; commits_ahead: number };
      conversation: { id: string; kind: string };
    }>("issue.promote", { session_id: workerId, title: "Promoted adhoc feature" });
    assert.equal(promoted.issue.number, 1);
    assert.equal(promoted.issue.status, "open");
    assert.equal(promoted.issue.commits_ahead, 1);
    assert.equal(promoted.issue.active_session_id, workerId);
    assert.equal(promoted.conversation.kind, "issue");

    // Promoted issue room sees pre-existing worker artifacts
    const opened = await alice.request<{ artifacts: Array<{ filename: string | null }> }>("issue.open", {
      issue_id: promoted.issue.id,
    });
    assert.ok(opened.artifacts.some((a) => a.filename === "adhoc-report.txt"));

    // Stop preserves clone
    await alice.request("issue.stop", { issue_id: promoted.issue.id });
    assert.equal(existsSync(workerBefore.clone_path!), true);

    // Abandon / close reaps clone and marks closed
    const closed = await alice.request<{ issue: { status: string } }>("issue.close", {
      issue_id: promoted.issue.id,
      abandon: true,
    });
    assert.equal(closed.issue.status, "closed");
    assert.equal(existsSync(workerBefore.clone_path!), false);
  } finally {
    await alice?.close();
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
    repo.cleanup();
    adminKey.cleanup();
    await stub.close();
  }
});

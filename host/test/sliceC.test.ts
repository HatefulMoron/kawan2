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

test("Slice C: orchestrator create_issue / update_issue / list_issues & issue.open / issue.update", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({ "README.md": "# Issue Authoring\n" });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceC-author-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    if (sysText.includes("AI engineering orchestrator")) {
      if (lastMsg?.role !== "tool") {
        return {
          toolCalls: [
            {
              name: "create_issue",
              arguments: {
                title: "Add caching layer",
                body_md: "## Goal\nInitial caching spec.",
              },
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
              arguments: {
                issue_ref: "#1",
                body_md: "## Goal\nUpdated caching spec with LRU eviction.",
              },
            },
          ],
        };
      }
      if (toolResults.length === 2) {
        return { toolCalls: [{ name: "list_issues", arguments: {} }] };
      }
      return { text: "Created Issue #1 and updated its specification." };
    }
    return { text: "ok" };
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

    const listed = await alice.request<{ issues: Array<{ id: string; number: number; title: string; body_md: string; conversation_id: string }> }>(
      "issue.list",
    );
    assert.equal(listed.issues.length, 1);
    const issue1 = listed.issues[0];
    assert.equal(issue1.title, "Add caching layer");
    assert.ok(issue1.body_md.includes("LRU eviction"));

    const opened = await alice.request<{
      issue: { id: string; number: number };
      conversation: { kind: string; name: string };
    }>("issue.open", { issue_id: issue1.id });
    assert.equal(opened.conversation.kind, "issue");
    assert.equal(opened.conversation.name, "issue-1");

    const updated = await alice.request<{ issue: { body_md: string } }>("issue.update", {
      issue_id: issue1.id,
      body_md: "## Goal\nHuman-edited markdown spec.",
    });
    assert.equal(updated.issue.body_md, "## Goal\nHuman-edited markdown spec.");
  } finally {
    await alice?.close();
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
    repo.cleanup();
    adminKey.cleanup();
    await stub.close();
  }
});

test("Slice C: collaborative issue, ask_owner resume, sync_main, start_review (fail -> fix -> pass), land", async () => {
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

  let stage: "ask" | "draft_ready" | "fix_pass" = "ask";

  stub.setHandler((reqBody) => {
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    const hasToolResult = lastMsg?.role === "tool";

    if (stage === "ask") {
      if (!hasToolResult) {
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
      const toolCallsSinceAnswer = msgs
        .slice(msgs.map((m: any) => m.role).lastIndexOf("user"))
        .filter((m: any) => m.role === "tool").length;
      if (toolCallsSinceAnswer === 0) {
        return {
          toolCalls: [
            {
              name: "bash",
              arguments: { command: "printf 'READY\\n' > ready.txt && git add ready.txt && git commit -m 'Draft ready.txt'" },
            },
          ],
        };
      }
      if (toolCallsSinceAnswer === 1) {
        return {
          toolCalls: [
            {
              name: "report",
              arguments: {
                text: "First draft ready for check",
                artifact: { filename: "notes.txt", mime_type: "text/plain", content: "wrote READY\n" },
              },
            },
          ],
        };
      }
      stage = "fix_pass";
      return { text: "NO_REPLY" };
    }

    // stage === "fix_pass"
    const toolCallsSinceFail = msgs
      .slice(msgs.map((m: any) => m.role).lastIndexOf("user"))
      .filter((m: any) => m.role === "tool").length;
    if (toolCallsSinceFail === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: { command: "printf 'PASS\\n' > ready.txt && git add ready.txt && git commit -m 'Set ready.txt to PASS'" },
          },
        ],
      };
    }
    if (toolCallsSinceFail === 1) {
      return {
        toolCalls: [
          {
            name: "report",
            arguments: { text: "Fixed ready.txt to PASS and committed." },
          },
        ],
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

    const created = await alice.request<{ issue: { id: string; number: number; conversation_id: string } }>(
      "issue.create",
      { title: "Configure ready sentinel", body_md: "Write ready.txt cleanly." },
    );
    const issueId = created.issue.id;
    const issueConvId = created.issue.conversation_id;

    // Assign & run -> worker calls ask_owner -> enters needs_input
    const needsInputWait = alice.waitForNextFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.status === "needs_input",
      20_000,
    );
    const askIdleWait = alice.waitForNextFrame(
      (f) => f.type === "session.update" && f.session?.kind === "worker" && f.session?.status === "idle",
      20_000,
    );
    const assigned = await alice.request<{ session: { id: string } }>("issue.assign", {
      issue_id: issueId,
      implementer_bot_id: botRes.bot.id,
    });
    const workerId = assigned.session.id;

    const niEv = await needsInputWait;
    assert.equal(niEv.issue.needs_input_question, "Should ready.txt say PASS or READY?");
    await askIdleWait;

    const statusRes = await alice.request<{ issues: Array<{ id: string; status: string }> }>("status.read");
    assert.ok(statusRes.issues.some((i) => i.id === issueId && i.status === "needs_input"));

    // Owner reply in issue room bypasses SubQ Snap and resumes persistent worker
    const decisionsBefore = host.db.listDecisions(issueConvId).length;
    const draftMsgWait = alice.waitForNextFrame(
      (f) =>
        f.type === "message.new" &&
        f.message?.conversation_id === issueConvId &&
        String(f.message?.body).includes("First draft ready for check"),
      25_000,
    );
    const workerIdle1 = alice.waitForNextFrame(
      (f) =>
        f.type === "session.update" &&
        f.session?.id === workerId &&
        f.session?.status === "idle",
      25_000,
    );

    await alice.request("message.send", {
      conversation_id: issueConvId,
      body: "Go ahead with PASS",
    });

    const draftMsg = await draftMsgWait;
    assert.ok(draftMsg.message.artifact_id, "worker report() artifact must appear directly in issue room");
    await workerIdle1;
    assert.equal(host.db.listDecisions(issueConvId).length, decisionsBefore, "needs_input owner reply must bypass SubQ Snap");

    // Push unrelated commit to host bare repo -> issue.open detects behind_main -> issue.sync_main rebases cleanly
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

    // Start Review Cycle -> fails .kawan/checks -> auto-resumes worker -> worker fixes to PASS
    const fixedMsgWait = alice.waitForNextFrame(
      (f) =>
        f.type === "message.new" &&
        f.message?.conversation_id === issueConvId &&
        String(f.message?.body).includes("Fixed ready.txt to PASS"),
      25_000,
    );
    const workerIdle2 = alice.waitForNextFrame(
      (f) =>
        f.type === "session.update" &&
        f.session?.id === workerId &&
        f.session?.status === "idle",
      25_000,
    );
    const reviewFail = await alice.request<{ ok: boolean; issue: { status: string } }>(
      "issue.start_review",
      { issue_id: issueId },
    );
    assert.equal(reviewFail.ok, false);
    assert.equal(reviewFail.issue.status, "implementing");

    await fixedMsgWait;
    await workerIdle2;

    // Second Start Review Cycle passes -> ready_to_land -> land.approve -> landed
    const reviewPass = await alice.request<{
      ok: boolean;
      issue: { status: string };
      land: { id: string; issue_id: string };
    }>("issue.start_review", { issue_id: issueId });
    assert.equal(reviewPass.ok, true);
    assert.equal(reviewPass.issue.status, "ready_to_land");
    assert.equal(reviewPass.land.issue_id, issueId);

    const landedIssueWait = alice.waitForFrame(
      (f) => f.type === "issue.update" && f.issue?.id === issueId && f.issue?.status === "landed",
      25_000,
    );
    await alice.request("land.approve", { land_id: reviewPass.land.id, async: true });
    await landedIssueWait;
  } finally {
    await alice?.close();
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
    repo.cleanup();
    adminKey.cleanup();
    await stub.close();
  }
});

test("Slice C: Promote to Issue, Return to Collaborate, Stop, and Abandon/Close", async () => {
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
                task: "Write adhoc.txt, commit it, attach report, and call land_request.",
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
              artifact: { filename: "adhoc-report.txt", mime_type: "text/plain", content: "adhoc\n" },
            },
          },
        ],
      };
    }
    if (toolCount === 2) {
      return {
        toolCalls: [{ name: "land_request", arguments: { summary: "adhoc ready" } }],
      };
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

    const landWait = alice.waitForFrame((f) => f.type === "land.update" && f.land?.status === "requested", 25_000);
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan add adhoc.txt now" });
    const landFrame = await landWait;
    const workerId = landFrame.land.session_id as string;
    const workerBefore = host.db.getSession(workerId)!;
    assert.ok(workerBefore.clone_path && existsSync(workerBefore.clone_path));

    // Promote to Issue
    const promoted = await alice.request<{
      issue: { id: string; number: number; status: string; active_session_id: string };
      conversation: { id: string; kind: string };
    }>("issue.promote", { session_id: workerId, title: "Promoted adhoc feature" });
    assert.equal(promoted.issue.number, 1);
    assert.equal(promoted.issue.status, "ready_to_land");
    assert.equal(promoted.issue.active_session_id, workerId);
    assert.equal(promoted.conversation.kind, "issue");

    // Promoted issue room sees pre-existing worker artifacts
    const opened = await alice.request<{ artifacts: Array<{ filename: string | null }> }>("issue.open", {
      issue_id: promoted.issue.id,
    });
    assert.ok(opened.artifacts.some((a) => a.filename === "adhoc-report.txt"));

    // Return to Collaborate drops ready_to_land -> implementing
    const returned = await alice.request<{ issue: { status: string } }>("issue.return_to_collaborate", {
      issue_id: promoted.issue.id,
    });
    assert.equal(returned.issue.status, "implementing");

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

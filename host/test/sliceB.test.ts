import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DecisionMode } from "../src/decisions.js";
import { branchTouchesKawanDir, runRepoChecks } from "../src/git.js";
import { startHost } from "../src/server.js";
import { createFixtureBareRepo, TestKeyPair, WsTestClient } from "./helpers.js";
import { startStubProvider } from "./stub-provider.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function seedExecutableFilesInRepo(
  barePath: string,
  defaultBranch: string,
  files: Array<{ path: string; content: string; executable?: boolean }>,
  commitMessage = "Add repo checks",
): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "kawan-seed-repo-"));
  try {
    await git(["clone", "--branch", defaultBranch, barePath, work]);
    await git(["config", "user.name", "Repo Admin"], work);
    await git(["config", "user.email", "admin@kawan.local"], work);
    for (const f of files) {
      const full = join(work, f.path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, f.content, "utf8");
      if (f.executable) {
        chmodSync(full, 0o755);
      }
      await git(["add", f.path], work);
    }
    await git(["commit", "-m", commitMessage], work);
    await git(["push", "origin", defaultBranch], work);
    return await git(["rev-parse", "HEAD"], work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("Slice B unit: .kawan/checks/* priority, ordering, fallback, and touches_kawan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kawan-checks-unit-"));
  try {
    mkdirSync(join(dir, ".kawan", "checks"), { recursive: true });
    const c2 = join(dir, ".kawan", "checks", "02-second.sh");
    const c1 = join(dir, ".kawan", "checks", "01-first.sh");
    const nonExec = join(dir, ".kawan", "checks", "03-ignored.sh");
    writeFileSync(c1, "#!/bin/sh\necho first-ok\n");
    writeFileSync(c2, "#!/bin/sh\necho second-ok\n");
    writeFileSync(nonExec, "#!/bin/sh\nexit 99\n");
    chmodSync(c1, 0o755);
    chmodSync(c2, 0o755);

    const passRes = await runRepoChecks({
      workdir: dir,
      verifyCommand: "false",
      sandboxEnabled: false,
      disableSandbox: true,
    });
    assert.equal(passRes.ok, true);
    assert.equal(passRes.source, "kawan_checks");
    assert.deepEqual(
      passRes.checks.map((c) => c.name),
      ["01-first.sh", "02-second.sh"],
    );
    assert.ok(passRes.checks.every((c) => c.ok));

    // Failing check in .kawan/checks/*
    writeFileSync(c2, "#!/bin/sh\necho second-boom >&2\nexit 2\n");
    const failRes = await runRepoChecks({
      workdir: dir,
      sandboxEnabled: false,
      disableSandbox: true,
    });
    assert.equal(failRes.ok, false);
    assert.equal(failRes.checks[0].ok, true);
    assert.equal(failRes.checks[1].ok, false);
    assert.equal(failRes.checks[1].exit_code, 2);
    assert.ok(failRes.combined_output.includes("second-boom"));

    // Fallback to .kawan/ci when no executable checks exist
    rmSync(join(dir, ".kawan", "checks"), { recursive: true, force: true });
    const ciPath = join(dir, ".kawan", "ci");
    writeFileSync(ciPath, "#!/bin/sh\necho ci-fallback\n");
    chmodSync(ciPath, 0o755);
    const ciRes = await runRepoChecks({
      workdir: dir,
      verifyCommand: "false",
      sandboxEnabled: false,
      disableSandbox: true,
    });
    assert.equal(ciRes.ok, true);
    assert.equal(ciRes.source, "kawan_ci");
    assert.equal(ciRes.checks[0].name, "ci");

    // Fallback to verify_command when neither .kawan/checks/* nor .kawan/ci exists
    rmSync(ciPath, { force: true });
    const verifyRes = await runRepoChecks({
      workdir: dir,
      verifyCommand: "echo verify-fallback",
      sandboxEnabled: false,
      disableSandbox: true,
    });
    assert.equal(verifyRes.ok, true);
    assert.equal(verifyRes.source, "verify_command");
    assert.equal(verifyRes.checks[0].name, "verify");

    // branchTouchesKawanDir detection
    await git(["init", "-b", "main"], dir);
    await git(["config", "user.name", "Test"], dir);
    await git(["config", "user.email", "test@kawan.local"], dir);
    writeFileSync(join(dir, "README.md"), "# hi\n");
    await git(["add", "README.md"], dir);
    await git(["commit", "-m", "init"], dir);
    const baseSha = await git(["rev-parse", "HEAD"], dir);

    writeFileSync(join(dir, "app.txt"), "ok\n");
    await git(["add", "app.txt"], dir);
    await git(["commit", "-m", "app change"], dir);
    assert.equal(await branchTouchesKawanDir(dir, baseSha), false);

    mkdirSync(join(dir, ".kawan"), { recursive: true });
    writeFileSync(join(dir, ".kawan", "ci"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, ".kawan", "ci"), 0o755);
    await git(["add", ".kawan/ci"], dir);
    await git(["commit", "-m", "add ci"], dir);
    assert.equal(await branchTouchesKawanDir(dir, baseSha), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Slice B: serialized FIFO merge queue fast-path + .kawan/checks + touches_kawan", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({
    "README.md": "# Merge Queue Repo\n",
  });
  await seedExecutableFilesInRepo(repo.barePath, repo.defaultBranch, [
    { path: ".kawan/checks/01-lint.sh", content: "#!/bin/sh\ntest -f README.md\n", executable: true },
    { path: ".kawan/checks/02-test.sh", content: "#!/bin/sh\necho all-good\n", executable: true },
  ]);

  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceB-fifo-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

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
        return { text: "Ready to review and land." };
      }
      if (!hasToolResult) {
        const isSecond = lastUserText.includes("TASK_TWO");
        const isKawan = lastUserText.includes("TASK_KAWAN");
        return {
          toolCalls: [
            {
              name: "spawn_session",
              arguments: {
                title: isKawan ? "Update check script" : isSecond ? "Add two.txt" : "Add one.txt",
                task: isKawan
                  ? "Add executable .kawan/checks/03-extra.sh, commit it, and call land_request."
                  : isSecond
                    ? "Create two.txt containing 'two', commit it, and call land_request."
                    : "Create one.txt containing 'one', commit it, and call land_request.",
              },
            },
          ],
        };
      }
      return { text: "On it." };
    }

    // Worker turns
    const toolCount = msgs.filter((m: any) => m.role === "tool").length;
    if (toolCount === 0) {
      const fullTask = JSON.stringify(msgs);
      const cmd = fullTask.includes("03-extra.sh")
        ? "printf '#!/bin/sh\\necho extra\\n' > .kawan/checks/03-extra.sh && chmod +x .kawan/checks/03-extra.sh && git add .kawan/checks/03-extra.sh && git commit -m 'Add extra check'"
        : fullTask.includes("two.txt")
          ? "printf 'two\\n' > two.txt && git add two.txt && git commit -m 'Add two.txt'"
          : "printf 'one\\n' > one.txt && git add one.txt && git commit -m 'Add one.txt'";
      return {
        toolCalls: [{ name: "bash", arguments: { command: cmd } }],
      };
    }
    if (toolCount === 1) {
      return {
        toolCalls: [{ name: "land_request", arguments: { summary: "Committed changes cleanly." } }],
      };
    }
    return { text: "Done." };
  });

  const host = await startHost({ dataDir, quiet: true, decisionMode, disableSandbox: true });
  let alice: WsTestClient | null = null;
  try {
    alice = await WsTestClient.connect(host.url);
    await alice.bootstrap(host.bootstrapToken!, "alice", adminKey);

    const convs0 = await alice.request<{
      conversations: Array<{ id: string; kind: string; name: string }>;
    }>("conversation.list");
    const generalId = convs0.conversations.find((c) => c.name === "general")!.id;
    const mqConv = convs0.conversations.find((c) => c.kind === "merge_queue")!;
    assert.ok(mqConv, "#merge-queue conversation should exist on bootstrap");
    assert.equal(mqConv.name, "merge-queue");

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

    // Create two non-conflicting land requests
    const l1Wait = alice.waitForFrame((f) => f.type === "land.update" && f.land?.status === "requested", 25_000);
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan do TASK_ONE please" });
    const l1Id = (await l1Wait).land.id as string;

    const l2Wait = alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.status === "requested" && f.land?.id !== l1Id,
      25_000,
    );
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan do TASK_TWO please" });
    const l2Id = (await l2Wait).land.id as string;

    // Enqueue both concurrently with async: true and wait for both to land sequentially
    const landed1 = alice.waitForFrame((f) => f.type === "land.update" && f.land?.id === l1Id && f.land?.status === "landed", 25_000);
    const landed2 = alice.waitForFrame((f) => f.type === "land.update" && f.land?.id === l2Id && f.land?.status === "landed", 25_000);
    const [res1, res2] = await Promise.all([
      alice.request<{ land: { id: string; status: string } }>("land.approve", { land_id: l1Id, async: true }),
      alice.request<{ land: { id: string; status: string } }>("land.approve", { land_id: l2Id, async: true }),
    ]);
    assert.ok(["queued", "rebasing", "verifying", "landed"].includes(res1.land.status));
    assert.ok(["queued", "rebasing", "verifying", "landed"].includes(res2.land.status));

    const [ev1, ev2] = await Promise.all([landed1, landed2]);
    assert.deepEqual(
      ev1.land.checks.map((c: any) => c.name),
      ["01-lint.sh", "02-test.sh"],
    );
    assert.equal(ev1.land.touches_kawan, false);
    assert.equal(ev2.land.touches_kawan, false);

    // Fast path posts zero messages in #merge-queue
    const mqOpen = await alice.request<{ messages: any[] }>("conversation.open", { conversation_id: mqConv.id });
    assert.equal(mqOpen.messages.length, 0, "Fast path must not clutter #merge-queue");

    const mqSnap = await alice.request<{ queue: { queued: any[]; recent_landed: any[]; settings: { paused: boolean } } }>(
      "merge_queue.read",
    );
    assert.equal(mqSnap.queue.queued.length, 0);
    assert.equal(mqSnap.queue.settings.paused, false);
    assert.equal(mqSnap.queue.recent_landed.length, 2);

    // Worker touching .kawan/checks/* sets touches_kawan = true
    const l3Wait = alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.status === "requested" && f.land?.id !== l1Id && f.land?.id !== l2Id,
      25_000,
    );
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan do TASK_KAWAN please" });
    const l3Id = (await l3Wait).land.id as string;
    const settled3 = await alice.request<{ land: { touches_kawan: boolean; status: string } }>("land.approve", {
      land_id: l3Id,
    });
    assert.equal(settled3.land.status, "landed");
    assert.equal(settled3.land.touches_kawan, true);
  } finally {
    await alice?.close();
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
    repo.cleanup();
    adminKey.cleanup();
    await stub.close();
  }
});

test("Slice B: merge queue friction pause -> #merge-queue Queue Bot reconcile -> resume_and_land + remove/eject", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({
    "README.md": "# Friction Repo\n",
  });
  await seedExecutableFilesInRepo(repo.barePath, repo.defaultBranch, [
    {
      path: ".kawan/checks/01-status.sh",
      content: "#!/bin/sh\ngrep -q '^GOOD$' status.txt\n",
      executable: true,
    },
  ]);

  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceB-friction-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    const hasToolResult = lastMsg?.role === "tool";
    const lastUserText = JSON.stringify(
      [...msgs].reverse().find((m: any) => m.role === "user")?.content ?? "",
    );

    if (sysText.includes("Merge Queue Bot")) {
      const alreadyLanded = msgs.some(
        (m: any) => m.role === "tool" && String(m.content ?? "").includes("landed_sha"),
      );
      if (alreadyLanded) {
        return { text: "Reconciled and landed cleanly." };
      }
      if (lastUserText.includes("FIX_STATUS_NOW")) {
        const lastIsBash =
          lastMsg?.role === "tool" && String(lastMsg?.content ?? "").includes("FIXED_SENTINEL");
        if (!lastIsBash) {
          return {
            toolCalls: [
              {
                name: "bash",
                arguments: {
                  command:
                    "printf 'GOOD\\n' > status.txt && git add status.txt && git commit -m 'Fix status.txt' && echo FIXED_SENTINEL",
                },
              },
            ],
          };
        }
        return {
          toolCalls: [
            {
              name: "resume_and_land",
              arguments: { summary: "Updated status.txt to GOOD per human instruction." },
            },
          ],
        };
      }
      if (lastMsg?.role === "tool") {
        return { text: "Reconciled and landed cleanly." };
      }
      return {
        text: "01-status.sh failed because status.txt does not contain GOOD. Reply to fix status.txt or send back.",
      };
    }

    if (sysText.includes("AI engineering orchestrator")) {
      if (lastUserText.includes("[worker-report")) {
        return { text: "Worker finished." };
      }
      if (!hasToolResult) {
        const isSecond = lastUserText.includes("QUEUE_TWO");
        const isEject = lastUserText.includes("QUEUE_EJECT");
        return {
          toolCalls: [
            {
              name: "spawn_session",
              arguments: {
                title: isEject ? "Failing eject task" : isSecond ? "Good second task" : "Bad status task",
                task: isEject
                  ? "Write BAD into status.txt, commit it, and call land_request."
                  : isSecond
                    ? "Write unrelated ok.txt without touching status.txt, commit it, and call land_request."
                    : "Write BAD into status.txt, commit it, and call land_request.",
              },
            },
          ],
        };
      }
      return { text: "On it." };
    }

    // Worker turns
    const toolCount = msgs.filter((m: any) => m.role === "tool").length;
    if (toolCount === 0) {
      const fullTask = JSON.stringify(msgs);
      const cmd = fullTask.includes("ok.txt")
        ? "printf 'ok\\n' > ok.txt && git add ok.txt && git commit -m 'Add ok.txt'"
        : "printf 'BAD\\n' > status.txt && git add status.txt && git commit -m 'Write BAD status'";
      return { toolCalls: [{ name: "bash", arguments: { command: cmd } }] };
    }
    if (toolCount === 1) {
      return { toolCalls: [{ name: "land_request", arguments: { summary: "Ready." } }] };
    }
    return { text: "Done." };
  });

  const host = await startHost({ dataDir, quiet: true, decisionMode, disableSandbox: true });
  let alice: WsTestClient | null = null;
  try {
    alice = await WsTestClient.connect(host.url);
    await alice.bootstrap(host.bootstrapToken!, "alice", adminKey);

    const convs = await alice.request<{ conversations: Array<{ id: string; kind: string; name: string }> }>(
      "conversation.list",
    );
    const generalId = convs.conversations.find((c) => c.name === "general")!.id;
    const mqId = convs.conversations.find((c) => c.kind === "merge_queue")!.id;

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

    // Spawn bad task 1 + clean task 2
    const l1Wait = alice.waitForFrame((f) => f.type === "land.update" && f.land?.status === "requested", 25_000);
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan run QUEUE_ONE" });
    const l1Id = (await l1Wait).land.id as string;

    const l2Wait = alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.status === "requested" && f.land?.id !== l1Id,
      25_000,
    );
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan run QUEUE_TWO" });
    const l2Id = (await l2Wait).land.id as string;

    // Approve both -> l1 pauses on check failure, l2 remains queued, Queue Bot diagnoses in #merge-queue
    const pausedWait = alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.id === l1Id && f.land?.status === "paused",
      25_000,
    );
    const botDiagnosisWait = alice.waitForFrame(
      (f) =>
        f.type === "message.new" &&
        f.message?.conversation_id === mqId &&
        typeof f.message?.thread_id === "string" &&
        f.author?.kind === "bot",
      25_000,
    );

    await Promise.all([
      alice.request("land.approve", { land_id: l1Id, async: true }),
      alice.request("land.approve", { land_id: l2Id, async: true }),
    ]);

    const pausedEv = await pausedWait;
    assert.equal(pausedEv.land.pause_reason, "checks_failed");
    assert.ok(pausedEv.land.queue_thread_id);
    const qThreadId = pausedEv.land.queue_thread_id as string;

    const diagMsg = await botDiagnosisWait;
    assert.equal(diagMsg.message.thread_id, qThreadId);

    const mqSnapPaused = await alice.request<{ queue: { settings: { paused: boolean }; queued: any[] } }>("merge_queue.read");
    assert.equal(mqSnapPaused.queue.settings.paused, true);
    assert.equal(mqSnapPaused.queue.queued.length, 2);

    // Send human instruction into #merge-queue thread: must bypass decision model and route directly to Queue Bot
    const decisionsBefore = host.db.listDecisions(mqId).length;
    const land1Done = alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.id === l1Id && f.land?.status === "landed",
      25_000,
    );
    const land2Done = alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.id === l2Id && f.land?.status === "landed",
      25_000,
    );
    await alice.request("message.send", {
      conversation_id: mqId,
      thread_id: qThreadId,
      body: "FIX_STATUS_NOW please update status.txt and land",
    });

    await Promise.all([land1Done, land2Done]);
    const decisionsAfter = host.db.listDecisions(mqId).length;
    assert.equal(decisionsAfter, decisionsBefore, "#merge-queue reply must not call route_message");

    // Test merge_queue.pause / merge_queue.remove / merge_queue.eject
    const l3Wait = alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.status === "requested" && f.land?.id !== l1Id && f.land?.id !== l2Id,
      25_000,
    );
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan run QUEUE_EJECT" });
    const l3Frame = await l3Wait;
    const l3Id = l3Frame.land.id as string;
    const l3SessionId = l3Frame.land.session_id as string;

    await alice.request("merge_queue.pause");
    const queuedWhilePaused = await alice.request<{ land: { status: string } }>("land.approve", {
      land_id: l3Id,
      async: true,
    });
    assert.equal(queuedWhilePaused.land.status, "queued");

    const afterRemove = await alice.request<{ queue: { queued: any[] } }>("merge_queue.remove", {
      land_id: l3Id,
    });
    assert.equal(afterRemove.queue.queued.length, 0);
    assert.equal(host.db.getLand(l3Id)!.status, "requested");

    // Unpause queue and re-approve l3 -> pause -> eject back to implementer
    await alice.request("merge_queue.resume");
    const l3Paused = alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.id === l3Id && f.land?.status === "paused",
      25_000,
    );
    await alice.request("land.approve", { land_id: l3Id, async: true });
    await l3Paused;

    const afterEject = await alice.request<{ queue: { settings: { paused: boolean }; queued: any[] } }>(
      "merge_queue.eject",
      { land_id: l3Id, reason: "Implementer needs to fix status.txt" },
    );
    assert.equal(afterEject.queue.settings.paused, false);
    assert.equal(afterEject.queue.queued.length, 0);
    assert.equal(host.db.getLand(l3Id)!.status, "failed");
    assert.equal(host.db.getSession(l3SessionId)!.status, "idle");
  } finally {
    await alice?.close();
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
    repo.cleanup();
    adminKey.cleanup();
    await stub.close();
  }
});

test("Slice B: 3-way spawn-intent gate (no/no block, no/yes dismiss & confirm, yes/yes stop)", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({
    "README.md": "# Spawn Gate Repo\n",
  });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceB-gate-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");

  let gateAnswer: { explicit: "yes" | "no"; req: "yes" | "no" } = { explicit: "no", req: "no" };
  let capturedPromptsAfterDismiss: string[] = [];

  stub.setSystemOneHandler(() => ({
    status: 200,
    body: {
      model: "stub-snap",
      answers: {
        destination: { type: "choice", choice: "orchestrator", confidence: 0.99, probabilities: { orchestrator: 0.99, none: 0.01 } },
        readiness: { type: "choice", choice: "dispatch", confidence: 0.99, probabilities: { dispatch: 0.99, hold: 0.01 } },
        explicit_work_start: {
          type: "choice",
          choice: gateAnswer.explicit,
          confidence: 0.99,
          probabilities: { yes: gateAnswer.explicit === "yes" ? 0.99 : 0.01, no: gateAnswer.explicit === "no" ? 0.99 : 0.01 },
        },
        work_request: {
          type: "choice",
          choice: gateAnswer.req,
          confidence: 0.99,
          probabilities: { yes: gateAnswer.req === "yes" ? 0.99 : 0.01, no: gateAnswer.req === "no" ? 0.99 : 0.01 },
        },
      },
    },
  }));

  stub.setHandler((reqBody) => {
    const sysText = JSON.stringify(reqBody.messages?.[0] ?? "");
    const msgs = reqBody.messages ?? [];
    const lastMsg = msgs[msgs.length - 1];
    const lastUserText = JSON.stringify(
      [...msgs].reverse().find((m: any) => m.role === "user")?.content ?? "",
    );

    if (sysText.includes("AI engineering orchestrator")) {
      if (lastUserText.includes("dismissed your proposed task")) {
        capturedPromptsAfterDismiss.push(lastUserText);
      }
      if (lastUserText.includes("[worker-report")) {
        return { text: "Confirmed worker completed." };
      }
      if (lastMsg?.role === "tool") {
        const toolOut = String(lastMsg?.content ?? "");
        if (toolOut.includes("Blocked: the user has not asked")) {
          return { text: "Got it, just answering conversationally without spawning work." };
        }
        if (toolOut.includes("Proposal card created")) {
          return { text: "I prepared a task proposal — click Start or Dismiss." };
        }
        return { text: "Started immediately." };
      }
      return {
        toolCalls: [
          {
            name: "spawn_session",
            arguments: {
              title: "Create gate.txt",
              task: "Create gate.txt containing 'ok', commit it, and call report.",
            },
          },
        ],
      };
    }

    // Worker turns
    const toolCount = msgs.filter((m: any) => m.role === "tool").length;
    if (toolCount === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: { command: "printf 'ok\\n' > gate.txt && git add gate.txt && git commit -m 'Add gate.txt'" },
          },
        ],
      };
    }
    if (toolCount === 1) {
      return {
        toolCalls: [{ name: "report", arguments: { text: "Committed gate.txt." } }],
      };
    }
    return { text: "Done." };
  });

  const host = await startHost({ dataDir, quiet: true, decisionMode, disableSandbox: true });
  let alice: WsTestClient | null = null;
  try {
    alice = await WsTestClient.connect(host.url);
    await alice.bootstrap(host.bootstrapToken!, "alice", adminKey);
    const convs = await alice.request<{ conversations: Array<{ id: string; name: string }> }>("conversation.list");
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

    // 1. (no, no): spawn_session blocked cleanly
    gateAnswer = { explicit: "no", req: "no" };
    const convReplyWait = alice.waitForFrame(
      (f) => f.type === "message.new" && f.author?.kind === "bot" && String(f.message?.body).includes("conversationally"),
      15_000,
    );
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan how does cloning work?" });
    await convReplyWait;
    assert.equal(host.db.listSessions({ kind: "worker" }).length, 0, "no worker session may be created on (no, no)");

    // 2. (no, yes): pending_approval with ZERO clone, then session.dismiss
    gateAnswer = { explicit: "no", req: "yes" };
    const pendingWait1 = alice.waitForFrame(
      (f) => f.type === "session.update" && f.session?.status === "pending_approval",
      15_000,
    );
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan maybe we should add gate.txt" });
    const pending1 = (await pendingWait1).session;
    assert.equal(pending1.clone_path ?? null, null);
    assert.equal(existsSync(join(dataDir, "workspaces", pending1.id)), false);

    const dismissed = await alice.request<{ session: { id: string; status: string } }>("session.dismiss", {
      session_id: pending1.id,
    });
    assert.equal(dismissed.session.status, "stopped");

    // 3. Second (no, yes) receives dismiss back-off note, then session.confirm launches worker to completion
    const pendingWait2 = alice.waitForFrame(
      (f) => f.type === "session.update" && f.session?.status === "pending_approval" && f.session?.id !== pending1.id,
      15_000,
    );
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan can you handle gate.txt later" });
    const pending2 = (await pendingWait2).session;
    assert.equal(capturedPromptsAfterDismiss.length, 1, "dismiss back-off note should be injected on next orchestrator turn");

    const workerDoneWait = alice.waitForFrame(
      (f) => f.type === "message.new" && f.author?.kind === "bot" && String(f.message?.body).includes("Confirmed worker completed"),
      25_000,
    );
    const confirmed = await alice.request<{ session: { id: string; status: string; clone_path: string } }>(
      "session.confirm",
      { session_id: pending2.id },
    );
    assert.equal(confirmed.session.status, "running");
    assert.equal(existsSync(join(dataDir, "workspaces", pending2.id)), true);
    await workerDoneWait;

    // 4. (yes, yes) spawns immediately and session.stop halts it cleanly
    gateAnswer = { explicit: "yes", req: "yes" };
    const runningWait = alice.waitForFrame(
      (f) =>
        f.type === "session.update" &&
        f.session?.kind === "worker" &&
        f.session?.status === "running" &&
        f.session?.id !== pending2.id,
      15_000,
    );
    await alice.request("message.send", { conversation_id: generalId, body: "@kawan go create gate.txt now" });
    const running3 = (await runningWait).session;
    const stopped = await alice.request<{ session: { id: string; status: string } }>("session.stop", {
      session_id: running3.id,
    });
    assert.equal(stopped.session.status, "stopped");
  } finally {
    await alice?.close();
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
    repo.cleanup();
    adminKey.cleanup();
    await stub.close();
  }
});

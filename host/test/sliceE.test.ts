import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { DecisionMode } from "../src/decisions.js";
import { createSessionClone } from "../src/git.js";
import { startHost } from "../src/server.js";
import type { SessionRow } from "../src/types.js";
import { callHostTool, createFixtureBareRepo, TestKeyPair, WsTestClient } from "./helpers.js";
import { startStubProvider } from "./stub-provider.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000 });
  return stdout.trim();
}

interface ProposalHarness {
  host: Awaited<ReturnType<typeof startHost>>;
  alice: WsTestClient;
  adminId: string;
  botId: string;
  generalId: string;
  mqId: string;
  repo: Awaited<ReturnType<typeof createFixtureBareRepo>>;
  makeWorker: (opts?: {
    title?: string;
    conversationId?: string | null;
    commits?: number;
  }) => Promise<SessionRow>;
  cleanup: () => Promise<void>;
}

async function setupProposalHost(
  opts: { landingMode?: "manual" | "auto"; verifyCommand?: string } = {},
): Promise<ProposalHarness> {
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({ "README.md": "# Proposal Fixture\n" });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceE-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");
  const decisionMode: DecisionMode = "live";

  const host = await startHost({ dataDir, quiet: true, disableSandbox: true, decisionMode });
  const alice = await WsTestClient.connect(host.url);
  await alice.bootstrap(host.bootstrapToken!, "alice", adminKey);
  const adminId = host.db.listUsers("human")[0].id;

  await alice.request("settings.update", {
    repo: { url: repo.barePath, default_branch: repo.defaultBranch },
    verify_command: opts.verifyCommand ?? "true",
    merge_queue: { default_landing_mode: opts.landingMode ?? "manual" },
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
      decision: {
        provider: "stub",
        baseUrl: stub.systemOneBaseUrl,
        model: "stub-snap",
        apiKey: "stub-key",
      },
    },
  });

  const botRes = await alice.request<{ bot: { id: string; name: string; email: string } }>(
    "bot.create",
    { name: "kawan", persona: "Orchestrator", sandbox_enabled: false },
  );
  const botId = botRes.bot.id;
  const convs = await alice.request<{ conversations: Array<{ id: string; name: string; kind: string }> }>(
    "conversation.list",
  );
  const generalId = convs.conversations.find((c) => c.name === "general")!.id;
  const mqId = convs.conversations.find((c) => c.kind === "merge_queue")!.id;

  const makeWorker: ProposalHarness["makeWorker"] = async (workerOpts = {}) => {
    const bot = host.db.getUser(botId)!;
    const settings = host.db.getHostSettings();
    const sessionId = crypto.randomUUID();
    const branch = `kawan/${sessionId}`;
    const clonePath = join(dataDir, "workspaces", sessionId);
    await createSessionClone({
      barePath: settings.repo!.bare_path,
      clonePath,
      defaultBranch: settings.repo!.default_branch,
      branchName: branch,
      botName: bot.name,
      botEmail: bot.email ?? "kawan@kawan.local",
      signingKeyPath: bot.signing_key_path!,
    });
    const commits = workerOpts.commits ?? 1;
    for (let i = 0; i < commits; i += 1) {
      writeFileSync(join(clonePath, `change-${i}.txt`), `change ${i}\n`, "utf8");
      await git(["add", "."], clonePath);
      await git(["commit", "-m", `Change ${i}`], clonePath);
    }
    return host.db.createSession({
      id: sessionId,
      botId,
      kind: "worker",
      conversationId: workerOpts.conversationId ?? generalId,
      title: workerOpts.title ?? "Proposal session",
      task: workerOpts.title ?? "Proposal session",
      status: "idle",
      branch,
      clonePath,
    });
  };

  return {
    host,
    alice,
    adminId,
    botId,
    generalId,
    mqId,
    repo,
    makeWorker,
    cleanup: async () => {
      await alice.close();
      await host.close();
      await stub.close();
      repo.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
      adminKey.cleanup();
    },
  };
}

function toolCall(harness: ProposalHarness, session: SessionRow, tool: string, params: Record<string, unknown>) {
  return callHostTool(harness.host.sessionManager.socketPath, session.token, tool, params);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Statuses that mean auto mode (or a human Merge) pulled the proposal into the train. */
const TRAIN_ACCEPT_STATUSES = ["queued", "rebasing", "verifying", "landed"];

/** The trial evaluation's last act is a `land.update` carrying the rebased base sha. */
function waitForTrialEvaluation(client: WsTestClient, landId: string, timeoutMs = 25_000) {
  return client.waitForFrame(
    (f) => f.type === "land.update" && f.land?.id === landId && Boolean(f.land?.base_sha),
    timeoutMs,
  );
}

function trainFramesFor(client: WsTestClient, landId: string) {
  return client.frames.filter(
    (f) =>
      f.type === "land.update" &&
      f.land?.id === landId &&
      TRAIN_ACCEPT_STATUSES.includes(f.land?.status),
  );
}

test("Slice E: propose_merge posts a proposal message with attachments and a proposed land", async () => {
  const h = await setupProposalHost();
  try {
    const worker = await h.makeWorker({ title: "Friendly greeting" });
    const res = await toolCall(h, worker, "propose_merge", {
      title: "Friendlier greeting",
      summary_md: "The fixture repo now greets you in the README.",
      evidence: [
        { filename: "after.png", mime_type: "image/png", content: "fake-png-bytes" },
        { filename: "report.md", mime_type: "text/markdown", content: "# Details\n\nAll good.\n" },
      ],
    });

    assert.equal(res.created, true);
    assert.equal(res.land.status, "proposed");
    assert.equal(res.land.message_id, res.message.id);

    const land = h.host.db.getLand(res.land.id)!;
    assert.equal(land.status, "proposed");
    assert.equal(land.session_id, worker.id);
    assert.equal(land.conversation_id, h.generalId, "land points at the origin conversation");
    assert.equal(land.message_id, res.message.id);

    const proposalMessage = h.host.db.getMessage(res.message.id)!;
    assert.equal(proposalMessage.conversation_id, h.mqId, "proposal lives in #merge-queue");
    assert.equal(proposalMessage.thread_id, null, "proposal is top-level in #merge-queue");
    assert.match(proposalMessage.body, /greets you in the README/);
    assert.equal(proposalMessage.attachments.length, 2);
    assert.deepEqual(
      proposalMessage.attachments.map((a) => a.filename),
      ["after.png", "report.md"],
    );
    for (const artifact of proposalMessage.attachments) {
      assert.match(
        proposalMessage.body,
        new RegExp(`!\\[[^\\]]+\\]\\(kawan://artifact/${artifact.id}\\)`),
        "unreferenced uploads get inline image refs",
      );
    }

    // The origin conversation gets exactly one short, host-authored notice.
    const originMessages = h.host.db.listMessages(h.generalId);
    assert.equal(originMessages.length, 1);
    assert.equal(originMessages[0].body, "Proposed for merge: Friendlier greeting → Merge Queue");
    assert.equal(originMessages[0].author_id, h.botId);

    // The snapshot exposes the proposal card the client renders.
    const snap = await h.alice.request<{
      queue: { proposed: Array<{ land: { id: string }; message: { id: string }; author: { name: string }; commits_ahead: number; session_title: string | null }> };
    }>("merge_queue.read");
    assert.equal(snap.queue.proposed.length, 1);
    const card = snap.queue.proposed[0];
    assert.equal(card.land.id, res.land.id);
    assert.equal(card.message.id, res.message.id);
    assert.equal(card.author.name, "kawan");
    assert.equal(card.commits_ahead, 1);
    assert.equal(card.session_title, "Friendly greeting");
  } finally {
    await h.cleanup();
  }
});

test("Slice E: proposing again amends the same message and land row", async () => {
  const h = await setupProposalHost();
  try {
    const worker = await h.makeWorker({ title: "Amendable change" });
    const first = await toolCall(h, worker, "propose_merge", {
      title: "Amendable change",
      summary_md: "First draft of the change.",
      evidence: [{ filename: "one.txt", mime_type: "text/plain", content: "one\n" }],
    });

    // A second commit on the branch must show up in the refreshed commit count.
    writeFileSync(join(worker.clone_path!, "second.txt"), "second\n", "utf8");
    await git(["add", "."], worker.clone_path!);
    await git(["commit", "-m", "Second change"], worker.clone_path!);

    const amended = await toolCall(h, worker, "propose_merge", {
      title: "Amendable change",
      summary_md: "Rewrote the changelog so it is clearer.",
      evidence: [{ filename: "two.txt", mime_type: "text/plain", content: "two\n" }],
    });

    assert.equal(amended.created, false);
    assert.equal(amended.land.id, first.land.id, "no second land row");
    assert.equal(amended.message.id, first.message.id, "no second message");

    const lands = h.host.db.listLands({ sessionId: worker.id });
    assert.equal(lands.length, 1, "at most one open proposal per branch");

    const message = h.host.db.getMessage(first.message.id)!;
    assert.match(message.body, /Rewrote the changelog/);
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].filename, "two.txt");
    assert.equal(
      h.host.db.getArtifact(first.message.attachments[0].id)!.message_id,
      null,
      "replaced attachments are detached",
    );

    const origins = h.host.db.listMessages(h.generalId).map((m) => m.body);
    assert.deepEqual(origins, [
      "Proposed for merge: Amendable change → Merge Queue",
      "Proposal updated: Amendable change",
    ]);

    const snap = await h.alice.request<{ queue: { proposed: Array<{ commits_ahead: number; message: { id: string } }> } }>(
      "merge_queue.read",
    );
    assert.equal(snap.queue.proposed.length, 1);
    assert.equal(snap.queue.proposed[0].message.id, first.message.id);
    assert.equal(snap.queue.proposed[0].commits_ahead, 2, "commit count refreshed");
  } finally {
    await h.cleanup();
  }
});

test("Slice E: land.merge accepts a proposal into the train and lands it", async () => {
  const h = await setupProposalHost();
  try {
    const worker = await h.makeWorker({ title: "Merge me" });
    const proposed = await toolCall(h, worker, "propose_merge", {
      title: "Merge me",
      summary_md: "Adds a change that is ready to land.",
    });

    const landed = h.alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.id === proposed.land.id && f.land?.status === "landed",
      25_000,
    );
    const merged = await h.alice.request<{ land: { status: string } }>("land.merge", {
      land_id: proposed.land.id,
      async: true,
    });
    assert.equal(merged.land.status, "queued", "Merge queues the proposal");

    const landedEv = await landed;
    assert.equal(landedEv.land.status, "landed");
    const landedSha = landedEv.land.landed_sha as string;
    assert.ok(landedSha);
    const hostBarePath = h.host.db.getHostSettings().repo!.bare_path;
    const head = await git(
      ["--git-dir", hostBarePath, "rev-parse", `refs/heads/${h.repo.defaultBranch}`],
      process.cwd(),
    );
    assert.equal(head, landedSha);

    const snap = await h.alice.request<{ queue: { proposed: unknown[]; recent_landed: unknown[] } }>(
      "merge_queue.read",
    );
    assert.equal(snap.queue.proposed.length, 0);
    assert.equal(snap.queue.recent_landed.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("Slice E: default_landing_mode auto accepts a clean proposal automatically", async () => {
  const h = await setupProposalHost({ landingMode: "auto" });
  try {
    const worker = await h.makeWorker({ title: "Auto accepted" });
    const queued = h.alice.waitForFrame(
      (f) =>
        f.type === "land.update" &&
        (f.land?.status === "queued" || f.land?.status === "landed"),
      25_000,
    );
    const proposed = await toolCall(h, worker, "propose_merge", {
      title: "Auto accepted",
      summary_md: "A clean change that should not need a human click.",
    });

    const ev = await queued;
    assert.equal(ev.land.id, proposed.land.id);
    const autoAccepted = h.host.db.getLand(proposed.land.id)!;
    assert.equal(autoAccepted.approved_by, null, "auto mode needs no human approver");
    assert.ok(["queued", "rebasing", "verifying", "landed"].includes(autoAccepted.status));

    // The proposal message is still posted as the record.
    const snapshotMessages = h.host.db.listMessages(h.mqId);
    assert.equal(snapshotMessages.length, 1);
    assert.match(snapshotMessages[0].body, /should not need a human click/);

    const landed = await h.alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.id === proposed.land.id && f.land?.status === "landed",
      25_000,
    );
    assert.equal(landed.land.trigger, "auto_land");
  } finally {
    await h.cleanup();
  }
});

test("Slice E: auto mode refuses a proposal whose checks fail", async () => {
  const h = await setupProposalHost({ landingMode: "auto", verifyCommand: "exit 1" });
  try {
    const worker = await h.makeWorker({ title: "Red checks" });
    const proposed = await toolCall(h, worker, "propose_merge", {
      title: "Red checks",
      summary_md: "A change whose repo checks fail.",
    });

    const evaluated = await waitForTrialEvaluation(h.alice, proposed.land.id);
    const checks = evaluated.land.checks as Array<{ ok: boolean }>;
    assert.ok(checks.length > 0, "the trial recorded its check results");
    assert.ok(
      checks.every((c) => !c.ok),
      "`exit 1` leaves every check red",
    );

    // Let the queue loop kick; it must not touch this proposal.
    await sleep(750);
    const land = h.host.db.getLand(proposed.land.id)!;
    assert.equal(land.status, "proposed", "failing checks never auto-land");
    assert.deepEqual(trainFramesFor(h.alice, proposed.land.id), [], "no queued/rebasing/verifying/landed frame");
  } finally {
    await h.cleanup();
  }
});

test("Slice E: auto mode refuses a proposal that modifies .kawan/", async () => {
  const h = await setupProposalHost({ landingMode: "auto" });
  try {
    const worker = await h.makeWorker({ title: "Touches kawan dir" });
    mkdirSync(join(worker.clone_path!, ".kawan", "checks"), { recursive: true });
    writeFileSync(join(worker.clone_path!, ".kawan", "checks", "lint.sh"), "#!/bin/sh\nexit 0\n", "utf8");
    await git(["add", "."], worker.clone_path!);
    await git(["commit", "-m", "Add a repo check"], worker.clone_path!);

    const proposed = await toolCall(h, worker, "propose_merge", {
      title: "Touches kawan dir",
      summary_md: "A change that adds a `.kawan/checks` script.",
    });
    assert.equal(
      h.host.db.getLand(proposed.land.id)!.touches_kawan,
      1,
      "the row records Modifies .kawan/",
    );

    await waitForTrialEvaluation(h.alice, proposed.land.id);
    await sleep(750);
    const land = h.host.db.getLand(proposed.land.id)!;
    assert.equal(land.status, "proposed", "a .kawan/ proposal always needs a human Merge");
    assert.equal(land.touches_kawan, 1, "the trial keeps the guard set");
    assert.deepEqual(trainFramesFor(h.alice, proposed.land.id), [], "no queued/rebasing/verifying/landed frame");
  } finally {
    await h.cleanup();
  }
});

test("Slice E: a thrown trial evaluation keeps the .kawan/ guard durable", async () => {
  const h = await setupProposalHost({ landingMode: "auto" });
  // The host keeps its own bare mirror, so that is the path to take away.
  const barePath = h.host.db.getHostSettings().repo!.bare_path;
  const movedBarePath = `${barePath}-unreachable`;
  let bareMoved = false;
  try {
    const worker = await h.makeWorker({ title: "Guard survives a throw" });
    mkdirSync(join(worker.clone_path!, ".kawan", "checks"), { recursive: true });
    writeFileSync(join(worker.clone_path!, ".kawan", "checks", "lint.sh"), "#!/bin/sh\nexit 0\n", "utf8");
    await git(["add", "."], worker.clone_path!);
    await git(["commit", "-m", "Add a repo check"], worker.clone_path!);

    const proposed = await toolCall(h, worker, "propose_merge", {
      title: "Guard survives a throw",
      summary_md: "A `.kawan/` change whose second trial cannot reach the repo.",
    });
    await waitForTrialEvaluation(h.alice, proposed.land.id);
    assert.equal(
      h.host.db.getLand(proposed.land.id)!.touches_kawan,
      1,
      "the first trial records Modifies .kawan/",
    );

    // The next trial's `prepareLandingClone` throws instead of returning `ok: false`:
    // the branch cannot be fetched from a repository that is not there any more.
    renameSync(barePath, movedBarePath);
    bareMoved = true;

    const trialFailed = h.alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.id === proposed.land.id && Boolean(f.land?.error),
      25_000,
    );
    const amended = await toolCall(h, worker, "propose_merge", {
      summary_md: "Rewrote the changelog while the repository is unreachable.",
    });
    assert.equal(amended.land.id, proposed.land.id, "the amendment reuses the same row");
    await trialFailed;

    // Let the queue loop kick; neither the throw nor the loop may clear the guard.
    await sleep(750);
    const land = h.host.db.getLand(proposed.land.id)!;
    assert.ok(land.error, "the thrown trial is recorded on the row");
    assert.equal(land.touches_kawan, 1, "a thrown trial keeps Modifies .kawan/ set");
    assert.equal(land.status, "proposed", "a thrown trial never auto-accepts");
    assert.deepEqual(trainFramesFor(h.alice, proposed.land.id), [], "no queued/rebasing/verifying/landed frame");
  } finally {
    if (bareMoved) renameSync(movedBarePath, barePath);
    await h.cleanup();
  }
});

test("Slice E: report attaches every artifact it is given", async () => {
  const h = await setupProposalHost();
  try {
    const issueConv = h.host.db.createConversation({ kind: "issue", name: "issue-1", topic: "Attachments" });
    const worker = await h.makeWorker({ title: "Issue worker", conversationId: issueConv.id });
    h.host.db.createIssue({
      conversationId: issueConv.id,
      title: "Attachments",
      ownerId: h.adminId,
      implementerBotId: h.botId,
      activeSessionId: worker.id,
    });

    const res = await toolCall(h, worker, "report", {
      text: "Two screenshots attached.",
      artifacts: [
        { filename: "before.png", mime_type: "image/png", content: "before" },
        { filename: "after.png", mime_type: "image/png", content: "after" },
      ],
    });

    assert.ok(res.message_id, "issue workers publish their report into the room");
    const message = h.host.db.getMessage(res.message_id)!;
    assert.equal(message.conversation_id, issueConv.id);
    assert.equal(message.attachments.length, 2);
    assert.deepEqual(
      message.attachments.map((a) => a.filename),
      ["before.png", "after.png"],
    );
    assert.deepEqual(
      message.attachments.map((a) => a.id),
      res.artifact_ids,
    );
  } finally {
    await h.cleanup();
  }
});

test("Slice E: withdraw_proposal sets withdrawn and notifies the origin conversation", async () => {
  const h = await setupProposalHost();
  try {
    const worker = await h.makeWorker({ title: "Pull me back" });
    const proposed = await toolCall(h, worker, "propose_merge", {
      title: "Pull me back",
      summary_md: "A change that will be withdrawn.",
    });

    const res = await toolCall(h, worker, "withdraw_proposal", {
      reason: "Needs another pass",
    });
    assert.equal(res.proposed.length, 0);
    assert.equal(h.host.db.getLand(proposed.land.id)!.status, "withdrawn");

    const originBodies = h.host.db.listMessages(h.generalId).map((m) => m.body);
    assert.deepEqual(originBodies, [
      "Proposed for merge: Pull me back → Merge Queue",
      "Proposal withdrawn: Pull me back — Needs another pass",
    ]);

    // A withdrawn proposal cannot be merged.
    await assert.rejects(() => h.alice.request("land.merge", { land_id: proposed.land.id }), /withdrawn/);
  } finally {
    await h.cleanup();
  }
});

test("Slice E: a member withdraws a proposal over the socket", async () => {
  const h = await setupProposalHost();
  try {
    const worker = await h.makeWorker({ title: "Withdraw by hand" });
    const proposed = await toolCall(h, worker, "propose_merge", {
      title: "Withdraw by hand",
      summary_md: "A change a human pulls back.",
    });

    const snap = await h.alice.request<{ queue: { proposed: Array<{ land: { id: string } }> } }>(
      "land.withdraw",
      { land_id: proposed.land.id },
    );
    assert.deepEqual(snap.queue.proposed, [], "the card leaves Proposed (N)");
    assert.equal(h.host.db.getLand(proposed.land.id)!.status, "withdrawn");

    const originBodies = h.host.db.listMessages(h.generalId).map((m) => m.body);
    assert.deepEqual(originBodies, [
      "Proposed for merge: Withdraw by hand → Merge Queue",
      "Proposal withdrawn by @alice: Withdraw by hand",
    ]);

    await assert.rejects(
      () => h.alice.request("land.merge", { land_id: proposed.land.id }),
      /withdrawn/,
    );
  } finally {
    await h.cleanup();
  }
});

test("Slice E: an amendment without evidence keeps the proposal's attachments", async () => {
  const h = await setupProposalHost();
  try {
    const worker = await h.makeWorker({ title: "Keep evidence" });
    const first = await toolCall(h, worker, "propose_merge", {
      title: "Keep evidence",
      summary_md: "First draft with a screenshot.",
      evidence: [{ filename: "one.png", mime_type: "image/png", content: "fake-png-bytes" }],
    });

    const amended = await toolCall(h, worker, "propose_merge", {
      summary_md: "Clearer changelog, same evidence.",
    });

    assert.equal(amended.message.id, first.message.id);
    const message = h.host.db.getMessage(first.message.id)!;
    assert.match(message.body, /Clearer changelog/);
    assert.equal(message.attachments.length, 1, "evidence survives an amendment without new uploads");
    assert.equal(message.attachments[0].filename, "one.png");
    assert.equal(message.attachments[0].id, first.message.attachments[0].id);
    assert.equal(
      h.host.db.getArtifact(message.attachments[0].id)!.message_id,
      message.id,
      "the original artifact stays attached",
    );
    assert.equal(h.host.db.getMessage(first.message.id)!.attachments[0].message_id, message.id);
  } finally {
    await h.cleanup();
  }
});

test("Slice E: a failed acceptance stays visible with its error and can be merged again", async () => {
  const h = await setupProposalHost();
  try {
    const worker = await h.makeWorker({ title: "Fails before the train" });
    const proposed = await toolCall(h, worker, "propose_merge", {
      title: "Fails before the train",
      summary_md: "A proposal whose acceptance fails.",
    });

    // Mirrors processHeadUnsafe giving up before the train (missing clone/key/repo).
    h.host.db.updateLand(proposed.land.id, {
      status: "failed",
      error: "Session clone, bot signing key, or repository missing",
    });

    const snap = await h.alice.request<{
      queue: { proposed: Array<{ land: { id: string; status: string; error: string | null } }> };
    }>("merge_queue.read");
    const failedCard = snap.queue.proposed.find((card) => card.land.id === proposed.land.id);
    assert.ok(failedCard, "a failed acceptance is still listed instead of vanishing");
    assert.equal(failedCard!.land.status, "failed");
    assert.match(failedCard!.land.error!, /repository missing/);

    const landed = h.alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.id === proposed.land.id && f.land?.status === "landed",
      25_000,
    );
    const merged = await h.alice.request<{ land: { status: string } }>("land.merge", {
      land_id: proposed.land.id,
      async: true,
    });
    assert.equal(merged.land.status, "queued", "Merge retries a failed acceptance");
    await landed;
  } finally {
    await h.cleanup();
  }
});

test("Slice E: artifact entries must be objects", async () => {
  const h = await setupProposalHost();
  try {
    const worker = await h.makeWorker({ title: "Bad evidence" });
    await assert.rejects(
      () => toolCall(h, worker, "report", { text: "Bad evidence", artifacts: ["screenshot.png"] }),
      /artifacts\[0\] must be an object/,
    );
  } finally {
    await h.cleanup();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DecisionMode } from "../src/decisions.js";
import { getBranchHead } from "../src/git.js";
import { startHost } from "../src/server.js";
import { createFixtureBareRepo, TestKeyPair, WsTestClient } from "./helpers.js";
import { startStubProvider } from "./stub-provider.js";

test("Slice A: read cursors, repository state, and live + post-land session.diff", async () => {
  const decisionMode: DecisionMode = "live";
  const stub = await startStubProvider();
  const repo = await createFixtureBareRepo({
    "README.md": "# Slice A Repo\n",
  });
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-sliceA-"));
  const adminKey = await TestKeyPair.generate("admin@kawan");
  const bobKey = await TestKeyPair.generate("bob@kawan");

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
        return { text: "Prepared hello.txt — ready for your approval." };
      }
      if (!hasToolResult) {
        return {
          toolCalls: [
            {
              name: "spawn_session",
              arguments: {
                title: "Add hello.txt",
                task: "Create hello.txt containing 'hello world', commit it, and call propose_merge.",
              },
            },
          ],
        };
      }
      return { text: "On it." };
    }

    const toolCallsMade = msgs.filter((m: any) => m.role === "tool").length;
    if (toolCallsMade === 0) {
      return {
        toolCalls: [
          {
            name: "bash",
            arguments: {
              command:
                "printf 'hello world\\n' > hello.txt && git add hello.txt && git commit -m 'Add hello.txt'",
            },
          },
        ],
      };
    }
    if (toolCallsMade === 1) {
      return {
        toolCalls: [
          {
            name: "propose_merge",
            arguments: { summary_md: "Added hello.txt so the workspace greets you." },
          },
        ],
      };
    }
    return { text: "Done." };
  });

  const host = await startHost({
    dataDir,
    quiet: true,
    decisionMode,
    disableSandbox: true,
  });

  try {
    const alice = await WsTestClient.connect(host.url);
    await alice.bootstrap(host.bootstrapToken!, "alice", adminKey);

    const invite = await alice.request<{ token: string }>("invite.create", { note: "bob" });
    const bob = await WsTestClient.connect(host.url);
    await bob.register(invite.token, "bob", bobKey);

    const convsAlice0 = await alice.request<{ conversations: Array<{ id: string; name: string }> }>(
      "conversation.list",
    );
    const generalId = convsAlice0.conversations.find((c) => c.name === "general")!.id;
    await alice.request("conversation.add_member", {
      conversation_id: generalId,
      user_id: host.db.listUsers("human").find((u) => u.name === "bob")!.id,
    });

    // 1. Unread cursor semantics across two users
    await alice.request("message.send", {
      conversation_id: generalId,
      body: "First message from alice",
    });
    await alice.request("message.send", {
      conversation_id: generalId,
      body: "Second message from alice",
    });

    const convsAlice1 = await alice.request<{
      conversations: Array<{ id: string; last_seq: number; last_read_seq: number; unread_count: number }>;
    }>("conversation.list");
    const generalAlice = convsAlice1.conversations.find((c) => c.id === generalId)!;
    assert.equal(generalAlice.unread_count, 0);
    assert.equal(generalAlice.last_read_seq, 2);

    const convsBob1 = await bob.request<{
      conversations: Array<{ id: string; last_seq: number; last_read_seq: number; unread_count: number }>;
    }>("conversation.list");
    const generalBob = convsBob1.conversations.find((c) => c.id === generalId)!;
    assert.equal(generalBob.last_seq, 2);
    assert.equal(generalBob.last_read_seq, 0);
    assert.equal(generalBob.unread_count, 2);

    // Opening clears unread for bob
    const openedBob = await bob.request<{
      conversation: { last_read_seq: number; unread_count: number };
    }>("conversation.open", { conversation_id: generalId });
    assert.equal(openedBob.conversation.last_read_seq, 2);
    assert.equal(openedBob.conversation.unread_count, 0);

    // Another message bumps bob's unread count to 1, cleared by conversation.mark_read + read_cursor.update event
    await alice.request("message.send", {
      conversation_id: generalId,
      body: "Third message while bob is away",
    });
    const convsBob2 = await bob.request<{
      conversations: Array<{ id: string; unread_count: number }>;
    }>("conversation.list");
    assert.equal(convsBob2.conversations.find((c) => c.id === generalId)!.unread_count, 1);

    const cursorEventPromise = bob.waitForNextFrame(
      (f) => f.type === "read_cursor.update" && f.conversation_id === generalId,
    );
    const markRes = await bob.request<{
      conversation_id: string;
      last_read_seq: number;
      unread_count: number;
    }>("conversation.mark_read", { conversation_id: generalId });
    assert.equal(markRes.last_read_seq, 3);
    assert.equal(markRes.unread_count, 0);
    const cursorEvent = await cursorEventPromise;
    assert.equal(cursorEvent.last_read_seq, 3);
    assert.equal(cursorEvent.unread_count, 0);

    // 2. Configure repo, stub LLM + decision model, bot, and spawn worker task
    await alice.request("settings.update", {
      repo: { url: repo.barePath, default_branch: "main" },
      verify_command: "test -f hello.txt",
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

    const botRes = await alice.request<{ bot: { id: string } }>("bot.create", {
      name: "kawan",
      persona: "Practical orchestrator. Call spawn_session.",
      sandbox_enabled: false,
    });
    await alice.request("conversation.add_member", {
      conversation_id: generalId,
      user_id: botRes.bot.id,
    });

    const landRequestedPromise = alice.waitForFrame(
      (f) => f.type === "land.update" && f.land?.status === "proposed",
      25_000,
    );
    await alice.request("message.send", {
      conversation_id: generalId,
      body: "@kawan please add hello.txt and propose it for merge",
    });
    const landFrame = await landRequestedPromise;
    const landId = landFrame.land.id as string;
    const workerSessionId = landFrame.land.session_id as string;

    // 3. host state reflects repo, worker session, and pending proposal
    const settings = host.db.getHostSettings();
    assert.ok(settings.repo);
    assert.equal(settings.repo!.default_branch, "main");
    assert.equal(
      await getBranchHead(settings.repo!.bare_path, `refs/heads/${settings.repo!.default_branch}`),
      repo.initialHead,
    );
    assert.ok(host.db.listSessions({ kind: "worker" }).some((s) => s.id === workerSessionId));
    assert.equal(host.db.getLand(landId)!.status, "proposed");

    // 4. session.diff reads pre-land diff from live worker clone
    const diffLive = await bob.request<{
      session_id: string;
      diff: {
        available: boolean;
        files_changed: number;
        insertions: number;
        deletions: number;
        files: Array<{ path: string; status: string; patch: string }>;
      };
    }>("session.diff", { session_id: workerSessionId });
    assert.equal(diffLive.diff.available, true);
    assert.equal(diffLive.diff.files_changed, 1);
    assert.equal(diffLive.diff.insertions, 1);
    assert.equal(diffLive.diff.files[0].path, "hello.txt");
    assert.equal(diffLive.diff.files[0].status, "A");
    assert.match(diffLive.diff.files[0].patch, /\+hello world/);

    // 5. Merge the proposal (removes worker clone) -> landed row & session.diff reads from bare repo
    await alice.request("land.merge", { land_id: landId });

    const landedRow = host.db.getLand(landId)!;
    assert.equal(landedRow.status, "landed");
    assert.ok(landedRow.landed_sha);
    assert.equal(
      await getBranchHead(
        settings.repo!.bare_path,
        `refs/heads/${settings.repo!.default_branch}`,
      ),
      landedRow.landed_sha,
    );

    const diffLanded = await bob.request<{
      diff: {
        available: boolean;
        base_ref: string | null;
        head_ref: string | null;
        files_changed: number;
        files: Array<{ path: string; patch: string }>;
      };
    }>("session.diff", { session_id: workerSessionId });
    assert.equal(diffLanded.diff.available, true);
    assert.equal(diffLanded.diff.files_changed, 1);
    assert.equal(diffLanded.diff.head_ref, landedRow.landed_sha!.slice(0, 12));
    assert.match(diffLanded.diff.files[0].patch, /\+hello world/);

    alice.close();
    bob.close();
  } finally {
    await host.close();
    await stub.close();
    repo.cleanup();
    adminKey.cleanup();
    bobKey.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

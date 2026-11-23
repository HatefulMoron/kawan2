import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startHost } from "../src/server.js";
import { TestKeyPair, WsTestClient } from "./helpers.js";

test("Slice 1: SSH auth, bootstrap, invites, channels/DMs/threads, reconnect replay, revocation", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kawan-slice1-"));
  const protocolPath = resolve("fixtures/protocol/slice1.jsonl");
  rmSync(protocolPath, { force: true });

  const adminKey = await TestKeyPair.generate("admin@kawan");
  const memberKey = await TestKeyPair.generate("member@kawan");
  const intruderKey = await TestKeyPair.generate("intruder@kawan");

  const host = await startHost({
    dataDir,
    quiet: true,
    recordProtocolPath: protocolPath,
  });

  try {
    assert.ok(host.bootstrapToken, "bootstrap token should be created on fresh host");

    // 1. Unauthenticated command is rejected and socket closes
    {
      const unauth = await WsTestClient.connect(host.url);
      unauth.sendRaw({ id: "1", type: "conversation.list" });
      const err = await unauth.waitForNextFrame((f) => f.type === "error");
      assert.match(err.message, /Authentication required/);
      await unauth.waitForClose();
    }

    // 2. Wrong bootstrap token fails and does not consume bootstrap
    {
      const bad = await WsTestClient.connect(host.url);
      bad.sendRaw({
        type: "bootstrap",
        token: "wrong-token",
        pubkey: intruderKey.pubkey,
        name: "intruder",
        version: 1,
      });
      const err = await bad.waitForNextFrame((f) => f.type === "error");
      assert.match(err.message, /Invalid bootstrap token/);
      await bad.waitForClose();
    }

    // 3. Invalid signature proof fails and leaves users empty
    {
      const badSig = await WsTestClient.connect(host.url);
      badSig.sendRaw({
        type: "bootstrap",
        token: host.bootstrapToken,
        pubkey: adminKey.pubkey,
        name: "alice",
        version: 1,
      });
      const challenge = await badSig.waitForNextFrame((f) => f.type === "challenge");
      const wrongSig = await intruderKey.signNonce(challenge.nonce, challenge.namespace);
      badSig.sendRaw({ type: "proof", signature: wrongSig });
      const err = await badSig.waitForNextFrame((f) => f.type === "error");
      assert.match(err.message, /Invalid proof signature/);
      await badSig.waitForClose();
      assert.equal(host.db.countHumans(), 0);
    }

    // 4. Admin bootstraps cleanly
    const admin = await WsTestClient.connect(host.url);
    const welcomeAdmin = await admin.bootstrap(host.bootstrapToken, "alice", adminKey);
    assert.equal(welcomeAdmin.role, "admin");
    assert.equal(welcomeAdmin.name, "alice");
    assert.equal(host.db.getSetting("bootstrap_token"), null);

    // 5. Second bootstrap attempt is rejected
    {
      const second = await WsTestClient.connect(host.url);
      second.sendRaw({
        type: "bootstrap",
        token: host.bootstrapToken,
        pubkey: intruderKey.pubkey,
        name: "bob2",
        version: 1,
      });
      const err = await second.waitForNextFrame((f) => f.type === "error");
      assert.match(err.message, /already bootstrapped/i);
      await second.waitForClose();
    }

    // 6. Admin lists #general created at bootstrap
    const initialList = await admin.request<{ conversations: Array<{ id: string; name: string }> }>(
      "conversation.list",
    );
    const general = initialList.conversations.find((c) => c.name === "general");
    assert.ok(general, "#general should exist after bootstrap");

    // 7. Admin creates an invite and member registers
    const inviteRes = await admin.request<{ token: string; link: string }>("invite.create", {
      note: "For bob",
    });
    assert.ok(inviteRes.link.startsWith("kawan://"));

    const member = await WsTestClient.connect(host.url);
    const welcomeMember = await member.register(inviteRes.token, "bob", memberKey);
    assert.equal(welcomeMember.role, "member");

    // Invite cannot be reused
    {
      const reuse = await WsTestClient.connect(host.url);
      reuse.sendRaw({
        type: "register",
        token: inviteRes.token,
        pubkey: intruderKey.pubkey,
        name: "intruder",
        version: 1,
      });
      const err = await reuse.waitForNextFrame((f) => f.type === "error");
      assert.match(err.message, /Invalid or expired invite/);
      await reuse.waitForClose();
    }

    // 8. Admin creates a channel, adds bob, and exchanges messages + threaded reply
    const chanRes = await admin.request<{ conversation: { id: string; name: string } }>(
      "conversation.create",
      { kind: "channel", name: "engineering", topic: "Build & CI" },
    );
    const engId = chanRes.conversation.id;
    await admin.request("conversation.add_member", {
      conversation_id: engId,
      user_id: welcomeMember.user,
    });

    const msg1Wait = member.waitForNextFrame(
      (f) => f.type === "message.new" && f.message?.body === "Welcome to #engineering",
    );
    const sent1 = await admin.request<{ message: { id: string; seq: number } }>("message.send", {
      conversation_id: engId,
      body: "Welcome to #engineering",
    });
    assert.equal(sent1.message.seq, 1);
    await msg1Wait;

    const replyWait = admin.waitForNextFrame(
      (f) => f.type === "message.new" && f.message?.thread_id === sent1.message.id,
    );
    const sent2 = await member.request<{ message: { id: string; seq: number; thread_id: string } }>(
      "message.send",
      {
        conversation_id: engId,
        body: "Glad to be here",
        thread_id: sent1.message.id,
      },
    );
    assert.equal(sent2.message.seq, 2);
    assert.equal(sent2.message.thread_id, sent1.message.id);
    await replyWait;

    // 9. DM creation is idempotent
    const dm1 = await admin.request<{ conversation: { id: string }; created: boolean }>(
      "conversation.create",
      { kind: "dm", peer_user_id: welcomeMember.user },
    );
    const dm2 = await member.request<{ conversation: { id: string }; created: boolean }>(
      "conversation.create",
      { kind: "dm", peer_user_id: welcomeAdmin.user },
    );
    assert.equal(dm1.created, true);
    assert.equal(dm2.created, false);
    assert.equal(dm1.conversation.id, dm2.conversation.id);

    // 10. Member disconnects, misses 2 messages, reconnects via hello/proof and replays from seq=2
    const lastSeenSeq = sent2.message.seq;
    member.close();
    await member.waitForClose();

    const sent3 = await admin.request<{ message: { seq: number } }>("message.send", {
      conversation_id: engId,
      body: "Message while offline 1",
    });
    const sent4 = await admin.request<{ message: { seq: number } }>("message.send", {
      conversation_id: engId,
      body: "Message while offline 2",
    });
    assert.equal(sent3.message.seq, 3);
    assert.equal(sent4.message.seq, 4);

    const memberReconnected = await WsTestClient.connect(host.url);
    const welcomeAgain = await memberReconnected.hello(memberKey);
    assert.equal(welcomeAgain.user, welcomeMember.user);

    const replay = await memberReconnected.request<{
      messages: Array<{ seq: number; body: string }>;
    }>("conversation.open", {
      conversation_id: engId,
      since: lastSeenSeq,
    });
    assert.deepEqual(
      replay.messages.map((m) => [m.seq, m.body]),
      [
        [3, "Message while offline 1"],
        [4, "Message while offline 2"],
      ],
    );

    // 11. Admin revokes member -> live connection closes immediately & future hello fails
    const closePromise = memberReconnected.waitForClose();
    await admin.request("user.revoke", { user_id: welcomeMember.user });
    await closePromise;

    const afterRevoke = await WsTestClient.connect(host.url);
    afterRevoke.sendRaw({ type: "hello", key: memberKey.fingerprint, version: 1 });
    const errRevoke = await afterRevoke.waitForNextFrame((f) => f.type === "error");
    assert.match(errRevoke.message, /Unknown SSH key/);
    await afterRevoke.waitForClose();

    admin.close();
  } finally {
    await host.close();
    adminKey.cleanup();
    memberKey.cleanup();
    intruderKey.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

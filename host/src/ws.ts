import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  createInvite,
  issueChallenge,
  pubkeyFingerprint,
  verifyProofSignature,
  type IssuedChallenge,
} from "./auth.js";
import type { KawanDb } from "./db.js";
import type { ClientRequest, ConversationRow, UserRow, WsEventFrame, WsResponseFrame } from "./types.js";

type PendingAuth =
  | {
      kind: "bootstrap";
      token: string;
      name: string;
      pubkey: string;
      fingerprint: string;
      challenge: IssuedChallenge;
    }
  | {
      kind: "register";
      inviteToken: string;
      name: string;
      pubkey: string;
      fingerprint: string;
      challenge: IssuedChallenge;
    }
  | {
      kind: "hello";
      user: UserRow;
      pubkey: string;
      fingerprint: string;
      challenge: IssuedChallenge;
    };

interface ClientConn {
  ws: WebSocket;
  user: UserRow | null;
  pendingAuth: PendingAuth | null;
  authAttempted: boolean;
}

export interface SetupStatus {
  has_repo: boolean;
  has_models: boolean;
  has_decision_model: boolean;
  has_bot: boolean;
  ready: boolean;
}

export function computeSetupStatus(db: KawanDb): SetupStatus {
  const settings = db.getHostSettings();
  const hasRepo = Boolean(settings.repo?.bare_path);
  const hasModels = Boolean(settings.roles.default?.provider && settings.roles.default?.model);
  const hasDecision = Boolean(
    settings.roles.decision?.baseUrl &&
      settings.roles.decision?.model &&
      settings.roles.decision?.apiKey,
  );
  const hasBot = db.listUsers("bot").length > 0;
  return {
    has_repo: hasRepo,
    has_models: hasModels,
    has_decision_model: hasDecision,
    has_bot: hasBot,
    ready: hasRepo && hasModels && hasDecision && hasBot,
  };
}

export type CommandHandler = (
  req: ClientRequest,
  client: { user: UserRow },
) => Promise<unknown> | unknown;

export interface WsServerOptions {
  db: KawanDb;
  hostNamespace: string;
  hostAddress: string;
  recordProtocolPath?: string;
  onMessageCreated?: (params: {
    conversation: ConversationRow;
    message: ReturnType<KawanDb["appendMessage"]>;
    author: UserRow;
  }) => Promise<void> | void;
  extraHandlers?: Record<string, CommandHandler>;
}

function scrubSecretsForRecording(frame: unknown): unknown {
  if (!frame || typeof frame !== "object") return frame;
  if (Array.isArray(frame)) return frame.map(scrubSecretsForRecording);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frame)) {
    if ((k === "apiKey" || k === "https_token") && typeof v === "string" && v.length > 0) {
      out[k] = "<REDACTED>";
    } else {
      out[k] = scrubSecretsForRecording(v);
    }
  }
  return out;
}

export class KawanWsServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ClientConn>();
  private readonly opts: WsServerOptions;

  constructor(wss: WebSocketServer, opts: WsServerOptions) {
    this.wss = wss;
    this.opts = opts;
    if (opts.recordProtocolPath) {
      mkdirSync(dirname(opts.recordProtocolPath), { recursive: true });
    }

    this.wss.on("connection", (ws) => {
      const conn: ClientConn = {
        ws,
        user: null,
        pendingAuth: null,
        authAttempted: false,
      };
      this.clients.add(conn);

      ws.on("message", (data) => {
        void this.handleRawMessage(conn, data.toString("utf8"));
      });
      ws.on("close", () => {
        this.clients.delete(conn);
      });
    });
  }

  private recordFrame(dir: "c2s" | "s2c", frame: unknown): void {
    if (!this.opts.recordProtocolPath) return;
    const entry = { dir, frame: scrubSecretsForRecording(frame) };
    appendFileSync(this.opts.recordProtocolPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private sendFrame(ws: WebSocket, frame: WsEventFrame | WsResponseFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    this.recordFrame("s2c", frame);
    ws.send(`${JSON.stringify(frame)}\n`);
  }

  private sendErrorAndClose(conn: ClientConn, message: string, id?: string): void {
    this.sendFrame(conn.ws, {
      ...(id ? { id } : {}),
      type: "error",
      message,
    });
    conn.ws.close(4001, message.slice(0, 120));
  }

  broadcast(frame: WsEventFrame, predicate?: (user: UserRow) => boolean): void {
    for (const conn of this.clients) {
      if (!conn.user) continue;
      if (predicate && !predicate(conn.user)) continue;
      this.sendFrame(conn.ws, frame);
    }
  }

  broadcastToConversation(conversation: ConversationRow, frame: WsEventFrame): void {
    if (conversation.kind === "channel") {
      this.broadcast(frame);
      return;
    }
    const memberIds = new Set(this.opts.db.listMembers(conversation.id).map((m) => m.id));
    this.broadcast(frame, (u) => memberIds.has(u.id));
  }

  revokeUserConnections(userId: string, reason = "Access revoked"): void {
    for (const conn of this.clients) {
      if (conn.user?.id === userId) {
        this.sendErrorAndClose(conn, reason);
      }
    }
  }

  private async handleRawMessage(conn: ClientConn, raw: string): Promise<void> {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
      let req: ClientRequest;
      try {
        req = JSON.parse(line) as ClientRequest;
      } catch {
        if (!conn.user) {
          this.sendErrorAndClose(conn, "Invalid JSON");
          return;
        }
        this.sendFrame(conn.ws, { type: "error", message: "Invalid JSON" });
        continue;
      }

      if (!req || typeof req !== "object" || typeof req.type !== "string") {
        if (!conn.user) {
          this.sendErrorAndClose(conn, "Invalid request frame");
          return;
        }
        this.sendFrame(conn.ws, { type: "error", message: "Invalid request frame" });
        continue;
      }

      this.recordFrame("c2s", req);
      await this.handleRequest(conn, req);
    }
  }

  private async handleRequest(conn: ClientConn, req: ClientRequest): Promise<void> {
    const reqId = typeof req.id === "string" ? req.id : undefined;

    // Unauthenticated phase
    if (!conn.user) {
      try {
        if (req.type === "bootstrap") {
          if (conn.authAttempted) {
            this.sendErrorAndClose(conn, "Only one authentication attempt per connection", reqId);
            return;
          }
          conn.authAttempted = true;
          if (this.opts.db.countHumans() > 0) {
            this.sendErrorAndClose(conn, "Host already bootstrapped", reqId);
            return;
          }
          const expectedToken = this.opts.db.getSetting("bootstrap_token");
          const token = String(req.token ?? "");
          const pubkey = String(req.pubkey ?? "").trim();
          const name = String(req.name ?? "").trim();
          if (!expectedToken || token !== expectedToken) {
            this.sendErrorAndClose(conn, "Invalid bootstrap token", reqId);
            return;
          }
          if (!name) {
            this.sendErrorAndClose(conn, "Name is required", reqId);
            return;
          }
          const fingerprint = await pubkeyFingerprint(pubkey);
          const challenge = issueChallenge(this.opts.hostNamespace);
          conn.pendingAuth = {
            kind: "bootstrap",
            token,
            name,
            pubkey,
            fingerprint,
            challenge,
          };
          this.sendFrame(conn.ws, {
            ...(reqId ? { id: reqId } : {}),
            type: "challenge",
            nonce: challenge.nonce,
            namespace: challenge.namespace,
            expires: challenge.expires,
          });
          return;
        }

        if (req.type === "register") {
          if (conn.authAttempted) {
            this.sendErrorAndClose(conn, "Only one authentication attempt per connection", reqId);
            return;
          }
          conn.authAttempted = true;
          const token = String(req.token ?? "");
          const pubkey = String(req.pubkey ?? "").trim();
          const name = String(req.name ?? "").trim();
          const invite = this.opts.db.getInvite(token);
          if (!invite || invite.used_by !== null || invite.expires_at <= Date.now()) {
            this.sendErrorAndClose(conn, "Invalid or expired invite token", reqId);
            return;
          }
          if (!name) {
            this.sendErrorAndClose(conn, "Name is required", reqId);
            return;
          }
          const fingerprint = await pubkeyFingerprint(pubkey);
          if (this.opts.db.findKeyByFingerprint(fingerprint)) {
            this.sendErrorAndClose(conn, "SSH key is already registered", reqId);
            return;
          }
          const challenge = issueChallenge(this.opts.hostNamespace);
          conn.pendingAuth = {
            kind: "register",
            inviteToken: token,
            name,
            pubkey,
            fingerprint,
            challenge,
          };
          this.sendFrame(conn.ws, {
            ...(reqId ? { id: reqId } : {}),
            type: "challenge",
            nonce: challenge.nonce,
            namespace: challenge.namespace,
            expires: challenge.expires,
          });
          return;
        }

        if (req.type === "hello") {
          if (conn.authAttempted) {
            this.sendErrorAndClose(conn, "Only one authentication attempt per connection", reqId);
            return;
          }
          conn.authAttempted = true;
          const keyFp = String(req.key ?? "").trim();
          const match = this.opts.db.findKeyByFingerprint(keyFp);
          if (!match || match.user.kind !== "human") {
            this.sendErrorAndClose(conn, "Unknown SSH key fingerprint", reqId);
            return;
          }
          const challenge = issueChallenge(this.opts.hostNamespace);
          conn.pendingAuth = {
            kind: "hello",
            user: match.user,
            pubkey: match.pubkey,
            fingerprint: match.fingerprint,
            challenge,
          };
          this.sendFrame(conn.ws, {
            ...(reqId ? { id: reqId } : {}),
            type: "challenge",
            nonce: challenge.nonce,
            namespace: challenge.namespace,
            expires: challenge.expires,
          });
          return;
        }

        if (req.type === "proof") {
          const pending = conn.pendingAuth;
          conn.pendingAuth = null; // single-use
          if (!pending) {
            this.sendErrorAndClose(conn, "No active authentication challenge", reqId);
            return;
          }
          if (Date.now() > pending.challenge.expiresAt) {
            this.sendErrorAndClose(conn, "Authentication challenge expired", reqId);
            return;
          }
          const signature = String(req.signature ?? "");
          const valid = await verifyProofSignature({
            principal: pending.fingerprint,
            pubkey: pending.pubkey,
            namespace: pending.challenge.namespace,
            nonce: pending.challenge.nonce,
            signature,
          });
          if (!valid) {
            this.sendErrorAndClose(conn, "Invalid proof signature", reqId);
            return;
          }

          let user: UserRow;
          if (pending.kind === "bootstrap") {
            user = this.opts.db.transaction(() => {
              if (this.opts.db.countHumans() > 0) {
                throw new Error("Host already bootstrapped");
              }
              const expected = this.opts.db.getSetting("bootstrap_token");
              if (!expected || expected !== pending.token) {
                throw new Error("Bootstrap token is no longer valid");
              }
              const created = this.opts.db.createUser({
                kind: "human",
                role: "admin",
                name: pending.name,
              });
              this.opts.db.addKey(created.id, pending.fingerprint, pending.pubkey);
              this.opts.db.deleteSetting("bootstrap_token");
              this.opts.db.createConversation({
                kind: "channel",
                name: "general",
                topic: "General project conversation",
                memberIds: [created.id],
              });
              return created;
            });
          } else if (pending.kind === "register") {
            user = this.opts.db.transaction(() => {
              if (this.opts.db.findKeyByFingerprint(pending.fingerprint)) {
                throw new Error("SSH key already registered");
              }
              const created = this.opts.db.createUser({
                kind: "human",
                role: "member",
                name: pending.name,
              });
              this.opts.db.addKey(created.id, pending.fingerprint, pending.pubkey);
              if (!this.opts.db.consumeInvite(pending.inviteToken, created.id)) {
                throw new Error("Invite token has already been used or expired");
              }
              return created;
            });
          } else {
            const refreshed = this.opts.db.findKeyByFingerprint(pending.fingerprint);
            if (!refreshed || refreshed.user.kind !== "human") {
              this.sendErrorAndClose(conn, "User key was revoked", reqId);
              return;
            }
            user = refreshed.user;
          }

          conn.user = user;
          this.sendFrame(conn.ws, {
            ...(reqId ? { id: reqId } : {}),
            type: "welcome",
            user: user.id,
            name: user.name,
            role: user.role,
            setup: computeSetupStatus(this.opts.db),
          });
          return;
        }

        this.sendErrorAndClose(conn, `Authentication required before ${req.type}`, reqId);
      } catch (err) {
        this.sendErrorAndClose(conn, err instanceof Error ? err.message : String(err), reqId);
      }
      return;
    }

    // Authenticated commands
    try {
      const data = await this.dispatchAuthenticated(conn.user, req);
      this.sendFrame(conn.ws, {
        ...(reqId ? { id: reqId } : {}),
        type: "response",
        command: req.type,
        success: true,
        data,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendFrame(conn.ws, {
        ...(reqId ? { id: reqId } : {}),
        type: "response",
        command: req.type,
        success: false,
        error: msg,
      });
    }
  }

  private async dispatchAuthenticated(user: UserRow, req: ClientRequest): Promise<unknown> {
    const db = this.opts.db;
    const extra = this.opts.extraHandlers?.[req.type];
    if (extra) {
      return await extra(req, { user });
    }

    switch (req.type) {
      case "invite.create": {
        if (user.role !== "admin") {
          throw new Error("Only admins can create invites");
        }
        const note = typeof req.note === "string" ? req.note : null;
        const invite = createInvite(db, user.id, note);
        return {
          token: invite.token,
          link: `kawan://${this.opts.hostAddress}/${invite.token}`,
          expires_at: invite.expires_at,
          note: invite.note,
        };
      }

      case "user.list": {
        return {
          users: db.listUsers().map((u) => ({
            id: u.id,
            kind: u.kind,
            role: u.role,
            name: u.name,
            email: u.email,
            created_at: u.created_at,
          })),
        };
      }

      case "user.revoke": {
        if (user.role !== "admin") {
          throw new Error("Only admins can revoke users");
        }
        const targetId = String(req.user_id ?? "");
        if (!targetId) throw new Error("user_id is required");
        if (targetId === user.id) throw new Error("Cannot revoke yourself");
        const target = db.getUser(targetId);
        if (!target) throw new Error(`User not found: ${targetId}`);
        db.deleteUser(targetId);
        this.revokeUserConnections(targetId, "User revoked by admin");
        return { revoked: targetId };
      }

      case "conversation.list": {
        const conversations = db.listConversationsForUser(user.id).map((c) => ({
          ...c,
          last_seq: c.next_seq - 1,
          members: db.listMembers(c.id).map((m) => ({
            id: m.id,
            kind: m.kind,
            name: m.name,
            role: m.role,
          })),
        }));
        return { conversations };
      }

      case "conversation.create": {
        const kind = req.kind === "dm" ? "dm" : "channel";
        if (kind === "dm") {
          const peerId = typeof req.peer_user_id === "string" ? req.peer_user_id : "";
          if (!peerId) throw new Error("peer_user_id is required for dm");
          const peer = db.getUser(peerId);
          if (!peer) throw new Error(`User not found: ${peerId}`);
          const existing = db.findDmBetween(user.id, peerId);
          if (existing) {
            return {
              conversation: {
                ...existing,
                last_seq: existing.next_seq - 1,
                members: db.listMembers(existing.id).map((m) => ({
                  id: m.id,
                  kind: m.kind,
                  name: m.name,
                  role: m.role,
                })),
              },
              created: false,
            };
          }
          const conv = db.transaction(() =>
            db.createConversation({
              kind: "dm",
              memberIds: peerId === user.id ? [user.id] : [user.id, peerId],
            }),
          );
          const payload = {
            ...conv,
            last_seq: conv.next_seq - 1,
            members: db.listMembers(conv.id).map((m) => ({
              id: m.id,
              kind: m.kind,
              name: m.name,
              role: m.role,
            })),
          };
          this.broadcastToConversation(conv, { type: "conversation.new", conversation: payload });
          return { conversation: payload, created: true };
        }

        const rawName = String(req.name ?? "").trim().replace(/^#/, "");
        if (!rawName) throw new Error("Channel name is required");
        if (db.getChannelByName(rawName)) {
          throw new Error(`Channel already exists: #${rawName}`);
        }
        const topic = typeof req.topic === "string" ? req.topic : null;
        const memberIds = new Set<string>([user.id]);
        if (Array.isArray(req.member_ids)) {
          for (const id of req.member_ids) {
            if (typeof id === "string" && db.getUser(id)) {
              memberIds.add(id);
            }
          }
        }
        const conv = db.transaction(() =>
          db.createConversation({
            kind: "channel",
            name: rawName,
            topic,
            memberIds: [...memberIds],
          }),
        );
        const payload = {
          ...conv,
          last_seq: conv.next_seq - 1,
          members: db.listMembers(conv.id).map((m) => ({
            id: m.id,
            kind: m.kind,
            name: m.name,
            role: m.role,
          })),
        };
        this.broadcastToConversation(conv, { type: "conversation.new", conversation: payload });
        return { conversation: payload, created: true };
      }

      case "conversation.add_member": {
        const convId = String(req.conversation_id ?? "");
        const memberId = String(req.user_id ?? "");
        const conv = db.getConversation(convId);
        if (!conv) throw new Error(`Conversation not found: ${convId}`);
        if (conv.kind === "dm") throw new Error("Cannot add members to a DM");
        const target = db.getUser(memberId);
        if (!target) throw new Error(`User not found: ${memberId}`);
        const added = db.addMember(convId, memberId);
        const payload = {
          ...conv,
          last_seq: conv.next_seq - 1,
          members: db.listMembers(convId).map((m) => ({
            id: m.id,
            kind: m.kind,
            name: m.name,
            role: m.role,
          })),
        };
        if (added) {
          this.broadcastToConversation(conv, { type: "conversation.new", conversation: payload });
        }
        return { conversation: payload, added };
      }

      case "conversation.open": {
        const convId = String(req.conversation_id ?? "");
        const since = typeof req.since === "number" && req.since >= 0 ? Math.floor(req.since) : 0;
        const conv = db.getConversation(convId);
        if (!conv) throw new Error(`Conversation not found: ${convId}`);
        if (conv.kind === "dm" && !db.isMember(convId, user.id)) {
          throw new Error("Not a member of this DM");
        }
        const members = db.listMembers(convId).map((m) => ({
          id: m.id,
          kind: m.kind,
          name: m.name,
          role: m.role,
        }));
        const messages = db.listMessages(convId, since);
        const decisions = db.listDecisions(convId, since);
        const sessions = db.listSessions({ conversationId: convId });
        const artifacts = db.listArtifacts({ conversationId: convId });
        const lands = db.listLands({ conversationId: convId });
        return {
          conversation: {
            ...conv,
            last_seq: conv.next_seq - 1,
          },
          members,
          messages,
          decisions,
          sessions,
          artifacts,
          lands,
        };
      }

      case "message.send": {
        const convId = String(req.conversation_id ?? "");
        const body = typeof req.body === "string" ? req.body : "";
        const threadId = typeof req.thread_id === "string" && req.thread_id ? req.thread_id : null;
        if (!body.trim()) throw new Error("Message body cannot be empty");
        const conv = db.getConversation(convId);
        if (!conv) throw new Error(`Conversation not found: ${convId}`);
        if (!db.isMember(convId, user.id)) {
          throw new Error("You must be a member of this conversation to send messages");
        }
        if (threadId) {
          const parent = db.getMessage(threadId);
          if (!parent || parent.conversation_id !== convId) {
            throw new Error(`Invalid thread_id: ${threadId}`);
          }
        }
        const message = db.appendMessage({
          conversationId: convId,
          authorId: user.id,
          body,
          threadId,
        });
        this.broadcastToConversation(conv, {
          type: "message.new",
          message,
          author: { id: user.id, kind: user.kind, name: user.name },
        });
        if (this.opts.onMessageCreated) {
          void Promise.resolve(
            this.opts.onMessageCreated({ conversation: conv, message, author: user }),
          ).catch((err) => {
            this.broadcastToConversation(conv, {
              type: "error",
              conversation_id: convId,
              message_id: message.id,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        }
        return { message };
      }

      default:
        throw new Error(`Unknown command: ${req.type}`);
    }
  }
}

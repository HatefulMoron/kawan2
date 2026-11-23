import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ArtifactRow,
  ConversationKind,
  ConversationRow,
  DecisionReadiness,
  DecisionRow,
  HostSettings,
  InviteRow,
  KeyRow,
  LandRow,
  LandStatus,
  MessageRow,
  SessionKind,
  SessionRow,
  SessionStatus,
  SoulRow,
  UserKind,
  UserRole,
  UserRow,
} from "./types.js";

const SCHEMA_MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('human', 'bot')),
        role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
        name TEXT NOT NULL,
        email TEXT,
        persona TEXT,
        model TEXT,
        thinking_level TEXT,
        sandbox_enabled INTEGER NOT NULL DEFAULT 1,
        sandbox_network INTEGER NOT NULL DEFAULT 0,
        signing_key_path TEXT,
        signing_pubkey TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL UNIQUE,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invites (
        token TEXT PRIMARY KEY,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        note TEXT,
        expires_at INTEGER NOT NULL,
        used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('channel', 'dm')),
        name TEXT,
        topic TEXT,
        next_seq INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_channel_name
        ON conversations(name) WHERE kind = 'channel';

      CREATE TABLE IF NOT EXISTS members (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        thread_id TEXT,
        body TEXT NOT NULL,
        artifact_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (conversation_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conv_seq
        ON messages(conversation_id, seq);

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        decision_type TEXT NOT NULL,
        destination TEXT NOT NULL,
        readiness TEXT NOT NULL CHECK(readiness IN ('dispatch', 'hold')),
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        held_batch_id TEXT,
        dispatched INTEGER NOT NULL DEFAULT 0,
        redirected_from TEXT,
        redirected_by TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_conv_bot_dispatched
        ON decisions(conversation_id, bot_id, dispatched);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_session_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('orchestrator', 'worker')),
        conversation_id TEXT,
        thread_id TEXT,
        task TEXT,
        status TEXT NOT NULL,
        branch TEXT,
        clone_path TEXT,
        agent_dir TEXT,
        pi_session_file TEXT,
        last_entry_id TEXT,
        last_report TEXT,
        soul_snapshot TEXT,
        token TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        filename TEXT,
        session_id TEXT,
        conversation_id TEXT,
        message_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS soul (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        diff TEXT NOT NULL,
        author_session_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (bot_id, revision)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lands (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        thread_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('requested', 'verifying', 'landed', 'failed')),
        approved_by TEXT,
        base_sha TEXT,
        landed_sha TEXT,
        verify_output TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

export class KawanDb {
  readonly sqlite: DatabaseSync;

  constructor(dbPath: string) {
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    this.sqlite.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  transaction<T>(fn: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.sqlite.exec("COMMIT;");
      return result;
    } catch (err) {
      this.sqlite.exec("ROLLBACK;");
      throw err;
    }
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const applied = new Set<number>(
      (this.sqlite.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
        (r) => r.version,
      ),
    );
    for (const m of SCHEMA_MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.transaction(() => {
        this.sqlite.exec(m.sql);
        this.sqlite
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(m.version, Date.now());
      });
    }
  }

  // ---- Settings ----
  getSetting(key: string): string | null {
    const row = this.sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  deleteSetting(key: string): void {
    this.sqlite.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  getHostSettings(): HostSettings {
    const raw = this.getSetting("host_settings");
    if (!raw) {
      return { providers: {}, roles: {} };
    }
    const parsed = JSON.parse(raw) as Partial<HostSettings>;
    return {
      repo: parsed.repo,
      verify_command: parsed.verify_command,
      providers: parsed.providers ?? {},
      roles: parsed.roles ?? {},
    };
  }

  saveHostSettings(settings: HostSettings): void {
    this.setSetting("host_settings", JSON.stringify(settings));
  }

  // ---- Users & Keys ----
  countHumans(): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) as c FROM users WHERE kind = 'human'")
      .get() as { c: number };
    return row.c;
  }

  countUsers(): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
    return row.c;
  }

  createUser(input: {
    id?: string;
    kind: UserKind;
    role: UserRole;
    name: string;
    email?: string | null;
    persona?: string | null;
    model?: string | null;
    thinking_level?: string | null;
    sandbox_enabled?: boolean;
    sandbox_network?: boolean;
    signing_key_path?: string | null;
    signing_pubkey?: string | null;
  }): UserRow {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO users (
          id, kind, role, name, email, persona, model, thinking_level,
          sandbox_enabled, sandbox_network, signing_key_path, signing_pubkey, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.role,
        input.name,
        input.email ?? null,
        input.persona ?? null,
        input.model ?? null,
        input.thinking_level ?? null,
        input.sandbox_enabled === false ? 0 : 1,
        input.sandbox_network ? 1 : 0,
        input.signing_key_path ?? null,
        input.signing_pubkey ?? null,
        now,
      );
    return this.getUser(id)!;
  }

  getUser(id: string): UserRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) ?? null
    );
  }

  listUsers(kind?: UserKind): UserRow[] {
    if (kind) {
      return this.sqlite
        .prepare("SELECT * FROM users WHERE kind = ? ORDER BY created_at ASC")
        .all(kind) as unknown as UserRow[];
    }
    return this.sqlite.prepare("SELECT * FROM users ORDER BY created_at ASC").all() as unknown as UserRow[];
  }

  updateBot(
    id: string,
    patch: {
      name?: string;
      email?: string | null;
      persona?: string | null;
      model?: string | null;
      thinking_level?: string | null;
      sandbox_enabled?: boolean;
      sandbox_network?: boolean;
    },
  ): UserRow | null {
    const existing = this.getUser(id);
    if (!existing || existing.kind !== "bot") return null;
    this.sqlite
      .prepare(
        `UPDATE users SET
          name = ?, email = ?, persona = ?, model = ?, thinking_level = ?,
          sandbox_enabled = ?, sandbox_network = ?
        WHERE id = ?`,
      )
      .run(
        patch.name ?? existing.name,
        patch.email !== undefined ? patch.email : existing.email,
        patch.persona !== undefined ? patch.persona : existing.persona,
        patch.model !== undefined ? patch.model : existing.model,
        patch.thinking_level !== undefined ? patch.thinking_level : existing.thinking_level,
        patch.sandbox_enabled !== undefined ? (patch.sandbox_enabled ? 1 : 0) : existing.sandbox_enabled,
        patch.sandbox_network !== undefined ? (patch.sandbox_network ? 1 : 0) : existing.sandbox_network,
        id,
      );
    return this.getUser(id);
  }

  deleteUser(id: string): boolean {
    const res = this.sqlite.prepare("DELETE FROM users WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  addKey(userId: string, fingerprint: string, pubkey: string): KeyRow {
    const id = randomUUID();
    const now = Date.now();
    this.sqlite
      .prepare("INSERT INTO keys (id, user_id, fingerprint, pubkey, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, userId, fingerprint, pubkey, now);
    return this.sqlite.prepare("SELECT * FROM keys WHERE id = ?").get(id) as unknown as KeyRow;
  }

  findKeyByFingerprint(fingerprint: string): (KeyRow & { user: UserRow }) | null {
    const key = this.sqlite
      .prepare("SELECT * FROM keys WHERE fingerprint = ?")
      .get(fingerprint) as KeyRow | undefined;
    if (!key) return null;
    const user = this.getUser(key.user_id);
    if (!user) return null;
    return { ...key, user };
  }

  // ---- Invites ----
  createInvite(createdBy: string, token: string, note: string | null, expiresAt: number): InviteRow {
    const now = Date.now();
    this.sqlite
      .prepare(
        "INSERT INTO invites (token, created_by, note, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(token, createdBy, note, expiresAt, now);
    return this.getInvite(token)!;
  }

  getInvite(token: string): InviteRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM invites WHERE token = ?").get(token) as InviteRow | undefined) ??
      null
    );
  }

  consumeInvite(token: string, usedBy: string): boolean {
    const res = this.sqlite
      .prepare(
        "UPDATE invites SET used_by = ?, used_at = ? WHERE token = ? AND used_by IS NULL AND expires_at > ?",
      )
      .run(usedBy, Date.now(), token, Date.now());
    return Number(res.changes) === 1;
  }

  // ---- Conversations & Members ----
  createConversation(input: {
    id?: string;
    kind: ConversationKind;
    name?: string | null;
    topic?: string | null;
    memberIds?: string[];
  }): ConversationRow {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.sqlite
      .prepare(
        "INSERT INTO conversations (id, kind, name, topic, next_seq, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      )
      .run(id, input.kind, input.name ?? null, input.topic ?? null, now);
    if (input.memberIds) {
      for (const uid of input.memberIds) {
        this.addMember(id, uid);
      }
    }
    return this.getConversation(id)!;
  }

  getConversation(id: string): ConversationRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
        | ConversationRow
        | undefined) ?? null
    );
  }

  getChannelByName(name: string): ConversationRow | null {
    return (
      (this.sqlite
        .prepare("SELECT * FROM conversations WHERE kind = 'channel' AND name = ?")
        .get(name) as ConversationRow | undefined) ?? null
    );
  }

  findDmBetween(userA: string, userB: string): ConversationRow | null {
    const candidates = this.sqlite
      .prepare(
        `SELECT c.* FROM conversations c
         JOIN members m ON m.conversation_id = c.id
         WHERE c.kind = 'dm' AND m.user_id IN (?, ?)
         GROUP BY c.id
         HAVING COUNT(DISTINCT m.user_id) = ?`,
      )
      .all(userA, userB, userA === userB ? 1 : 2) as unknown as ConversationRow[];

    for (const c of candidates) {
      const members = this.listMembers(c.id);
      if (userA === userB && members.length === 1 && members[0].id === userA) return c;
      if (userA !== userB && members.length === 2) return c;
    }
    return null;
  }

  listConversationsForUser(userId: string): ConversationRow[] {
    return this.sqlite
      .prepare(
        `SELECT DISTINCT c.* FROM conversations c
         LEFT JOIN members m ON m.conversation_id = c.id AND m.user_id = ?
         WHERE c.kind = 'channel' OR m.user_id IS NOT NULL
         ORDER BY c.created_at ASC`,
      )
      .all(userId) as unknown as ConversationRow[];
  }

  addMember(conversationId: string, userId: string): boolean {
    const res = this.sqlite
      .prepare("INSERT OR IGNORE INTO members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)")
      .run(conversationId, userId, Date.now());
    return Number(res.changes) > 0;
  }

  isMember(conversationId: string, userId: string): boolean {
    const row = this.sqlite
      .prepare("SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?")
      .get(conversationId, userId);
    return Boolean(row);
  }

  listMembers(conversationId: string): UserRow[] {
    return this.sqlite
      .prepare(
        `SELECT u.* FROM users u
         JOIN members m ON m.user_id = u.id
         WHERE m.conversation_id = ?
         ORDER BY m.joined_at ASC`,
      )
      .all(conversationId) as unknown as UserRow[];
  }

  // ---- Messages ----
  appendMessage(input: {
    id?: string;
    conversationId: string;
    authorId: string;
    body: string;
    threadId?: string | null;
    artifactId?: string | null;
  }): MessageRow {
    return this.transaction(() => {
      const conv = this.getConversation(input.conversationId);
      if (!conv) {
        throw new Error(`Conversation not found: ${input.conversationId}`);
      }
      const seq = conv.next_seq;
      this.sqlite
        .prepare("UPDATE conversations SET next_seq = next_seq + 1 WHERE id = ?")
        .run(input.conversationId);
      const id = input.id ?? randomUUID();
      const now = Date.now();
      this.sqlite
        .prepare(
          `INSERT INTO messages (id, conversation_id, seq, author_id, thread_id, body, artifact_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          seq,
          input.authorId,
          input.threadId ?? null,
          input.body,
          input.artifactId ?? null,
          now,
        );
      return this.getMessage(id)!;
    });
  }

  getMessage(id: string): MessageRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined) ??
      null
    );
  }

  listMessages(conversationId: string, since = 0, limit?: number): MessageRow[] {
    if (limit !== undefined) {
      return this.sqlite
        .prepare(
          `SELECT * FROM messages
           WHERE conversation_id = ? AND seq > ?
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(conversationId, since, limit) as unknown as MessageRow[];
    }
    return this.sqlite
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC")
      .all(conversationId, since) as unknown as MessageRow[];
  }

  listRecentMessages(conversationId: string, limit = 20): MessageRow[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?")
      .all(conversationId, limit) as unknown as MessageRow[];
    return rows.reverse();
  }

  // ---- Decisions ----
  createDecision(input: {
    id?: string;
    conversationId: string;
    messageId: string;
    botId: string;
    decisionType: string;
    destination: string;
    readiness: DecisionReadiness;
    confidence: number;
    reason: string;
    rawJson: string;
    heldBatchId?: string | null;
    dispatched?: boolean;
  }): DecisionRow {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO decisions (
          id, conversation_id, message_id, bot_id, decision_type, destination,
          readiness, confidence, reason, raw_json, held_batch_id, dispatched, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.messageId,
        input.botId,
        input.decisionType,
        input.destination,
        input.readiness,
        input.confidence,
        input.reason,
        input.rawJson,
        input.heldBatchId ?? null,
        input.dispatched ? 1 : 0,
        now,
      );
    return this.getDecision(id)!;
  }

  getDecision(id: string): DecisionRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as DecisionRow | undefined) ??
      null
    );
  }

  listDecisions(conversationId: string, sinceSeq = 0): DecisionRow[] {
    return this.sqlite
      .prepare(
        `SELECT d.* FROM decisions d
         JOIN messages m ON m.id = d.message_id
         WHERE d.conversation_id = ? AND m.seq > ?
         ORDER BY m.seq ASC, d.created_at ASC`,
      )
      .all(conversationId, sinceSeq) as unknown as DecisionRow[];
  }

  listHeldDecisions(conversationId: string, botId: string): Array<DecisionRow & { message: MessageRow }> {
    const rows = this.sqlite
      .prepare(
        `SELECT d.* FROM decisions d
         JOIN messages m ON m.id = d.message_id
         WHERE d.conversation_id = ? AND d.bot_id = ? AND d.readiness = 'hold' AND d.dispatched = 0
         ORDER BY m.seq ASC`,
      )
      .all(conversationId, botId) as unknown as DecisionRow[];
    return rows.map((d) => ({
      ...d,
      message: this.getMessage(d.message_id)!,
    }));
  }

  markDecisionsDispatched(decisionIds: string[]): void {
    if (decisionIds.length === 0) return;
    const placeholders = decisionIds.map(() => "?").join(",");
    this.sqlite
      .prepare(`UPDATE decisions SET dispatched = 1 WHERE id IN (${placeholders})`)
      .run(...decisionIds);
  }

  redirectDecision(
    id: string,
    destination: string,
    redirectedBy: string,
  ): DecisionRow | null {
    const existing = this.getDecision(id);
    if (!existing) return null;
    this.sqlite
      .prepare(
        `UPDATE decisions
         SET redirected_from = COALESCE(redirected_from, destination),
             redirected_by = ?,
             destination = ?,
             readiness = 'dispatch',
             dispatched = 1
         WHERE id = ?`,
      )
      .run(redirectedBy, destination, id);
    return this.getDecision(id);
  }

  // ---- Sessions ----
  createSession(input: {
    id?: string;
    botId: string;
    parentSessionId?: string | null;
    kind: SessionKind;
    conversationId?: string | null;
    threadId?: string | null;
    task?: string | null;
    status?: SessionStatus;
    branch?: string | null;
    clonePath?: string | null;
    agentDir?: string | null;
    piSessionFile?: string | null;
    soulSnapshot?: string | null;
    token?: string;
  }): SessionRow {
    const id = input.id ?? randomUUID();
    const token = input.token ?? randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO sessions (
          id, bot_id, parent_session_id, kind, conversation_id, thread_id,
          task, status, branch, clone_path, agent_dir, pi_session_file,
          soul_snapshot, token, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.parentSessionId ?? null,
        input.kind,
        input.conversationId ?? null,
        input.threadId ?? null,
        input.task ?? null,
        input.status ?? "not_started",
        input.branch ?? null,
        input.clonePath ?? null,
        input.agentDir ?? null,
        input.piSessionFile ?? null,
        input.soulSnapshot ?? null,
        token,
        now,
        now,
      );
    return this.getSession(id)!;
  }

  getSession(id: string): SessionRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined) ??
      null
    );
  }

  getSessionByToken(token: string): SessionRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as
        | SessionRow
        | undefined) ?? null
    );
  }

  getActiveOrchestratorSession(botId: string): SessionRow | null {
    return (
      (this.sqlite
        .prepare(
          `SELECT * FROM sessions
           WHERE bot_id = ? AND kind = 'orchestrator' AND status != 'archived'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(botId) as SessionRow | undefined) ?? null
    );
  }

  listSessions(filter?: { botId?: string; conversationId?: string; kind?: SessionKind }): SessionRow[] {
    const clauses: string[] = [];
    const params: Array<string> = [];
    if (filter?.botId) {
      clauses.push("bot_id = ?");
      params.push(filter.botId);
    }
    if (filter?.conversationId) {
      clauses.push("conversation_id = ?");
      params.push(filter.conversationId);
    }
    if (filter?.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.sqlite
      .prepare(`SELECT * FROM sessions ${where} ORDER BY created_at ASC`)
      .all(...params) as unknown as SessionRow[];
  }

  listActiveWorkerSessions(botId: string, conversationId?: string): SessionRow[] {
    if (conversationId) {
      return this.sqlite
        .prepare(
          `SELECT * FROM sessions
           WHERE bot_id = ? AND kind = 'worker' AND conversation_id = ?
             AND status NOT IN ('landed', 'archived', 'stopped')
           ORDER BY created_at ASC`,
        )
        .all(botId, conversationId) as unknown as SessionRow[];
    }
    return this.sqlite
      .prepare(
        `SELECT * FROM sessions
         WHERE bot_id = ? AND kind = 'worker'
           AND status NOT IN ('landed', 'archived', 'stopped')
         ORDER BY created_at ASC`,
      )
      .all(botId) as unknown as SessionRow[];
  }

  updateSession(
    id: string,
    patch: Partial<{
      status: SessionStatus;
      branch: string | null;
      clone_path: string | null;
      agent_dir: string | null;
      pi_session_file: string | null;
      last_entry_id: string | null;
      last_report: string | null;
      conversation_id: string | null;
      thread_id: string | null;
    }>,
  ): SessionRow | null {
    const existing = this.getSession(id);
    if (!existing) return null;
    this.sqlite
      .prepare(
        `UPDATE sessions SET
          status = ?, branch = ?, clone_path = ?, agent_dir = ?, pi_session_file = ?,
          last_entry_id = ?, last_report = ?, conversation_id = ?, thread_id = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        patch.status ?? existing.status,
        patch.branch !== undefined ? patch.branch : existing.branch,
        patch.clone_path !== undefined ? patch.clone_path : existing.clone_path,
        patch.agent_dir !== undefined ? patch.agent_dir : existing.agent_dir,
        patch.pi_session_file !== undefined ? patch.pi_session_file : existing.pi_session_file,
        patch.last_entry_id !== undefined ? patch.last_entry_id : existing.last_entry_id,
        patch.last_report !== undefined ? patch.last_report : existing.last_report,
        patch.conversation_id !== undefined ? patch.conversation_id : existing.conversation_id,
        patch.thread_id !== undefined ? patch.thread_id : existing.thread_id,
        Date.now(),
        id,
      );
    return this.getSession(id);
  }

  // ---- Artifacts ----
  createArtifact(input: {
    id?: string;
    sha256: string;
    mimeType: string;
    byteSize: number;
    filename?: string | null;
    sessionId?: string | null;
    conversationId?: string | null;
    messageId?: string | null;
  }): ArtifactRow {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO artifacts (
          id, sha256, mime_type, byte_size, filename, session_id, conversation_id, message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sha256,
        input.mimeType,
        input.byteSize,
        input.filename ?? null,
        input.sessionId ?? null,
        input.conversationId ?? null,
        input.messageId ?? null,
        now,
      );
    return this.getArtifact(id)!;
  }

  getArtifact(id: string): ArtifactRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined) ??
      null
    );
  }

  linkArtifactMessage(artifactId: string, messageId: string): void {
    this.sqlite.prepare("UPDATE artifacts SET message_id = ? WHERE id = ?").run(messageId, artifactId);
  }

  listArtifacts(filter?: { sessionId?: string; conversationId?: string }): ArtifactRow[] {
    if (filter?.sessionId) {
      return this.sqlite
        .prepare("SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC")
        .all(filter.sessionId) as unknown as ArtifactRow[];
    }
    if (filter?.conversationId) {
      return this.sqlite
        .prepare("SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY created_at ASC")
        .all(filter.conversationId) as unknown as ArtifactRow[];
    }
    return this.sqlite.prepare("SELECT * FROM artifacts ORDER BY created_at ASC").all() as unknown as ArtifactRow[];
  }

  // ---- Soul ----
  getLatestSoul(botId: string): SoulRow | null {
    return (
      (this.sqlite
        .prepare("SELECT * FROM soul WHERE bot_id = ? ORDER BY revision DESC LIMIT 1")
        .get(botId) as SoulRow | undefined) ?? null
    );
  }

  listSoulRevisions(botId: string): SoulRow[] {
    return this.sqlite
      .prepare("SELECT * FROM soul WHERE bot_id = ? ORDER BY revision ASC")
      .all(botId) as unknown as SoulRow[];
  }

  insertSoulRevision(input: {
    botId: string;
    revision: number;
    content: string;
    diff: string;
    authorSessionId?: string | null;
  }): SoulRow {
    const id = randomUUID();
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO soul (id, bot_id, revision, content, diff, author_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.botId, input.revision, input.content, input.diff, input.authorSessionId ?? null, now);
    return this.sqlite.prepare("SELECT * FROM soul WHERE id = ?").get(id) as unknown as SoulRow;
  }

  // ---- Lands ----
  createLand(input: {
    id?: string;
    sessionId: string;
    conversationId: string;
    threadId?: string | null;
  }): LandRow {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO lands (
          id, session_id, conversation_id, thread_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'requested', ?, ?)`,
      )
      .run(id, input.sessionId, input.conversationId, input.threadId ?? null, now, now);
    return this.getLand(id)!;
  }

  getLand(id: string): LandRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM lands WHERE id = ?").get(id) as LandRow | undefined) ?? null
    );
  }

  listLands(filter?: { sessionId?: string; conversationId?: string }): LandRow[] {
    if (filter?.sessionId) {
      return this.sqlite
        .prepare("SELECT * FROM lands WHERE session_id = ? ORDER BY created_at ASC")
        .all(filter.sessionId) as unknown as LandRow[];
    }
    if (filter?.conversationId) {
      return this.sqlite
        .prepare("SELECT * FROM lands WHERE conversation_id = ? ORDER BY created_at ASC")
        .all(filter.conversationId) as unknown as LandRow[];
    }
    return this.sqlite.prepare("SELECT * FROM lands ORDER BY created_at ASC").all() as unknown as LandRow[];
  }

  updateLand(
    id: string,
    patch: Partial<{
      status: LandStatus;
      approved_by: string | null;
      base_sha: string | null;
      landed_sha: string | null;
      verify_output: string | null;
      error: string | null;
    }>,
  ): LandRow | null {
    const existing = this.getLand(id);
    if (!existing) return null;
    this.sqlite
      .prepare(
        `UPDATE lands SET
          status = ?, approved_by = ?, base_sha = ?, landed_sha = ?, verify_output = ?, error = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        patch.status ?? existing.status,
        patch.approved_by !== undefined ? patch.approved_by : existing.approved_by,
        patch.base_sha !== undefined ? patch.base_sha : existing.base_sha,
        patch.landed_sha !== undefined ? patch.landed_sha : existing.landed_sha,
        patch.verify_output !== undefined ? patch.verify_output : existing.verify_output,
        patch.error !== undefined ? patch.error : existing.error,
        Date.now(),
        id,
      );
    return this.getLand(id);
  }
}

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ArtifactRow,
  CheckRunItem,
  ConversationKind,
  ConversationRow,
  DecisionReadiness,
  DecisionRow,
  HostSettings,
  InviteRow,
  IssueChecksStatus,
  IssueRow,
  IssueStatus,
  KeyRow,
  LandRow,
  LandStatus,
  MessageRow,
  ReadCursorRow,
  SerializedIssue,
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
        sandbox_network INTEGER NOT NULL DEFAULT 1,
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
        kind TEXT NOT NULL CHECK(kind IN ('channel', 'dm', 'issue', 'merge_queue')),
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
        hold_expires_at INTEGER,
        explicit_work_start TEXT,
        work_request TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_conv_bot_dispatched
        ON decisions(conversation_id, bot_id, dispatched);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_session_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('orchestrator', 'worker', 'queue', 'reviewer')),
        conversation_id TEXT,
        thread_id TEXT,
        title TEXT,
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

      CREATE TABLE IF NOT EXISTS message_artifacts (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (message_id, artifact_id)
      );

      CREATE INDEX IF NOT EXISTS idx_message_artifacts_message
        ON message_artifacts(message_id, position);

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
        message_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('proposed', 'queued', 'rebasing', 'verifying', 'paused', 'landed', 'failed', 'withdrawn')),
        approved_by TEXT,
        base_sha TEXT,
        landed_sha TEXT,
        verify_output TEXT,
        error TEXT,
        queue_position INTEGER,
        issue_id TEXT,
        pause_reason TEXT,
        queue_session_id TEXT,
        queue_thread_id TEXT,
        trigger TEXT NOT NULL DEFAULT 'proposal',
        checks_json TEXT,
        touches_kawan INTEGER NOT NULL DEFAULT 0,
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
    if (!applied.has(1)) {
      this.transaction(() => {
        this.sqlite.exec(SCHEMA_MIGRATIONS[0].sql);
        const now = Date.now();
        this.sqlite
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(1, now);
        this.sqlite
          .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(2, now);
      });
    } else if (!applied.has(2)) {
      this.sqlite.exec("PRAGMA foreign_keys = OFF;");
      try {
        this.transaction(() => {
          this.sqlite.exec(`
            CREATE TABLE conversations_v2 (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL CHECK(kind IN ('channel', 'dm', 'issue', 'merge_queue')),
              name TEXT,
              topic TEXT,
              next_seq INTEGER NOT NULL DEFAULT 1,
              created_at INTEGER NOT NULL
            );
            INSERT INTO conversations_v2 (id, kind, name, topic, next_seq, created_at)
              SELECT id, kind, name, topic, next_seq, created_at FROM conversations;
            DROP TABLE conversations;
            ALTER TABLE conversations_v2 RENAME TO conversations;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_channel_name
              ON conversations(name) WHERE kind = 'channel';

            CREATE TABLE sessions_v2 (
              id TEXT PRIMARY KEY,
              bot_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              parent_session_id TEXT,
              kind TEXT NOT NULL CHECK(kind IN ('orchestrator', 'worker', 'queue', 'reviewer')),
              conversation_id TEXT,
              thread_id TEXT,
              title TEXT,
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
            INSERT INTO sessions_v2 (
              id, bot_id, parent_session_id, kind, conversation_id, thread_id, title, task, status,
              branch, clone_path, agent_dir, pi_session_file, last_entry_id, last_report,
              soul_snapshot, token, created_at, updated_at
            )
            SELECT
              id, bot_id, parent_session_id, kind, conversation_id, thread_id, title, task, status,
              branch, clone_path, agent_dir, pi_session_file, last_entry_id, last_report,
              soul_snapshot, token, created_at, updated_at
            FROM sessions;
            DROP TABLE sessions;
            ALTER TABLE sessions_v2 RENAME TO sessions;

            CREATE TABLE lands_v2 (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
              conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
              thread_id TEXT,
              message_id TEXT,
              status TEXT NOT NULL CHECK(status IN ('requested', 'queued', 'rebasing', 'verifying', 'paused', 'landed', 'failed', 'removed')),
              approved_by TEXT,
              base_sha TEXT,
              landed_sha TEXT,
              verify_output TEXT,
              error TEXT,
              queue_position INTEGER,
              issue_id TEXT,
              pause_reason TEXT,
              queue_session_id TEXT,
              queue_thread_id TEXT,
              trigger TEXT NOT NULL DEFAULT 'manual_approve',
              checks_json TEXT,
              touches_kawan INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            INSERT INTO lands_v2 (
              id, session_id, conversation_id, thread_id, message_id, status, approved_by,
              base_sha, landed_sha, verify_output, error, created_at, updated_at
            )
            SELECT
              id, session_id, conversation_id, thread_id, message_id, status, approved_by,
              base_sha, landed_sha, verify_output, error, created_at, updated_at
            FROM lands;
            DROP TABLE lands;
            ALTER TABLE lands_v2 RENAME TO lands;
          `);
          this.sqlite
            .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .run(2, Date.now());
        });
      } finally {
        this.sqlite.exec("PRAGMA foreign_keys = ON;");
      }
    }
    const decCols = this.sqlite
      .prepare("PRAGMA table_info(decisions)")
      .all() as Array<{ name: string }>;
    if (!decCols.some((c) => c.name === "hold_expires_at")) {
      this.sqlite.exec("ALTER TABLE decisions ADD COLUMN hold_expires_at INTEGER");
    }
    if (!decCols.some((c) => c.name === "explicit_work_start")) {
      this.sqlite.exec("ALTER TABLE decisions ADD COLUMN explicit_work_start TEXT");
    }
    if (!decCols.some((c) => c.name === "work_request")) {
      this.sqlite.exec("ALTER TABLE decisions ADD COLUMN work_request TEXT");
    }
    const sessCols = this.sqlite
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    if (!sessCols.some((c) => c.name === "title")) {
      this.sqlite.exec("ALTER TABLE sessions ADD COLUMN title TEXT");
    }
    const landCols = this.sqlite
      .prepare("PRAGMA table_info(lands)")
      .all() as Array<{ name: string }>;
    if (!landCols.some((c) => c.name === "message_id")) {
      this.sqlite.exec("ALTER TABLE lands ADD COLUMN message_id TEXT");
    }
    const extraLandCols: Array<[string, string]> = [
      ["queue_position", "INTEGER"],
      ["issue_id", "TEXT"],
      ["pause_reason", "TEXT"],
      ["queue_session_id", "TEXT"],
      ["queue_thread_id", "TEXT"],
      ["trigger", "TEXT NOT NULL DEFAULT 'manual_approve'"],
      ["checks_json", "TEXT"],
      ["touches_kawan", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [col, def] of extraLandCols) {
      if (!landCols.some((c) => c.name === col)) {
        this.sqlite.exec(`ALTER TABLE lands ADD COLUMN ${col} ${def}`);
      }
    }
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS read_cursors (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, conversation_id)
      );

      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body_md TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'landed', 'closed')),
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        implementer_bot_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        active_session_id TEXT,
        parent_issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
        needs_input_question TEXT,
        behind_main INTEGER NOT NULL DEFAULT 0,
        commits_ahead INTEGER NOT NULL DEFAULT 0,
        checks_status TEXT NOT NULL DEFAULT 'none' CHECK(checks_status IN ('none', 'running', 'passed', 'failed')),
        checks_sha TEXT,
        checks_summary TEXT,
        checks_json TEXT,
        checks_artifact_id TEXT,
        touches_kawan INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    const issueTableSql = (
      this.sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'issues'")
        .get() as { sql?: string } | undefined
    )?.sql;
    if (issueTableSql && (!issueTableSql.includes("checks_status") || issueTableSql.includes("'backlog'"))) {
      this.sqlite.exec("PRAGMA foreign_keys = OFF;");
      try {
        this.transaction(() => {
          this.sqlite.exec(`
            CREATE TABLE issues_v3 (
              id TEXT PRIMARY KEY,
              number INTEGER NOT NULL UNIQUE,
              conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
              title TEXT NOT NULL,
              body_md TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'landed', 'closed')),
              owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              implementer_bot_id TEXT REFERENCES users(id) ON DELETE SET NULL,
              active_session_id TEXT,
              parent_issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
              needs_input_question TEXT,
              behind_main INTEGER NOT NULL DEFAULT 0,
              commits_ahead INTEGER NOT NULL DEFAULT 0,
              checks_status TEXT NOT NULL DEFAULT 'none' CHECK(checks_status IN ('none', 'running', 'passed', 'failed')),
              checks_sha TEXT,
              checks_summary TEXT,
              checks_json TEXT,
              checks_artifact_id TEXT,
              touches_kawan INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            INSERT INTO issues_v3 (
              id, number, conversation_id, title, body_md, status, owner_id,
              implementer_bot_id, active_session_id, parent_issue_id,
              needs_input_question, behind_main, created_at, updated_at
            )
            SELECT
              id, number, conversation_id, title, body_md,
              CASE WHEN status IN ('landed', 'closed') THEN status ELSE 'open' END,
              owner_id, implementer_bot_id, active_session_id, parent_issue_id,
              needs_input_question, behind_main, created_at, updated_at
            FROM issues;
            DROP TABLE issues;
            ALTER TABLE issues_v3 RENAME TO issues;
          `);
        });
      } finally {
        this.sqlite.exec("PRAGMA foreign_keys = ON;");
      }
    }
    this.sqlite.exec(`
      DROP TABLE IF EXISTS issue_reviewers;
      DROP TABLE IF EXISTS issue_reviews;
    `);
    this.upgradeProposalSchema();
  }

  /**
   * Forward migration onto the proposal model. A message used to carry at most
   * one `messages.artifact_id`; attachments now live in the ordered
   * `message_artifacts` join table. `lands.requested` became `lands.proposed`
   * (and `removed` became `withdrawn`), which also needs the status CHECK
   * rewritten. Both steps are idempotent and safe on a fresh database.
   */
  private upgradeProposalSchema(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS message_artifacts (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (message_id, artifact_id)
      );
      CREATE INDEX IF NOT EXISTS idx_message_artifacts_message
        ON message_artifacts(message_id, position);
    `);

    const msgCols = this.sqlite
      .prepare("PRAGMA table_info(messages)")
      .all() as Array<{ name: string }>;
    if (msgCols.some((c) => c.name === "artifact_id")) {
      this.sqlite.exec(`
        INSERT OR IGNORE INTO message_artifacts (message_id, artifact_id, position)
          SELECT m.id, m.artifact_id, 0
          FROM messages m JOIN artifacts a ON a.id = m.artifact_id
          WHERE m.artifact_id IS NOT NULL;
        UPDATE artifacts
          SET message_id = (
            SELECT ma.message_id FROM message_artifacts ma WHERE ma.artifact_id = artifacts.id
          )
          WHERE message_id IS NULL
            AND EXISTS (SELECT 1 FROM message_artifacts ma WHERE ma.artifact_id = artifacts.id);
      `);
      try {
        this.sqlite.exec("ALTER TABLE messages DROP COLUMN artifact_id");
      } catch {
        // SQLite < 3.35 cannot drop columns; the column stays unused and null.
      }
    }

    const landTableSql = (
      this.sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lands'")
        .get() as { sql?: string } | undefined
    )?.sql;
    if (landTableSql && (landTableSql.includes("'requested'") || landTableSql.includes("'removed'"))) {
      this.sqlite.exec("PRAGMA foreign_keys = OFF;");
      try {
        this.transaction(() => {
          this.sqlite.exec(`
            CREATE TABLE lands_v4 (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
              conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
              thread_id TEXT,
              message_id TEXT,
              status TEXT NOT NULL CHECK(status IN ('proposed', 'queued', 'rebasing', 'verifying', 'paused', 'landed', 'failed', 'withdrawn')),
              approved_by TEXT,
              base_sha TEXT,
              landed_sha TEXT,
              verify_output TEXT,
              error TEXT,
              queue_position INTEGER,
              issue_id TEXT,
              pause_reason TEXT,
              queue_session_id TEXT,
              queue_thread_id TEXT,
              trigger TEXT NOT NULL DEFAULT 'proposal',
              checks_json TEXT,
              touches_kawan INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            INSERT INTO lands_v4 (
              id, session_id, conversation_id, thread_id, message_id, status, approved_by,
              base_sha, landed_sha, verify_output, error, queue_position, issue_id, pause_reason,
              queue_session_id, queue_thread_id, trigger, checks_json, touches_kawan,
              created_at, updated_at
            )
            SELECT
              id, session_id, conversation_id, thread_id, message_id,
              CASE status
                WHEN 'requested' THEN 'proposed'
                WHEN 'removed' THEN 'withdrawn'
                ELSE status
              END,
              approved_by, base_sha, landed_sha, verify_output, error, queue_position, issue_id,
              pause_reason, queue_session_id, queue_thread_id, trigger, checks_json, touches_kawan,
              created_at, updated_at
            FROM lands;
            DROP TABLE lands;
            ALTER TABLE lands_v4 RENAME TO lands;
          `);
        });
      } finally {
        this.sqlite.exec("PRAGMA foreign_keys = ON;");
      }
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
      merge_queue: parsed.merge_queue,
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
        input.sandbox_network === false ? 0 : 1,
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

  updateConversationTopic(conversationId: string, topic: string | null): void {
    this.sqlite.prepare("UPDATE conversations SET topic = ? WHERE id = ?").run(topic, conversationId);
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
         WHERE c.kind IN ('channel', 'issue', 'merge_queue') OR m.user_id IS NOT NULL
         ORDER BY c.created_at ASC`,
      )
      .all(userId) as unknown as ConversationRow[];
  }

  getMergeQueueConversation(): ConversationRow | null {
    return (
      (this.sqlite
        .prepare("SELECT * FROM conversations WHERE kind = 'merge_queue' ORDER BY created_at ASC LIMIT 1")
        .get() as ConversationRow | undefined) ?? null
    );
  }

  ensureMergeQueueConversation(memberIds: string[] = []): ConversationRow {
    let conv = this.getMergeQueueConversation();
    if (!conv) {
      conv = this.createConversation({
        kind: "merge_queue",
        name: "merge-queue",
        topic: "Serialized merge queue and conflict reconciliation",
        memberIds,
      });
    } else {
      for (const uid of memberIds) {
        this.addMember(conv.id, uid);
      }
    }
    return conv;
  }

  syncMergeQueueBotMember(convId: string, botId: string | null): void {
    this.sqlite
      .prepare(
        `DELETE FROM members
         WHERE conversation_id = ?
           AND user_id IN (SELECT id FROM users WHERE kind = 'bot')`,
      )
      .run(convId);
    if (botId) {
      this.addMember(convId, botId);
    }
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
  private static readonly MESSAGE_COLUMNS =
    "id, conversation_id, seq, author_id, thread_id, body, created_at";

  /**
   * Messages hydrate their ordered attachments from `message_artifacts`. The
   * join table is the only source of truth: an artifact is attached because a
   * caller said so, never because it happened to be the newest worker upload.
   */
  private hydrateMessages(rows: Array<Omit<MessageRow, "attachments">>): MessageRow[] {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(",");
    const attachmentRows = this.sqlite
      .prepare(
        `SELECT ma.message_id AS _message_id, a.*
         FROM message_artifacts ma
         JOIN artifacts a ON a.id = ma.artifact_id
         WHERE ma.message_id IN (${placeholders})
         ORDER BY ma.message_id ASC, ma.position ASC, a.created_at ASC`,
      )
      .all(...rows.map((r) => r.id)) as unknown as Array<ArtifactRow & { _message_id: string }>;
    const byMessage = new Map<string, ArtifactRow[]>();
    for (const { _message_id, ...artifact } of attachmentRows) {
      const list = byMessage.get(_message_id);
      if (list) {
        list.push(artifact as ArtifactRow);
      } else {
        byMessage.set(_message_id, [artifact as ArtifactRow]);
      }
    }
    return rows.map((row) => ({ ...row, attachments: byMessage.get(row.id) ?? [] }));
  }

  private hydrateMessage(row: Omit<MessageRow, "attachments">): MessageRow {
    return this.hydrateMessages([row])[0];
  }

  appendMessage(input: {
    id?: string;
    conversationId: string;
    authorId: string;
    body: string;
    threadId?: string | null;
    attachmentIds?: string[];
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
          `INSERT INTO messages (id, conversation_id, seq, author_id, thread_id, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          seq,
          input.authorId,
          input.threadId ?? null,
          input.body,
          now,
        );
      for (const artifactId of input.attachmentIds ?? []) {
        this.attachArtifact(id, artifactId);
      }
      return this.getMessage(id)!;
    });
  }

  /**
   * A proposal is an ordinary message in the #merge-queue conversation whose
   * attachments are declared explicitly. The linked `lands` row owns the branch.
   */
  createProposalMessage(input: {
    id?: string;
    conversationId: string;
    authorId: string;
    body: string;
    threadId?: string | null;
    attachmentIds?: string[];
  }): MessageRow {
    return this.appendMessage(input);
  }

  /** Amend an existing proposal message in place: rewrite the body and replace
   * the attachment set, preserving attachment order. */
  updateProposalMessage(
    messageId: string,
    patch: { body?: string; attachmentIds?: string[] },
  ): MessageRow {
    return this.transaction(() => {
      const existing = this.getMessage(messageId);
      if (!existing) throw new Error(`Message not found: ${messageId}`);
      if (patch.body !== undefined) {
        this.sqlite.prepare("UPDATE messages SET body = ? WHERE id = ?").run(patch.body, messageId);
      }
      if (patch.attachmentIds !== undefined) {
        this.setMessageAttachments(messageId, patch.attachmentIds);
      }
      return this.getMessage(messageId)!;
    });
  }

  /** Attach one artifact to a message (appended to the end of its list). */
  attachArtifact(messageId: string, artifactId: string): void {
    const message = this
      .sqlite
      .prepare("SELECT id FROM messages WHERE id = ?")
      .get(messageId) as { id: string } | undefined;
    if (!message) throw new Error(`Message not found: ${messageId}`);
    const artifact = this
      .sqlite
      .prepare("SELECT id FROM artifacts WHERE id = ?")
      .get(artifactId) as { id: string } | undefined;
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    const next = this.sqlite
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM message_artifacts WHERE message_id = ?")
      .get(messageId) as { next_pos: number };
    this.sqlite
      .prepare(
        "INSERT OR IGNORE INTO message_artifacts (message_id, artifact_id, position) VALUES (?, ?, ?)",
      )
      .run(messageId, artifactId, next.next_pos);
    this.sqlite.prepare("UPDATE artifacts SET message_id = ? WHERE id = ?").run(messageId, artifactId);
  }

  listMessageAttachments(messageId: string): ArtifactRow[] {
    return this.sqlite
      .prepare(
        `SELECT a.* FROM message_artifacts ma
         JOIN artifacts a ON a.id = ma.artifact_id
         WHERE ma.message_id = ?
         ORDER BY ma.position ASC, a.created_at ASC`,
      )
      .all(messageId) as unknown as ArtifactRow[];
  }

  /** Replace the message's attachment set with exactly `artifactIds`, in order. */
  setMessageAttachments(messageId: string, artifactIds: string[]): void {
    this.sqlite.prepare("DELETE FROM message_artifacts WHERE message_id = ?").run(messageId);
    this.sqlite
      .prepare("UPDATE artifacts SET message_id = NULL WHERE message_id = ?")
      .run(messageId);
    for (const artifactId of artifactIds) {
      this.attachArtifact(messageId, artifactId);
    }
  }

  getMessage(id: string): MessageRow | null {
    const row = this.sqlite
      .prepare(`SELECT ${KawanDb.MESSAGE_COLUMNS} FROM messages WHERE id = ?`)
      .get(id) as Omit<MessageRow, "attachments"> | undefined;
    return row ? this.hydrateMessage(row) : null;
  }

  listMessages(conversationId: string, since = 0, limit?: number): MessageRow[] {
    if (limit !== undefined) {
      const rows = this.sqlite
        .prepare(
          `SELECT ${KawanDb.MESSAGE_COLUMNS} FROM messages
           WHERE conversation_id = ? AND seq > ?
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(conversationId, since, limit) as unknown as Array<Omit<MessageRow, "attachments">>;
      return this.hydrateMessages(rows);
    }
    const rows = this.sqlite
      .prepare(
        `SELECT ${KawanDb.MESSAGE_COLUMNS} FROM messages
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq ASC`,
      )
      .all(conversationId, since) as unknown as Array<Omit<MessageRow, "attachments">>;
    return this.hydrateMessages(rows);
  }

  listRecentMessages(conversationId: string, limit = 20): MessageRow[] {
    const rows = this.sqlite
      .prepare(
        `SELECT ${KawanDb.MESSAGE_COLUMNS} FROM messages
         WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(conversationId, limit) as unknown as Array<Omit<MessageRow, "attachments">>;
    return this.hydrateMessages(rows).reverse();
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
    holdExpiresAt?: number | null;
    explicitWorkStart?: string | null;
    workRequest?: string | null;
  }): DecisionRow {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO decisions (
          id, conversation_id, message_id, bot_id, decision_type, destination,
          readiness, confidence, reason, raw_json, held_batch_id, dispatched,
          hold_expires_at, explicit_work_start, work_request, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.holdExpiresAt ?? null,
        input.explicitWorkStart ?? null,
        input.workRequest ?? null,
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

  listAllHeldDecisions(): Array<DecisionRow & { message: MessageRow }> {
    const rows = this.sqlite
      .prepare(
        `SELECT d.* FROM decisions d
         JOIN messages m ON m.id = d.message_id
         WHERE d.readiness = 'hold' AND d.dispatched = 0
         ORDER BY d.created_at ASC`,
      )
      .all() as unknown as DecisionRow[];
    return rows.map((d) => ({
      ...d,
      message: this.getMessage(d.message_id)!,
    }));
  }

  updateHeldExpiry(decisionIds: string[], holdExpiresAt: number | null): DecisionRow[] {
    if (decisionIds.length === 0) return [];
    const placeholders = decisionIds.map(() => "?").join(",");
    this.sqlite
      .prepare(`UPDATE decisions SET hold_expires_at = ? WHERE id IN (${placeholders})`)
      .run(holdExpiresAt, ...decisionIds);
    return this.sqlite
      .prepare(`SELECT * FROM decisions WHERE id IN (${placeholders})`)
      .all(...decisionIds) as unknown as DecisionRow[];
  }

  markDecisionsDispatched(decisionIds: string[], heldBatchId: string | null = null): DecisionRow[] {
    if (decisionIds.length === 0) return [];
    const placeholders = decisionIds.map(() => "?").join(",");
    this.sqlite
      .prepare(
        `UPDATE decisions
         SET dispatched = 1,
             hold_expires_at = NULL,
             held_batch_id = COALESCE(held_batch_id, ?)
         WHERE id IN (${placeholders})`,
      )
      .run(heldBatchId, ...decisionIds);
    return this.sqlite
      .prepare(`SELECT * FROM decisions WHERE id IN (${placeholders})`)
      .all(...decisionIds) as unknown as DecisionRow[];
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
         SET redirected_from = CASE
               WHEN ? != destination THEN COALESCE(redirected_from, destination)
               ELSE redirected_from
             END,
             redirected_by = ?,
             destination = ?,
             readiness = 'dispatch',
             dispatched = 1,
             hold_expires_at = NULL
         WHERE id = ?`,
      )
      .run(destination, redirectedBy, destination, id);
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
    title?: string | null;
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
          id, bot_id, parent_session_id, kind, conversation_id, thread_id, title,
          task, status, branch, clone_path, agent_dir, pi_session_file,
          soul_snapshot, token, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.parentSessionId ?? null,
        input.kind,
        input.conversationId ?? null,
        input.threadId ?? null,
        input.title ?? null,
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
             AND status NOT IN ('pending_approval', 'landed', 'archived', 'stopped')
           ORDER BY created_at ASC`,
        )
        .all(botId, conversationId) as unknown as SessionRow[];
    }
    return this.sqlite
      .prepare(
        `SELECT * FROM sessions
         WHERE bot_id = ? AND kind = 'worker'
           AND status NOT IN ('pending_approval', 'landed', 'archived', 'stopped')
         ORDER BY created_at ASC`,
      )
      .all(botId) as unknown as SessionRow[];
  }

  updateSession(
    id: string,
    patch: Partial<{
      status: SessionStatus;
      title: string | null;
      task: string | null;
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
          status = ?, title = ?, task = ?, branch = ?, clone_path = ?, agent_dir = ?, pi_session_file = ?,
          last_entry_id = ?, last_report = ?, conversation_id = ?, thread_id = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        patch.status ?? existing.status,
        patch.title !== undefined ? patch.title : existing.title,
        patch.task !== undefined ? patch.task : existing.task,
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

  /** Link an artifact to a message (kept as a thin alias for attachArtifact). */
  linkArtifactMessage(artifactId: string, messageId: string): void {
    this.attachArtifact(messageId, artifactId);
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
    messageId?: string | null;
    issueId?: string | null;
    trigger?: string;
  }): LandRow {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO lands (
          id, session_id, conversation_id, thread_id, message_id, issue_id, trigger, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.conversationId,
        input.threadId ?? null,
        input.messageId ?? null,
        input.issueId ?? null,
        input.trigger ?? "proposal",
        now,
        now,
      );
    return this.getLand(id)!;
  }

  getLand(id: string): LandRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM lands WHERE id = ?").get(id) as LandRow | undefined) ?? null
    );
  }

  listLands(filter?: { sessionId?: string; conversationId?: string; issueId?: string }): LandRow[] {
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
    if (filter?.issueId) {
      return this.sqlite
        .prepare("SELECT * FROM lands WHERE issue_id = ? ORDER BY created_at ASC")
        .all(filter.issueId) as unknown as LandRow[];
    }
    return this.sqlite.prepare("SELECT * FROM lands ORDER BY created_at ASC").all() as unknown as LandRow[];
  }

  nextQueuePosition(): number {
    const row = this.sqlite
      .prepare("SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_pos FROM lands")
      .get() as { next_pos: number };
    return row.next_pos;
  }

  listQueuedLands(): LandRow[] {
    return this.sqlite
      .prepare(
        `SELECT * FROM lands
         WHERE status IN ('queued', 'rebasing', 'verifying', 'paused')
         ORDER BY COALESCE(queue_position, 999999) ASC, created_at ASC`,
      )
      .all() as unknown as LandRow[];
  }

  /**
   * Proposals shown in the Merge Queue: waiting for a human **Merge** (or auto
   * mode) plus failed acceptances that still own their proposal message, so a
   * failure before entering the train cannot silently disappear.
   */
  listProposedLands(): LandRow[] {
    return this.sqlite
      .prepare(
        `SELECT * FROM lands WHERE status IN ('proposed', 'failed') ORDER BY updated_at DESC, created_at DESC`,
      )
      .all() as unknown as LandRow[];
  }

  updateLand(
    id: string,
    patch: Partial<{
      status: LandStatus;
      conversation_id: string;
      thread_id: string | null;
      message_id: string | null;
      approved_by: string | null;
      base_sha: string | null;
      landed_sha: string | null;
      verify_output: string | null;
      error: string | null;
      queue_position: number | null;
      issue_id: string | null;
      pause_reason: string | null;
      queue_session_id: string | null;
      queue_thread_id: string | null;
      trigger: string;
      checks_json: string | null;
      touches_kawan: number;
    }>,
  ): LandRow | null {
    const existing = this.getLand(id);
    if (!existing) return null;
    this.sqlite
      .prepare(
        `UPDATE lands SET
          status = ?, conversation_id = ?, thread_id = ?, message_id = ?, approved_by = ?, base_sha = ?, landed_sha = ?,
          verify_output = ?, error = ?, queue_position = ?, issue_id = ?, pause_reason = ?,
          queue_session_id = ?, queue_thread_id = ?, trigger = ?, checks_json = ?, touches_kawan = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        patch.status ?? existing.status,
        patch.conversation_id !== undefined ? patch.conversation_id : existing.conversation_id,
        patch.thread_id !== undefined ? patch.thread_id : existing.thread_id,
        patch.message_id !== undefined ? patch.message_id : existing.message_id,
        patch.approved_by !== undefined ? patch.approved_by : existing.approved_by,
        patch.base_sha !== undefined ? patch.base_sha : existing.base_sha,
        patch.landed_sha !== undefined ? patch.landed_sha : existing.landed_sha,
        patch.verify_output !== undefined ? patch.verify_output : existing.verify_output,
        patch.error !== undefined ? patch.error : existing.error,
        patch.queue_position !== undefined ? patch.queue_position : existing.queue_position,
        patch.issue_id !== undefined ? patch.issue_id : existing.issue_id,
        patch.pause_reason !== undefined ? patch.pause_reason : existing.pause_reason,
        patch.queue_session_id !== undefined ? patch.queue_session_id : existing.queue_session_id,
        patch.queue_thread_id !== undefined ? patch.queue_thread_id : existing.queue_thread_id,
        patch.trigger ?? existing.trigger ?? "proposal",
        patch.checks_json !== undefined ? patch.checks_json : existing.checks_json,
        patch.touches_kawan !== undefined ? patch.touches_kawan : existing.touches_kawan ?? 0,
        Date.now(),
        id,
      );
    return this.getLand(id);
  }

  // ---- Read Cursors ----
  getReadCursor(userId: string, conversationId: string): number {
    const row = this.sqlite
      .prepare("SELECT last_read_seq FROM read_cursors WHERE user_id = ? AND conversation_id = ?")
      .get(userId, conversationId) as { last_read_seq: number } | undefined;
    return row ? row.last_read_seq : 0;
  }

  listReadCursorsForUser(userId: string): Map<string, number> {
    const rows = this.sqlite
      .prepare("SELECT conversation_id, last_read_seq FROM read_cursors WHERE user_id = ?")
      .all(userId) as Array<{ conversation_id: string; last_read_seq: number }>;
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.conversation_id, r.last_read_seq);
    }
    return map;
  }

  markConversationRead(userId: string, conversationId: string, seq: number): ReadCursorRow {
    const clampedSeq = Math.max(0, Math.floor(seq));
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO read_cursors (user_id, conversation_id, last_read_seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, conversation_id) DO UPDATE SET
           last_read_seq = MAX(read_cursors.last_read_seq, excluded.last_read_seq),
           updated_at = excluded.updated_at`,
      )
      .run(userId, conversationId, clampedSeq, now);
    return this.sqlite
      .prepare("SELECT * FROM read_cursors WHERE user_id = ? AND conversation_id = ?")
      .get(userId, conversationId) as unknown as ReadCursorRow;
  }

  // ---- Issues ----
  nextIssueNumber(): number {
    const row = this.sqlite
      .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next_num FROM issues")
      .get() as { next_num: number };
    return row.next_num;
  }

  createIssue(input: {
    id?: string;
    number?: number;
    conversationId: string;
    title: string;
    bodyMd?: string;
    status?: IssueStatus;
    ownerId: string;
    implementerBotId?: string | null;
    activeSessionId?: string | null;
    parentIssueId?: string | null;
    needsInputQuestion?: string | null;
    behindMain?: number;
    commitsAhead?: number;
    checksStatus?: IssueChecksStatus;
    checksSha?: string | null;
    checksSummary?: string | null;
    checksJson?: string | null;
    checksArtifactId?: string | null;
    touchesKawan?: boolean | number;
  }): IssueRow {
    const id = input.id ?? randomUUID();
    const num = input.number ?? this.nextIssueNumber();
    const now = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO issues (
          id, number, conversation_id, title, body_md, status, owner_id,
          implementer_bot_id, active_session_id, parent_issue_id,
          needs_input_question, behind_main, commits_ahead,
          checks_status, checks_sha, checks_summary, checks_json, checks_artifact_id, touches_kawan,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        num,
        input.conversationId,
        input.title,
        input.bodyMd ?? "",
        input.status ?? "open",
        input.ownerId,
        input.implementerBotId ?? null,
        input.activeSessionId ?? null,
        input.parentIssueId ?? null,
        input.needsInputQuestion ?? null,
        input.behindMain ?? 0,
        input.commitsAhead ?? 0,
        input.checksStatus ?? "none",
        input.checksSha ?? null,
        input.checksSummary ?? null,
        input.checksJson ?? null,
        input.checksArtifactId ?? null,
        input.touchesKawan ? 1 : 0,
        now,
        now,
      );
    return this.getIssue(id)!;
  }

  getIssue(id: string): IssueRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined) ?? null
    );
  }

  getIssueByNumber(num: number): IssueRow | null {
    return (
      (this.sqlite.prepare("SELECT * FROM issues WHERE number = ?").get(num) as IssueRow | undefined) ??
      null
    );
  }

  getIssueByConversationId(conversationId: string): IssueRow | null {
    return (
      (this.sqlite
        .prepare("SELECT * FROM issues WHERE conversation_id = ?")
        .get(conversationId) as IssueRow | undefined) ?? null
    );
  }

  getIssueBySessionId(sessionId: string): IssueRow | null {
    return (
      (this.sqlite
        .prepare("SELECT * FROM issues WHERE active_session_id = ?")
        .get(sessionId) as IssueRow | undefined) ?? null
    );
  }

  listIssues(filter?: { status?: IssueStatus; ownerId?: string }): IssueRow[] {
    const clauses: string[] = [];
    const params: Array<string> = [];
    if (filter?.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.ownerId) {
      clauses.push("owner_id = ?");
      params.push(filter.ownerId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.sqlite
      .prepare(`SELECT * FROM issues ${where} ORDER BY number DESC`)
      .all(...params) as unknown as IssueRow[];
  }

  updateIssue(
    id: string,
    patch: Partial<{
      title: string;
      body_md: string;
      status: IssueStatus;
      owner_id: string;
      implementer_bot_id: string | null;
      active_session_id: string | null;
      parent_issue_id: string | null;
      needs_input_question: string | null;
      behind_main: number;
      commits_ahead: number;
      checks_status: IssueChecksStatus;
      checks_sha: string | null;
      checks_summary: string | null;
      checks_json: string | null;
      checks_artifact_id: string | null;
      touches_kawan: boolean | number;
    }>,
  ): IssueRow | null {
    const existing = this.getIssue(id);
    if (!existing) return null;
    const touchesKawan =
      patch.touches_kawan !== undefined
        ? patch.touches_kawan
          ? 1
          : 0
        : existing.touches_kawan;
    this.sqlite
      .prepare(
        `UPDATE issues SET
          title = ?, body_md = ?, status = ?, owner_id = ?, implementer_bot_id = ?,
          active_session_id = ?, parent_issue_id = ?, needs_input_question = ?,
          behind_main = ?, commits_ahead = ?,
          checks_status = ?, checks_sha = ?, checks_summary = ?, checks_json = ?,
          checks_artifact_id = ?, touches_kawan = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        patch.title !== undefined ? patch.title : existing.title,
        patch.body_md !== undefined ? patch.body_md : existing.body_md,
        patch.status !== undefined ? patch.status : existing.status,
        patch.owner_id !== undefined ? patch.owner_id : existing.owner_id,
        patch.implementer_bot_id !== undefined ? patch.implementer_bot_id : existing.implementer_bot_id,
        patch.active_session_id !== undefined ? patch.active_session_id : existing.active_session_id,
        patch.parent_issue_id !== undefined ? patch.parent_issue_id : existing.parent_issue_id,
        patch.needs_input_question !== undefined
          ? patch.needs_input_question
          : existing.needs_input_question,
        patch.behind_main !== undefined ? patch.behind_main : existing.behind_main,
        patch.commits_ahead !== undefined ? patch.commits_ahead : existing.commits_ahead,
        patch.checks_status !== undefined ? patch.checks_status : existing.checks_status,
        patch.checks_sha !== undefined ? patch.checks_sha : existing.checks_sha,
        patch.checks_summary !== undefined ? patch.checks_summary : existing.checks_summary,
        patch.checks_json !== undefined ? patch.checks_json : existing.checks_json,
        patch.checks_artifact_id !== undefined ? patch.checks_artifact_id : existing.checks_artifact_id,
        touchesKawan,
        Date.now(),
        id,
      );
    return this.getIssue(id);
  }

  serializeIssue(issue: IssueRow): SerializedIssue {
    let checks: CheckRunItem[] = [];
    if (issue.checks_json) {
      try {
        const parsed = JSON.parse(issue.checks_json);
        if (Array.isArray(parsed)) checks = parsed as CheckRunItem[];
      } catch {
        checks = [];
      }
    }
    return {
      ...issue,
      checks,
      touches_kawan: Boolean(issue.touches_kawan),
      active_reviewers: [],
    };
  }
}

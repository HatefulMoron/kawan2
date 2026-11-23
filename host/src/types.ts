export type UserKind = "human" | "bot";
export type UserRole = "admin" | "member";
export type ConversationKind = "channel" | "dm" | "issue" | "merge_queue";
export type DecisionReadiness = "dispatch" | "hold";
export type SessionKind = "orchestrator" | "worker" | "queue" | "reviewer";
export type SessionStatus =
  | "not_started"
  | "pending_approval"
  | "running"
  | "idle"
  | "review_requested"
  | "landed"
  | "failed"
  | "archived"
  | "stopped";
export type LandStatus =
  | "requested"
  | "queued"
  | "rebasing"
  | "verifying"
  | "paused"
  | "landed"
  | "failed"
  | "removed";
export type MergeConflictPolicy = "pause_on_issue" | "auto_resolve_trivial";
export type LandingMode = "manual" | "auto";

export interface UserRow {
  id: string;
  kind: UserKind;
  role: UserRole;
  name: string;
  email: string | null;
  persona: string | null;
  model: string | null;
  thinking_level: string | null;
  sandbox_enabled: number;
  sandbox_network: number;
  signing_key_path: string | null;
  signing_pubkey: string | null;
  created_at: number;
}

export interface KeyRow {
  id: string;
  user_id: string;
  fingerprint: string;
  pubkey: string;
  created_at: number;
}

export interface InviteRow {
  token: string;
  created_by: string;
  note: string | null;
  expires_at: number;
  used_by: string | null;
  used_at: number | null;
  created_at: number;
}

export interface ConversationRow {
  id: string;
  kind: ConversationKind;
  name: string | null;
  topic: string | null;
  next_seq: number;
  created_at: number;
}

export interface MemberRow {
  conversation_id: string;
  user_id: string;
  joined_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  author_id: string;
  thread_id: string | null;
  body: string;
  artifact_id: string | null;
  created_at: number;
}

export interface DecisionRow {
  id: string;
  conversation_id: string;
  message_id: string;
  bot_id: string;
  decision_type: string;
  destination: string;
  readiness: DecisionReadiness;
  confidence: number;
  reason: string;
  raw_json: string;
  held_batch_id: string | null;
  dispatched: number;
  redirected_from: string | null;
  redirected_by: string | null;
  hold_expires_at: number | null;
  explicit_work_start?: string | null;
  work_request?: string | null;
  created_at: number;
}

export interface SessionRow {
  id: string;
  bot_id: string;
  parent_session_id: string | null;
  kind: SessionKind;
  conversation_id: string | null;
  thread_id: string | null;
  title: string | null;
  task: string | null;
  status: SessionStatus;
  branch: string | null;
  clone_path: string | null;
  agent_dir: string | null;
  pi_session_file: string | null;
  last_entry_id: string | null;
  last_report: string | null;
  soul_snapshot: string | null;
  token: string;
  created_at: number;
  updated_at: number;
}

export interface ArtifactRow {
  id: string;
  sha256: string;
  mime_type: string;
  byte_size: number;
  filename: string | null;
  session_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  created_at: number;
}

export interface SoulRow {
  id: string;
  bot_id: string;
  revision: number;
  content: string;
  diff: string;
  author_session_id: string | null;
  created_at: number;
}

export interface CheckRunItem {
  name: string;
  ok: boolean;
  exit_code: number | null;
  duration_ms: number;
  output: string;
  artifact_id?: string | null;
}

export interface RepoCheckResult {
  ok: boolean;
  source: "kawan_checks" | "kawan_ci" | "verify_command";
  checks: CheckRunItem[];
  summary: string;
  combined_output: string;
}

export interface LandRow {
  id: string;
  session_id: string;
  conversation_id: string;
  thread_id: string | null;
  message_id: string | null;
  status: LandStatus;
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
  created_at: number;
  updated_at: number;
}

export interface SerializedLand extends Omit<LandRow, "touches_kawan"> {
  checks: CheckRunItem[];
  touches_kawan: boolean;
}

export function serializeLand(land: LandRow): SerializedLand {
  let checks: CheckRunItem[] = [];
  if (land.checks_json) {
    try {
      const parsed = JSON.parse(land.checks_json);
      if (Array.isArray(parsed)) checks = parsed as CheckRunItem[];
    } catch {
      checks = [];
    }
  }
  return {
    ...land,
    checks,
    touches_kawan: Boolean(land.touches_kawan),
  };
}

export interface RepoSettings {
  url: string;
  default_branch: string;
  bare_path: string;
  https_token?: string;
}

export interface ModelDefinition {
  id: string;
  name: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  baseUrl?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

export interface ProviderSettings {
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  apiKey?: string;
  authHeader?: boolean;
  models: ModelDefinition[];
}

export interface DecisionRoleSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface DefaultRoleSettings {
  provider: string;
  model: string;
  thinking_level?: string;
}

export interface MergeQueueSettings {
  bot_id?: string | null;
  default_landing_mode?: LandingMode;
  conflict_policy?: MergeConflictPolicy;
  paused?: boolean;
}

export interface HostSettings {
  repo?: RepoSettings;
  verify_command?: string;
  merge_queue?: MergeQueueSettings;
  providers: Record<string, ProviderSettings>;
  roles: {
    default?: DefaultRoleSettings;
    decision?: DecisionRoleSettings;
  };
}

export interface ClientRequest {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface WsResponseFrame {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface WsEventFrame {
  type: string;
  [key: string]: unknown;
}

export interface ReadCursorRow {
  user_id: string;
  conversation_id: string;
  last_read_seq: number;
  updated_at: number;
}

export interface SessionDiffFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  patch: string;
}

export interface SessionDiffSummary {
  available: boolean;
  base_ref: string | null;
  head_ref: string | null;
  files_changed: number;
  insertions: number;
  deletions: number;
  truncated: boolean;
  files: SessionDiffFile[];
  note?: string;
}

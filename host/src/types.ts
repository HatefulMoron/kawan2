export type UserKind = "human" | "bot";
export type UserRole = "admin" | "member";
export type ConversationKind = "channel" | "dm";
export type DecisionReadiness = "dispatch" | "hold";
export type SessionKind = "orchestrator" | "worker";
export type SessionStatus =
  | "not_started"
  | "running"
  | "idle"
  | "review_requested"
  | "landed"
  | "failed"
  | "archived"
  | "stopped";
export type LandStatus = "requested" | "verifying" | "landed" | "failed";

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
  created_at: number;
  updated_at: number;
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

export interface HostSettings {
  repo?: RepoSettings;
  verify_command?: string;
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

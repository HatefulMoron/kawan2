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
  | "landed"
  | "failed"
  | "archived"
  | "stopped";
/**
 * A proposal is a message plus a `lands` row. `proposed` is the open state a
 * human (or auto mode) accepts into the train with **Merge**; `withdrawn` is
 * the agent/owner pulling it back. Nothing else about the train changed.
 */
export type LandStatus =
  | "proposed"
  | "queued"
  | "rebasing"
  | "verifying"
  | "paused"
  | "landed"
  | "failed"
  | "withdrawn";
/** Statuses that still own the branch/session and are worth amending. */
export const OPEN_LAND_STATUSES: LandStatus[] = [
  "proposed",
  "queued",
  "rebasing",
  "verifying",
  "paused",
  "failed",
];
export type MergeConflictPolicy = "pause_on_issue" | "auto_resolve_trivial";
export type LandingMode = "manual" | "auto";
export type IssueStatus = "open" | "landed" | "closed";
export type IssueChecksStatus = "none" | "running" | "passed" | "failed";

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

export interface MessageAuthor {
  id: string;
  kind: UserKind;
  name: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  author_id: string;
  thread_id: string | null;
  body: string;
  created_at: number;
  /** Ordered by `message_artifacts.position`; empty when the message has none. */
  attachments: ArtifactRow[];
}

/** Wire shape for `message.*` frames: ordinary fields plus explicit attachments. */
export function serializeMessage(message: MessageRow): MessageRow {
  return {
    ...message,
    attachments: message.attachments ?? [],
  };
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
  source: "kawan_checks" | "kawan_ci" | "verify_command" | "none";
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

/**
 * One open proposal row in the Merge Queue's `Proposed (N)` section. The
 * proposal body lives on `message`; `land` owns the branch.
 */
export interface ProposalCard {
  land: SerializedLand;
  message: MessageRow;
  author: MessageAuthor;
  session_title: string | null;
  checks: CheckRunItem[];
  commits_ahead: number;
  behind_main: number;
  issue_number: number | null;
  updated_at: number;
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

export interface ActiveReviewerInfo {
  session_id: string;
  bot_id: string;
  bot_name: string;
  focus: string | null;
}

export interface IssueRow {
  id: string;
  number: number;
  conversation_id: string;
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
  touches_kawan: number;
  created_at: number;
  updated_at: number;
}

export interface SerializedIssue extends Omit<IssueRow, "touches_kawan"> {
  checks: CheckRunItem[];
  touches_kawan: boolean;
  active_reviewers: ActiveReviewerInfo[];
}

//! Wire protocol types matching the TypeScript host (`host/src/ws.ts`, `host/src/server.ts`)
//! and tested against recorded protocol fixtures (`host/fixtures/protocol/slice*.jsonl`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupStatus {
    pub has_repo: bool,
    pub has_models: bool,
    pub has_decision_model: bool,
    pub has_bot: bool,
    pub ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserSummary {
    pub id: String,
    pub kind: String,
    pub role: String,
    pub name: String,
    pub email: Option<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub kind: String,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub next_seq: u64,
    pub created_at: u64,
    #[serde(default)]
    pub last_seq: u64,
    #[serde(default)]
    pub last_read_seq: u64,
    #[serde(default)]
    pub unread_count: u64,
    #[serde(default)]
    pub members: Vec<Member>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub seq: u64,
    pub author_id: String,
    pub thread_id: Option<String>,
    pub body: String,
    pub artifact_id: Option<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageAuthor {
    pub id: String,
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Decision {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub bot_id: String,
    pub decision_type: String,
    pub destination: String,
    pub readiness: String,
    pub confidence: f64,
    pub reason: String,
    pub raw_json: String,
    pub held_batch_id: Option<String>,
    pub dispatched: u64,
    pub redirected_from: Option<String>,
    pub redirected_by: Option<String>,
    #[serde(default)]
    pub hold_expires_at: Option<u64>,
    #[serde(default)]
    pub explicit_work_start: Option<String>,
    #[serde(default)]
    pub work_request: Option<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotSummary {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub email: Option<String>,
    pub persona: Option<String>,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub sandbox_enabled: bool,
    pub sandbox_network: bool,
    pub signing_pubkey: Option<String>,
    pub orchestrator_session_id: Option<String>,
    pub orchestrator_status: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: String,
    pub bot_id: String,
    pub parent_session_id: Option<String>,
    pub kind: String,
    pub conversation_id: Option<String>,
    pub thread_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    pub task: Option<String>,
    pub status: String,
    pub branch: Option<String>,
    pub clone_path: Option<String>,
    pub agent_dir: Option<String>,
    pub pi_session_file: Option<String>,
    pub last_entry_id: Option<String>,
    pub last_report: Option<String>,
    pub soul_snapshot: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artifact {
    pub id: String,
    pub sha256: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub filename: Option<String>,
    pub session_id: Option<String>,
    pub conversation_id: Option<String>,
    pub message_id: Option<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckRunItem {
    pub name: String,
    pub ok: bool,
    pub exit_code: Option<i64>,
    pub duration_ms: u64,
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub artifact_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Land {
    pub id: String,
    pub session_id: String,
    pub conversation_id: String,
    pub thread_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    pub status: String,
    pub approved_by: Option<String>,
    pub base_sha: Option<String>,
    pub landed_sha: Option<String>,
    pub verify_output: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub queue_position: Option<u64>,
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(default)]
    pub pause_reason: Option<String>,
    #[serde(default)]
    pub queue_session_id: Option<String>,
    #[serde(default)]
    pub queue_thread_id: Option<String>,
    #[serde(default)]
    pub trigger: Option<String>,
    #[serde(default)]
    pub checks: Vec<CheckRunItem>,
    #[serde(default)]
    pub touches_kawan: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

fn default_landing_mode_str() -> String {
    "manual".to_string()
}

fn default_conflict_policy_str() -> String {
    "pause_on_issue".to_string()
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeQueueSettingsView {
    #[serde(default)]
    pub bot_id: Option<String>,
    #[serde(default = "default_landing_mode_str")]
    pub default_landing_mode: String,
    #[serde(default = "default_conflict_policy_str")]
    pub conflict_policy: String,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeQueueSnapshot {
    pub conversation_id: String,
    #[serde(default)]
    pub settings: MergeQueueSettingsView,
    #[serde(default)]
    pub head: Option<Land>,
    #[serde(default)]
    pub queued: Vec<Land>,
    #[serde(default)]
    pub paused_land: Option<Land>,
    #[serde(default)]
    pub recent_landed: Vec<Land>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeQueueReadData {
    pub queue: MergeQueueSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionActionData {
    pub session: SessionSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoSettingsView {
    pub url: String,
    pub default_branch: String,
    pub bare_path: String,
    #[serde(default)]
    pub https_token_configured: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelDefView {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default, rename = "contextWindow")]
    pub context_window: Option<u64>,
    #[serde(default, rename = "maxTokens")]
    pub max_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderView {
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub api: String,
    #[serde(default, rename = "authHeader")]
    pub auth_header: bool,
    #[serde(default, rename = "apiKeyConfigured")]
    pub api_key_configured: bool,
    #[serde(default)]
    pub models: Vec<ModelDefView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DefaultRoleView {
    pub provider: String,
    pub model: String,
    pub thinking_level: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionRoleView {
    pub provider: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub model: String,
    #[serde(default, rename = "apiKeyConfigured")]
    pub api_key_configured: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RolesView {
    pub default: Option<DefaultRoleView>,
    pub decision: Option<DecisionRoleView>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SettingsView {
    pub host_ssh_pubkey: Option<String>,
    pub repo: Option<RepoSettingsView>,
    pub verify_command: Option<String>,
    #[serde(default)]
    pub providers: HashMap<String, ProviderView>,
    #[serde(default)]
    pub roles: RolesView,
    #[serde(default)]
    pub merge_queue: Option<MergeQueueSettingsView>,
    #[serde(default)]
    pub setup: SetupStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelTestOutcome {
    pub ok: bool,
    pub latency_ms: u64,
    pub sample: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelsTestData {
    pub default: ModelTestOutcome,
    pub decision: ModelTestOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationListData {
    pub conversations: Vec<Conversation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationCreateData {
    pub conversation: Conversation,
    #[serde(default)]
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationOpenData {
    pub conversation: Conversation,
    pub members: Vec<Member>,
    pub messages: Vec<Message>,
    pub decisions: Vec<Decision>,
    pub sessions: Vec<SessionSummary>,
    pub artifacts: Vec<Artifact>,
    pub lands: Vec<Land>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserListData {
    pub users: Vec<UserSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotListData {
    pub bots: Vec<BotSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotCreateData {
    pub bot: BotSummary,
    pub session: Option<SessionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionListData {
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionOpenData {
    pub session: SessionSummary,
    pub artifacts: Vec<Artifact>,
    pub lands: Vec<Land>,
    pub entries: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactGetData {
    pub artifact: Artifact,
    pub base64: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LandApproveData {
    pub land: Land,
    pub session: SessionSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteCreateData {
    pub token: String,
    pub link: String,
    pub expires_at: u64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusRepoInfo {
    pub url: String,
    pub default_branch: String,
    pub head_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueReviewer {
    pub id: String,
    pub issue_id: String,
    pub bot_id: String,
    #[serde(default)]
    pub focus: Option<String>,
    #[serde(default)]
    pub order_index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueReview {
    pub id: String,
    pub issue_id: String,
    pub round: u64,
    pub reviewer_slot_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub verdict: String,
    pub summary: String,
    #[serde(default)]
    pub notes_artifact_id: Option<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueSummary {
    pub id: String,
    pub number: u64,
    pub conversation_id: String,
    pub title: String,
    #[serde(default)]
    pub body_md: String,
    pub status: String,
    pub owner_id: String,
    #[serde(default)]
    pub implementer_bot_id: Option<String>,
    #[serde(default)]
    pub auto_start_review: bool,
    #[serde(default)]
    pub landing_mode: String,
    #[serde(default)]
    pub max_rounds: u64,
    #[serde(default)]
    pub current_round: u64,
    #[serde(default)]
    pub active_session_id: Option<String>,
    #[serde(default)]
    pub parent_issue_id: Option<String>,
    #[serde(default)]
    pub needs_input_question: Option<String>,
    #[serde(default)]
    pub behind_main: u64,
    #[serde(default)]
    pub reviewers: Vec<IssueReviewer>,
    #[serde(default)]
    pub reviews: Vec<IssueReview>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueListData {
    pub issues: Vec<IssueSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueActionData {
    pub issue: IssueSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueAssignData {
    pub issue: IssueSummary,
    pub session: SessionSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssuePromoteData {
    pub issue: IssueSummary,
    pub conversation: Conversation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueSyncData {
    pub ok: bool,
    pub behind_before: u64,
    pub behind_after: u64,
    #[serde(default)]
    pub error: Option<String>,
    pub issue: IssueSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueStartReviewData {
    pub issue: IssueSummary,
    pub ok: bool,
    #[serde(default)]
    pub checks: Vec<CheckRunItem>,
    #[serde(default)]
    pub land: Option<Land>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IssueOpenData {
    pub issue: IssueSummary,
    pub conversation: Conversation,
    pub members: Vec<Member>,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub decisions: Vec<Decision>,
    pub sessions: Vec<SessionSummary>,
    pub artifacts: Vec<Artifact>,
    pub lands: Vec<Land>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusReadData {
    pub repo: Option<StatusRepoInfo>,
    #[serde(default)]
    pub sessions: Vec<SessionSummary>,
    #[serde(default)]
    pub lands: Vec<Land>,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
    #[serde(default)]
    pub issues: Vec<IssueSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationMarkReadData {
    pub conversation_id: String,
    pub last_read_seq: u64,
    pub unread_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDiffFile {
    pub path: String,
    pub status: String,
    pub insertions: u64,
    pub deletions: u64,
    pub patch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDiffSummary {
    pub available: bool,
    pub base_ref: Option<String>,
    pub head_ref: Option<String>,
    pub files_changed: u64,
    pub insertions: u64,
    pub deletions: u64,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub files: Vec<SessionDiffFile>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDiffData {
    pub session_id: String,
    pub diff: SessionDiffSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerFrame {
    #[serde(rename = "challenge")]
    Challenge {
        #[serde(default)]
        id: Option<String>,
        nonce: String,
        namespace: String,
        expires: u64,
    },
    #[serde(rename = "welcome")]
    Welcome {
        #[serde(default)]
        id: Option<String>,
        user: String,
        name: String,
        role: String,
        setup: SetupStatus,
    },
    #[serde(rename = "response")]
    Response {
        #[serde(default)]
        id: Option<String>,
        command: String,
        success: bool,
        #[serde(default)]
        data: Option<Value>,
        #[serde(default)]
        error: Option<String>,
    },
    #[serde(rename = "conversation.new")]
    ConversationNew { conversation: Conversation },
    #[serde(rename = "message.new")]
    MessageNew {
        message: Message,
        author: MessageAuthor,
    },
    #[serde(rename = "decision.new")]
    DecisionNew { decision: Decision },
    #[serde(rename = "bot.update")]
    BotUpdate { bot: BotSummary },
    #[serde(rename = "session.update")]
    SessionUpdate { session: SessionSummary },
    #[serde(rename = "artifact.new")]
    ArtifactNew { artifact: Artifact },
    #[serde(rename = "land.update")]
    LandUpdate { land: Land },
    #[serde(rename = "merge_queue.update")]
    MergeQueueUpdate { queue: Box<MergeQueueSnapshot> },
    #[serde(rename = "issue.update")]
    IssueUpdate { issue: Box<IssueSummary> },
    #[serde(rename = "read_cursor.update")]
    ReadCursorUpdate {
        conversation_id: String,
        last_read_seq: u64,
        unread_count: u64,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        conversation_id: Option<String>,
        #[serde(default)]
        message_id: Option<String>,
        #[serde(default)]
        bot_id: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        scope: Option<String>,
        message: String,
    },
}

pub fn parse_invite_link(raw: &str) -> Option<(String, String)> {
    let trimmed = raw.trim();
    let rest = trimmed.strip_prefix("kawan://")?;
    let (host, token) = rest.split_once('/')?;
    if host.is_empty() || token.is_empty() {
        return None;
    }
    Some((format!("ws://{host}"), token.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    struct RecordedEntry {
        dir: String,
        frame: Value,
    }

    #[test]
    fn parses_all_recorded_protocol_fixtures() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("host/fixtures/protocol");
        let files = [
            "slice1.jsonl",
            "slice2.jsonl",
            "slice3.jsonl",
            "slice4.jsonl",
            "slice5.jsonl",
        ];

        let mut total_s2c = 0usize;
        let mut total_c2s = 0usize;

        for name in files {
            let path = root.join(name);
            let raw = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("failed reading {}: {e}", path.display()));
            for (line_idx, line) in raw.lines().enumerate() {
                if line.trim().is_empty() {
                    continue;
                }
                let entry: RecordedEntry = serde_json::from_str(line).unwrap_or_else(|e| {
                    panic!("{name}:{}: invalid wrapper JSON: {e}", line_idx + 1)
                });
                if entry.dir == "c2s" {
                    total_c2s += 1;
                    assert!(
                        entry.frame.get("type").and_then(Value::as_str).is_some(),
                        "{name}:{}: c2s missing type",
                        line_idx + 1
                    );
                    continue;
                }
                assert_eq!(entry.dir, "s2c");
                total_s2c += 1;
                let frame: ServerFrame = serde_json::from_value(entry.frame.clone())
                    .unwrap_or_else(|e| {
                        panic!(
                            "{name}:{}: failed to parse ServerFrame: {e}\n{}",
                            line_idx + 1,
                            entry.frame
                        )
                    });

                if let ServerFrame::Response {
                    command,
                    success: true,
                    data: Some(data),
                    ..
                } = frame
                {
                    match command.as_str() {
                        "conversation.list" => {
                            let _: ConversationListData = serde_json::from_value(data).unwrap();
                        }
                        "conversation.create" | "conversation.add_member" => {
                            let _: ConversationCreateData = serde_json::from_value(data).unwrap();
                        }
                        "conversation.open" => {
                            let _: ConversationOpenData = serde_json::from_value(data).unwrap();
                        }
                        "bot.list" => {
                            let _: BotListData = serde_json::from_value(data).unwrap();
                        }
                        "bot.create" | "bot.update" => {
                            let _: BotCreateData = serde_json::from_value(data).unwrap();
                        }
                        "session.list" => {
                            let _: SessionListData = serde_json::from_value(data).unwrap();
                        }
                        "session.open" => {
                            let _: SessionOpenData = serde_json::from_value(data).unwrap();
                        }
                        "artifact.get" => {
                            let _: ArtifactGetData = serde_json::from_value(data).unwrap();
                        }
                        "land.approve" => {
                            let _: LandApproveData = serde_json::from_value(data).unwrap();
                        }
                        "settings.read" | "settings.update" => {
                            let _: SettingsView = serde_json::from_value(data).unwrap();
                        }
                        "models.test" => {
                            let _: ModelsTestData = serde_json::from_value(data).unwrap();
                        }
                        "invite.create" => {
                            let _: InviteCreateData = serde_json::from_value(data).unwrap();
                        }
                        _ => {}
                    }
                }
            }
        }

        assert!(total_c2s > 20, "expected recorded c2s frames");
        assert!(total_s2c > 30, "expected recorded s2c frames");
    }

    #[test]
    fn parses_invite_links() {
        assert_eq!(
            parse_invite_link("kawan://127.0.0.1:8787/abc123"),
            Some(("ws://127.0.0.1:8787".to_string(), "abc123".to_string()))
        );
        assert_eq!(parse_invite_link("https://example.com/abc"), None);
    }
}

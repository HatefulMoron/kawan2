//! Client state machine, WebSocket event reducer, form state, and keyboard dispatch.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use gpui::{Context, FocusHandle, Image, ImageFormat, KeyDownEvent, Task};
use serde_json::{Value, json};

use crate::mock;
use crate::protocol::{
    Artifact, ArtifactGetData, BotCreateData, BotListData, BotSummary, Conversation,
    ConversationCreateData, ConversationListData, ConversationMarkReadData, ConversationOpenData,
    Decision, InviteCreateData, IssueActionData, IssueLandData, IssueListData, IssueOpenData,
    IssuePromoteData, IssueSummary, IssueSyncData, Land, LandMergeData, Member, MergeQueueReadData,
    MergeQueueSnapshot, Message, ModelsTestData, ProposalCard, ServerFrame, SessionActionData,
    SessionDiffData, SessionDiffSummary, SessionListData, SessionOpenData, SessionSummary,
    SettingsView, SetupStatus, UserListData, UserSummary, parse_invite_link,
};
use crate::ssh::default_ssh_key_path;
use crate::ws_client::{AuthMode, ConnectConfig, WsEvent, WsHandle};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Screen {
    Connect,
    Checklist,
    Workspace(WorkspacePage),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspacePage {
    MergeQueue,
    Issues,
    IssueDetail(String),
    Conversation,
    Settings(SettingsTab),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsTab {
    Repository,
    Models,
    Bots,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionDrawerTab {
    Overview,
    Changes,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RightPanel {
    None,
    Thread(String),
    Session(String),
    Artifact(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusTarget {
    ConnectHost,
    ConnectToken,
    ConnectName,
    ConnectKeyPath,
    Composer,
    ThreadComposer,
    NewChannelName,
    RepoUrl,
    RepoBranch,
    RepoVerifyCmd,
    ProviderName,
    ProviderBaseUrl,
    ProviderModelId,
    ProviderApiKey,
    DecisionBaseUrl,
    DecisionModel,
    DecisionApiKey,
    BotName,
    BotPersona,
    BotModel,
    BotThinking,
    InviteNote,
    IssueTitle,
    IssueBody,
    IssueEditTitle,
    IssueEditBody,
}

#[derive(Clone)]
pub struct LoadedArtifact {
    pub text_preview: Option<String>,
    pub image: Option<Arc<Image>>,
}

#[derive(Debug, Clone)]
pub struct ConversationError {
    pub message: String,
}

pub struct KawanApp {
    pub focus_handle: FocusHandle,
    pub focus_target: FocusTarget,
    pub screen: Screen,
    pub is_mock: bool,

    // Connection & auth
    pub auth_mode: AuthMode,
    pub connect_host: String,
    pub connect_token: String,
    pub connect_name: String,
    pub connect_key_path: String,
    pub connecting: bool,
    pub connect_error: Option<String>,

    // Logged-in identity & setup
    pub current_user_id: String,
    pub current_user_name: String,
    pub current_user_role: String,
    pub setup: SetupStatus,
    pub settings: SettingsView,
    pub models_test_result: Option<ModelsTestData>,
    pub models_test_pending: bool,
    pub status_banner: Option<String>,
    pub error_banner: Option<String>,

    // Workspace data
    pub users: Vec<UserSummary>,
    pub bots: Vec<BotSummary>,
    pub conversations: Vec<Conversation>,
    pub active_conversation_id: Option<String>,
    pub members_by_conv: HashMap<String, Vec<Member>>,
    pub messages_by_conv: HashMap<String, Vec<Message>>,
    pub decisions_by_conv: HashMap<String, Vec<Decision>>,
    pub sessions_by_id: HashMap<String, SessionSummary>,
    pub artifacts_by_id: HashMap<String, Artifact>,
    pub lands_by_id: HashMap<String, Land>,
    pub merge_queue: Option<MergeQueueSnapshot>,
    /// Land armed by a first **Merge** click when checks are red or the branch
    /// touches `.kawan/`; the second click actually accepts it.
    pub confirm_merge: Option<String>,
    pub issues_by_id: HashMap<String, IssueSummary>,
    pub conv_errors: HashMap<String, Vec<ConversationError>>,
    pub loaded_artifacts: HashMap<String, LoadedArtifact>,
    pub session_entries: HashMap<String, Vec<Value>>,

    // Conversation interactive state
    pub composer_text: String,
    pub thread_composer_text: String,
    pub right_panel: RightPanel,
    pub session_drawer_tab: SessionDrawerTab,
    pub session_diffs: HashMap<String, SessionDiffSummary>,
    pub session_diff_loading: HashSet<String>,
    pub selected_diff_file: HashMap<String, String>,
    pub redirect_menu_decision_id: Option<String>,
    pub show_add_member: bool,
    pub show_new_channel: bool,
    pub new_channel_name: String,

    // Issues view state
    pub issue_filter: String,
    pub show_new_issue_form: bool,
    pub new_issue_title: String,
    pub new_issue_body: String,
    pub editing_issue_id: Option<String>,
    pub edit_issue_title: String,
    pub edit_issue_body: String,
    pub collapsed_issue_docs: HashSet<String>,

    // Settings form state
    pub repo_url_input: String,
    pub repo_branch_input: String,
    pub repo_verify_input: String,
    pub provider_name_input: String,
    pub provider_base_url_input: String,
    pub provider_model_input: String,
    pub provider_api_key_input: String,
    pub decision_base_url_input: String,
    pub decision_model_input: String,
    pub decision_api_key_input: String,

    // Bot editor state
    pub editing_bot_id: Option<String>,
    pub bot_name_input: String,
    pub bot_persona_input: String,
    pub bot_model_input: String,
    pub bot_thinking_input: String,
    pub bot_sandbox_enabled: bool,
    pub bot_sandbox_network: bool,

    // Admin invite creator
    pub invite_note_input: String,
    pub last_invite_link: Option<String>,

    // WS transport
    ws: Option<WsHandle>,
    pending_commands: HashMap<String, String>,
    _poll_task: Option<Task<()>>,
    last_hold_tick_sec: u64,
}

impl KawanApp {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let is_mock = std::env::var("KAWAN_MOCK").as_deref() == Ok("1");
        let default_host = std::env::var("KAWAN_HOST_URL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "ws://127.0.0.1:8787".to_string());
        let default_key = default_ssh_key_path();
        let default_auth_mode = match std::env::var("KAWAN_AUTH_MODE")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "login" => AuthMode::Login,
            "register" | "invite" => AuthMode::Register,
            _ => AuthMode::Bootstrap,
        };
        let default_name = std::env::var("KAWAN_USER_NAME")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "alice".to_string());

        let mut app = Self {
            focus_handle: cx.focus_handle(),
            focus_target: FocusTarget::ConnectHost,
            screen: Screen::Connect,
            is_mock,

            auth_mode: default_auth_mode,
            connect_host: default_host,
            connect_token: std::env::var("KAWAN_BOOTSTRAP_TOKEN").unwrap_or_default(),
            connect_name: default_name,
            connect_key_path: default_key,
            connecting: false,
            connect_error: None,

            current_user_id: String::new(),
            current_user_name: String::new(),
            current_user_role: "admin".to_string(),
            setup: SetupStatus::default(),
            settings: SettingsView::default(),
            models_test_result: None,
            models_test_pending: false,
            status_banner: None,
            error_banner: None,

            users: Vec::new(),
            bots: Vec::new(),
            conversations: Vec::new(),
            active_conversation_id: None,
            members_by_conv: HashMap::new(),
            messages_by_conv: HashMap::new(),
            decisions_by_conv: HashMap::new(),
            sessions_by_id: HashMap::new(),
            artifacts_by_id: HashMap::new(),
            lands_by_id: HashMap::new(),
            merge_queue: None,
            confirm_merge: None,
            issues_by_id: HashMap::new(),
            conv_errors: HashMap::new(),
            loaded_artifacts: HashMap::new(),
            session_entries: HashMap::new(),

            composer_text: String::new(),
            thread_composer_text: String::new(),
            right_panel: RightPanel::None,
            session_drawer_tab: SessionDrawerTab::Overview,
            session_diffs: HashMap::new(),
            session_diff_loading: HashSet::new(),
            selected_diff_file: HashMap::new(),
            redirect_menu_decision_id: None,
            show_add_member: false,
            show_new_channel: false,
            new_channel_name: String::new(),

            issue_filter: "all".to_string(),
            show_new_issue_form: false,
            new_issue_title: String::new(),
            new_issue_body: String::new(),
            editing_issue_id: None,
            edit_issue_title: String::new(),
            edit_issue_body: String::new(),
            collapsed_issue_docs: HashSet::new(),

            repo_url_input: String::new(),
            repo_branch_input: "main".to_string(),
            repo_verify_input: String::new(),
            provider_name_input: "lithosai".to_string(),
            provider_base_url_input: "https://api.lithosai.cloud/v1".to_string(),
            provider_model_input: "deepseek-ai/DeepSeek-V4.1-Flash".to_string(),
            provider_api_key_input: String::new(),
            decision_base_url_input: "https://api.subq.ai/v1".to_string(),
            decision_model_input: "subq-snap-1.2".to_string(),
            decision_api_key_input: String::new(),

            editing_bot_id: None,
            bot_name_input: "kawan".to_string(),
            bot_persona_input: "Concise, practical software engineering orchestrator.".to_string(),
            bot_model_input: String::new(),
            bot_thinking_input: "medium".to_string(),
            bot_sandbox_enabled: true,
            bot_sandbox_network: true,

            invite_note_input: String::new(),
            last_invite_link: None,

            ws: None,
            pending_commands: HashMap::new(),
            _poll_task: None,
            last_hold_tick_sec: 0,
        };

        if is_mock {
            mock::populate_mock(&mut app);
        } else if std::env::var("KAWAN_AUTOCONNECT").as_deref() == Ok("1") {
            app.start_connect(cx);
        }

        app
    }

    pub fn start_connect(&mut self, cx: &mut Context<Self>) {
        if self.is_mock {
            self.screen = Screen::Workspace(WorkspacePage::Conversation);
            self.focus_target = FocusTarget::Composer;
            return;
        }
        if self.connecting {
            return;
        }
        if let Some((parsed_url, parsed_token)) = parse_invite_link(&self.connect_token) {
            self.connect_host = parsed_url;
            self.connect_token = parsed_token;
            self.auth_mode = AuthMode::Register;
        } else if let Some((parsed_url, parsed_token)) = parse_invite_link(&self.connect_host) {
            self.connect_host = parsed_url;
            self.connect_token = parsed_token;
            self.auth_mode = AuthMode::Register;
        }

        if self.connect_host.trim().is_empty() {
            self.connect_error = Some("Host WebSocket address is required.".to_string());
            return;
        }
        if self.auth_mode != AuthMode::Login && self.connect_token.trim().is_empty() {
            self.connect_error = Some("Token is required for bootstrap or invite.".to_string());
            return;
        }
        if self.auth_mode != AuthMode::Login && self.connect_name.trim().is_empty() {
            self.connect_error = Some("Display name is required.".to_string());
            return;
        }

        self.connecting = true;
        self.connect_error = None;
        self.error_banner = None;

        let handle = WsHandle::connect(ConnectConfig {
            url: self.connect_host.clone(),
            mode: self.auth_mode,
            token: self.connect_token.clone(),
            name: self.connect_name.clone(),
            key_path: self.connect_key_path.clone(),
        });
        self.ws = Some(handle);
        self.start_ws_polling(cx);
    }

    fn start_ws_polling(&mut self, cx: &mut Context<Self>) {
        self._poll_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(40))
                    .await;
                let alive = this
                    .update(cx, |this, cx| {
                        let drained = this.drain_ws_events();
                        let ticked = this.tick_hold_countdown();
                        if drained || ticked {
                            cx.notify();
                        }
                    })
                    .is_ok();
                if !alive {
                    break;
                }
            }
        }));
    }

    fn tick_hold_countdown(&mut self) -> bool {
        let Some(cid) = self.active_conversation_id.as_deref() else {
            return false;
        };
        let has_pending_hold = self.decisions_by_conv.get(cid).is_some_and(|list| {
            list.iter()
                .any(|d| d.readiness == "hold" && d.dispatched == 0 && d.hold_expires_at.is_some())
        });
        if !has_pending_hold {
            return false;
        }
        let now_sec = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if now_sec != self.last_hold_tick_sec {
            self.last_hold_tick_sec = now_sec;
            return true;
        }
        false
    }

    fn drain_ws_events(&mut self) -> bool {
        let mut events = Vec::new();
        if let Some(ws) = &self.ws {
            while let Ok(ev) = ws.in_rx.try_recv() {
                events.push(ev);
            }
        }
        if events.is_empty() {
            return false;
        }
        for ev in events {
            match ev {
                WsEvent::Frame(frame) => self.handle_server_frame(*frame),
                WsEvent::Disconnected(reason) => {
                    self.connecting = false;
                    self.ws = None;
                    if self.screen == Screen::Connect {
                        self.connect_error = Some(reason);
                    } else {
                        self.error_banner = Some(format!("Disconnected: {reason}"));
                    }
                }
            }
        }
        true
    }

    fn send_cmd(&mut self, command: &str, payload: Value) {
        if self.is_mock {
            return;
        }
        if let Some(ws) = &mut self.ws {
            let id = ws.send_command(command, payload);
            self.pending_commands.insert(id, command.to_string());
        } else {
            self.error_banner = Some("Not connected to host.".to_string());
        }
    }

    fn handle_server_frame(&mut self, frame: ServerFrame) {
        match frame {
            ServerFrame::Challenge { .. } => {}
            ServerFrame::Welcome {
                user,
                name,
                role,
                setup,
                ..
            } => {
                self.connecting = false;
                self.connect_error = None;
                self.current_user_id = user;
                self.current_user_name = name;
                self.current_user_role = role;
                self.setup = setup.clone();
                self.screen = if setup.ready {
                    Screen::Workspace(WorkspacePage::Conversation)
                } else {
                    Screen::Checklist
                };
                self.focus_target = FocusTarget::Composer;
                self.refresh_workspace();
            }
            ServerFrame::Response {
                id,
                command,
                success,
                data,
                error,
            } => {
                if let Some(req_id) = id {
                    self.pending_commands.remove(&req_id);
                }
                if !success {
                    let msg = error.unwrap_or_else(|| format!("{command} failed"));
                    if command == "models.test" {
                        self.models_test_pending = false;
                    }
                    self.error_banner = Some(msg);
                    return;
                }
                if let Some(val) = data {
                    self.handle_command_success(&command, val);
                }
            }
            ServerFrame::ConversationNew { conversation } => {
                self.upsert_conversation(conversation);
            }
            ServerFrame::MessageNew { message, author } => {
                let conv_id = message.conversation_id.clone();
                let msg_seq = message.seq;
                let author_is_self = author.id == self.current_user_id;
                if let Some(members) = self.members_by_conv.get_mut(&conv_id)
                    && !members.iter().any(|m| m.id == author.id)
                {
                    members.push(Member {
                        id: author.id,
                        kind: author.kind,
                        name: author.name,
                        role: "member".to_string(),
                    });
                }
                self.ingest_attachments(&message.attachments);
                let list = self.messages_by_conv.entry(conv_id.clone()).or_default();
                if !list.iter().any(|m| m.id == message.id) {
                    list.push(message);
                    list.sort_by_key(|m| m.seq);
                }
                let viewing_active = matches!(
                    &self.screen,
                    Screen::Workspace(
                        WorkspacePage::Conversation
                            | WorkspacePage::MergeQueue
                            | WorkspacePage::IssueDetail(_)
                    )
                ) && self.active_conversation_id.as_deref()
                    == Some(conv_id.as_str());
                if let Some(conv) = self.conversations.iter_mut().find(|c| c.id == conv_id) {
                    conv.last_seq = conv.last_seq.max(msg_seq);
                    conv.next_seq = conv.next_seq.max(conv.last_seq + 1);
                    if viewing_active || author_is_self {
                        conv.last_read_seq = conv.last_read_seq.max(msg_seq);
                    }
                    conv.unread_count = conv.last_seq.saturating_sub(conv.last_read_seq);
                }
                if viewing_active && !author_is_self && !self.is_mock {
                    self.send_cmd(
                        "conversation.mark_read",
                        json!({ "conversation_id": conv_id, "seq": msg_seq }),
                    );
                }
            }
            ServerFrame::DecisionNew { decision } => {
                let list = self
                    .decisions_by_conv
                    .entry(decision.conversation_id.clone())
                    .or_default();
                if let Some(slot) = list.iter_mut().find(|d| d.id == decision.id) {
                    *slot = decision;
                } else {
                    list.push(decision);
                }
            }
            ServerFrame::BotUpdate { bot } => {
                if let Some(slot) = self.bots.iter_mut().find(|b| b.id == bot.id) {
                    *slot = bot;
                } else {
                    self.bots.push(bot);
                }
                self.recompute_setup_local();
            }
            ServerFrame::SessionUpdate { session } => {
                if session.kind == "orchestrator"
                    && let Some(bot) = self.bots.iter_mut().find(|b| b.id == session.bot_id)
                {
                    bot.orchestrator_status = session.status.clone();
                }
                self.sessions_by_id.insert(session.id.clone(), session);
            }
            ServerFrame::ArtifactNew { artifact } => {
                let art_id = artifact.id.clone();
                self.artifacts_by_id.insert(art_id.clone(), artifact);
                if !self.loaded_artifacts.contains_key(&art_id) {
                    self.send_cmd("artifact.get", json!({ "artifact_id": art_id }));
                }
            }
            ServerFrame::LandUpdate { land } => {
                let sess_id = land.session_id.clone();
                let is_landed = land.status == "landed";
                self.lands_by_id.insert(land.id.clone(), land);
                if is_landed {
                    self.session_diffs.remove(&sess_id);
                    self.session_diff_loading.remove(&sess_id);
                    if self.right_panel == RightPanel::Session(sess_id.clone())
                        && self.session_drawer_tab == SessionDrawerTab::Changes
                        && !self.is_mock
                    {
                        self.fetch_session_diff(&sess_id);
                    }
                }
            }
            ServerFrame::MergeQueueUpdate { queue } => {
                self.apply_merge_queue_snapshot(*queue);
            }
            ServerFrame::IssueUpdate { issue } => {
                self.issues_by_id.insert(issue.id.clone(), *issue);
            }
            ServerFrame::ReadCursorUpdate {
                conversation_id,
                last_read_seq,
                unread_count,
            } => {
                if let Some(conv) = self
                    .conversations
                    .iter_mut()
                    .find(|c| c.id == conversation_id)
                {
                    conv.last_read_seq = last_read_seq;
                    conv.unread_count = unread_count;
                }
            }
            ServerFrame::Error {
                conversation_id,
                message,
                ..
            } => {
                if let Some(cid) = conversation_id {
                    self.conv_errors
                        .entry(cid)
                        .or_default()
                        .push(ConversationError { message });
                } else {
                    self.error_banner = Some(message);
                }
            }
        }
    }

    fn handle_command_success(&mut self, command: &str, val: Value) {
        match command {
            "settings.read" | "settings.update" => {
                if let Ok(view) = serde_json::from_value::<SettingsView>(val) {
                    self.apply_settings_view(view);
                    if command == "settings.update" {
                        self.status_banner = Some("Settings saved.".to_string());
                        self.error_banner = None;
                    }
                }
            }
            "models.test" => {
                self.models_test_pending = false;
                if let Ok(res) = serde_json::from_value::<ModelsTestData>(val) {
                    self.models_test_result = Some(res);
                    self.error_banner = None;
                }
            }
            "bot.list" => {
                if let Ok(list) = serde_json::from_value::<BotListData>(val) {
                    self.bots = list.bots;
                    self.recompute_setup_local();
                }
            }
            "bot.create" | "bot.update" => {
                if let Ok(res) = serde_json::from_value::<BotCreateData>(val) {
                    if let Some(slot) = self.bots.iter_mut().find(|b| b.id == res.bot.id) {
                        *slot = res.bot;
                    } else {
                        self.bots.push(res.bot);
                    }
                    if let Some(sess) = res.session {
                        self.sessions_by_id.insert(sess.id.clone(), sess);
                    }
                    self.editing_bot_id = None;
                    self.recompute_setup_local();
                    self.status_banner = Some("Bot saved.".to_string());
                    self.error_banner = None;
                    self.send_cmd("user.list", json!({}));
                }
            }
            "user.list" => {
                if let Ok(res) = serde_json::from_value::<UserListData>(val) {
                    self.users = res.users;
                }
            }
            "conversation.list" => {
                if let Ok(res) = serde_json::from_value::<ConversationListData>(val) {
                    let prev_active = self.active_conversation_id.clone();
                    self.conversations = res.conversations;
                    for conv in &self.conversations {
                        if !conv.members.is_empty() {
                            self.members_by_conv
                                .insert(conv.id.clone(), conv.members.clone());
                        }
                    }
                    if prev_active.is_none()
                        && let Some(first) = self
                            .conversations
                            .iter()
                            .find(|c| c.kind == "channel")
                            .or_else(|| self.conversations.first())
                    {
                        let cid = first.id.clone();
                        self.active_conversation_id = Some(cid.clone());
                        self.send_cmd("conversation.open", json!({ "conversation_id": cid }));
                    }
                }
            }
            "conversation.create" => {
                if let Ok(res) = serde_json::from_value::<ConversationCreateData>(val) {
                    let cid = res.conversation.id.clone();
                    self.upsert_conversation(res.conversation);
                    self.show_new_channel = false;
                    self.new_channel_name.clear();
                    self.open_conversation(&cid);
                }
            }
            "conversation.add_member" => {
                if let Ok(res) = serde_json::from_value::<ConversationCreateData>(val) {
                    self.upsert_conversation(res.conversation);
                    self.show_add_member = false;
                    self.status_banner = Some("Member added to conversation.".to_string());
                }
            }
            "conversation.open" => {
                if let Ok(res) = serde_json::from_value::<ConversationOpenData>(val) {
                    let cid = res.conversation.id.clone();
                    self.upsert_conversation(res.conversation);
                    self.members_by_conv.insert(cid.clone(), res.members);
                    self.messages_by_conv
                        .insert(cid.clone(), res.messages.clone());
                    self.decisions_by_conv.insert(cid, res.decisions);
                    for sess in res.sessions {
                        self.sessions_by_id.insert(sess.id.clone(), sess);
                    }
                    for art in res.artifacts {
                        let aid = art.id.clone();
                        self.artifacts_by_id.insert(aid.clone(), art);
                        if !self.loaded_artifacts.contains_key(&aid) {
                            self.send_cmd("artifact.get", json!({ "artifact_id": aid }));
                        }
                    }
                    for msg in &res.messages {
                        self.ingest_attachments(&msg.attachments);
                    }
                    for land in res.lands {
                        self.lands_by_id.insert(land.id.clone(), land);
                    }
                }
            }
            "session.list" => {
                if let Ok(res) = serde_json::from_value::<SessionListData>(val) {
                    for s in res.sessions {
                        self.sessions_by_id.insert(s.id.clone(), s);
                    }
                }
            }
            "session.open" => {
                if let Ok(res) = serde_json::from_value::<SessionOpenData>(val) {
                    let sid = res.session.id.clone();
                    self.sessions_by_id.insert(sid.clone(), res.session);
                    self.session_entries.insert(sid, res.entries);
                    for art in res.artifacts {
                        let aid = art.id.clone();
                        self.artifacts_by_id.insert(aid.clone(), art);
                        if !self.loaded_artifacts.contains_key(&aid) {
                            self.send_cmd("artifact.get", json!({ "artifact_id": aid }));
                        }
                    }
                    for land in res.lands {
                        self.lands_by_id.insert(land.id.clone(), land);
                    }
                }
            }
            "artifact.get" => {
                if let Ok(res) = serde_json::from_value::<ArtifactGetData>(val) {
                    let aid = res.artifact.id.clone();
                    self.artifacts_by_id
                        .insert(aid.clone(), res.artifact.clone());
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(res.base64.trim())
                        .ok();
                    let mut text_preview = None;
                    let mut image = None;
                    if let Some(bytes) = decoded {
                        if let Some(fmt) = image_format_for_mime(&res.mime_type) {
                            image = Some(Arc::new(Image::from_bytes(fmt, bytes)));
                        } else if let Ok(txt) = String::from_utf8(bytes) {
                            text_preview = Some(txt);
                        }
                    }
                    self.loaded_artifacts.insert(
                        aid,
                        LoadedArtifact {
                            text_preview,
                            image,
                        },
                    );
                }
            }
            "land.merge" => {
                if let Ok(res) = serde_json::from_value::<LandMergeData>(val) {
                    self.lands_by_id.insert(res.land.id.clone(), res.land);
                    self.sessions_by_id
                        .insert(res.session.id.clone(), res.session);
                    self.error_banner = None;
                }
            }
            "land.withdraw" => {
                if let Ok(res) = serde_json::from_value::<MergeQueueReadData>(val) {
                    self.apply_merge_queue_snapshot(res.queue);
                    self.error_banner = None;
                }
            }
            "merge_queue.read"
            | "merge_queue.configure"
            | "merge_queue.pause"
            | "merge_queue.resume"
            | "merge_queue.retry"
            | "merge_queue.eject"
            | "merge_queue.remove" => {
                if let Ok(res) = serde_json::from_value::<MergeQueueReadData>(val) {
                    self.apply_merge_queue_snapshot(res.queue);
                    self.error_banner = None;
                }
            }
            "session.confirm" | "session.dismiss" | "session.stop" => {
                if let Ok(res) = serde_json::from_value::<SessionActionData>(val) {
                    self.sessions_by_id
                        .insert(res.session.id.clone(), res.session);
                    self.error_banner = None;
                }
            }
            "invite.create" => {
                if let Ok(res) = serde_json::from_value::<InviteCreateData>(val) {
                    self.last_invite_link = Some(res.link);
                    self.invite_note_input.clear();
                    self.error_banner = None;
                }
            }
            "issue.list" => {
                if let Ok(res) = serde_json::from_value::<IssueListData>(val) {
                    for issue in res.issues {
                        self.issues_by_id.insert(issue.id.clone(), issue);
                    }
                }
            }
            "issue.create" => {
                if let Ok(res) = serde_json::from_value::<IssueActionData>(val) {
                    let iid = res.issue.id.clone();
                    self.issues_by_id.insert(iid.clone(), res.issue);
                    self.show_new_issue_form = false;
                    self.new_issue_title.clear();
                    self.new_issue_body.clear();
                    self.error_banner = None;
                    self.open_issue(&iid);
                }
            }
            "issue.promote" => {
                if let Ok(res) = serde_json::from_value::<IssuePromoteData>(val) {
                    let iid = res.issue.id.clone();
                    self.upsert_conversation(res.conversation);
                    self.issues_by_id.insert(iid.clone(), res.issue);
                    self.error_banner = None;
                    self.open_issue(&iid);
                }
            }
            "issue.open" => {
                if let Ok(res) = serde_json::from_value::<IssueOpenData>(val) {
                    let cid = res.conversation.id.clone();
                    self.issues_by_id.insert(res.issue.id.clone(), res.issue);
                    self.upsert_conversation(res.conversation);
                    self.members_by_conv.insert(cid.clone(), res.members);
                    self.messages_by_conv
                        .insert(cid.clone(), res.messages.clone());
                    self.decisions_by_conv.insert(cid, res.decisions);
                    for sess in res.sessions {
                        self.sessions_by_id.insert(sess.id.clone(), sess);
                    }
                    for art in res.artifacts {
                        let aid = art.id.clone();
                        self.artifacts_by_id.insert(aid.clone(), art);
                        if !self.loaded_artifacts.contains_key(&aid) {
                            self.send_cmd("artifact.get", json!({ "artifact_id": aid }));
                        }
                    }
                    for msg in &res.messages {
                        self.ingest_attachments(&msg.attachments);
                    }
                    for land in res.lands {
                        self.lands_by_id.insert(land.id.clone(), land);
                    }
                }
            }
            "issue.update" | "issue.stop" | "issue.close" => {
                if let Ok(res) = serde_json::from_value::<IssueActionData>(val) {
                    if command == "issue.update" {
                        self.editing_issue_id = None;
                    }
                    self.issues_by_id.insert(res.issue.id.clone(), res.issue);
                    self.error_banner = None;
                }
            }
            "issue.sync_main" => {
                if let Ok(res) = serde_json::from_value::<IssueSyncData>(val) {
                    self.issues_by_id.insert(res.issue.id.clone(), res.issue);
                    if !res.ok {
                        self.error_banner = res.error;
                    } else {
                        self.error_banner = None;
                    }
                }
            }
            "issue.propose" => {
                if let Ok(res) = serde_json::from_value::<IssueLandData>(val) {
                    self.issues_by_id.insert(res.issue.id.clone(), res.issue);
                    self.lands_by_id.insert(res.land.id.clone(), res.land);
                    self.error_banner = None;
                }
            }
            "conversation.mark_read" => {
                if let Ok(res) = serde_json::from_value::<ConversationMarkReadData>(val)
                    && let Some(conv) = self
                        .conversations
                        .iter_mut()
                        .find(|c| c.id == res.conversation_id)
                {
                    conv.last_read_seq = res.last_read_seq;
                    conv.unread_count = res.unread_count;
                }
            }
            "session.diff" => {
                if let Ok(res) = serde_json::from_value::<SessionDiffData>(val) {
                    let sid = res.session_id;
                    self.session_diff_loading.remove(&sid);
                    let valid_selected = self
                        .selected_diff_file
                        .get(&sid)
                        .is_some_and(|p| res.diff.files.iter().any(|f| &f.path == p));
                    if !valid_selected {
                        if let Some(first) = res.diff.files.first() {
                            self.selected_diff_file
                                .insert(sid.clone(), first.path.clone());
                        } else {
                            self.selected_diff_file.remove(&sid);
                        }
                    }
                    self.session_diffs.insert(sid, res.diff);
                }
            }
            _ => {}
        }
    }

    fn apply_settings_view(&mut self, view: SettingsView) {
        self.setup = view.setup.clone();
        if let Some(repo) = &view.repo {
            self.repo_url_input = repo.url.clone();
            self.repo_branch_input = repo.default_branch.clone();
        }
        if let Some(cmd) = &view.verify_command {
            self.repo_verify_input = cmd.clone();
        }
        if let Some((pname, prov)) = view.providers.iter().next() {
            self.provider_name_input = pname.clone();
            self.provider_base_url_input = prov.base_url.clone();
            if let Some(m) = prov.models.first() {
                self.provider_model_input = m.id.clone();
            }
        }
        if let Some(dec) = &view.roles.decision {
            self.decision_base_url_input = dec.base_url.clone();
            self.decision_model_input = dec.model.clone();
        }
        if let Some(def) = &view.roles.default {
            self.bot_model_input = format!("{}/{}", def.provider, def.model);
            if let Some(t) = &def.thinking_level {
                self.bot_thinking_input = t.clone();
            }
        }
        self.settings = view;
    }

    fn recompute_setup_local(&mut self) {
        self.setup.has_bot = !self.bots.is_empty();
        self.setup.ready = self.setup.has_repo
            && self.setup.has_models
            && self.setup.has_decision_model
            && self.setup.has_bot;
    }

    fn apply_merge_queue_snapshot(&mut self, queue: MergeQueueSnapshot) {
        // A proposal that left the list can no longer be waiting for a confirm click.
        let confirm_still_listed = self
            .confirm_merge
            .as_ref()
            .is_some_and(|id| queue.proposed.iter().any(|card| &card.land.id == id));
        if !confirm_still_listed {
            self.confirm_merge = None;
        }
        for card in &queue.proposed {
            self.lands_by_id
                .insert(card.land.id.clone(), card.land.clone());
            self.ingest_attachments(&card.message.attachments);
            let conversation_id = card.message.conversation_id.clone();
            let messages = self.messages_by_conv.entry(conversation_id).or_default();
            match messages.iter().position(|m| m.id == card.message.id) {
                Some(index) => messages[index] = card.message.clone(),
                None => {
                    messages.push(card.message.clone());
                    messages.sort_by_key(|m| m.seq);
                }
            }
        }
        if let Some(head) = &queue.head {
            self.lands_by_id.insert(head.id.clone(), head.clone());
        }
        for l in &queue.queued {
            self.lands_by_id.insert(l.id.clone(), l.clone());
        }
        if let Some(p) = &queue.paused_land {
            self.lands_by_id.insert(p.id.clone(), p.clone());
        }
        for l in &queue.recent_landed {
            self.lands_by_id.insert(l.id.clone(), l.clone());
        }
        self.merge_queue = Some(queue);
    }

    /// Store a message's attachments and start loading bytes for inline images.
    ///
    /// Artifacts another part of the same response already listed are left alone,
    /// so an image attachment is never fetched twice.
    fn ingest_attachments(&mut self, attachments: &[Artifact]) {
        for artifact in attachments {
            let id = artifact.id.clone();
            if self.artifacts_by_id.contains_key(&id) {
                continue;
            }
            let is_image = artifact.mime_type.starts_with("image/");
            self.artifacts_by_id.insert(id.clone(), artifact.clone());
            if is_image && !self.is_mock {
                self.send_cmd("artifact.get", json!({ "artifact_id": id }));
            }
        }
    }

    /// Open proposals shown in the Merge Queue, as the host ordered them.
    pub fn proposals(&self) -> &[ProposalCard] {
        self.merge_queue
            .as_ref()
            .map(|queue| queue.proposed.as_slice())
            .unwrap_or(&[])
    }

    /// True when a message is newer than the local read cursor, so a proposal row
    /// can show its "updated since you viewed" dot.
    pub fn message_unseen(&self, message: &Message) -> bool {
        self.conversations
            .iter()
            .find(|c| c.id == message.conversation_id)
            .is_some_and(|conv| message.seq > conv.last_read_seq)
    }

    fn upsert_conversation(&mut self, conv: Conversation) {
        let cid = conv.id.clone();
        let kind = conv.kind.clone();
        if !conv.members.is_empty() {
            self.members_by_conv
                .insert(cid.clone(), conv.members.clone());
        }
        if let Some(slot) = self.conversations.iter_mut().find(|c| c.id == cid) {
            *slot = conv;
        } else {
            self.conversations.push(conv);
        }
        if self.active_conversation_id.is_none() && kind != "merge_queue" && kind != "issue" {
            self.active_conversation_id = Some(cid.clone());
            self.send_cmd("conversation.open", json!({ "conversation_id": cid }));
        }
    }

    pub fn refresh_workspace(&mut self) {
        self.send_cmd("settings.read", json!({}));
        self.send_cmd("bot.list", json!({}));
        self.send_cmd("user.list", json!({}));
        self.send_cmd("conversation.list", json!({}));
        self.send_cmd("session.list", json!({}));
        self.send_cmd("merge_queue.read", json!({}));
        self.send_cmd("issue.list", json!({}));
    }

    pub fn open_conversation(&mut self, conv_id: &str) {
        self.active_conversation_id = Some(conv_id.to_string());
        self.screen = Screen::Workspace(WorkspacePage::Conversation);
        self.right_panel = RightPanel::None;
        self.redirect_menu_decision_id = None;
        self.show_add_member = false;
        self.focus_target = FocusTarget::Composer;
        if let Some(conv) = self.conversations.iter_mut().find(|c| c.id == conv_id) {
            conv.last_read_seq = conv.last_read_seq.max(conv.last_seq);
            conv.unread_count = 0;
        }
        if !self.is_mock {
            self.send_cmd("conversation.open", json!({ "conversation_id": conv_id }));
        }
    }

    pub fn merge_queue_conversation(&self) -> Option<&Conversation> {
        self.conversations.iter().find(|c| c.kind == "merge_queue")
    }

    pub fn open_merge_queue(&mut self) {
        self.screen = Screen::Workspace(WorkspacePage::MergeQueue);
        self.right_panel = RightPanel::None;
        self.redirect_menu_decision_id = None;
        self.show_add_member = false;
        self.focus_target = FocusTarget::Composer;
        let mq_cid = self
            .merge_queue
            .as_ref()
            .map(|q| q.conversation_id.clone())
            .or_else(|| self.merge_queue_conversation().map(|c| c.id.clone()));
        if let Some(cid) = mq_cid {
            self.active_conversation_id = Some(cid.clone());
            if let Some(conv) = self.conversations.iter_mut().find(|c| c.id == cid) {
                conv.last_read_seq = conv.last_read_seq.max(conv.last_seq);
                conv.unread_count = 0;
            }
            if !self.is_mock {
                self.send_cmd("conversation.open", json!({ "conversation_id": cid }));
            }
        }
        if !self.is_mock {
            self.send_cmd("merge_queue.read", json!({}));
        }
    }

    pub fn open_merge_queue_thread(&mut self, thread_id: &str) {
        self.open_merge_queue();
        self.right_panel = RightPanel::Thread(thread_id.to_string());
        self.focus_target = FocusTarget::ThreadComposer;
    }

    pub fn open_dm_with(&mut self, user_id: &str) {
        self.screen = Screen::Workspace(WorkspacePage::Conversation);
        if self.is_mock {
            return;
        }
        self.send_cmd(
            "conversation.create",
            json!({ "kind": "dm", "peer_user_id": user_id }),
        );
    }

    pub fn open_settings(&mut self, tab: SettingsTab) {
        self.screen = Screen::Workspace(WorkspacePage::Settings(tab));
        self.status_banner = None;
        self.error_banner = None;
        self.focus_target = match tab {
            SettingsTab::Repository => FocusTarget::RepoUrl,
            SettingsTab::Models => FocusTarget::ProviderName,
            SettingsTab::Bots => FocusTarget::BotName,
        };
    }

    pub fn issue_for_session(&self, session_id: &str) -> Option<&IssueSummary> {
        self.issues_by_id
            .values()
            .find(|i| i.active_session_id.as_deref() == Some(session_id))
    }

    pub fn issue_by_conv(&self, conv_id: &str) -> Option<&IssueSummary> {
        self.issues_by_id
            .values()
            .find(|i| i.conversation_id == conv_id)
    }

    pub fn open_issues(&mut self) {
        self.screen = Screen::Workspace(WorkspacePage::Issues);
        self.right_panel = RightPanel::None;
        self.redirect_menu_decision_id = None;
        self.show_add_member = false;
        self.editing_issue_id = None;
        if !self.is_mock {
            self.send_cmd("issue.list", json!({}));
        }
    }

    pub fn open_issue(&mut self, issue_id: &str) {
        self.screen = Screen::Workspace(WorkspacePage::IssueDetail(issue_id.to_string()));
        self.right_panel = RightPanel::None;
        self.redirect_menu_decision_id = None;
        self.show_add_member = false;
        self.editing_issue_id = None;
        self.focus_target = FocusTarget::Composer;
        if let Some(issue) = self.issues_by_id.get(issue_id).cloned() {
            self.active_conversation_id = Some(issue.conversation_id.clone());
            if let Some(conv) = self
                .conversations
                .iter_mut()
                .find(|c| c.id == issue.conversation_id)
            {
                conv.last_read_seq = conv.last_read_seq.max(conv.last_seq);
                conv.unread_count = 0;
            }
            if !self.is_mock {
                self.send_cmd("issue.open", json!({ "issue_id": issue_id }));
            }
        }
    }

    pub fn create_issue(&mut self) {
        let title = self.new_issue_title.trim().to_string();
        let body = self.new_issue_body.trim().to_string();
        if title.is_empty() {
            self.error_banner = Some("Issue title is required.".to_string());
            return;
        }
        self.error_banner = None;
        if self.is_mock {
            let num = self
                .issues_by_id
                .values()
                .map(|i| i.number)
                .max()
                .unwrap_or(0)
                + 1;
            let iid = format!("mock-issue-{num}");
            let cid = format!("mock-conv-issue-{num}");
            self.upsert_conversation(Conversation {
                id: cid.clone(),
                kind: "issue".to_string(),
                name: Some(format!("issue-{num}")),
                topic: Some(title.clone()),
                next_seq: 1,
                created_at: 300,
                last_seq: 0,
                last_read_seq: 0,
                unread_count: 0,
                members: Vec::new(),
            });
            self.issues_by_id.insert(
                iid.clone(),
                IssueSummary {
                    id: iid.clone(),
                    number: num,
                    conversation_id: cid,
                    title,
                    body_md: body,
                    status: "open".to_string(),
                    owner_id: self.current_user_id.clone(),
                    implementer_bot_id: None,
                    active_session_id: None,
                    parent_issue_id: None,
                    needs_input_question: None,
                    behind_main: 0,
                    commits_ahead: 0,
                    checks_status: "none".to_string(),
                    checks_sha: None,
                    checks_summary: None,
                    checks: Vec::new(),
                    checks_artifact_id: None,
                    touches_kawan: false,
                    active_reviewers: Vec::new(),
                    created_at: 300,
                    updated_at: 300,
                },
            );
            self.show_new_issue_form = false;
            self.new_issue_title.clear();
            self.new_issue_body.clear();
            self.open_issue(&iid);
            return;
        }
        self.send_cmd("issue.create", json!({ "title": title, "body_md": body }));
    }

    pub fn begin_edit_issue(&mut self, issue_id: &str) {
        if let Some(issue) = self.issues_by_id.get(issue_id) {
            self.collapsed_issue_docs.remove(issue_id);
            self.editing_issue_id = Some(issue.id.clone());
            self.edit_issue_title = issue.title.clone();
            self.edit_issue_body = issue.body_md.clone();
            self.focus_target = FocusTarget::IssueEditTitle;
        }
    }

    pub fn save_edit_issue(&mut self, issue_id: &str) {
        let title = self.edit_issue_title.trim().to_string();
        let body = self.edit_issue_body.clone();
        if title.is_empty() {
            self.error_banner = Some("Issue title cannot be empty.".to_string());
            return;
        }
        self.error_banner = None;
        if self.is_mock {
            if let Some(issue) = self.issues_by_id.get_mut(issue_id) {
                issue.title = title;
                issue.body_md = body;
            }
            self.editing_issue_id = None;
            return;
        }
        self.send_cmd(
            "issue.update",
            json!({ "issue_id": issue_id, "title": title, "body_md": body }),
        );
    }

    pub fn toggle_issue_doc(&mut self, issue_id: &str) {
        if !self.collapsed_issue_docs.remove(issue_id) {
            self.collapsed_issue_docs.insert(issue_id.to_string());
            if self.editing_issue_id.as_deref() == Some(issue_id) {
                self.editing_issue_id = None;
            }
        }
    }

    pub fn open_artifact_drawer(&mut self, artifact_id: &str) {
        self.right_panel = RightPanel::Artifact(artifact_id.to_string());
        if !self.is_mock && !self.loaded_artifacts.contains_key(artifact_id) {
            self.send_cmd("artifact.get", json!({ "artifact_id": artifact_id }));
        }
    }

    pub fn promote_session_to_issue(&mut self, session_id: &str) {
        if self.is_mock {
            if let Some(existing) = self.issue_for_session(session_id).map(|i| i.id.clone()) {
                self.open_issue(&existing);
                return;
            }
            if let Some(sess) = self.sessions_by_id.get(session_id).cloned() {
                let num = self
                    .issues_by_id
                    .values()
                    .map(|i| i.number)
                    .max()
                    .unwrap_or(0)
                    + 1;
                let iid = format!("mock-issue-{num}");
                let cid = format!("mock-conv-issue-{num}");
                let title = sess
                    .title
                    .clone()
                    .unwrap_or_else(|| format!("Promoted task #{num}"));
                let body = sess.task.clone().unwrap_or_default();
                self.upsert_conversation(Conversation {
                    id: cid.clone(),
                    kind: "issue".to_string(),
                    name: Some(format!("issue-{num}")),
                    topic: Some(title.clone()),
                    next_seq: 1,
                    created_at: 300,
                    last_seq: 0,
                    last_read_seq: 0,
                    unread_count: 0,
                    members: Vec::new(),
                });
                self.issues_by_id.insert(
                    iid.clone(),
                    IssueSummary {
                        id: iid.clone(),
                        number: num,
                        conversation_id: cid,
                        title,
                        body_md: body,
                        status: "open".to_string(),
                        owner_id: self.current_user_id.clone(),
                        implementer_bot_id: Some(sess.bot_id),
                        active_session_id: Some(session_id.to_string()),
                        parent_issue_id: None,
                        needs_input_question: None,
                        behind_main: 0,
                        commits_ahead: 1,
                        checks_status: "none".to_string(),
                        checks_sha: None,
                        checks_summary: None,
                        checks: Vec::new(),
                        checks_artifact_id: None,
                        touches_kawan: false,
                        active_reviewers: Vec::new(),
                        created_at: 300,
                        updated_at: 300,
                    },
                );
                self.open_issue(&iid);
            }
            return;
        }
        self.send_cmd("issue.promote", json!({ "session_id": session_id }));
    }

    pub fn sync_issue_with_main(&mut self, issue_id: &str) {
        if self.is_mock {
            if let Some(issue) = self.issues_by_id.get_mut(issue_id) {
                issue.behind_main = 0;
            }
            return;
        }
        self.send_cmd("issue.sync_main", json!({ "issue_id": issue_id }));
    }

    pub fn land_issue(&mut self, issue_id: &str) {
        if self.is_mock {
            self.mock_propose_issue(issue_id);
            return;
        }
        self.send_cmd("issue.propose", json!({ "issue_id": issue_id }));
    }

    /// Mock stand-in for the host's propose path: the issue's branch becomes a
    /// `proposed` land with a message in `#merge-queue`, and the issue stays open.
    fn mock_propose_issue(&mut self, issue_id: &str) {
        let Some(issue) = self.issues_by_id.get(issue_id).cloned() else {
            return;
        };
        let land_id = format!("mock-proposal-{issue_id}");
        let message_id = format!("mock-proposal-msg-{issue_id}");
        let mq_cid = self
            .merge_queue_conversation()
            .map(|c| c.id.clone())
            .or_else(|| self.merge_queue.as_ref().map(|q| q.conversation_id.clone()))
            .unwrap_or_else(|| "conv-merge-queue".to_string());
        let session_id = issue
            .active_session_id
            .clone()
            .or_else(|| Some(format!("mock-proposal-sess-{issue_id}")));
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let bot = self
            .bots
            .first()
            .map(|b| (b.id.clone(), b.name.clone()))
            .unwrap_or_else(|| (issue.owner_id.clone(), "kawan".to_string()));
        let commits = issue.commits_ahead.max(1);
        let branch = format!("kawan/issue-{}", issue.number);
        let checks = if issue.checks_status == "passed" {
            "green".to_string()
        } else {
            issue.checks_status.clone()
        };
        let body = format!(
            "## {}\n\n{commits} commits ready to merge from `{branch}`.\n\nChecks: {checks}.",
            issue.title
        );
        let seq = self
            .messages_by_conv
            .get(&mq_cid)
            .and_then(|msgs| msgs.iter().map(|m| m.seq).max())
            .unwrap_or(0)
            + 1;
        let message = Message {
            id: message_id.clone(),
            conversation_id: mq_cid.clone(),
            seq,
            author_id: bot.0.clone(),
            thread_id: None,
            body,
            attachments: Vec::new(),
            created_at: now_ms,
        };
        self.messages_by_conv
            .entry(mq_cid.clone())
            .or_default()
            .push(message.clone());
        let land = Land {
            id: land_id.clone(),
            session_id: session_id.clone().unwrap_or_default(),
            conversation_id: issue.conversation_id.clone(),
            thread_id: None,
            message_id: Some(message_id),
            status: "proposed".to_string(),
            approved_by: None,
            base_sha: None,
            landed_sha: None,
            verify_output: None,
            error: None,
            queue_position: None,
            issue_id: Some(issue.id.clone()),
            pause_reason: None,
            queue_session_id: None,
            queue_thread_id: None,
            trigger: Some("proposal".to_string()),
            checks: issue.checks.clone(),
            touches_kawan: issue.touches_kawan,
            created_at: now_ms,
            updated_at: now_ms,
        };
        self.lands_by_id.insert(land.id.clone(), land.clone());
        if let Some(mq) = &mut self.merge_queue {
            mq.proposed.retain(|card| card.land.id != land.id);
            mq.proposed.insert(
                0,
                ProposalCard {
                    land,
                    message,
                    author: crate::protocol::MessageAuthor {
                        id: bot.0,
                        kind: "bot".to_string(),
                        name: bot.1,
                    },
                    session_title: Some(issue.title.clone()),
                    checks: issue.checks.clone(),
                    commits_ahead: issue.commits_ahead.max(1),
                    behind_main: issue.behind_main,
                    issue_number: Some(issue.number),
                    updated_at: now_ms,
                },
            );
        }
        if let Some(issue) = self.issues_by_id.get_mut(issue_id) {
            issue.needs_input_question = None;
            issue.active_reviewers.clear();
        }
        if let Some(sid) = &session_id
            && let Some(sess) = self.sessions_by_id.get_mut(sid)
        {
            sess.status = "idle".to_string();
        }
    }

    pub fn stop_issue(&mut self, issue_id: &str) {
        if self.is_mock {
            if let Some(issue) = self.issues_by_id.get_mut(issue_id) {
                issue.active_reviewers.clear();
                if let Some(sid) = issue.active_session_id.clone()
                    && let Some(sess) = self.sessions_by_id.get_mut(&sid)
                {
                    sess.status = "stopped".to_string();
                }
            }
            return;
        }
        self.send_cmd("issue.stop", json!({ "issue_id": issue_id }));
    }

    pub fn close_issue(&mut self, issue_id: &str, abandon: bool) {
        if self.is_mock {
            if let Some(issue) = self.issues_by_id.get_mut(issue_id) {
                issue.status = "closed".to_string();
                issue.needs_input_question = None;
            }
            return;
        }
        self.send_cmd(
            "issue.close",
            json!({ "issue_id": issue_id, "abandon": abandon }),
        );
    }

    pub fn open_workspace(&mut self) {
        self.screen = Screen::Workspace(WorkspacePage::Conversation);
        self.focus_target = FocusTarget::Composer;
        if let Some(cid) = self.active_conversation_id.clone()
            && !self.is_mock
        {
            self.send_cmd("conversation.open", json!({ "conversation_id": cid }));
        }
    }

    pub fn open_session_inspector(&mut self, session_id: &str) {
        self.right_panel = RightPanel::Session(session_id.to_string());
        self.session_drawer_tab = SessionDrawerTab::Overview;
        if !self.is_mock {
            self.send_cmd("session.open", json!({ "session_id": session_id }));
            self.fetch_session_diff(session_id);
        }
    }

    pub fn open_session_changes(&mut self, session_id: &str) {
        self.right_panel = RightPanel::Session(session_id.to_string());
        self.session_drawer_tab = SessionDrawerTab::Changes;
        if !self.is_mock {
            self.send_cmd("session.open", json!({ "session_id": session_id }));
            self.fetch_session_diff(session_id);
        }
    }

    pub fn fetch_session_diff(&mut self, session_id: &str) {
        if self.is_mock {
            return;
        }
        self.session_diff_loading.insert(session_id.to_string());
        self.send_cmd("session.diff", json!({ "session_id": session_id }));
    }

    pub fn send_composer_message(&mut self) {
        let body = self.composer_text.trim().to_string();
        if body.is_empty() {
            return;
        }
        let Some(cid) = self.active_conversation_id.clone() else {
            return;
        };
        self.composer_text.clear();

        if self.is_mock {
            let next_seq = self
                .messages_by_conv
                .get(&cid)
                .and_then(|v| v.last())
                .map(|m| m.seq + 1)
                .unwrap_or(1);
            let msg_id = format!("mock-msg-{next_seq}");
            self.messages_by_conv
                .entry(cid.clone())
                .or_default()
                .push(Message {
                    id: msg_id.clone(),
                    conversation_id: cid.clone(),
                    seq: next_seq,
                    author_id: self.current_user_id.clone(),
                    thread_id: None,
                    body,
                    attachments: Vec::new(),
                    created_at: 1_795_409_400_000,
                });
            self.decisions_by_conv
                .entry(cid.clone())
                .or_default()
                .push(Decision {
                    id: format!("mock-dec-{next_seq}"),
                    conversation_id: cid,
                    message_id: msg_id,
                    bot_id: self.bots.first().map(|b| b.id.clone()).unwrap_or_default(),
                    decision_type: "route_message".to_string(),
                    destination: "orchestrator".to_string(),
                    readiness: "dispatch".to_string(),
                    confidence: 0.98,
                    reason: "destination=orchestrator (98%), readiness=dispatch (96%)".to_string(),
                    raw_json: "{}".to_string(),
                    held_batch_id: None,
                    dispatched: 1,
                    redirected_from: None,
                    redirected_by: None,
                    hold_expires_at: None,
                    explicit_work_start: Some("yes".to_string()),
                    work_request: Some("yes".to_string()),
                    created_at: 1_795_409_400_050,
                });
            return;
        }

        self.send_cmd(
            "message.send",
            json!({ "conversation_id": cid, "body": body }),
        );
    }

    pub fn send_thread_reply(&mut self) {
        let RightPanel::Thread(thread_id) = self.right_panel.clone() else {
            return;
        };
        let body = self.thread_composer_text.trim().to_string();
        if body.is_empty() {
            return;
        }
        let Some(cid) = self.active_conversation_id.clone() else {
            return;
        };
        self.thread_composer_text.clear();

        if self.is_mock {
            let next_seq = self
                .messages_by_conv
                .get(&cid)
                .and_then(|v| v.last())
                .map(|m| m.seq + 1)
                .unwrap_or(1);
            self.messages_by_conv.entry(cid).or_default().push(Message {
                id: format!("mock-thread-{next_seq}"),
                conversation_id: self.active_conversation_id.clone().unwrap_or_default(),
                seq: next_seq,
                author_id: self.current_user_id.clone(),
                thread_id: Some(thread_id),
                body,
                attachments: Vec::new(),
                created_at: 1_795_409_410_000,
            });
            return;
        }

        self.send_cmd(
            "message.send",
            json!({ "conversation_id": cid, "body": body, "thread_id": thread_id }),
        );
    }

    pub fn create_channel(&mut self) {
        let name = self
            .new_channel_name
            .trim()
            .trim_start_matches('#')
            .to_string();
        if name.is_empty() {
            return;
        }
        if self.is_mock {
            let id = format!("mock-ch-{name}");
            self.upsert_conversation(Conversation {
                id: id.clone(),
                kind: "channel".to_string(),
                name: Some(name),
                topic: None,
                next_seq: 1,
                created_at: 0,
                last_seq: 0,
                last_read_seq: 0,
                unread_count: 0,
                members: Vec::new(),
            });
            self.show_new_channel = false;
            self.new_channel_name.clear();
            self.open_conversation(&id);
            return;
        }
        self.send_cmd(
            "conversation.create",
            json!({ "kind": "channel", "name": name }),
        );
    }

    pub fn add_member_to_active(&mut self, user_id: &str) {
        let Some(cid) = self.active_conversation_id.clone() else {
            return;
        };
        if self.is_mock {
            self.show_add_member = false;
            return;
        }
        self.send_cmd(
            "conversation.add_member",
            json!({ "conversation_id": cid, "user_id": user_id }),
        );
    }

    pub fn redirect_decision(&mut self, decision_id: &str, destination: &str) {
        self.redirect_menu_decision_id = None;
        if self.is_mock {
            for list in self.decisions_by_conv.values_mut() {
                if let Some(dec) = list.iter_mut().find(|d| d.id == decision_id) {
                    if dec.destination != destination {
                        dec.redirected_from = Some(dec.destination.clone());
                    }
                    dec.destination = destination.to_string();
                    dec.readiness = "dispatch".to_string();
                    dec.dispatched = 1;
                    dec.hold_expires_at = None;
                }
            }
            return;
        }
        self.send_cmd(
            "decision.redirect",
            json!({ "decision_id": decision_id, "destination": destination }),
        );
    }

    /// Human accept: a proposal (`proposed`) enters the train (`queued`).
    pub fn merge_land(&mut self, land_id: &str) {
        self.confirm_merge = None;
        if self.is_mock {
            if let Some(land) = self.lands_by_id.get_mut(land_id) {
                land.status = "queued".to_string();
                land.approved_by = Some(self.current_user_id.clone());
                land.pause_reason = None;
                land.error = None;
                let updated_land = land.clone();
                if let Some(sess) = self.sessions_by_id.get_mut(&land.session_id) {
                    sess.status = "idle".to_string();
                }
                if let Some(mq) = &mut self.merge_queue {
                    mq.proposed.retain(|card| card.land.id != land_id);
                    if !mq.queued.iter().any(|l| l.id == land_id) {
                        mq.queued.push(updated_land);
                    }
                    mq.head = mq.queued.first().cloned();
                }
            }
            return;
        }
        self.send_cmd("land.merge", json!({ "land_id": land_id, "async": true }));
    }

    /// Pull an open proposal back: `withdrawn`, out of the train, never landed.
    pub fn withdraw_land(&mut self, land_id: &str) {
        self.confirm_merge = None;
        if self.is_mock {
            if let Some(land) = self.lands_by_id.get_mut(land_id) {
                land.status = "withdrawn".to_string();
                land.pause_reason = None;
                land.queue_position = None;
            }
            if let Some(mq) = &mut self.merge_queue {
                mq.proposed.retain(|card| card.land.id != land_id);
                mq.queued.retain(|l| l.id != land_id);
            }
            self.sync_mock_merge_queue_head();
            return;
        }
        self.send_cmd("land.withdraw", json!({ "land_id": land_id }));
    }

    pub fn confirm_session(&mut self, session_id: &str) {
        if self.is_mock {
            if let Some(sess) = self.sessions_by_id.get_mut(session_id) {
                sess.status = "running".to_string();
            }
            return;
        }
        self.send_cmd("session.confirm", json!({ "session_id": session_id }));
    }

    pub fn dismiss_session(&mut self, session_id: &str) {
        if self.is_mock {
            if let Some(sess) = self.sessions_by_id.get_mut(session_id) {
                sess.status = "stopped".to_string();
                sess.last_report = Some("Dismissed by user".to_string());
            }
            return;
        }
        self.send_cmd("session.dismiss", json!({ "session_id": session_id }));
    }

    pub fn stop_session(&mut self, session_id: &str) {
        if self.is_mock {
            if let Some(sess) = self.sessions_by_id.get_mut(session_id) {
                sess.status = "stopped".to_string();
                sess.last_report = Some("Stopped by user".to_string());
            }
            return;
        }
        self.send_cmd("session.stop", json!({ "session_id": session_id }));
    }

    fn sync_mock_merge_queue_head(&mut self) {
        if let Some(mq) = &mut self.merge_queue {
            mq.head = mq.queued.first().cloned();
            mq.paused_land = mq.queued.iter().find(|l| l.status == "paused").cloned();
            if mq.paused_land.is_none() && mq.queued.is_empty() {
                mq.settings.paused = false;
            }
        }
    }

    pub fn merge_queue_pause(&mut self) {
        if self.is_mock {
            if let Some(mq) = &mut self.merge_queue {
                mq.settings.paused = true;
            }
            return;
        }
        self.send_cmd("merge_queue.pause", json!({}));
    }

    pub fn merge_queue_resume(&mut self) {
        if self.is_mock {
            if let Some(mq) = &mut self.merge_queue {
                mq.settings.paused = false;
                if let Some(head) = mq.queued.first_mut()
                    && head.status == "paused"
                {
                    head.status = "queued".to_string();
                    head.pause_reason = None;
                    head.error = None;
                    self.lands_by_id.insert(head.id.clone(), head.clone());
                }
            }
            self.sync_mock_merge_queue_head();
            return;
        }
        self.send_cmd("merge_queue.resume", json!({}));
    }

    pub fn merge_queue_retry(&mut self, land_id: Option<&str>) {
        if self.is_mock {
            self.merge_queue_resume();
            return;
        }
        self.send_cmd("merge_queue.retry", json!({ "land_id": land_id }));
    }

    pub fn merge_queue_eject(&mut self, land_id: &str) {
        if self.is_mock {
            if let Some(land) = self.lands_by_id.get_mut(land_id) {
                land.status = "failed".to_string();
                land.pause_reason = None;
                land.queue_position = None;
                if let Some(sess) = self.sessions_by_id.get_mut(&land.session_id) {
                    sess.status = "idle".to_string();
                }
            }
            if let Some(mq) = &mut self.merge_queue {
                mq.queued.retain(|l| l.id != land_id);
                mq.settings.paused = false;
            }
            self.sync_mock_merge_queue_head();
            return;
        }
        self.send_cmd("merge_queue.eject", json!({ "land_id": land_id }));
    }

    pub fn merge_queue_remove(&mut self, land_id: &str) {
        if self.is_mock {
            if let Some(land) = self.lands_by_id.get_mut(land_id) {
                land.status = "proposed".to_string();
                land.pause_reason = None;
                land.queue_position = None;
                if let Some(sess) = self.sessions_by_id.get_mut(&land.session_id) {
                    sess.status = "idle".to_string();
                }
            }
            if let Some(mq) = &mut self.merge_queue {
                mq.queued.retain(|l| l.id != land_id);
                mq.settings.paused = false;
            }
            self.sync_mock_merge_queue_head();
            return;
        }
        self.send_cmd("merge_queue.remove", json!({ "land_id": land_id }));
    }

    pub fn merge_queue_cycle_bot(&mut self) {
        if self.bots.is_empty() {
            return;
        }
        let current = self
            .merge_queue
            .as_ref()
            .and_then(|q| q.settings.bot_id.as_deref());
        let next_idx = current
            .and_then(|cid| self.bots.iter().position(|b| b.id == cid))
            .map(|i| (i + 1) % self.bots.len())
            .unwrap_or(0);
        let next_bot_id = self.bots[next_idx].id.clone();
        if self.is_mock {
            if let Some(mq) = &mut self.merge_queue {
                mq.settings.bot_id = Some(next_bot_id);
            }
            return;
        }
        self.send_cmd("merge_queue.configure", json!({ "bot_id": next_bot_id }));
    }

    pub fn merge_queue_toggle_conflict_policy(&mut self) {
        let current = self
            .merge_queue
            .as_ref()
            .map(|q| q.settings.conflict_policy.as_str())
            .unwrap_or("pause_on_issue");
        let next = if current == "auto_resolve_trivial" {
            "pause_on_issue"
        } else {
            "auto_resolve_trivial"
        };
        if self.is_mock {
            if let Some(mq) = &mut self.merge_queue {
                mq.settings.conflict_policy = next.to_string();
            }
            return;
        }
        self.send_cmd("merge_queue.configure", json!({ "conflict_policy": next }));
    }

    pub fn merge_queue_toggle_default_landing_mode(&mut self) {
        let current = self
            .merge_queue
            .as_ref()
            .map(|q| q.settings.default_landing_mode.as_str())
            .unwrap_or("manual");
        let next = if current == "auto" { "manual" } else { "auto" };
        if self.is_mock {
            if let Some(mq) = &mut self.merge_queue {
                mq.settings.default_landing_mode = next.to_string();
            }
            if let Some(mq_s) = &mut self.settings.merge_queue {
                mq_s.default_landing_mode = next.to_string();
            }
            return;
        }
        self.send_cmd(
            "merge_queue.configure",
            json!({ "default_landing_mode": next }),
        );
    }

    pub fn save_repository_settings(&mut self) {
        let url = self.repo_url_input.trim().to_string();
        let branch = self.repo_branch_input.trim().to_string();
        let verify = self.repo_verify_input.trim().to_string();
        if url.is_empty() || branch.is_empty() {
            self.error_banner = Some("Repository URL and default branch are required.".to_string());
            return;
        }
        self.error_banner = None;
        self.status_banner = Some("Cloning bare repository and verifying branch...".to_string());
        self.send_cmd(
            "settings.update",
            json!({
                "repo": { "url": url, "default_branch": branch },
                "verify_command": verify,
            }),
        );
    }

    pub fn save_models_settings(&mut self) {
        let prov_name = self.provider_name_input.trim().to_string();
        let prov_url = self.provider_base_url_input.trim().to_string();
        let model_id = self.provider_model_input.trim().to_string();
        let prov_key = self.provider_api_key_input.trim().to_string();
        let dec_url = self.decision_base_url_input.trim().to_string();
        let dec_model = self.decision_model_input.trim().to_string();
        let dec_key = self.decision_api_key_input.trim().to_string();

        if prov_name.is_empty() || prov_url.is_empty() || model_id.is_empty() {
            self.error_banner =
                Some("Provider name, base URL, and model ID are required.".to_string());
            return;
        }
        if dec_url.is_empty() || dec_model.is_empty() {
            self.error_banner = Some("Decision base URL and model ID are required.".to_string());
            return;
        }

        let is_deepseek = model_id.to_lowercase().contains("deepseek");
        let model_obj = if is_deepseek {
            json!({
                "id": model_id,
                "name": model_id,
                "reasoning": true,
                "contextWindow": 1048576,
                "maxTokens": 393216,
                "thinkingLevelMap": { "minimal": null, "low": "low", "medium": "high", "high": "high", "xhigh": null, "max": "max" },
                "compat": { "thinkingFormat": "deepseek", "supportsReasoningEffort": true, "maxTokensField": "max_tokens" }
            })
        } else {
            json!({
                "id": model_id,
                "name": model_id,
                "reasoning": false,
                "contextWindow": 128000,
                "maxTokens": 16384
            })
        };

        let mut provider_entry = json!({
            "baseUrl": prov_url,
            "api": "openai-completions",
            "models": [model_obj]
        });
        if !prov_key.is_empty() {
            provider_entry["apiKey"] = json!(prov_key);
        }

        let decision_provider = if dec_url.contains("127.0.0.1") || dec_url.contains("localhost") {
            "stub"
        } else {
            "subq"
        };
        let mut decision_role = json!({
            "provider": decision_provider,
            "baseUrl": dec_url,
            "model": dec_model,
        });
        if !dec_key.is_empty() {
            decision_role["apiKey"] = json!(dec_key);
        }

        self.error_banner = None;
        self.status_banner = Some("Saving models and writing models.json...".to_string());
        self.send_cmd(
            "settings.update",
            json!({
                "providers": { prov_name: provider_entry },
                "roles": {
                    "default": {
                        "provider": self.provider_name_input.trim(),
                        "model": self.provider_model_input.trim(),
                        "thinking_level": self.bot_thinking_input.trim(),
                    },
                    "decision": decision_role,
                }
            }),
        );
        self.provider_api_key_input.clear();
        self.decision_api_key_input.clear();
    }

    pub fn test_models(&mut self) {
        if self.is_mock {
            return;
        }
        self.models_test_pending = true;
        self.models_test_result = None;
        self.send_cmd("models.test", json!({}));
    }

    pub fn save_bot(&mut self) {
        let name = self.bot_name_input.trim().to_string();
        if name.is_empty() {
            self.error_banner = Some("Bot name is required.".to_string());
            return;
        }
        let persona = self.bot_persona_input.trim().to_string();
        let model = self.bot_model_input.trim().to_string();
        let thinking = self.bot_thinking_input.trim().to_string();

        self.error_banner = None;
        if let Some(bot_id) = self.editing_bot_id.clone() {
            self.send_cmd(
                "bot.update",
                json!({
                    "bot_id": bot_id,
                    "name": name,
                    "persona": persona,
                    "model": model,
                    "thinking_level": thinking,
                    "sandbox_enabled": self.bot_sandbox_enabled,
                    "sandbox_network": self.bot_sandbox_network,
                }),
            );
        } else {
            self.send_cmd(
                "bot.create",
                json!({
                    "name": name,
                    "persona": persona,
                    "model": if model.is_empty() { Value::Null } else { json!(model) },
                    "thinking_level": if thinking.is_empty() { "medium" } else { thinking.as_str() },
                    "sandbox_enabled": self.bot_sandbox_enabled,
                    "sandbox_network": self.bot_sandbox_network,
                }),
            );
        }
    }

    pub fn create_invite(&mut self) {
        if self.is_mock {
            self.last_invite_link = Some("kawan://127.0.0.1:8787/mock-invite-token".to_string());
            return;
        }
        let note = self.invite_note_input.trim().to_string();
        self.send_cmd(
            "invite.create",
            json!({ "note": if note.is_empty() { Value::Null } else { json!(note) } }),
        );
    }

    pub fn active_conversation(&self) -> Option<&Conversation> {
        let cid = self.active_conversation_id.as_deref()?;
        self.conversations.iter().find(|c| c.id == cid)
    }

    pub fn active_messages(&self) -> &[Message] {
        self.active_conversation_id
            .as_deref()
            .and_then(|cid| self.messages_by_conv.get(cid))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn decisions_for_message(&self, msg_id: &str) -> Vec<&Decision> {
        let Some(cid) = self.active_conversation_id.as_deref() else {
            return Vec::new();
        };
        let Some(list) = self.decisions_by_conv.get(cid) else {
            return Vec::new();
        };
        list.iter().filter(|d| d.message_id == msg_id).collect()
    }

    pub fn worker_sessions_for_active(&self) -> Vec<&SessionSummary> {
        let mut out: Vec<&SessionSummary> = self
            .sessions_by_id
            .values()
            .filter(|s| {
                s.kind == "worker"
                    && (self.active_conversation_id.is_none()
                        || s.conversation_id.as_deref() == self.active_conversation_id.as_deref())
            })
            .collect();
        out.sort_by_key(|s| s.created_at);
        out
    }

    pub fn all_worker_sessions(&self) -> Vec<&SessionSummary> {
        let mut out: Vec<&SessionSummary> = self
            .sessions_by_id
            .values()
            .filter(|s| s.kind == "worker")
            .collect();
        out.sort_by_key(|s| s.created_at);
        out
    }

    pub fn worker_sessions_for_bot(&self, bot_id: &str) -> Vec<&SessionSummary> {
        let mut out: Vec<&SessionSummary> = self
            .sessions_by_id
            .values()
            .filter(|s| s.kind == "worker" && s.bot_id == bot_id)
            .collect();
        out.sort_by_key(|s| {
            let prio = match s.status.as_str() {
                "running" => 0_u8,
                "pending_approval" => 1,
                "failed" => 2,
                _ => 3,
            };
            (prio, std::cmp::Reverse(s.updated_at))
        });
        out
    }

    pub fn active_dm_bot(&self) -> Option<&BotSummary> {
        let conv = self.active_conversation()?;
        if conv.kind != "dm" {
            return None;
        }
        let members = self.members_by_conv.get(&conv.id)?;
        let bot_member = members
            .iter()
            .find(|m| m.kind == "bot" && m.id != self.current_user_id)?;
        self.bots.iter().find(|b| b.id == bot_member.id)
    }

    pub fn conversation_label(&self, conv_id: &str) -> String {
        if let Some(conv) = self.conversations.iter().find(|c| c.id == conv_id) {
            if conv.kind == "merge_queue" {
                return "#merge-queue".to_string();
            }
            if conv.kind == "issue" {
                if let Some(issue) = self.issue_by_conv(conv_id) {
                    return format!("#{}", issue.number);
                }
                return format!("#{}", conv.name.as_deref().unwrap_or("issue"));
            }
            if conv.kind == "channel" {
                return format!("#{}", conv.name.as_deref().unwrap_or("channel"));
            }
            if let Some(members) = self.members_by_conv.get(conv_id)
                && let Some(peer) = members.iter().find(|m| m.id != self.current_user_id)
            {
                return if peer.kind == "bot" {
                    format!("@{}", peer.name)
                } else {
                    peer.name.clone()
                };
            }
            return "DM".to_string();
        }
        "chat".to_string()
    }

    pub fn land_for_session(&self, session_id: &str) -> Option<&Land> {
        let mut matches: Vec<&Land> = self
            .lands_by_id
            .values()
            .filter(|l| l.session_id == session_id)
            .collect();
        matches.sort_by_key(|l| l.created_at);
        matches.last().copied()
    }

    pub fn actor_name(&self, user_id: &str) -> String {
        if let Some(cid) = self.active_conversation_id.as_deref()
            && let Some(members) = self.members_by_conv.get(cid)
            && let Some(m) = members.iter().find(|m| m.id == user_id)
        {
            return m.name.clone();
        }
        if let Some(b) = self.bots.iter().find(|b| b.id == user_id) {
            return b.name.clone();
        }
        if let Some(u) = self.users.iter().find(|u| u.id == user_id) {
            return u.name.clone();
        }
        if user_id == self.current_user_id && !self.current_user_name.is_empty() {
            return self.current_user_name.clone();
        }
        user_id.chars().take(8).collect()
    }

    pub fn actor_is_bot(&self, user_id: &str) -> bool {
        if let Some(cid) = self.active_conversation_id.as_deref()
            && let Some(members) = self.members_by_conv.get(cid)
            && let Some(m) = members.iter().find(|m| m.id == user_id)
        {
            return m.kind == "bot";
        }
        self.bots.iter().any(|b| b.id == user_id)
    }

    pub fn handle_key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let mods = event.keystroke.modifiers;

        if key == "escape" {
            self.redirect_menu_decision_id = None;
            self.show_add_member = false;
            self.show_new_channel = false;
            self.show_new_issue_form = false;
            self.editing_issue_id = None;
            return;
        }

        if key == "tab" {
            self.cycle_focus_target(mods.shift);
            return;
        }

        if mods.control && key == "u" {
            self.focused_string_mut().clear();
            return;
        }

        if (mods.control || mods.platform) && key == "v" {
            if let Some(pasted) = cx.read_from_clipboard().and_then(|item| item.text()) {
                let sanitized = sanitize_paste(self.focus_target, &pasted);
                if !sanitized.is_empty() {
                    self.focused_string_mut().push_str(&sanitized);
                    self.maybe_parse_invite_link();
                }
            }
            return;
        }

        if key == "enter" && mods.shift {
            if matches!(
                self.focus_target,
                FocusTarget::IssueBody | FocusTarget::IssueEditBody
            ) {
                self.focused_string_mut().push('\n');
            }
            return;
        }

        if key == "enter" && !mods.shift {
            match self.focus_target {
                FocusTarget::ConnectHost
                | FocusTarget::ConnectToken
                | FocusTarget::ConnectName
                | FocusTarget::ConnectKeyPath => self.start_connect(cx),
                FocusTarget::Composer => self.send_composer_message(),
                FocusTarget::ThreadComposer => self.send_thread_reply(),
                FocusTarget::NewChannelName => self.create_channel(),
                FocusTarget::IssueTitle => {
                    if !self.new_issue_title.trim().is_empty() {
                        self.focus_target = FocusTarget::IssueBody;
                    }
                }
                FocusTarget::IssueEditTitle => {
                    if let Some(iid) = self.editing_issue_id.clone() {
                        self.save_edit_issue(&iid);
                    }
                }
                FocusTarget::IssueBody | FocusTarget::IssueEditBody => {
                    self.focused_string_mut().push('\n');
                }
                _ => {}
            }
            return;
        }

        if key == "backspace" {
            self.focused_string_mut().pop();
            return;
        }

        if !mods.control
            && !mods.platform
            && !mods.alt
            && let Some(ch_str) = &event.keystroke.key_char
            && !ch_str.is_empty()
            && !ch_str.chars().any(|c| c.is_control())
        {
            self.focused_string_mut().push_str(ch_str);
            self.maybe_parse_invite_link();
        }
    }

    fn maybe_parse_invite_link(&mut self) {
        if matches!(
            self.focus_target,
            FocusTarget::ConnectHost | FocusTarget::ConnectToken
        ) {
            let raw = self.focused_string_mut().clone();
            if let Some((u, tok)) = parse_invite_link(&raw) {
                self.connect_host = u;
                self.connect_token = tok;
                self.auth_mode = AuthMode::Register;
            }
        }
    }

    fn focused_string_mut(&mut self) -> &mut String {
        match self.focus_target {
            FocusTarget::ConnectHost => &mut self.connect_host,
            FocusTarget::ConnectToken => &mut self.connect_token,
            FocusTarget::ConnectName => &mut self.connect_name,
            FocusTarget::ConnectKeyPath => &mut self.connect_key_path,
            FocusTarget::Composer => &mut self.composer_text,
            FocusTarget::ThreadComposer => &mut self.thread_composer_text,
            FocusTarget::NewChannelName => &mut self.new_channel_name,
            FocusTarget::RepoUrl => &mut self.repo_url_input,
            FocusTarget::RepoBranch => &mut self.repo_branch_input,
            FocusTarget::RepoVerifyCmd => &mut self.repo_verify_input,
            FocusTarget::ProviderName => &mut self.provider_name_input,
            FocusTarget::ProviderBaseUrl => &mut self.provider_base_url_input,
            FocusTarget::ProviderModelId => &mut self.provider_model_input,
            FocusTarget::ProviderApiKey => &mut self.provider_api_key_input,
            FocusTarget::DecisionBaseUrl => &mut self.decision_base_url_input,
            FocusTarget::DecisionModel => &mut self.decision_model_input,
            FocusTarget::DecisionApiKey => &mut self.decision_api_key_input,
            FocusTarget::BotName => &mut self.bot_name_input,
            FocusTarget::BotPersona => &mut self.bot_persona_input,
            FocusTarget::BotModel => &mut self.bot_model_input,
            FocusTarget::BotThinking => &mut self.bot_thinking_input,
            FocusTarget::InviteNote => &mut self.invite_note_input,
            FocusTarget::IssueTitle => &mut self.new_issue_title,
            FocusTarget::IssueBody => &mut self.new_issue_body,
            FocusTarget::IssueEditTitle => &mut self.edit_issue_title,
            FocusTarget::IssueEditBody => &mut self.edit_issue_body,
        }
    }

    fn cycle_focus_target(&mut self, reverse: bool) {
        let group: &[FocusTarget] = match &self.screen {
            Screen::Connect => match self.auth_mode {
                AuthMode::Login => &[FocusTarget::ConnectHost, FocusTarget::ConnectKeyPath],
                AuthMode::Bootstrap | AuthMode::Register => &[
                    FocusTarget::ConnectHost,
                    FocusTarget::ConnectToken,
                    FocusTarget::ConnectName,
                    FocusTarget::ConnectKeyPath,
                ],
            },
            Screen::Workspace(WorkspacePage::Issues) if self.show_new_issue_form => {
                &[FocusTarget::IssueTitle, FocusTarget::IssueBody]
            }
            Screen::Workspace(WorkspacePage::IssueDetail(_)) if self.editing_issue_id.is_some() => {
                &[FocusTarget::IssueEditTitle, FocusTarget::IssueEditBody]
            }
            Screen::Workspace(WorkspacePage::Settings(SettingsTab::Repository)) => &[
                FocusTarget::RepoUrl,
                FocusTarget::RepoBranch,
                FocusTarget::RepoVerifyCmd,
            ],
            Screen::Workspace(WorkspacePage::Settings(SettingsTab::Models)) => &[
                FocusTarget::ProviderName,
                FocusTarget::ProviderBaseUrl,
                FocusTarget::ProviderModelId,
                FocusTarget::ProviderApiKey,
                FocusTarget::DecisionBaseUrl,
                FocusTarget::DecisionModel,
                FocusTarget::DecisionApiKey,
            ],
            Screen::Workspace(WorkspacePage::Settings(SettingsTab::Bots)) => &[
                FocusTarget::BotName,
                FocusTarget::BotPersona,
                FocusTarget::BotModel,
                FocusTarget::BotThinking,
                FocusTarget::InviteNote,
            ],
            _ => return,
        };
        if let Some(pos) = group.iter().position(|t| *t == self.focus_target) {
            let next = if reverse {
                (pos + group.len() - 1) % group.len()
            } else {
                (pos + 1) % group.len()
            };
            self.focus_target = group[next];
        } else if let Some(first) = group.first() {
            self.focus_target = *first;
        }
    }
}

/// Decoded-image format for an artifact mime type, when it is an image.
fn image_format_for_mime(mime_type: &str) -> Option<ImageFormat> {
    let mime = mime_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    ImageFormat::from_mime_type(&mime)
}

fn sanitize_paste(target: FocusTarget, text: &str) -> String {
    match target {
        FocusTarget::IssueBody | FocusTarget::IssueEditBody => text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .trim_end_matches('\n')
            .to_string(),
        FocusTarget::Composer | FocusTarget::ThreadComposer | FocusTarget::BotPersona => text
            .trim_end_matches(['\r', '\n'])
            .replace("\r\n", " ")
            .replace(['\r', '\n'], " "),
        _ => text.replace(['\r', '\n'], "").trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_single_line_and_prose_pastes() {
        assert_eq!(
            sanitize_paste(FocusTarget::ProviderApiKey, "  sk-example-123\r\n "),
            "sk-example-123"
        );
        assert_eq!(
            sanitize_paste(FocusTarget::ConnectToken, "kawan://127.0.0.1:8787/tok\n"),
            "kawan://127.0.0.1:8787/tok"
        );
        assert_eq!(
            sanitize_paste(FocusTarget::RepoVerifyCmd, " cargo test --workspace\n"),
            "cargo test --workspace"
        );
        assert_eq!(
            sanitize_paste(FocusTarget::Composer, "line one\r\nline two\n"),
            "line one line two"
        );
        assert_eq!(
            sanitize_paste(FocusTarget::BotPersona, "First sentence.\nSecond.\r\n"),
            "First sentence. Second."
        );
    }
}

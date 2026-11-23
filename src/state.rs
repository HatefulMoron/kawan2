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
    ConversationCreateData, ConversationListData, ConversationOpenData, Decision, InviteCreateData,
    Land, LandApproveData, Member, Message, ModelsTestData, ServerFrame, SessionListData,
    SessionOpenData, SessionSummary, SettingsView, SetupStatus, UserListData, UserSummary,
    parse_invite_link,
};
use crate::ssh::default_ssh_key_path;
use crate::ws_client::{AuthMode, ConnectConfig, WsEvent, WsHandle};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Screen {
    Connect,
    Checklist,
    Workspace(WorkspacePage),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspacePage {
    Conversation,
    Settings(SettingsTab),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsTab {
    Repository,
    Models,
    Bots,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RightPanel {
    None,
    Thread(String),
    Session(String),
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
    pub conv_errors: HashMap<String, Vec<ConversationError>>,
    pub loaded_artifacts: HashMap<String, LoadedArtifact>,
    pub expanded_artifacts: HashSet<String>,
    pub session_entries: HashMap<String, Vec<Value>>,

    // Conversation interactive state
    pub composer_text: String,
    pub thread_composer_text: String,
    pub right_panel: RightPanel,
    pub redirect_menu_decision_id: Option<String>,
    pub show_add_member: bool,
    pub show_new_channel: bool,
    pub new_channel_name: String,

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
            conv_errors: HashMap::new(),
            loaded_artifacts: HashMap::new(),
            expanded_artifacts: HashSet::new(),
            session_entries: HashMap::new(),

            composer_text: String::new(),
            thread_composer_text: String::new(),
            right_panel: RightPanel::None,
            redirect_menu_decision_id: None,
            show_add_member: false,
            show_new_channel: false,
            new_channel_name: String::new(),

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
                let list = self.messages_by_conv.entry(conv_id).or_default();
                if !list.iter().any(|m| m.id == message.id) {
                    list.push(message);
                    list.sort_by_key(|m| m.seq);
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
                self.lands_by_id.insert(land.id.clone(), land);
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
                        && let Some(first) = self.conversations.first()
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
                    self.messages_by_conv.insert(cid.clone(), res.messages);
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
                        if res.mime_type.starts_with("image/") {
                            let fmt = if res.mime_type.contains("jpeg")
                                || res.mime_type.contains("jpg")
                            {
                                Some(ImageFormat::Jpeg)
                            } else if res.mime_type.contains("webp") {
                                Some(ImageFormat::Webp)
                            } else {
                                Some(ImageFormat::Png)
                            };
                            if let Some(fmt) = fmt {
                                image = Some(Arc::new(Image::from_bytes(fmt, bytes)));
                            }
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
            "land.approve" => {
                if let Ok(res) = serde_json::from_value::<LandApproveData>(val) {
                    self.lands_by_id.insert(res.land.id.clone(), res.land);
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

    fn upsert_conversation(&mut self, conv: Conversation) {
        let cid = conv.id.clone();
        if !conv.members.is_empty() {
            self.members_by_conv
                .insert(cid.clone(), conv.members.clone());
        }
        if let Some(slot) = self.conversations.iter_mut().find(|c| c.id == cid) {
            *slot = conv;
        } else {
            self.conversations.push(conv);
        }
        if self.active_conversation_id.is_none() {
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
    }

    pub fn open_conversation(&mut self, conv_id: &str) {
        self.active_conversation_id = Some(conv_id.to_string());
        self.screen = Screen::Workspace(WorkspacePage::Conversation);
        self.right_panel = RightPanel::None;
        self.redirect_menu_decision_id = None;
        self.show_add_member = false;
        self.focus_target = FocusTarget::Composer;
        if !self.is_mock {
            self.send_cmd("conversation.open", json!({ "conversation_id": conv_id }));
        }
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
        if !self.is_mock {
            self.send_cmd("session.open", json!({ "session_id": session_id }));
        }
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
                    artifact_id: None,
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
                artifact_id: None,
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

    pub fn approve_land(&mut self, land_id: &str) {
        if self.is_mock {
            if let Some(land) = self.lands_by_id.get_mut(land_id) {
                land.status = "landed".to_string();
                land.landed_sha = Some("d92b7f1e88c3".to_string());
                if let Some(sess) = self.sessions_by_id.get_mut(&land.session_id) {
                    sess.status = "landed".to_string();
                }
            }
            return;
        }
        self.send_cmd("land.approve", json!({ "land_id": land_id }));
    }

    pub fn toggle_artifact_view(&mut self, artifact_id: &str) {
        if !self.expanded_artifacts.remove(artifact_id) {
            self.expanded_artifacts.insert(artifact_id.to_string());
            if !self.is_mock && !self.loaded_artifacts.contains_key(artifact_id) {
                self.send_cmd("artifact.get", json!({ "artifact_id": artifact_id }));
            }
        }
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
                "review_requested" => 1,
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
            if conv.kind == "channel" {
                return format!("#{}", conv.name.as_deref().unwrap_or("channel"));
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

        if key == "enter" && !mods.shift {
            match self.focus_target {
                FocusTarget::ConnectHost
                | FocusTarget::ConnectToken
                | FocusTarget::ConnectName
                | FocusTarget::ConnectKeyPath => self.start_connect(cx),
                FocusTarget::Composer => self.send_composer_message(),
                FocusTarget::ThreadComposer => self.send_thread_reply(),
                FocusTarget::NewChannelName => self.create_channel(),
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
        }
    }

    fn cycle_focus_target(&mut self, reverse: bool) {
        let group: &[FocusTarget] = match self.screen {
            Screen::Connect => match self.auth_mode {
                AuthMode::Login => &[FocusTarget::ConnectHost, FocusTarget::ConnectKeyPath],
                AuthMode::Bootstrap | AuthMode::Register => &[
                    FocusTarget::ConnectHost,
                    FocusTarget::ConnectToken,
                    FocusTarget::ConnectName,
                    FocusTarget::ConnectKeyPath,
                ],
            },
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

fn sanitize_paste(target: FocusTarget, text: &str) -> String {
    match target {
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

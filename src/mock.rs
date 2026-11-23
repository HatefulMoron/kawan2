//! Static mock dataset (`KAWAN_MOCK=1`) for headless layout & styling inspection.

use std::collections::HashMap;

use crate::protocol::{
    Artifact, BotSummary, Conversation, Decision, DecisionRoleView, DefaultRoleView, Land, Member,
    Message, ModelDefView, ProviderView, RepoSettingsView, RolesView, SessionSummary, SettingsView,
    SetupStatus, UserSummary,
};
use crate::state::{FocusTarget, KawanApp, LoadedArtifact, Screen, WorkspacePage};

pub fn populate_mock(app: &mut KawanApp) {
    let alice_id = "human-alice".to_string();
    let maya_id = "human-maya".to_string();
    let bot_id = "bot-kawan".to_string();
    let conv_general = "conv-general".to_string();
    let conv_runtime = "conv-runtime".to_string();

    app.current_user_id = alice_id.clone();
    app.current_user_name = "Alice".to_string();
    app.current_user_role = "admin".to_string();

    app.setup = SetupStatus {
        has_repo: true,
        has_models: true,
        has_decision_model: true,
        has_bot: true,
        ready: true,
    };

    let mut providers = HashMap::new();
    providers.insert(
        "lithosai".to_string(),
        ProviderView {
            base_url: "https://api.lithosai.cloud/v1".to_string(),
            api: "openai-completions".to_string(),
            auth_header: false,
            api_key_configured: true,
            models: vec![ModelDefView {
                id: "deepseek-ai/DeepSeek-V4.1-Flash".to_string(),
                name: "DeepSeek V4.1 Flash".to_string(),
                reasoning: true,
                context_window: Some(1_048_576),
                max_tokens: Some(393_216),
            }],
        },
    );
    app.settings = SettingsView {
        host_ssh_pubkey: Some(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockHostPubkey kawan-host".to_string(),
        ),
        repo: Some(RepoSettingsView {
            url: "git@github.com:kawan-dev/kawan.git".to_string(),
            default_branch: "main".to_string(),
            bare_path: "/var/lib/kawan/repo.git".to_string(),
            https_token_configured: false,
        }),
        verify_command: Some("cargo test --workspace".to_string()),
        providers,
        roles: RolesView {
            default: Some(DefaultRoleView {
                provider: "lithosai".to_string(),
                model: "deepseek-ai/DeepSeek-V4.1-Flash".to_string(),
                thinking_level: Some("medium".to_string()),
            }),
            decision: Some(DecisionRoleView {
                provider: "subq".to_string(),
                base_url: "https://api.subq.ai/v1".to_string(),
                model: "subq-snap-1.2".to_string(),
                api_key_configured: true,
            }),
        },
        setup: app.setup.clone(),
    };

    app.users = vec![
        UserSummary {
            id: alice_id.clone(),
            kind: "human".to_string(),
            role: "admin".to_string(),
            name: "Alice".to_string(),
            email: None,
            created_at: 1,
        },
        UserSummary {
            id: maya_id.clone(),
            kind: "human".to_string(),
            role: "member".to_string(),
            name: "Maya Lin".to_string(),
            email: None,
            created_at: 2,
        },
        UserSummary {
            id: bot_id.clone(),
            kind: "bot".to_string(),
            role: "member".to_string(),
            name: "kawan".to_string(),
            email: Some("kawan@kawan.local".to_string()),
            created_at: 3,
        },
    ];

    app.bots = vec![BotSummary {
        id: bot_id.clone(),
        kind: "bot".to_string(),
        name: "kawan".to_string(),
        email: Some("kawan@kawan.local".to_string()),
        persona: Some("Concise, practical software engineering orchestrator.".to_string()),
        model: Some("lithosai/deepseek-ai/DeepSeek-V4.1-Flash".to_string()),
        thinking_level: Some("medium".to_string()),
        sandbox_enabled: true,
        sandbox_network: true,
        signing_pubkey: Some(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockBotKey kawan@kawan.local".to_string(),
        ),
        orchestrator_session_id: Some("orch-1".to_string()),
        orchestrator_status: "idle".to_string(),
        created_at: 3,
    }];

    let members = vec![
        Member {
            id: alice_id.clone(),
            kind: "human".to_string(),
            name: "Alice".to_string(),
            role: "admin".to_string(),
        },
        Member {
            id: maya_id.clone(),
            kind: "human".to_string(),
            name: "Maya Lin".to_string(),
            role: "member".to_string(),
        },
        Member {
            id: bot_id.clone(),
            kind: "bot".to_string(),
            name: "kawan".to_string(),
            role: "member".to_string(),
        },
    ];

    app.conversations = vec![
        Conversation {
            id: conv_general.clone(),
            kind: "channel".to_string(),
            name: Some("general".to_string()),
            topic: Some("General project conversation".to_string()),
            next_seq: 2,
            created_at: 1,
            last_seq: 1,
            members: members.clone(),
        },
        Conversation {
            id: conv_runtime.clone(),
            kind: "channel".to_string(),
            name: Some("runtime".to_string()),
            topic: Some(
                "Single-machine host, pi worker lifecycle, sandboxes & verify landings".to_string(),
            ),
            next_seq: 6,
            created_at: 2,
            last_seq: 5,
            members: members.clone(),
        },
    ];
    app.members_by_conv
        .insert(conv_general.clone(), members.clone());
    app.members_by_conv.insert(conv_runtime.clone(), members);
    app.active_conversation_id = Some(conv_runtime.clone());

    let sess_1 = "8f2a9c41-0001-4000-8000-000000000001".to_string();
    let sess_2 = "3b71d20e-0002-4000-8000-000000000002".to_string();
    let art_1 = "art-pty-check".to_string();
    let land_1 = "land-pty-check".to_string();

    app.sessions_by_id.insert(
        sess_1.clone(),
        SessionSummary {
            id: sess_1.clone(),
            bot_id: bot_id.clone(),
            parent_session_id: Some("orch-1".to_string()),
            kind: "worker".to_string(),
            conversation_id: Some(conv_runtime.clone()),
            thread_id: Some("msg-2".to_string()),
            task: Some("Fix WorkerPty teardown FD leak and add verification test".to_string()),
            status: "review_requested".to_string(),
            branch: Some(format!("kawan/{sess_1}")),
            clone_path: Some("/var/lib/kawan/workspaces/8f2a9c41".to_string()),
            agent_dir: None,
            pi_session_file: None,
            last_entry_id: None,
            last_report: Some(
                "All 42 unit tests pass; open FD count dropped from 312 to 18.".to_string(),
            ),
            soul_snapshot: None,
            created_at: 100,
            updated_at: 200,
        },
    );
    app.sessions_by_id.insert(
        sess_2.clone(),
        SessionSummary {
            id: sess_2.clone(),
            bot_id: bot_id.clone(),
            parent_session_id: Some("orch-1".to_string()),
            kind: "worker".to_string(),
            conversation_id: Some(conv_runtime.clone()),
            thread_id: Some("msg-5".to_string()),
            task: Some("Wire SSH signature check on bare repository verify-commit".to_string()),
            status: "running".to_string(),
            branch: Some(format!("kawan/{sess_2}")),
            clone_path: None,
            agent_dir: None,
            pi_session_file: None,
            last_entry_id: None,
            last_report: Some("Running verify-commit against bot allowed_signers".to_string()),
            soul_snapshot: None,
            created_at: 210,
            updated_at: 220,
        },
    );

    let artifact_obj = Artifact {
        id: art_1.clone(),
        sha256: "b6e41c739902a1f8".to_string(),
        mime_type: "text/plain".to_string(),
        byte_size: 184,
        filename: Some("pty-check.txt".to_string()),
        session_id: Some(sess_1.clone()),
        conversation_id: Some(conv_runtime.clone()),
        message_id: Some("msg-4".to_string()),
        created_at: 195,
    };
    app.artifacts_by_id
        .insert(art_1.clone(), artifact_obj.clone());
    app.loaded_artifacts.insert(
        art_1.clone(),
        LoadedArtifact {
            text_preview: Some(
                "cargo test pty::teardown ... ok (42 passed, 0 failed)\nopen_fds_before=312 open_fds_after=18\ncommit 7a9d312 signed by kawan@kawan.local"
                    .to_string(),
            ),
            image: None,
        },
    );
    app.expanded_artifacts.insert(art_1.clone());

    app.lands_by_id.insert(
        land_1,
        Land {
            id: "land-pty-check".to_string(),
            session_id: sess_1.clone(),
            conversation_id: conv_runtime.clone(),
            thread_id: Some("msg-2".to_string()),
            status: "requested".to_string(),
            approved_by: None,
            base_sha: Some("c8a41f001122".to_string()),
            landed_sha: None,
            verify_output: None,
            error: None,
            created_at: 196,
            updated_at: 196,
        },
    );

    app.messages_by_conv.insert(
        conv_runtime.clone(),
        vec![
            Message {
                id: "msg-1".to_string(),
                conversation_id: conv_runtime.clone(),
                seq: 1,
                author_id: maya_id.clone(),
                thread_id: None,
                body: "Grabbing coffee before reviewing the timeout logs — did staging recover after the sweep?".to_string(),
                artifact_id: None,
                created_at: 1_795_400_000_000,
            },
            Message {
                id: "msg-2".to_string(),
                conversation_id: conv_runtime.clone(),
                seq: 2,
                author_id: alice_id.clone(),
                thread_id: None,
                body: "@kawan fix the WorkerPty teardown FD leak and add an integration stress check.".to_string(),
                artifact_id: None,
                created_at: 1_795_400_120_000,
            },
            Message {
                id: "msg-3".to_string(),
                conversation_id: conv_runtime.clone(),
                seq: 3,
                author_id: maya_id,
                thread_id: Some("msg-2".to_string()),
                body: "Make sure we kill the whole process group (-pgid), not just the top-level pi pid.".to_string(),
                artifact_id: None,
                created_at: 1_795_400_240_000,
            },
            Message {
                id: "msg-4".to_string(),
                conversation_id: conv_runtime.clone(),
                seq: 4,
                author_id: bot_id,
                thread_id: Some("msg-2".to_string()),
                body: "Finished WorkerPty teardown fix in worker clone and verified across 200 simulated timeouts. Ready for human approval to land.".to_string(),
                artifact_id: Some(art_1),
                created_at: 1_795_400_360_000,
            },
        ],
    );

    app.decisions_by_conv.insert(
        conv_runtime,
        vec![
            Decision {
                id: "dec-1".to_string(),
                conversation_id: "conv-runtime".to_string(),
                message_id: "msg-1".to_string(),
                bot_id: "bot-kawan".to_string(),
                decision_type: "route_message".to_string(),
                destination: "none".to_string(),
                readiness: "dispatch".to_string(),
                confidence: 0.96,
                reason: "destination=none (96%), readiness=dispatch (99%)".to_string(),
                raw_json: "{}".to_string(),
                held_batch_id: None,
                dispatched: 1,
                redirected_from: None,
                redirected_by: None,
                hold_expires_at: None,
                created_at: 1_795_400_001_000,
            },
            Decision {
                id: "dec-2".to_string(),
                conversation_id: "conv-runtime".to_string(),
                message_id: "msg-2".to_string(),
                bot_id: "bot-kawan".to_string(),
                decision_type: "route_message".to_string(),
                destination: "orchestrator".to_string(),
                readiness: "dispatch".to_string(),
                confidence: 0.99,
                reason: "destination=orchestrator (99%), readiness=dispatch (98%)".to_string(),
                raw_json: "{}".to_string(),
                held_batch_id: None,
                dispatched: 1,
                redirected_from: None,
                redirected_by: None,
                hold_expires_at: None,
                created_at: 1_795_400_121_000,
            },
            Decision {
                id: "dec-3".to_string(),
                conversation_id: "conv-runtime".to_string(),
                message_id: "msg-3".to_string(),
                bot_id: "bot-kawan".to_string(),
                decision_type: "route_message".to_string(),
                destination: format!("session:{sess_1}"),
                readiness: "dispatch".to_string(),
                confidence: 0.94,
                reason: "destination=session (94%), readiness=dispatch (97%)".to_string(),
                raw_json: "{}".to_string(),
                held_batch_id: None,
                dispatched: 1,
                redirected_from: None,
                redirected_by: None,
                hold_expires_at: None,
                created_at: 1_795_400_241_000,
            },
        ],
    );

    app.screen = Screen::Workspace(WorkspacePage::Conversation);
    app.focus_target = FocusTarget::Composer;
}

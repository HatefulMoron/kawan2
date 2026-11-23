//! Static mock dataset (`KAWAN_MOCK=1`) for headless layout & styling inspection.

use std::collections::HashMap;

use crate::protocol::{
    Artifact, BotSummary, CheckRunItem, Conversation, Decision, DecisionRoleView, DefaultRoleView,
    Land, Member, MergeQueueSettingsView, MergeQueueSnapshot, Message, ModelDefView, ProviderView,
    RepoSettingsView, RolesView, SessionDiffFile, SessionDiffSummary, SessionSummary, SettingsView,
    SetupStatus, StatusRepoInfo, UserSummary,
};
use crate::state::{FocusTarget, KawanApp, LoadedArtifact, Screen, WorkspacePage};

pub fn populate_mock(app: &mut KawanApp) {
    let alice_id = "human-alice".to_string();
    let maya_id = "human-maya".to_string();
    let bot_id = "bot-kawan".to_string();
    let conv_general = "conv-general".to_string();
    let conv_runtime = "conv-runtime".to_string();
    let conv_mq = "conv-merge-queue".to_string();

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
    app.status_repo = Some(StatusRepoInfo {
        url: "git@github.com:kawan-dev/kawan.git".to_string(),
        default_branch: "main".to_string(),
        head_sha: Some("c8a41f001122aabb".to_string()),
    });

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
        merge_queue: Some(MergeQueueSettingsView {
            bot_id: Some(bot_id.clone()),
            default_landing_mode: "manual".to_string(),
            conflict_policy: "pause_on_issue".to_string(),
            paused: true,
        }),
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
            last_read_seq: 0,
            unread_count: 1,
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
            last_read_seq: 5,
            unread_count: 0,
            members: members.clone(),
        },
        Conversation {
            id: conv_mq.clone(),
            kind: "merge_queue".to_string(),
            name: Some("merge-queue".to_string()),
            topic: Some("Serialized merge train and reconciliation threads".to_string()),
            next_seq: 3,
            created_at: 3,
            last_seq: 2,
            last_read_seq: 1,
            unread_count: 1,
            members: members.clone(),
        },
    ];
    app.members_by_conv
        .insert(conv_general.clone(), members.clone());
    app.members_by_conv
        .insert(conv_runtime.clone(), members.clone());
    app.members_by_conv.insert(conv_mq.clone(), members);
    app.active_conversation_id = Some(conv_runtime.clone());

    let sess_0 = "1a4d0e22-0000-4000-8000-000000000000".to_string();
    let sess_1 = "8f2a9c41-0001-4000-8000-000000000001".to_string();
    let sess_2 = "3b71d20e-0002-4000-8000-000000000002".to_string();
    let sess_3 = "9c12e800-0003-4000-8000-000000000003".to_string();
    let art_0 = "art-hold-report".to_string();
    let art_1 = "art-pty-check".to_string();
    let art_mq = "art-mq-failure".to_string();
    let land_0 = "land-hold-countdown".to_string();
    let land_1 = "land-pty-check".to_string();
    let land_2 = "land-verify-sigs".to_string();

    app.sessions_by_id.insert(
        sess_0.clone(),
        SessionSummary {
            id: sess_0.clone(),
            bot_id: bot_id.clone(),
            parent_session_id: Some("orch-1".to_string()),
            kind: "worker".to_string(),
            conversation_id: Some(conv_general.clone()),
            thread_id: None,
            title: Some("Add SubQ Snap hold countdown timer".to_string()),
            task: Some("Add 10s hold expiry countdown pill and Send Now button.".to_string()),
            status: "landed".to_string(),
            branch: Some(format!("kawan/{sess_0}")),
            clone_path: None,
            agent_dir: None,
            pi_session_file: None,
            last_entry_id: None,
            last_report: Some(
                "Added live countdown chip and immediate dispatch button.".to_string(),
            ),
            soul_snapshot: None,
            created_at: 40,
            updated_at: 95,
        },
    );

    app.sessions_by_id.insert(
        sess_1.clone(),
        SessionSummary {
            id: sess_1.clone(),
            bot_id: bot_id.clone(),
            parent_session_id: Some("orch-1".to_string()),
            kind: "worker".to_string(),
            conversation_id: Some(conv_runtime.clone()),
            thread_id: Some("msg-2".to_string()),
            title: Some("Fix WorkerPty teardown FD leak".to_string()),
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
            title: Some("Verify SSH commit signatures".to_string()),
            task: Some("Wire SSH signature check on bare repository verify-commit".to_string()),
            status: "idle".to_string(),
            branch: Some(format!("kawan/{sess_2}")),
            clone_path: None,
            agent_dir: None,
            pi_session_file: None,
            last_entry_id: None,
            last_report: Some("03-test failed on bare repo allowed_signers check".to_string()),
            soul_snapshot: None,
            created_at: 210,
            updated_at: 220,
        },
    );

    app.sessions_by_id.insert(
        sess_3.clone(),
        SessionSummary {
            id: sess_3,
            bot_id: bot_id.clone(),
            parent_session_id: Some("orch-1".to_string()),
            kind: "worker".to_string(),
            conversation_id: Some(conv_runtime.clone()),
            thread_id: Some("msg-1".to_string()),
            title: Some("Sweep stale staging timeout logs".to_string()),
            task: Some(
                "Inspect staging timeout log rotation settings and add a bounded retention policy."
                    .to_string(),
            ),
            status: "pending_approval".to_string(),
            branch: None,
            clone_path: None,
            agent_dir: None,
            pi_session_file: None,
            last_entry_id: None,
            last_report: None,
            soul_snapshot: None,
            created_at: 230,
            updated_at: 230,
        },
    );

    let art_0_obj = Artifact {
        id: art_0.clone(),
        sha256: "99a01f22e334b810".to_string(),
        mime_type: "text/markdown".to_string(),
        byte_size: 162,
        filename: Some("report.md".to_string()),
        session_id: Some(sess_0.clone()),
        conversation_id: Some(conv_general.clone()),
        message_id: None,
        created_at: 90,
    };
    app.artifacts_by_id.insert(art_0.clone(), art_0_obj);
    app.loaded_artifacts.insert(
        art_0,
        LoadedArtifact {
            text_preview: Some(
                "# Summary\n\nAdded a 10-second readiness hold timer in host/src/server.ts and rendered the live countdown + Send Now action in decision chips."
                    .to_string(),
            ),
            image: None,
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
        land_0.clone(),
        Land {
            id: land_0.clone(),
            session_id: sess_0.clone(),
            conversation_id: conv_general,
            thread_id: None,
            message_id: None,
            status: "landed".to_string(),
            approved_by: Some(alice_id.clone()),
            base_sha: Some("91f02a110099".to_string()),
            landed_sha: Some("c8a41f001122aabb".to_string()),
            verify_output: Some("13 passed, 0 failed".to_string()),
            error: None,
            queue_position: None,
            issue_id: None,
            pause_reason: None,
            queue_session_id: None,
            queue_thread_id: None,
            trigger: Some("manual_approve".to_string()),
            checks: Vec::new(),
            touches_kawan: false,
            created_at: 92,
            updated_at: 95,
        },
    );

    let mock_checks = vec![
        CheckRunItem {
            name: "01-fmt".to_string(),
            ok: true,
            exit_code: Some(0),
            duration_ms: 340,
            output: String::new(),
            artifact_id: None,
        },
        CheckRunItem {
            name: "02-clippy".to_string(),
            ok: true,
            exit_code: Some(0),
            duration_ms: 820,
            output: String::new(),
            artifact_id: None,
        },
        CheckRunItem {
            name: "03-test".to_string(),
            ok: false,
            exit_code: Some(101),
            duration_ms: 1290,
            output: "test ssh::verify_commit_sig ... FAILED\nmissing allowed_signers entry"
                .to_string(),
            artifact_id: Some(art_mq.clone()),
        },
    ];

    let paused_head = Land {
        id: land_2,
        session_id: sess_2,
        conversation_id: conv_runtime.clone(),
        thread_id: Some("msg-5".to_string()),
        message_id: None,
        status: "paused".to_string(),
        approved_by: Some(alice_id.clone()),
        base_sha: Some("c8a41f001122".to_string()),
        landed_sha: None,
        verify_output: Some("03-test failed (2/3 passed)".to_string()),
        error: Some(
            "Verification failed (03-test exit 101):\ntest ssh::verify_commit_sig ... FAILED"
                .to_string(),
        ),
        queue_position: Some(1),
        issue_id: None,
        pause_reason: Some("checks_failed".to_string()),
        queue_session_id: None,
        queue_thread_id: Some("mq-msg-1".to_string()),
        trigger: Some("manual_approve".to_string()),
        checks: mock_checks,
        touches_kawan: false,
        created_at: 215,
        updated_at: 222,
    };

    let queued_second = Land {
        id: land_1.clone(),
        session_id: sess_1.clone(),
        conversation_id: conv_runtime.clone(),
        thread_id: Some("msg-2".to_string()),
        message_id: Some("msg-4".to_string()),
        status: "queued".to_string(),
        approved_by: Some(alice_id.clone()),
        base_sha: Some("c8a41f001122".to_string()),
        landed_sha: None,
        verify_output: None,
        error: None,
        queue_position: Some(2),
        issue_id: None,
        pause_reason: None,
        queue_session_id: None,
        queue_thread_id: None,
        trigger: Some("manual_approve".to_string()),
        checks: Vec::new(),
        touches_kawan: false,
        created_at: 196,
        updated_at: 196,
    };

    app.lands_by_id
        .insert(paused_head.id.clone(), paused_head.clone());
    app.lands_by_id.insert(land_1, queued_second.clone());

    let landed_copy = app.lands_by_id.get(&land_0).cloned();
    app.merge_queue = Some(MergeQueueSnapshot {
        conversation_id: conv_mq.clone(),
        settings: MergeQueueSettingsView {
            bot_id: Some(bot_id.clone()),
            default_landing_mode: "manual".to_string(),
            conflict_policy: "pause_on_issue".to_string(),
            paused: true,
        },
        head: Some(paused_head.clone()),
        queued: vec![paused_head, queued_second],
        paused_land: Some(app.lands_by_id.get("land-verify-sigs").unwrap().clone()),
        recent_landed: landed_copy.into_iter().collect(),
    });

    app.selected_diff_file
        .insert(sess_1.clone(), "src/pty/teardown.rs".to_string());
    app.session_diffs.insert(
        sess_1.clone(),
        SessionDiffSummary {
            available: true,
            base_ref: Some("c8a41f001122".to_string()),
            head_ref: Some("7a9d312ee401".to_string()),
            files_changed: 1,
            insertions: 4,
            deletions: 1,
            truncated: false,
            files: vec![SessionDiffFile {
                path: "src/pty/teardown.rs".to_string(),
                status: "M".to_string(),
                insertions: 4,
                deletions: 1,
                patch: "@@ -18,5 +18,8 @@ pub fn kill_worker_group(pgid: i32) {\n-    unsafe { libc::kill(pgid, libc::SIGTERM); }\n+    // Signal the entire process group so pi child trees clean up FDs.\n+    unsafe {\n+        libc::kill(-pgid, libc::SIGTERM);\n+        libc::close(pty_master_fd);\n+    }\n }"
                    .to_string(),
            }],
            note: None,
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
                author_id: bot_id.clone(),
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
                explicit_work_start: Some("yes".to_string()),
                work_request: Some("yes".to_string()),
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
                explicit_work_start: Some("yes".to_string()),
                work_request: Some("yes".to_string()),
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
                explicit_work_start: Some("yes".to_string()),
                work_request: Some("yes".to_string()),
                created_at: 1_795_400_241_000,
            },
        ],
    );

    app.artifacts_by_id.insert(
        art_mq.clone(),
        Artifact {
            id: art_mq.clone(),
            sha256: "e104ab7711223344".to_string(),
            mime_type: "text/plain".to_string(),
            byte_size: 98,
            filename: Some("merge-failure.log".to_string()),
            session_id: Some("3b71d20e-0002-4000-8000-000000000002".to_string()),
            conversation_id: Some(conv_mq.clone()),
            message_id: Some("mq-msg-1".to_string()),
            created_at: 222,
        },
    );
    app.loaded_artifacts.insert(
        art_mq.clone(),
        LoadedArtifact {
            text_preview: Some(
                "Verification failed (03-test exit 101):\ntest ssh::verify_commit_sig ... FAILED\nallowed_signers missing test key"
                    .to_string(),
            ),
            image: None,
        },
    );
    app.messages_by_conv.insert(
        conv_mq.clone(),
        vec![
            Message {
                id: "mq-msg-1".to_string(),
                conversation_id: conv_mq.clone(),
                seq: 1,
                author_id: bot_id.clone(),
                thread_id: None,
                body: "Paused Merge Queue on \"Verify SSH commit signatures\" (#runtime · post-rebase verification failed).".to_string(),
                artifact_id: Some(art_mq),
                created_at: 1_795_401_000_000,
            },
            Message {
                id: "mq-msg-2".to_string(),
                conversation_id: conv_mq,
                seq: 2,
                author_id: bot_id,
                thread_id: Some("mq-msg-1".to_string()),
                body: "03-test failed because allowed_signers does not include the new signing fixture key. Reply to regenerate allowed_signers or send back to implementer.".to_string(),
                artifact_id: None,
                created_at: 1_795_401_020_000,
            },
        ],
    );

    app.screen = Screen::Workspace(WorkspacePage::Conversation);
    app.focus_target = FocusTarget::Composer;
}

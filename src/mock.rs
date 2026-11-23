//! Static mock dataset (`KAWAN_MOCK=1`) for headless layout & styling inspection.

use std::collections::HashMap;

use crate::protocol::{
    ActiveReviewer, Artifact, BotSummary, CheckRunItem, Conversation, Decision, DecisionRoleView,
    DefaultRoleView, IssueSummary, Land, Member, MergeQueueSettingsView, MergeQueueSnapshot,
    Message, ModelDefView, ProviderView, RepoSettingsView, RolesView, SessionDiffFile,
    SessionDiffSummary, SessionSummary, SettingsView, SetupStatus, StatusRepoInfo, UserSummary,
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
    app.members_by_conv.insert(conv_mq.clone(), members.clone());
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
                author_id: maya_id.clone(),
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
                author_id: bot_id.clone(),
                thread_id: Some("mq-msg-1".to_string()),
                body: "03-test failed because allowed_signers does not include the new signing fixture key. Reply to regenerate allowed_signers or send back to implementer.".to_string(),
                artifact_id: None,
                created_at: 1_795_401_020_000,
            },
        ],
    );

    // Chat-first mock issues (#1 open + needs_input + Checks ✗ + reviewer, #2 open + Checks ✓ ready to Land, #3 open Draft, #4 Landed)
    let conv_i1 = "conv-issue-1".to_string();
    let conv_i2 = "conv-issue-2".to_string();
    let conv_i3 = "conv-issue-3".to_string();
    let conv_i4 = "conv-issue-4".to_string();
    let issue_1 = "mock-issue-1".to_string();
    let issue_2 = "mock-issue-2".to_string();
    let issue_3 = "mock-issue-3".to_string();
    let issue_4 = "mock-issue-4".to_string();
    let sess_i1 = "7b88d100-0004-4000-8000-000000000004".to_string();
    let sess_i2 = "7b88d100-0005-4000-8000-000000000005".to_string();
    let sess_i4 = "7b88d100-0006-4000-8000-000000000006".to_string();

    for (cid, num, title, last_seq, last_read_seq, unread) in [
        (
            &conv_i1,
            1u64,
            "Enforce .kawan/checks exit-code isolation",
            2u64,
            1u64,
            1u64,
        ),
        (
            &conv_i2,
            2u64,
            "Wire per-session token budgets & auto-pause",
            2u64,
            2u64,
            0u64,
        ),
        (
            &conv_i3,
            3u64,
            "Persist per-channel composer drafts across view switches",
            1u64,
            1u64,
            0u64,
        ),
        (
            &conv_i4,
            4u64,
            "Add pre-commit formatting check in .kawan/checks",
            2u64,
            2u64,
            0u64,
        ),
    ] {
        app.conversations.push(Conversation {
            id: cid.clone(),
            kind: "issue".to_string(),
            name: Some(format!("issue-{num}")),
            topic: Some(title.to_string()),
            next_seq: last_seq + 1,
            created_at: 4 + num,
            last_seq,
            last_read_seq,
            unread_count: unread,
            members: members.clone(),
        });
        app.members_by_conv.insert(cid.clone(), members.clone());
    }

    let art_i1_fail = "art-issue-1-checks-fail".to_string();
    app.artifacts_by_id.insert(
        art_i1_fail.clone(),
        Artifact {
            id: art_i1_fail.clone(),
            sha256: "f41c88e02a1901".to_string(),
            mime_type: "text/plain".to_string(),
            byte_size: 218,
            filename: Some("checks-7a12f0c.log".to_string()),
            session_id: Some(sess_i1.clone()),
            conversation_id: Some(conv_i1.clone()),
            message_id: None,
            created_at: 261,
        },
    );
    app.loaded_artifacts.insert(
        art_i1_fail.clone(),
        LoadedArtifact {
            text_preview: Some(
                "[PASS exit=0] 01-fmt (142ms)\n\n[FAIL exit=1] 02-exit-isolation (310ms)\nassertion failed: expected stderr_ring_len > 0 on timeout\n  at host/test/checks.test.ts:84:12"
                    .to_string(),
            ),
            image: None,
        },
    );

    let art_i2_pass = "art-issue-2-checks-pass".to_string();
    app.artifacts_by_id.insert(
        art_i2_pass.clone(),
        Artifact {
            id: art_i2_pass.clone(),
            sha256: "91d44b02cc312".to_string(),
            mime_type: "text/plain".to_string(),
            byte_size: 124,
            filename: Some("checks-9c31b11.log".to_string()),
            session_id: Some(sess_i2.clone()),
            conversation_id: Some(conv_i2.clone()),
            message_id: None,
            created_at: 246,
        },
    );
    app.loaded_artifacts.insert(
        art_i2_pass.clone(),
        LoadedArtifact {
            text_preview: Some(
                "[PASS exit=0] 01-fmt (118ms)\n\n[PASS exit=0] 02-budget-test (845ms)\n24 passed, 0 failed"
                    .to_string(),
            ),
            image: None,
        },
    );

    app.sessions_by_id.insert(
        sess_i1.clone(),
        SessionSummary {
            id: sess_i1.clone(),
            bot_id: bot_id.clone(),
            parent_session_id: None,
            kind: "worker".to_string(),
            conversation_id: Some(conv_i1.clone()),
            thread_id: None,
            title: Some("#1: Enforce .kawan/checks exit-code isolation".to_string()),
            task: Some("Implement Issue #1 check runner isolation".to_string()),
            status: "idle".to_string(),
            branch: Some("kawan/issue-1-7b88d100".to_string()),
            clone_path: Some("/var/lib/kawan/workspaces/issue-1".to_string()),
            agent_dir: None,
            pi_session_file: None,
            last_entry_id: None,
            last_report: Some(
                "Split stdout/stderr buffers; one timeout test still failing.".to_string(),
            ),
            soul_snapshot: None,
            created_at: 250,
            updated_at: 260,
        },
    );
    app.sessions_by_id.insert(
        sess_i2.clone(),
        SessionSummary {
            id: sess_i2.clone(),
            bot_id: bot_id.clone(),
            parent_session_id: None,
            kind: "worker".to_string(),
            conversation_id: Some(conv_i2.clone()),
            thread_id: None,
            title: Some("#2: Wire per-session token budgets & auto-pause".to_string()),
            task: Some("Implement Issue #2 token budget ledger".to_string()),
            status: "idle".to_string(),
            branch: Some("kawan/issue-2-7b88d100".to_string()),
            clone_path: Some("/var/lib/kawan/workspaces/issue-2".to_string()),
            agent_dir: None,
            pi_session_file: None,
            last_entry_id: None,
            last_report: Some(
                "Implemented token budget ledger and warning notifications.".to_string(),
            ),
            soul_snapshot: None,
            created_at: 240,
            updated_at: 246,
        },
    );
    app.sessions_by_id.insert(
        sess_i4.clone(),
        SessionSummary {
            id: sess_i4.clone(),
            bot_id: bot_id.clone(),
            parent_session_id: None,
            kind: "worker".to_string(),
            conversation_id: Some(conv_i4.clone()),
            thread_id: None,
            title: Some("#4: Add pre-commit formatting check in .kawan/checks".to_string()),
            task: Some("Add 00-fmt.sh script inside .kawan/checks/".to_string()),
            status: "landed".to_string(),
            branch: Some("kawan/issue-4-7b88d100".to_string()),
            clone_path: Some("/var/lib/kawan/workspaces/issue-4".to_string()),
            agent_dir: None,
            pi_session_file: None,
            last_entry_id: None,
            last_report: Some("Added .kawan/checks/00-fmt.sh and landed on main.".to_string()),
            soul_snapshot: None,
            created_at: 230,
            updated_at: 235,
        },
    );
    app.lands_by_id.insert(
        "land-issue-4".to_string(),
        Land {
            id: "land-issue-4".to_string(),
            session_id: sess_i4.clone(),
            conversation_id: conv_i4.clone(),
            thread_id: None,
            message_id: None,
            status: "landed".to_string(),
            approved_by: Some(alice_id.clone()),
            base_sha: Some("7b22100a".to_string()),
            landed_sha: Some("e94c20f88a12".to_string()),
            verify_output: Some("00-fmt.sh (exit 0)".to_string()),
            error: None,
            queue_position: None,
            issue_id: Some(issue_4.clone()),
            pause_reason: None,
            queue_session_id: None,
            queue_thread_id: None,
            trigger: Some("manual_approve".to_string()),
            checks: vec![CheckRunItem {
                name: "00-fmt.sh".to_string(),
                ok: true,
                exit_code: Some(0),
                duration_ms: 120,
                output: String::new(),
                artifact_id: None,
            }],
            touches_kawan: true,
            created_at: 232,
            updated_at: 235,
        },
    );

    app.issues_by_id.insert(
        issue_1.clone(),
        IssueSummary {
            id: issue_1.clone(),
            number: 1,
            conversation_id: conv_i1.clone(),
            title: "Enforce .kawan/checks exit-code isolation".to_string(),
            body_md: "## Goal\nEnsure failing `.kawan/checks/*` scripts preserve exact exit code and tail output in artifacts.\n\n- Run scripts in sorted lexical order\n- Capture stderr independently of stdout".to_string(),
            status: "open".to_string(),
            owner_id: alice_id.clone(),
            implementer_bot_id: Some(bot_id.clone()),
            active_session_id: Some(sess_i1),
            parent_issue_id: None,
            needs_input_question: Some(
                "Should killed timeout checks still flush partial stderr before exit code 124?".to_string(),
            ),
            behind_main: 2,
            commits_ahead: 2,
            checks_status: "failed".to_string(),
            checks_sha: Some("7a12f0c".to_string()),
            checks_summary: Some("02-exit-isolation failed (1/2 passed)".to_string()),
            checks: vec![
                CheckRunItem {
                    name: "01-fmt".to_string(),
                    ok: true,
                    exit_code: Some(0),
                    duration_ms: 142,
                    output: String::new(),
                    artifact_id: None,
                },
                CheckRunItem {
                    name: "02-exit-isolation".to_string(),
                    ok: false,
                    exit_code: Some(1),
                    duration_ms: 310,
                    output: "stderr ring empty".to_string(),
                    artifact_id: Some(art_i1_fail.clone()),
                },
            ],
            checks_artifact_id: Some(art_i1_fail),
            touches_kawan: true,
            active_reviewers: vec![ActiveReviewer {
                session_id: "mock-rev-1".to_string(),
                bot_id: "bot-reviewer".to_string(),
                bot_name: "reviewer".to_string(),
                focus: Some("Edge cases".to_string()),
            }],
            created_at: 1_795_401_100_000,
            updated_at: 1_795_401_200_000,
        },
    );
    app.issues_by_id.insert(
        issue_2.clone(),
        IssueSummary {
            id: issue_2.clone(),
            number: 2,
            conversation_id: conv_i2.clone(),
            title: "Wire per-session token budgets & auto-pause".to_string(),
            body_md: "## Goal\nTrack prompt + completion tokens per worker clone and warn cleanly before runaway tool loops.\n\n## Acceptance\n- Emit `session.update` usage telemetry\n- Pause worker when budget hits 100%".to_string(),
            status: "open".to_string(),
            owner_id: maya_id.clone(),
            implementer_bot_id: Some(bot_id.clone()),
            active_session_id: Some(sess_i2),
            parent_issue_id: None,
            needs_input_question: None,
            behind_main: 0,
            commits_ahead: 3,
            checks_status: "passed".to_string(),
            checks_sha: Some("9c31b11".to_string()),
            checks_summary: Some("checks passed (2/2)".to_string()),
            checks: vec![
                CheckRunItem {
                    name: "01-fmt".to_string(),
                    ok: true,
                    exit_code: Some(0),
                    duration_ms: 118,
                    output: String::new(),
                    artifact_id: None,
                },
                CheckRunItem {
                    name: "02-budget-test".to_string(),
                    ok: true,
                    exit_code: Some(0),
                    duration_ms: 845,
                    output: String::new(),
                    artifact_id: None,
                },
            ],
            checks_artifact_id: Some(art_i2_pass),
            touches_kawan: false,
            active_reviewers: Vec::new(),
            created_at: 1_795_400_900_000,
            updated_at: 1_795_401_150_000,
        },
    );
    app.issues_by_id.insert(
        issue_3.clone(),
        IssueSummary {
            id: issue_3,
            number: 3,
            conversation_id: conv_i3.clone(),
            title: "Persist per-channel composer drafts across view switches".to_string(),
            body_md: "Store unsent draft text per conversation ID in `KawanApp` state so switching to Status or Issues does not discard half-written messages.".to_string(),
            status: "open".to_string(),
            owner_id: alice_id.clone(),
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
            created_at: 1_795_400_800_000,
            updated_at: 1_795_400_800_000,
        },
    );
    app.issues_by_id.insert(
        issue_4.clone(),
        IssueSummary {
            id: issue_4,
            number: 4,
            conversation_id: conv_i4.clone(),
            title: "Add pre-commit formatting check in .kawan/checks".to_string(),
            body_md: "## Goal\nAdd `.kawan/checks/00-fmt.sh` to enforce formatting checks cleanly."
                .to_string(),
            status: "landed".to_string(),
            owner_id: alice_id.clone(),
            implementer_bot_id: Some(bot_id.clone()),
            active_session_id: Some(sess_i4),
            parent_issue_id: None,
            needs_input_question: None,
            behind_main: 0,
            commits_ahead: 1,
            checks_status: "passed".to_string(),
            checks_sha: Some("e94c20f".to_string()),
            checks_summary: Some("checks passed (1/1)".to_string()),
            checks: Vec::new(),
            checks_artifact_id: None,
            touches_kawan: true,
            active_reviewers: Vec::new(),
            created_at: 1_795_400_700_000,
            updated_at: 1_795_400_750_000,
        },
    );

    app.messages_by_conv.insert(
        conv_i1,
        vec![
            Message {
                id: "i1-msg-1".to_string(),
                conversation_id: "conv-issue-1".to_string(),
                seq: 1,
                author_id: alice_id.clone(),
                thread_id: None,
                body: "@kawan please implement check runner exit-code isolation per the document above.".to_string(),
                artifact_id: None,
                created_at: 1_795_401_120_000,
            },
            Message {
                id: "i1-msg-2".to_string(),
                conversation_id: "conv-issue-1".to_string(),
                seq: 2,
                author_id: bot_id.clone(),
                thread_id: None,
                body: "@Alice: Should killed timeout checks still flush partial stderr before exit code 124?".to_string(),
                artifact_id: None,
                created_at: 1_795_401_200_000,
            },
        ],
    );
    app.messages_by_conv.insert(
        conv_i2,
        vec![
            Message {
                id: "i2-msg-1".to_string(),
                conversation_id: "conv-issue-2".to_string(),
                seq: 1,
                author_id: maya_id,
                thread_id: None,
                body: "@kawan wire up the token budget ledger; check the document above for telemetry fields.".to_string(),
                artifact_id: None,
                created_at: 1_795_401_060_000,
            },
            Message {
                id: "i2-msg-2".to_string(),
                conversation_id: "conv-issue-2".to_string(),
                seq: 2,
                author_id: bot_id.clone(),
                thread_id: None,
                body: "Committed token budget tracking and telemetry events across 3 commits. Checks are green.".to_string(),
                artifact_id: None,
                created_at: 1_795_401_150_000,
            },
        ],
    );
    app.messages_by_conv.insert(
        conv_i3,
        vec![Message {
            id: "i3-msg-1".to_string(),
            conversation_id: "conv-issue-3".to_string(),
            seq: 1,
            author_id: alice_id.clone(),
            thread_id: None,
            body: "Document drafted — @mention a bot whenever ready to implement.".to_string(),
            artifact_id: None,
            created_at: 1_795_400_800_000,
        }],
    );
    app.messages_by_conv.insert(
        conv_i4,
        vec![
            Message {
                id: "i4-msg-1".to_string(),
                conversation_id: "conv-issue-4".to_string(),
                seq: 1,
                author_id: bot_id,
                thread_id: None,
                body: "Added .kawan/checks/00-fmt.sh cleanly; ready whenever you click Land."
                    .to_string(),
                artifact_id: None,
                created_at: 1_795_401_285_000,
            },
            Message {
                id: "i4-msg-2".to_string(),
                conversation_id: "conv-issue-4".to_string(),
                seq: 2,
                author_id: alice_id,
                thread_id: None,
                body: "Looks good — landed onto main.".to_string(),
                artifact_id: None,
                created_at: 1_795_401_290_000,
            },
        ],
    );

    app.screen = Screen::Workspace(WorkspacePage::Conversation);
    app.focus_target = FocusTarget::Composer;
}

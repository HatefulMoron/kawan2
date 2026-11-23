//! Conversations Folio shell: 256px left rail, 780px stream (decision chips, redirect,
//! Slack-style thread trays, artifact/land cards, composer), 36px bottom session strip,
//! and 420px thread/session drawer.

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, FontWeight, div, img, px, relative};

use crate::kit;
use crate::protocol::{Conversation, Decision, Land, Message, SessionSummary};
use crate::state::{
    FocusTarget, KawanApp, RightPanel, Screen, SessionDrawerTab, SettingsTab, WorkspacePage,
};
use crate::theme::{self, Theme};
use crate::views::{short_id, status_color_hex};

const EDITORIAL_MEASURE: f32 = 780.0;

pub(crate) fn truncate_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let prefix: String = text.chars().take(max_chars.saturating_sub(3)).collect();
    format!("{}...", prefix.trim_end())
}

pub(crate) fn session_display_title(sess: &SessionSummary) -> String {
    if let Some(title) = sess
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return title.to_string();
    }
    if let Some(task) = sess.task.as_deref() {
        let first = task.lines().next().unwrap_or("").trim();
        if !first.is_empty() {
            return truncate_chars(first, 42);
        }
    }
    short_id(&sess.id)
}

pub(crate) fn short_status_label(status: &str) -> &'static str {
    match status {
        "running" => "running",
        "pending_approval" => "proposed",
        "open" => "open",
        "closed" => "closed",
        "queued" => "queued",
        "rebasing" => "rebasing",
        "verifying" => "verifying",
        "paused" => "paused",
        "review_requested" | "requested" => "review",
        "landed" => "landed",
        "failed" => "failed",
        "stopped" => "stopped",
        _ => "idle",
    }
}

pub fn render(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    div()
        .size_full()
        .flex()
        .bg(theme.surface)
        .child(left_rail(app, theme, cx))
        .child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .h_full()
                .flex()
                .flex_col()
                .child(main_stream_pane(app, theme, cx))
                .child(session_strip(app, theme, cx)),
        )
        .children((app.right_panel != RightPanel::None).then(|| right_drawer(app, theme, cx)))
}

pub fn left_rail(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let channels: Vec<&Conversation> = app
        .conversations
        .iter()
        .filter(|c| c.kind == "channel")
        .collect();
    let dm_convs: Vec<&Conversation> = app
        .conversations
        .iter()
        .filter(|c| c.kind == "dm")
        .collect();
    let status_active = matches!(app.screen, Screen::Workspace(WorkspacePage::Status));
    let issues_active = matches!(
        app.screen,
        Screen::Workspace(WorkspacePage::Issues | WorkspacePage::IssueDetail(_))
    );
    let mq_active = matches!(app.screen, Screen::Workspace(WorkspacePage::MergeQueue));
    let conv_page_active = matches!(app.screen, Screen::Workspace(WorkspacePage::Conversation));
    let settings_active = matches!(app.screen, Screen::Workspace(WorkspacePage::Settings(_)));

    let (needs_you_count, waiting_count, in_flight_count) = app.status_counts();
    let (status_badge_label, status_badge_color) = if needs_you_count > 0 {
        (
            format!("{needs_you_count} failed"),
            theme::hex(theme::CATEGORY_VALS),
        )
    } else if waiting_count > 0 {
        (
            format!("{waiting_count} to land"),
            theme::hex(theme::CATEGORY_ACADEMIC),
        )
    } else if in_flight_count > 0 {
        (
            format!("{in_flight_count} active"),
            theme::hex(theme::CATEGORY_INDUSTRY),
        )
    } else {
        (String::new(), theme.fg_tertiary)
    };

    let mut status_row = div()
        .id("rail-status")
        .h(px(30.0))
        .px(px(8.0))
        .rounded(px(2.0))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .cursor_pointer();
    status_row = if status_active {
        status_row
            .relative()
            .overflow_hidden()
            .bg(theme::with_alpha(theme.palette.vivid, 0.09))
            .child(kit::left_edge(theme.dark))
    } else {
        status_row.hover(|s| s.bg(theme.hover))
    };
    let status_row = status_row
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(kit::icon("kawan/status.svg", 13.0, theme.dark))
                .child(theme::label("Status", 13.0, theme.ink)),
        )
        .children((!status_badge_label.is_empty()).then(|| {
            div()
                .flex()
                .items_center()
                .gap(px(5.0))
                .child(kit::swatch(status_badge_color, px(5.0)))
                .child(theme::micro(status_badge_label, 8.0, theme.fg_tertiary))
        }))
        .on_click(cx.listener(|this, _, window, cx| {
            this.open_status();
            window.focus(&this.focus_handle, cx);
            cx.notify();
        }));

    let mq_unread = if mq_active {
        0
    } else {
        app.merge_queue_conversation().map_or(0, |c| c.unread_count)
    };
    let (mq_paused, mq_queued_count) = match &app.merge_queue {
        Some(q) => (q.settings.paused || q.paused_land.is_some(), q.queued.len()),
        None => {
            let queued_lands: Vec<&Land> = app
                .lands_by_id
                .values()
                .filter(|l| {
                    matches!(
                        l.status.as_str(),
                        "queued" | "rebasing" | "verifying" | "paused"
                    )
                })
                .collect();
            (
                queued_lands.iter().any(|l| l.status == "paused"),
                queued_lands.len(),
            )
        }
    };
    let (mq_badge_label, mq_badge_color) = if mq_paused {
        ("paused".to_string(), theme::hex(theme::CATEGORY_VALS))
    } else if mq_queued_count > 0 {
        (
            format!("{mq_queued_count} queued"),
            theme::hex(theme::CATEGORY_ACADEMIC),
        )
    } else {
        (String::new(), theme.fg_tertiary)
    };

    let mut merge_queue_row = div()
        .id("rail-merge-queue")
        .h(px(30.0))
        .px(px(8.0))
        .rounded(px(2.0))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .cursor_pointer();
    merge_queue_row = if mq_active {
        merge_queue_row
            .relative()
            .overflow_hidden()
            .bg(theme::with_alpha(theme.palette.vivid, 0.09))
            .child(kit::left_edge(theme.dark))
    } else {
        merge_queue_row.hover(|s| s.bg(theme.hover))
    };
    let merge_queue_row = merge_queue_row
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(kit::icon("kawan/merge.svg", 13.0, theme.dark))
                .child(theme::label("Merge Queue", 13.0, theme.ink)),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(5.0))
                .children((mq_unread > 0).then(|| kit::swatch(theme.vivid, px(5.0))))
                .children((!mq_badge_label.is_empty()).then(|| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(5.0))
                        .child(kit::swatch(mq_badge_color, px(5.0)))
                        .child(theme::micro(mq_badge_label, 8.0, theme.fg_tertiary))
                })),
        )
        .on_click(cx.listener(|this, _, window, cx| {
            this.open_merge_queue();
            window.focus(&this.focus_handle, cx);
            cx.notify();
        }));

    let open_issues_count = app
        .issues_by_id
        .values()
        .filter(|i| i.status == "open")
        .count();
    let needs_input_issues_count = app
        .issues_by_id
        .values()
        .filter(|i| i.status == "open" && i.needs_input_question.is_some())
        .count();
    let issues_unread = app.issues_by_id.values().any(|i| {
        let open_here = matches!(
            &app.screen,
            Screen::Workspace(WorkspacePage::IssueDetail(open_id)) if open_id == &i.id
        );
        !open_here
            && app
                .conversations
                .iter()
                .find(|c| c.id == i.conversation_id)
                .is_some_and(|c| c.unread_count > 0)
    });
    let (issues_badge_label, issues_badge_color) = if needs_input_issues_count > 0 {
        (
            format!("{needs_input_issues_count} input"),
            theme::hex(theme::CATEGORY_VALS),
        )
    } else if open_issues_count > 0 {
        (
            format!("{open_issues_count} open"),
            theme::hex(theme::CATEGORY_ACADEMIC),
        )
    } else {
        (String::new(), theme.fg_tertiary)
    };

    let mut issues_row = div()
        .id("rail-issues")
        .h(px(30.0))
        .px(px(8.0))
        .rounded(px(2.0))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .cursor_pointer();
    issues_row = if issues_active {
        issues_row
            .relative()
            .overflow_hidden()
            .bg(theme::with_alpha(theme.palette.vivid, 0.09))
            .child(kit::left_edge(theme.dark))
    } else {
        issues_row.hover(|s| s.bg(theme.hover))
    };
    let issues_row = issues_row
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(kit::icon("kawan/issue.svg", 13.0, theme.dark))
                .child(theme::label("Issues", 13.0, theme.ink)),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(5.0))
                .children(issues_unread.then(|| kit::swatch(theme.vivid, px(5.0))))
                .children((!issues_badge_label.is_empty()).then(|| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(5.0))
                        .child(kit::swatch(issues_badge_color, px(5.0)))
                        .child(theme::micro(issues_badge_label, 8.0, theme.fg_tertiary))
                })),
        )
        .on_click(cx.listener(|this, _, window, cx| {
            this.open_issues();
            window.focus(&this.focus_handle, cx);
            cx.notify();
        }));

    let nav_section = div()
        .flex()
        .flex_col()
        .gap(px(3.0))
        .child(div().px(px(6.0)).pb(px(2.0)).child(theme::micro(
            "REPOSITORY",
            9.0,
            theme.fg_tertiary,
        )))
        .child(status_row)
        .child(merge_queue_row)
        .child(issues_row);

    let mut ch_section = div().flex().flex_col().gap(px(3.0)).child(
        div()
            .px(px(6.0))
            .pb(px(2.0))
            .flex()
            .items_center()
            .justify_between()
            .child(theme::micro("CHANNELS", 9.0, theme.fg_tertiary))
            .child(
                div()
                    .id("rail-new-channel-btn")
                    .w(px(18.0))
                    .h(px(18.0))
                    .rounded(px(2.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(theme.hover))
                    .child(kit::icon("ui/plus.svg", 11.0, theme.dark))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.show_new_channel = !this.show_new_channel;
                        if this.show_new_channel {
                            this.focus_target = FocusTarget::NewChannelName;
                        }
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    })),
            ),
    );

    if app.show_new_channel {
        ch_section = ch_section.child(
            div()
                .px(px(4.0))
                .py(px(4.0))
                .flex()
                .items_center()
                .gap(px(4.0))
                .child(div().flex_1().child(kit::text_input_box(
                    "rail-new-channel-input",
                    &app.new_channel_name,
                    "channel-name",
                    app.focus_target == FocusTarget::NewChannelName,
                    false,
                    theme,
                )))
                .child(
                    kit::small_primary_button("rail-create-channel", "Add", theme).on_click(
                        cx.listener(|this, _, window, cx| {
                            this.create_channel();
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }),
                    ),
                ),
        );
    }

    ch_section = ch_section.children(channels.into_iter().enumerate().map(|(ci, ch)| {
        let cid = ch.id.clone();
        let active =
            conv_page_active && app.active_conversation_id.as_deref() == Some(cid.as_str());
        let unread = if active { 0 } else { ch.unread_count };
        let name = ch.name.clone().unwrap_or_else(|| "channel".to_string());
        let mut row = div()
            .id(("rail-ch", ci))
            .h(px(30.0))
            .px(px(8.0))
            .rounded(px(2.0))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .cursor_pointer();
        row = if active {
            row.relative()
                .overflow_hidden()
                .bg(theme::with_alpha(theme.palette.vivid, 0.09))
                .child(kit::left_edge(theme.dark))
        } else {
            row.hover(|s| s.bg(theme.hover))
        };
        row.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(kit::icon("kawan/hash.svg", 12.0, theme.dark))
                .child(theme::label(name, 13.0, theme.ink)),
        )
        .children((unread > 0).then(|| {
            div()
                .flex()
                .items_center()
                .gap(px(4.0))
                .child(kit::swatch(theme.vivid, px(5.0)))
                .child(theme::numeric(unread.to_string(), 9.5, theme.fg_tertiary))
        }))
        .on_click(cx.listener(move |this, _, window, cx| {
            this.open_conversation(&cid);
            window.focus(&this.focus_handle, cx);
            cx.notify();
        }))
    }));

    let dm_section = div()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(div().px(px(6.0)).pb(px(2.0)).child(theme::micro(
            "DIRECT MESSAGES",
            9.0,
            theme.fg_tertiary,
        )))
        .children(app.bots.iter().enumerate().map(|(bi, bot)| {
            let bot_id = bot.id.clone();
            let existing_dm = dm_convs.iter().find(|c| {
                app.members_by_conv
                    .get(&c.id)
                    .is_some_and(|ms| ms.iter().any(|m| m.id == bot_id))
            });
            let active = conv_page_active
                && existing_dm
                    .is_some_and(|c| app.active_conversation_id.as_deref() == Some(c.id.as_str()));
            let unread = if active {
                0
            } else {
                existing_dm.map_or(0, |c| c.unread_count)
            };
            let mut row = div()
                .id(("rail-dm-bot", bi))
                .h(px(30.0))
                .px(px(8.0))
                .rounded(px(2.0))
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .cursor_pointer();
            row = if active {
                row.relative()
                    .overflow_hidden()
                    .bg(theme::with_alpha(theme.palette.vivid, 0.09))
                    .child(kit::left_edge(theme.dark))
            } else {
                row.hover(|s| s.bg(theme.hover))
            };
            let workers = app.worker_sessions_for_bot(&bot.id);
            let workers_running = workers.iter().filter(|s| s.status == "running").count();
            let workers_pending = workers
                .iter()
                .filter(|s| s.status == "pending_approval")
                .count();
            let workers_review = workers
                .iter()
                .filter(|s| s.status == "review_requested")
                .count();
            let workers_failed = workers.iter().filter(|s| s.status == "failed").count();
            let orch_running = bot.orchestrator_status == "running"
                || app.sessions_by_id.values().any(|s| {
                    s.bot_id == bot.id && s.kind == "orchestrator" && s.status == "running"
                });

            let (badge_label, badge_color) = if workers_running > 0 {
                (
                    if workers_running == 1 {
                        "working".to_string()
                    } else {
                        format!("{workers_running} working")
                    },
                    theme::hex(theme::CATEGORY_INDUSTRY),
                )
            } else if orch_running {
                ("thinking".to_string(), theme::hex(theme::CATEGORY_INDUSTRY))
            } else if workers_pending > 0 {
                (
                    format!("{workers_pending} proposed"),
                    theme::hex(theme::CATEGORY_ACADEMIC),
                )
            } else if workers_review > 0 {
                (
                    format!("{workers_review} review"),
                    theme::hex(theme::CATEGORY_ACADEMIC),
                )
            } else if workers_failed > 0 {
                (
                    format!("{workers_failed} failed"),
                    theme::hex(theme::CATEGORY_VALS),
                )
            } else {
                (
                    String::new(),
                    theme::hex(status_color_hex(&bot.orchestrator_status)),
                )
            };

            row.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(kit::bot_avatar(20.0, theme))
                    .child(theme::label(format!("@{}", bot.name), 13.0, theme.ink)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(5.0))
                    .children((unread > 0).then(|| kit::swatch(theme.vivid, px(5.0))))
                    .child(kit::swatch(badge_color, px(5.0)))
                    .children(
                        (!badge_label.is_empty())
                            .then(|| theme::micro(badge_label, 8.0, theme.fg_tertiary)),
                    ),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_dm_with(&bot_id);
                window.focus(&this.focus_handle, cx);
                cx.notify();
            }))
        }))
        .children(
            app.users
                .iter()
                .filter(|u| u.kind == "human" && u.id != app.current_user_id)
                .enumerate()
                .map(|(ui, user)| {
                    let uid = user.id.clone();
                    let existing_dm = dm_convs.iter().find(|c| {
                        app.members_by_conv
                            .get(&c.id)
                            .is_some_and(|ms| ms.iter().any(|m| m.id == uid))
                    });
                    let active = conv_page_active
                        && existing_dm.is_some_and(|c| {
                            app.active_conversation_id.as_deref() == Some(c.id.as_str())
                        });
                    let unread = if active {
                        0
                    } else {
                        existing_dm.map_or(0, |c| c.unread_count)
                    };
                    let mut row = div()
                        .id(("rail-dm-human", ui))
                        .h(px(30.0))
                        .px(px(8.0))
                        .rounded(px(2.0))
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.0))
                        .cursor_pointer();
                    row = if active {
                        row.relative()
                            .overflow_hidden()
                            .bg(theme::with_alpha(theme.palette.vivid, 0.09))
                            .child(kit::left_edge(theme.dark))
                    } else {
                        row.hover(|s| s.bg(theme.hover))
                    };
                    row.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(kit::human_avatar(&user.name, 20.0, theme))
                            .child(theme::label(user.name.clone(), 13.0, theme.ink)),
                    )
                    .children((unread > 0).then(|| {
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .child(kit::swatch(theme.vivid, px(5.0)))
                            .child(theme::numeric(unread.to_string(), 9.5, theme.fg_tertiary))
                    }))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_dm_with(&uid);
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    }))
                }),
        );

    let bottom_settings = div()
        .id("rail-settings")
        .h(px(36.0))
        .w_full()
        .flex_none()
        .px(px(12.0))
        .bg(theme.strip)
        .border_t_1()
        .border_color(theme.border_subtle)
        .relative()
        .overflow_hidden()
        .flex()
        .items_center()
        .justify_between()
        .cursor_pointer()
        .hover(|s| s.bg(theme.hover))
        .children(settings_active.then(|| kit::left_edge(theme.dark)))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(kit::icon("ui/sliders.svg", 13.0, theme.ink))
                .child(theme::label("Settings", 12.5, theme.ink)),
        )
        .child(theme::micro(
            app.current_user_name.clone(),
            8.5,
            theme.fg_tertiary,
        ))
        .on_click(cx.listener(|this, _, window, cx| {
            this.open_settings(SettingsTab::Repository);
            window.focus(&this.focus_handle, cx);
            cx.notify();
        }));

    div()
        .w(px(256.0))
        .h_full()
        .flex_none()
        .border_r_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .flex()
        .flex_col()
        .child(
            kit::strip_bar(theme)
                .child(theme::title("Kawan", 16.0, theme.ink))
                .child(theme::micro(
                    if app.is_mock { "MOCK" } else { "LIVE" },
                    8.5,
                    theme.fg_tertiary,
                )),
        )
        .child(
            div()
                .id("rail-scroll")
                .flex_1()
                .min_h(px(0.0))
                .overflow_y_scroll()
                .py(px(12.0))
                .px(px(12.0))
                .flex()
                .flex_col()
                .gap(px(14.0))
                .child(nav_section)
                .child(kit::hairline(theme.border_subtle))
                .child(ch_section)
                .child(kit::hairline(theme.border_subtle))
                .child(dm_section),
        )
        .child(bottom_settings)
}

fn main_stream_pane(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let conv = app.active_conversation();
    let dm_bot = app.active_dm_bot();
    let (title, subtitle, is_channel) = match conv {
        Some(c) if c.kind == "channel" => (
            format!("#{}", c.name.as_deref().unwrap_or("channel")),
            c.topic
                .clone()
                .unwrap_or_else(|| "Channel conversation".to_string()),
            true,
        ),
        Some(c) => {
            if let Some(bot) = dm_bot {
                let workers = app.worker_sessions_for_bot(&bot.id);
                let running = workers.iter().filter(|s| s.status == "running").count();
                let review = workers
                    .iter()
                    .filter(|s| s.status == "review_requested")
                    .count();
                let mut parts = Vec::new();
                if running > 0 {
                    parts.push(format!("{running} working"));
                }
                if review > 0 {
                    parts.push(format!("{review} awaiting approval"));
                }
                let status_line = if parts.is_empty() {
                    "Idle · no active tasks".to_string()
                } else {
                    parts.join(" · ")
                };
                (format!("@{}", bot.name), status_line, false)
            } else {
                let other = app
                    .members_by_conv
                    .get(&c.id)
                    .and_then(|ms| ms.iter().find(|m| m.id != app.current_user_id))
                    .map(|m| m.name.clone())
                    .unwrap_or_else(|| "Direct message".to_string());
                (other, "Direct message".to_string(), false)
            }
        }
        None => (
            "#general".to_string(),
            "Select or create a conversation".to_string(),
            false,
        ),
    };

    let active_cid = app.active_conversation_id.clone().unwrap_or_default();
    let current_members = app.members_by_conv.get(&active_cid);
    let non_members: Vec<(String, String, bool)> = if is_channel {
        app.users
            .iter()
            .filter(|u| !current_members.is_some_and(|ms| ms.iter().any(|m| m.id == u.id)))
            .map(|u| (u.id.clone(), u.name.clone(), u.kind == "bot"))
            .collect()
    } else {
        Vec::new()
    };

    let messages = app.active_messages();
    let all_ids: HashSet<&str> = messages.iter().map(|m| m.id.as_str()).collect();
    let mut replies_by_parent: HashMap<&str, Vec<&Message>> = HashMap::new();
    let mut top_level_messages: Vec<&Message> = Vec::new();
    for m in messages {
        if let Some(tid) = m.thread_id.as_deref()
            && all_ids.contains(tid)
        {
            replies_by_parent.entry(tid).or_default().push(m);
        } else {
            top_level_messages.push(m);
        }
    }
    let thread_count = replies_by_parent.len();
    let latest_thread = replies_by_parent
        .iter()
        .max_by_key(|(_, rs)| rs.last().map(|r| r.seq).unwrap_or(0))
        .map(|(tid, _)| (*tid).to_string())
        .or_else(|| top_level_messages.last().map(|m| m.id.clone()));

    let header = div()
        .w_full()
        .flex_none()
        .bg(theme.surface)
        .flex()
        .justify_center()
        .child(
            div()
                .w(relative(1.0))
                .max_w(px(EDITORIAL_MEASURE))
                .px(px(24.0))
                .pt(px(14.0))
                .pb(px(10.0))
                .border_b_1()
                .border_color(theme.border)
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    div()
                        .flex()
                        .items_end()
                        .justify_between()
                        .gap(px(16.0))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(2.0))
                                .min_w(px(0.0))
                                .child(theme::title(title.clone(), 24.0, theme.ink))
                                .child(theme::body(subtitle, 12.5, theme.fg_secondary)),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .flex_none()
                                .children(is_channel.then(|| {
                                    kit::secondary_button(
                                        "conv-add-member-btn",
                                        "+ Add member",
                                        theme,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            this.show_add_member = !this.show_add_member;
                                            cx.notify();
                                        },
                                    ))
                                }))
                                .child(
                                    kit::ghost_button(
                                        "conv-threads-btn",
                                        format!("Threads ({thread_count})"),
                                        theme,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, window, cx| {
                                            if let Some(tid) = latest_thread.clone() {
                                                this.right_panel = RightPanel::Thread(tid);
                                                this.focus_target = FocusTarget::ThreadComposer;
                                                window.focus(&this.focus_handle, cx);
                                                cx.notify();
                                            }
                                        },
                                    )),
                                ),
                        ),
                )
                .children((app.show_add_member && is_channel).then(|| {
                    div()
                        .p(px(8.0))
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(theme.border_subtle)
                        .bg(theme.strip)
                        .flex()
                        .items_center()
                        .flex_wrap()
                        .gap(px(6.0))
                        .child(theme::micro("Add to channel:", 9.0, theme.fg_tertiary))
                        .children(if non_members.is_empty() {
                            vec![
                                theme::numeric(
                                    "All users and bots are already members",
                                    10.5,
                                    theme.fg_tertiary,
                                )
                                .into_any_element(),
                            ]
                        } else {
                            non_members
                                .into_iter()
                                .enumerate()
                                .map(|(mi, (uid, name, is_bot))| {
                                    let lbl = if is_bot { format!("@{name}") } else { name };
                                    kit::secondary_button(("add-member-opt", mi), lbl, theme)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.add_member_to_active(&uid);
                                            cx.notify();
                                        }))
                                        .into_any_element()
                                })
                                .collect()
                        })
                })),
        );

    let (stream, composer) = conversation_stream_and_composer(
        app,
        &active_cid,
        &title,
        is_channel,
        "No messages yet. Mention a bot with @name to start work.",
        theme,
        cx,
    );

    let tasks_panel = dm_bot.map(|bot| bot_tasks_panel(app, bot, theme, cx));

    div()
        .flex_1()
        .min_h(px(0.0))
        .w_full()
        .flex()
        .flex_col()
        .child(header)
        .children(tasks_panel)
        .child(stream)
        .child(composer)
}

pub(crate) fn conversation_stream_and_composer(
    app: &KawanApp,
    active_cid: &str,
    title: &str,
    is_channel: bool,
    empty_hint: &str,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> (gpui::Stateful<Div>, Div) {
    let messages = app
        .messages_by_conv
        .get(active_cid)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let all_ids: HashSet<&str> = messages.iter().map(|m| m.id.as_str()).collect();
    let mut replies_by_parent: HashMap<&str, Vec<&Message>> = HashMap::new();
    let mut top_level_messages: Vec<&Message> = Vec::new();
    for m in messages {
        if let Some(tid) = m.thread_id.as_deref()
            && all_ids.contains(tid)
        {
            replies_by_parent.entry(tid).or_default().push(m);
        } else {
            top_level_messages.push(m);
        }
    }

    let rendered_parent_ids: HashSet<&str> =
        top_level_messages.iter().map(|m| m.id.as_str()).collect();
    let mut standalone_pending: Vec<&SessionSummary> = app
        .sessions_by_id
        .values()
        .filter(|s| {
            s.kind == "worker"
                && s.status == "pending_approval"
                && s.conversation_id.as_deref() == Some(active_cid)
                && s.thread_id
                    .as_deref()
                    .is_none_or(|tid| !rendered_parent_ids.contains(tid))
        })
        .collect();
    standalone_pending.sort_by_key(|s| s.created_at);

    let conv_errors = app
        .conv_errors
        .get(active_cid)
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let empty_text = empty_hint.to_string();
    let stream = div()
        .id("conv-message-scroll")
        .flex_1()
        .min_h(px(0.0))
        .w_full()
        .overflow_y_scroll()
        .bg(theme.surface)
        .child(
            div().w_full().flex().justify_center().child(
                div()
                    .w(relative(1.0))
                    .max_w(px(EDITORIAL_MEASURE))
                    .px(px(24.0))
                    .py(px(14.0))
                    .flex()
                    .flex_col()
                    .gap(px(10.0))
                    .children(conv_errors.iter().map(|err| {
                        div()
                            .relative()
                            .overflow_hidden()
                            .p(px(10.0))
                            .rounded(px(2.0))
                            .border_1()
                            .border_color(theme::with_alpha(theme::CATEGORY_VALS, 0.45))
                            .bg(theme.surface)
                            .child(kit::left_edge(theme::hex(theme::CATEGORY_VALS)))
                            .child(theme::numeric(
                                err.message.clone(),
                                11.0,
                                theme::hex(theme::CATEGORY_VALS),
                            ))
                    }))
                    .children(
                        if top_level_messages.is_empty() && standalone_pending.is_empty() {
                            vec![
                                div()
                                    .py(px(24.0))
                                    .child(theme::body(empty_text, 13.0, theme.fg_tertiary))
                                    .into_any_element(),
                            ]
                        } else {
                            top_level_messages
                                .iter()
                                .enumerate()
                                .map(|(mi, msg)| {
                                    let replies = replies_by_parent
                                        .get(msg.id.as_str())
                                        .map(Vec::as_slice)
                                        .unwrap_or(&[]);
                                    message_row(app, msg, replies, is_channel, mi, theme, cx)
                                        .into_any_element()
                                })
                                .collect()
                        },
                    )
                    .children(standalone_pending.into_iter().enumerate().map(|(pi, ps)| {
                        pending_session_card(app, ps, "stream-pend", pi, theme, cx)
                    })),
            ),
        );

    let placeholder = if let Some(issue) = app.issue_by_conv(active_cid) {
        format!("Message #{}… (@bot to implement or review)", issue.number)
    } else {
        format!("Message {title}...")
    };
    let focused = app.focus_target == FocusTarget::Composer;
    let composer = div()
        .flex_none()
        .w_full()
        .border_t_1()
        .border_color(theme.border_subtle)
        .bg(theme.surface)
        .flex()
        .justify_center()
        .child(
            div()
                .w(relative(1.0))
                .max_w(px(EDITORIAL_MEASURE))
                .px(px(24.0))
                .py(px(12.0))
                .child(
                    div()
                        .id("conv-composer-box")
                        .w_full()
                        .min_h(px(44.0))
                        .px(px(12.0))
                        .py(px(6.0))
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(if focused { theme.vivid } else { theme.border })
                        .bg(theme.surface)
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(10.0))
                        .cursor_text()
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.focus_target = FocusTarget::Composer;
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }))
                        .child(div().flex_1().min_w(px(0.0)).child(
                            if app.composer_text.is_empty() {
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(2.0))
                                    .child(div().w(px(1.5)).h(px(14.0)).bg(if focused {
                                        theme.ink
                                    } else {
                                        gpui::transparent_black()
                                    }))
                                    .child(theme::numeric(
                                        placeholder,
                                        12.0,
                                        theme::with_alpha(theme.palette.dark, 0.45),
                                    ))
                            } else {
                                div()
                                    .flex()
                                    .items_center()
                                    .flex_wrap()
                                    .child(
                                        div()
                                            .font_family(theme::MONO)
                                            .text_size(px(12.0))
                                            .line_height(px(17.0))
                                            .text_color(theme.ink)
                                            .child(app.composer_text.clone()),
                                    )
                                    .child(div().ml(px(1.0)).w(px(1.5)).h(px(14.0)).bg(
                                        if focused {
                                            theme.ink
                                        } else {
                                            gpui::transparent_black()
                                        },
                                    ))
                            },
                        ))
                        .child(
                            kit::small_primary_button("conv-send-btn", "Send", theme).on_click(
                                cx.listener(|this, _, _, cx| {
                                    this.send_composer_message();
                                    cx.notify();
                                }),
                            ),
                        ),
                ),
        );

    (stream, composer)
}

pub(crate) fn pending_session_card(
    app: &KawanApp,
    sess: &SessionSummary,
    id_prefix: &'static str,
    idx: usize,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let title = session_display_title(sess);
    let task_body = sess
        .task
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| truncate_chars(s, 200))
        .unwrap_or_else(|| "Confirm to clone repository and start worker session.".to_string());
    let bot_name = format!("@{}", app.actor_name(&sess.bot_id));
    let sid_start = sess.id.clone();
    let sid_dismiss = sess.id.clone();

    div()
        .mt(px(4.0))
        .w_full()
        .relative()
        .overflow_hidden()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .child(kit::left_edge(theme::hex(theme::CATEGORY_ACADEMIC)))
        .child(
            div()
                .min_h(px(32.0))
                .px(px(14.0))
                .py(px(5.0))
                .bg(theme.strip)
                .border_b_1()
                .border_color(theme.border_subtle)
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(theme::micro("TASK PROPOSAL", 8.5, theme.fg_tertiary))
                        .child(theme::label(title, 12.5, theme.ink)),
                )
                .child(kit::status_tag(
                    "AWAITING CONFIRMATION",
                    theme::CATEGORY_ACADEMIC,
                    theme,
                )),
        )
        .child(div().px(px(14.0)).py(px(9.0)).child(theme::body(
            task_body,
            12.5,
            theme.fg_secondary,
        )))
        .child(
            div()
                .min_h(px(34.0))
                .px(px(14.0))
                .py(px(5.0))
                .bg(theme.strip)
                .border_t_1()
                .border_color(theme.border_subtle)
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(theme::micro(bot_name, 8.5, theme.fg_tertiary))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            kit::ghost_button((id_prefix, idx * 2 + 1), "Dismiss", theme).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.dismiss_session(&sid_dismiss);
                                    cx.notify();
                                }),
                            ),
                        )
                        .child(
                            kit::small_primary_button((id_prefix, idx * 2), "Start", theme)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.confirm_session(&sid_start);
                                    cx.notify();
                                })),
                        ),
                ),
        )
}

fn bot_tasks_panel(
    app: &KawanApp,
    bot: &crate::protocol::BotSummary,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let workers = app.worker_sessions_for_bot(&bot.id);
    let active_count = workers
        .iter()
        .filter(|s| {
            matches!(
                s.status.as_str(),
                "running" | "pending_approval" | "review_requested" | "failed"
            )
        })
        .count();

    let rows: Vec<AnyElement> = if workers.is_empty() {
        vec![
            div()
                .px(px(14.0))
                .py(px(10.0))
                .child(theme::body(
                    "No tasks yet — assign work here or in any channel.",
                    12.5,
                    theme.fg_tertiary,
                ))
                .into_any_element(),
        ]
    } else {
        workers
            .iter()
            .take(6)
            .enumerate()
            .map(|(ti, sess)| {
                let sid = sess.id.clone();
                let sid_confirm = sess.id.clone();
                let sid_dismiss = sess.id.clone();
                let sid_stop = sess.id.clone();
                let sid_promote = sess.id.clone();
                let linked_issue = app
                    .issue_for_session(&sess.id)
                    .map(|i| (i.id.clone(), i.number));
                let title = session_display_title(sess);
                let origin = sess
                    .conversation_id
                    .as_deref()
                    .map(|cid| app.conversation_label(cid))
                    .unwrap_or_else(|| "chat".to_string());
                let land = app
                    .land_for_session(&sess.id)
                    .filter(|l| l.status == "requested" || l.status == "failed");
                let status_color = status_color_hex(&sess.status);
                let is_pending = sess.status == "pending_approval";
                let is_running = sess.status == "running";

                div()
                    .px(px(14.0))
                    .py(px(8.0))
                    .border_t_1()
                    .border_color(theme.border_subtle)
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(10.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(kit::swatch(theme::hex(status_color), px(6.0)))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w(px(0.0))
                                    .font_family(theme::SANS)
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_size(px(12.5))
                                    .text_color(theme.ink)
                                    .child(title),
                            )
                            .child(theme::numeric(origin, 10.0, theme.fg_tertiary))
                            .child(kit::status_tag(
                                short_status_label(&sess.status).to_uppercase(),
                                status_color,
                                theme,
                            )),
                    )
                    .child(
                        div()
                            .flex_none()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .children(match linked_issue {
                                Some((iid, num)) => Some(
                                    kit::ghost_button(
                                        ("dm-task-issue", ti),
                                        format!("#{num}"),
                                        theme,
                                    )
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_issue(&iid);
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                                    .into_any_element(),
                                ),
                                None if !is_pending => Some(
                                    kit::ghost_button(("dm-task-promote", ti), "Promote", theme)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.promote_session_to_issue(&sid_promote);
                                            cx.notify();
                                        }))
                                        .into_any_element(),
                                ),
                                None => None,
                            })
                            .child(
                                kit::ghost_button(("dm-task-inspect", ti), "Inspect", theme)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.open_session_inspector(&sid);
                                        cx.notify();
                                    })),
                            )
                            .children(is_running.then(|| {
                                kit::ghost_button(("dm-task-stop", ti), "Stop", theme).on_click(
                                    cx.listener(move |this, _, _, cx| {
                                        this.stop_session(&sid_stop);
                                        cx.notify();
                                    }),
                                )
                            }))
                            .children(is_pending.then(|| {
                                kit::ghost_button(("dm-task-dismiss", ti), "Dismiss", theme)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.dismiss_session(&sid_dismiss);
                                        cx.notify();
                                    }))
                            }))
                            .children(is_pending.then(|| {
                                kit::small_primary_button(("dm-task-start", ti), "Start", theme)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.confirm_session(&sid_confirm);
                                        cx.notify();
                                    }))
                            }))
                            .children(land.map(|l| {
                                let lid = l.id.clone();
                                kit::small_primary_button(
                                    ("dm-task-approve", ti),
                                    "Approve Land",
                                    theme,
                                )
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.approve_land(&lid);
                                        cx.notify();
                                    },
                                ))
                            })),
                    )
                    .into_any_element()
            })
            .collect()
    };

    div().flex_none().w_full().flex().justify_center().child(
        div()
            .w(relative(1.0))
            .max_w(px(EDITORIAL_MEASURE))
            .px(px(24.0))
            .pt(px(12.0))
            .child(
                div()
                    .rounded(px(2.0))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.surface)
                    .overflow_hidden()
                    .child(
                        kit::strip_bar(theme)
                            .child(theme::micro(
                                format!("TASKS · @{}", bot.name),
                                9.5,
                                theme.dark,
                            ))
                            .child(theme::numeric(
                                format!("{active_count} active · {} total", workers.len()),
                                10.0,
                                theme.fg_tertiary,
                            )),
                    )
                    .children(rows),
            ),
    )
}

fn message_row(
    app: &KawanApp,
    msg: &Message,
    replies: &[&Message],
    is_channel: bool,
    mi: usize,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let is_bot = app.actor_is_bot(&msg.author_id);
    let raw_name = app.actor_name(&msg.author_id);
    let author_label = if is_bot {
        format!("@{raw_name}")
    } else {
        raw_name.clone()
    };

    let avatar = if is_bot {
        kit::bot_avatar(28.0, theme)
    } else {
        kit::human_avatar(&raw_name, 28.0, theme)
    };

    let mut content_col = div()
        .flex_1()
        .min_w(px(0.0))
        .flex()
        .flex_col()
        .gap(px(5.0))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .font_family(theme::SANS)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_size(px(13.0))
                        .line_height(px(16.0))
                        .text_color(theme.ink)
                        .child(author_label),
                )
                .child(theme::numeric(
                    format!("#{}", msg.seq),
                    10.0,
                    theme::with_alpha(theme.palette.dark, 0.50),
                )),
        )
        .child(
            div()
                .w_full()
                .min_w(px(0.0))
                .child(theme::body(msg.body.clone(), 13.5, theme.ink)),
        );

    if let Some(attachment) = render_message_attachment(app, msg, is_bot, mi, theme, cx) {
        content_col = content_col.child(attachment);
    }

    if let Some(tid) = &msg.thread_id {
        let tid_open = tid.clone();
        content_col = content_col.child(
            div()
                .id(("msg-thread-link", mi))
                .pt(px(2.0))
                .flex()
                .items_center()
                .gap(px(5.0))
                .cursor_pointer()
                .hover(|s| s.opacity(0.75))
                .child(kit::icon("kawan/thread.svg", 11.0, theme.dark))
                .child(theme::numeric("thread →", 10.5, theme.dark))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.right_panel = RightPanel::Thread(tid_open.clone());
                    this.focus_target = FocusTarget::ThreadComposer;
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                })),
        );
    }

    let decisions = app.decisions_for_message(&msg.id);
    for (di, dec) in decisions.into_iter().enumerate() {
        content_col = content_col.child(decision_chip_row(app, dec, mi * 10 + di, theme, cx));
    }

    let mut pending_for_msg: Vec<&SessionSummary> = app
        .sessions_by_id
        .values()
        .filter(|s| {
            s.kind == "worker"
                && s.status == "pending_approval"
                && s.thread_id.as_deref() == Some(msg.id.as_str())
        })
        .collect();
    pending_for_msg.sort_by_key(|s| s.created_at);

    if !replies.is_empty() {
        content_col = content_col.child(thread_tray(app, &msg.id, replies, mi, theme, cx));
    } else if is_channel && msg.thread_id.is_none() {
        let tid_open = msg.id.clone();
        content_col = content_col.child(
            div().pt(px(1.0)).flex().items_center().child(
                div()
                    .id(("msg-start-thread", mi))
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded(px(2.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .cursor_pointer()
                    .hover(|s| s.bg(theme.hover))
                    .child(kit::icon("kawan/thread.svg", 10.5, theme.fg_tertiary))
                    .child(theme::micro("Reply in thread", 8.5, theme.fg_tertiary))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.right_panel = RightPanel::Thread(tid_open.clone());
                        this.focus_target = FocusTarget::ThreadComposer;
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    })),
            ),
        );
    }

    for (pi, ps) in pending_for_msg.into_iter().enumerate() {
        content_col = content_col.child(pending_session_card(
            app,
            ps,
            "msg-pend",
            mi * 10 + pi,
            theme,
            cx,
        ));
    }

    div()
        .w_full()
        .min_w(px(0.0))
        .pt(px(6.0))
        .pb(px(4.0))
        .flex()
        .items_start()
        .gap(px(12.0))
        .child(div().pt(px(2.0)).child(avatar))
        .child(content_col)
}

fn thread_tray(
    app: &KawanApp,
    parent_msg_id: &str,
    replies: &[&Message],
    mi: usize,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let reply_count = replies.len();
    let reply_label = if reply_count == 1 {
        "1 reply".to_string()
    } else {
        format!("{reply_count} replies")
    };
    let last_reply = replies
        .last()
        .expect("thread_tray requires non-empty replies");
    let last_is_bot = app.actor_is_bot(&last_reply.author_id);
    let last_raw_name = app.actor_name(&last_reply.author_id);
    let last_author = if last_is_bot {
        format!("@{last_raw_name}")
    } else {
        last_raw_name.clone()
    };
    let last_avatar = if last_is_bot {
        kit::bot_avatar(18.0, theme)
    } else {
        kit::human_avatar(&last_raw_name, 18.0, theme)
    };

    let has_report = replies.iter().any(|r| r.artifact_id.is_some());
    let thread_running_sess = app.sessions_by_id.values().find(|s| {
        s.kind == "worker" && s.thread_id.as_deref() == Some(parent_msg_id) && s.status == "running"
    });
    let mut thread_workers: Vec<&SessionSummary> = app
        .sessions_by_id
        .values()
        .filter(|s| s.kind == "worker" && s.thread_id.as_deref() == Some(parent_msg_id))
        .collect();
    thread_workers.sort_by_key(|s| s.updated_at);
    let thread_worker_sess = thread_workers.last().copied();
    let thread_running = thread_running_sess.is_some();
    let thread_pending = app.sessions_by_id.values().any(|s| {
        s.kind == "worker"
            && s.thread_id.as_deref() == Some(parent_msg_id)
            && s.status == "pending_approval"
    });
    let mut matching_lands: Vec<&Land> = app
        .lands_by_id
        .values()
        .filter(|l| {
            l.thread_id.as_deref() == Some(parent_msg_id)
                || replies
                    .iter()
                    .any(|r| l.message_id.as_deref() == Some(r.id.as_str()))
        })
        .collect();
    matching_lands.sort_by_key(|l| l.updated_at);
    let thread_land = matching_lands.last().copied();

    let status_badge: Option<(&'static str, u32)> = if thread_running {
        Some(("WORKING", theme::CATEGORY_INDUSTRY))
    } else if thread_pending {
        Some(("PROPOSED", theme::CATEGORY_ACADEMIC))
    } else if let Some(land) = thread_land {
        match land.status.as_str() {
            "requested" => Some(("REVIEW", theme::UMBER_VIVID)),
            "queued" => Some(("QUEUED", theme::CATEGORY_ACADEMIC)),
            "rebasing" => Some(("REBASING", theme::CATEGORY_INDUSTRY)),
            "verifying" => Some(("VERIFYING", theme::CATEGORY_INDUSTRY)),
            "paused" => Some(("PAUSED", theme::CATEGORY_VALS)),
            "failed" => Some(("BLOCKED", theme::CATEGORY_VALS)),
            "landed" => Some(("LANDED", status_color_hex("landed"))),
            _ => None,
        }
    } else {
        None
    };

    let accent_color = status_badge
        .map(|(_, col)| theme::hex(col))
        .unwrap_or(theme.vivid);
    let is_open = app.right_panel == RightPanel::Thread(parent_msg_id.to_string());
    let open_tid = parent_msg_id.to_string();
    let single_line = last_reply
        .body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let left_btn = div()
        .id(("thread-tray-open", mi))
        .flex_1()
        .min_w(px(0.0))
        .cursor_pointer()
        .hover(|s| s.opacity(0.82))
        .flex()
        .flex_col()
        .gap(px(3.0))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .flex_wrap()
                        .gap(px(6.0))
                        .min_w(px(0.0))
                        .child(last_avatar)
                        .child(kit::icon("kawan/thread.svg", 11.0, theme.dark))
                        .child(theme::label(reply_label, 11.5, theme.ink))
                        .children(status_badge.map(|(lbl, col)| kit::status_tag(lbl, col, theme)))
                        .children(has_report.then(|| {
                            div()
                                .px(px(5.0))
                                .py(px(1.0))
                                .rounded(px(2.0))
                                .border_1()
                                .border_color(theme.border_subtle)
                                .bg(theme.surface)
                                .child(theme::micro("REPORT", 8.0, theme.dark))
                        })),
                )
                .child(theme::micro(
                    if is_open {
                        "VIEWING"
                    } else {
                        "VIEW THREAD →"
                    },
                    8.5,
                    if is_open { theme.vivid } else { theme.dark },
                )),
        )
        .child(theme::body(
            format!("{last_author}: {}", truncate_chars(&single_line, 86)),
            12.0,
            theme.fg_secondary,
        ))
        .on_click(cx.listener(move |this, _, window, cx| {
            this.right_panel = RightPanel::Thread(open_tid.clone());
            this.focus_target = FocusTarget::ThreadComposer;
            window.focus(&this.focus_handle, cx);
            cx.notify();
        }));

    let mut tray = div()
        .mt(px(4.0))
        .w_full()
        .relative()
        .overflow_hidden()
        .rounded(px(2.0))
        .border_1()
        .border_color(if is_open {
            theme.vivid
        } else {
            theme.border_subtle
        })
        .bg(if is_open {
            theme::with_alpha(theme.palette.vivid, 0.06)
        } else {
            theme.strip
        })
        .pl(px(12.0))
        .pr(px(10.0))
        .py(px(7.0))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(10.0))
        .child(kit::left_edge(accent_color))
        .child(left_btn);

    if let Some(run_sess) = thread_running_sess {
        let stop_sid = run_sess.id.clone();
        tray = tray.child(
            kit::ghost_button(("tray-sess-stop", mi), "Stop", theme).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.stop_session(&stop_sid);
                    cx.notify();
                },
            )),
        );
    }

    if let Some(ws) = thread_worker_sess {
        if let Some(issue) = app.issue_for_session(&ws.id) {
            let iid = issue.id.clone();
            tray = tray.child(
                kit::ghost_button(("tray-issue", mi), format!("#{}", issue.number), theme)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_issue(&iid);
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    })),
            );
        } else if ws.status != "pending_approval" {
            let sid_promote = ws.id.clone();
            tray = tray.child(
                kit::ghost_button(("tray-promote", mi), "Promote", theme).on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.promote_session_to_issue(&sid_promote);
                        cx.notify();
                    },
                )),
            );
        }
    }

    if let Some(land) = thread_land {
        if land.status == "requested" || land.status == "failed" {
            let lid = land.id.clone();
            tray = tray.child(
                kit::small_primary_button(("tray-land-approve", mi), "Approve Land", theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.approve_land(&lid);
                        cx.notify();
                    })),
            );
        } else if land.status == "paused" {
            tray = tray.child(
                kit::ghost_button(("tray-mq-open", mi), "Merge Queue", theme).on_click(
                    cx.listener(|this, _, window, cx| {
                        this.open_merge_queue();
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    }),
                ),
            );
        }
    }

    tray
}

fn decision_chip_row(
    app: &KawanApp,
    dec: &Decision,
    idx: usize,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let dest_label = if let Some(sid) = dec.destination.strip_prefix("session:") {
        format!("session:{}", short_id(sid))
    } else {
        dec.destination.clone()
    };
    let is_held_pending = dec.readiness == "hold" && dec.dispatched == 0;
    let countdown = if is_held_pending {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        dec.hold_expires_at.map(|exp| {
            let rem_ms = exp.saturating_sub(now_ms);
            let total_ms = exp.saturating_sub(dec.created_at).max(1);
            let frac = (rem_ms as f32 / total_ms as f32).clamp(0.0, 1.0);
            (rem_ms, frac)
        })
    } else {
        None
    };

    let status_text = if is_held_pending {
        match countdown {
            Some((0, _)) => format!("held · {dest_label} · sending…"),
            Some((rem_ms, _)) => {
                format!("held · {dest_label} · auto in {}s", rem_ms.div_ceil(1000))
            }
            None => format!("held · {dest_label}"),
        }
    } else {
        format!("routed → {dest_label}")
    };
    let chip_color = if dec.destination == "none" {
        theme::with_alpha(theme.palette.dark, 0.50)
    } else if is_held_pending {
        theme::hex(theme::UMBER_VIVID)
    } else {
        theme::hex(theme::CATEGORY_INDUSTRY)
    };

    let dec_id = dec.id.clone();
    let dec_id_now = dec.id.clone();
    let dec_dest_now = dec.destination.clone();
    let menu_open = app.redirect_menu_decision_id.as_deref() == Some(dec_id.as_str());

    let mut wrapper = div().flex().flex_col().gap(px(5.0)).child(
        div()
            .flex()
            .items_center()
            .flex_wrap()
            .gap(px(8.0))
            .pt(px(2.0))
            .child(
                div()
                    .relative()
                    .overflow_hidden()
                    .h(px(20.0))
                    .px(px(7.0))
                    .rounded(px(2.0))
                    .border_1()
                    .border_color(theme.border_subtle)
                    .bg(theme.strip)
                    .flex()
                    .items_center()
                    .gap(px(5.0))
                    .child(kit::swatch(chip_color, px(5.0)))
                    .child(theme::numeric(status_text, 10.0, theme.fg_secondary))
                    .children(dec.redirected_from.as_ref().map(|from| {
                        theme::numeric(format!("(was {from})"), 9.5, theme.fg_tertiary)
                    }))
                    .children(countdown.filter(|(_, frac)| *frac > 0.0).map(|(_, frac)| {
                        div()
                            .absolute()
                            .left_0()
                            .bottom_0()
                            .h(px(2.0))
                            .w(relative(frac))
                            .bg(theme::hex(theme::UMBER_VIVID))
                    })),
            )
            .children((is_held_pending && dec.destination != "none").then(|| {
                div()
                    .id(("msg-send-now", idx))
                    .cursor_pointer()
                    .px(px(6.0))
                    .h(px(20.0))
                    .rounded(px(2.0))
                    .border_1()
                    .border_color(theme::with_alpha(theme.palette.dark, 0.22))
                    .bg(theme.surface)
                    .flex()
                    .items_center()
                    .hover(|s| s.bg(theme.hover))
                    .child(theme::micro("Send now", 8.5, theme.dark))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.redirect_decision(&dec_id_now, &dec_dest_now);
                        cx.notify();
                    }))
            }))
            .child(
                div()
                    .id(("msg-redirect-toggle", idx))
                    .cursor_pointer()
                    .px(px(5.0))
                    .py(px(2.0))
                    .rounded(px(2.0))
                    .hover(|s| s.bg(theme.hover))
                    .child(theme::micro(
                        if menu_open { "Cancel" } else { "Redirect" },
                        8.5,
                        theme.fg_tertiary,
                    ))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if this.redirect_menu_decision_id.as_deref() == Some(dec_id.as_str()) {
                            this.redirect_menu_decision_id = None;
                        } else {
                            this.redirect_menu_decision_id = Some(dec_id.clone());
                        }
                        cx.notify();
                    })),
            ),
    );

    if menu_open {
        let mut targets: Vec<(String, String)> = vec![
            ("none".to_string(), "none".to_string()),
            ("orchestrator".to_string(), "orchestrator".to_string()),
        ];
        for sess in app.worker_sessions_for_active() {
            targets.push((
                format!("→ {}", short_id(&sess.id)),
                format!("session:{}", sess.id),
            ));
        }

        let dec_id_menu = dec.id.clone();
        wrapper = wrapper.child(
            div()
                .p(px(6.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.strip)
                .flex()
                .items_center()
                .flex_wrap()
                .gap(px(6.0))
                .child(theme::micro("Route to:", 9.0, theme.fg_tertiary))
                .children(targets.into_iter().enumerate().map(|(ti, (lbl, dest))| {
                    let active = dec.destination == dest;
                    let did = dec_id_menu.clone();
                    div()
                        .id(("redirect-opt", idx * 20 + ti))
                        .h(px(22.0))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(if active {
                            theme.ink
                        } else {
                            theme.border_subtle
                        })
                        .bg(if active { theme.ink } else { theme.surface })
                        .cursor_pointer()
                        .child(theme::micro(
                            lbl,
                            9.0,
                            if active {
                                theme::hex(0xFFFFFF)
                            } else {
                                theme.ink
                            },
                        ))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.redirect_decision(&did, &dest);
                            cx.notify();
                        }))
                })),
        );
    }

    wrapper
}

fn render_message_attachment(
    app: &KawanApp,
    msg: &Message,
    is_bot: bool,
    card_idx: usize,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Option<Div> {
    if let Some(art_id) = &msg.artifact_id
        && let Some(artifact) = app.artifacts_by_id.get(art_id)
    {
        let sess = artifact
            .session_id
            .as_deref()
            .and_then(|sid| app.sessions_by_id.get(sid));
        let land = artifact
            .session_id
            .as_deref()
            .and_then(|sid| app.land_for_session(sid));
        return Some(artifact_card(
            app,
            artifact.id.clone(),
            artifact.filename.clone(),
            artifact.byte_size,
            sess,
            land,
            card_idx,
            theme,
            cx,
        ));
    }

    if is_bot {
        let matching_land = app
            .lands_by_id
            .values()
            .find(|l| l.message_id.as_deref() == Some(msg.id.as_str()));
        if let Some(land) = matching_land {
            let sess = app.sessions_by_id.get(&land.session_id);
            return Some(land_card(land, sess, card_idx, theme, cx));
        }
    }

    None
}

#[allow(clippy::too_many_arguments)]
fn artifact_card(
    app: &KawanApp,
    artifact_id: String,
    filename: Option<String>,
    byte_size: u64,
    sess: Option<&SessionSummary>,
    land: Option<&Land>,
    mi: usize,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let status = land
        .map(|l| l.status.as_str())
        .or_else(|| sess.map(|s| s.status.as_str()))
        .unwrap_or("artifact");
    let status_color = status_color_hex(status);
    let expanded = app.expanded_artifacts.contains(&artifact_id);
    let loaded = app.loaded_artifacts.get(&artifact_id);
    let is_report = filename.as_deref().is_some_and(|name| {
        let lower = name.to_ascii_lowercase();
        lower.ends_with(".md") || lower.contains("report")
    });
    let header_label = sess
        .map(|s| truncate_chars(&session_display_title(s), 28))
        .unwrap_or_else(|| {
            if is_report {
                "Report".to_string()
            } else {
                "Artifact".to_string()
            }
        });

    let mut card = div()
        .mt(px(4.0))
        .w_full()
        .relative()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .overflow_hidden()
        .child(kit::left_edge(theme::hex(status_color)))
        .child(
            div()
                .min_h(px(34.0))
                .px(px(14.0))
                .py(px(6.0))
                .bg(theme.strip)
                .border_b_1()
                .border_color(theme.border_subtle)
                .flex()
                .items_center()
                .justify_between()
                .flex_wrap()
                .gap(px(8.0))
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex()
                        .items_center()
                        .flex_wrap()
                        .gap(px(8.0))
                        .child(theme::label(header_label, 12.0, theme.dark))
                        .child(kit::status_tag(
                            short_status_label(status).to_uppercase(),
                            status_color,
                            theme,
                        ))
                        .children(land.filter(|l| l.touches_kawan).map(|_| {
                            kit::status_tag("MODIFIES .kawan/", theme::UMBER_VIVID, theme)
                        })),
                )
                .child(theme::numeric(
                    format!(
                        "{} · {} B",
                        filename.unwrap_or_else(|| "artifact".to_string()),
                        byte_size
                    ),
                    10.0,
                    theme.fg_tertiary,
                )),
        );

    if expanded {
        let preview: AnyElement = if let Some(art) = loaded {
            if let Some(image) = &art.image {
                img(image.clone()).max_h(px(240.0)).into_any_element()
            } else if let Some(txt) = &art.text_preview {
                let all_lines: Vec<&str> = txt.lines().collect();
                let shown = all_lines.len().min(80);
                let remaining = all_lines.len().saturating_sub(shown);
                div()
                    .w_full()
                    .min_w(px(0.0))
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .children(all_lines.into_iter().take(80).map(|line| {
                        div()
                            .w_full()
                            .min_w(px(0.0))
                            .font_family(theme::MONO)
                            .text_size(px(11.0))
                            .line_height(px(15.5))
                            .text_color(theme.ink)
                            .child(line.to_string())
                    }))
                    .children((remaining > 0).then(|| {
                        theme::numeric(
                            format!("… ({remaining} more lines)"),
                            10.0,
                            theme.fg_tertiary,
                        )
                    }))
                    .into_any_element()
            } else {
                theme::numeric("Binary artifact loaded", 11.0, theme.fg_tertiary).into_any_element()
            }
        } else {
            theme::numeric("Loading artifact...", 11.0, theme.fg_tertiary).into_any_element()
        };

        card = card.child(div().p(px(12.0)).bg(theme.surface).child(preview));
    }

    let art_toggle = artifact_id.clone();
    let sess_open = sess.map(|s| s.id.clone());
    let toggle_label = if expanded {
        if is_report {
            "Hide report"
        } else {
            "Hide artifact"
        }
    } else if is_report {
        "View report"
    } else {
        "View artifact"
    };

    card.child(
        div()
            .min_h(px(36.0))
            .px(px(14.0))
            .py(px(6.0))
            .bg(theme.strip)
            .border_t_1()
            .border_color(theme.border_subtle)
            .flex()
            .items_center()
            .justify_between()
            .flex_wrap()
            .gap(px(8.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        kit::ghost_button(("art-toggle", mi), toggle_label, theme).on_click(
                            cx.listener(move |this, _, _, cx| {
                                this.toggle_artifact_view(&art_toggle);
                                cx.notify();
                            }),
                        ),
                    )
                    .children(sess_open.map(|sid| {
                        kit::ghost_button(("art-sess", mi), "Session", theme).on_click(cx.listener(
                            move |this, _, _, cx| {
                                this.open_session_inspector(&sid);
                                cx.notify();
                            },
                        ))
                    })),
            )
            .children(land.map(|l| {
                let lid = l.id.clone();
                if l.status == "requested" || l.status == "failed" {
                    kit::small_primary_button(("art-approve", mi), "Approve Land", theme)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.approve_land(&lid);
                            cx.notify();
                        }))
                        .into_any_element()
                } else if l.status == "paused" {
                    kit::ghost_button(("art-mq-open", mi), "Merge Queue", theme)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_merge_queue();
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }))
                        .into_any_element()
                } else {
                    kit::status_tag(l.status.to_uppercase(), status_color_hex(&l.status), theme)
                        .into_any_element()
                }
            })),
    )
}

fn land_card(
    land: &Land,
    sess: Option<&SessionSummary>,
    mi: usize,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let status_color = status_color_hex(&land.status);
    let lid = land.id.clone();
    let sid = land.session_id.clone();
    let title = sess
        .map(session_display_title)
        .unwrap_or_else(|| "Land request".to_string());

    let mut card = div()
        .mt(px(4.0))
        .w_full()
        .relative()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .overflow_hidden()
        .child(kit::left_edge(theme::hex(status_color)))
        .child(
            div()
                .min_h(px(34.0))
                .px(px(14.0))
                .py(px(6.0))
                .bg(theme.strip)
                .border_b_1()
                .border_color(theme.border_subtle)
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .child(theme::label(title, 12.0, theme.dark))
                        .child(kit::status_tag(
                            land.status.to_uppercase(),
                            status_color,
                            theme,
                        ))
                        .children(land.touches_kawan.then(|| {
                            kit::status_tag("MODIFIES .kawan/", theme::UMBER_VIVID, theme)
                        })),
                )
                .children(land.landed_sha.as_ref().map(|sha| {
                    theme::numeric(
                        sha.chars().take(12).collect::<String>(),
                        10.0,
                        theme.fg_tertiary,
                    )
                })),
        );

    if let Some(err) = &land.error {
        card = card.child(div().p(px(12.0)).child(theme::numeric(
            err.clone(),
            11.0,
            theme::hex(theme::CATEGORY_VALS),
        )));
    }

    card.child(
        div()
            .min_h(px(36.0))
            .px(px(14.0))
            .py(px(6.0))
            .bg(theme.strip)
            .border_t_1()
            .border_color(theme.border_subtle)
            .flex()
            .items_center()
            .justify_between()
            .child(
                kit::ghost_button(("land-sess", mi), "Session", theme).on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.open_session_inspector(&sid);
                        cx.notify();
                    },
                )),
            )
            .child(if land.status == "requested" || land.status == "failed" {
                kit::small_primary_button(("land-approve", mi), "Approve Land", theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.approve_land(&lid);
                        cx.notify();
                    }))
                    .into_any_element()
            } else if land.status == "paused" {
                kit::ghost_button(("land-mq-open", mi), "Merge Queue", theme)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_merge_queue();
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    }))
                    .into_any_element()
            } else {
                kit::status_tag(land.status.to_uppercase(), status_color, theme).into_any_element()
            }),
    )
}

pub(crate) fn session_strip(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let workers = app.all_worker_sessions();
    let (mq_pill_color, mq_pill_label) = match &app.merge_queue {
        Some(q) if q.settings.paused || q.paused_land.is_some() => {
            (theme::CATEGORY_VALS, "MQ · paused".to_string())
        }
        Some(q) if !q.queued.is_empty() => {
            let head_st = q
                .head
                .as_ref()
                .map(|h| h.status.as_str())
                .unwrap_or("queued");
            let col = if matches!(head_st, "verifying" | "rebasing") {
                theme::CATEGORY_INDUSTRY
            } else {
                theme::CATEGORY_ACADEMIC
            };
            let lbl = if q.queued.len() == 1 && matches!(head_st, "verifying" | "rebasing") {
                format!("MQ · {head_st}")
            } else {
                format!("MQ · {} queued", q.queued.len())
            };
            (col, lbl)
        }
        _ => (0x284D32, "MQ · idle".to_string()),
    };
    let mq_pill_active = matches!(app.screen, Screen::Workspace(WorkspacePage::MergeQueue));
    div()
        .h(px(36.0))
        .w_full()
        .flex_none()
        .px(px(16.0))
        .bg(theme.strip)
        .border_t_1()
        .border_color(theme.border_subtle)
        .flex()
        .items_center()
        .justify_between()
        .gap(px(10.0))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .children(if workers.is_empty() {
                    vec![
                        theme::micro("NO WORKER SESSIONS", 8.5, theme.fg_tertiary)
                            .into_any_element(),
                    ]
                } else {
                    workers
                        .into_iter()
                        .enumerate()
                        .map(|(wi, sess)| {
                            let sid = sess.id.clone();
                            let active = app.right_panel == RightPanel::Session(sid.clone());
                            let color = status_color_hex(&sess.status);
                            div()
                                .id(("strip-sess", wi))
                                .h(px(24.0))
                                .px(px(7.0))
                                .rounded(px(2.0))
                                .bg(if active {
                                    theme::with_alpha(theme.palette.vivid, 0.09)
                                } else {
                                    gpui::transparent_black()
                                })
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .cursor_pointer()
                                .hover(|s| s.bg(theme.hover))
                                .child(kit::swatch(theme::hex(color), px(5.0)))
                                .child(theme::numeric(
                                    format!(
                                        "{} · {}",
                                        truncate_chars(&session_display_title(sess), 26),
                                        short_status_label(&sess.status)
                                    ),
                                    10.5,
                                    if active {
                                        theme.ink
                                    } else {
                                        theme.fg_secondary
                                    },
                                ))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if this.right_panel == RightPanel::Session(sid.clone()) {
                                        this.right_panel = RightPanel::None;
                                    } else {
                                        this.open_session_inspector(&sid);
                                    }
                                    cx.notify();
                                }))
                                .into_any_element()
                        })
                        .collect()
                }),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .id("strip-merge-queue")
                        .h(px(24.0))
                        .px(px(8.0))
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(if mq_pill_active {
                            theme.ink
                        } else {
                            theme.border_subtle
                        })
                        .bg(if mq_pill_active {
                            theme::with_alpha(theme.palette.vivid, 0.09)
                        } else {
                            theme.surface
                        })
                        .flex()
                        .items_center()
                        .gap(px(5.0))
                        .cursor_pointer()
                        .hover(|s| s.bg(theme.hover))
                        .child(kit::swatch(theme::hex(mq_pill_color), px(5.0)))
                        .child(theme::micro(mq_pill_label, 8.5, theme.dark))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_merge_queue();
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        })),
                )
                .children((!app.setup.ready).then(|| {
                    kit::ghost_button("strip-checklist", "Checklist", theme).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.screen = crate::state::Screen::Checklist;
                            cx.notify();
                        },
                    ))
                }))
                .child(theme::micro(
                    format!("{} BOTS", app.bots.len()),
                    8.5,
                    theme.fg_tertiary,
                )),
        )
}

pub(crate) fn right_drawer(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let title = match &app.right_panel {
        RightPanel::Thread(tid) => {
            let reply_count = app
                .active_messages()
                .iter()
                .filter(|m| m.thread_id.as_deref() == Some(tid.as_str()))
                .count();
            if reply_count == 0 {
                "THREAD".to_string()
            } else if reply_count == 1 {
                "THREAD · 1 REPLY".to_string()
            } else {
                format!("THREAD · {reply_count} REPLIES")
            }
        }
        RightPanel::Session(sid) => {
            let sess_title = app
                .sessions_by_id
                .get(sid)
                .map(|s| truncate_chars(&session_display_title(s), 30))
                .unwrap_or_else(|| "TASK".to_string());
            format!("TASK · {sess_title}")
        }
        RightPanel::Artifact(aid) => {
            let fname = app
                .artifacts_by_id
                .get(aid)
                .and_then(|a| a.filename.clone())
                .unwrap_or_else(|| short_id(aid));
            format!("ARTIFACT · {fname}")
        }
        RightPanel::None => String::new(),
    };

    let body: AnyElement = match &app.right_panel {
        RightPanel::Thread(tid) => thread_drawer_body(app, tid, theme, cx).into_any_element(),
        RightPanel::Session(sid) => session_drawer_body(app, sid, theme, cx).into_any_element(),
        RightPanel::Artifact(aid) => artifact_drawer_body(app, aid, theme).into_any_element(),
        RightPanel::None => div().into_any_element(),
    };

    div()
        .w(px(420.0))
        .h_full()
        .flex_none()
        .border_l_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .flex()
        .flex_col()
        .child(
            kit::strip_bar(theme)
                .child(theme::micro(title, 9.5, theme.dark))
                .child(
                    kit::icon_button("drawer-close", "ui/close.svg", theme).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.right_panel = RightPanel::None;
                            this.focus_target = FocusTarget::Composer;
                            cx.notify();
                        },
                    )),
                ),
        )
        .child(body)
}

fn thread_drawer_body(
    app: &KawanApp,
    thread_id: &str,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let thread_msgs: Vec<&Message> = app
        .active_messages()
        .iter()
        .filter(|m| m.id == thread_id || m.thread_id.as_deref() == Some(thread_id))
        .collect();
    let mut thread_pending: Vec<&SessionSummary> = app
        .sessions_by_id
        .values()
        .filter(|s| {
            s.kind == "worker"
                && s.status == "pending_approval"
                && s.thread_id.as_deref() == Some(thread_id)
        })
        .collect();
    thread_pending.sort_by_key(|s| s.created_at);
    let thread_running = app.sessions_by_id.values().find(|s| {
        s.kind == "worker" && s.status == "running" && s.thread_id.as_deref() == Some(thread_id)
    });
    let focused = app.focus_target == FocusTarget::ThreadComposer;

    div()
        .flex_1()
        .min_h(px(0.0))
        .flex()
        .flex_col()
        .child(
            div()
                .id("drawer-thread-scroll")
                .flex_1()
                .min_h(px(0.0))
                .overflow_y_scroll()
                .p(px(16.0))
                .flex()
                .flex_col()
                .gap(px(12.0))
                .children(thread_msgs.into_iter().enumerate().map(|(ti, m)| {
                    let is_root = m.id == thread_id;
                    let is_bot = app.actor_is_bot(&m.author_id);
                    let raw_name = app.actor_name(&m.author_id);
                    let author_label = if is_bot {
                        format!("@{raw_name}")
                    } else {
                        raw_name.clone()
                    };
                    let avatar = if is_bot {
                        kit::bot_avatar(22.0, theme)
                    } else {
                        kit::human_avatar(&raw_name, 22.0, theme)
                    };
                    let card_idx = 100_000 + ti;

                    let mut msg_col = div()
                        .pb(px(10.0))
                        .border_b_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(7.0))
                                        .child(avatar)
                                        .child(theme::label(author_label, 12.0, theme.ink))
                                        .child(theme::numeric(
                                            format!("#{}", m.seq),
                                            9.5,
                                            theme::with_alpha(theme.palette.dark, 0.50),
                                        )),
                                )
                                .children(is_root.then(|| {
                                    div()
                                        .px(px(5.0))
                                        .py(px(1.0))
                                        .rounded(px(2.0))
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .bg(theme.strip)
                                        .child(theme::micro("ROOT", 8.0, theme.fg_tertiary))
                                })),
                        )
                        .child(div().w_full().min_w(px(0.0)).child(theme::body(
                            m.body.clone(),
                            12.5,
                            theme.ink,
                        )));

                    if let Some(attachment) =
                        render_message_attachment(app, m, is_bot, card_idx, theme, cx)
                    {
                        msg_col = msg_col.child(attachment);
                    }

                    if !is_root {
                        let decisions = app.decisions_for_message(&m.id);
                        for (di, dec) in decisions.into_iter().enumerate() {
                            msg_col = msg_col.child(decision_chip_row(
                                app,
                                dec,
                                100_000 + ti * 10 + di,
                                theme,
                                cx,
                            ));
                        }
                    }

                    msg_col
                }))
                .children(
                    thread_pending.into_iter().enumerate().map(|(pi, ps)| {
                        pending_session_card(app, ps, "drawer-pend", pi, theme, cx)
                    }),
                )
                .children(thread_running.map(|rs| {
                    let stop_sid = rs.id.clone();
                    div()
                        .p(px(10.0))
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(theme.border_subtle)
                        .bg(theme.strip)
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .child(kit::swatch(theme::hex(theme::CATEGORY_INDUSTRY), px(6.0)))
                                .child(theme::label(session_display_title(rs), 12.0, theme.ink)),
                        )
                        .child(
                            kit::ghost_button("drawer-thread-stop", "Stop", theme).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.stop_session(&stop_sid);
                                    cx.notify();
                                }),
                            ),
                        )
                })),
        )
        .child(
            div()
                .p(px(12.0))
                .border_t_1()
                .border_color(theme.border_subtle)
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div().flex_1().child(
                        kit::text_input_box(
                            "drawer-thread-input",
                            &app.thread_composer_text,
                            "Reply in thread...",
                            focused,
                            false,
                            theme,
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.focus_target = FocusTarget::ThreadComposer;
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        })),
                    ),
                )
                .child(
                    kit::small_primary_button("drawer-thread-send", "Reply", theme).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.send_thread_reply();
                            cx.notify();
                        }),
                    ),
                ),
        )
}

fn session_drawer_body(
    app: &KawanApp,
    session_id: &str,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> AnyElement {
    let Some(sess) = app.sessions_by_id.get(session_id) else {
        return div()
            .p(px(16.0))
            .child(theme::body("Session not found.", 13.0, theme.fg_tertiary))
            .into_any_element();
    };

    let artifacts: Vec<&crate::protocol::Artifact> = app
        .artifacts_by_id
        .values()
        .filter(|a| a.session_id.as_deref() == Some(session_id))
        .collect();
    let land = app.land_for_session(session_id);
    let entries_count = app
        .session_entries
        .get(session_id)
        .map(Vec::len)
        .unwrap_or(0);
    let diff = app.session_diffs.get(session_id);
    let changes_label = match diff {
        Some(d) if d.available => format!("Changes ({})", d.files_changed),
        _ => "Changes".to_string(),
    };
    let sid_for_changes = session_id.to_string();

    let tab_bar = div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .pb(px(4.0))
        .border_b_1()
        .border_color(theme.border_subtle)
        .child(
            drawer_tab_button(
                "sess-tab-overview",
                "Overview",
                app.session_drawer_tab == SessionDrawerTab::Overview,
                theme,
            )
            .on_click(cx.listener(|this, _, _, cx| {
                this.session_drawer_tab = SessionDrawerTab::Overview;
                cx.notify();
            })),
        )
        .child(
            drawer_tab_button(
                "sess-tab-changes",
                changes_label,
                app.session_drawer_tab == SessionDrawerTab::Changes,
                theme,
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.session_drawer_tab = SessionDrawerTab::Changes;
                if !this.session_diffs.contains_key(&sid_for_changes)
                    && !this.session_diff_loading.contains(&sid_for_changes)
                {
                    this.fetch_session_diff(&sid_for_changes);
                }
                cx.notify();
            })),
        );

    let sid_confirm = session_id.to_string();
    let sid_dismiss = session_id.to_string();
    let sid_stop = session_id.to_string();
    let sid_promote = session_id.to_string();
    let linked_issue = app
        .issue_for_session(session_id)
        .map(|i| (i.id.clone(), i.number));
    let mut container = div()
        .id("drawer-session-scroll")
        .flex_1()
        .min_h(px(0.0))
        .overflow_y_scroll()
        .p(px(16.0))
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(theme::title(session_display_title(sess), 17.0, theme.ink))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(kit::status_tag(
                    sess.status.to_uppercase(),
                    status_color_hex(&sess.status),
                    theme,
                ))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .children(
                            (sess.kind == "worker")
                                .then(|| {
                                    if let Some((iid, num)) = linked_issue.clone() {
                                        Some(
                                            kit::ghost_button(
                                                "drawer-sess-issue",
                                                format!("Issue #{num}"),
                                                theme,
                                            )
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.open_issue(&iid);
                                                window.focus(&this.focus_handle, cx);
                                                cx.notify();
                                            }))
                                            .into_any_element(),
                                        )
                                    } else if sess.status != "pending_approval" {
                                        let sid_p = sid_promote.clone();
                                        Some(
                                            kit::ghost_button(
                                                "drawer-sess-promote",
                                                "Promote to Issue",
                                                theme,
                                            )
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.promote_session_to_issue(&sid_p);
                                                cx.notify();
                                            }))
                                            .into_any_element(),
                                        )
                                    } else {
                                        None
                                    }
                                })
                                .flatten(),
                        )
                        .children((sess.status == "running").then(|| {
                            kit::ghost_button("drawer-sess-stop", "Stop", theme).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.stop_session(&sid_stop);
                                    cx.notify();
                                }),
                            )
                        }))
                        .children((sess.status == "pending_approval").then(|| {
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .child(
                                    kit::ghost_button("drawer-sess-dismiss", "Dismiss", theme)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.dismiss_session(&sid_dismiss);
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    kit::small_primary_button("drawer-sess-start", "Start", theme)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.confirm_session(&sid_confirm);
                                            cx.notify();
                                        })),
                                )
                        })),
                ),
        )
        .child(tab_bar);

    if app.session_drawer_tab == SessionDrawerTab::Changes {
        container = container.child(session_diff_tab(app, session_id, theme, cx));
        return container.into_any_element();
    }

    container
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(3.0))
                .child(theme::micro("BRANCH", 9.0, theme.fg_tertiary))
                .child(theme::numeric(
                    sess.branch.clone().unwrap_or_else(|| "none".to_string()),
                    11.5,
                    theme.ink,
                )),
        )
        .children(land.and_then(|l| l.landed_sha.as_ref()).map(|sha| {
            div()
                .flex()
                .flex_col()
                .gap(px(3.0))
                .child(theme::micro("LANDED COMMIT", 9.0, theme.fg_tertiary))
                .child(theme::numeric(
                    sha.chars().take(12).collect::<String>(),
                    11.5,
                    theme.ink,
                ))
        }))
        .children(sess.task.as_ref().map(|task| {
            div()
                .flex()
                .flex_col()
                .gap(px(3.0))
                .child(theme::micro("TASK", 9.0, theme.fg_tertiary))
                .child(theme::body(task.clone(), 12.5, theme.ink))
        }))
        .children(sess.last_report.as_ref().map(|rep| {
            div()
                .flex()
                .flex_col()
                .gap(px(3.0))
                .child(theme::micro("LAST REPORT", 9.0, theme.fg_tertiary))
                .child(theme::body(rep.clone(), 12.0, theme.fg_secondary))
        }))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(theme::micro(
                    format!("ARTIFACTS ({})", artifacts.len()),
                    9.0,
                    theme.fg_tertiary,
                ))
                .children(artifacts.into_iter().map(|a| {
                    theme::numeric(
                        format!(
                            "{} ({}, {} B)",
                            a.filename.clone().unwrap_or_else(|| short_id(&a.id)),
                            a.mime_type,
                            a.byte_size
                        ),
                        11.0,
                        theme.ink,
                    )
                })),
        )
        .children(land.map(|l| {
            let lid = l.id.clone();
            div()
                .p(px(10.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.strip)
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .child(kit::status_tag(
                                    format!("LAND · {}", l.status.to_uppercase()),
                                    status_color_hex(&l.status),
                                    theme,
                                ))
                                .children(l.touches_kawan.then(|| {
                                    kit::status_tag("MODIFIES .kawan/", theme::UMBER_VIVID, theme)
                                })),
                        )
                        .children((l.status == "requested" || l.status == "failed").then(|| {
                            kit::small_primary_button("drawer-approve-land", "Approve Land", theme)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.approve_land(&lid);
                                    cx.notify();
                                }))
                        }))
                        .children((l.status == "paused").then(|| {
                            kit::ghost_button("drawer-land-mq", "Open in Merge Queue", theme)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.open_merge_queue();
                                    window.focus(&this.focus_handle, cx);
                                    cx.notify();
                                }))
                        })),
                )
                .children((!l.checks.is_empty()).then(|| {
                    div()
                        .flex()
                        .items_center()
                        .flex_wrap()
                        .gap(px(5.0))
                        .children(l.checks.iter().map(|chk| {
                            let (fg, mark) = if chk.ok {
                                (theme::hex(0x1C592C), "✓")
                            } else {
                                (theme::hex(theme::CATEGORY_VALS), "✕")
                            };
                            theme::numeric(format!("{mark} {}", chk.name), 10.0, fg)
                        }))
                }))
        }))
        .child(theme::numeric(
            format!("Persisted pi entries: {entries_count}"),
            10.5,
            theme.fg_tertiary,
        ))
        .into_any_element()
}

fn drawer_tab_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<gpui::SharedString>,
    active: bool,
    theme: &Theme,
) -> gpui::Stateful<Div> {
    div()
        .id(id)
        .h(px(24.0))
        .px(px(9.0))
        .rounded(px(2.0))
        .border_1()
        .border_color(if active {
            theme::with_alpha(theme.palette.dark, 0.28)
        } else {
            theme.border_subtle
        })
        .bg(if active {
            theme::with_alpha(theme.palette.vivid, 0.10)
        } else {
            theme.surface
        })
        .flex()
        .items_center()
        .cursor_pointer()
        .child(theme::micro(
            label,
            8.5,
            if active {
                theme.ink
            } else {
                theme.fg_secondary
            },
        ))
}

fn session_diff_tab(
    app: &KawanApp,
    session_id: &str,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> AnyElement {
    let sid_refresh = session_id.to_string();
    let loading = app.session_diff_loading.contains(session_id);
    let Some(diff) = app.session_diffs.get(session_id) else {
        let msg = if loading {
            "Loading branch diff..."
        } else {
            "Diff not loaded yet."
        };
        return div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(theme::body(msg, 12.0, theme.fg_secondary))
            .children((!loading).then(|| {
                kit::secondary_button("diff-load-btn", "Load Changes", theme).on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.fetch_session_diff(&sid_refresh);
                        cx.notify();
                    },
                ))
            }))
            .into_any_element();
    };

    if !diff.available {
        return div()
            .p(px(10.0))
            .rounded(px(2.0))
            .border_1()
            .border_color(theme.border_subtle)
            .bg(theme.strip)
            .child(theme::body(
                diff.note
                    .clone()
                    .unwrap_or_else(|| "No git diff available for this session.".to_string()),
                12.0,
                theme.fg_secondary,
            ))
            .into_any_element();
    }

    let selected_path = app
        .selected_diff_file
        .get(session_id)
        .filter(|p| diff.files.iter().any(|f| &f.path == *p))
        .cloned()
        .or_else(|| diff.files.first().map(|f| f.path.clone()));
    let selected_file = selected_path
        .as_deref()
        .and_then(|p| diff.files.iter().find(|f| f.path == p));

    let ref_line = match (&diff.base_ref, &diff.head_ref) {
        (Some(b), Some(h)) => format!("{b} → {h}"),
        (Some(b), None) => format!("vs {b}"),
        _ => String::new(),
    };

    let mut col = div()
        .flex()
        .flex_col()
        .gap(px(10.0))
        .child(
            div()
                .p(px(10.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.strip)
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(theme::label(
                                    format!("{} files", diff.files_changed),
                                    12.0,
                                    theme.ink,
                                ))
                                .child(theme::numeric(
                                    format!("+{}", diff.insertions),
                                    11.0,
                                    theme::hex(0x284D32),
                                ))
                                .child(theme::numeric(
                                    format!("-{}", diff.deletions),
                                    11.0,
                                    theme::hex(theme::CATEGORY_VALS),
                                )),
                        )
                        .children(
                            (!ref_line.is_empty())
                                .then(|| theme::numeric(ref_line, 10.0, theme.fg_tertiary)),
                        ),
                )
                .child(
                    kit::ghost_button("diff-refresh", "Refresh", theme).on_click(cx.listener(
                        move |this, _, _, cx| {
                            this.fetch_session_diff(&sid_refresh);
                            cx.notify();
                        },
                    )),
                ),
        )
        .children(diff.truncated.then(|| {
            theme::micro(
                "DIFF TRUNCATED TO 40 FILES / 64 KB",
                8.5,
                theme::hex(theme::UMBER_VIVID),
            )
        }));

    if diff.files.is_empty() {
        return col
            .child(theme::body(
                "Working tree matches base commit.",
                12.0,
                theme.fg_secondary,
            ))
            .into_any_element();
    }

    let sid_owned = session_id.to_string();
    let file_list = div()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.surface)
        .overflow_hidden()
        .flex()
        .flex_col()
        .children(diff.files.iter().enumerate().map(|(fi, file)| {
            let is_sel = selected_path.as_deref() == Some(file.path.as_str());
            let sid_click = sid_owned.clone();
            let fpath = file.path.clone();
            let status_col = match file.status.as_str() {
                "A" => theme::hex(0x284D32),
                "D" => theme::hex(theme::CATEGORY_VALS),
                _ => theme::hex(theme::CATEGORY_ACADEMIC),
            };
            div()
                .id(("diff-file", fi))
                .px(px(10.0))
                .py(px(6.0))
                .border_b_1()
                .border_color(theme.border_subtle)
                .bg(if is_sel {
                    theme::with_alpha(theme.palette.vivid, 0.09)
                } else {
                    theme.surface
                })
                .hover(|s| s.bg(theme.hover))
                .cursor_pointer()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex_1()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(theme::micro(file.status.clone(), 8.5, status_col))
                        .child(
                            div()
                                .min_w(px(0.0))
                                .flex_1()
                                .font_family(theme::MONO)
                                .text_size(px(11.0))
                                .line_height(px(15.0))
                                .text_color(theme.ink)
                                .child(file.path.clone()),
                        ),
                )
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(5.0))
                        .child(theme::numeric(
                            format!("+{}", file.insertions),
                            10.0,
                            theme::hex(0x284D32),
                        ))
                        .child(theme::numeric(
                            format!("-{}", file.deletions),
                            10.0,
                            theme::hex(theme::CATEGORY_VALS),
                        )),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.selected_diff_file
                        .insert(sid_click.clone(), fpath.clone());
                    cx.notify();
                }))
        }));

    col = col.child(file_list);

    if let Some(file) = selected_file {
        let all_lines: Vec<&str> = file.patch.lines().collect();
        let remaining = all_lines.len().saturating_sub(240);
        let patch_box = div()
            .rounded(px(2.0))
            .border_1()
            .border_color(theme.border)
            .bg(theme.surface)
            .overflow_hidden()
            .flex()
            .flex_col()
            .child(
                div()
                    .px(px(10.0))
                    .py(px(6.0))
                    .bg(theme.strip)
                    .border_b_1()
                    .border_color(theme.border_subtle)
                    .child(
                        div()
                            .w_full()
                            .min_w(px(0.0))
                            .font_family(theme::MONO)
                            .text_size(px(11.0))
                            .line_height(px(15.0))
                            .text_color(theme.dark)
                            .child(file.path.clone()),
                    ),
            )
            .child(
                div()
                    .w_full()
                    .min_w(px(0.0))
                    .py(px(6.0))
                    .flex()
                    .flex_col()
                    .children(all_lines.into_iter().take(240).map(|line| {
                        let (bg, fg) = if line.starts_with('+') && !line.starts_with("+++") {
                            (theme::hex(0xEDF7EF), theme::hex(0x1C592C))
                        } else if line.starts_with('-') && !line.starts_with("---") {
                            (theme::hex(0xFDF0EF), theme::hex(0x9B2C27))
                        } else if line.starts_with("@@")
                            || line.starts_with("diff ")
                            || line.starts_with("index ")
                        {
                            (theme.strip, theme.fg_tertiary)
                        } else {
                            (theme.surface, theme.ink)
                        };
                        div()
                            .w_full()
                            .min_w(px(0.0))
                            .px(px(10.0))
                            .py(px(1.0))
                            .bg(bg)
                            .font_family(theme::MONO)
                            .text_size(px(10.5))
                            .line_height(px(15.0))
                            .text_color(fg)
                            .child(if line.is_empty() {
                                " ".to_string()
                            } else {
                                line.to_string()
                            })
                    }))
                    .children((remaining > 0).then(|| {
                        div().px(px(10.0)).pt(px(4.0)).child(theme::numeric(
                            format!("… ({remaining} more lines)"),
                            10.0,
                            theme.fg_tertiary,
                        ))
                    })),
            );
        col = col.child(patch_box);
    }

    col.into_any_element()
}

fn artifact_drawer_body(app: &KawanApp, artifact_id: &str, theme: &Theme) -> gpui::Stateful<Div> {
    let artifact = app.artifacts_by_id.get(artifact_id);
    let loaded = app.loaded_artifacts.get(artifact_id);
    let fname = artifact
        .and_then(|a| a.filename.clone())
        .unwrap_or_else(|| short_id(artifact_id));
    let mime = artifact
        .map(|a| a.mime_type.clone())
        .unwrap_or_else(|| "text/plain".to_string());
    let size_bytes = artifact.map_or(0, |a| a.byte_size);

    let mut content_el: AnyElement = theme::body(
        "Loading artifact contents...".to_string(),
        12.0,
        theme.fg_tertiary,
    )
    .into_any_element();

    if let Some(loaded) = loaded {
        if let Some(image) = &loaded.image {
            content_el = div()
                .w_full()
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .overflow_hidden()
                .child(img(image.clone()).w_full().max_h(px(420.0)))
                .into_any_element();
        } else if let Some(txt) = &loaded.text_preview {
            let lines: Vec<&str> = txt.lines().collect();
            let remaining = lines.len().saturating_sub(240);
            content_el = div()
                .w_full()
                .min_w(px(0.0))
                .p(px(10.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.strip)
                .flex()
                .flex_col()
                .gap(px(2.0))
                .children(lines.into_iter().take(240).map(|line| {
                    div()
                        .w_full()
                        .min_w(px(0.0))
                        .font_family(theme::MONO)
                        .text_size(px(11.0))
                        .line_height(px(15.5))
                        .text_color(theme.ink)
                        .child(if line.is_empty() {
                            " ".to_string()
                        } else {
                            line.to_string()
                        })
                }))
                .children((remaining > 0).then(|| {
                    theme::numeric(
                        format!("… ({remaining} more lines)"),
                        10.0,
                        theme.fg_tertiary,
                    )
                }))
                .into_any_element();
        } else {
            content_el =
                theme::numeric("Binary artifact", 11.0, theme.fg_tertiary).into_any_element();
        }
    }

    div()
        .id("drawer-artifact-scroll")
        .flex_1()
        .min_h(px(0.0))
        .overflow_y_scroll()
        .p(px(16.0))
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(
            div()
                .p(px(10.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.strip)
                .flex()
                .flex_col()
                .gap(px(3.0))
                .child(theme::label(fname, 13.0, theme.ink))
                .child(theme::numeric(
                    format!("{mime} · {size_bytes} B"),
                    10.5,
                    theme.fg_tertiary,
                )),
        )
        .child(content_el)
}

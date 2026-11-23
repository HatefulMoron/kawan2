//! Conversations Folio shell: 256px left rail, 780px stream (decision chips, redirect,
//! artifact/land cards, composer), 36px bottom session strip, and 380px thread/session drawer.

use std::time::{SystemTime, UNIX_EPOCH};

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, FontWeight, div, img, px, relative};

use crate::kit;
use crate::protocol::{Conversation, Decision, Land, Message, SessionSummary};
use crate::state::{FocusTarget, KawanApp, RightPanel, SettingsTab};
use crate::theme::{self, Theme};
use crate::views::{short_id, status_color_hex};

const EDITORIAL_MEASURE: f32 = 780.0;

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let prefix: String = text.chars().take(max_chars.saturating_sub(3)).collect();
    format!("{}...", prefix.trim_end())
}

fn session_display_title(sess: &SessionSummary) -> String {
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

fn short_status_label(status: &str) -> &'static str {
    match status {
        "running" => "running",
        "review_requested" => "review",
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
    let settings_active = matches!(
        app.screen,
        crate::state::Screen::Workspace(crate::state::WorkspacePage::Settings(_))
    );

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
            !settings_active && app.active_conversation_id.as_deref() == Some(cid.as_str());
        let name = ch.name.clone().unwrap_or_else(|| "channel".to_string());
        let mut row = div()
            .id(("rail-ch", ci))
            .h(px(30.0))
            .px(px(8.0))
            .rounded(px(2.0))
            .flex()
            .items_center()
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
        row.child(kit::icon("kawan/hash.svg", 12.0, theme.dark))
            .child(theme::label(name, 13.0, theme.ink))
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
            let active = !settings_active
                && existing_dm
                    .is_some_and(|c| app.active_conversation_id.as_deref() == Some(c.id.as_str()));
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
                    let active = !settings_active
                        && existing_dm.is_some_and(|c| {
                            app.active_conversation_id.as_deref() == Some(c.id.as_str())
                        });
                    let mut row = div()
                        .id(("rail-dm-human", ui))
                        .h(px(30.0))
                        .px(px(8.0))
                        .rounded(px(2.0))
                        .flex()
                        .items_center()
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
                    row.child(kit::human_avatar(&user.name, 20.0, theme))
                        .child(theme::label(user.name.clone(), 13.0, theme.ink))
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
    let thread_count = messages
        .iter()
        .filter_map(|m| m.thread_id.as_ref())
        .collect::<std::collections::HashSet<_>>()
        .len();
    let first_thread = messages
        .iter()
        .find_map(|m| m.thread_id.clone().or_else(|| Some(m.id.clone())));

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
                                        move |this, _, _, cx| {
                                            if let Some(tid) = first_thread.clone() {
                                                this.right_panel = RightPanel::Thread(tid);
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

    let conv_errors = app
        .conv_errors
        .get(&active_cid)
        .map(Vec::as_slice)
        .unwrap_or(&[]);

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
                    .children(if messages.is_empty() {
                        vec![
                            div()
                                .py(px(24.0))
                                .child(theme::body(
                                    "No messages yet. Mention a bot with @name to start work.",
                                    13.0,
                                    theme.fg_tertiary,
                                ))
                                .into_any_element(),
                        ]
                    } else {
                        messages
                            .iter()
                            .enumerate()
                            .map(|(mi, msg)| {
                                message_row(app, msg, mi, theme, cx).into_any_element()
                            })
                            .collect()
                    }),
            ),
        );

    let placeholder = format!("Message {title}...");
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

fn bot_tasks_panel(
    app: &KawanApp,
    bot: &crate::protocol::BotSummary,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let workers = app.worker_sessions_for_bot(&bot.id);
    let active_count = workers
        .iter()
        .filter(|s| matches!(s.status.as_str(), "running" | "review_requested" | "failed"))
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
                            .child(
                                kit::ghost_button(("dm-task-inspect", ti), "Inspect", theme)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.open_session_inspector(&sid);
                                        cx.notify();
                                    })),
                            )
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
        content_col = content_col.child(artifact_card(
            app,
            artifact.id.clone(),
            artifact.filename.clone(),
            artifact.byte_size,
            sess,
            land,
            mi,
            theme,
            cx,
        ));
    } else if is_bot {
        let matching_land = app
            .lands_by_id
            .values()
            .find(|l| l.message_id.as_deref() == Some(msg.id.as_str()));
        if let Some(land) = matching_land {
            let sess = app.sessions_by_id.get(&land.session_id);
            content_col = content_col.child(land_card(land, sess, mi, theme, cx));
        }
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
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.right_panel = RightPanel::Thread(tid_open.clone());
                    cx.notify();
                })),
        );
    }

    let decisions = app.decisions_for_message(&msg.id);
    for (di, dec) in decisions.into_iter().enumerate() {
        content_col = content_col.child(decision_chip_row(app, dec, mi * 10 + di, theme, cx));
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
    let header_label = sess
        .map(session_display_title)
        .unwrap_or_else(|| "Artifact".to_string());

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
                .gap(px(10.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .child(theme::label(header_label, 12.0, theme.dark))
                        .child(kit::status_tag(
                            short_status_label(status).to_uppercase(),
                            status_color,
                            theme,
                        )),
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
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .children(txt.lines().take(24).map(|line| {
                        div()
                            .font_family(theme::MONO)
                            .text_size(px(11.0))
                            .line_height(px(15.5))
                            .text_color(theme.ink)
                            .child(line.to_string())
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
            .gap(px(8.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        kit::ghost_button(
                            ("art-toggle", mi),
                            if expanded {
                                "Hide artifact"
                            } else {
                                "View artifact"
                            },
                            theme,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.toggle_artifact_view(&art_toggle);
                            cx.notify();
                        })),
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
                        )),
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
            } else {
                kit::status_tag(land.status.to_uppercase(), status_color, theme).into_any_element()
            }),
    )
}

fn session_strip(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let workers = app.all_worker_sessions();
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

fn right_drawer(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let title = match &app.right_panel {
        RightPanel::Thread(tid) => format!("THREAD · {}", short_id(tid)),
        RightPanel::Session(sid) => format!("SESSION · {}", short_id(sid)),
        RightPanel::None => String::new(),
    };

    let body: AnyElement = match &app.right_panel {
        RightPanel::Thread(tid) => thread_drawer_body(app, tid, theme, cx).into_any_element(),
        RightPanel::Session(sid) => session_drawer_body(app, sid, theme, cx).into_any_element(),
        RightPanel::None => div().into_any_element(),
    };

    div()
        .w(px(380.0))
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
                .gap(px(10.0))
                .children(thread_msgs.into_iter().map(|m| {
                    div()
                        .pb(px(8.0))
                        .border_b_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .flex_col()
                        .gap(px(3.0))
                        .child(theme::micro(
                            format!("{} · #{}", app.actor_name(&m.author_id), m.seq),
                            9.0,
                            theme.dark,
                        ))
                        .child(theme::body(m.body.clone(), 12.5, theme.ink))
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

    div()
        .id("drawer-session-scroll")
        .flex_1()
        .min_h(px(0.0))
        .overflow_y_scroll()
        .p(px(16.0))
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(theme::title(session_display_title(sess), 17.0, theme.ink))
        .child(kit::status_tag(
            sess.status.to_uppercase(),
            status_color_hex(&sess.status),
            theme,
        ))
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
                .items_center()
                .justify_between()
                .child(kit::status_tag(
                    format!("LAND · {}", l.status.to_uppercase()),
                    status_color_hex(&l.status),
                    theme,
                ))
                .children((l.status == "requested" || l.status == "failed").then(|| {
                    kit::small_primary_button("drawer-approve-land", "Approve Land", theme)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.approve_land(&lid);
                            cx.notify();
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

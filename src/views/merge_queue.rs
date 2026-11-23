//! Merge Queue surface (#merge-queue): Merge Train pipeline status, check pills,
//! Queue Bot controls, and shared reconciliation conversation stream.

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, div, px, relative};

use crate::kit;
use crate::protocol::Land;
use crate::state::{KawanApp, RightPanel};
use crate::theme::{self, Theme};
use crate::views::conversation::{
    conversation_stream_and_composer, left_rail, right_drawer, session_display_title,
    session_strip, short_status_label, truncate_chars,
};
use crate::views::status_color_hex;

const MERGE_MEASURE: f32 = 780.0;

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
                .child(main_merge_queue_pane(app, theme, cx))
                .child(session_strip(app, theme, cx)),
        )
        .children((app.right_panel != RightPanel::None).then(|| right_drawer(app, theme, cx)))
}

fn main_merge_queue_pane(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let mq_snap = app.merge_queue.as_ref();
    let mq_cid = mq_snap
        .map(|q| q.conversation_id.clone())
        .or_else(|| app.merge_queue_conversation().map(|c| c.id.clone()))
        .unwrap_or_default();

    let (is_paused, policy, default_mode, bot_label, head_opt, queued_list, recent_count) =
        match mq_snap {
            Some(q) => {
                let bot_name = q
                    .settings
                    .bot_id
                    .as_deref()
                    .map(|bid| format!("@{}", app.actor_name(bid)))
                    .unwrap_or_else(|| "Unassigned".to_string());
                (
                    q.settings.paused || q.paused_land.is_some(),
                    q.settings.conflict_policy.as_str(),
                    q.settings.default_landing_mode.as_str(),
                    bot_name,
                    q.head.as_ref(),
                    q.queued.as_slice(),
                    q.recent_landed.len(),
                )
            }
            None => (
                false,
                "pause_on_issue",
                "manual",
                "Auto".to_string(),
                None,
                &[][..],
                0,
            ),
        };

    let (queue_state_lbl, queue_state_hex) = if is_paused {
        ("PAUSED", theme::CATEGORY_VALS)
    } else if !queued_list.is_empty() {
        ("RUNNING", theme::CATEGORY_INDUSTRY)
    } else {
        ("IDLE", 0x284D32)
    };

    let policy_lbl = if policy == "auto_resolve_trivial" {
        "Policy: Auto-resolve trivial"
    } else {
        "Policy: Pause on issue"
    };

    let header = div()
        .w_full()
        .flex_none()
        .bg(theme.surface)
        .flex()
        .justify_center()
        .child(
            div()
                .w(relative(1.0))
                .max_w(px(MERGE_MEASURE))
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
                        .flex_wrap()
                        .gap(px(12.0))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(2.0))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(10.0))
                                        .child(theme::title("#merge-queue", 24.0, theme.ink))
                                        .child(kit::status_tag(
                                            queue_state_lbl,
                                            queue_state_hex,
                                            theme,
                                        )),
                                )
                                .child(theme::body(
                                    "Serialized FIFO landing train & .kawan/checks verification.",
                                    12.5,
                                    theme.fg_secondary,
                                )),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .flex_wrap()
                                .gap(px(6.0))
                                .child(
                                    kit::ghost_button(
                                        "mq-bot-cycle",
                                        format!("Queue Bot: {bot_label}"),
                                        theme,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            this.merge_queue_cycle_bot();
                                            cx.notify();
                                        },
                                    )),
                                )
                                .child(
                                    kit::ghost_button("mq-policy-toggle", policy_lbl, theme)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.merge_queue_toggle_conflict_policy();
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    kit::ghost_button(
                                        "mq-default-landing-btn",
                                        format!("Default: {default_mode}"),
                                        theme,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            this.merge_queue_toggle_default_landing_mode();
                                            cx.notify();
                                        },
                                    )),
                                )
                                .child(if is_paused {
                                    kit::small_primary_button("mq-resume", "Resume Queue", theme)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.merge_queue_resume();
                                            cx.notify();
                                        }))
                                        .into_any_element()
                                } else {
                                    kit::secondary_button("mq-pause", "Pause", theme)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.merge_queue_pause();
                                            cx.notify();
                                        }))
                                        .into_any_element()
                                })
                                .child(kit::ghost_button("mq-refresh", "Refresh", theme).on_click(
                                    cx.listener(|this, _, _, cx| {
                                        this.open_merge_queue();
                                        cx.notify();
                                    }),
                                )),
                        ),
                ),
        );

    let mut train_col = div()
        .w(relative(1.0))
        .max_w(px(MERGE_MEASURE))
        .px(px(24.0))
        .pt(px(12.0))
        .pb(px(4.0))
        .flex()
        .flex_col()
        .gap(px(8.0));

    if let Some(head) = head_opt {
        train_col = train_col.child(merge_train_head_card(app, head, theme, cx));
        let trailing: Vec<&Land> = queued_list.iter().filter(|l| l.id != head.id).collect();
        if !trailing.is_empty() {
            train_col =
                train_col.child(
                    div()
                        .w_full()
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(theme.border_subtle)
                        .bg(theme.strip)
                        .overflow_hidden()
                        .flex()
                        .flex_col()
                        .children(
                            trailing.into_iter().take(4).enumerate().map(|(qi, item)| {
                                queued_item_row(app, item, qi + 2, qi, theme, cx)
                            }),
                        ),
                );
        }
    } else {
        train_col = train_col.child(
            div()
                .w_full()
                .px(px(14.0))
                .py(px(10.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.strip)
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .child(theme::body(
                    "Queue is clear — approved branches land here in FIFO order.",
                    12.5,
                    theme.fg_secondary,
                ))
                .children((recent_count > 0).then(|| {
                    theme::micro(
                        format!("{recent_count} RECENT LANDED"),
                        8.5,
                        theme.fg_tertiary,
                    )
                })),
        );
    }

    let train_section = div()
        .flex_none()
        .w_full()
        .flex()
        .justify_center()
        .child(train_col);

    let (stream, composer) = conversation_stream_and_composer(
        app,
        &mq_cid,
        "#merge-queue",
        true,
        "Queue is quiet. Rebase conflicts and check failures open reconciliation threads here.",
        theme,
        cx,
    );

    div()
        .flex_1()
        .min_h(px(0.0))
        .w_full()
        .flex()
        .flex_col()
        .child(header)
        .child(train_section)
        .child(stream)
        .child(composer)
}

fn pipeline_stage_pill(
    label: &'static str,
    state: &'static str, // "pass" | "active" | "fail" | "pending"
    theme: &Theme,
) -> Div {
    let (bg, border, fg) = match state {
        "pass" => (
            theme::hex(0xEDF7EF),
            theme::hex(0x284D32),
            theme::hex(0x1C592C),
        ),
        "active" => (
            theme::with_alpha(theme::CATEGORY_INDUSTRY, 0.12),
            theme::hex(theme::CATEGORY_INDUSTRY),
            theme::hex(theme::CATEGORY_INDUSTRY),
        ),
        "fail" => (
            theme::hex(0xFDF0EF),
            theme::hex(theme::CATEGORY_VALS),
            theme::hex(theme::CATEGORY_VALS),
        ),
        _ => (theme.surface, theme.border_subtle, theme.fg_tertiary),
    };
    div()
        .h(px(20.0))
        .px(px(8.0))
        .rounded(px(2.0))
        .border_1()
        .border_color(border)
        .bg(bg)
        .flex()
        .items_center()
        .child(theme::micro(label, 8.5, fg))
}

fn merge_train_head_card(
    app: &KawanApp,
    head: &Land,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let sess = app.sessions_by_id.get(&head.session_id);
    let title = sess
        .map(|s| truncate_chars(&session_display_title(s), 44))
        .unwrap_or_else(|| "Queued branch".to_string());
    let origin = app.conversation_label(&head.conversation_id);
    let pos = head.queue_position.unwrap_or(1);
    let status_color = status_color_hex(&head.status);

    let is_rebase_fail =
        head.status == "paused" && head.pause_reason.as_deref() == Some("rebase_conflict");
    let is_checks_fail = head.status == "paused" && !is_rebase_fail;

    let rebase_state = match head.status.as_str() {
        "queued" => "pending",
        "rebasing" => "active",
        "paused" if is_rebase_fail => "fail",
        _ => "pass",
    };
    let checks_state = match head.status.as_str() {
        "queued" | "rebasing" => "pending",
        "verifying" => "active",
        "paused" if is_checks_fail => "fail",
        "paused" if is_rebase_fail => "pending",
        "landed" => "pass",
        _ => "pending",
    };
    let land_state = if head.status == "landed" {
        "pass"
    } else {
        "pending"
    };

    let sid_changes = head.session_id.clone();
    let sid_inspect = head.session_id.clone();
    let lid_retry = head.id.clone();
    let lid_eject = head.id.clone();
    let lid_defer = head.id.clone();
    let q_tid = head.queue_thread_id.clone();

    let mut card = div()
        .w_full()
        .relative()
        .overflow_hidden()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .child(kit::left_edge(theme::hex(status_color)))
        .child(
            div()
                .px(px(14.0))
                .py(px(10.0))
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .flex_wrap()
                        .gap(px(8.0))
                        .child(
                            div()
                                .min_w(px(0.0))
                                .flex_1()
                                .flex()
                                .items_center()
                                .flex_wrap()
                                .gap(px(8.0))
                                .child(theme::numeric(format!("#{pos}"), 11.0, theme.fg_tertiary))
                                .child(theme::label(title, 13.5, theme.ink))
                                .child(kit::status_tag(
                                    short_status_label(&head.status).to_uppercase(),
                                    status_color,
                                    theme,
                                ))
                                .children(head.touches_kawan.then(|| {
                                    kit::status_tag("MODIFIES .kawan/", theme::UMBER_VIVID, theme)
                                })),
                        )
                        .child(theme::micro(origin, 8.5, theme.fg_tertiary)),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .flex_wrap()
                        .gap(px(6.0))
                        .child(pipeline_stage_pill("1. Rebase", rebase_state, theme))
                        .child(theme::micro("→", 9.0, theme.fg_tertiary))
                        .child(pipeline_stage_pill("2. Checks", checks_state, theme))
                        .child(theme::micro("→", 9.0, theme.fg_tertiary))
                        .child(pipeline_stage_pill("3. Land", land_state, theme)),
                )
                .children((!head.checks.is_empty()).then(|| {
                    div()
                        .flex()
                        .items_center()
                        .flex_wrap()
                        .gap(px(6.0))
                        .children(head.checks.iter().enumerate().map(|(ci, chk)| {
                            let (bg, border, fg, mark) = if chk.ok {
                                (
                                    theme::hex(0xEDF7EF),
                                    theme::hex(0x284D32),
                                    theme::hex(0x1C592C),
                                    "✓",
                                )
                            } else {
                                (
                                    theme::hex(0xFDF0EF),
                                    theme::hex(theme::CATEGORY_VALS),
                                    theme::hex(theme::CATEGORY_VALS),
                                    "✕",
                                )
                            };
                            let art_id = chk.artifact_id.clone();
                            let thread_fallback = q_tid.clone();
                            let pill = div()
                                .id(("mq-chk-pill", ci))
                                .h(px(21.0))
                                .px(px(8.0))
                                .rounded(px(2.0))
                                .border_1()
                                .border_color(border)
                                .bg(bg)
                                .flex()
                                .items_center()
                                .gap(px(4.0))
                                .cursor_pointer()
                                .child(theme::numeric(format!("{mark} {}", chk.name), 10.5, fg));
                            pill.on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(aid) = &art_id {
                                    this.toggle_artifact_view(aid);
                                }
                                if let Some(tid) = &thread_fallback {
                                    this.open_merge_queue_thread(tid);
                                }
                                cx.notify();
                            }))
                        }))
                }))
                .children(head.error.as_deref().map(|err| {
                    let excerpt_lines: Vec<&str> = err
                        .lines()
                        .filter(|l| !l.trim().is_empty())
                        .take(5)
                        .collect();
                    div()
                        .w_full()
                        .p(px(8.0))
                        .rounded(px(2.0))
                        .bg(theme::with_alpha(theme::CATEGORY_VALS, 0.06))
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
                        .children(excerpt_lines.into_iter().map(|line| {
                            div()
                                .w_full()
                                .min_w(px(0.0))
                                .font_family(theme::MONO)
                                .text_size(px(10.5))
                                .line_height(px(14.5))
                                .text_color(theme::hex(theme::CATEGORY_VALS))
                                .child(line.to_string())
                        }))
                })),
        );

    let mut left_actions = div()
        .flex()
        .items_center()
        .flex_wrap()
        .gap(px(6.0))
        .child(
            kit::ghost_button("mq-head-changes", "Changes", theme).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.open_session_changes(&sid_changes);
                    cx.notify();
                },
            )),
        )
        .child(
            kit::ghost_button("mq-head-inspect", "Inspect", theme).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.open_session_inspector(&sid_inspect);
                    cx.notify();
                },
            )),
        );
    if let Some(tid) = q_tid {
        left_actions = left_actions.child(
            kit::ghost_button("mq-head-thread", "Open Thread", theme).on_click(cx.listener(
                move |this, _, window, cx| {
                    this.open_merge_queue_thread(&tid);
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                },
            )),
        );
    }

    let right_actions = div()
        .flex()
        .items_center()
        .flex_wrap()
        .gap(px(6.0))
        .child(
            kit::ghost_button("mq-head-defer", "Defer", theme).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.merge_queue_remove(&lid_defer);
                    cx.notify();
                },
            )),
        )
        .child(
            kit::secondary_button("mq-head-eject", "Send back to implementer", theme).on_click(
                cx.listener(move |this, _, _, cx| {
                    this.merge_queue_eject(&lid_eject);
                    cx.notify();
                }),
            ),
        )
        .child(
            kit::small_primary_button("mq-head-retry", "Retry checks", theme).on_click(
                cx.listener(move |this, _, _, cx| {
                    this.merge_queue_retry(Some(&lid_retry));
                    cx.notify();
                }),
            ),
        );

    card = card.child(
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
            .child(left_actions)
            .child(right_actions),
    );
    card
}

fn queued_item_row(
    app: &KawanApp,
    land: &Land,
    pos: usize,
    qi: usize,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> AnyElement {
    let sess = app.sessions_by_id.get(&land.session_id);
    let title = sess
        .map(|s| truncate_chars(&session_display_title(s), 44))
        .unwrap_or_else(|| "Queued branch".to_string());
    let origin = app.conversation_label(&land.conversation_id);
    let sid_changes = land.session_id.clone();
    let lid_remove = land.id.clone();

    div()
        .px(px(14.0))
        .py(px(7.0))
        .border_b_1()
        .border_color(theme.border_subtle)
        .flex()
        .items_center()
        .justify_between()
        .gap(px(10.0))
        .child(
            div()
                .min_w(px(0.0))
                .flex_1()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(theme::numeric(format!("#{pos}"), 10.5, theme.fg_tertiary))
                .child(theme::label(title, 12.5, theme.ink))
                .child(theme::numeric(origin, 10.0, theme.fg_tertiary))
                .children(
                    land.touches_kawan
                        .then(|| kit::status_tag("MODIFIES .kawan/", theme::UMBER_VIVID, theme)),
                ),
        )
        .child(
            div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(
                    kit::ghost_button(("mq-q-changes", qi), "Changes", theme).on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.open_session_changes(&sid_changes);
                            cx.notify();
                        }),
                    ),
                )
                .child(
                    kit::ghost_button(("mq-q-remove", qi), "Remove", theme).on_click(cx.listener(
                        move |this, _, _, cx| {
                            this.merge_queue_remove(&lid_remove);
                            cx.notify();
                        },
                    )),
                ),
        )
        .into_any_element()
}

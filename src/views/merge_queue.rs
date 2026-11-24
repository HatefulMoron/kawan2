//! Merge Queue surface (#merge-queue): Merge Train pipeline status, check pills,
//! Queue Bot controls, and shared reconciliation conversation stream.

use std::time::{SystemTime, UNIX_EPOCH};

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, ObjectFit, StyledImage, div, img, px, relative};

use crate::kit;
use crate::protocol::{Artifact, Land, ProposalCard};
use crate::state::{KawanApp, RightPanel};
use crate::theme::{self, Theme};
use crate::views::conversation::{
    StreamOptions, conversation_stream_and_composer, inline_artifact_bytes, left_rail,
    message_body_clipped, right_drawer, session_display_title, session_strip, short_status_label,
    truncate_chars,
};
use crate::views::{markdown, short_id, status_color_hex};

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

    let mut train_col = div().w_full().flex().flex_col().gap(px(8.0));

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
                    "Queue is clear — merged branches land here in FIFO order.",
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

    // Proposals are rendered as cards above the train, so keep their messages out of
    // the reconciliation stream below — including withdrawn/landed guidance whose
    // message would otherwise pop back in as ordinary chat.
    let mut proposal_message_ids: Vec<&str> = app
        .proposals()
        .iter()
        .map(|card| card.message.id.as_str())
        .collect();
    proposal_message_ids.extend(
        app.lands_by_id
            .values()
            .filter_map(|land| land.message_id.as_deref()),
    );
    proposal_message_ids.sort_unstable();
    proposal_message_ids.dedup();

    // Proposals and the train scroll with the conversation: the pinned header stays,
    // and a tall proposal can never squeeze the stream out of view.
    let above = div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(10.0))
        .pb(px(6.0))
        .child(proposals_section(app, theme, cx))
        .child(train_col);

    let (stream, composer) = conversation_stream_and_composer(
        app,
        &mq_cid,
        StreamOptions {
            title: "#merge-queue",
            is_channel: true,
            empty_hint: "Queue is quiet. Rebase conflicts and check failures open reconciliation threads here.",
            hidden_message_ids: &proposal_message_ids,
            above: Some(above.into_any_element()),
        },
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
        .child(stream)
        .child(composer)
}

/// `Proposed (N)`: open proposals, each one an ordinary message awaiting **Merge**.
fn proposals_section(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let proposals = app.proposals();
    let mut col = div().w_full().flex().flex_col().gap(px(8.0)).child(
        div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .child(theme::micro(
                format!("PROPOSED ({})", proposals.len()),
                9.0,
                theme.fg_tertiary,
            ))
            .children(
                (!proposals.is_empty())
                    .then(|| theme::micro("AWAITING MERGE", 8.5, theme.fg_tertiary)),
            ),
    );

    if proposals.is_empty() {
        col = col.child(
            div()
                .w_full()
                .px(px(14.0))
                .py(px(10.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.strip)
                .child(theme::body(
                    "Nothing is proposed yet — finished branches show up here for Merge.",
                    12.5,
                    theme.fg_tertiary,
                )),
        );
    } else {
        col = col.children(
            proposals
                .iter()
                .enumerate()
                .map(|(pi, card)| proposal_card(app, card, pi, theme, cx)),
        );
    }

    col
}

fn proposal_card(
    app: &KawanApp,
    card: &ProposalCard,
    idx: usize,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let land = &card.land;
    let accent = theme::hex(status_color_hex(&land.status));
    let plain = markdown::plain_text(&card.message.body)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title = card
        .session_title
        .clone()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| truncate_chars(&plain, 72));
    let unseen = app.message_unseen(&card.message);
    let origin = app.conversation_label(&land.conversation_id);
    let origin_cid = land.conversation_id.clone();
    let lid_merge = land.id.clone();
    let lid_withdraw = land.id.clone();
    let msg_id = card.message.id.clone();
    let checks_failed = card.checks.iter().any(|c| !c.ok);
    let needs_confirm = checks_failed || land.touches_kawan;
    let confirm_armed = needs_confirm && app.confirm_merge.as_deref() == Some(land.id.as_str());
    let lid_confirm = land.id.clone();
    // A short proposal can still have replies; the thread drawer is their only entrance.
    let has_replies = app
        .messages_by_conv
        .get(&card.message.conversation_id)
        .is_some_and(|messages| {
            messages
                .iter()
                .any(|m| m.thread_id.as_deref() == Some(msg_id.as_str()))
        });

    let (body, clipped) = message_body_clipped(app, &card.message.body, 12.5, theme, cx, Some(4));

    // Thumbnails are for images the body does not already show inline.
    let images: Vec<&Artifact> = card
        .message
        .attachments
        .iter()
        .filter(|a| {
            a.mime_type.starts_with("image/")
                && !card
                    .message
                    .body
                    .contains(&format!("kawan://artifact/{}", a.id))
        })
        .collect();

    let mut content = div()
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
                        .child(kit::bot_avatar(20.0, theme))
                        .child(theme::label(
                            format!("@{}", card.author.name),
                            12.0,
                            theme.fg_secondary,
                        ))
                        .child(theme::label(title, 13.5, theme.ink))
                        .children(card.issue_number.map(|n| {
                            kit::status_tag(format!("#{n}"), theme::CATEGORY_INDUSTRY, theme)
                        }))
                        .children(land.touches_kawan.then(|| {
                            kit::status_tag("MODIFIES .kawan/", theme::UMBER_VIVID, theme)
                        })),
                )
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(5.0))
                        .children(unseen.then(|| kit::swatch(theme.vivid, px(5.0))))
                        .child(theme::micro(
                            format!("updated {}", time_ago(card.updated_at)),
                            8.5,
                            theme.fg_tertiary,
                        )),
                ),
        )
        .child(body);

    if !images.is_empty() {
        content = content.child(
            div()
                .flex()
                .items_center()
                .flex_wrap()
                .gap(px(6.0))
                .children(images.into_iter().enumerate().map(|(ti, a)| {
                    let aid = a.id.clone();
                    let label = a.filename.clone().unwrap_or_else(|| short_id(&a.id));
                    let thumb: AnyElement = match inline_artifact_bytes(app, &a.id) {
                        Some(bytes) => div()
                            .rounded(px(2.0))
                            .overflow_hidden()
                            .border_1()
                            .border_color(theme.border_subtle)
                            .child(
                                img(bytes)
                                    .h(px(72.0))
                                    .max_w(px(180.0))
                                    .object_fit(ObjectFit::Cover),
                            )
                            .into_any_element(),
                        None => div()
                            .h(px(72.0))
                            .px(px(10.0))
                            .rounded(px(2.0))
                            .border_1()
                            .border_color(theme.border_subtle)
                            .bg(theme.strip)
                            .flex()
                            .items_center()
                            .child(theme::numeric(label, 10.0, theme.fg_tertiary))
                            .into_any_element(),
                    };
                    div()
                        .id(("mq-prop-thumb", idx * 10 + ti))
                        .cursor_pointer()
                        .hover(|s| s.opacity(0.85))
                        .child(thumb)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_artifact_drawer(&aid);
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }))
                })),
        );
    }

    content = content.child(
        div()
            .flex()
            .items_center()
            .flex_wrap()
            .gap(px(6.0))
            .children(card.checks.iter().enumerate().map(|(ci, chk)| {
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
                let pill = div()
                    .id(("mq-prop-chk", idx * 10 + ci))
                    .h(px(21.0))
                    .px(px(8.0))
                    .rounded(px(2.0))
                    .border_1()
                    .border_color(border)
                    .bg(bg)
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(theme::numeric(format!("{mark} {}", chk.name), 10.5, fg));
                match art_id {
                    Some(aid) => {
                        pill.cursor_pointer()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_artifact_drawer(&aid);
                                window.focus(&this.focus_handle, cx);
                                cx.notify();
                            }))
                    }
                    None => pill,
                }
            }))
            .child(theme::numeric(
                format!(
                    "{} commits ahead · {} behind main",
                    card.commits_ahead, card.behind_main
                ),
                10.0,
                theme.fg_tertiary,
            )),
    );

    if let Some(err) = land.error.as_deref()
        && !err.trim().is_empty()
    {
        content = content.child(theme::body(
            err.to_string(),
            11.0,
            theme::hex(theme::CATEGORY_VALS),
        ));
    }

    if clipped || has_replies {
        content = content.child(div().flex().items_center().child(
            kit::ghost_button(("mq-prop-full", idx), "View full proposal", theme).on_click(
                cx.listener(move |this, _, window, cx| {
                    this.right_panel = RightPanel::Thread(msg_id.clone());
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }),
            ),
        ));
    }

    div()
        .w_full()
        .relative()
        .overflow_hidden()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .child(kit::left_edge(accent))
        .child(content)
        .child(
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
                    kit::ghost_button(("mq-prop-open", idx), format!("Open in {origin}"), theme)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            // Issue-origin proposals belong to an issue room, not a DM.
                            match this.issue_by_conv(&origin_cid).map(|i| i.id.clone()) {
                                Some(iid) => this.open_issue(&iid),
                                None => this.open_conversation(&origin_cid),
                            }
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            kit::ghost_button(("mq-prop-withdraw", idx), "Withdraw", theme)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.withdraw_land(&lid_withdraw);
                                    cx.notify();
                                })),
                        )
                        .child(
                            kit::small_primary_button(
                                ("mq-prop-merge", idx),
                                if confirm_armed {
                                    "Confirm merge"
                                } else if needs_confirm {
                                    "Merge anyway"
                                } else {
                                    "Merge"
                                },
                                theme,
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    if needs_confirm
                                        && this.confirm_merge.as_deref() != Some(&lid_confirm)
                                    {
                                        this.confirm_merge = Some(lid_confirm.clone());
                                    } else {
                                        this.merge_land(&lid_merge);
                                    }
                                    cx.notify();
                                },
                            )),
                        ),
                ),
        )
}

/// Compact `updated 3m ago` stamp for a millisecond timestamp.
fn time_ago(timestamp_ms: u64) -> String {
    if timestamp_ms == 0 {
        return "just now".to_string();
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let secs = now_ms.saturating_sub(timestamp_ms) / 1000;
    match secs {
        0..=9 => "just now".to_string(),
        10..=59 => format!("{secs}s ago"),
        60..=3599 => format!("{}m ago", secs / 60),
        3600..=86_399 => format!("{}h ago", secs / 3600),
        _ => format!("{}d ago", secs / 86_400),
    }
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
                                    this.open_artifact_drawer(aid);
                                } else if let Some(tid) = &thread_fallback {
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

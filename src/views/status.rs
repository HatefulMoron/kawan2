//! Repository Status view: repo-wide delivery ledger across channels and DMs
//! (Needs You, Waiting to Land, In Flight, Shipped) sharing the conversation chrome.

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, div, px, relative};

use crate::kit;
use crate::protocol::{Artifact, Land, SessionSummary};
use crate::state::{KawanApp, RightPanel};
use crate::theme::{self, Theme};
use crate::views::conversation::{
    left_rail, right_drawer, session_display_title, session_strip, short_status_label,
};
use crate::views::{short_id, status_color_hex};

const STATUS_MEASURE: f32 = 860.0;

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
                .child(main_status_pane(app, theme, cx))
                .child(session_strip(app, theme, cx)),
        )
        .children((app.right_panel != RightPanel::None).then(|| right_drawer(app, theme, cx)))
}

fn find_report_artifact<'a>(
    app: &'a KawanApp,
    sess: &SessionSummary,
    land: Option<&Land>,
) -> Option<&'a Artifact> {
    let mut candidates: Vec<&Artifact> = app
        .artifacts_by_id
        .values()
        .filter(|a| {
            a.session_id.as_deref() == Some(sess.id.as_str()) && !a.mime_type.starts_with("image/")
        })
        .collect();
    if candidates.is_empty()
        && let Some(mid) = land.and_then(|l| l.message_id.as_deref())
    {
        candidates = app
            .artifacts_by_id
            .values()
            .filter(|a| a.message_id.as_deref() == Some(mid) && !a.mime_type.starts_with("image/"))
            .collect();
    }
    candidates.sort_by_key(|a| {
        let is_report_md = a
            .filename
            .as_deref()
            .is_some_and(|n| n.eq_ignore_ascii_case("report.md"));
        let is_md = a.mime_type.contains("markdown")
            || a.filename
                .as_deref()
                .is_some_and(|n| n.ends_with(".md") || n.ends_with(".markdown"));
        (
            if is_report_md {
                0_u8
            } else if is_md {
                1
            } else {
                2
            },
            std::cmp::Reverse(a.created_at),
        )
    });
    candidates.into_iter().next()
}

fn main_status_pane(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let workers = app.all_worker_sessions();

    let mut needs_you: Vec<(&SessionSummary, Option<&Land>)> = Vec::new();
    let mut waiting: Vec<(&SessionSummary, Option<&Land>)> = Vec::new();
    let mut in_flight: Vec<&SessionSummary> = Vec::new();

    for sess in &workers {
        let land = app.land_for_session(&sess.id);
        let land_status = land.map(|l| l.status.as_str());
        if land_status == Some("failed")
            || (sess.status == "failed" && land_status != Some("landed"))
        {
            needs_you.push((sess, land));
        } else if matches!(land_status, Some("requested" | "verifying"))
            || (sess.status == "review_requested" && land_status != Some("landed"))
        {
            waiting.push((sess, land));
        } else if matches!(sess.status.as_str(), "running" | "idle")
            && land_status != Some("landed")
        {
            in_flight.push(sess);
        }
    }

    needs_you.sort_by_key(|(s, _)| std::cmp::Reverse(s.updated_at));
    waiting.sort_by_key(|(s, _)| std::cmp::Reverse(s.updated_at));
    in_flight.sort_by_key(|s| std::cmp::Reverse(s.updated_at));

    let mut shipped: Vec<&Land> = app
        .lands_by_id
        .values()
        .filter(|l| l.status == "landed")
        .collect();
    shipped.sort_by_key(|l| std::cmp::Reverse(l.updated_at));

    let repo_badge = match &app.status_repo {
        Some(r) => match &r.head_sha {
            Some(sha) => format!(
                "{} · {}",
                r.default_branch,
                sha.chars().take(8).collect::<String>()
            ),
            None => r.default_branch.clone(),
        },
        None => app
            .settings
            .repo
            .as_ref()
            .map(|r| r.default_branch.clone())
            .unwrap_or_else(|| "no repo".to_string()),
    };

    let top_bar = kit::strip_bar(theme)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.0))
                .child(theme::micro("REPOSITORY STATUS", 9.5, theme.ink))
                .child(theme::numeric(repo_badge, 10.5, theme.fg_tertiary)),
        )
        .child(
            kit::ghost_button("status-refresh", "Refresh", theme).on_click(cx.listener(
                |this, _, _, cx| {
                    this.refresh_workspace();
                    cx.notify();
                },
            )),
        );

    let mut inner = div()
        .w(relative(1.0))
        .max_w(px(STATUS_MEASURE))
        .px(px(28.0))
        .py(px(22.0))
        .flex()
        .flex_col()
        .gap(px(18.0))
        .child(
            div()
                .pb(px(12.0))
                .border_b_1()
                .border_color(theme.border)
                .flex()
                .items_end()
                .justify_between()
                .gap(px(16.0))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(theme::title("Repository Status", 26.0, theme.ink))
                        .child(theme::body(
                            "What needs attention, is moving across channels, or has landed on the default branch.",
                            13.0,
                            theme.fg_secondary,
                        )),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .child(theme::micro(
                            format!("{} WAITING", waiting.len()),
                            8.5,
                            theme.fg_tertiary,
                        ))
                        .child(theme::micro(
                            format!("{} IN FLIGHT", in_flight.len()),
                            8.5,
                            theme.fg_tertiary,
                        ))
                        .child(theme::micro(
                            format!("{} SHIPPED", shipped.len()),
                            8.5,
                            theme.fg_tertiary,
                        )),
                ),
        );

    if let Some(err) = &app.error_banner {
        inner = inner.child(
            div()
                .p(px(10.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme::with_alpha(theme::CATEGORY_VALS, 0.5))
                .bg(theme::with_alpha(theme::CATEGORY_VALS, 0.06))
                .child(theme::body(
                    err.clone(),
                    12.0,
                    theme::hex(theme::CATEGORY_VALS),
                )),
        );
    }

    if !needs_you.is_empty() {
        inner = inner.child(status_section(
            "NEEDS YOU",
            needs_you.len(),
            theme::CATEGORY_VALS,
            needs_you
                .into_iter()
                .enumerate()
                .map(|(i, (sess, land))| {
                    status_task_card(app, "st-needs", i, sess, land, theme, cx)
                })
                .collect(),
            None,
            theme,
        ));
    }

    inner = inner.child(status_section(
        "WAITING TO LAND",
        waiting.len(),
        theme::CATEGORY_ACADEMIC,
        waiting
            .into_iter()
            .enumerate()
            .map(|(i, (sess, land))| status_task_card(app, "st-wait", i, sess, land, theme, cx))
            .collect(),
        Some("Nothing waiting to land."),
        theme,
    ));

    inner = inner.child(status_section(
        "IN FLIGHT",
        in_flight.len(),
        theme::CATEGORY_INDUSTRY,
        in_flight
            .into_iter()
            .enumerate()
            .map(|(i, sess)| status_in_flight_row(app, i, sess, theme, cx))
            .collect(),
        Some("No tasks currently running."),
        theme,
    ));

    inner = inner.child(status_section(
        "SHIPPED",
        shipped.len(),
        0x284D32,
        shipped
            .into_iter()
            .enumerate()
            .map(|(i, land)| status_shipped_card(app, i, land, theme, cx))
            .collect(),
        Some("No landed tasks yet."),
        theme,
    ));

    let body = div()
        .id("status-scroll")
        .flex_1()
        .min_h(px(0.0))
        .overflow_y_scroll()
        .bg(theme.surface)
        .child(div().w_full().flex().justify_center().child(inner));

    div()
        .flex_1()
        .min_h(px(0.0))
        .flex()
        .flex_col()
        .child(top_bar)
        .child(body)
}

fn status_section(
    heading: &str,
    count: usize,
    accent_hex: u32,
    items: Vec<AnyElement>,
    empty_text: Option<&str>,
    theme: &Theme,
) -> Div {
    let mut section = div().flex().flex_col().gap(px(10.0)).child(
        div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(kit::swatch(theme::hex(accent_hex), px(6.0)))
            .child(theme::micro(
                format!("{heading} · {count}"),
                9.5,
                theme.dark,
            )),
    );

    if items.is_empty() {
        if let Some(empty) = empty_text {
            section = section.child(
                div()
                    .px(px(12.0))
                    .py(px(10.0))
                    .rounded(px(2.0))
                    .border_1()
                    .border_color(theme.border_subtle)
                    .bg(theme.strip)
                    .child(theme::body(empty.to_string(), 12.5, theme.fg_tertiary)),
            );
        }
        return section;
    }

    section.children(items)
}

fn origin_chip(
    id: (&'static str, usize),
    conv_id: Option<&str>,
    thread_id: Option<&str>,
    app: &KawanApp,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Option<gpui::Stateful<Div>> {
    let cid = conv_id?.to_string();
    let tid = thread_id.map(str::to_string);
    let label = app.conversation_label(&cid);
    Some(
        kit::ghost_button(id, label, theme).on_click(cx.listener(move |this, _, window, cx| {
            this.open_conversation_thread(&cid, tid.as_deref());
            window.focus(&this.focus_handle, cx);
            cx.notify();
        })),
    )
}

fn expandable_report_block(app: &KawanApp, artifact: &Artifact, theme: &Theme) -> Option<Div> {
    if !app.expanded_artifacts.contains(&artifact.id) {
        return None;
    }
    let content: AnyElement = if let Some(loaded) = app.loaded_artifacts.get(&artifact.id) {
        if let Some(txt) = &loaded.text_preview {
            let lines: Vec<&str> = txt.lines().collect();
            let remaining = lines.len().saturating_sub(80);
            div()
                .w_full()
                .min_w(px(0.0))
                .flex()
                .flex_col()
                .gap(px(2.0))
                .children(lines.into_iter().take(80).map(|line| {
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
            theme::numeric("Binary report artifact", 11.0, theme.fg_tertiary).into_any_element()
        }
    } else {
        theme::numeric("Loading report...", 11.0, theme.fg_tertiary).into_any_element()
    };

    Some(
        div()
            .w_full()
            .p(px(12.0))
            .bg(theme.surface)
            .border_t_1()
            .border_color(theme.border_subtle)
            .child(content),
    )
}

fn status_task_card(
    app: &KawanApp,
    prefix: &'static str,
    idx: usize,
    sess: &SessionSummary,
    land: Option<&Land>,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> AnyElement {
    let status_str = land
        .map(|l| l.status.as_str())
        .unwrap_or(sess.status.as_str());
    let status_color = status_color_hex(status_str);
    let title = session_display_title(sess);
    let bot_name = format!("@{}", app.actor_name(&sess.bot_id));
    let conv_id = land
        .map(|l| l.conversation_id.as_str())
        .or(sess.conversation_id.as_deref());
    let thread_id = land
        .and_then(|l| l.thread_id.as_deref())
        .or(sess.thread_id.as_deref());
    let report_art = find_report_artifact(app, sess, land);
    let sid_changes = sess.id.clone();
    let sid_inspect = sess.id.clone();

    let mut card = div()
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
                .px(px(14.0))
                .py(px(10.0))
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(
                    div()
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
                                .child(theme::label(title, 13.5, theme.ink))
                                .child(kit::status_tag(
                                    short_status_label(status_str).to_uppercase(),
                                    status_color,
                                    theme,
                                )),
                        )
                        .child(theme::micro(bot_name, 8.5, theme.fg_tertiary)),
                )
                .children(
                    sess.last_report
                        .as_ref()
                        .map(|rep| theme::body(rep.clone(), 12.5, theme.fg_secondary)),
                )
                .children(land.and_then(|l| l.error.as_ref()).map(|err| {
                    div()
                        .p(px(8.0))
                        .rounded(px(2.0))
                        .bg(theme::with_alpha(theme::CATEGORY_VALS, 0.06))
                        .child(
                            div()
                                .w_full()
                                .min_w(px(0.0))
                                .font_family(theme::MONO)
                                .text_size(px(11.0))
                                .line_height(px(15.0))
                                .text_color(theme::hex(theme::CATEGORY_VALS))
                                .child(err.clone()),
                        )
                })),
        );

    if let Some(art) = report_art
        && let Some(preview) = expandable_report_block(app, art, theme)
    {
        card = card.child(preview);
    }

    let report_btn_id = if prefix == "st-needs" {
        ("st-needs-report", idx)
    } else {
        ("st-wait-report", idx)
    };
    let origin_btn_id = if prefix == "st-needs" {
        ("st-needs-origin", idx)
    } else {
        ("st-wait-origin", idx)
    };
    let changes_btn_id = if prefix == "st-needs" {
        ("st-needs-changes", idx)
    } else {
        ("st-wait-changes", idx)
    };
    let inspect_btn_id = if prefix == "st-needs" {
        ("st-needs-inspect", idx)
    } else {
        ("st-wait-inspect", idx)
    };
    let approve_btn_id = if prefix == "st-needs" {
        ("st-needs-approve", idx)
    } else {
        ("st-wait-approve", idx)
    };

    let mut left_actions = div().flex().items_center().gap(px(6.0));
    if let Some(chip) = origin_chip(origin_btn_id, conv_id, thread_id, app, theme, cx) {
        left_actions = left_actions.child(chip);
    }
    if let Some(art) = report_art {
        let aid = art.id.clone();
        let expanded = app.expanded_artifacts.contains(&aid);
        let label = if expanded {
            "Hide report"
        } else {
            "View report"
        };
        left_actions = left_actions.child(kit::ghost_button(report_btn_id, label, theme).on_click(
            cx.listener(move |this, _, _, cx| {
                this.toggle_artifact_view(&aid);
                cx.notify();
            }),
        ));
    }
    left_actions = left_actions
        .child(
            kit::ghost_button(changes_btn_id, "Changes", theme).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.open_session_changes(&sid_changes);
                    cx.notify();
                },
            )),
        )
        .child(
            kit::ghost_button(inspect_btn_id, "Inspect", theme).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.open_session_inspector(&sid_inspect);
                    cx.notify();
                },
            )),
        );

    let approve_el: Option<AnyElement> = land.and_then(|l| {
        if l.status == "requested" || l.status == "failed" {
            let lid = l.id.clone();
            Some(
                kit::small_primary_button(approve_btn_id, "Approve Land", theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.approve_land(&lid);
                        cx.notify();
                    }))
                    .into_any_element(),
            )
        } else {
            None
        }
    });

    card.child(
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
            .child(left_actions)
            .children(approve_el),
    )
    .into_any_element()
}

fn status_in_flight_row(
    app: &KawanApp,
    idx: usize,
    sess: &SessionSummary,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> AnyElement {
    let status_color = status_color_hex(&sess.status);
    let title = session_display_title(sess);
    let bot_name = format!("@{}", app.actor_name(&sess.bot_id));
    let sid_changes = sess.id.clone();
    let sid_inspect = sess.id.clone();

    let mut actions = div().flex().items_center().gap(px(6.0));
    if let Some(chip) = origin_chip(
        ("st-flight-origin", idx),
        sess.conversation_id.as_deref(),
        sess.thread_id.as_deref(),
        app,
        theme,
        cx,
    ) {
        actions = actions.child(chip);
    }
    actions = actions
        .child(
            kit::ghost_button(("st-flight-changes", idx), "Changes", theme).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.open_session_changes(&sid_changes);
                    cx.notify();
                },
            )),
        )
        .child(
            kit::ghost_button(("st-flight-inspect", idx), "Inspect", theme).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.open_session_inspector(&sid_inspect);
                    cx.notify();
                },
            )),
        );

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
        .gap(px(10.0))
        .child(
            div()
                .min_w(px(0.0))
                .flex_1()
                .flex()
                .flex_col()
                .gap(px(3.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(kit::swatch(theme::hex(status_color), px(6.0)))
                        .child(theme::label(title, 13.0, theme.ink))
                        .child(theme::micro(bot_name, 8.5, theme.fg_tertiary)),
                )
                .children(
                    sess.last_report
                        .as_ref()
                        .map(|rep| theme::body(rep.clone(), 12.0, theme.fg_secondary)),
                ),
        )
        .child(actions)
        .into_any_element()
}

fn status_shipped_card(
    app: &KawanApp,
    idx: usize,
    land: &Land,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> AnyElement {
    let sess = app.sessions_by_id.get(&land.session_id);
    let title = sess
        .map(session_display_title)
        .unwrap_or_else(|| format!("Task {}", short_id(&land.session_id)));
    let bot_name = sess
        .map(|s| format!("@{}", app.actor_name(&s.bot_id)))
        .unwrap_or_else(|| "@bot".to_string());
    let approver = land
        .approved_by
        .as_deref()
        .map(|uid| format!("Approved by {}", app.actor_name(uid)))
        .unwrap_or_else(|| "Landed".to_string());
    let report_art = sess.and_then(|s| find_report_artifact(app, s, Some(land)));
    let sid_changes = land.session_id.clone();
    let sid_inspect = land.session_id.clone();

    let mut card = div()
        .w_full()
        .relative()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.surface)
        .overflow_hidden()
        .child(kit::left_edge(theme::hex(0x284D32)))
        .child(
            div()
                .px(px(14.0))
                .py(px(10.0))
                .flex()
                .flex_col()
                .gap(px(5.0))
                .child(
                    div()
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
                                .child(theme::label(title, 13.5, theme.ink))
                                .child(kit::status_tag("LANDED", 0x284D32, theme)),
                        )
                        .child(theme::micro(
                            format!("{bot_name} · {approver}"),
                            8.5,
                            theme.fg_tertiary,
                        )),
                )
                .children(
                    sess.and_then(|s| s.last_report.as_ref())
                        .map(|rep| theme::body(rep.clone(), 12.5, theme.fg_secondary)),
                ),
        );

    if let Some(art) = report_art
        && let Some(preview) = expandable_report_block(app, art, theme)
    {
        card = card.child(preview);
    }

    let mut footer_actions = div().flex().items_center().gap(px(6.0));
    if let Some(chip) = origin_chip(
        ("st-ship-origin", idx),
        Some(&land.conversation_id),
        land.thread_id.as_deref(),
        app,
        theme,
        cx,
    ) {
        footer_actions = footer_actions.child(chip);
    }
    if let Some(art) = report_art {
        let aid = art.id.clone();
        let expanded = app.expanded_artifacts.contains(&aid);
        footer_actions = footer_actions.child(
            kit::ghost_button(
                ("st-ship-report", idx),
                if expanded {
                    "Hide report"
                } else {
                    "View report"
                },
                theme,
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.toggle_artifact_view(&aid);
                cx.notify();
            })),
        );
    }
    footer_actions = footer_actions
        .child(
            kit::ghost_button(("st-ship-changes", idx), "Changes", theme).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.open_session_changes(&sid_changes);
                    cx.notify();
                },
            )),
        )
        .child(
            kit::ghost_button(("st-ship-inspect", idx), "Inspect", theme).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.open_session_inspector(&sid_inspect);
                    cx.notify();
                },
            )),
        );

    card.child(
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
            .child(footer_actions),
    )
    .into_any_element()
}

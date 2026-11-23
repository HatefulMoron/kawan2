//! Issues surface: durable markdown issue list (#N) and PR-style Issue Room
//! with editable spec, Collaborate controls, Sync with main, Stop/Abandon, and stream.

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, FontWeight, Stateful, div, px, relative};

use crate::kit;
use crate::protocol::IssueSummary;
use crate::state::{FocusTarget, KawanApp, RightPanel};
use crate::theme::{self, Theme};
use crate::views::conversation::{
    conversation_stream_and_composer, left_rail, right_drawer, session_strip, short_status_label,
};
use crate::views::status_color_hex;

const ISSUES_MEASURE: f32 = 820.0;

pub fn render_list(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
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
                .child(main_issues_list_pane(app, theme, cx))
                .child(session_strip(app, theme, cx)),
        )
        .children((app.right_panel != RightPanel::None).then(|| right_drawer(app, theme, cx)))
}

pub fn render_detail(
    app: &KawanApp,
    issue_id: &str,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
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
                .child(main_issue_detail_pane(app, issue_id, theme, cx))
                .child(session_strip(app, theme, cx)),
        )
        .children((app.right_panel != RightPanel::None).then(|| right_drawer(app, theme, cx)))
}

fn main_issues_list_pane(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let mut all: Vec<&IssueSummary> = app.issues_by_id.values().collect();
    all.sort_by_key(|i| std::cmp::Reverse(i.number));

    let open_count = all
        .iter()
        .filter(|i| i.status != "landed" && i.status != "closed")
        .count();

    let filtered: Vec<&IssueSummary> = all
        .into_iter()
        .filter(|i| match app.issue_filter.as_str() {
            "active" => matches!(
                i.status.as_str(),
                "implementing" | "verifying" | "reviewing" | "queued"
            ),
            "needs_input" => i.status == "needs_input",
            "backlog" => i.status == "backlog",
            "ready_to_land" => i.status == "ready_to_land",
            "shipped" => matches!(i.status.as_str(), "landed" | "closed"),
            _ => true,
        })
        .collect();

    let is_board = app.issue_view_mode == "board";

    let top_bar =
        kit::strip_bar(theme)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .child(theme::micro("ISSUES", 9.5, theme.ink))
                    .child(theme::numeric(
                        format!("{open_count} open"),
                        10.5,
                        theme.fg_tertiary,
                    ))
                    .child(
                        div()
                            .ml(px(6.0))
                            .flex()
                            .items_center()
                            .gap(px(3.0))
                            .child(
                                view_mode_pill("issues-view-list", "List", !is_board, theme)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.issue_view_mode = "list".to_string();
                                        cx.notify();
                                    })),
                            )
                            .child(
                                view_mode_pill("issues-view-board", "Board", is_board, theme)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.issue_view_mode = "board".to_string();
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        kit::ghost_button("issues-refresh", "Refresh", theme).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.open_issues();
                                cx.notify();
                            }),
                        ),
                    )
                    .child(
                        kit::small_primary_button("issues-new-toggle", "+ New Issue", theme)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.show_new_issue_form = !this.show_new_issue_form;
                                if this.show_new_issue_form {
                                    this.focus_target = FocusTarget::IssueTitle;
                                    window.focus(&this.focus_handle, cx);
                                }
                                cx.notify();
                            })),
                    ),
            );

    let filters = [
        ("all", "All"),
        ("active", "Active"),
        ("needs_input", "Needs Input"),
        ("ready_to_land", "Ready to Land"),
        ("backlog", "Backlog"),
        ("shipped", "Shipped"),
    ];

    let filter_bar = div()
        .flex()
        .items_center()
        .flex_wrap()
        .gap(px(6.0))
        .children(filters.into_iter().enumerate().map(|(fi, (key, label))| {
            let active = app.issue_filter == key;
            let k = key.to_string();
            div()
                .id(("issues-filter", fi))
                .h(px(24.0))
                .px(px(9.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(if active {
                    theme.ink
                } else {
                    theme.border_subtle
                })
                .bg(if active { theme.ink } else { theme.strip })
                .flex()
                .items_center()
                .cursor_pointer()
                .child(theme::micro(
                    label,
                    8.5,
                    if active {
                        theme::hex(0xFFFFFF)
                    } else {
                        theme.fg_secondary
                    },
                ))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.issue_filter = k.clone();
                    cx.notify();
                }))
        }));

    let mut inner = div()
        .w(relative(1.0))
        .max_w(px(if is_board { 1140.0 } else { ISSUES_MEASURE }))
        .px(px(28.0))
        .py(px(22.0))
        .flex()
        .flex_col()
        .gap(px(16.0))
        .child(
            div()
                .pb(px(12.0))
                .border_b_1()
                .border_color(theme.border)
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(theme::title("Issues", 26.0, theme.ink))
                .child(theme::body(
                    if is_board {
                        "Active pipeline board — Backlog and Shipped issues stay in List."
                    } else {
                        "Durable markdown specs, collaborative implementation rooms, and review readiness."
                    },
                    13.0,
                    theme.fg_secondary,
                )),
        );

    if !is_board {
        inner = inner.child(filter_bar);
    }

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

    if app.show_new_issue_form {
        inner = inner.child(new_issue_form_card(app, theme, cx));
    }

    if is_board {
        let all_issues: Vec<&IssueSummary> = {
            let mut v: Vec<&IssueSummary> = app.issues_by_id.values().collect();
            v.sort_by_key(|i| std::cmp::Reverse(i.number));
            v
        };
        inner = inner.child(issues_board_view(app, all_issues, theme, cx));
    } else {
        let groups: [(&str, u32, &[&str]); 5] = [
            ("NEEDS INPUT", theme::CATEGORY_VALS, &["needs_input"]),
            (
                "IN PROGRESS",
                theme::CATEGORY_INDUSTRY,
                &["implementing", "verifying", "reviewing", "queued"],
            ),
            (
                "READY TO LAND",
                theme::CATEGORY_ACADEMIC,
                &["ready_to_land"],
            ),
            ("BACKLOG", theme::UMBER_VIVID, &["backlog"]),
            ("SHIPPED & CLOSED", 0x284D32, &["landed", "closed"]),
        ];

        let mut any_rendered = false;
        for (heading, accent, statuses) in groups {
            let items: Vec<&IssueSummary> = filtered
                .iter()
                .copied()
                .filter(|i| statuses.contains(&i.status.as_str()))
                .collect();
            if items.is_empty() {
                continue;
            }
            any_rendered = true;
            inner = inner.child(issue_group_section(app, heading, accent, items, theme, cx));
        }

        if !any_rendered {
            inner = inner.child(
                div()
                    .p(px(16.0))
                    .rounded(px(2.0))
                    .border_1()
                    .border_color(theme.border_subtle)
                    .bg(theme.strip)
                    .child(theme::body(
                        "No issues match this filter yet. Click '+ New Issue' or promote an ad-hoc task.",
                        12.5,
                        theme.fg_tertiary,
                    )),
            );
        }
    }

    let body = div()
        .id("issues-list-scroll")
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

fn new_issue_form_card(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    div()
        .w_full()
        .p(px(14.0))
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.strip)
        .flex()
        .flex_col()
        .gap(px(10.0))
        .child(theme::micro("NEW MARKDOWN ISSUE", 9.0, theme.dark))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(theme::micro("TITLE", 8.5, theme.fg_tertiary))
                .child(
                    kit::text_input_box(
                        "new-issue-title",
                        &app.new_issue_title,
                        "Short issue title (e.g. Add Redis caching layer)",
                        app.focus_target == FocusTarget::IssueTitle,
                        false,
                        theme,
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.focus_target = FocusTarget::IssueTitle;
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    })),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(theme::micro(
                    "SPECIFICATION (MARKDOWN, SHIFT+ENTER NEWLINE)",
                    8.5,
                    theme.fg_tertiary,
                ))
                .child(
                    div()
                        .id("new-issue-body")
                        .w_full()
                        .min_h(px(74.0))
                        .p(px(10.0))
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(if app.focus_target == FocusTarget::IssueBody {
                            theme.vivid
                        } else {
                            theme.border
                        })
                        .bg(theme.surface)
                        .cursor_text()
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.focus_target = FocusTarget::IssueBody;
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }))
                        .child(if app.new_issue_body.is_empty() {
                            theme::body(
                                "Context, acceptance criteria, constraints...",
                                12.5,
                                theme::with_alpha(theme.palette.dark, 0.45),
                            )
                        } else {
                            div()
                                .w_full()
                                .min_w(px(0.0))
                                .font_family(theme::MONO)
                                .text_size(px(11.5))
                                .line_height(px(16.0))
                                .text_color(theme.ink)
                                .child(app.new_issue_body.clone())
                        }),
                ),
        )
        .child(
            div()
                .flex()
                .items_center()
                .justify_end()
                .gap(px(8.0))
                .child(
                    kit::ghost_button("new-issue-cancel", "Cancel", theme).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.show_new_issue_form = false;
                            cx.notify();
                        },
                    )),
                )
                .child(
                    kit::small_primary_button("new-issue-submit", "Create Issue", theme).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.create_issue();
                            cx.notify();
                        }),
                    ),
                ),
        )
}

fn issue_group_section(
    app: &KawanApp,
    heading: &str,
    accent: u32,
    items: Vec<&IssueSummary>,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(kit::swatch(theme::hex(accent), px(6.0)))
                .child(theme::micro(
                    format!("{heading} · {}", items.len()),
                    9.5,
                    theme.dark,
                )),
        )
        .child(
            div()
                .w_full()
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.surface)
                .overflow_hidden()
                .flex()
                .flex_col()
                .children(items.into_iter().map(|issue| {
                    let iid = issue.id.clone();
                    let status_color = status_color_hex(&issue.status);
                    let unread = app
                        .conversations
                        .iter()
                        .find(|c| c.id == issue.conversation_id)
                        .map_or(0, |c| c.unread_count);
                    let impl_label = issue
                        .implementer_bot_id
                        .as_deref()
                        .map(|bid| format!("@{}", app.actor_name(bid)))
                        .unwrap_or_else(|| "Unassigned".to_string());
                    let behind = issue.behind_main;

                    div()
                        .id(("issue-row", issue.number as usize))
                        .px(px(14.0))
                        .py(px(10.0))
                        .border_b_1()
                        .border_color(theme.border_subtle)
                        .hover(|s| s.bg(theme.hover))
                        .cursor_pointer()
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
                                .child(kit::swatch(theme::hex(status_color), px(6.0)))
                                .child(theme::numeric(
                                    format!("#{}", issue.number),
                                    11.0,
                                    theme.fg_tertiary,
                                ))
                                .child(theme::label(issue.title.clone(), 13.0, theme.ink))
                                .child(kit::status_tag(
                                    short_status_label(&issue.status).to_uppercase(),
                                    status_color,
                                    theme,
                                ))
                                .children((behind > 0).then(|| {
                                    kit::status_tag(
                                        format!("{behind} BEHIND MAIN"),
                                        theme::UMBER_VIVID,
                                        theme,
                                    )
                                })),
                        )
                        .child(
                            div()
                                .flex_none()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .children((unread > 0).then(|| kit::swatch(theme.vivid, px(5.0))))
                                .child(theme::micro(impl_label, 8.5, theme.fg_tertiary)),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_issue(&iid);
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }))
                })),
        )
}

fn view_mode_pill(
    id: &'static str,
    label: &'static str,
    active: bool,
    theme: &Theme,
) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(22.0))
        .px(px(8.0))
        .rounded(px(2.0))
        .border_1()
        .border_color(if active {
            theme.ink
        } else {
            theme.border_subtle
        })
        .bg(if active { theme.ink } else { theme.strip })
        .flex()
        .items_center()
        .cursor_pointer()
        .child(theme::micro(
            label,
            8.0,
            if active {
                theme::hex(0xFFFFFF)
            } else {
                theme.fg_secondary
            },
        ))
}

fn issues_board_view(
    app: &KawanApp,
    all: Vec<&IssueSummary>,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let columns: [(&str, u32, &[&str]); 4] = [
        (
            "IMPLEMENTING",
            theme::CATEGORY_INDUSTRY,
            &["implementing", "verifying"],
        ),
        ("REVIEWING", theme::CATEGORY_ACADEMIC, &["reviewing"]),
        ("NEEDS INPUT", theme::CATEGORY_VALS, &["needs_input"]),
        ("READY TO LAND", 0x284D32, &["ready_to_land"]),
    ];

    div()
        .w_full()
        .flex()
        .items_start()
        .gap(px(12.0))
        .children(
            columns
                .into_iter()
                .enumerate()
                .map(|(ci, (title, accent, statuses))| {
                    let col_items: Vec<&IssueSummary> = all
                        .iter()
                        .copied()
                        .filter(|i| statuses.contains(&i.status.as_str()))
                        .collect();
                    div()
                        .id(("board-col", ci))
                        .flex_1()
                        .min_w(px(0.0))
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
                                .pb(px(6.0))
                                .border_b_1()
                                .border_color(theme.border_subtle)
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.0))
                                        .child(kit::swatch(theme::hex(accent), px(6.0)))
                                        .child(theme::micro(title, 9.0, theme.dark)),
                                )
                                .child(theme::numeric(
                                    col_items.len().to_string(),
                                    10.0,
                                    theme.fg_tertiary,
                                )),
                        )
                        .children((col_items.is_empty()).then(|| {
                            div()
                                .py(px(12.0))
                                .child(theme::micro("NONE", 8.0, theme.fg_tertiary))
                        }))
                        .children(col_items.into_iter().map(|issue| {
                            let iid = issue.id.clone();
                            let unread = app
                                .conversations
                                .iter()
                                .find(|c| c.id == issue.conversation_id)
                                .is_some_and(|c| c.unread_count > 0);
                            let impl_lbl = issue
                                .implementer_bot_id
                                .as_deref()
                                .map(|bid| format!("@{}", app.actor_name(bid)))
                                .unwrap_or_else(|| "Unassigned".to_string());
                            let total_rev = issue.reviewers.len();
                            let approved_rev = if total_rev > 0 && !issue.reviews.is_empty() {
                                let target_round = issue
                                    .reviews
                                    .iter()
                                    .map(|r| r.round)
                                    .max()
                                    .unwrap_or(issue.current_round);
                                issue
                                    .reviews
                                    .iter()
                                    .filter(|r| r.round == target_round && r.verdict == "approve")
                                    .count()
                            } else {
                                0
                            };

                            div()
                                .id(("board-card", issue.number as usize))
                                .w_full()
                                .p(px(10.0))
                                .rounded(px(2.0))
                                .border_1()
                                .border_color(theme.border)
                                .bg(theme.surface)
                                .hover(|s| s.border_color(theme.dark))
                                .cursor_pointer()
                                .flex()
                                .flex_col()
                                .gap(px(6.0))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .justify_between()
                                        .gap(px(6.0))
                                        .child(
                                            div()
                                                .flex()
                                                .items_center()
                                                .gap(px(5.0))
                                                .child(theme::numeric(
                                                    format!("#{}", issue.number),
                                                    10.5,
                                                    theme.vivid,
                                                ))
                                                .children(
                                                    unread
                                                        .then(|| kit::swatch(theme.vivid, px(5.0))),
                                                ),
                                        )
                                        .child(theme::micro(impl_lbl, 8.0, theme.fg_tertiary)),
                                )
                                .child(
                                    div()
                                        .w_full()
                                        .min_w(px(0.0))
                                        .font_family(theme::SANS)
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_size(px(12.5))
                                        .line_height(px(17.0))
                                        .text_color(theme.ink)
                                        .child(issue.title.clone()),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .flex_wrap()
                                        .gap(px(4.0))
                                        .children((issue.current_round > 0).then(|| {
                                            kit::status_tag(
                                                format!(
                                                    "R{}/{}",
                                                    issue.current_round, issue.max_rounds
                                                ),
                                                accent,
                                                theme,
                                            )
                                        }))
                                        .children((total_rev > 0).then(|| {
                                            kit::status_tag(
                                                format!("{approved_rev}/{total_rev} REV"),
                                                if approved_rev == total_rev {
                                                    0x284D32
                                                } else {
                                                    theme::CATEGORY_ACADEMIC
                                                },
                                                theme,
                                            )
                                        }))
                                        .children((issue.behind_main > 0).then(|| {
                                            kit::status_tag(
                                                format!("{} BEHIND", issue.behind_main),
                                                theme::UMBER_VIVID,
                                                theme,
                                            )
                                        })),
                                )
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.open_issue(&iid);
                                    window.focus(&this.focus_handle, cx);
                                    cx.notify();
                                }))
                        }))
                }),
        )
}

fn main_issue_detail_pane(
    app: &KawanApp,
    issue_id: &str,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    let Some(issue) = app.issues_by_id.get(issue_id) else {
        return div()
            .flex_1()
            .p(px(28.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(theme::body("Issue not found.", 13.0, theme.fg_tertiary))
            .child(
                kit::secondary_button("issue-missing-back", "← Issues", theme).on_click(
                    cx.listener(|this, _, window, cx| {
                        this.open_issues();
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    }),
                ),
            );
    };

    let status_color = status_color_hex(&issue.status);
    let owner_name = app.actor_name(&issue.owner_id);
    let impl_name = issue
        .implementer_bot_id
        .as_deref()
        .map(|bid| format!("@{}", app.actor_name(bid)))
        .unwrap_or_else(|| "Unassigned".to_string());
    let active_sess = issue
        .active_session_id
        .as_deref()
        .and_then(|sid| app.sessions_by_id.get(sid));
    let worker_running = active_sess.is_some_and(|s| s.status == "running");
    let matching_land = issue
        .active_session_id
        .as_deref()
        .and_then(|sid| app.land_for_session(sid));

    let is_editing = app.editing_issue_id.as_deref() == Some(issue.id.as_str());
    let is_expanded = app.expanded_issue_specs.contains(&issue.id);

    let iid_edit = issue.id.clone();
    let iid_save = issue.id.clone();
    let iid_expand = issue.id.clone();
    let iid_cfg = issue.id.clone();
    let iid_assign_run = issue.id.clone();
    let iid_save_cfg = issue.id.clone();
    let iid_sync = issue.id.clone();
    let iid_review = issue.id.clone();
    let iid_return = issue.id.clone();
    let iid_stop = issue.id.clone();
    let iid_close = issue.id.clone();
    let iid_abandon = issue.id.clone();

    let spec_lines: Vec<&str> = issue.body_md.lines().collect();
    let spec_preview = if is_expanded || spec_lines.len() <= 4 {
        issue.body_md.clone()
    } else {
        format!("{}\n…", spec_lines[..4].join("\n"))
    };

    let mut header_inner = div()
        .w(relative(1.0))
        .max_w(px(780.0))
        .px(px(24.0))
        .pt(px(12.0))
        .pb(px(10.0))
        .border_b_1()
        .border_color(theme.border)
        .flex()
        .flex_col()
        .gap(px(8.0))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .flex_wrap()
                .gap(px(10.0))
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex_1()
                        .flex()
                        .items_center()
                        .flex_wrap()
                        .gap(px(8.0))
                        .child(
                            kit::ghost_button("issue-back-btn", "← Issues", theme).on_click(
                                cx.listener(|this, _, window, cx| {
                                    this.open_issues();
                                    window.focus(&this.focus_handle, cx);
                                    cx.notify();
                                }),
                            ),
                        )
                        .child(theme::numeric(
                            format!("#{}", issue.number),
                            13.0,
                            theme.fg_tertiary,
                        ))
                        .child(theme::title(issue.title.clone(), 20.0, theme.ink))
                        .child(kit::status_tag(
                            short_status_label(&issue.status).to_uppercase(),
                            status_color,
                            theme,
                        ))
                        .children((issue.behind_main > 0).then(|| {
                            kit::status_tag(
                                format!("{} BEHIND MAIN", issue.behind_main),
                                theme::UMBER_VIVID,
                                theme,
                            )
                        })),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .child(theme::micro(
                            format!("OWNER: {owner_name}"),
                            8.5,
                            theme.fg_tertiary,
                        ))
                        .child(theme::micro(
                            format!("IMPL: {impl_name}"),
                            8.5,
                            theme.fg_tertiary,
                        )),
                ),
        );

    if is_editing {
        header_inner = header_inner.child(
            div()
                .p(px(10.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.strip)
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    kit::text_input_box(
                        "edit-issue-title",
                        &app.edit_issue_title,
                        "Issue title",
                        app.focus_target == FocusTarget::IssueEditTitle,
                        false,
                        theme,
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.focus_target = FocusTarget::IssueEditTitle;
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    })),
                )
                .child(
                    div()
                        .id("edit-issue-body")
                        .w_full()
                        .min_h(px(64.0))
                        .p(px(8.0))
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(if app.focus_target == FocusTarget::IssueEditBody {
                            theme.vivid
                        } else {
                            theme.border
                        })
                        .bg(theme.surface)
                        .cursor_text()
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.focus_target = FocusTarget::IssueEditBody;
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }))
                        .child(
                            div()
                                .w_full()
                                .min_w(px(0.0))
                                .font_family(theme::MONO)
                                .text_size(px(11.5))
                                .line_height(px(16.0))
                                .text_color(theme.ink)
                                .child(if app.edit_issue_body.is_empty() {
                                    " ".to_string()
                                } else {
                                    app.edit_issue_body.clone()
                                }),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_end()
                        .gap(px(6.0))
                        .child(
                            kit::ghost_button("edit-issue-cancel", "Cancel", theme).on_click(
                                cx.listener(|this, _, _, cx| {
                                    this.editing_issue_id = None;
                                    cx.notify();
                                }),
                            ),
                        )
                        .child(
                            kit::small_primary_button("edit-issue-save", "Save Spec", theme)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.save_edit_issue(&iid_save);
                                    cx.notify();
                                })),
                        ),
                ),
        );
    } else {
        header_inner = header_inner.child(
            div()
                .p(px(10.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.strip)
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(theme::micro("MARKDOWN SPEC", 8.5, theme.fg_tertiary))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .children((spec_lines.len() > 4).then(|| {
                                    kit::ghost_button(
                                        "issue-spec-expand",
                                        if is_expanded {
                                            "Collapse"
                                        } else {
                                            "Expand spec"
                                        },
                                        theme,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            if !this.expanded_issue_specs.remove(&iid_expand) {
                                                this.expanded_issue_specs
                                                    .insert(iid_expand.clone());
                                            }
                                            cx.notify();
                                        },
                                    ))
                                }))
                                .child(
                                    kit::ghost_button("issue-spec-edit", "Edit Spec", theme)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.begin_edit_issue(&iid_edit);
                                            window.focus(&this.focus_handle, cx);
                                            cx.notify();
                                        })),
                                ),
                        ),
                )
                .child(if issue.body_md.trim().is_empty() {
                    theme::body(
                        "No specification written yet — click 'Edit Spec' or collaborate below.",
                        12.0,
                        theme.fg_tertiary,
                    )
                } else {
                    div()
                        .w_full()
                        .min_w(px(0.0))
                        .font_family(theme::SANS)
                        .text_size(px(12.5))
                        .line_height(px(17.5))
                        .text_color(theme.fg_secondary)
                        .child(spec_preview)
                }),
        );
    }

    if !issue.reviewers.is_empty()
        || !issue.reviews.is_empty()
        || issue.auto_start_review
        || issue.landing_mode == "auto"
    {
        let target_round = issue
            .reviews
            .iter()
            .map(|r| r.round)
            .max()
            .unwrap_or(issue.current_round);
        let round_chip = if issue.current_round > 0 {
            format!("ROUND {}/{}", issue.current_round, issue.max_rounds)
        } else {
            format!("MAX {} ROUNDS", issue.max_rounds)
        };
        header_inner = header_inner.child(
            div()
                .px(px(10.0))
                .py(px(6.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.strip)
                .flex()
                .items_center()
                .flex_wrap()
                .gap(px(8.0))
                .child(theme::micro(round_chip, 8.5, theme.dark))
                .children(
                    issue
                        .auto_start_review
                        .then(|| kit::status_tag("AUTO REVIEW", theme::CATEGORY_ACADEMIC, theme)),
                )
                .children(
                    (issue.landing_mode == "auto")
                        .then(|| kit::status_tag("AUTO LAND", 0x284D32, theme)),
                )
                .children(issue.reviewers.iter().map(|rev| {
                    let bot_name = app.actor_name(&rev.bot_id);
                    let focus_part = rev
                        .focus
                        .as_deref()
                        .filter(|s| !s.trim().is_empty())
                        .map(|f| format!(" · {f}"))
                        .unwrap_or_default();
                    let verdict_opt = issue
                        .reviews
                        .iter()
                        .rfind(|r| r.reviewer_slot_id == rev.id && r.round == target_round)
                        .or_else(|| issue.reviews.iter().rfind(|r| r.reviewer_slot_id == rev.id));
                    let (v_lbl, v_col) = match verdict_opt.map(|r| r.verdict.as_str()) {
                        Some("approve") => ("APPROVED", 0x284D32),
                        Some("request_changes" | "changes_requested") => {
                            ("CHANGES", theme::CATEGORY_VALS)
                        }
                        Some("needs_owner") => ("NEEDS OWNER", theme::CATEGORY_VALS),
                        _ => ("PENDING", theme::CATEGORY_ACADEMIC),
                    };
                    div()
                        .px(px(6.0))
                        .py(px(2.0))
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(theme.border_subtle)
                        .bg(theme.surface)
                        .flex()
                        .items_center()
                        .gap(px(5.0))
                        .child(theme::micro(
                            format!("@{bot_name}{focus_part}"),
                            8.0,
                            theme.ink,
                        ))
                        .child(kit::status_tag(v_lbl, v_col, theme))
                })),
        );
    }

    if matching_land.is_some_and(|l| l.touches_kawan) {
        header_inner = header_inner.child(
            div()
                .relative()
                .overflow_hidden()
                .px(px(10.0))
                .py(px(7.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme::with_alpha(theme::CATEGORY_VALS, 0.45))
                .bg(theme::with_alpha(theme::CATEGORY_VALS, 0.06))
                .child(kit::left_edge(theme::hex(theme::CATEGORY_VALS)))
                .child(
                    div()
                        .pl(px(6.0))
                        .flex()
                        .items_center()
                        .justify_between()
                        .flex_wrap()
                        .gap(px(8.0))
                        .child(theme::micro(
                            "MODIFIES .KAWAN/ CHECKS",
                            8.5,
                            theme::hex(theme::CATEGORY_VALS),
                        ))
                        .child(theme::body(
                            "Auto-land disabled for check changes; explicit human approval required.",
                            12.0,
                            theme.ink,
                        )),
                ),
        );
    }

    if issue.status == "needs_input"
        && let Some(q) = &issue.needs_input_question
    {
        header_inner = header_inner.child(
            div()
                .relative()
                .overflow_hidden()
                .p(px(10.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme::with_alpha(theme::CATEGORY_VALS, 0.45))
                .bg(theme::with_alpha(theme::CATEGORY_VALS, 0.06))
                .child(kit::left_edge(theme::hex(theme::CATEGORY_VALS)))
                .child(
                    div()
                        .pl(px(6.0))
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(theme::micro(
                            format!("NEEDS INPUT · @{owner_name}"),
                            8.5,
                            theme::hex(theme::CATEGORY_VALS),
                        ))
                        .child(theme::body(q.clone(), 12.5, theme.ink))
                        .child(theme::micro(
                            "Reply in the stream below to resume implementation.",
                            8.5,
                            theme.fg_tertiary,
                        )),
                ),
        );
    }

    if app.show_assign_panel {
        let selected_bot = app
            .assign_bot_id
            .clone()
            .or_else(|| issue.implementer_bot_id.clone())
            .or_else(|| app.bots.first().map(|b| b.id.clone()));
        let selected_rev_bot = app
            .assign_reviewer_bot_id
            .clone()
            .or_else(|| app.bots.first().map(|b| b.id.clone()));
        let is_backlog = issue.status == "backlog";

        header_inner = header_inner.child(
            div()
                .p(px(10.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.strip)
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(theme::micro(
                    if is_backlog {
                        "ASSIGN & RUN ISSUE"
                    } else {
                        "CONFIGURE REVIEW LOOP & LANDING"
                    },
                    9.0,
                    theme.dark,
                ))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .flex_wrap()
                        .gap(px(6.0))
                        .child(theme::micro("Implementer:", 9.0, theme.fg_tertiary))
                        .children(app.bots.iter().enumerate().map(|(bi, b)| {
                            let bid = b.id.clone();
                            let active = selected_bot.as_deref() == Some(bid.as_str());
                            div()
                                .id(("assign-bot", bi))
                                .h(px(24.0))
                                .px(px(8.0))
                                .rounded(px(2.0))
                                .border_1()
                                .border_color(if active {
                                    theme.ink
                                } else {
                                    theme.border_subtle
                                })
                                .bg(if active { theme.ink } else { theme.surface })
                                .flex()
                                .items_center()
                                .cursor_pointer()
                                .child(theme::micro(
                                    format!("@{}", b.name),
                                    8.5,
                                    if active {
                                        theme::hex(0xFFFFFF)
                                    } else {
                                        theme.ink
                                    },
                                ))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.assign_bot_id = Some(bid.clone());
                                    cx.notify();
                                }))
                        })),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .flex_wrap()
                        .gap(px(6.0))
                        .child(theme::micro("Reviewers:", 9.0, theme.fg_tertiary))
                        .children(app.assign_reviewers.iter().enumerate().map(
                            |(ri, (bid, focus))| {
                                let bname = app.actor_name(bid);
                                let label = if focus.trim().is_empty() {
                                    format!("@{bname}")
                                } else {
                                    format!("@{bname} · {}", focus.trim())
                                };
                                div()
                                    .h(px(24.0))
                                    .px(px(6.0))
                                    .rounded(px(2.0))
                                    .border_1()
                                    .border_color(theme.border_subtle)
                                    .bg(theme.surface)
                                    .flex()
                                    .items_center()
                                    .gap(px(4.0))
                                    .child(theme::micro(label, 8.5, theme.ink))
                                    .child(
                                        kit::ghost_button(("assign-rev-rm", ri), "×", theme)
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.remove_assign_reviewer(ri);
                                                cx.notify();
                                            })),
                                    )
                            },
                        ))
                        .children(app.assign_reviewers.is_empty().then(|| {
                            theme::micro("0 reviewers (checks only)", 8.5, theme.fg_tertiary)
                        })),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .flex_wrap()
                        .gap(px(6.0))
                        .children(app.bots.iter().enumerate().map(|(bi, b)| {
                            let bid = b.id.clone();
                            let active = selected_rev_bot.as_deref() == Some(bid.as_str());
                            div()
                                .id(("assign-rev-bot", bi))
                                .h(px(22.0))
                                .px(px(7.0))
                                .rounded(px(2.0))
                                .border_1()
                                .border_color(if active {
                                    theme.ink
                                } else {
                                    theme.border_subtle
                                })
                                .bg(if active { theme.ink } else { theme.surface })
                                .flex()
                                .items_center()
                                .cursor_pointer()
                                .child(theme::micro(
                                    format!("+ @{}:", b.name),
                                    8.0,
                                    if active {
                                        theme::hex(0xFFFFFF)
                                    } else {
                                        theme.fg_secondary
                                    },
                                ))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.assign_reviewer_bot_id = Some(bid.clone());
                                    cx.notify();
                                }))
                        }))
                        .child(
                            div().flex_1().min_w(px(220.0)).overflow_hidden().child(
                                kit::text_input_box(
                                    "assign-rev-focus",
                                    &app.assign_reviewer_focus,
                                    "Optional review focus (e.g. Security)",
                                    app.focus_target == FocusTarget::AssignReviewerFocus,
                                    false,
                                    theme,
                                )
                                .on_click(cx.listener(
                                    |this, _, window, cx| {
                                        this.focus_target = FocusTarget::AssignReviewerFocus;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    },
                                )),
                            ),
                        )
                        .child(
                            kit::secondary_button("assign-rev-add", "+ Add Reviewer", theme)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.add_assign_reviewer();
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .flex_wrap()
                        .gap(px(8.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .flex_wrap()
                                .gap(px(6.0))
                                .child(
                                    kit::ghost_button(
                                        "assign-auto-review-toggle",
                                        if app.assign_auto_review {
                                            "Mode: Autonomous (auto-review)"
                                        } else {
                                            "Mode: Interactive"
                                        },
                                        theme,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            this.assign_auto_review = !this.assign_auto_review;
                                            cx.notify();
                                        },
                                    )),
                                )
                                .child(
                                    kit::ghost_button(
                                        "assign-landing-toggle",
                                        format!("Landing: {}", app.assign_landing_mode),
                                        theme,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            this.assign_landing_mode =
                                                if this.assign_landing_mode == "auto" {
                                                    "manual".to_string()
                                                } else {
                                                    "auto".to_string()
                                                };
                                            cx.notify();
                                        },
                                    )),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(4.0))
                                        .child(
                                            kit::ghost_button("assign-rounds-dec", "-", theme)
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.assign_max_rounds = this
                                                        .assign_max_rounds
                                                        .saturating_sub(1)
                                                        .max(1);
                                                    cx.notify();
                                                })),
                                        )
                                        .child(theme::micro(
                                            format!("Max rounds: {}", app.assign_max_rounds.max(1)),
                                            8.5,
                                            theme.ink,
                                        ))
                                        .child(
                                            kit::ghost_button("assign-rounds-inc", "+", theme)
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.assign_max_rounds =
                                                        (this.assign_max_rounds + 1).min(8);
                                                    cx.notify();
                                                })),
                                        ),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .child(
                                    kit::ghost_button("assign-cancel", "Cancel", theme).on_click(
                                        cx.listener(|this, _, _, cx| {
                                            this.show_assign_panel = false;
                                            cx.notify();
                                        }),
                                    ),
                                )
                                .child(if is_backlog {
                                    kit::small_primary_button("assign-submit", "Run Issue", theme)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.assign_and_run_issue(&iid_assign_run);
                                            cx.notify();
                                        }))
                                        .into_any_element()
                                } else {
                                    kit::small_primary_button(
                                        "assign-save-cfg",
                                        "Save Config",
                                        theme,
                                    )
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.save_issue_loop_config(&iid_save_cfg);
                                        cx.notify();
                                    }))
                                    .into_any_element()
                                }),
                        ),
                ),
        );
    }

    // Action bar (sibling buttons based on current issue status)
    let mut actions: Vec<AnyElement> = Vec::new();
    match issue.status.as_str() {
        "backlog" => {
            let iid_open = iid_cfg.clone();
            actions.push(
                kit::small_primary_button("iss-act-assign", "Assign & Run", theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_assign_panel_for_issue(&iid_open);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
            actions.push(
                kit::ghost_button("iss-act-close", "Close", theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.close_issue(&iid_close, false);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        }
        "implementing" => {
            actions.push(
                kit::small_primary_button("iss-act-review", "Start Review Cycle", theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.start_issue_review(&iid_review);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
            let sync_lbl = if issue.behind_main > 0 {
                format!("Sync with main ({})", issue.behind_main)
            } else {
                "Sync with main".to_string()
            };
            actions.push(
                kit::secondary_button("iss-act-sync", sync_lbl, theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.sync_issue_with_main(&iid_sync);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
            actions.push(
                kit::ghost_button("iss-act-configure", "Configure", theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_assign_panel_for_issue(&iid_cfg);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
            if worker_running {
                actions.push(
                    kit::ghost_button("iss-act-stop", "Stop", theme)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.stop_issue(&iid_stop);
                            cx.notify();
                        }))
                        .into_any_element(),
                );
            }
            actions.push(
                kit::ghost_button("iss-act-abandon", "Abandon", theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.close_issue(&iid_abandon, true);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        }
        "verifying" | "reviewing" => {
            actions.push(
                kit::secondary_button("iss-act-collab", "Return to Collaborate", theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.return_issue_to_collaborate(&iid_return);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
            if worker_running {
                actions.push(
                    kit::ghost_button("iss-act-stop", "Stop", theme)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.stop_issue(&iid_stop);
                            cx.notify();
                        }))
                        .into_any_element(),
                );
            }
        }
        "needs_input" => {
            actions.push(
                kit::secondary_button("iss-act-collab", "Return to Collaborate", theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.return_issue_to_collaborate(&iid_return);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        }
        "ready_to_land" => {
            if let Some(l) = matching_land
                && (l.status == "requested" || l.status == "failed")
            {
                let lid = l.id.clone();
                actions.push(
                    kit::small_primary_button("iss-act-approve", "Approve Land", theme)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.approve_land(&lid);
                            cx.notify();
                        }))
                        .into_any_element(),
                );
            }
            actions.push(
                kit::secondary_button("iss-act-collab", "Return to Collaborate", theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.return_issue_to_collaborate(&iid_return);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        }
        "queued" => {
            actions.push(
                kit::small_primary_button("iss-act-mq", "Open in Merge Queue →", theme)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_merge_queue();
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        }
        _ => {}
    }

    if let Some(sess) = active_sess {
        let sid_c = sess.id.clone();
        let sid_i = sess.id.clone();
        actions.push(
            kit::ghost_button("iss-act-changes", "Changes", theme)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_session_changes(&sid_c);
                    cx.notify();
                }))
                .into_any_element(),
        );
        actions.push(
            kit::ghost_button("iss-act-inspect", "Inspect", theme)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_session_inspector(&sid_i);
                    cx.notify();
                }))
                .into_any_element(),
        );
    }

    if !actions.is_empty() {
        header_inner = header_inner.child(
            div()
                .flex()
                .items_center()
                .flex_wrap()
                .gap(px(6.0))
                .children(actions),
        );
    }

    let header = div()
        .w_full()
        .flex_none()
        .bg(theme.surface)
        .flex()
        .justify_center()
        .child(header_inner);

    let (stream, composer) = conversation_stream_and_composer(
        app,
        &issue.conversation_id,
        &format!("#{}", issue.number),
        true,
        "Discuss specs, review artifacts, or steer the implementer here.",
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

//! Issues surface: chat-first issue rooms (#N) anchored by a central editable Markdown
//! document, one writable branch owner, read-only reviewers, implicit checks, and direct
//! **Propose** into the Merge Queue.

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, div, px, relative};

use crate::kit;
use crate::protocol::{IssueSummary, Land, SessionSummary};
use crate::state::{FocusTarget, KawanApp, RightPanel};
use crate::theme::{self, Theme};
use crate::views::conversation::{
    StreamOptions, conversation_stream_and_composer, left_rail, right_drawer, session_strip,
    short_status_label, truncate_chars,
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

fn check_pill_spec(status: &str) -> Option<(&'static str, u32)> {
    match status {
        "passed" => Some(("CHECKS ✓", 0x284D32)),
        "failed" => Some(("CHECKS ✗", theme::CATEGORY_VALS)),
        "running" => Some(("CHECKS…", theme::CATEGORY_INDUSTRY)),
        _ => None,
    }
}

/// The land that currently represents an issue: an open proposal or train item
/// filed against the issue wins over a stale `active_session_id` lookup.
fn issue_land<'a>(app: &'a KawanApp, issue: &IssueSummary) -> Option<&'a Land> {
    const OPEN: [&str; 5] = ["proposed", "queued", "rebasing", "verifying", "paused"];
    let by_issue = app
        .lands_by_id
        .values()
        .filter(|l| {
            l.issue_id.as_deref() == Some(issue.id.as_str()) && OPEN.contains(&l.status.as_str())
        })
        .max_by_key(|l| l.updated_at);
    by_issue.or_else(|| {
        issue
            .active_session_id
            .as_deref()
            .and_then(|sid| app.land_for_session(sid))
    })
}

fn issue_row_badges(
    app: &KawanApp,
    issue: &IssueSummary,
    active_sess: Option<&SessionSummary>,
    active_land: Option<&Land>,
) -> Vec<(String, u32)> {
    let mut tags: Vec<(String, u32)> = Vec::new();

    if issue.status == "landed" {
        tags.push(("LANDED".to_string(), 0x284D32));
        return tags;
    }
    if issue.status == "closed" {
        tags.push(("CLOSED".to_string(), theme::UMBER_VIVID));
        return tags;
    }

    if let Some(rev) = issue.active_reviewers.first() {
        let more = issue.active_reviewers.len().saturating_sub(1);
        let lbl = if more > 0 {
            format!("@{} +{} REVIEWING", rev.bot_name, more)
        } else {
            format!("@{} REVIEWING", rev.bot_name)
        };
        tags.push((lbl, theme::CATEGORY_ACADEMIC));
    }

    if let Some(land) = active_land
        && matches!(
            land.status.as_str(),
            "proposed" | "queued" | "rebasing" | "verifying" | "paused"
        )
    {
        let (lbl, col) = if land.status == "proposed" {
            ("PROPOSED".to_string(), theme::CATEGORY_ACADEMIC)
        } else if land.status == "paused" {
            ("PAUSED IN QUEUE".to_string(), theme::CATEGORY_VALS)
        } else if let Some(pos) = land.queue_position {
            (format!("QUEUED #{pos}"), theme::CATEGORY_ACADEMIC)
        } else {
            (
                short_status_label(&land.status).to_uppercase(),
                theme::CATEGORY_ACADEMIC,
            )
        };
        tags.push((lbl, col));
    } else if active_sess.is_some_and(|s| s.status == "running") {
        let bot_lbl = issue
            .implementer_bot_id
            .as_deref()
            .map(|id| format!("@{} WORKING", app.actor_name(id)))
            .unwrap_or_else(|| "WORKING".to_string());
        tags.push((bot_lbl, theme::CATEGORY_INDUSTRY));
    } else if active_sess.is_some() {
        let c = issue.commits_ahead;
        let lbl = if c == 1 {
            "1 COMMIT".to_string()
        } else {
            format!("{c} COMMITS")
        };
        tags.push((lbl, theme::CATEGORY_ACADEMIC));
    } else {
        tags.push(("DRAFT".to_string(), theme::UMBER_VIVID));
    }

    if let Some((lbl, col)) = check_pill_spec(&issue.checks_status) {
        tags.push((lbl.to_string(), col));
    }
    if issue.needs_input_question.is_some() {
        tags.push(("NEEDS INPUT".to_string(), theme::CATEGORY_VALS));
    }
    if issue.behind_main > 0 {
        tags.push((format!("{} BEHIND", issue.behind_main), theme::UMBER_VIVID));
    }
    if issue.touches_kawan {
        tags.push(("MODIFIES .KAWAN/".to_string(), theme::CATEGORY_VALS));
    }
    tags
}

fn main_issues_list_pane(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let mut all: Vec<&IssueSummary> = app.issues_by_id.values().collect();
    all.sort_by_key(|i| std::cmp::Reverse(i.number));

    let open_count = all.iter().filter(|i| i.status == "open").count();

    let filtered: Vec<&IssueSummary> = all
        .into_iter()
        .filter(|i| match app.issue_filter.as_str() {
            "open" => i.status == "open",
            "shipped" => matches!(i.status.as_str(), "landed" | "closed"),
            _ => true,
        })
        .collect();

    let top_bar = kit::strip_bar(theme)
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
                )),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(
                    kit::ghost_button("issues-refresh", "Refresh", theme).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.open_issues();
                            cx.notify();
                        },
                    )),
                )
                .child(
                    kit::small_primary_button("issues-new-toggle", "+ New Issue", theme).on_click(
                        cx.listener(|this, _, window, cx| {
                            this.show_new_issue_form = !this.show_new_issue_form;
                            if this.show_new_issue_form {
                                this.focus_target = FocusTarget::IssueTitle;
                                window.focus(&this.focus_handle, cx);
                            }
                            cx.notify();
                        }),
                    ),
                ),
        );

    let filters = [
        ("all", "All"),
        ("open", "Open"),
        ("shipped", "Landed / Closed"),
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
        .max_w(px(ISSUES_MEASURE))
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
                    "Each issue is a room anchored by a live Markdown document. @mention bots in chat to implement or review, then propose the branch to the Merge Queue.",
                    13.0,
                    theme.fg_secondary,
                )),
        )
        .child(filter_bar);

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

    let groups: [(&str, u32, &[&str]); 2] = [
        ("OPEN", theme::CATEGORY_INDUSTRY, &["open"]),
        ("LANDED / CLOSED", 0x284D32, &["landed", "closed"]),
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
                    "MARKDOWN DOCUMENT (SHIFT+ENTER NEWLINE)",
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
    let muted_group = heading == "LANDED / CLOSED";
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
                    let active_sess = issue
                        .active_session_id
                        .as_deref()
                        .and_then(|sid| app.sessions_by_id.get(sid));
                    let active_land = issue_land(app, issue);
                    let badges = issue_row_badges(app, issue, active_sess, active_land);
                    let dot_color = badges
                        .first()
                        .map(|(_, c)| *c)
                        .unwrap_or_else(|| status_color_hex(&issue.status));
                    let unread = app
                        .conversations
                        .iter()
                        .find(|c| c.id == issue.conversation_id)
                        .map_or(0, |c| c.unread_count);
                    let branch_owner = issue
                        .implementer_bot_id
                        .as_deref()
                        .map(|bid| format!("@{}", app.actor_name(bid)))
                        .unwrap_or_else(|| "No branch".to_string());

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
                                .flex_wrap()
                                .gap(px(8.0))
                                .child(kit::swatch(theme::hex(dot_color), px(6.0)))
                                .child(theme::numeric(
                                    format!("#{}", issue.number),
                                    11.0,
                                    theme.fg_tertiary,
                                ))
                                .child(theme::label(
                                    issue.title.clone(),
                                    13.0,
                                    if muted_group {
                                        theme.fg_secondary
                                    } else {
                                        theme.ink
                                    },
                                ))
                                .children(
                                    badges
                                        .into_iter()
                                        .map(|(lbl, col)| kit::status_tag(lbl, col, theme)),
                                ),
                        )
                        .child(
                            div()
                                .flex_none()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .children((unread > 0).then(|| kit::swatch(theme.vivid, px(5.0))))
                                .child(theme::micro(branch_owner, 8.5, theme.fg_tertiary)),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_issue(&iid);
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }))
                })),
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
    let active_sess = issue
        .active_session_id
        .as_deref()
        .and_then(|sid| app.sessions_by_id.get(sid));
    let worker_running = active_sess.is_some_and(|s| s.status == "running");
    let has_active_reviewers = !issue.active_reviewers.is_empty();
    let matching_land = issue_land(app, issue);
    let is_queued_now = matching_land.is_some_and(|l| {
        matches!(
            l.status.as_str(),
            "proposed" | "queued" | "rebasing" | "verifying" | "paused"
        )
    });

    let is_open = issue.status == "open";
    let is_editing = app.editing_issue_id.as_deref() == Some(issue.id.as_str());
    let is_collapsed = !is_editing && app.collapsed_issue_docs.contains(&issue.id);

    let iid_edit = issue.id.clone();
    let iid_save = issue.id.clone();
    let iid_toggle = issue.id.clone();
    let iid_sync = issue.id.clone();
    let iid_land = issue.id.clone();
    let iid_stop = issue.id.clone();
    let iid_close = issue.id.clone();
    let iid_abandon = issue.id.clone();

    // Row 1: Compact top header
    let row_header = div()
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
                    kit::ghost_button("iss-back", "← Issues", theme).on_click(cx.listener(
                        |this, _, window, cx| {
                            this.open_issues();
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        },
                    )),
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
                )),
        )
        .child(
            div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(theme::micro(
                    format!("Owner: @{owner_name}"),
                    8.5,
                    theme.fg_tertiary,
                ))
                .children(is_open.then(|| {
                    kit::ghost_button("iss-close", "Close", theme).on_click(cx.listener(
                        move |this, _, _, cx| {
                            this.close_issue(&iid_close, false);
                            cx.notify();
                        },
                    ))
                }))
                .children((is_open && active_sess.is_some()).then(|| {
                    kit::ghost_button("iss-abandon", "Abandon", theme).on_click(cx.listener(
                        move |this, _, _, cx| {
                            this.close_issue(&iid_abandon, true);
                            cx.notify();
                        },
                    ))
                })),
        );

    // Row 2: Single Concrete Live Branch & Activity Bar
    let mut left_status = div()
        .min_w(px(0.0))
        .flex_1()
        .flex()
        .items_center()
        .flex_wrap()
        .gap(px(8.0));

    if issue.status == "landed" {
        let sha_txt = matching_land
            .and_then(|l| l.landed_sha.as_deref())
            .map(|s| format!(" · {}", s.chars().take(8).collect::<String>()))
            .unwrap_or_default();
        left_status = left_status
            .child(kit::swatch(theme::hex(0x284D32), px(6.0)))
            .child(theme::label(format!("Landed{sha_txt}"), 12.0, theme.ink));
    } else if issue.status == "closed" {
        left_status = left_status
            .child(kit::swatch(theme::hex(theme::UMBER_VIVID), px(6.0)))
            .child(theme::label("Closed", 12.0, theme.fg_secondary));
    } else if is_queued_now && let Some(land) = matching_land {
        let queue_txt = if land.status == "proposed" {
            "Proposed · in Merge Queue".to_string()
        } else if land.status == "paused" {
            "Paused in #merge-queue".to_string()
        } else if let Some(pos) = land.queue_position {
            format!("Queued #{pos} in #merge-queue")
        } else {
            "Landing in #merge-queue…".to_string()
        };
        let qcol = if land.status == "paused" {
            theme::CATEGORY_VALS
        } else {
            theme::CATEGORY_ACADEMIC
        };
        left_status = left_status
            .child(kit::swatch(theme::hex(qcol), px(6.0)))
            .child(theme::label(queue_txt, 12.0, theme.ink));
    } else if has_active_reviewers {
        let rev_names: Vec<String> = issue
            .active_reviewers
            .iter()
            .map(|r| format!("@{}", r.bot_name))
            .collect();
        left_status = left_status
            .child(kit::swatch(theme::hex(theme::CATEGORY_ACADEMIC), px(6.0)))
            .child(theme::label(
                format!("{} reviewing…", rev_names.join(", ")),
                12.0,
                theme.ink,
            ));
    } else if let Some(sess) = active_sess {
        let bot_name = issue
            .implementer_bot_id
            .as_deref()
            .map(|bid| format!("@{}", app.actor_name(bid)))
            .unwrap_or_else(|| format!("@{}", app.actor_name(&sess.bot_id)));
        if worker_running {
            left_status = left_status
                .child(kit::swatch(theme::hex(theme::CATEGORY_INDUSTRY), px(6.0)))
                .child(theme::label(
                    format!("{bot_name} working…"),
                    12.0,
                    theme.ink,
                ));
        } else {
            let commit_lbl = if issue.commits_ahead == 1 {
                "1 commit".to_string()
            } else {
                format!("{} commits", issue.commits_ahead)
            };
            let behind_lbl = if issue.behind_main > 0 {
                format!(" · {} behind main", issue.behind_main)
            } else {
                String::new()
            };
            left_status = left_status
                .child(kit::swatch(theme::hex(0x284D32), px(6.0)))
                .child(theme::label(
                    format!("{bot_name} idle · {commit_lbl}{behind_lbl}"),
                    12.0,
                    theme.ink,
                ));
        }
    } else {
        left_status = left_status
            .child(kit::swatch(theme::hex(theme::UMBER_VIVID), px(6.0)))
            .child(theme::body(
                "No branch yet — @mention a bot below to start.",
                12.0,
                theme.fg_secondary,
            ));
    }

    if let Some((chk_lbl, chk_col)) = check_pill_spec(&issue.checks_status) {
        if let Some(aid) = &issue.checks_artifact_id {
            let aid_click = aid.clone();
            let (bg, border, text_col) = (
                theme::with_alpha(chk_col, 0.12),
                theme::with_alpha(chk_col, 0.35),
                theme::hex(chk_col),
            );
            left_status = left_status.child(
                div()
                    .id("iss-checks-btn")
                    .h(px(22.0))
                    .px(px(7.0))
                    .rounded(px(2.0))
                    .border_1()
                    .border_color(border)
                    .bg(bg)
                    .flex()
                    .items_center()
                    .cursor_pointer()
                    .hover(|s| s.opacity(0.85))
                    .child(theme::micro(chk_lbl, 8.5, text_col))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_artifact_drawer(&aid_click);
                        cx.notify();
                    })),
            );
        } else {
            left_status = left_status.child(kit::status_tag(chk_lbl, chk_col, theme));
        }
    }

    if issue.touches_kawan {
        left_status = left_status.child(kit::status_tag(
            "MODIFIES .KAWAN/",
            theme::CATEGORY_VALS,
            theme,
        ));
    }

    let mut right_actions: Vec<AnyElement> = Vec::new();
    if is_queued_now {
        right_actions.push(
            kit::small_primary_button("iss-open-mq", "Open Queue →", theme)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.open_merge_queue();
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }))
                .into_any_element(),
        );
    }
    if let Some(sess) = active_sess {
        let sid_c = sess.id.clone();
        let sid_i = sess.id.clone();
        right_actions.push(
            kit::ghost_button("iss-changes", "Changes", theme)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_session_changes(&sid_c);
                    cx.notify();
                }))
                .into_any_element(),
        );
        right_actions.push(
            kit::ghost_button("iss-inspect", "Inspect", theme)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_session_inspector(&sid_i);
                    cx.notify();
                }))
                .into_any_element(),
        );
        if is_open && !worker_running && !is_queued_now {
            let sync_lbl = if issue.behind_main > 0 {
                format!("Sync main ({})", issue.behind_main)
            } else {
                "Sync main".to_string()
            };
            right_actions.push(
                kit::secondary_button("iss-sync", sync_lbl, theme)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.sync_issue_with_main(&iid_sync);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        }
    }
    if is_open && (worker_running || has_active_reviewers) {
        right_actions.push(
            kit::ghost_button("iss-stop", "Stop", theme)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.stop_issue(&iid_stop);
                    cx.notify();
                }))
                .into_any_element(),
        );
    }
    if is_open
        && active_sess.is_some()
        && issue.commits_ahead >= 1
        && !worker_running
        && !is_queued_now
    {
        right_actions.push(
            kit::small_primary_button("iss-land", "Propose", theme)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.land_issue(&iid_land);
                    cx.notify();
                }))
                .into_any_element(),
        );
    }

    let activity_bar = div()
        .px(px(12.0))
        .py(px(8.0))
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.strip)
        .flex()
        .items_center()
        .justify_between()
        .flex_wrap()
        .gap(px(8.0))
        .child(left_status)
        .children((!right_actions.is_empty()).then(|| {
            div()
                .flex_none()
                .flex()
                .items_center()
                .flex_wrap()
                .gap(px(6.0))
                .children(right_actions)
        }));

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
        .child(row_header)
        .child(activity_bar);

    if let Some(question) = &issue.needs_input_question {
        header_inner = header_inner.child(
            div()
                .relative()
                .overflow_hidden()
                .px(px(12.0))
                .py(px(8.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme::with_alpha(theme::CATEGORY_VALS, 0.45))
                .bg(theme::with_alpha(theme::CATEGORY_VALS, 0.06))
                .flex()
                .items_center()
                .flex_wrap()
                .gap(px(8.0))
                .child(kit::left_edge(theme::hex(theme::CATEGORY_VALS)))
                .child(kit::status_tag("NEEDS INPUT", theme::CATEGORY_VALS, theme))
                .child(theme::body(
                    format!("@{owner_name}: {question}"),
                    12.0,
                    theme.ink,
                )),
        );
    }

    // Central Collapsible Markdown Document panel
    let doc_panel: Div =
        if is_editing {
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
                        .min_h(px(72.0))
                        .max_h(px(200.0))
                        .overflow_y_scroll()
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
                            kit::small_primary_button("edit-issue-save", "Save Document", theme)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.save_edit_issue(&iid_save);
                                    cx.notify();
                                })),
                        ),
                )
        } else if is_collapsed {
            let preview_snippet = issue
                .body_md
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| truncate_chars(l.trim(), 64))
                .unwrap_or_else(|| "Empty document".to_string());
            div()
                .px(px(10.0))
                .py(px(6.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.surface)
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
                        .gap(px(8.0))
                        .child(theme::micro("DOCUMENT", 8.5, theme.fg_tertiary))
                        .child(theme::body(preview_snippet, 12.0, theme.fg_tertiary)),
                )
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(kit::ghost_button("iss-doc-edit", "Edit", theme).on_click(
                            cx.listener(move |this, _, window, cx| {
                                this.begin_edit_issue(&iid_edit);
                                window.focus(&this.focus_handle, cx);
                                cx.notify();
                            }),
                        ))
                        .child(
                            kit::ghost_button("iss-doc-toggle", "Expand", theme).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.toggle_issue_doc(&iid_toggle);
                                    cx.notify();
                                }),
                            ),
                        ),
                )
        } else {
            div()
                .p(px(12.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border)
                .bg(theme.surface)
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(theme::micro("MARKDOWN DOCUMENT", 8.5, theme.dark))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .child(kit::ghost_button("iss-doc-edit", "Edit", theme).on_click(
                                    cx.listener(move |this, _, window, cx| {
                                        this.begin_edit_issue(&iid_edit);
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }),
                                ))
                                .child(
                                    kit::ghost_button("iss-doc-toggle", "Collapse", theme)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.toggle_issue_doc(&iid_toggle);
                                            cx.notify();
                                        })),
                                ),
                        ),
                )
                .child(if issue.body_md.trim().is_empty() {
                    theme::body(
                        "No document written yet — click Edit or ask a bot in chat to draft it.",
                        12.5,
                        theme.fg_tertiary,
                    )
                    .into_any_element()
                } else {
                    div()
                        .id("iss-doc-body-scroll")
                        .w_full()
                        .min_w(px(0.0))
                        .max_h(px(190.0))
                        .overflow_y_scroll()
                        .font_family(theme::SANS)
                        .text_size(px(12.5))
                        .line_height(px(18.0))
                        .text_color(theme.fg_secondary)
                        .child(issue.body_md.clone())
                        .into_any_element()
                })
        };

    header_inner = header_inner.child(doc_panel);

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
        StreamOptions {
            title: &format!("#{}", issue.number),
            is_channel: true,
            empty_hint: "Discuss the document, @mention a bot to start implementing or review changes.",
            hidden_message_ids: &[],
            above: None,
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

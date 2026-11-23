//! Setup Checklist surface: gates workspace access until repo, models, decision model, and a bot exist.

use gpui::prelude::*;
use gpui::{Context, Div, div, px};

use crate::kit;
use crate::state::{KawanApp, SettingsTab};
use crate::theme::{self, Theme};

pub fn render(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let models_ready = app.setup.has_models && app.setup.has_decision_model;
    let steps = [
        (
            "01",
            "Attach Repository",
            "Clone bare upstream repo, confirm default branch, and set verify command.",
            app.setup.has_repo,
            SettingsTab::Repository,
            true,
        ),
        (
            "02",
            "Configure Models",
            "Add LLM provider credentials, default model role, and SubQ Snap decision endpoint.",
            models_ready,
            SettingsTab::Models,
            true,
        ),
        (
            "03",
            "Create First Bot",
            "Generate a bot identity, SSH signing keypair, and root orchestrator session.",
            app.setup.has_bot,
            SettingsTab::Bots,
            app.setup.has_repo && models_ready,
        ),
    ];

    let card = div()
        .w(px(760.0))
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .overflow_hidden()
        .child(
            kit::strip_bar(theme)
                .child(theme::micro(
                    format!(
                        "HOST SETUP · {} ({})",
                        app.current_user_name, app.current_user_role
                    ),
                    9.5,
                    theme.dark,
                ))
                .child(kit::status_tag(
                    if app.setup.ready {
                        "READY"
                    } else {
                        "INCOMPLETE"
                    },
                    if app.setup.ready {
                        theme::CATEGORY_INDUSTRY
                    } else {
                        theme::UMBER_VIVID
                    },
                    theme,
                )),
        )
        .child(
            div()
                .p(px(24.0))
                .flex()
                .flex_col()
                .gap(px(16.0))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(theme::title("Setup Checklist", 26.0, theme.ink))
                        .child(theme::body(
                            "Complete all three host requirements before opening conversations.",
                            13.5,
                            theme.fg_secondary,
                        )),
                )
                .child(
                    div()
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(theme.border_subtle)
                        .overflow_hidden()
                        .children(steps.into_iter().enumerate().map(
                            |(idx, (num, name, desc, done, tab, enabled))| {
                                let border_c = if idx < 2 {
                                    theme.border_subtle
                                } else {
                                    gpui::transparent_black()
                                };
                                div()
                                    .relative()
                                    .overflow_hidden()
                                    .p(px(16.0))
                                    .border_b_1()
                                    .border_color(border_c)
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(16.0))
                                    .children(done.then(|| {
                                        kit::left_edge(theme::hex(theme::CATEGORY_INDUSTRY))
                                    }))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w(px(0.0))
                                            .flex()
                                            .flex_col()
                                            .gap(px(3.0))
                                            .child(
                                                div()
                                                    .flex()
                                                    .items_center()
                                                    .gap(px(10.0))
                                                    .child(theme::numeric(
                                                        num,
                                                        11.0,
                                                        theme.fg_tertiary,
                                                    ))
                                                    .child(theme::title(name, 17.0, theme.ink))
                                                    .child(kit::status_tag(
                                                        if done {
                                                            "CONFIGURED"
                                                        } else {
                                                            "REQUIRED"
                                                        },
                                                        if done {
                                                            theme::CATEGORY_INDUSTRY
                                                        } else {
                                                            theme::UMBER_VIVID
                                                        },
                                                        theme,
                                                    )),
                                            )
                                            .child(theme::body(desc, 12.5, theme.fg_secondary)),
                                    )
                                    .child(if enabled {
                                        kit::secondary_button(
                                            ("checklist-step", idx),
                                            if done { "Edit" } else { "Configure" },
                                            theme,
                                        )
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.open_settings(tab);
                                            window.focus(&this.focus_handle, cx);
                                            cx.notify();
                                        }))
                                        .into_any_element()
                                    } else {
                                        kit::disabled_primary_button(
                                            ("checklist-step-dis", idx),
                                            "Requires 01 & 02",
                                            theme,
                                        )
                                        .into_any_element()
                                    })
                            },
                        )),
                ),
        )
        .child(
            div()
                .h(px(44.0))
                .px(px(24.0))
                .bg(theme.strip)
                .border_t_1()
                .border_color(theme.border_subtle)
                .flex()
                .items_center()
                .justify_between()
                .child(theme::numeric(
                    "#general was created at bootstrap",
                    10.5,
                    theme.fg_tertiary,
                ))
                .child(if app.setup.ready {
                    kit::primary_button("checklist-open-ws", "Open Workspace", theme).on_click(
                        cx.listener(|this, _, window, cx| {
                            this.open_workspace();
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }),
                    )
                } else {
                    kit::disabled_primary_button("checklist-open-ws", "Open Workspace", theme)
                }),
        );

    div()
        .size_full()
        .bg(theme.surface)
        .flex()
        .items_center()
        .justify_center()
        .p(px(24.0))
        .child(card)
}

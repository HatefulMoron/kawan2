//! Settings surface: Repository, Models (write-only masked secrets + Test), Bots & Invites.

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, div, px, relative};

use crate::kit;
use crate::state::{FocusTarget, KawanApp, Screen, SettingsTab};
use crate::theme::{self, Theme};
use crate::views::conversation::left_rail;

const SETTINGS_MEASURE: f32 = 860.0;

pub fn render(app: &KawanApp, tab: SettingsTab, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let tabs = [
        (SettingsTab::Repository, "Repository"),
        (SettingsTab::Models, "Models"),
        (SettingsTab::Bots, "Bots & Invites"),
    ];

    let tab_bar =
        div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .children(tabs.into_iter().enumerate().map(|(ti, (t, lbl))| {
                let active = tab == t;
                div()
                    .id(("settings-tab", ti))
                    .h(px(26.0))
                    .px(px(10.0))
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
                        lbl,
                        9.0,
                        if active {
                            theme.ink
                        } else {
                            theme.fg_secondary
                        },
                    ))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_settings(t);
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    }))
            }));

    let content: AnyElement = match tab {
        SettingsTab::Repository => repository_tab(app, theme, cx).into_any_element(),
        SettingsTab::Models => models_tab(app, theme, cx).into_any_element(),
        SettingsTab::Bots => bots_tab(app, theme, cx).into_any_element(),
    };

    let main_pane = div()
        .id("settings-scroll")
        .flex_1()
        .min_w(px(0.0))
        .h_full()
        .overflow_y_scroll()
        .bg(theme.surface)
        .child(
            div().w_full().flex().justify_center().child(
                div()
                    .w(relative(1.0))
                    .max_w(px(SETTINGS_MEASURE))
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
                            .items_end()
                            .justify_between()
                            .gap(px(16.0))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.0))
                                    .child(theme::title("Settings", 26.0, theme.ink))
                                    .child(tab_bar),
                            )
                            .child(if app.setup.ready {
                                kit::secondary_button("settings-back-ws", "← Workspace", theme)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.open_workspace();
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    }))
                            } else {
                                kit::secondary_button(
                                    "settings-back-checklist",
                                    "← Checklist",
                                    theme,
                                )
                                .on_click(cx.listener(
                                    |this, _, window, cx| {
                                        this.screen = Screen::Checklist;
                                        window.focus(&this.focus_handle, cx);
                                        cx.notify();
                                    },
                                ))
                            }),
                    )
                    .children(app.error_banner.as_ref().map(|err| {
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
                                err.clone(),
                                11.0,
                                theme::hex(theme::CATEGORY_VALS),
                            ))
                    }))
                    .children(app.status_banner.as_ref().map(|msg| {
                        div()
                            .relative()
                            .overflow_hidden()
                            .p(px(10.0))
                            .rounded(px(2.0))
                            .border_1()
                            .border_color(theme.border_subtle)
                            .bg(theme.strip)
                            .child(kit::left_edge(theme::hex(theme::CATEGORY_INDUSTRY)))
                            .child(theme::numeric(msg.clone(), 11.0, theme.dark))
                    }))
                    .child(content),
            ),
        );

    div()
        .size_full()
        .flex()
        .bg(theme.surface)
        .child(left_rail(app, theme, cx))
        .child(main_pane)
}

fn repository_tab(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let host_pubkey = app
        .settings
        .host_ssh_pubkey
        .clone()
        .unwrap_or_else(|| "Not loaded".to_string());

    div()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .overflow_hidden()
        .child(
            kit::strip_bar(theme)
                .child(theme::micro("REPOSITORY & VERIFY GATE", 9.5, theme.dark))
                .child(kit::status_tag(
                    if app.setup.has_repo {
                        "ATTACHED"
                    } else {
                        "NOT ATTACHED"
                    },
                    if app.setup.has_repo {
                        theme::CATEGORY_INDUSTRY
                    } else {
                        theme::UMBER_VIVID
                    },
                    theme,
                )),
        )
        .child(
            div()
                .p(px(16.0))
                .flex()
                .flex_col()
                .gap(px(14.0))
                .child(
                    div()
                        .p(px(10.0))
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(theme.border_subtle)
                        .bg(theme.strip)
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(theme::micro("HOST SSH PUBLIC KEY", 9.0, theme.fg_tertiary))
                        .child(
                            div()
                                .font_family(theme::MONO)
                                .text_size(px(10.5))
                                .text_color(theme.ink)
                                .child(host_pubkey),
                        ),
                )
                .child(field_row(
                    "repo-url-input",
                    "CLONE URL OR LOCAL BARE PATH",
                    &app.repo_url_input,
                    "/path/to/repo.git or git@github.com:org/repo.git",
                    app.focus_target == FocusTarget::RepoUrl,
                    false,
                    FocusTarget::RepoUrl,
                    theme,
                    cx,
                ))
                .child(field_row(
                    "repo-branch-input",
                    "DEFAULT BRANCH",
                    &app.repo_branch_input,
                    "main",
                    app.focus_target == FocusTarget::RepoBranch,
                    false,
                    FocusTarget::RepoBranch,
                    theme,
                    cx,
                ))
                .child(field_row(
                    "repo-verify-input",
                    "VERIFY COMMAND",
                    &app.repo_verify_input,
                    "cargo test --workspace",
                    app.focus_target == FocusTarget::RepoVerifyCmd,
                    false,
                    FocusTarget::RepoVerifyCmd,
                    theme,
                    cx,
                )),
        )
        .child(
            div()
                .h(px(44.0))
                .px(px(16.0))
                .bg(theme.strip)
                .border_t_1()
                .border_color(theme.border_subtle)
                .flex()
                .items_center()
                .justify_between()
                .child(theme::numeric(
                    app.settings
                        .repo
                        .as_ref()
                        .map(|r| format!("Bare path: {}", r.bare_path))
                        .unwrap_or_else(|| "Runs git clone --bare on save".to_string()),
                    10.5,
                    theme.fg_tertiary,
                ))
                .child(
                    kit::primary_button("settings-save-repo", "Save Repository", theme).on_click(
                        cx.listener(|this, _, window, cx| {
                            this.save_repository_settings();
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }),
                    ),
                ),
        )
}

fn models_tab(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let llm_key_configured = app
        .settings
        .providers
        .get(app.provider_name_input.trim())
        .is_some_and(|p| p.api_key_configured);
    let dec_key_configured = app
        .settings
        .roles
        .decision
        .as_ref()
        .is_some_and(|d| d.api_key_configured);

    div()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .overflow_hidden()
        .child(
            kit::strip_bar(theme)
                .child(theme::micro(
                    "MODELS & DECISION ENDPOINT (WRITE-ONLY KEYS)",
                    9.5,
                    theme.dark,
                ))
                .child(kit::status_tag(
                    if app.setup.has_models && app.setup.has_decision_model {
                        "CONFIGURED"
                    } else {
                        "REQUIRED"
                    },
                    if app.setup.has_models && app.setup.has_decision_model {
                        theme::CATEGORY_INDUSTRY
                    } else {
                        theme::UMBER_VIVID
                    },
                    theme,
                )),
        )
        .child(
            div()
                .p(px(16.0))
                .flex()
                .flex_col()
                .gap(px(14.0))
                .child(theme::micro("DEFAULT AGENT PROVIDER", 9.5, theme.dark))
                .child(
                    div()
                        .flex()
                        .gap(px(12.0))
                        .child(div().flex_1().child(field_row(
                            "prov-name-input",
                            "PROVIDER NAME",
                            &app.provider_name_input,
                            "lithosai",
                            app.focus_target == FocusTarget::ProviderName,
                            false,
                            FocusTarget::ProviderName,
                            theme,
                            cx,
                        )))
                        .child(div().flex_1().child(field_row(
                            "prov-url-input",
                            "BASE URL",
                            &app.provider_base_url_input,
                            "https://api.lithosai.cloud/v1",
                            app.focus_target == FocusTarget::ProviderBaseUrl,
                            false,
                            FocusTarget::ProviderBaseUrl,
                            theme,
                            cx,
                        ))),
                )
                .child(
                    div()
                        .flex()
                        .gap(px(12.0))
                        .child(div().flex_1().child(field_row(
                            "prov-model-input",
                            "MODEL ID",
                            &app.provider_model_input,
                            "deepseek-ai/DeepSeek-V4.1-Flash",
                            app.focus_target == FocusTarget::ProviderModelId,
                            false,
                            FocusTarget::ProviderModelId,
                            theme,
                            cx,
                        )))
                        .child(div().flex_1().child(field_row(
                            "prov-key-input",
                            if llm_key_configured {
                                "API KEY (CONFIGURED · ENTER TO ROTATE)"
                            } else {
                                "API KEY (WRITE-ONLY)"
                            },
                            &app.provider_api_key_input,
                            if llm_key_configured {
                                "configured"
                            } else {
                                "sk-..."
                            },
                            app.focus_target == FocusTarget::ProviderApiKey,
                            true,
                            FocusTarget::ProviderApiKey,
                            theme,
                            cx,
                        ))),
                )
                .child(kit::hairline(theme.border_subtle))
                .child(theme::micro(
                    "DECISION MODEL (SUBQ SNAP / ROUTE_MESSAGE)",
                    9.5,
                    theme.dark,
                ))
                .child(
                    div()
                        .flex()
                        .gap(px(12.0))
                        .child(div().flex_1().child(field_row(
                            "dec-url-input",
                            "DECISION BASE URL",
                            &app.decision_base_url_input,
                            "https://api.subq.ai/v1",
                            app.focus_target == FocusTarget::DecisionBaseUrl,
                            false,
                            FocusTarget::DecisionBaseUrl,
                            theme,
                            cx,
                        )))
                        .child(div().flex_1().child(field_row(
                            "dec-model-input",
                            "DECISION MODEL ID",
                            &app.decision_model_input,
                            "subq-snap-1.2",
                            app.focus_target == FocusTarget::DecisionModel,
                            false,
                            FocusTarget::DecisionModel,
                            theme,
                            cx,
                        ))),
                )
                .child(field_row(
                    "dec-key-input",
                    if dec_key_configured {
                        "DECISION API KEY (CONFIGURED · ENTER TO ROTATE)"
                    } else {
                        "DECISION API KEY (WRITE-ONLY)"
                    },
                    &app.decision_api_key_input,
                    if dec_key_configured {
                        "configured"
                    } else {
                        "sk-proj-..."
                    },
                    app.focus_target == FocusTarget::DecisionApiKey,
                    true,
                    FocusTarget::DecisionApiKey,
                    theme,
                    cx,
                ))
                .children(app.models_test_result.as_ref().map(|res| {
                    div()
                        .p(px(10.0))
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(theme.border_subtle)
                        .bg(theme.strip)
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(theme::numeric(
                            format!(
                                "default: {} ({} ms){}",
                                if res.default.ok { "PASS" } else { "FAIL" },
                                res.default.latency_ms,
                                res.default
                                    .error
                                    .as_deref()
                                    .map(|e| format!(" — {e}"))
                                    .unwrap_or_default()
                            ),
                            11.0,
                            if res.default.ok {
                                theme.dark
                            } else {
                                theme::hex(theme::CATEGORY_VALS)
                            },
                        ))
                        .child(theme::numeric(
                            format!(
                                "decision: {} ({} ms){}",
                                if res.decision.ok { "PASS" } else { "FAIL" },
                                res.decision.latency_ms,
                                res.decision
                                    .error
                                    .as_deref()
                                    .map(|e| format!(" — {e}"))
                                    .unwrap_or_default()
                            ),
                            11.0,
                            if res.decision.ok {
                                theme.dark
                            } else {
                                theme::hex(theme::CATEGORY_VALS)
                            },
                        ))
                })),
        )
        .child(
            div()
                .h(px(44.0))
                .px(px(16.0))
                .bg(theme.strip)
                .border_t_1()
                .border_color(theme.border_subtle)
                .flex()
                .items_center()
                .justify_between()
                .child(if app.models_test_pending {
                    kit::disabled_primary_button("settings-test-models", "Testing...", theme)
                } else {
                    kit::secondary_button("settings-test-models", "Test Models", theme).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.test_models();
                            cx.notify();
                        }),
                    )
                })
                .child(
                    kit::primary_button("settings-save-models", "Save Models", theme).on_click(
                        cx.listener(|this, _, window, cx| {
                            this.save_models_settings();
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        }),
                    ),
                ),
        )
}

fn bots_tab(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let prereqs_ok = app.setup.has_repo && app.setup.has_models && app.setup.has_decision_model;

    let bot_list_card = div()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .overflow_hidden()
        .child(
            kit::strip_bar(theme)
                .child(theme::micro("CONFIGURED BOTS", 9.5, theme.dark))
                .child(theme::numeric(
                    format!("{} bots", app.bots.len()),
                    10.5,
                    theme.fg_tertiary,
                )),
        )
        .children(if app.bots.is_empty() {
            vec![
                div()
                    .p(px(16.0))
                    .child(theme::body(
                        "No bots configured yet.",
                        13.0,
                        theme.fg_tertiary,
                    ))
                    .into_any_element(),
            ]
        } else {
            app.bots
                .iter()
                .enumerate()
                .map(|(bi, b)| {
                    let bid_edit = b.id.clone();
                    let bname = b.name.clone();
                    let bpersona = b.persona.clone().unwrap_or_default();
                    let bmodel = b.model.clone().unwrap_or_default();
                    let bthink = b
                        .thinking_level
                        .clone()
                        .unwrap_or_else(|| "medium".to_string());
                    let bsand = b.sandbox_enabled;
                    let bnet = b.sandbox_network;

                    div()
                        .px(px(16.0))
                        .py(px(10.0))
                        .border_b_1()
                        .border_color(theme.border_subtle)
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(10.0))
                                .child(kit::bot_avatar(24.0, theme))
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(2.0))
                                        .child(theme::label(format!("@{bname}"), 13.0, theme.ink))
                                        .child(theme::numeric(
                                            format!(
                                                "{bmodel} · thinking {bthink} · {}",
                                                b.orchestrator_status
                                            ),
                                            10.0,
                                            theme.fg_tertiary,
                                        )),
                                ),
                        )
                        .child(
                            kit::secondary_button(("bot-edit-btn", bi), "Edit", theme).on_click(
                                cx.listener(move |this, _, window, cx| {
                                    this.editing_bot_id = Some(bid_edit.clone());
                                    this.bot_name_input = bname.clone();
                                    this.bot_persona_input = bpersona.clone();
                                    this.bot_model_input = bmodel.clone();
                                    this.bot_thinking_input = bthink.clone();
                                    this.bot_sandbox_enabled = bsand;
                                    this.bot_sandbox_network = bnet;
                                    this.focus_target = FocusTarget::BotName;
                                    window.focus(&this.focus_handle, cx);
                                    cx.notify();
                                }),
                            ),
                        )
                        .into_any_element()
                })
                .collect()
        });

    let bot_form = div()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .overflow_hidden()
        .child(
            kit::strip_bar(theme)
                .child(theme::micro(
                    if app.editing_bot_id.is_some() {
                        "EDIT BOT"
                    } else {
                        "CREATE BOT"
                    },
                    9.5,
                    theme.dark,
                ))
                .children(app.editing_bot_id.is_some().then(|| {
                    kit::ghost_button("bot-cancel-edit", "New bot instead", theme).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.editing_bot_id = None;
                            cx.notify();
                        }),
                    )
                })),
        )
        .child(
            div()
                .p(px(16.0))
                .flex()
                .flex_col()
                .gap(px(12.0))
                .child(
                    div()
                        .flex()
                        .gap(px(12.0))
                        .child(div().flex_1().child(field_row(
                            "bot-name-input",
                            "BOT NAME",
                            &app.bot_name_input,
                            "kawan",
                            app.focus_target == FocusTarget::BotName,
                            false,
                            FocusTarget::BotName,
                            theme,
                            cx,
                        )))
                        .child(div().flex_1().child(field_row(
                            "bot-thinking-input",
                            "THINKING LEVEL",
                            &app.bot_thinking_input,
                            "medium",
                            app.focus_target == FocusTarget::BotThinking,
                            false,
                            FocusTarget::BotThinking,
                            theme,
                            cx,
                        ))),
                )
                .child(field_row(
                    "bot-persona-input",
                    "PERSONA / SYSTEM PROMPT",
                    &app.bot_persona_input,
                    "Practical software engineering orchestrator",
                    app.focus_target == FocusTarget::BotPersona,
                    false,
                    FocusTarget::BotPersona,
                    theme,
                    cx,
                ))
                .child(field_row(
                    "bot-model-input",
                    "MODEL (PROVIDER/MODEL · OPTIONAL)",
                    &app.bot_model_input,
                    "Defaults to role default",
                    app.focus_target == FocusTarget::BotModel,
                    false,
                    FocusTarget::BotModel,
                    theme,
                    cx,
                ))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(18.0))
                        .child(
                            div()
                                .id("bot-toggle-sandbox")
                                .flex()
                                .items_center()
                                .gap(px(7.0))
                                .cursor_pointer()
                                .child(kit::checkbox(app.bot_sandbox_enabled, theme))
                                .child(theme::label("bwrap sandbox", 12.0, theme.ink))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.bot_sandbox_enabled = !this.bot_sandbox_enabled;
                                    cx.notify();
                                })),
                        )
                        .child(
                            div()
                                .id("bot-toggle-net")
                                .flex()
                                .items_center()
                                .gap(px(7.0))
                                .cursor_pointer()
                                .child(kit::checkbox(app.bot_sandbox_network, theme))
                                .child(theme::label("sandbox network", 12.0, theme.ink))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.bot_sandbox_network = !this.bot_sandbox_network;
                                    cx.notify();
                                })),
                        ),
                ),
        )
        .child(
            div()
                .h(px(44.0))
                .px(px(16.0))
                .bg(theme.strip)
                .border_t_1()
                .border_color(theme.border_subtle)
                .flex()
                .items_center()
                .justify_between()
                .child(theme::numeric(
                    if prereqs_ok {
                        "Editing persona archives old orchestrator session"
                    } else {
                        "Configure repository & models first"
                    },
                    10.5,
                    theme.fg_tertiary,
                ))
                .child(if prereqs_ok {
                    kit::primary_button(
                        "settings-save-bot",
                        if app.editing_bot_id.is_some() {
                            "Save Bot"
                        } else {
                            "Create Bot"
                        },
                        theme,
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.save_bot();
                        window.focus(&this.focus_handle, cx);
                        cx.notify();
                    }))
                } else {
                    kit::disabled_primary_button("settings-save-bot", "Create Bot", theme)
                }),
        );

    let invite_card = div()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .overflow_hidden()
        .child(kit::strip_bar(theme).child(theme::micro("INVITE MEMBERS (ADMIN)", 9.5, theme.dark)))
        .child(
            div()
                .p(px(16.0))
                .flex()
                .flex_col()
                .gap(px(10.0))
                .child(
                    div()
                        .flex()
                        .items_end()
                        .gap(px(10.0))
                        .child(div().flex_1().child(field_row(
                            "invite-note-input",
                            "INVITE NOTE (OPTIONAL)",
                            &app.invite_note_input,
                            "For teammate",
                            app.focus_target == FocusTarget::InviteNote,
                            false,
                            FocusTarget::InviteNote,
                            theme,
                            cx,
                        )))
                        .child(
                            kit::secondary_button("settings-create-invite", "Create Invite", theme)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.create_invite();
                                    cx.notify();
                                })),
                        ),
                )
                .children(app.last_invite_link.as_ref().map(|link| {
                    div()
                        .p(px(8.0))
                        .rounded(px(2.0))
                        .border_1()
                        .border_color(theme.border_subtle)
                        .bg(theme.strip)
                        .child(theme::numeric(link.clone(), 11.0, theme.ink))
                })),
        );

    div()
        .flex()
        .flex_col()
        .gap(px(16.0))
        .child(bot_list_card)
        .child(bot_form)
        .child(invite_card)
}

#[allow(clippy::too_many_arguments)]
fn field_row(
    id: &'static str,
    label: &'static str,
    value: &str,
    placeholder: &'static str,
    focused: bool,
    masked: bool,
    target: FocusTarget,
    theme: &Theme,
    cx: &mut Context<KawanApp>,
) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(5.0))
        .child(theme::micro(label, 9.0, theme.fg_tertiary))
        .child(
            kit::text_input_box(id, value, placeholder, focused, masked, theme).on_click(
                cx.listener(move |this, _, window, cx| {
                    this.focus_target = target;
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }),
            ),
        )
}

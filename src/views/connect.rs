//! Connect surface: Bootstrap, Invite registration, or SSH Login.

use gpui::prelude::*;
use gpui::{Context, Div, div, px};

use crate::kit;
use crate::state::{FocusTarget, KawanApp};
use crate::theme::{self, Theme};
use crate::ws_client::AuthMode;

pub fn render(app: &KawanApp, theme: &Theme, cx: &mut Context<KawanApp>) -> Div {
    let modes = [
        (AuthMode::Bootstrap, "Bootstrap"),
        (AuthMode::Register, "Invite"),
        (AuthMode::Login, "Login"),
    ];

    let card = div()
        .w(px(520.0))
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .overflow_hidden()
        .child(
            kit::strip_bar(theme)
                .child(theme::micro("KAWAN · HOST CONNECTION", 9.5, theme.dark))
                .child(theme::micro(
                    if app.connecting {
                        "HANDSHAKING"
                    } else {
                        "SSH CHALLENGE AUTH"
                    },
                    9.0,
                    theme.fg_tertiary,
                )),
        )
        .child(
            div()
                .p(px(20.0))
                .flex()
                .flex_col()
                .gap(px(14.0))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(theme::title("Connect to Host", 24.0, theme.ink))
                        .child(theme::body(
                            "Authenticate with an ed25519 SSH key via challenge-response.",
                            13.0,
                            theme.fg_secondary,
                        )),
                )
                .child(div().flex().items_center().gap(px(6.0)).children(
                    modes.into_iter().enumerate().map(|(idx, (mode, lbl))| {
                        let active = app.auth_mode == mode;
                        div()
                            .id(("connect-mode", idx))
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
                                this.auth_mode = mode;
                                this.connect_error = None;
                                window.focus(&this.focus_handle, cx);
                                cx.notify();
                            }))
                    }),
                ))
                .child(labeled_input(
                    "connect-host",
                    "HOST ADDRESS",
                    &app.connect_host,
                    "ws://127.0.0.1:8787 or kawan://host/token",
                    app.focus_target == FocusTarget::ConnectHost,
                    false,
                    FocusTarget::ConnectHost,
                    theme,
                    cx,
                ))
                .children((app.auth_mode != AuthMode::Login).then(|| {
                    labeled_input(
                        "connect-token",
                        if app.auth_mode == AuthMode::Bootstrap {
                            "BOOTSTRAP TOKEN"
                        } else {
                            "INVITE TOKEN OR KAWAN:// LINK"
                        },
                        &app.connect_token,
                        "Paste token from host log or invite link",
                        app.focus_target == FocusTarget::ConnectToken,
                        false,
                        FocusTarget::ConnectToken,
                        theme,
                        cx,
                    )
                }))
                .children((app.auth_mode != AuthMode::Login).then(|| {
                    labeled_input(
                        "connect-name",
                        "DISPLAY NAME",
                        &app.connect_name,
                        "alice",
                        app.focus_target == FocusTarget::ConnectName,
                        false,
                        FocusTarget::ConnectName,
                        theme,
                        cx,
                    )
                }))
                .child(labeled_input(
                    "connect-key",
                    "SSH PRIVATE KEY PATH",
                    &app.connect_key_path,
                    "~/.ssh/id_ed25519",
                    app.focus_target == FocusTarget::ConnectKeyPath,
                    false,
                    FocusTarget::ConnectKeyPath,
                    theme,
                    cx,
                ))
                .children(app.connect_error.as_ref().map(|err| {
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
                })),
        )
        .child(
            div()
                .h(px(44.0))
                .px(px(20.0))
                .bg(theme.strip)
                .border_t_1()
                .border_color(theme.border_subtle)
                .flex()
                .items_center()
                .justify_between()
                .child(theme::numeric(
                    "No TLS in v1 · use localhost or tunnel",
                    10.0,
                    theme.fg_tertiary,
                ))
                .child(if app.connecting {
                    kit::disabled_primary_button("connect-submit", "Connecting...", theme)
                } else {
                    kit::primary_button("connect-submit", "Connect", theme).on_click(cx.listener(
                        |this, _, window, cx| {
                            this.start_connect(cx);
                            window.focus(&this.focus_handle, cx);
                            cx.notify();
                        },
                    ))
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

#[allow(clippy::too_many_arguments)]
fn labeled_input(
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

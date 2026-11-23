//! Shared Instrument Panel UI primitives: icons, swatches, hairlines, strips, buttons, inputs.

use gpui::prelude::*;
use gpui::{Div, Hsla, Pixels, SharedString, Stateful, div, px, svg};

use crate::theme::{self, Theme};

pub fn icon(path: impl Into<SharedString>, size_px: f32, color: Hsla) -> impl IntoElement {
    svg()
        .path(path.into())
        .flex_none()
        .w(px(size_px))
        .h(px(size_px))
        .text_color(color)
}

pub fn left_edge(color: Hsla) -> Div {
    div()
        .absolute()
        .left_0()
        .top_0()
        .bottom_0()
        .w(px(2.0))
        .bg(color)
}

pub fn swatch(color: Hsla, size: Pixels) -> Div {
    div().w(size).h(size).flex_none().rounded(px(1.0)).bg(color)
}

pub fn hairline(color: Hsla) -> Div {
    div().w_full().h(px(1.0)).bg(color)
}

pub fn strip_bar(theme: &Theme) -> Div {
    div()
        .h(px(40.0))
        .w_full()
        .flex_none()
        .px(px(14.0))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.0))
        .bg(theme.strip)
        .border_b_1()
        .border_color(theme.border_subtle)
}

pub fn bot_avatar(size_px: f32, theme: &Theme) -> Div {
    div()
        .w(px(size_px))
        .h(px(size_px))
        .flex_none()
        .rounded(px(2.0))
        .bg(theme.ink)
        .border_1()
        .border_color(theme.ink)
        .flex()
        .items_center()
        .justify_center()
        .child(icon("kawan/bot.svg", size_px * 0.60, theme::hex(0xFFFFFF)))
}

pub fn human_avatar(name: &str, size_px: f32, theme: &Theme) -> Div {
    let initials: String = name
        .split_whitespace()
        .filter_map(|part| part.chars().next())
        .take(2)
        .collect::<String>()
        .to_uppercase();
    let initials = if initials.is_empty() {
        "U".to_string()
    } else {
        initials
    };

    div()
        .w(px(size_px))
        .h(px(size_px))
        .flex_none()
        .rounded(px(2.0))
        .bg(theme.strip)
        .border_1()
        .border_color(theme::with_alpha(theme.palette.dark, 0.24))
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .font_family(theme::MONO)
                .text_size(px((size_px * 0.38).max(8.0)))
                .line_height(px(size_px))
                .text_color(theme.ink)
                .child(initials),
        )
}

pub fn status_tag(label: impl Into<SharedString>, color_hex: u32, theme: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(5.0))
        .child(swatch(theme::hex(color_hex), px(6.0)))
        .child(theme::micro(label, 9.0, theme.fg_secondary))
}

pub fn primary_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    theme: &Theme,
) -> Stateful<Div> {
    let label: SharedString = label.into().to_uppercase().into();
    div()
        .id(id)
        .h(px(30.0))
        .px(px(12.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(6.0))
        .rounded(px(2.0))
        .bg(theme.ink)
        .text_color(theme::hex(0xFFFFFF))
        .cursor_pointer()
        .hover(|s| s.bg(theme.dark))
        .font_family(theme::MONO_TRACKED)
        .text_size(px(10.0))
        .line_height(px(12.0))
        .whitespace_nowrap()
        .child(label)
}

pub fn disabled_primary_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    theme: &Theme,
) -> Stateful<Div> {
    let label: SharedString = label.into().to_uppercase().into();
    div()
        .id(id)
        .h(px(30.0))
        .px(px(12.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(6.0))
        .rounded(px(2.0))
        .bg(theme::with_alpha(theme.palette.dark, 0.1))
        .text_color(theme::with_alpha(theme.palette.dark, 0.4))
        .cursor_not_allowed()
        .font_family(theme::MONO_TRACKED)
        .text_size(px(10.0))
        .line_height(px(12.0))
        .whitespace_nowrap()
        .child(label)
}

pub fn small_primary_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    theme: &Theme,
) -> Stateful<Div> {
    let label: SharedString = label.into().to_uppercase().into();
    div()
        .id(id)
        .h(px(24.0))
        .px(px(9.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(5.0))
        .rounded(px(2.0))
        .bg(theme.ink)
        .text_color(theme::hex(0xFFFFFF))
        .cursor_pointer()
        .hover(|s| s.bg(theme.dark))
        .font_family(theme::MONO_TRACKED)
        .text_size(px(9.0))
        .line_height(px(11.0))
        .whitespace_nowrap()
        .child(label)
}

pub fn secondary_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    theme: &Theme,
) -> Stateful<Div> {
    let label: SharedString = label.into().to_uppercase().into();
    div()
        .id(id)
        .h(px(24.0))
        .px(px(8.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(5.0))
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border)
        .bg(theme.surface)
        .text_color(theme.ink)
        .cursor_pointer()
        .hover(|s| {
            s.bg(theme.hover)
                .border_color(theme::with_alpha(theme.palette.dark, 0.45))
        })
        .font_family(theme::MONO_TRACKED)
        .text_size(px(9.0))
        .line_height(px(11.0))
        .whitespace_nowrap()
        .child(label)
}

pub fn ghost_button(
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    theme: &Theme,
) -> Stateful<Div> {
    let label: SharedString = label.into().to_uppercase().into();
    div()
        .id(id)
        .h(px(24.0))
        .px(px(8.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(4.0))
        .rounded(px(2.0))
        .text_color(theme.fg_secondary)
        .cursor_pointer()
        .hover(|s| s.bg(theme.hover).text_color(theme.ink))
        .font_family(theme::MONO_TRACKED)
        .text_size(px(9.0))
        .line_height(px(11.0))
        .whitespace_nowrap()
        .child(label)
}

pub fn icon_button(
    id: impl Into<gpui::ElementId>,
    svg_path: &'static str,
    theme: &Theme,
) -> Stateful<Div> {
    div()
        .id(id)
        .w(px(24.0))
        .h(px(24.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(2.0))
        .border_1()
        .border_color(theme::with_alpha(theme.palette.dark, 0.2))
        .bg(theme.surface)
        .cursor_pointer()
        .hover(|s| s.bg(theme.hover))
        .child(icon(svg_path, 12.0, theme.dark))
}

pub fn text_input_box(
    id: impl Into<gpui::ElementId>,
    value: &str,
    placeholder: &str,
    focused: bool,
    masked: bool,
    theme: &Theme,
) -> Stateful<Div> {
    let display = if value.is_empty() {
        String::new()
    } else if masked {
        "•".repeat(value.chars().count().min(36))
    } else {
        value.to_string()
    };

    let content = if display.is_empty() {
        div()
            .flex()
            .items_center()
            .gap(px(2.0))
            .child(div().w(px(1.5)).h(px(13.0)).bg(if focused {
                theme.ink
            } else {
                gpui::transparent_black()
            }))
            .child(theme::numeric(
                placeholder.to_string(),
                12.0,
                theme::with_alpha(theme.palette.dark, 0.45),
            ))
    } else {
        div()
            .flex()
            .items_center()
            .overflow_hidden()
            .child(theme::numeric(display, 12.0, theme.ink))
            .child(div().ml(px(1.0)).w(px(1.5)).h(px(13.0)).bg(if focused {
                theme.ink
            } else {
                gpui::transparent_black()
            }))
    };

    div()
        .id(id)
        .h(px(32.0))
        .w_full()
        .px(px(10.0))
        .rounded(px(2.0))
        .border_1()
        .border_color(if focused { theme.vivid } else { theme.border })
        .bg(theme.surface)
        .flex()
        .items_center()
        .cursor_text()
        .child(content)
}

pub fn checkbox(checked: bool, theme: &Theme) -> Div {
    if checked {
        div()
            .w(px(14.0))
            .h(px(14.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(2.0))
            .bg(theme.ink)
            .child(icon("ui/check.svg", 10.0, theme::hex(0xFFFFFF)))
    } else {
        div()
            .w(px(14.0))
            .h(px(14.0))
            .flex_none()
            .rounded(px(2.0))
            .border_1()
            .border_color(theme::with_alpha(theme.palette.dark, 0.3))
            .bg(theme.surface)
    }
}

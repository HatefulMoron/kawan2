//! vals-ai Instrument Panel design tokens and typography helpers.

use gpui::{
    ColorExt, Div, FontWeight, Hsla, ParentElement, SharedString, Styled, div, px, rgb, rgb_to_hsla,
};

pub const SANS: &str = "Söhne";
pub const SANS_TRACKED: &str = "Söhne Tracked";
pub const MONO: &str = "Berkeley Mono";
pub const MONO_TRACKED: &str = "Berkeley Mono Tracked";
pub const SERIF: &str = "Martina Plantijn";

pub const CATEGORY_VALS: u32 = 0xC0453F;
pub const CATEGORY_INDUSTRY: u32 = 0x57A86D;
pub const CATEGORY_ACADEMIC: u32 = 0x19335C;
pub const UMBER_VIVID: u32 = 0x908041;

pub fn hex(value: u32) -> Hsla {
    rgb_to_hsla(rgb(value))
}

pub fn with_alpha(value: u32, alpha: f32) -> Hsla {
    hex(value).opacity(alpha)
}

#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub ink: u32,
    pub dark: u32,
    pub mid: u32,
    pub vivid: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Theme {
    pub palette: Palette,
    pub surface: Hsla,
    pub strip: Hsla,
    pub ink: Hsla,
    pub dark: Hsla,
    pub vivid: Hsla,
    pub fg_secondary: Hsla,
    pub fg_tertiary: Hsla,
    pub border: Hsla,
    pub border_subtle: Hsla,
    pub hover: Hsla,
}

impl Theme {
    fn from_palette(palette: Palette, strip: u32) -> Self {
        Self {
            palette,
            surface: hex(0xFFFFFF),
            strip: hex(strip),
            ink: hex(palette.ink),
            dark: hex(palette.dark),
            vivid: hex(palette.vivid),
            fg_secondary: hex(palette.dark),
            fg_tertiary: hex(palette.mid),
            border: with_alpha(palette.dark, 0.3),
            border_subtle: with_alpha(palette.dark, 0.1),
            hover: with_alpha(palette.dark, 0.05),
        }
    }

    pub fn green() -> Self {
        Self::from_palette(
            Palette {
                ink: 0x102015,
                dark: 0x284D32,
                mid: 0x386B46,
                vivid: 0x488959,
            },
            0xF6F9F7,
        )
    }
}

pub fn micro(text: impl Into<SharedString>, size: f32, color: Hsla) -> Div {
    div()
        .font_family(MONO_TRACKED)
        .text_size(px(size))
        .line_height(px(size * 1.45))
        .text_color(color)
        .whitespace_nowrap()
        .child(text.into().to_uppercase())
}

pub fn numeric(text: impl Into<SharedString>, size: f32, color: Hsla) -> Div {
    div()
        .font_family(MONO)
        .text_size(px(size))
        .line_height(px(size * 1.4))
        .text_color(color)
        .whitespace_nowrap()
        .child(text.into())
}

pub fn label(text: impl Into<SharedString>, size: f32, color: Hsla) -> Div {
    div()
        .font_family(SANS_TRACKED)
        .text_size(px(size))
        .line_height(px(size * 1.35))
        .text_color(color)
        .child(text.into())
}

pub fn body(text: impl Into<SharedString>, size: f32, color: Hsla) -> Div {
    div()
        .font_family(SANS)
        .text_size(px(size))
        .line_height(px(size * 1.45))
        .text_color(color)
        .child(text.into())
}

pub fn title(text: impl Into<SharedString>, size: f32, color: Hsla) -> Div {
    div()
        .font_family(SERIF)
        .font_weight(FontWeight::MEDIUM)
        .text_size(px(size))
        .line_height(px(size * 1.2))
        .text_color(color)
        .child(text.into())
}

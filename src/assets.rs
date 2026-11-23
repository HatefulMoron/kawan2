//! Embedded SVG icons and vals-ai Instrument Panel fonts.

use std::borrow::Cow;

use gpui::{AssetSource, Result, SharedString};

static SVG_ASSETS: &[(&str, &[u8])] = &[
    (
        "kawan/hash.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round"><path d="M6.2 2.8 4.8 13.2"/><path d="M11.2 2.8 9.8 13.2"/><path d="M3 6h10.5"/><path d="M2.5 10H13"/></svg>"##,
    ),
    (
        "kawan/bot.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="10" height="8.5" rx="1.5"/><path d="M8 2v2.5"/><circle cx="8" cy="1.8" r="0.7"/><path d="M5.8 8.3h.6"/><path d="M9.6 8.3h.6"/><path d="M6 10.6h4"/></svg>"##,
    ),
    (
        "kawan/thread.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 3v7.8a1.2 1.2 0 0 0 1.2 1.2H13"/><path d="M4.2 7.5H11"/><path d="m10.8 9.8 2.2 2.2-2.2 2.2"/></svg>"##,
    ),
    (
        "kawan/redirect.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5V7a2 2 0 0 1 2-2h7.5"/><path d="m10 2.5 2.5 2.5L10 7.5"/></svg>"##,
    ),
    (
        "kawan/merge.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="9" r="1.5"/><path d="M4.5 5v6"/><path d="M4.5 5.5c0 2.5 2 3.5 5.5 3.5"/></svg>"##,
    ),
    (
        "kawan/issue.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.3" fill="#000"/></svg>"##,
    ),
    (
        "kawan/send.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13V3.5L13.5 8 3 12.5"/><path d="M3 8h5.5"/></svg>"##,
    ),
    (
        "kawan/status.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5h2.4l1.7-4 2.4 7 1.8-4.5 1.3 1.5H14"/></svg>"##,
    ),
    (
        "kawan/diff.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5v4"/><path d="M3 5.5h4"/><path d="M3 11.5h4"/><path d="M9.5 5.5H13"/><path d="M9.5 8.5H13"/><path d="M9.5 11.5H13"/></svg>"##,
    ),
    (
        "ui/sliders.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round"><path d="M2 5h7"/><path d="M12 5h2"/><path d="M2 11h2"/><path d="M7 11h7"/><circle cx="10.5" cy="5" r="1.6"/><circle cx="5.5" cy="11" r="1.6"/></svg>"##,
    ),
    (
        "ui/close.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round"><path d="M4 4 12 12M12 4 4 12"/></svg>"##,
    ),
    (
        "ui/check.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m3.2 8.4 3.1 3.1 6.5-7"/></svg>"##,
    ),
    (
        "ui/plus.svg",
        br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round"><path d="M8 3v10"/><path d="M3 8h10"/></svg>"##,
    ),
];

pub struct KawanAssets;

impl AssetSource for KawanAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(SVG_ASSETS
            .iter()
            .find(|(p, _)| *p == path)
            .map(|(_, bytes)| Cow::Borrowed(*bytes)))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(SVG_ASSETS
            .iter()
            .map(|(p, _)| *p)
            .filter(|p| p.starts_with(path))
            .map(SharedString::from)
            .collect())
    }
}

pub fn font_data() -> Vec<Cow<'static, [u8]>> {
    vec![
        Cow::Borrowed(include_bytes!("../assets/fonts/soehne-buch.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/soehne-halbfett.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Soehne-Tracked.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Soehne-Tracked-Medium.ttf")),
        Cow::Borrowed(include_bytes!(
            "../assets/fonts/martina-plantijn-regular.ttf"
        )),
        Cow::Borrowed(include_bytes!(
            "../assets/fonts/martina-plantijn-medium.ttf"
        )),
        Cow::Borrowed(include_bytes!("../assets/fonts/BerkeleyMono-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/BerkeleyMono-Bold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/BerkeleyMono-Tracked.ttf")),
        Cow::Borrowed(include_bytes!(
            "../assets/fonts/BerkeleyMono-Tracked-Bold.ttf"
        )),
    ]
}

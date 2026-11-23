//! Kawan GPUI desktop client entrypoint.

mod assets;
mod kit;
mod mock;
mod protocol;
mod ssh;
mod state;
mod theme;
mod views;
mod ws_client;

use assets::KawanAssets;
use gpui::prelude::*;
use gpui::{
    App, Bounds, Context, KeyDownEvent, QuitMode, TitlebarOptions, Window, WindowBounds,
    WindowOptions, div, point, px, size,
};
use state::{KawanApp, Screen, WorkspacePage};
use theme::Theme;

impl Render for KawanApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::green();

        let body = match &self.screen {
            Screen::Connect => views::connect::render(self, &theme, cx),
            Screen::Checklist => views::checklist::render(self, &theme, cx),
            Screen::Workspace(WorkspacePage::Status) => views::status::render(self, &theme, cx),
            Screen::Workspace(WorkspacePage::MergeQueue) => {
                views::merge_queue::render(self, &theme, cx)
            }
            Screen::Workspace(WorkspacePage::Conversation) => {
                views::conversation::render(self, &theme, cx)
            }
            Screen::Workspace(WorkspacePage::Settings(tab)) => {
                views::settings::render(self, *tab, &theme, cx)
            }
        };

        div()
            .id("kawan-root")
            .size_full()
            .bg(theme.surface)
            .text_color(theme.ink)
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                this.handle_key_down(event, cx);
                cx.notify();
            }))
            .child(body)
    }
}

fn main() {
    gpui_platform::application()
        .with_assets(KawanAssets)
        .with_quit_mode(QuitMode::LastWindowClosed)
        .run(|cx: &mut App| {
            cx.text_system()
                .add_fonts(assets::font_data())
                .expect("bundled fonts should load");

            let bounds = Bounds {
                origin: point(px(0.0), px(0.0)),
                size: size(px(1440.0), px(900.0)),
            };
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(TitlebarOptions {
                        title: Some("kawan".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |window, cx| {
                    let view = cx.new(KawanApp::new);
                    let handle = view.read(cx).focus_handle.clone();
                    window.focus(&handle, cx);
                    view
                },
            )
            .unwrap();
            cx.activate(true);
        });
}

//! kawan — a small GPUI dashboard for the kache compiler cache.
//!
//! The window shells out to `kache stats --json` and renders the result.
//! Builds of this crate itself go through kache via `.cargo/config.toml`.

use std::process::Command;
use std::time::{Duration, Instant};

use gpui::{
    App, Bounds, Context, Div, FontWeight, QuitMode, Task, Window, WindowBounds, WindowOptions,
    colors::Colors, div, prelude::*, px, size,
};
use serde::Deserialize;

const REFRESH: Duration = Duration::from_secs(5);

fn main() {
    gpui_platform::application()
        .with_quit_mode(QuitMode::LastWindowClosed)
        .run(|cx: &mut App| {
            let bounds = Bounds::centered(None, size(px(980.), px(640.)), cx);
            cx.open_window(
                WindowOptions::default().window_bounds(WindowBounds::Windowed(bounds)),
                |_window, cx| {
                    cx.new(|cx| {
                        let mut dashboard = Dashboard::default();
                        dashboard.refresh(cx);
                        dashboard.start_auto_refresh(cx);
                        dashboard
                    })
                },
            )
            .unwrap();
            cx.activate(true);
        });
}

#[derive(Default)]
struct Dashboard {
    version: Option<String>,
    stats: Option<Stats>,
    error: Option<String>,
    loading: bool,
    last_update: Option<Instant>,
    refresh_task: Option<Task<()>>,
    ticker: Option<Task<()>>,
}

impl Dashboard {
    /// Runs `kache stats` off the UI thread and stores the parsed report.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        self.loading = true;
        cx.notify();

        self.refresh_task = Some(cx.spawn(async move |this, cx| {
            let snapshot = cx.background_spawn(async { query_kache() }).await;
            this.update(cx, |this, cx| {
                this.loading = false;
                match snapshot {
                    Ok(snapshot) => {
                        this.version = Some(snapshot.version);
                        this.stats = Some(snapshot.stats);
                        this.error = None;
                        this.last_update = Some(Instant::now());
                    }
                    Err(message) => this.error = Some(message),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn start_auto_refresh(&mut self, cx: &mut Context<Self>) {
        self.ticker = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(REFRESH).await;
                let alive = this.update(cx, |this, cx| this.refresh(cx)).is_ok();
                if !alive {
                    break;
                }
            }
        }));
    }
}

struct Snapshot {
    version: String,
    stats: Stats,
}

fn query_kache() -> Result<Snapshot, String> {
    let version = Command::new("kache")
        .arg("--version")
        .output()
        .map_err(|error| format!("could not run kache: {error}"))?;
    if !version.status.success() {
        return Err(String::from_utf8_lossy(&version.stderr).trim().to_string());
    }
    let version = String::from_utf8_lossy(&version.stdout).trim().to_string();

    let output = Command::new("kache")
        .args(["stats", "--json"])
        .output()
        .map_err(|error| format!("could not run kache stats: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("kache stats exited with {}", output.status)
        } else {
            stderr
        });
    }

    let stats = serde_json::from_slice::<Stats>(&output.stdout)
        .map_err(|error| format!("could not parse kache stats: {error}"))?;
    Ok(Snapshot { version, stats })
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct Stats {
    entries: u64,
    hit_rate_pct: f64,
    time_saved_ms: u64,
    local_hits: u64,
    readonly_hits: u64,
    remote_hits: u64,
    prefetch_hits: u64,
    misses: u64,
    dups: u64,
    disk: Disk,
    stores: Vec<Store>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct Disk {
    store_bytes: u64,
    store_limit_bytes: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct Store {
    path: String,
    entries: u64,
}

impl Stats {
    fn hits(&self) -> u64 {
        self.local_hits + self.readonly_hits + self.remote_hits + self.prefetch_hits
    }

    fn store_path(&self) -> &str {
        self.stores
            .first()
            .map(|store| store.path.as_str())
            .unwrap_or("~/.cache/kache")
    }
}

impl Render for Dashboard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = Colors::for_appearance(window);

        let status = if self.loading {
            "refreshing…".to_string()
        } else if let Some(error) = &self.error {
            format!("error: {error}")
        } else if let Some(at) = self.last_update {
            format!("updated {}s ago", at.elapsed().as_secs())
        } else {
            "waiting for kache".to_string()
        };

        let status_text = div().text_sm();
        let status_text = if self.error.is_some() {
            status_text.text_color(gpui::red())
        } else {
            status_text.text_color(colors.disabled)
        };

        let mut body = div().flex().flex_col().flex_1().gap_4();

        match &self.stats {
            Some(stats) => {
                body = body
                    .child(
                        div().flex().gap_4().child(hero_card(&colors, stats)).child(
                            div()
                                .flex_1()
                                .flex()
                                .flex_col()
                                .gap_4()
                                .child(
                                    div()
                                        .flex()
                                        .gap_4()
                                        .child(card(
                                            &colors,
                                            "hits",
                                            format_number(stats.hits()),
                                            format!(
                                                "{} local · {} remote",
                                                stats.local_hits + stats.readonly_hits,
                                                stats.remote_hits + stats.prefetch_hits
                                            ),
                                        ))
                                        .child(card(
                                            &colors,
                                            "misses",
                                            format_number(stats.misses),
                                            format!("{} deduplicated", stats.dups),
                                        )),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .gap_4()
                                        .child(card(
                                            &colors,
                                            "entries",
                                            format_number(stats.entries),
                                            "cached compilations".to_string(),
                                        ))
                                        .child(card(
                                            &colors,
                                            "time saved",
                                            format_duration(stats.time_saved_ms),
                                            "across cache hits".to_string(),
                                        )),
                                ),
                        ),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_4()
                            .child(card(
                                &colors,
                                "store size",
                                format_bytes(stats.disk.store_bytes),
                                format!("budget {}", format_bytes(stats.disk.store_limit_bytes)),
                            ))
                            .child(card(
                                &colors,
                                "store",
                                stats.store_path().to_string(),
                                format!("{} entries", stats.entries),
                            )),
                    );
            }
            None => {
                body = body.child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap_2()
                        .child(div().text_lg().text_color(colors.disabled).child(
                            if self.error.is_some() {
                                "kache did not answer"
                            } else {
                                "Loading kache stats…"
                            },
                        ))
                        .child(div().text_sm().text_color(colors.disabled).child(
                            if self.error.is_some() {
                                "Check that kache is installed and on PATH."
                            } else {
                                "The dashboard refreshes every 5 seconds."
                            },
                        )),
                );
            }
        }

        div()
            .size_full()
            .flex()
            .flex_col()
            .gap_5()
            .p_6()
            .bg(colors.background)
            .text_color(colors.text)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_2xl()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("kache"),
                            )
                            .child(div().text_sm().text_color(colors.disabled).child(
                                match &self.version {
                                    Some(version) => {
                                        format!("{version} · build cache dashboard")
                                    }
                                    None => "build cache dashboard".to_string(),
                                },
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(status_text.child(status))
                            .child(
                                div()
                                    .id("refresh")
                                    .px_3()
                                    .py_1()
                                    .rounded_md()
                                    .bg(colors.selected)
                                    .text_color(colors.selected_text)
                                    .cursor_pointer()
                                    .hover(|style| style.opacity(0.9))
                                    .active(|style| style.opacity(0.8))
                                    .child("Refresh")
                                    .on_click(
                                        cx.listener(|this, _event, _window, cx| this.refresh(cx)),
                                    ),
                            ),
                    ),
            )
            .child(body)
    }
}

fn hero_card(colors: &Colors, stats: &Stats) -> Div {
    div()
        .flex()
        .flex_col()
        .justify_between()
        .w(px(300.))
        .p_5()
        .rounded_lg()
        .border_1()
        .border_color(colors.border)
        .bg(colors.container)
        .child(
            div()
                .text_sm()
                .text_color(colors.disabled)
                .child("hit rate · last 24h"),
        )
        .child(
            div()
                .text_size(px(56.))
                .font_weight(FontWeight::BOLD)
                .child(format!("{:.1}%", stats.hit_rate_pct)),
        )
        .child(div().text_sm().text_color(colors.disabled).child(format!(
            "{} hits · {} misses",
            format_number(stats.hits()),
            format_number(stats.misses)
        )))
}

fn card(colors: &Colors, label: &str, value: String, hint: String) -> Div {
    div()
        .flex_1()
        .min_w(px(180.))
        .flex()
        .flex_col()
        .gap_1()
        .p_4()
        .rounded_lg()
        .border_1()
        .border_color(colors.border)
        .bg(colors.container)
        .child(
            div()
                .text_xs()
                .text_color(colors.disabled)
                .child(label.to_string()),
        )
        .child(
            div()
                .text_xl()
                .font_weight(FontWeight::SEMIBOLD)
                .child(value),
        )
        .child(div().text_xs().text_color(colors.disabled).child(hint))
}

fn format_number(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn format_duration(ms: u64) -> String {
    let seconds = ms / 1000;
    match seconds {
        0 => format!("{} ms", ms),
        1..=59 => format!("{seconds}s"),
        60..=3599 => format!("{}m {}s", seconds / 60, seconds % 60),
        _ => format!("{}h {}m", seconds / 3600, (seconds % 3600) / 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stats_report() {
        let json = br#"{
            "entries": 12,
            "hit_rate_pct": 62.5,
            "time_saved_ms": 90000,
            "local_hits": 8,
            "readonly_hits": 1,
            "remote_hits": 2,
            "prefetch_hits": 1,
            "misses": 5,
            "dups": 3,
            "disk": { "store_bytes": 2147483648, "store_limit_bytes": 10737418240 },
            "stores": [ { "path": "/home/me/.cache/kache", "entries": 12 } ]
        }"#;
        let stats: Stats = serde_json::from_slice(json).unwrap();
        assert_eq!(stats.hits(), 12);
        assert_eq!(stats.store_path(), "/home/me/.cache/kache");
        assert_eq!(format_bytes(stats.disk.store_bytes), "2.0 GiB");
        assert_eq!(format_duration(stats.time_saved_ms), "1m 30s");
        assert_eq!(format_number(stats.misses), "5");
    }

    #[test]
    fn formats_large_numbers() {
        assert_eq!(format_number(1_234_567), "1,234,567");
        assert_eq!(format_number(999), "999");
        assert_eq!(format_duration(250), "250 ms");
    }

    #[test]
    fn talks_to_kache() {
        let snapshot = query_kache().expect("kache stats should answer");
        assert!(snapshot.version.contains("kache"), "{}", snapshot.version);
        assert!(snapshot.stats.disk.store_limit_bytes > 0);
    }
}

//! UI views for the four Kawan v1 surfaces: Connect, Checklist, Conversations, Settings.

pub mod checklist;
pub mod connect;
pub mod conversation;
pub mod settings;

use crate::theme;

pub fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

pub fn status_color_hex(status: &str) -> u32 {
    match status {
        "running" | "verifying" => theme::CATEGORY_INDUSTRY,
        "review_requested" | "requested" => theme::CATEGORY_ACADEMIC,
        "landed" | "idle" => 0x284D32,
        "failed" | "stopped" => theme::CATEGORY_VALS,
        _ => theme::UMBER_VIVID,
    }
}

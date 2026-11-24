//! UI views for Kawan surfaces: Connect, Checklist, Merge Queue, Issues, Conversations, Settings.

pub mod checklist;
pub mod connect;
pub mod conversation;
pub mod issues;
pub mod markdown;
pub mod merge_queue;
pub mod settings;

use crate::theme;

pub fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

pub fn status_color_hex(status: &str) -> u32 {
    match status {
        "running" | "verifying" | "rebasing" | "open" => theme::CATEGORY_INDUSTRY,
        "proposed" | "queued" | "pending_approval" => theme::CATEGORY_ACADEMIC,
        "landed" | "idle" | "passed" => 0x284D32,
        "failed" | "stopped" | "paused" | "withdrawn" => theme::CATEGORY_VALS,
        "closed" => theme::UMBER_VIVID,
        _ => theme::UMBER_VIVID,
    }
}

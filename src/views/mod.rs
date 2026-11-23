//! UI views for Kawan surfaces: Connect, Checklist, Status, Merge Queue, Issues, Conversations, Settings.

pub mod checklist;
pub mod connect;
pub mod conversation;
pub mod issues;
pub mod merge_queue;
pub mod settings;
pub mod status;

use crate::theme;

pub fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

pub fn status_color_hex(status: &str) -> u32 {
    match status {
        "running" | "verifying" | "rebasing" | "implementing" | "reviewing" => {
            theme::CATEGORY_INDUSTRY
        }
        "review_requested" | "requested" | "queued" | "pending_approval" | "ready_to_land" => {
            theme::CATEGORY_ACADEMIC
        }
        "landed" | "idle" => 0x284D32,
        "failed" | "stopped" | "paused" | "needs_input" => theme::CATEGORY_VALS,
        "backlog" | "closed" => theme::UMBER_VIVID,
        _ => theme::UMBER_VIVID,
    }
}

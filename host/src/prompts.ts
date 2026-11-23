/**
 * Copy shown in review cards: the Status view sections (Needs You, Waiting to
 * Land, Shipped), land approvals, and session drawers. Humans approve from
 * these cards without opening the diff, so the text must read like a product
 * changelog rather than a commit summary.
 */
export const REVIEW_CARD_SUMMARY_RULES = [
  "Review-card summary rules (humans read this in the Status view and approval cards; they are not looking at the code):",
  "- Lead with the user-visible outcome: what changed and what someone can now do. Keep it to 1-3 plain sentences, changelog style.",
  "- Leave implementation out: no file names or paths, component/function/class names, HTML/CSS/markup, line numbers, branch names, commit SHAs, or internal session IDs.",
  '- Describe verification at a human level ("checks pass", "tried the new flow") instead of naming tests, commands, or pasting logs.',
  '- When the change is visible, attach a screenshot or image artifact via report(..., { path: "screenshot.png" }) so the reviewer can see the result; do not describe the pixels in prose.',
  "- Put file-by-file details, diffs, logs, and edge-case notes in an optional report.md artifact, not in the card text.",
].join("\n");

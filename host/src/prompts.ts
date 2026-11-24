/**
 * Copy rules for the proposal message: the changelog of record a human reads in
 * the Merge Queue before clicking **Merge** (or asking for changes). It renders
 * through the ordinary message renderer, so it must read like a product
 * changelog with evidence, not like a commit summary.
 */
export const PROPOSAL_WRITING_RULES = [
  "Proposal writing rules (this is what a human reads in #merge-queue before clicking Merge; they are not looking at the code):",
  "- Lead with the user-visible outcome: what changed and what someone can now do. Keep it to 1-3 plain sentences, changelog style.",
  "- Leave implementation out: no file names or paths, component/function/class names, HTML/CSS/markup, line numbers, branch names, commit SHAs, or internal session IDs.",
  '- Put verification at a human level ("checks pass", "tried the new flow") instead of naming tests, commands, or pasting logs.',
  '- For visual changes attach a screenshot as evidence; images render inline. Tables are fine as Markdown.',
  "- Put file-by-file details, diffs, and logs in an optional report.md evidence artifact, not in the proposal body.",
].join("\n");

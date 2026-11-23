## Purpose & Unification

v1 proves the core chat-to-worker-to-land loop for individual requests. v2 adds
durable task authoring, automated multi-reviewer iteration, repo-wide visibility,
and a serialized merge queue without splitting Kawan into separate products:

- **One delivery pipeline:** ad-hoc `@bot` tasks started in channels/DMs and formal
  markdown issues feed the same **Status** ledger and **Merge Queue**.
- **One conversation substrate:** rather than inventing separate comment boxes or
  floating reconciliation inputs, **Issues** and **Merge Queue** reuse Kawan's
  existing `conversations`, `messages`, sequence replay, threads, `artifacts`, and
  composer.

## Conversation Kinds & Routing Boundary

`conversations.kind` expands from `('channel', 'dm')` to
`('channel', 'dm', 'issue', 'merge_queue')`. Every conversation shares the same
message stream and thread model, while the UI wraps `issue` and `merge_queue` in
purpose-built top chrome.

To match how teams iterate on specs and prototypes while keeping the final review
loop crisp, issues operate across three gears (**Collaborate → Review Cycle → Merge
Queue**) instead of locking work behind a hard draft-vs-run split:

- **SubQ Snap routes** `channel`, `dm`, **collaborative `issue` conversations (both
  drafting and implementation)**, and idle/freeform chat in `#merge-queue`:
  - While an issue is in **Collaborate** (`backlog` / `implementing`), it behaves
    like a normal Kawan conversation: humans can discuss artifacts with each other
    (`none`), steer the implementer in new directions, or adjust scope together.
  - Before an implementer is assigned, bot-directed messages go to the
    orchestrator (`update_issue`, brainstorming). Once an implementer is assigned,
    bot-directed messages route to the issue's implementer session (or hold/steer
    naturally through Snap).
- **Host state machines route deterministically** only during automated Review
  Cycle gates and Merge Queue triage:
  - Host-posted workflow cards (CI results, review verdicts, `@owner` prompts,
    queue pause notices) never re-enter SubQ Snap routing.
  - When paused in `needs_input` during a Review Cycle, a reply from `owner_id`
    (or an explicit redirect) resumes the paused agent directly with that answer.
  - Replies inside an active `#merge-queue` incident thread route straight to the
    Queue Bot's paused landing session for that item.
  - A human can pull an issue back out of the Review Cycle into **Collaborate** at
    any time if the underlying direction needs to change.

## Navigation & Repository Status

The left rail adds two top-level views plus the Merge Queue above `CHANNELS`:

```text
Status           (badge when Needs You / Waiting to Land is non-empty)
Merge Queue      (live pill: running count or paused alert)
Issues           (open/active count)
──────────
CHANNELS
#general
...
```

The `36px` bottom session strip also carries a compact Merge Queue status pill on
its right edge whenever items are queued or the queue is paused, linking directly
to **Merge Queue** from anywhere in the app.

**Status** is the single repo-wide delivery view across both formal issues and
ad-hoc chat work, arranged top to bottom by attention priority:

1. **Needs You** (shown only when non-empty): items paused in `needs_input` awaiting
   an `@owner` reply, plus a paused Merge Queue banner linking into `#merge-queue`.
2. **Waiting to Land:** finished branches awaiting manual human sign-off, showing
   CI and reviewer verdicts, an expandable `report.md`, origin link (`#issue` or
   chat thread), and one-click `Approve Land` (which enqueues onto the Merge Queue).
3. **In Flight:** currently running sessions and issue loops across all channels
   and issues, showing stage (`Implementing`, `Verifying`, `Reviewing 1/2`,
   `Revising`), active round, participating bots, and click-to-inspect.
4. **Shipped:** reverse-chronological changelog of landed work centered on task
   title, participants (implementer, reviewers, approver), timestamp, origin link,
   and expandable `report.md`—keeping raw branches and commit SHAs tucked behind
   on-demand inspection.

## Issues & Multi-Reviewer Workflow

Issues replace chat-buried work tracking with trimmed-down PR-style rooms backed by
SQLite and a host-driven loop.

### Data Model

- **`issues`:** `id`, `number` (sequential `#1`, `#2`, ...), `conversation_id`
  (`kind = 'issue'`), `title`, `body_md`, `status` (`backlog`, `implementing`,
  `verifying`, `reviewing`, `needs_input`, `ready_to_land`, `queued`, `landed`,
  `closed`), `owner_id`, `implementer_bot_id`, `auto_start_review` (boolean:
  interactive collaborative default `false` vs autonomous transition `true`),
  `landing_mode` (`manual` | `auto`), `max_rounds`, `current_round`,
  `active_session_id`, `parent_issue_id` (optional epic link), `created_at`,
  `updated_at`.
- **`issue_reviewers`:** `id`, `issue_id`, `bot_id`, `focus` (optional short prompt
  such as `"Correctness & edge cases"` or `"Security"`), `order_index`. Stored as a
  list of slots rather than a unique bot set so a single-bot workspace can run one or
  more focused passes with the same bot model while multi-bot setups can assign
  distinct reviewers.
- **`issue_reviews`:** `id`, `issue_id`, `round`, `reviewer_slot_id`, `session_id`,
  `verdict` (`approve` | `request_changes` | `needs_owner`), `summary`,
  `notes_artifact_id`, `created_at`.

### Authoring & Assignment

- **PR-style Issue room:** pinned markdown spec header paired with
  status/assignment pills and the conversation + event stream below. The markdown
  spec stays editable throughout implementation (by humans, orchestrators, or the
  issue's implementer via `update_issue`) so spec and code can evolve together.
- **Orchestrator issue tools:** `create_issue`, `update_issue`, and `list_issues`
  let humans brainstorm in `#general`, DMs, or an issue room and have an
  orchestrator (or active issue implementer) draft or update the spec cleanly.
- **Assign & Run modal:** configures Owner (defaults to creator), Implementer bot,
  `0..N` Reviewer slots (`bot` + optional `focus`), transition mode (**Interactive**
  collaborative default vs **Autonomous** `auto_start_review` for crisp bugs/tasks),
  `landing_mode` (`manual` | `auto`, defaulting to host setting), and `max_rounds`
  (default `3`). Submitting transitions the issue from `backlog` to `implementing`.

### Collaborate → Automated Review Cycle

```text
Collaborate (SubQ Snap routed — fluid human + bot iteration)
  backlog ──► implementing  (implementer posts artifacts, humans critique & redirect)
                    │
         Start Review Cycle (button / chat trigger / auto_start_review)
                    ▼
Review Cycle (deterministic host state machine)
  verifying (.kawan/checks/* in sandbox)
    ├─ fail ──► revising (same worker resumed with check output) ──► verifying
    └─ pass ──► reviewing  (0 reviewers ─► ready_to_land / queued;
                            N reviewers ─► parallel read-only sessions)
                  ├─ all approve ────────► ready_to_land or auto-queued
                  ├─ request_changes ────► revising (same worker, bundled feedback, round + 1)
                  ├─ needs_owner ────────► needs_input (paused, @owner pinged)
                  └─ round >= max_rounds ► needs_input (circuit breaker, @owner decides)
    ▲                                                              │
    └─────── Return to Collaborate (human escape hatch) ◄──────────┘
```

Loop rules and guardrails:

- **Fluid implementation:** During `implementing`, the implementer shares builds,
  screenshots, and `report.md` artifacts in the issue room without entering the
  review machine. Humans can discuss what they see, change direction, or update the
  markdown spec across arbitrary iterations until they are satisfied with the shape
  of the solution and trigger **Start Review Cycle** (or skip straight there when
  `auto_start_review` is enabled).
- **Persistent implementer, fresh read-only reviewers:** Both collaborative turns
  and Review Cycle revisions resume the implementer's existing `pi` session so
  earlier design decisions stay in context. Reviewers spawn in fresh read-only
  sessions over the branch diff, issue spec, implementer summary, and prior-round
  notes, and finish via `submit_review(verdict, summary, notes_md?)` — with no
  commit rights.
- **Anti-bikeshedding on Round 2+:** Reviewer prompts on round 2+ instruct reviewers
  to verify prior blocking items and regressions rather than inventing new style nits.
  `max_rounds` enforces a hard circuit breaker that pauses for `@owner`.
- **Owner escalation (`ask_owner`) & escape hatch:** Inside a Review Cycle, either
  the implementer or a reviewer can pause with a question (`needs_input`, `@owner`
  pinged, lighting up `Needs You` without spamming `#general`), and a human can click
  **Return to Collaborate** at any time to drop back into open-ended iteration.
- **Views:** Issues defaults to a grouped flat list (filterable by status/owner)
  with an optional **Board** toggle scoped strictly to active pipeline columns
  (`Implementing`, `Reviewing`, `Needs Input`, `Ready to Land`), keeping `Backlog`
  and `Landed` out of the 2D board.

## Repo-Native CI (`.kawan/checks/*`)

Verification moves from a single opaque host string to versioned repo scripts with
zero YAML DSL:

- **Discovery & execution:** When `.kawan/checks/` exists in the branch checkout, the
  host collects executable files sorted lexicographically by filename (e.g.,
  `01-fmt`, `02-clippy`, `03-test`) and runs each inside the session/landing
  sandbox (`bwrap`), recording each check's status, exit code, and full
  stdout/stderr as a content-addressed artifact. If `.kawan/checks/` does not exist,
  execution falls back to `.kawan/ci` if present, otherwise to the host Settings
  `verify_command`.
- **Two gates:** CI runs (1) **pre-review** on the implementer's branch so reviewers
  never waste turns on broken builds or failing tests, and (2) **pre-land** inside
  the Merge Queue after rebasing onto latest `default_branch`.
- **CI self-modification guard:** If a branch's diff touches `.kawan/*`, auto-land is
  forcibly downgraded to `manual` and the UI displays a `Modifies .kawan/ checks`
  warning requiring human approval before landing.

## Merge Queue & `#merge-queue`

A single serialized FIFO queue per host replaces uncoordinated per-session landing.

### Data & Configuration

- **Host settings:** `queue_bot_id` (required to run automated reconciliation;
  defaults to the configured bot when one exists), `default_landing_mode`
  (`manual` | `auto`), and `conflict_policy`:
  - `pause_on_issue` (default): any conflict or post-rebase check failure pauses the
    queue for human reconciliation after the Queue Bot diagnoses it.
  - `auto_resolve_trivial`: Queue Bot may attempt clean, unambiguous conflict fixes
    and re-run checks automatically, pausing only on semantic ambiguity or repeat
    check failure.
- **`lands` extensions:** `queue_position`, `issue_id` (nullable for ad-hoc chat
  tasks), `status` (`queued` | `rebasing` | `verifying` | `paused` | `landed` |
  `failed` | `removed`), `pause_reason`, `queue_session_id`, and `trigger`
  (`manual_approve` | `auto_land`).

### Execution & Reconciliation Flow

1. **Enqueue:** `Approve Land` (from chat, an issue, or Status) or an issue's
   `auto_land` transition appends an entry to `lands` (`status = 'queued'`). Order is
   preserved strictly: while the queue is paused, later entries wait rather than
   skipping ahead.
2. **Host fast-path (quiet on success):** For the head item (`#1`), the host creates
   a clean landing clone of `default_branch`, fetches the candidate branch, rebases,
   and runs `.kawan/checks/*`. If rebase is clean and every check exits `0`, the host
   fast-forwards `default_branch` immediately with zero LLM turns, writes the
   `Shipped` record, and closes any linked issue (`landed`). Clean merges do not
   clutter `#merge-queue`.
3. **Friction path (strict pause + Queue Bot in `#merge-queue`):** If rebase
   conflicts or `.kawan/checks/*` fail:
   - The queue pauses immediately (`paused`) at `#1`.
   - The Queue Bot spins up (or resumes) a landing-clone session for `#1`, inspects
     the conflict/diff/check artifact, posts a top-level incident card in
     `#merge-queue` summarizing what conflicted or failed (with diff/log artifacts
     attached), and waits for humans in that incident thread.
   - Humans inspect and converse multi-turn with the Queue Bot (and `@`-mention
     teammates) in the `#merge-queue` thread, or use deterministic controls in the
     Merge Train header: **Retry checks**, **Send back to implementer & Resume**
     (ejects `#1` to `implementing` and unpauses `#2`), or **Defer / Remove**.
   - Once instructed, the Queue Bot applies the fix inside the landing clone and
     calls `resume_and_land` (which re-runs full `.kawan/checks/*` before pushing
     and advancing `#2`) or `eject_to_implementer`.

### `#merge-queue` UI

Opening **Merge Queue** displays a pinned **Merge Train** header above the standard
`#merge-queue` conversation stream:

- **Header:** Queue state pill (`Idle` / `Running` / `Paused`), assigned `Queue bot`
  selector, conflict policy badge, and `Pause` / `Resume` button.
- **Head slot (`#1 · Now Landing`):** Title, origin link (`#issue` or chat thread),
  3-stage progress (`Rebase → Checks [named .kawan/checks/* pills] → Land`),
  artifact/log inspector, and quick action buttons (`Retry checks`,
  `Send back to implementer`, `Defer`) when paused.
- **Queued rows (`#2`, `#3`, ...):** Compact queue list with trigger source
  (`approved by @user` or `auto-queued`) and `Remove` (returns item to
  `Waiting to Land` without discarding its branch).

## Slices

Each slice builds incrementally and remains verifiable end-to-end:

1. **Slice A — Repository Status:** Left-rail **Status** screen built over existing
   `sessions`, `lands`, and `artifacts` (*Needs You*, *Waiting to Land*, *In Flight*,
   *Shipped*).
2. **Slice B — `.kawan/checks/*` CI + Serialized Merge Queue + `#merge-queue`:**
   Sandboxed `.kawan/checks/*` runner, FIFO queue serialization, Merge Train UI, and
   Queue Bot reconciliation thread for all landings.
3. **Slice C — Markdown Issues + Collaborative Implementation:**
   `kind = 'issue'` conversations, continuously editable markdown spec, issue authoring
   tools, SubQ Snap–routed collaborative implementation turns with artifact iteration,
   and `Start Review Cycle` / `ask_owner` escalation feeding into Status and the Merge
   Queue.
4. **Slice D — Automated Multi-Reviewer Loop + Configurable Auto-Land + Active Board View:**
   Parallel `N`-reviewer slots with focus prompts, `auto_start_review` option, round
   cap circuit breaker with **Return to Collaborate** escape hatch, configurable
   `auto_land` (with `.kawan/*` safety downgrade), and active-pipeline Board toggle.

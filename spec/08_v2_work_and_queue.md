## Purpose & Unification

v1 proves the core chat-to-worker-to-land loop for individual requests. v2 adds
durable Markdown issue rooms, repo-native checks, bot-to-bot collaboration,
repo-wide visibility, and a serialized merge queue without inventing parallel
state machines or separating Issues from Kawan's core chat model:

- **One delivery pipeline:** ad-hoc `@bot` tasks started in channels/DMs and
  Markdown issue rooms feed the same **Status** ledger and **Merge Queue**, and
  any ad-hoc worker session can graduate into an issue (`#N`) via one-click
  **Promote to Issue** carrying its existing clone, branch, session, and artifacts.
- **One conversation substrate:** rather than inventing modal wizards, dedicated
  review state machines, or separate comment forms, **Issues** and **Merge
  Queue** reuse Kawan's `conversations`, `messages`, sequence replay, threads,
  `artifacts`, and composer — adding only what each surface genuinely needs (a
  central editable Markdown document + branch bar for issues, and the Merge Train
  header for `#merge-queue`).

## Conversation Kinds & Routing Boundary

`conversations.kind` expands from `('channel', 'dm')` to
`('channel', 'dm', 'issue', 'merge_queue')`. Every conversation shares the same
message stream and thread model, while the UI wraps `issue` and `merge_queue` in
lightweight top chrome.

### Bot-to-Bot Routing Everywhere

Conversational messages from **both humans and bots** pass through **SubQ Snap**
(`route_message`) across **channels, DMs, and issue rooms** alike. That lets bots
talk to one another naturally — delegating, asking questions, posting code
review findings in an issue room so the implementer sees them and responds, or
coordinating across channels — using the same routing primitive humans use.

Three strict rules keep routing safe and predictable without adding premature
heuristics:

1. **Never route self:** A bot never routes messages it authored itself.
2. **Host notices never wake bots:** Deterministic host-posted cards and notices
   (implicit check checkpoints, land notices, `#merge-queue` incident cards) do
   not enter `route_message`.
3. **Lightweight SubQ Snap anti-chatter guidance:** When the incoming author is a
   bot, the host passes `author_kind: "bot"` and instructs `route_message` to
   treat polite closings, acknowledgements, status confirmations, or bare approvals
   (`"thanks"`, `"LGTM"`, `"looks good"`, `"done"`, `"fixed"`) as `none`, while
   routing genuine review findings, questions, or direct `@` requests cleanly.
   No artificial turn caps or sibling-batching timers are added on top.

Two deterministic host routing exceptions remain outside SubQ Snap:

- If a bot explicitly paused with `ask_owner(question)` on an open issue, the
  owner's next reply answers that pending question (`needs_input_question`) and
  clears it directly to the implementer worker.
- Replies inside an active `#merge-queue` incident thread route straight to the
  Queue Bot's paused landing session for that item. (Bot-authored messages never
  auto-route inside `#merge-queue`.)

### Spawn-Intent Gate (Decision Model)

To stop accidental worker spawns during casual or exploratory chat without nagging
users on direct commands, `route_message` evaluates two strict binary `yes`/`no`
questions alongside `destination` and `readiness`:

- **`explicit_work_start` (`yes` | `no`):** Direct, unambiguous instruction to
  start implementing or changing code right now (e.g., `"@bot fix the flaky header
  test"`, `"@bot go ahead and add that flag"`).
- **`work_request` (`yes` | `no`):** The user is actually asking or expecting the
  bot to take on a concrete task, even if phrased politely or indirectly (e.g.,
  `"@bot the CI build is flaky, could you take a look?"`). Strictly **`no`** for
  questions, brainstorming, hypotheticals (`"what would it take to..."`, `"should
  we eventually..."`), or open-ended discussion so it never fires on a hair trigger.

The host enforces the gate mechanically whenever an orchestrator calls
`spawn_session` to start a writable worker clone:

| `explicit_work_start` | `work_request` | Example | Host behavior on `spawn_session` |
|---|---|---|---|
| `yes` | `yes` | `"@bot fix the flaky header test"` | **Start immediately** and render an inline running task card with `[ Stop ]` and `[ Promote to Issue ]` (or bind the branch if inside an issue room without one) |
| `no` | `yes` | `"@bot the CI build is flaky, could you take a look?"` | Hold in `pending_approval` behind an inline `[ Start ] [ Dismiss ]` card (zero clone or worker tokens until clicked; `[ Dismiss ]` records a host back-off note in orchestrator context) |
| `no` | `no` | `"@bot what would it take to add dark mode?"` | **Block spawn** — host tells orchestrator no work was requested so it replies conversationally without emitting a proposal card |

Read-only reviewer passes have no write side effects and do not hold behind
`pending_approval`. Criteria are calibrated empirically with `routing-harness.ts`.

## Navigation & Repository Status

The left rail adds two top-level views plus the Merge Queue above `CHANNELS`:

```text
Status           (badge when Needs You / Waiting to Land is non-empty)
Merge Queue      (live pill: running count or paused alert)
Issues           (open issue count)
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

1. **Needs You** (shown only when non-empty): items with a pending `@owner`
   `ask_owner` question, failed sessions/lands, pending spawn approvals, or a
   paused Merge Queue banner linking into `#merge-queue`.
2. **Waiting to Land:** finished ad-hoc sessions requesting land and Merge Queue
   items currently `queued` / `rebasing` / `verifying`, leading with a concise
   user-facing changelog summary (user-visible outcome, not file-level
   implementation) plus any attached screenshot evidence, showing checks, an
   expandable `report.md`, origin link, and one-click `Approve Land` / queue links.
3. **In Flight:** currently running or active worker sessions and open active
   issues (including active read-only reviewer passes), showing concrete activity
   (working, reviewing, idle branch with commits/checks) and click-to-inspect.
4. **Shipped:** reverse-chronological changelog of landed work centered on a
   short user-facing outcome summary, task title, participants, timestamp, origin
   link, screenshot evidence when attached, and an expandable `report.md`—keeping
   raw branches and commit SHAs tucked behind on-demand inspection.

Every review card is written for the person approving from the card, not for
someone reading the diff: 1-3 sentences of plain-language change, with file
names, markup, logs, branches, and commits left to `report.md` or the Changes
drawer. Visual changes carry a screenshot artifact on the card.

### Two-Tier Unread & Attention (`read_cursors`)

As asynchronous activity spans channels, issues, and `#merge-queue`, a lightweight
`(user_id, conversation_id, last_read_seq)` cursor table distinguishes ambient
updates from required action in the left rail:

- **Quiet unread dot:** new messages, artifacts, or comments arrived past
  `last_read_seq` without requiring human intervention.
- **Loud action badge:** `@you` (`ask_owner`), `Waiting to Land`, or
  `Merge Queue paused`.

## Issues: Chat-First Rooms + Central Markdown Document

Rather than imposing a multi-stage workflow wizard, an **Issue (`#N`)** is simply
a Kawan conversation (`kind = 'issue'`) anchored by a **central, continuously
editable Markdown document** and an **attached branch** once a bot begins
implementing.

### Data Model

- **`issues`:** `id`, `number` (sequential `#1`, `#2`, ...), `conversation_id`
  (`kind = 'issue'`), `title`, `body_md`, `status` (`open` | `landed` | `closed`),
  `owner_id`, `implementer_bot_id` (nullable until a bot claims the branch),
  `active_session_id` (nullable worker session owning the writable branch),
  `parent_issue_id` (optional epic link), `needs_input_question` (optional owner
  prompt set by `ask_owner`), `behind_main`, `commits_ahead`, `checks_status`
  (`none` | `running` | `passed` | `failed`), `checks_sha`, `checks_summary`,
  `checks_json`, `checks_artifact_id`, `touches_kawan`, `created_at`,
  `updated_at`. (Plus ephemeral `active_reviewers` runtime status on open rooms.)

All workspace humans and bots are members of every open issue room (and newly
created bots join open issues automatically), so anyone can be `@`-mentioned in
chat at any time without pre-configuring assignment or reviewer slots.

### Central Live Document (`kawan://issue.md`)

- **Editable Markdown Document panel:** Prominently rendered (and collapsible to a
  1-line bar) above the issue's message stream. Humans can click `Edit` to refine
  the title and Markdown specification at any point; orchestrators and the
  issue's implementer worker can also update it with `update_issue`.
- **Dynamic context injection (`kawan://issue.md`):** On every turn inside an
  issue room — whether an orchestrator turn, an implementer worker turn, or a
  read-only reviewer pass — `get_context` dynamically injects `kawan://issue.md`
  alongside `kawan://soul.md`. Every participant always sees the latest spec,
  branch owner, commit count, divergence from `default_branch`, and latest
  check result (plus any failure excerpt).

### Starting Work, Branch Ownership & Read-Only Reviewing

Issues reuse `@mention` chat and SubQ Snap directly — there is no `Assign & Run`
wizard or `Start Review Cycle` modal:

1. **Authoring & discussion:** Create an issue (`Title` + optional `Markdown` body),
   or brainstorm in chat with `@bot` to create/edit via `create_issue` /
   `update_issue`.
2. **Implementing (`@coder implement this`):**
   - When the user instructs a bot to work inside an open issue room, SubQ Snap +
     the spawn-intent gate run normally (`yes/yes` starts immediately; `no/yes`
     renders `[ Start ] [ Dismiss ]`).
   - If the issue does not yet have an active branch, spawning binds the new
     writable worker clone/branch (`kawan/issue-N-...`) to the issue
     (`active_session_id`, `implementer_bot_id`).
   - If the same bot already owns the issue's branch, subsequent steering resumes
     or steers its existing persistent worker session.
   - **No `land_request` trap:** Issue workers simply commit on their branch and
     report progress in the room — humans decide when to click **Land**.
3. **Reviewing (`@rev1 @rev2 review this`, or `review_issue` in 1-bot rooms):**
   - Only **one bot owns the writable branch** on an issue at a time.
   - Any **other** bot asked to review or work on an issue that already has a live
     writable branch automatically runs a **fresh read-only reviewer session**
     (`role: "reviewer"`, `--exclude-tools bash,edit,write`, `bwrap --ro-bind`)
     over the implementer's clone + diff + `kawan://issue.md`.
   - In a **single-bot workspace**, orchestrators and issue workers also expose
     `review_issue(issue_ref?, focus?)` so asking `"@bot review this"` spawns a
     fresh read-only reviewer pass against its own branch instead of reviewing in
     the same implementation context.
   - Reviewers post their findings directly into the issue room as themselves (via
     `report(text, artifact?)` or reply). Via bot-to-bot routing, the branch
     owner's worker sees the critique, fixes the code/tests on its branch, pushes
     a new commit, and replies back cleanly — continuing until both sides converge
     (with polite `LGTM` / sign-offs routed as `none`).

### Implicit `.kawan/checks/*` (Always Knowable, Never Auto-Retrying)

Verification scripts stay quiet when everything works and stay immediately
visible whenever you glance at the issue:

- **When checks run automatically:** The host runs `.kawan/checks/*` (falling back
  to `.kawan/ci`, then host `verify_command`) inside a sandbox (`bwrap`) in the
  background on the issue's clone whenever:
  1. An issue worker finishes a turn with a clean working tree, `commits_ahead >= 1`,
     and a `HEAD` SHA that differs from `checks_sha`;
  2. `Sync with main` cleanly rebases new commits; or
  3. An open issue is opened (`issue.open`) whose current `HEAD` SHA hasn't been
     checked yet.
- **Unconfigured repos:** If `.kawan/checks/*`, `.kawan/ci`, and `verify_command`
  are all absent, `checks_status` stays `none` rather than showing a false failure.
- **No auto-retry on failure:** If a check fails, the host stores the combined
  log artifact (`checks_artifact_id`), sets `checks_status = 'failed'`, and
  surfaces **`Checks ✗`** in the live bar and `kawan://issue.md` — **without**
  automatically re-running or waking the implementer. If something is broken,
  humans or reviewers see it explicitly and decide what to do next.
- **Worker checkpoints:** When an issue worker finishes a turn with commits, a
  concise non-routed host checkpoint note records commit count and check status.

### Live Activity Bar, Landing & Other Controls

- **Concrete Live Branch & Activity Bar (Issue Room):** One compact bar under the
  header shows concrete reality rather than abstract workflow phase names:
  - Draft: `No branch yet — @mention a bot below to start`
  - Working / Reviewing: `● @coder working…` / `● @rev reviewing…` + `[ Stop ]`
  - Idle with branch: `@coder idle · N commits · M behind main · Checks ✓/✗`
    (clicking `Checks ✓/✗` opens its log artifact) + `[ Changes ]`,
    `[ Sync with main ]`, and primary **`[ Land ]`**
  - Queued / Landed: `Queued #1 in #merge-queue` / `Landed`
- **Direct `[ Land ]` (`issue.land`):** Available directly whenever an `open`
  issue has a clean branch with `commits_ahead >= 1` and is not currently queued
  or landing — no intermediate `Ready to Land` transition required. Clicking
  `Land` enqueues onto `#merge-queue`.
- **Escape & utility controls:**
  - **`ask_owner(question)`:** Optional pause banner (`needs_input_question`)
    pinging `@owner` without trapping the issue in a rigid state machine.
  - **`Sync with main`:** Rebases the issue's branch onto latest `default_branch`
    and re-runs implicit checks when commits moved.
  - **`Stop` / `Close` / `Abandon`:** Cleanly stops active worker/reviewer
    sessions and optionally cleans up unlanded clones.
  - **`Promote to Issue`:** Converts any ad-hoc chat worker session into `#N`
    preserving clone, branch, session, and artifacts.
  - **Soul learning loop (`06_memory.md`):** After an issue lands, a concise
    post-landing digest returns to the implementer bot's orchestrator so durable
    lessons fold into `kawan://soul.md`.
- **Views:** The Issues list shows two clean groups — **Open** (with concrete
  live pills: `Draft`, `Working`, `Reviewing`, `N commits`, `Checks ✓/✗`,
  `Queued`, `Modifies .kawan/`) and **Landed / Closed** — without a 4-column
  waterfall Board.

## Repo-Native CI (`.kawan/checks/*`)

- **Discovery & execution:** When `.kawan/checks/` exists in the branch checkout,
  the host collects executable files sorted lexicographically by filename (e.g.,
  `01-fmt`, `02-clippy`, `03-test`) and runs each inside the session/landing
  sandbox (`bwrap`), recording each check's status, exit code, and full
  stdout/stderr as a content-addressed artifact. If `.kawan/checks/` does not
  exist, execution falls back to `.kawan/ci` if present, otherwise to the host
  Settings `verify_command`.
- **Two places checks run:** (1) **implicitly** on open issue branches after new
  commits/rebases (never auto-retrying), and (2) **pre-land** deterministically
  inside the Merge Queue after rebasing onto latest `default_branch`.
- **`.kawan/` modification guard:** If a branch's diff touches `.kawan/*`, the UI
  surfaces a **`Modifies .kawan/ checks`** warning and auto-land is never
  bypassed without explicit human landing.

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

1. **Enqueue:** `Approve Land` (from chat or Status) or **`Land`** (from an issue
   room) appends an entry to `lands` (`status = 'queued'`). Order is preserved
   strictly: while the queue is paused, later entries wait rather than skipping
   ahead.
2. **Host fast-path (quiet on success):** For the head item (`#1`), the host creates
   a clean landing clone of `default_branch`, fetches the candidate branch, rebases,
   and runs `.kawan/checks/*`. If rebase is clean and every check exits `0`, the host
   fast-forwards `default_branch` immediately with zero LLM turns, writes the
   `Shipped` record, and marks any linked issue `landed`. Clean merges do not
   clutter `#merge-queue`.
3. **Friction path (strict pause + Queue Bot in `#merge-queue`):** If rebase
   conflicts or `.kawan/checks/*` fail:
   - The queue pauses immediately (`paused`) at `#1`.
   - The Queue Bot spins up (or resumes) a landing-clone session for `#1`, inspects
     the conflict/diff/check artifact, posts a top-level incident card in
     `#merge-queue` summarizing what conflicted or failed (with diff/log artifacts
     attached), and waits for humans in that incident thread.
   - Humans inspect and converse multi-turn with the Queue Bot in `#merge-queue`,
     or use deterministic controls in the Merge Train header: **Retry checks**,
     **Send back to implementer & Resume** (ejects `#1` back to its room/owner
     and unpauses `#2`), or **Defer / Remove**.
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
- **Queued rows (`#2`, `#3`, ...):** Compact queue list with trigger source and
  `Remove` (returns item out of queue without discarding its branch).

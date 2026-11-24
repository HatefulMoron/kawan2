## Purpose & Unification

v1 proves the core chat-to-worker-to-land loop for individual requests. v2 adds
durable Markdown issue rooms, repo-native checks, bot-to-bot collaboration,
repo-wide visibility, and a serialized merge queue without inventing parallel
state machines or separating Issues from Kawan's core chat model:

- **One delivery pipeline:** ad-hoc `@bot` tasks started in channels/DMs and
  Markdown issue rooms both end in the same proposal path and **Merge Queue**, and
  any ad-hoc worker session can graduate into an issue (`#N`) via one-click
  **Promote to Issue** carrying its existing clone, branch, session, and artifacts.
  Proposals are defined in `09_proposals.md`.
- **One conversation substrate:** rather than inventing modal wizards, dedicated
  review state machines, or separate comment forms, **Issues** and **Merge
  Queue** reuse Kawan's `conversations`, `messages`, sequence replay, threads,
  `artifacts`, and composer — adding only what each surface genuinely needs (a
  central editable Markdown document + branch bar for issues, and the Merge Train
  header + `Proposed` section for `#merge-queue`).

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
2. **Host notices never wake bots:** Deterministic host-posted notices
   (implicit check checkpoints, proposal create/amend notices, land notices,
   `#merge-queue` incident cards) do not enter `route_message`.
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
| `yes` | `yes` | `"@bot fix the flaky header test"` | **Start immediately**; the worker appears in the bottom session strip (or the branch is bound if inside an issue room without one) |
| `no` | `yes` | `"@bot the CI build is flaky, could you take a look?"` | Hold in `pending_approval` behind an inline `[ Start ] [ Dismiss ]` card (zero clone or worker tokens until clicked; `[ Dismiss ]` records a host back-off note in orchestrator context) |
| `no` | `no` | `"@bot what would it take to add dark mode?"` | **Block spawn** — host tells orchestrator no work was requested so it replies conversationally and proposes nothing |

Read-only reviewer passes have no write side effects and do not hold behind
`pending_approval`. Criteria are calibrated empirically with `routing-harness.ts`.

## Navigation

The left rail shows the Merge Queue and Issues above `CHANNELS`:

```text
Merge Queue      (live pill: proposed/running count or paused alert)
Issues           (open issue count)
──────────
CHANNELS
#general
...
```

The `36px` bottom session strip also carries a compact Merge Queue status pill on
its right edge whenever proposals or queued items exist or the queue is paused,
linking directly to **Merge Queue** from anywhere in the app.

In-flight visibility is limited to the bottom session strip, the issue room live
activity bar, the session drawer, and the spawn-approval row.

### Two-Tier Unread & Attention (`read_cursors`)

As asynchronous activity spans channels, issues, and `#merge-queue`, a lightweight
`(user_id, conversation_id, last_read_seq)` cursor table distinguishes ambient
updates from required action in the left rail:

- **Quiet unread dot:** new messages, artifacts, proposals, or comments arrived
  past `last_read_seq` without requiring human intervention.
- **Loud action badge:** `@you` (`ask_owner`) or `Merge Queue paused`.

The same cursor drives the "updated since you viewed" dot on proposal rows in
`#merge-queue` (`09_proposals.md`).

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
   - **Propose, don't land:** committing lands nothing. When the work is ready,
     the worker or orchestrator calls `propose_merge` and the proposal appears in
     `#merge-queue`; humans decide when to click **Merge**
     (`09_proposals.md`).
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
     `report(text, artifacts?)` or reply). Via bot-to-bot routing, the branch
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

### Live Activity Bar, Proposals & Other Controls

- **Concrete Live Branch & Activity Bar (Issue Room):** One compact bar under the
  header shows concrete reality rather than abstract workflow phase names:
  - Draft: `No branch yet — @mention a bot below to start`
  - Working / Reviewing: `● @coder working…` / `● @rev reviewing…` + `[ Stop ]`
  - Idle with branch: `@coder idle · N commits · M behind main · Checks ✓/✗`
    (clicking `Checks ✓/✗` opens its log artifact) + `[ Changes ]`,
    `[ Sync with main ]`, and primary **`[ Propose ]`**
  - Proposed / Landed: `Proposed · in Merge Queue` / `Landed`
- **Direct `[ Propose ]`:** Available directly whenever an `open` issue has a
  clean branch with `commits_ahead >= 1` and no open proposal. Clicking
  `Propose` creates the issue's proposal in `#merge-queue`; proposing again
  amends it. Merging happens in the queue, not in the room.
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
  `Proposed`, `Modifies .kawan/`) and **Landed / Closed** — without a 4-column
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
  surfaces a **`Modifies .kawan/ checks`** warning and the proposal never lands
  automatically; it waits for an explicit human **Merge**.

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
- **`lands` extensions:** `queue_position`, `message_id` (the proposal message),
  `issue_id` (nullable for ad-hoc chat tasks), `status` (`proposed` | `queued` |
  `rebasing` | `verifying` | `paused` | `landed` | `failed` | `withdrawn`),
  `pause_reason`, `queue_session_id`, and `trigger` (whether a human merged it or
  auto mode accepted it).

### Execution & Reconciliation Flow

1. **Propose:** `propose_merge` creates the proposal message and a `proposed`
   `lands` row; proposing again on the same branch amends both. Order is preserved
   strictly: while the queue is paused, later entries wait rather than skipping
   ahead.
2. **Accept:** **`Merge`** in `#merge-queue` (`land.merge`) moves the item to
   `queued`. With `default_landing_mode = "auto"` the host accepts a clean proposal
   itself. Nothing else is accepted; **`Withdraw`** (`land.withdraw`, or the agent's
   `withdraw_proposal`) ends an open proposal instead.
3. **Host fast-path (quiet on success):** For the head item (`#1`), the host creates
   a clean landing clone of `default_branch`, fetches the candidate branch, rebases,
   and runs `.kawan/checks/*`. If rebase is clean and every check exits `0`, the host
   fast-forwards `default_branch` immediately with zero LLM turns, posts the landed
   notice (the proposal message is the changelog of record), and marks any linked
   issue `landed`. Clean merges do not clutter `#merge-queue`.
4. **Friction path (strict pause + Queue Bot in `#merge-queue`):** If rebase
   conflicts or `.kawan/checks/*` fail:
   - The queue pauses immediately (`paused`) at `#1`.
   - The Queue Bot spins up (or resumes) a landing-clone session for `#1`, inspects
     the conflict/diff/check artifact, posts a top-level incident card in
     `#merge-queue` summarizing what conflicted or failed (with diff/log artifacts
     attached), and waits for humans in that incident thread.
   - Humans inspect and converse multi-turn with the Queue Bot in `#merge-queue`,
     or use deterministic controls in the Merge Train header: **Retry checks**,
     **Send back to implementer & Resume** (returns `#1` to `proposed` in its
     origin room and unpauses `#2`), or **Defer / Remove**.
   - Once instructed, the Queue Bot applies the fix inside the landing clone and
     calls `resume_and_land` (which re-runs full `.kawan/checks/*` before pushing
     and advancing `#2`) or `eject_to_implementer`.

### `#merge-queue` UI

Opening **Merge Queue** displays a pinned **Merge Train** header above the standard
`#merge-queue` conversation stream:

- **Header:** Queue state pill (`Idle` / `Running` / `Paused`), assigned `Queue bot`
  selector, conflict policy badge, and `Pause` / `Resume` button.
- **`Proposed (N)` section:** one row per open proposal, with author, title,
  rendered changelog (clipped with `View full proposal`), image thumbnails, checks
  pills, commits ahead / behind, `updated` time with the read-cursor dot, and
  `Merge`, `Open in <origin>`, `Withdraw` (`09_proposals.md`).
- **Head slot (`#1 · Now Landing`):** Title, origin link (`#issue` or chat thread),
  3-stage progress (`Rebase → Checks [named .kawan/checks/* pills] → Land`),
  artifact/log inspector, and quick action buttons (`Retry checks`,
  `Send back to implementer`, `Defer`) when paused.
- **Queued rows (`#2`, `#3`, ...):** Compact queue list with trigger source and
  `Remove` (returns item out of queue without discarding its branch).

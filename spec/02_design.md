## Overview

Kawan's UI is a GPUI desktop client connected to a single-machine host. It uses
a **chat-first orchestration** model: humans and bots share channels, threads,
direct messages, and issue rooms, while bots manage isolated virtual
environments and `pi` agent sessions behind the scenes.

## Bot & Session Hierarchy

```text
@bot (orchestrator session)
├── bug-1 (worker session + virtual environment)
└── feat-1 (worker session + virtual environment)
```

- **Bot:** A user, not a client. A bot has a profile, an identity in every
  channel it joins, and a key pair the host holds, so the commits its sessions
  make are authored and signed by it. Bots never log in; they exist so that
  agent work has an owner and an author.
- **Orchestrator (`@bot`):** A persistent bot identity that can be added to any
  conversation or messaged directly. Talking to `@bot` talks to the orchestrator,
  which can spawn, inspect, summarize, and instruct its child sessions. One
  orchestrator session serves every channel, DM, and issue room the bot is in,
  which keeps its view of the work unified; it delegates coding to isolated
  worker sessions so its orchestrator turns stay short.
- **Worker sessions:** Individual `pi` agent sessions spawned for concrete
  tasks, owned by the bot that spawned them. Each worker owns an isolated
  **virtual environment** (its own clone, working tree, and sandbox). Git
  mechanics are managed entirely by the host.
- **Threads:** Used when a topic or session needs deeper context-building,
  exploration, or focused steering without cluttering the main channel.

## Decision Points

A decision model is a separate class of model from the one running the agents: a
fixed question over a large supplied context, answered inside a fixed answer space,
with structured output and no tools. The same kind of call is made wherever Kawan
needs a cheap judgement rather than an agent run — routing a message, extracting
facts, triaging a merge conflict. These calls gate attention, not action: they can
only pick between next steps the host already allows, and the thinking itself
remains with the agent in the session.

Routing answers three parts in one structured judgement about each message — where
it belongs, whether there is enough context to act on yet, and whether work was
actually requested:

- **Destination** — `none` (an acknowledgement, an aside, chatter/sign-offs not
  needing a response), `orchestrator` (a turn for the bot's own session), or
  `session(id)` (the message belongs to a worker session already in flight).
- **Readiness** — `dispatch` (act now) or `hold` (relevant, but the message does
  not yet carry enough to act on; it waits visibly for the next one). Held
  messages wait per `(conversation, bot)` and are included in `route_message`
  context on the next message, dispatching together as one turn when `dispatch`
  fires.
- **Spawn intent (`explicit_work_start`, `work_request`)** — two binary `yes`/`no`
  choices gating `spawn_session` mechanically on the host (`work_request` stays
  strictly `no` for questions, brainstorming, and hypotheticals so it never fires
  on a hair trigger):
  - `yes / yes` — start immediately; the worker appears in the bottom session
    strip (or attach a writable branch if inside an issue room without one).
  - `no / yes` — hold behind the inline `[ Start ] [ Dismiss ]` spawn-approval row
    (zero clone or worker tokens until confirmed; `[ Dismiss ]` notes the back-off
    in orchestrator context).
  - `no / no` — block `spawn_session` and instruct the orchestrator to reply
    conversationally; nothing is proposed.

**Bot-to-bot messaging everywhere:** Conversational messages from both humans and
bots flow through `route_message` in channels, DMs, and issue rooms alike. Two
mechanical boundaries prevent noise without premature turn-cap or batching
heuristics: a bot never routes its own messages, and host-generated system/status
notices never enter routing. When the incoming author is a bot, `route_message`
receives `author_kind: "bot"` and treats polite closings/acknowledgements/approvals
as `none`, while routing genuine review findings, questions, or direct `@` requests
cleanly.

Aside from those mechanical boundaries, there are no secret fast-paths. Every
conversational message in conversations the bot is a member of goes to the
decision model, including direct addresses. Nothing is short-circuited in code,
no conversational message is dropped silently, and no rule overrides the model.

That is deliberate, and it makes the failure mode legible rather than impossible: a
message the model judges wrong is visible in the conversation, with the decision
and the reason beside it, and redirecting it is one click. A missing or failing
decision model is a hard error shown in the conversation, not a quiet fallback to
something dumber.

## Proposals

A finished branch shows up as a proposal: an ordinary message — Markdown plus zero
or more attachments — posted in `#merge-queue` and linked to a branch. The message
renderer is the only renderer, so inline `![alt](kawan://artifact/<id>)` images
render in the body at column width and open the artifact drawer on click. The Merge
Queue shows a `Proposed (N)` section above the train, and the existing read cursor
marks a proposal updated since it was last viewed. Bots reach out in ordinary chat
messages when something needs attention. See `09_proposals.md`.

## Issues & Epics

To prevent bugs, backlog items, and epics from getting lost in chat scrollback
(without requiring a separate tool like Linear), Kawan models an **Issue (`#N`)**
simply as a specialized room (`kind = 'issue'`) built around a central,
continuously editable Markdown document (`kawan://issue.md`) and an attached
branch once a bot begins implementing:

- **Shared room + live document:** Every issue has a title, an editable Markdown
  document (`kawan://issue.md`, injected on every turn in the room alongside
  `kawan://soul.md`), optional `parent_issue_id`, coarse status
  (`open` | `landed` | `closed`), and a normal Kawan chat stream. Ad-hoc chat
  sessions can also be converted in place with one-click **Promote to Issue**.
- **Chat-first implementation & multi-bot review:** You do everything in chat using
  the same primitives as anywhere else in Kawan:
  - `@coder implement this` routes through SubQ Snap (and the spawn-intent gate)
    to bind one writable branch (`kawan/issue-N-...`) and isolated worker clone to
    the issue. Follow-up steering routes to that session.
  - `@reviewer1 @reviewer2 review this` spawns read-only reviewer sessions over
    the issue's branch clone and `kawan://issue.md` (with no write/edit/bash
    rights). Reviewers post their findings back into the room as themselves;
    via bot-to-bot routing, `@coder` sees the feedback, fixes it on its branch,
    and replies back naturally. In a single-bot workspace, `review_issue()` runs a
    fresh read-only review pass against the bot's own branch.
- **Concrete live state & implicit `.kawan/checks/*`:** After commits or rebases,
  the host runs `.kawan/checks/*` implicitly in the background sandbox (never
  auto-retrying on failure) and displays concrete state in a compact branch bar:
  branch owner, working/reviewing indicator, commit count, divergence from
  `default_branch` (`Sync with main`), `Checks ✓/✗`, `[ Changes ]`, and one-click
  **`[ Propose ]`** whenever commits exist.
- **Soul learning loop:** After an issue lands, a concise post-landing digest
  returns to the implementer bot's orchestrator so durable repository lessons fold
  into `kawan://soul.md` (`06_memory.md`). See `08_v2_work_and_queue.md`.

## Proposals & Merge Queue

- **Repo checks & inspection:** `.kawan/checks/*` (or `.kawan/ci` / host
  `verify_command`) runs implicitly on branches as commits arrive and
  deterministically pre-merge in the Merge Queue after rebase. Review focuses on
  the proposal's rendered changelog, inline screenshots, diffs, and check logs
  (`Changes` drawer and expandable log artifacts). Branches touching `.kawan/*`
  surface a `Modifies .kawan/ checks` warning and never land automatically.
- **Proposals & `#merge-queue`:** `propose_merge` posts the proposal message and a
  `proposed` `lands` row; a human clicks **Merge**, or `default_landing_mode =
  "auto"` accepts a clean proposal, and the branch enters a serialized FIFO merge
  queue backed by a dedicated `#merge-queue` conversation (`kind =
  'merge_queue'`) with a pinned Merge Train header, a `Proposed` section, and an
  assigned Queue Bot. Clean rebases with passing checks land via a deterministic
  host fast-path; any conflict or check regression pauses the queue and opens an
  incident thread in `#merge-queue` where humans and the Queue Bot reconcile
  multi-turn before resuming. See `08_v2_work_and_queue.md` and
  `09_proposals.md`.

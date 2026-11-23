## Overview

Kawan's UI is a GPUI desktop client connected to a single-machine host. It uses
a **chat-first orchestration** model: humans and bots share channels, threads,
and direct messages, while bots manage isolated virtual environments and `pi`
agent sessions behind the scenes.

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
  channel or messaged directly. Talking to `@bot` talks to the orchestrator,
  which can spawn, inspect, summarize, and instruct its child sessions. One
  orchestrator session serves every channel and DM the bot is in, which keeps its
  view of the work unified; it is expected to delegate rather than do work itself
  so its runs stay short and channels do not queue behind each other.
- **Worker sessions:** Individual `pi` agent sessions spawned for concrete
  tasks, owned by the bot that spawned them. Each worker owns an isolated
  **virtual environment** (its own clone, working tree, and sandbox). Git
  mechanics are managed entirely by the host.
- **Bot profile:** Clicking a bot opens a structured view of its active
  sessions, their current status, and their virtual environments/artifacts,
  providing direct visibility without having to ask in chat.
- **Threads:** Used when a topic or session needs deeper context-building,
  exploration, or focused steering without cluttering the main channel.

## Decision Points

A decision model is a separate class of model from the one running the agents: a
fixed question over a large supplied context, answered inside a fixed answer space,
with structured output and no tools. The same kind of call is made wherever Kawan
needs a cheap judgement rather than an agent run — routing a message, extracting
facts, reading a review, triaging a merge conflict. These calls gate attention, not
action: they can only pick between next steps the host already allows, and the
thinking itself remains with the agent in the session.

Routing answers one question about each message: where does this belong, and is
there enough in it to act on yet? Two fields, one judgement:

- **Destination** — `none` (an acknowledgement, an aside, humans talking to each
  other), `orchestrator` (a turn for the bot's own session), or `session(id)` (the
  message belongs to a worker session already in flight).
- **Readiness** — `dispatch` (act now) or `hold` (relevant, but the message does
  not yet carry enough to act on; it waits visibly for the next one). Held
  messages wait per `(conversation, bot)` and are included in `route_message`
  context on the next message, dispatching together as one turn when `dispatch`
  fires.

There are no guardrails. Every message in conversations the bot is a member of
goes to the decision model, including direct addresses. Nothing is
short-circuited in code, no message is dropped silently, and no rule overrides
the model.

That is deliberate, and it makes the failure mode legible rather than impossible: a
message the model judges wrong is visible in the channel, with the decision and the
reason beside it, and redirecting it is one click. A missing or failing decision
model is a hard error shown in the conversation, not a quiet fallback to something
dumber.

## Repository Status

To answer what is moving, waiting, or merged across the project without translating
git branches or scrolling through channels, Kawan provides a unified **Status**
view covering both ad-hoc chat tasks and formal issues (`Needs You`,
`Waiting to Land`, `In Flight`, `Shipped`). Every entry centers on its human title,
status, participants, and expandable `report.md` artifact, keeping raw branch and
commit identifiers tucked away unless inspected.

## Issues & Epics

To prevent bugs, backlog items, and epics from getting lost in chat scrollback
(without requiring a separate tool like Linear), Kawan includes lightweight issues
(`#id`) backed by special conversations (`kind = 'issue'`) rendered with trimmed-down
PR chrome:

- An issue holds a markdown spec alongside a full Kawan conversation and thread
  stream, an explicit owner, an implementer bot, `0..N` reviewer slots (distinct
  bots or the same bot assigned with distinct review focuses), configurable
  `manual` vs `auto` landing, and optional parent/child links for epics.
- Issues operate across three gears (**Collaborate → Review Cycle → Merge Queue**):
  - **Collaborate** (drafting and implementation): stays a normal SubQ Snap–routed
    Kawan conversation where humans discuss artifacts, push the implementer in new
    directions, and evolve the spec and implementation together. Before assignment,
    `@bot` is the orchestrator; once assigned, bot-directed feedback routes to the
    issue's implementer session while human-to-human discussion stays `none`.
  - **Review Cycle**: the automated, programmatic gear (`CI → parallel reviewers →
    revise → ready_to_land / queued`, with `needs_input` `@owner` pauses and round
    caps), entered either manually via `Start Review Cycle` (interactive mode) or
    automatically after the implementer's first pass (autonomous mode), with an
    escape hatch back to Collaborate if direction changes.
- Issues default to a grouped flat list (with an optional 2D board view scoped to
  active pipeline columns). See `08_v2_work_and_queue.md`.

## Artifact Review & Merge Queue

- **Artifact-first review & CI:** When a worker finishes, the host runs repo-defined
  `.kawan/checks/*` verification scripts inside the sandbox (falling back to the
  configured host verify command when absent) before waking reviewers. Review focuses
  on evidence—`report.md` wrap-ups, check logs, screenshots, and review summaries—with
  full diffs and session logs accessible on demand. Branches touching `.kawan/*`
  disable auto-land and require explicit human approval.
- **Merge queue & `#merge-queue`:** Approving a session (or auto-landing after
  checks and reviewer sign-offs pass) enqueues it into a serialized FIFO merge queue
  backed by a dedicated `#merge-queue` conversation (`kind = 'merge_queue'`) with a
  pinned Merge Train header and an assigned Queue Bot. Clean rebases with passing
  checks land via a deterministic host fast-path; any conflict or check regression
  pauses the queue and opens an incident thread in `#merge-queue` where humans and
  the Queue Bot reconcile multi-turn before resuming. See `08_v2_work_and_queue.md`.

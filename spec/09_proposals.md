## A proposal is a message

A proposal is an ordinary message: Markdown body plus zero or more attachments,
posted in the `#merge-queue` conversation and linked to a `lands` row (status
`proposed`) that owns the branch. It renders through the ordinary message renderer,
with attachments carried as `Message.attachments` and the
`message_artifacts(message_id, artifact_id, position)` join table preserving their
order.

Markdown images of the form `![alt](kawan://artifact/<artifact_id>)` render the
artifact bytes inline at column width with a capped height; clicking opens the
existing artifact drawer. Chat and proposals use the same renderer.

## Lifecycle

`lands.status` is one of:

| State | Meaning |
|---|---|
| `proposed` | open, waiting for a human **Merge** (or for auto mode) |
| `queued` | accepted into the train, by a human or by auto mode |
| `rebasing` | head item being rebased onto the current default branch |
| `verifying` | head item running `.kawan/checks/*` |
| `paused` | conflict or check failure held for reconciliation |
| `landed` | fast-forwarded into the default branch |
| `failed` | landing failed |
| `withdrawn` | pulled by any authenticated workspace member, or the agent |

At most one open proposal exists per branch/session. A session with an open
proposal is simply `idle`.

## Agent tools

```text
report(text, artifacts?)              post a message with zero or more attachments
propose_merge(summary_md, evidence?, title?)
                                      create or amend the branch's proposal
withdraw_proposal(reason?)            pull the branch's open proposal
```

`evidence` accepts worktree-relative paths (resolved and uploaded by the session's
extension process) and/or `{filename, mime_type, content|base64}` objects. Uploads
that the body does not already reference get `![filename](kawan://artifact/<id>)`
appended.

`propose_merge` writes the proposal message and the `proposed` `lands` row in one
step. Calling it again on the same branch **amends** the open proposal: the same
message and row are rewritten, the commit count refreshed, and attachments replaced
only when the amendment supplies new evidence (an amendment without evidence keeps
the attachments already on the proposal). It never creates a second open proposal.

## Host notices

The host posts one short, never-routed notice in the origin conversation:

- on create: `Proposed for merge: <title> → Merge Queue`
- on amend: `Proposal updated: <title>`

Orchestrator chat commentary about finished work is optional; when it exists it
points at the proposal instead of restating the changelog.

## Accepting: Merge and auto-merge

`land.merge { land_id }` is the human accept: `proposed` → `queued`, and the queue
starts on it in order. `land.withdraw { land_id }` (any authenticated workspace member,
or the agent) sets `withdrawn`; the agent's own route is `withdraw_proposal`. Accepting
is a single click with no separate approval step, except that a proposal with failing
checks or `Modifies .kawan/` requires a second confirmation click. That second
confirmation is a client UI affordance: `land.merge` on the host does not require it,
so it protects the human clicking in the app, not the wire route.

A `failed` acceptance (missing clone, signing key, or repository) keeps its message
and stays listed in the `Proposed (N)` section with its error text, so it can be
retried with **Merge** or pulled with **Withdraw** instead of disappearing.

Host setting `default_landing_mode` controls the entrance:

- `manual` (default): the proposal stays `proposed` until a human clicks **Merge**.
- `auto`: a clean proposal is accepted automatically (`proposed` → `queued`) when
  it rebases cleanly and checks pass. The proposal message is still posted as the
  record.

Conflicts are not resolved at the entrance: a queued item pauses the train exactly
as before (`08_v2_work_and_queue.md`).

## Issues

The issue room's primary button is **Propose**, calling the same path with
`lands.issue_id` set. An issue keeps its document panel, branch bar, checks,
**Sync**, and **Stop**; it has no landing machinery of its own. The issue is marked
`landed` when its proposal lands.

## Checks

A proposal may exist with failing checks. They render red on its row and **Merge**
asks for confirmation. The `Modifies .kawan/` guard label stays visible and such a
proposal never lands automatically.

Checks run implicitly on the branch as commits arrive and deterministically in the
train after rebasing; neither run auto-retries (`08_v2_work_and_queue.md`).

## Merge Queue layout

The pinned **Merge Train** header stays: state pill, queue bot, conflict policy,
Pause/Resume. Above the train sits a **`Proposed (N)`** section, one row per open
proposal:

- author bot, title (with `#N` when it came from an issue);
- the changelog Markdown rendered inline, clipped after a few blocks with
  `View full proposal`;
- image thumbnails, checks pills, `N commits ahead · M behind main`;
- `updated 3m ago` plus an "updated since you viewed" dot driven by the existing
  read cursor on the proposal message;
- actions **Merge**, **Open in `<origin>`**, and **Withdraw** (any authenticated
  workspace member, or the agent).

Below it are the existing queued rows and head slot.

## What the human does

Read the proposal, then either **Merge** it or reply in the origin conversation to
request changes; the reply routes to the worker or orchestrator like any other
message, and the next `propose_merge` amends the same proposal. Landing posts the
landed notice; the proposal message is the changelog of record for Shipped and
history.

In-flight work is visible in the bottom session strip, the issue room live activity
bar, the session drawer, and the spawn-approval `[ Start ]` / `[ Dismiss ]` row.
Everything else the client shows is conversation: chat messages and the queue.

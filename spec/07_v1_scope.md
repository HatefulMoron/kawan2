## Principle

Small first. Each subsystem earns its abstractions from a second caller, not from
an anticipated one. Where the specs describe a mechanism, ship the behaviour with
the cheapest mechanism that produces it, and let the mechanism arrive when a second
need does.

## What v1 is

The whole loop, once, for one bot, one repository, and one verify command, with a
human at the merge seat. A human talks in a channel, the bot decides the message is
for it, spawns a worker in a clone, the worker commits and proposes the branch for
merge, a human merges the proposal, the host verifies and lands. When that works
end to end, v1 is done.

The flows are in `05_flows.md`. This is what they require, and nothing more.

## Server

Eleven tables: `users` (human or bot), `keys`, `invites`, `conversations` (channel or
DM), `members`, `messages`, `decisions`, `sessions`, `artifacts`, `soul`, `settings`.
Add a twelfth for lands if the queue wants its own history.

Modules: `db.ts`, `auth.ts`, `ws.ts`, `decisions.ts`, `spawn.ts`, `sessions.ts`,
`git.ts`, `extension/`. The decision module holds prompt plus answer enum per
decision; the spawn module composes one argv and is the only place `bwrap` and `pi`
are named.

Host tools, exposed by the injected extension over the unix socket:

```text
spawn_session(task)      create a worker, error if no repo or no live bot
session_status()         what my children are doing
report(text, artifacts?) post into the conversation, attach evidence
propose_merge(summary_md, evidence?, title?)
                         create or amend the branch's proposal in #merge-queue
withdraw_proposal(reason?)
                         pull the branch's open proposal
soul_replace(anchor, text)   edit the soul by exact anchor; empty text deletes
soul_write(document)         whole-document rewrite for consolidation
```

WebSocket, client to host: `bootstrap`, `register`, `hello`, `proof`,
`conversation.list`, `conversation.create`, `conversation.add_member`,
`conversation.open(since)`, `message.send`, `decision.redirect`, `bot.list`,
`bot.create`, `bot.update`, `session.list`, `session.open`, `artifact.get`,
`land.merge`, `land.withdraw`, `settings.read`, `settings.update`, `models.test`,
`invite.create`.

WebSocket, host to client: `welcome`, `conversation.new`, `message.new`,
`decision.new`, `bot.update`, `session.update`, `artifact.new`, `land.update`,
`error`.

## Client

Four surfaces: connect (address, key, bootstrap or invite), the setup checklist,
conversations (with threads, modeled via optional `thread_id` on `messages`),
and settings. Inside a conversation: the message stream with a decision chip on
every routed message, a redirect action on that chip, and a session strip
showing children of the bot with status and artifacts. Settings holds the
repository, the verify command, and the models file with a Test button; provider
API keys are write-only on `settings.update` and masked on `settings.read` so
raw secrets never leave the host.

That is the entire client. Everything else is a later screen.

## Not in v1

Issues and epics, the bot profile, the memory UI and soul revisions,
notifications beyond a chip, attachments beyond text and images, merge queue
ordering, conflict resolution, multiple repositories, multiple hosts per client,
TLS, secrets at rest, invite pre-binding, metrics, and any settings screen that is
not the three above. Invites, personas, threads, and DMs are in because the loop
needs them to be usable.

## Testing

Development runs against the real decision model and the real agent. Stubs prove the
plumbing; only the real thing tells you whether routing decisions are any good, and
the prompt is the part most likely to be wrong. Credentials come from the environment, never from a committed file; headless
scenario scripts read those environment variables and pass them into the host
via `settings.update`.

That means assertions are designed for a system whose outputs vary. Scenario scripts
assert invariants and outcomes, never text:

- **Structural** — a decision row exists for each message with a valid destination and
  readiness; a dispatch created a session; a report attached an artifact; a land
  produced a commit whose parent is the previous default-branch head.
- **Outcome** — the bot answered at all; the worker committed something; the verify
  command ran and gated the land. These are allowed one retry, because a model may
  reasonably decline a badly worded task.
- **Never** — that a message says a particular thing.

Three seams remain, none of them on the default dev path:

- **Record and replay.** Decision calls can be recorded to fixtures and replayed,
  which is how a real Snap answer becomes a deterministic test. Fixtures are captured
  from live calls, not hand-written, so replaying them keeps the real model's shape.
- **A stub provider.** A local OpenAI-compatible stub exists for CI without
  credentials and for simulating provider failures, which cannot be provoked on
  demand any other way.
- **Sandbox off, temp dirs, a fixture repository.** `bwrap` is skipped in tests, each
  test gets its own data directory, and the fixture repository's verify command is a
  scripted pass or fail.

Routing gets its own harness, because it is the component where a wrong answer is
silent until a human notices: a cases file of real conversations with the destination
a human would pick, and a runner that reports accuracy and disagreements. It is how
the prompt is tuned, and it costs cents per run.

Dev spend is bounded by the scenario tasks being small — a scenario asks for a
trivial, verifiable change, not a feature — and by workers using the cheapest model
that can do them.

### Live suite

Two tiers, because they fail for different reasons.

**Per change:** recorded fixtures only. Deterministic, no credentials, no spend. This
is what gates a merge.

**Nightly, or on demand:** the same scenarios against the real decision model and a
real agent, on a schedule rather than per push, with the API keys in a protected
environment and never exposed to fork builds. This tier exists to catch drift — a
provider updating a model, a prompt that stopped working, a loop that now takes
eleven turns instead of four — which fixtures cannot see by construction, because
they were recorded before the change.

The live suite is three or four scenarios, not a corpus: route the cases file, land a
trivial change, block a land on a failing verify, hold then dispatch a fragment. Each
run reports per-scenario outcome, wall time, token spend, and the transcript, and
aborts if spend crosses a small ceiling. It is advisory — a model's bad day does not
block a merge — but a red live run is a bug report about the prompt.

Recording is how the two tiers stay honest: a live run with `--record` rewrites the
fixtures the per-change tier replays, so the deterministic suite tracks what the model
actually does rather than what it did the month it was written.

The protocol is frozen by recorded frames rather than by codegen: the server tests
capture what they emit, and the client's parser is tested against the same
recordings.

## Slices

Server first (slices 1–5 headless), then the client in slice 6. Each slice is
done when its scenario script passes, and each is worth committing on its own.

1. **Skeleton.** Database and migrations, SSH auth, conversations and messages over
   the WebSocket. Done when two scripted clients authenticate, exchange messages, and
   a reconnect replays from a sequence number. No agents.
2. **Bot that decides.** Settings, models materialisation, bot creation, and
   `route_message` as the only thing that decides a message was meant for the bot.
   Done when, against the real decision model, an addressed message walks the
   orchestrator path, a fragment is held and then dispatches with its successor, and a
   human aside is routed to `none`. The cases file is written here.
3. **Work.** The extension and its tools, `spawn_session`, the clone and branch, the
   worker prompt, `report` with content-addressed artifacts (`artifact.get`).
   Done when a real orchestrator, asked for a trivial change, spawns a worker
   that commits in its clone and posts an artifact row.
4. **Land.** One verify command, rebase, fast-forward, `land.merge`. Done when a
   passing proposal lands on the default branch in the bare repository and a failing
   one does not, with the failure reported in the conversation.
5. **Memory.** Soul document, `soul_replace` and `soul_write`, context-file
   injection. Done when a fact learned by a worker is reported to the
   orchestrator, written to the soul by the orchestrator, and reaches the
   orchestrator's next run through the soul (not by re-reading old conversation
   scrollback), and an ambiguous anchor is rejected rather than applied.
6. **Client.** Connect, checklist, conversations, settings, with the decision chip,
   redirect, and session strip. Done when `scripts/ui-shot` and a `uidrive.py` step
   script drive the flow from bootstrap to a landing commit against a headless
   host running in replay/stub-provider mode with the fixtures from slices 1–5.

Slice 6 is where the product risk lives, not the engineering risk: the chip, the
redirect, and the session strip are the only affordances that make routing corrections
cheap, and their layout is worth one static mock screen before the real client work
starts. That mock needs no host calls and no protocol.

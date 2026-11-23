## Concept

Each bot has one markdown document: its soul. It is small, it is rewritten rather
than appended, and it is the only thing the bot carries into every conversation it
has. Chat history stays the long-term record; the soul is the distillation the bot
must not have to rediscover.

The soul is not the persona. Persona is human-authored, changes with an
orchestrator restart, and says who the bot is. The soul is bot-authored, hot
loaded, and says what the bot has learned: how this project builds, what the humans
prefer, what is in flight.

## Shape

Markdown, capped at 4 KB (roughly a thousand tokens). The cap is enforced, not
suggested. Sections the bot is told to keep, not forced to:

```text
## Working agreements   how to work in this repo
## Project facts         build, test, run, gotchas
## Decisions             what we chose, and what we abandoned and why
## Preferences           how the humans here like to be spoken to
```

Notice what is absent: in-flight work. A session list written in prose goes stale
the moment a branch lands, and the host already knows the truth. What is in flight
is injected live, from the sessions table, on every orchestrator turn. The soul
holds only what the host cannot derive.

Stored as a row per bot in SQLite with its revision history, so nothing depends on
a file being present or parseable. Renderable, diffable, and restorable.

## Reading

The soul is injected as a context file into every session the bot owns. Workers
get the version current at spawn. The orchestrator re-reads it at the start of each
run, so a write is visible to the bot immediately with no restart.

Workers receive only the working-agreements and project-facts sections. The
orchestrator receives the whole document plus a live summary of its own sessions —
what each is doing, what it is blocked on, what it last reported — so awareness of
subagent work comes from the host rather than from the bot's memory of it.

## Writing

Only the orchestrator writes, and it edits rather than appends. Two tools:

```text
soul_replace(anchor, replacement)   exact unique match required; delete = empty replacement
soul_write(document)                whole document, for consolidation
```

`replace` is the everyday tool. Editing by anchor keeps the output small and fails
loudly: no match or an ambiguous match is an error, not a silent no-op. Deleting a
line is a replace with an empty replacement, inserting is a replace of a sentence
with itself plus the new text, and both are legible in the diff afterwards.

`write` exists for the moment a bot needs to restructure rather than patch. It
requires each section heading exactly once, and it is rejected if a section
disappears without being emptied deliberately.

Rewriting a thousand tokens faithfully is harder for a model than patching four
lines, and a summarising rewrite quietly loses things. That failure is invisible
once it has happened, which is why the everyday path is the one that cannot happen
silently. The revisions are the safety net either way: every write records its
authoring session, a timestamp, and a diff against its parent, so a bad consolidation
is a diff to read and a version to restore.

No read tool. The document is injected in full at the start of each run, so a bot that
wanted to read it has already read it.

Every call returns the new size against the cap and a one-line summary of what
changed, so a rewrite that collapsed three sections into one is visible in the tool
result rather than discovered next session.

A write exceeding the cap is rejected with the current size and the instruction to
consolidate. Truncation is worse than refusal.

## Short-term memory

Not in v1; see `07_v1_scope.md`. When it arrives it is the `extract_facts` decision
point, not a buffer: the host asks which facts in the messages since the last
extraction are worth keeping, the decision model answers with a short list, and the
orchestrator folds what survives into the soul using its tools.

That replaces the retained-context buffer this design started with. Extraction over
a span of messages and a buffer that expires are the same idea, and only one of them
needs an overflow policy.

## What it is not

Not a vector store, not semantic search over history, not per-user memory, and not
a wiki. Anything that needs retrieval is a message, an issue, or a file in the
repository.

## UI

Not in v1. Until then the document is readable through the bot's own tools and in
the database, and revisions make anything an admin wants to recover recoverable.
When it does appear it belongs on the bot profile as rendered markdown with a
revision list and restore, showing size against the cap, since the pressure to
consolidate is invisible otherwise.

## v1 scope

One document per bot, written only through tools by the orchestrator, with no
human editing and no UI. No per-project document, no per-user memory, no retrieval.
If a second scope is ever needed it is another document of the same shape, not
another mechanism.

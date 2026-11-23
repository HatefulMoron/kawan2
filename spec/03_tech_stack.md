## Purpose

The minimum set of stack decisions needed to start building Kawan. Anything not
listed here is left to the implementation.

## Stack

- **Host:** TypeScript on Node LTS, single process, single machine. Chosen
  because `pi` is TypeScript and already a hard runtime dependency on the host; a
  second language would reimplement pi's session store, provider auth, and RPC
  protocol for no gain.
- **Client:** Rust GPUI desktop app (existing crate). Talks to the host over the
  network only; no shared types, no shared database.
- **Agent runtime:** every agent session is its own `pi --mode rpc` child
  process, driven through `RpcClient`. The host holds no in-process agent state
  beyond the event stream it mirrors. Uniform rule — orchestrator and workers go
  through the same path, differing only in tool set, system prompt, and sandbox.
- **Decision points:** routing, fact extraction, review verdicts, and merge
  conflict triage are single calls to a decision model over HTTP — SubQ Snap —
  not sessions. Fixed context, fixed answer space, schema-constrained output, one
  row recorded per decision. Required, not optional: no decision model means no
  bot and a loud error per message. Nothing else in the host decides where a
  message goes. See `07_v1_scope.md`.
- **State:** one SQLite database owns everything that is not pi session data —
  users (human and bot), invites, keys, conversations (`channel`, `dm`, `issue`,
  `merge_queue`) sharing one message/thread/artifact substrate, routing decisions,
  issues, review rounds, sessions, workspaces, and merge queue entries. Git holds
  code only. No state lives in committed files.
- **Durability:** pi's persisted session tree is the source of truth for
  conversations. The host recovers after a restart by re-creating children and
  replaying `get_entries` from the last entry id it recorded.
- **Git:** the host shells out to the `git` binary. No libgit2 bindings.
- **Sandbox:** sessions spawn through a command wrapper the host composes. Default
  is `bwrap`: read-only system directories, one writable session root, private
  `tmp` and `dev`, no host `~/.pi`. Docker remains an alternate wrapper behind
  the same interface. This prevents cross-session and host-data access; it is not
  a defence against a determined attacker.
- **Auth:** SSH key challenge-response. The client signs a challenge
  (`ssh-keygen -Y sign`), the host verifies against keys stored in SQLite
  (`ssh-keygen -Y verify`). The first user is admin; invites are single-use links
  that bind the first key presented. No sshd, no unix users, no passwords. Bot
  users never log in; their keys only sign commits. See `04_auth_flow.md`.
- **Transport:** one long-lived WebSocket carrying JSONL records, reusing pi
  RPC's framing conventions (one JSON object per line, `id`-correlated
  requests/responses, uncorrelated events). History reads go over the same
  socket: snapshot on connect, deltas after.

## Bot identities

- A bot is a row in the user table with a key pair the host generated and
  holds. Humans log in; bots do not. Bots own sessions, post in channels, and
  author the commits their sessions make.
- Every workspace clone is configured at creation with the owning bot's name,
  email, `gpg.format = ssh`, `commit.gpgsign = true`, and `user.signingkey`
  pointing to the bot's dedicated signing-only key mounted read-only into the
  sandbox (separate from the host's upstream repository SSH key). Landed history
  is therefore attributable and verifiable with stock git.

## Host API for sessions

- The host injects a `pi` extension into every child. It exposes the host's API
  as tools: spawn and inspect sessions, steer a session, report status and
  artifacts, request review. Children reach the host over a local unix socket
  carrying one JSONL record per line, the same framing as every other boundary.
- Every child is given its own token, scoped to the session it belongs to. A
  session can act for itself and the host decides the rest; nothing in a
  workspace shares identity with another session.
- Provider credentials are configured once on the host and shared by every
  session. No per-user keys, quotas, or authorization checks in v1. Human
  identity exists for attribution only, and any user may interact with any
  session.

## Workspaces

- The host keeps one bare repository for the project and never checks it out.
  Users' sessions and the merge queue are the only things that touch git.
- A session workspace is a full local clone of the bare repository, created at
  session start with its own branch, `kawan/<session-id>`. A local clone
  hardlinks objects into its own store, so creation is near-instant and the
  clone does not depend on the origin's object store afterwards.
- All work — branches, commits, rebases — happens inside the clone, which is the
  writable root of the sandbox. No host gitdir is exposed to it, and nothing is
  shared between sessions.
- The merge queue serializes landings per repository, fetches the session branch
  out of the clone, rebases it onto the target branch, runs repo-defined
  `.kawan/checks/*` verification inside the sandbox wrapper (falling back to host
  `verify_command` when absent), and lands it in the bare repository. See
  `08_v2_work_and_queue.md`.
- Clones are removed after landing or abandonment; their history survives in the
  bare repository.

## Artifacts

- Text and image artifacts are stored as content-addressed files on disk under
  `<data_dir>/artifacts/<sha256>` and indexed in the `artifacts` SQLite table
  (`id`, `sha256`, `mime_type`, `byte_size`, `session_id`, `created_at`).
- Clients fetch artifacts over the existing WebSocket via `artifact.get(id)`
  (returning base64 + `mime_type`, capped at 10 MB in v1), avoiding a separate
  HTTP file server and auth path.

## Deferred

Decided in principle, not yet specified: sandbox network policy, clone reaping and
concurrency caps, TLS termination, encryption of provider keys at rest, chat
retention, `pi` version pinning, notifications, and whether a client may connect
to more than one host.

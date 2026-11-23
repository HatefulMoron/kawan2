## Purpose

The flows a new instance goes through, from an empty machine to the first landed
change. Each flow lists what triggers it, what the client shows, and what state it
creates. Anything not listed here is not needed for v1.

## 0. Host bring-up

No client involved. The host is started with a data directory; it creates the
database, the repository directory, and the workspace directory, then prints one
line to its log:

```text
kawan ready — connect to ws://<host>:<port> — bootstrap token <token>
```

At this point there are no users, no repository, no models, and no bots.

## 1. Admin registers

The client asks for an address and connects. The host has no users, so it asks for
the bootstrap token, then a key.

```text
address → key choice (ssh-agent or file) → sign challenge → admin created
```

The client then shows a setup checklist with three required items: repository,
models, bot. The checklist is the whole of the UI until it is satisfied; there is
nothing else to look at.

`#general` is created at this moment with the admin as its only member, so the
client is never completely empty.

## 2. Attach the repository

Admin pastes a clone URL and confirms the default branch. The host's SSH key is
generated at bring-up and its public half is returned by `settings.read` for
pasting into the remote; HTTPS tokens are accepted too. `settings.update`
accepts `repo_url` and `default_branch`, runs `git clone --bare` into the host's
repository directory, and verifies the default branch exists. Failures are
reported verbatim from git via an `error` frame, not summarised.

Creates: one repository record — URL, credential, bare path, default branch. One
per host.

## 3. Models

Two screens. Provider credentials are admin-only, write-only from the client,
and never leave the host (`settings.update` accepts them; `settings.read`
returns only masked `"configured"` status to admins). The model catalogue —
which models exist and which roles they fill — is visible read-only to every
member, since they need to know what they are talking to.

**Providers.** Pick a known provider and give it a credential, or give a custom
`baseUrl` and API style for a local endpoint. Credentials are stored with the
host, not with a user.

**Models.** Choose which models from that provider are allowed, or add a custom
model with its context window and costs. Then assign two roles: `default` for new
bots, and `decision` for the decision model. The decision model is its own provider
entry with its own endpoint and key, since it is a different vendor, and it is
required: without it a bot cannot be created and channels report the error.

**Test.** A button sends one small prompt to each role as written and shows the
provider's error inline. For the decision role the prompt includes a trivial
`route_message` question, since a plain completion does not prove the answer space
survives.

Creates: providers, allowed models, model roles. Effect: the host materialises
`models.json` and the model settings into each child's config directory, so
"configured" means written files, and keeps the decision endpoint in its own config
since nothing agent-shaped reads it.

## 4. Create a bot

Admin fills in name, persona/system prompt (optional), model (defaults to the
`default` role), thinking level, and sandbox policy (on or off, network on or off).
The email is derived from the name.

Creating a bot with no repository or no models is blocked, with a link back to the
checklist. So is creating one without a decision model, because that bot would be
unable to hear anything.

Persona, model, thinking level, and sandbox policy stay editable afterwards.
Editing the persona replaces the root orchestrator session: the old session is
archived and readable, a new one starts with the new prompt, and channel
membership and messages are untouched.

Creates: a bot user, its key pair, and a root orchestrator session in the
`not started` state. No child process exists until the first message arrives.

## 5. Channels and DMs

The admin can create channels and add users and bots as members. A channel has a
name, a topic, and members; all channels are visible to every user in v1. Bots
join only when explicitly added — never automatically, including to `#general`.

**DM** with a user opens a two-person conversation. **DM** with a bot opens a
conversation with its root orchestrator session, which is the same session that
receives that bot's channel messages.

Every message row carries an author (human or bot), body, timestamp, and a
per-conversation sequence number the client uses to resume after a reconnect.

## 6. First work

Only the orchestrator represents the bot in conversation; worker sessions work
quietly behind the scenes and report back to the orchestrator:

```text
human in #general:  @bot the CI build is flaky, look at it
decision call:      orchestrator, dispatch — addressed and actionable
orchestrator:       spawns worker session + clone + kawan/<id> branch (optional brief ack)
worker:             works in isolated clone; calls report() / land_request() to orchestrator only
                    (if blocked, asks orchestrator → orchestrator asks human & relays via message_session)
orchestrator:       posts one plain-language summary in chat (attaching artifacts & Approve Land)
human:              replies in the thread → routed to that session (or orchestrator)
human:              approves (in chat, bot DM tasks panel, or session drawer) → verify & land
bot:                posts a concise landing confirmation, closes the issue if there is one
```

The issue variant is `@bot fix #12`, which links the spawned session and its
artifacts to the issue instead of a bare channel thread.

Live worker progress, artifacts, and pending land approvals are visible in the
bot's left-rail indicator, bot DM tasks panel, bottom session strip, and
session drawer without cluttering chat. Two moments need the client to be loud:
a question relayed to the channel and a verification failure in the merge queue.

## What this forces

- Onboarding is a three-step state machine, and the client has to be coherent with
  zero bots, zero channels, and zero models configured.
- Bot creation is gated on repository and models, so the checklist cannot be
  skipped silently.
- Chat works before models are configured. A message to a bot without a model must
  fail visibly in the channel, not silently.
- Each bot has exactly one orchestrator session serving every channel and DM. It
  is expected to delegate rather than work, so its runs stay short; a bot that
  starts running commands in a channel will serialise every other channel behind
  it.
- Everything except users, bots, channels, and issues is a per-host singleton, so
  every "configure" screen is an edit rather than a list.

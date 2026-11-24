## Overview

Authentication is an SSH key challenge-response. There is no sshd, no unix user,
no password, and no session token. Every WebSocket connection authenticates
itself in-band before it can do anything else, using `ssh-keygen -Y sign` on the
client and `ssh-keygen -Y verify` on the host.

Trust model: a client that can sign with a key the host has recorded for a user
is that user. Nothing else is checked. Identity exists for attribution, git
authorship, and who may administer the host.

## Bootstrap

The host starts with an empty database and refuses all connections. On first
start it prints a single-use bootstrap token to its log. The client's first
connection presents that token alongside a key, creating the admin user. The
token is discarded once used. Nobody can claim the host by connecting first.

Bootstrap creates no bot. A fresh host has an empty client: no channels, no
sessions, and nothing that can spawn one until the admin creates a bot.

## Registration

An admin creates an invite: a single-use token that expires after 24 hours, with
an optional note. The invite is one string the invitee pastes into the client:

```text
kawan://<host>/<invite-token>
```

The client parses that string; the OS scheme is not registered, so nothing
happens if it is pasted elsewhere. On first start the equivalent manual form is
host, port, and token in two fields.

The invite is not bound to a key in advance. Anyone holding the token can
register their own key until it is used or expires, which is the deliberate
trade for a link that is trivial to hand over.

The client sends the token with the public key it wants to register. The host
creates a user, consumes the invite, and proceeds to the standard challenge
handshake on the same connection. Invites are the only way to add a user, and
only admins create them.

## Login

Records on the WebSocket, pruned to the interesting part:

```text
Login:
C→S  {"type":"hello", "key":"SHA256:...", "version":1}
S→C  {"type":"challenge", "nonce":"<base64>", "namespace":"kawan@<host>", "expires":30}
C→S  {"type":"proof", "signature":"<SSHSIG armor>"}
S→C  {"type":"welcome", "user":"<id>", "role":"admin|member"}

Bootstrap (only when users table is empty):
C→S  {"type":"bootstrap", "token":"<bootstrap-token>", "pubkey":"ssh-ed25519 ...", "name":"<name>", "version":1}
S→C  {"type":"challenge", ...}  # followed by proof -> welcome

Invite registration:
C→S  {"type":"register", "token":"<invite-token>", "pubkey":"ssh-ed25519 ...", "name":"<name>", "version":1}
S→C  {"type":"challenge", ...}  # followed by proof -> welcome
```

- The nonce is 32 random bytes, recorded server-side with a short expiry, and
  deleted on first use, so a proof cannot be replayed or shared between
  connections.
- The client writes the nonce to a file and runs
  `ssh-keygen -Y sign -n kawan@<host> -f ~/.ssh/id_ed25519.pub nonce.txt`,
  then sends the `.sig` armor. Namespace binding stops a proof from one host
  being replayed against another.
- The host verifies with `ssh-keygen -Y verify -f allowed_signers -I <user>
  -n kawan@<host> -s proof.sig`, with `allowed_signers` generated from SQLite
  for that fingerprint.
- Anything other than a valid proof closes the connection. There is one
  attempt per connection; reconnecting gets a fresh nonce.

Signing needs the key in `ssh-agent` or an unencrypted key file on the client.
The client tries the agent first and falls back to asking for a path.

## Identity

Two kinds of user share one table and one identity space.

- **Humans** are a key fingerprint plus a profile. They log in with the handshake
  above and their fingerprint is what the host checks.
- **Bots** are created by an admin, one at a time, and there is no default. A
  bot needs a name and gets an email; the host generates an ed25519 key pair for
  it at creation and keeps the private half, and the public half is what any
  commit it lands is signed with. Bots never log in and never appear on the
  WebSocket as a client. They own sessions and post in channels.

Commits in a bot's session clones are authored as that bot and signed with its
dedicated signing-only key (`gpg.format = ssh`, `commit.gpgsign = true`,
`user.signingkey` pointing to the bot's private signing key mounted read-only
into the sandbox, separate from the host's upstream repository SSH key), so
`git log --show-signature` on the bare repository attributes every landed change
to a bot without any extra bookkeeping.

## Roles

`admin` and `member`. Admins create invites and bots, change host settings
including provider credentials, remove users, and override the merge queue.
Members can do everything else, including steering any session and merging or
withdrawing any proposal.

## Session identity

Agent sessions do not authenticate as users. Each child is given a token scoped
to its own session id, used only on the host's local unix socket, which the
injected extension presents when it calls host tools. A session can act for
itself; the host decides what that permits. Sessions are owned by the bot that
spawned them, and the root orchestrator session is the bot's only entry point
for talking to humans.

## Revocation

Deleting a user or key takes effect immediately: live connections belonging to
that identity are closed and future proofs fail. Deleting a bot stops its
sessions and orphans nothing — its children go with it.

## Transport

No TLS in v1. The handshake cannot be forged — nonces are single-use, short-lived,
and bound to the host namespace — but an on-path attacker can passively read every
message and, by relaying a nonce, sit in the middle of a live connection. The host
is therefore only reached over a private network or a tunnel (WireGuard,
Tailscale, `ssh -L`) until TLS lands, not directly from the internet.

## Not in scope

Passwords, web sessions, OAuth, and browser clients. If a web client appears
later, the challenge-response handshake is replaced by a bearer token minted
from it, and nothing else changes.

# Contributing to t3ctl

Maintainer and contributor notes: how the protocol was worked out, what the wire
format actually is, and how releases are cut. If you just want to *use* t3ctl,
read the [README](README.md) instead.

## Working on this

t3ctl is a single dependency-free ESM file (`t3ctl.mjs`) targeting Node >= 22.
There is no build step and no test suite yet — run it directly:

```sh
node t3ctl.mjs ls -t
```

[T3 Code](https://github.com/pingdotgg/t3code) is MIT-licensed open source.
**Read the source before guessing at anything here:**

- `docs/user/remote-access.md` — pairing, `t3 serve`, transports
- `docs/internals/environment-auth.md` — session methods, bearer tokens
- `docs/internals/t3-connect.md` — the relay
- `packages/contracts/src/orchestration.ts` — the authoritative command/event schemas

Note that `@t3tools/contracts` and `@t3tools/client-runtime` are `private: true`
— readable in the repo, but not installable from npm. Hence the hand-rolled HTTP
client here rather than a typed client.

## Auth

The server advertises its own policy at `GET /api/auth/session`;
`bearer-access-token` is a supported session method (see the
`sessionMethods` field of the environment descriptor). `t3 auth` is the
documented way to manage access:

```sh
npx t3 auth session issue --label t3ctl --ttl 30d --token-only
npx t3 auth session list
npx t3 auth session revoke <session-id>
```

`t3` is published on npm (the `apps/server` package); `npx t3` works. Note that
npx resolves the latest *published* version, which may lag the Nightly server
you're running — T3 Code warns about client/server version skew. The same CLI
ships inside the desktop app and needs no install, which guarantees an exact
version match:

```sh
APP="/Applications/T3 Code (Nightly).app"
ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/T3 Code (Nightly)" \
  "$APP/Contents/Resources/app.asar/apps/server/dist/bin.mjs" auth session issue --token-only
```

There is also `t3 auth pairing create|list|revoke` for one-time pairing tokens,
which is what the mobile app consumes. t3ctl uses long-lived bearer sessions
instead, so it never touches the pairing flow.

## Endpoints

| Purpose | Endpoint | Auth |
|---|---|---|
| Identify the server | `GET /.well-known/t3/environment` | **none** |
| List everything | `GET /api/orchestration/snapshot` | bearer |
| Per-thread | `GET /api/orchestration/threads/:threadId` | bearer |
| Writes (commands) | `POST /api/orchestration/dispatch` | bearer |

t3ctl uses `descriptor`, `snapshot` and `dispatch` only.

### The environment descriptor

`GET /.well-known/t3/environment` is the one endpoint with no auth middleware
(route `descriptor` in `packages/contracts/src/environmentHttp.ts`; payload
`ExecutionEnvironmentDescriptor` in `packages/contracts/src/environment.ts`):

```json
{ "environmentId": "9d9d9921-…", "label": "SPR-Gobius-D",
  "platform": { "os": "darwin", "arch": "arm64" },
  "serverVersion": "0.0.38-nightly.20260901.1250",
  "capabilities": { "…": true } }
```

Because it needs no token, `host add` probes it *first* and only writes to
`hosts.json` if it parses. That splits two failures users otherwise cannot tell
apart: "this origin isn't T3 Code" and "your token is wrong". t3ctl stores
`environmentId`, `label` and `serverVersion`, and treats a changed
`environmentId` on a known origin as a loud warning — the origin now resolves to
a different machine, so the stored token belongs to something else.

Probing happens on `host add` and `hosts` only. `ls` must stay one request per
host; adding a descriptor round-trip there would double its cost for information
it never displays. t3ctl reads only the three string fields — `platform` and
`capabilities` are deliberately ignored rather than stored, so there is nothing
to keep in sync when the server grows a capability flag.

## Command vocabulary

Commands are imperative, events past-tense (`thread.create` → `thread.created`).
Commands are dispatched directly to `/dispatch` with no envelope — the command
object *is* the request body, and the response carries a `sequence`.

**The client generates `commandId`, `threadId`, and `projectId`**; `commandId`
is the idempotency key, so retries are safe. Exact schemas live in
`packages/contracts/src/orchestration.ts`.

```
project.create      { commandId, projectId, title, workspaceRoot, createdAt,
                      createWorkspaceRootIfMissing? }
thread.create       { commandId, threadId, projectId, title, modelSelection,
                      runtimeMode, interactionMode?, branch, worktreePath, createdAt }
thread.turn.start   { commandId, threadId, message: {messageId, role, text, attachments},
                      runtimeMode, interactionMode, modelSelection?, titleSeed?, createdAt }
thread.turn.interrupt { commandId, threadId }
```

`RuntimeMode` is one of `approval-required`, `auto-accept-edits`, `auto`,
`full-access` (default `full-access`). `ProviderInteractionMode` is `default`
or `plan` (default `default`).

`modelSelection` is `{instanceId, model}`. `instanceId` is the segment before
the *first* slash, and `model` keeps the rest — opencode models are themselves
slashed, e.g. `opencode/github-copilot/gpt-5.4` parses to
`{instanceId: "opencode", model: "github-copilot/gpt-5.4"}`.

### thread.create vs thread.turn.start

`thread create` in t3ctl creates an *idle* thread with no messages — it does not
start the agent. The UI never produces this state: it always fires
`thread.create` immediately followed by `thread.turn.start`, a single command
that carries the first message inline (`message: {messageId, role, text,
attachments}` plus a `titleSeed`).

`thread.message-sent` and `thread.turn-start-requested` are the resulting
*events*, not commands — don't try to dispatch them.

One asymmetry to know about: the client-side `thread.turn.start` schema requires
`runtimeMode`/`interactionMode` explicitly, while the server-side schema
defaults them. t3ctl always sends both.

### Simple thread commands

`SIMPLE_THREAD_COMMANDS` in `t3ctl.mjs` is exactly the set of commands whose
entire payload is `{commandId, threadId}`, verified against the contracts:

```
thread.settle  thread.archive  thread.unarchive  thread.unpin  thread.delete
```

Deliberate exclusions, all of which carry extra fields and so cannot ride the
same generic code path:

- `thread.unsettle` — carries `reason: "user"`. Commands only ever carry
  `"user"`: activity un-settles are decided server-side (the decider emits
  `thread.unsettled(reason: "activity")` directly), so a client cannot forge
  the neutral reset.
- `thread.snooze` — carries `snoozedUntil`.
- `thread.unsnooze` — carries `reason: "user"`, same reasoning as `unsettle`.
- `thread.pin` — carries an optional `orderKey` (fractional index).
- `thread.pin.reorder` — carries a required `orderKey`.

Adding any of these means giving it its own payload builder, not appending to
the list.

## Derived thread status

The server does not send a single status field; t3ctl derives one. Order
matters — most urgent wins, and `archived`/`deleted` short-circuit before
anything else is considered:

| Status | Condition |
|---|---|
| `deleted` | `deletedAt` |
| `archived` | `archivedAt` |
| `running` | `session.activeTurnId` or `session.status === "running"` |
| `error` | `session.status === "error"` or `latestTurn.state === "error"` |
| `snoozed` | `snoozedUntil` is in the future |
| `needs-review` | `proposedPlans` is non-empty |
| `settled` | `settledAt && !unsettledAt` |
| `idle` | fallback |

If you add a status, add it to `ICON` too — `ls` prints `?` for anything
unmapped rather than crashing.

## Transports

t3ctl only ever sees an origin string, so it is transport-agnostic by
construction. What produces a reachable origin:

- **Tailscale** — `t3 serve --tailscale-serve` advertises
  `https://machine.tailnet.ts.net/` (`--tailscale-serve-port` for a non-443
  HTTPS port). The mapping persists until `tailscale serve --https=443 off`.
- **LAN** — `t3 serve --host "$(tailscale ip -4)"`, or any bound interface.
  Default port is `3773`, but `t3 serve` will pick the next free port if it's
  taken, so read the URL it prints.
- **SSH** — any manual port-forward works. T3 Code's own SSH *launch* feature
  (the desktop app starting a remote server and forwarding for you) is
  desktop-only today.
- **T3 Connect relay** (`relay.t3.codes`) — **NOT IMPLEMENTED in t3ctl.** This
  is the account-level environment registry that mobile uses off-tailnet. The
  client-side API is `/v1/client/environment-links`, `.../dpop-token`,
  `.../environment-link-challenges`, `.../devices`; auth is DPoP-bound rather
  than a plain bearer, which is why it isn't a drop-in for the existing client.
  See `docs/internals/t3-connect.md` and `packages/contracts/src/relay.ts`.
  Nothing in the codebase talks to the relay — do not describe it as working.

## Known rough edges

- `snapshot` returns full messages/activities (~900 KB for 215 threads). Fine
  for `ls`, wrong for polling — a poller should use `snapshotSequence` for
  incremental sync. t3ctl re-fetches the whole snapshot on every write command
  in order to resolve a project/thread reference, which is wasteful but simple.
- `ls` fans out to every registered host and has no `--host` filter; the write
  commands take `--host` and require it when more than one host is registered.
- Tokens are stored in plaintext in `~/.config/t3ctl/hosts.json` (dir `0700`,
  file `0600`). No keychain integration.
- `host add` accepts two shapes and tells them apart by scheme: a first argument
  matching `^https?://` is the origin (current form), otherwise it is the legacy
  `<name> <origin> <token>`, which warns. The cost is that an origin must carry a
  scheme — `host add localhost:3773` is rejected rather than guessed at.
- Stored descriptor fields go stale: `hosts` shows live values where it can and
  dims the row when it falls back to what was last recorded. Nothing re-probes in
  the background.
- `host` subcommands validate their arguments before reading the registry or
  touching the network, so `t3ctl host add` with no arguments prints usage. Keep
  it that way — the no-host paths are exercised in CI.

## Releasing

Publishing runs in CI via **npm trusted publishing (OIDC)**. There is no
`NPM_TOKEN` anywhere — not in the workflow, not in repo secrets. CI proves its
identity with a short-lived OIDC token that npm verifies against a configured
trusted publisher, so there is no long-lived credential to leak, rotate, or
exfiltrate. npm also attaches a provenance attestation linking the tarball to
the exact commit and workflow run.

Versions are not chosen by hand. **release-please** watches `main`, derives the
next version from Conventional Commits, and keeps a `chore(main): release X.Y.Z`
pull request up to date with the computed version and a generated `CHANGELOG.md`.

To cut a release, merge that PR. Nothing else. `feat:` bumps the minor, `fix:`
the patch, `feat!:`/`BREAKING CHANGE:` the major; `ci:`, `chore:`, `docs:`,
`refactor:` and `test:` do not trigger a release on their own.

Merging the release PR creates the tag and GitHub release, which runs the
`stage` job in the same workflow. That job **stages** the package — it cannot
make a version public, because the trusted publisher is configured stage-only.
A maintainer promotes it with 2FA:

- **npmjs.com** → the package → **Staged Packages** tab → **Approve**, or
- `npm stage list @gobius/t3ctl` then `npm stage approve <stage-id>`

2FA is required either way. `npm stage view <id>` and `npm stage download <id>`
let you inspect the exact tarball before approving.

So a release passes two human gates — merging the release PR, and approving the
staged package — and no long-lived credential is involved in either.

### Trust boundaries, deliberately

- **Staged, not published.** CI stages with provenance; a human promotes with
  2FA. A compromised workflow cannot ship anything to users. This is npm's own
  hardened recommendation, and the stage subcommands can't use OIDC tokens by
  design.
- **Releases come from merging the release PR**, never from an ordinary merge to
  main. Everyday commits only update the pending release PR.
- **`environment: release`.** The OIDC subject npm checks includes the
  environment, so a workflow running outside it cannot publish even from this
  repo. Add required reviewers to that environment in GitHub settings to gate
  releases on a human.
- **`permissions: {}` at the top**, with the job opting into only
  `contents: read` and `id-token: write`.
- **Actions pinned to full commit SHAs**, so a moved tag cannot swap the code.
- **`persist-credentials: false`**, so the job's token isn't left in
  `.git/config`.
- **`--ignore-scripts`** on publish, and the package has zero dependencies, so
  no third-party code executes in the release job.
- **Tag/version agreement is enforced** before publishing, not after.

### One-time trusted-publisher setup

On npmjs.com, package → Settings → Trusted Publisher: organization/user
`Goobles`, repository `t3ctl`, workflow `release.yml`, environment `release`.
Grant it `npm stage publish` only — not `npm publish`. Once that works,
consider disallowing token-based publishes for the package entirely so this
pipeline becomes the only path in.

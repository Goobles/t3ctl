# t3ctl

A controller CLI for [T3 Code](https://github.com/pingdotgg/t3code) — a peer of the
mobile app, not a host. Lists and (eventually) drives threads across all your machines.

T3 Code is MIT-licensed open source. **Read the source before guessing at anything here:**
`docs/user/remote-access.md`, `docs/internals/environment-auth.md`,
`docs/internals/t3-connect.md`, and `packages/contracts/src/orchestration.ts`.

## Status: spike (read-only) working

    node t3ctl.mjs ls              # projects + status badges, per host
    node t3ctl.mjs ls --threads    # expand threads
    node t3ctl.mjs ls --json       # machine-readable
    node t3ctl.mjs host add <name> <origin> <token>

## Auth

The server advertises its own policy at `GET /api/auth/session`; `bearer-access-token`
is a supported session method. `t3 auth` is the documented way to manage access.

    npx t3 auth session issue --label t3ctl --ttl 30d --token-only
    npx t3 auth session list
    npx t3 auth session revoke <session-id>

`t3` is published on npm (the `apps/server` package); `npx t3` works. Note that npx
resolves the latest *published* version, which may lag the Nightly server you're running
— T3 Code warns about client/server version skew. The same CLI ships inside the desktop
app and needs no install, which guarantees an exact version match:

    APP="/Applications/T3 Code (Nightly).app"
    ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/T3 Code (Nightly)" \
      "$APP/Contents/Resources/app.asar/apps/server/dist/bin.mjs" auth session issue --token-only

Note `@t3tools/contracts` and `@t3tools/client-runtime` are `private: true` — readable in
the repo, but not installable from npm. Hence the hand-rolled HTTP client here.

## Endpoints

| Purpose | Endpoint |
|---|---|
| List everything | `GET /api/orchestration/snapshot` |
| Per-thread | `GET /api/orchestration/threads/:threadId` |
| Writes (commands) | `POST /api/orchestration/dispatch` |

Commands are imperative, events past-tense (`thread.create` → `thread.created`).
**The client generates `commandId`, `threadId`, and `projectId`**; `commandId` is the
idempotency key. Exact schemas: `packages/contracts/src/orchestration.ts`.

    project.create  { commandId, projectId, title, workspaceRoot, createdAt,
                      createWorkspaceRootIfMissing? }
    thread.create   { commandId, threadId, projectId, title, modelSelection,
                      runtimeMode, interactionMode?, branch, worktreePath, createdAt }

### Derived thread status

Most-urgent-first: `running` (`session.activeTurnId` or `session.status==="running"`)
› `error` › `snoozed` › `needs-review` (`proposedPlans`) › `settled` › `idle`;
`archived`/`deleted` short-circuit.

## Cross-machine

`t3ctl` is origin-agnostic, so anything that gives a host a reachable URL works:

- **Tailscale** — `t3 serve --tailscale-serve` advertises `https://machine.tailnet.ts.net/`.
  Then `t3ctl host add <name> <url> <token>`.
- **LAN** — `t3 serve --host "$(tailscale ip -4)"` or any bound interface.
- **SSH launch** — desktop-only today; the desktop app starts a remote server and port-forwards.
- **T3 Connect relay** (`relay.t3.codes`) — account-level environment registry, what mobile
  uses off-tailnet. Client-side API is `/v1/client/environment-links`, `.../dpop-token`,
  `.../environment-link-challenges`, `.../devices`. Not implemented here yet; see
  `docs/internals/t3-connect.md` and `packages/contracts/src/relay.ts`.

## Caveats

- Unofficial client. Built against T3 Code Nightly; pin to `snapshot` + `dispatch`.
- A host is only reachable while its T3 Code server is running.
- `snapshot` returns full messages/activities (~900 KB for 215 threads). Fine for `ls`,
  wrong for polling — use `snapshotSequence` for incremental sync.
- Treat pairing tokens like passwords; revoke with `t3 auth session revoke`.

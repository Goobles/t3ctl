# t3ctl

A controller CLI for [T3 Code](https://github.com/pingdotgg/t3code) — a peer of the
mobile app, not a host. Lists and (eventually) drives threads across all your machines.

T3 Code is MIT-licensed open source. **Read the source before guessing at anything here:**
`docs/user/remote-access.md`, `docs/internals/environment-auth.md`,
`docs/internals/t3-connect.md`, and `packages/contracts/src/orchestration.ts`.

## Install

    npm i -g @gobius/t3ctl     # installs a `t3ctl` binary
    npx @gobius/t3ctl ls

## Status: local read + write working; relay transport not started

    t3ctl ls [-t|--threads] [-a|--all] [--json]
    t3ctl host add <name> <origin> <token>
    t3ctl project create <title> <workspace-root>
    t3ctl thread create <project> <title> [--model <instance>/<model>] [--branch <b>]
    t3ctl thread start <thread> <message...>  [--interaction-mode plan] [--model ...]
    t3ctl thread interrupt <thread>
    t3ctl thread settle|archive|unarchive|unpin|delete <thread>

`<project>` resolves by id, title, or workspace root. `<thread>` resolves by id,
exact title, then unique case-insensitive substring (ambiguous matches are listed,
not guessed). The five verb commands above are exactly those whose payload is
`{commandId, threadId}`; `unsettle` carries extra fields and is not among them. `--model` defaults to
`claudeAgent/claude-opus-5`; `instanceId` is the segment before the first slash
(opencode models are themselves slashed, e.g. `opencode/github-copilot/gpt-5.4`).

`thread create` creates an *idle* thread with no messages — it does not start the
agent; use `thread start` for that. The UI never produces this state: it always fires `thread.create` immediately
followed by `thread.turn.start`, a single command that carries the first message
inline (`message: {messageId, role, text, attachments}` plus a `titleSeed`).
`thread.message-sent` and `thread.turn-start-requested` are the resulting *events*,
not commands. Starting a turn is not implemented here yet.

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

## Releasing

Publishing runs in CI via **npm trusted publishing (OIDC)**. There is no `NPM_TOKEN`
anywhere — not in the workflow, not in repo secrets. CI proves its identity with a
short-lived OIDC token that npm verifies against a configured trusted publisher, so
there is no long-lived credential to leak, rotate, or exfiltrate. npm also attaches a
provenance attestation linking the tarball to the exact commit and workflow run.

To cut a release:

    npm version minor          # or patch/major; commits and tags
    git push origin main --follow-tags

The `v*` tag triggers `.github/workflows/release.yml`. Prereleases (`1.2.3-beta.0`)
publish to the `next` dist-tag; everything else to `latest`.

Trust boundaries, deliberately:

- **Tag-triggered, not push-to-main.** Merging never publishes.
- **`environment: release`.** The OIDC subject npm checks includes the environment,
  so a workflow running outside it cannot publish even from this repo. Add required
  reviewers to that environment in GitHub settings to gate releases on a human.
- **`permissions: {}` at the top**, with the job opting into only `contents: read`
  and `id-token: write`.
- **Actions pinned to full commit SHAs**, so a moved tag cannot swap the code.
- **`persist-credentials: false`**, so the job's token isn't left in `.git/config`.
- **`--ignore-scripts`** on publish, and the package has zero dependencies, so no
  third-party code executes in the release job.
- **Tag/version agreement is enforced** before publishing, not after.

One-time setup on npmjs.com (package → Settings → Trusted Publisher):
organization/user `Goobles`, repository `t3ctl`, workflow `release.yml`,
environment `release`. Once that works, consider disallowing token-based publishes
for the package entirely so CI becomes the only path.

## Caveats

- Unofficial client. Built against T3 Code Nightly; pin to `snapshot` + `dispatch`.
- A host is only reachable while its T3 Code server is running.
- `snapshot` returns full messages/activities (~900 KB for 215 threads). Fine for `ls`,
  wrong for polling — use `snapshotSequence` for incremental sync.
- Treat pairing tokens like passwords; revoke with `t3 auth session revoke`.

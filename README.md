# t3ctl

A terminal client for [T3 Code](https://github.com/pingdotgg/t3code) that lists and
drives your coding-agent threads across every machine you run T3 Code on. Register
each host once, then start turns, interrupt runaway agents, and see what's running
everywhere from one prompt — without opening the desktop app.

> Unofficial community client. Not affiliated with T3 Tools. See [Limitations](#limitations).

## Quick start

You need a running T3 Code server (`t3 serve`, or the desktop app, which runs one)
and Node 22+.

```sh
# 1. install
npm i -g @gobius/t3ctl

# 2. mint a token — run this on the machine hosting T3 Code
npx t3 auth session issue --label t3ctl --ttl 30d --token-only

# 3. register that host — t3ctl probes it and names it after the machine
t3ctl host add http://localhost:3773 eyJ2Ijox...

# 4. see everything
t3ctl ls
```

```
laptop http://localhost:3773

  t3ctl  ●1 ◆1 ·3  ~/Code/t3ctl
  api-gateway  ✓2 ·1  ~/Code/api-gateway
```

Add `-t` to expand threads:

```sh
t3ctl ls -t
```

```
laptop http://localhost:3773

  t3ctl  ●1 ◆1 ·3  ~/Code/t3ctl
    ● rewrite the readme for users                                   main claudeAgent
    ◆ add snapshotSequence polling                                   poll claudeAgent
    · flaky release workflow                                         main claudeAgent
```

Projects are sorted most-recently-updated first, and so are the threads inside
them. Thread titles are truncated at 62 characters.

Hosts and tokens are stored in `~/.config/t3ctl/hosts.json` (directory `0700`,
file `0600`). Tokens are stored in plaintext, so treat that file like a password
file — revoke with `npx t3 auth session revoke <session-id>` if it leaks.

## Commands

Run `t3ctl` with no arguments for the built-in summary.

### `t3ctl ls`

List projects and threads across **all** registered hosts, in parallel. Hosts that
don't answer are reported at the end as `unreachable` rather than failing the run.

```sh
t3ctl ls                # projects only, with a status tally per project
t3ctl ls -t             # --threads: expand each project's threads
t3ctl ls -a             # --all: include archived and deleted, and empty projects
t3ctl ls --json         # machine-readable; always includes threads
```

`ls` deliberately has no `--host` filter — it's the "what's happening everywhere"
view. Pipe `--json` through `jq` if you want to slice it:

```sh
t3ctl ls --json | jq -r '.projects[].threads[] | select(.status=="running") | .title'
```

The JSON shape is `{projects: [{host, id, title, workspaceRoot, threads: [{id,
title, branch, status, provider, updatedAt}]}], unreachable: [{host, error}]}`.

### `t3ctl host add <origin> [token] [--name <name>]`

Register (or update) a host. `<origin>` is a scheme + host + optional port, with
any trailing slash trimmed — the scheme is required.

Before writing anything, t3ctl fetches the host's environment descriptor from
`/.well-known/t3/environment`. That endpoint is unauthenticated, so it confirms
you are pointed at a real T3 Code server *before* a token is involved: a wrong
origin fails with `not a T3 Code server` instead of a confusing 401 on your first
`ls`. The descriptor's `environmentId`, `label` and `serverVersion` are stored
alongside the token.

```sh
t3ctl host add https://studio.tailnet-1234.ts.net eyJ2Ijox...
```

The host is named after the machine's own label (`SPR-Gobius-D` becomes
`spr-gobius-d`); pass `--name` to choose your own. Re-running `host add` for an
origin you already have updates that entry in place and keeps the stored token if
you don't pass a new one.

t3ctl warns you when:

- the new host's `serverVersion` differs from your other hosts — the API is not a
  stable public interface, so a version split is worth knowing about
- an origin you already registered now reports a **different `environmentId`**,
  meaning it points at a different machine than it used to and the stored token
  belongs to the old one

The token is optional so you can register a host before minting one, but reads
will fail until you add it.

The older `t3ctl host add <name> <origin> <token>` form still works and prints a
deprecation notice.

### `t3ctl host rm <name>`

```sh
t3ctl host rm desktop
```

### `t3ctl hosts`

List registered hosts, probing each one in parallel for its label, environment id
(shortened), server version and reachability. `t3ctl host` with no subcommand does
the same thing.

```sh
t3ctl hosts
```

```
● laptop         SPR-Gobius-D       9d9d9921  0.0.38-nightly.20260901.1250  http://localhost:3773
✕ desktop        Desktop            11111111  0.0.31-nightly.20260801.0900  https://studio.tailnet-1234.ts.net  cannot reach …
```

Unreachable hosts are dimmed and show the values last recorded, not live ones.
`ls` deliberately does *not* probe — it stays a single request per host.

### `t3ctl project create <title> <workspace-root>`

Register an existing directory on the host as a project. The path is resolved
locally (`~` expands) and must already exist — t3ctl will not create it.

```sh
t3ctl project create t3ctl ~/Code/t3ctl
```

> Note: the workspace root is interpreted on the **host**, so this really only
> makes sense for a host whose filesystem you share — i.e. `localhost`. For a
> remote host, pass the remote absolute path and skip the `~` shorthand.

### `t3ctl thread create <project> <title>`

Create a thread. This produces an **idle thread with no messages** — it does not
start the agent. Use `thread start` for that.

```sh
t3ctl thread create t3ctl "rewrite the readme for users" --branch docs/readme
```

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--model <instance>/<model>` | `claudeAgent/claude-opus-5` | Provider instance and model |
| `--branch <name>` | none | Git branch for the thread |
| `--worktree <path>` | none | Explicit worktree path |
| `--runtime-mode <mode>` | `full-access` | `approval-required`, `auto-accept-edits`, `auto`, `full-access` |
| `--interaction-mode <mode>` | `default` | `default` or `plan` |
| `--host <name>` | the only host | Which host to act on |

`--model` splits on the **first** slash, so slashed model names work as-is:
`--model opencode/github-copilot/gpt-5.4`.

### `t3ctl thread start <thread> <message...>`

Send a message and run the agent. Everything after the thread reference is the
message — no quoting needed.

```sh
t3ctl thread start "rewrite the readme" move the endpoint tables into CONTRIBUTING.md
```

```
started rewrite the readme for users
  id    0f5c1e2a-...
  model claudeAgent/claude-opus-5
  mode  full-access / default
  seq   4471
```

Accepts `--model`, `--runtime-mode`, `--interaction-mode`, and `--host`. Unlike
`thread create`, `--model` has no default here: the thread's existing model is
reused unless you override it. Use `--interaction-mode plan` to make the agent
plan instead of edit:

```sh
t3ctl thread start "flaky release workflow" --interaction-mode plan why does the tag job race?
```

### `t3ctl thread interrupt <thread>`

Stop the turn that's currently running.

```sh
t3ctl thread interrupt "rewrite the readme"
```

### `t3ctl thread settle|archive|unarchive|unpin|delete <thread>`

Thread lifecycle. Each takes a single thread reference (plus `--host`).

```sh
t3ctl thread settle "rewrite the readme"    # mark as done, drop out of the active list
t3ctl thread archive "flaky release workflow"
t3ctl thread unarchive 0f5c1e2a-...
t3ctl thread unpin "api rate limits"
t3ctl thread delete "scratch experiment"
```

`delete` is not prompted and not undoable from t3ctl — check with `ls -t` first.

## Referring to projects and threads

You rarely need to paste a UUID.

**Projects** resolve by id, then exact title, then workspace root (`~` expands,
relative paths are resolved against your current directory).

**Threads** resolve by id, then exact title, then a unique case-insensitive
substring of the title. Ambiguous substrings are listed rather than guessed:

```
error "readme" matches 3 threads:
  0f5c1e2a-...  rewrite the readme for users
  7b31d004-...  readme screenshots
  c9e0a115-...  fix readme badge
```

Deleted threads are never resolution candidates.

## Choosing a host

Write commands act on one host. With a single host registered, that one is
implied. With more than one, pass `--host`:

```sh
t3ctl thread start --host desktop "api rate limits" pick this back up
```

Otherwise you get `multiple hosts; pass --host <laptop|desktop>`.

## Reading `ls` output

Each project line ends with a tally like `●1 ◆1 ·3` — one icon per status, with a
count. With `-t`, each thread line starts with its own icon.

| Icon | Status | What it means |
|---|---|---|
| `●` green | `running` | A turn is in flight right now. The agent is working. |
| `✕` red | `error` | The session or its most recent turn failed. Needs you. |
| `◆` yellow | `needs-review` | The agent produced a plan and is waiting for you to approve it. |
| `☾` grey | `snoozed` | Hidden on purpose until a wake time (set in the app) passes. |
| `✓` grey | `settled` | You marked it done. It stays settled until new activity un-settles it. |
| `·` grey | `idle` | Alive, nothing running, nothing waiting on you. Freshly created threads land here. |
| `▪` grey | `archived` | Archived. Hidden unless you pass `-a`. |
| `✗` grey | `deleted` | Deleted. Hidden unless you pass `-a`. |

The two worth acting on are `✕` and `◆`: red means something broke, yellow means an
agent is blocked waiting for your approval. `●` is just work in progress.

One status per thread, most urgent first — a thread that is both running and
settled shows as `running`.

## Several machines

t3ctl only ever stores an origin string, so **any transport that gives a host a
reachable URL works.** There's nothing to configure beyond `host add`.

- **Tailscale** — on the host, `npx t3 serve --tailscale-serve` publishes it at
  `https://machine.tailnet.ts.net/`. Register that URL.
- **LAN** — `npx t3 serve --host 0.0.0.0` (or a specific interface), then register
  `http://192.168.1.x:3773`. Read the URL `t3 serve` prints; it picks another port
  if the default is taken.
- **SSH port-forward** — `ssh -N -L 3773:localhost:3773 you@box`, then register
  `http://localhost:3773`. Good for hosts you don't want exposed at all.

**One token per host.** Tokens are issued by the server they belong to, so run
`npx t3 auth session issue --label t3ctl --ttl 30d --token-only` on each machine
and give each host its own short name:

```sh
t3ctl host add http://localhost:3773               eyJ2Ijox...
t3ctl host add https://studio.tailnet-1234.ts.net  eyJ2Ijox...
t3ctl host add http://10.0.0.42:3773               eyJ2Ijox...
t3ctl ls -t
```

`ls` then fans out to all three at once. Machines that are asleep or offline show
up as `unreachable` and don't block the rest.

T3 Code's own **T3 Connect relay** (what the mobile app uses when you're off your
tailnet) is **not planned**: the relay's `dpop-token` exchange only accepts a
Clerk *session* JWT carrying the relay audience, and its allowed scopes are keyed
by `client_id`, which is pinned to `t3-mobile` and `t3-web`. A third-party CLI has
no way to present either. The transports above are the options.

## Limitations

Worth knowing before you build a workflow on this:

- **Unofficial.** Not affiliated with or supported by T3 Tools. Written against
  T3 Code Nightly's HTTP API, which is not a documented public API — **endpoints
  and payloads can change without warning** and a T3 Code update may break t3ctl
  until it catches up.
- **A host is only reachable while its T3 Code server is running.** t3ctl can't
  wake a machine, launch a server, or queue work for later. If the desktop app is
  closed and no `t3 serve` is running, that host is `unreachable`.
- **`thread create` doesn't run anything.** It leaves an idle thread with no
  messages — a state the desktop UI never produces. Follow it with `thread start`,
  or the thread just sits there.
- **Not everything the API supports is wired up.** No `pin`, `unsettle`,
  `snooze`/`unsnooze`, no reading message content, no live tailing of a running
  turn. `unpin` exists without `pin` because only some of these share a payload
  shape — see [CONTRIBUTING.md](CONTRIBUTING.md).
- **`ls` fetches full snapshots.** Fine interactively; too heavy to poll in a
  loop.
- **Tokens sit in plaintext** in `~/.config/t3ctl/hosts.json`. No keychain
  integration. Scope them with `--ttl` and revoke when done.

## Contributing

Protocol notes, the command vocabulary, status-derivation rules, and the release
process are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

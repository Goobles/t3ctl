#!/usr/bin/env node
// t3ctl — a controller CLI for T3 Code hosts.
// Peer of the mobile app: pairs once per host, then reads/controls remotely.
// Spike scope: host registry + read-only listing.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { Command } from 'commander';
import type { OptionValues } from 'commander';
import os from 'node:os';
import path from 'node:path';

// ---- domain types -------------------------------------------------------
// Shapes are the subset of T3 Code's API that t3ctl actually reads. T3 Code
// speaks one of two orchestration protocols (see "protocol detection" below):
// 1 is packages/contracts/src/orchestration.ts upstream, 2 ("Orchestrator V2")
// is orchestrationV2.ts, with project mutations in project.ts.

type Host = {
  name: string;
  origin: string;
  token: string | null;
  environmentId?: string;
  label?: string;
  serverVersion?: string;
  timeoutMs?: number;
  /** ssh login the host is reached through; origin is the local tunnel end. */
  ssh?: string;
  sshLocalPort?: number;
  sshRemotePort?: number;
  t3Version?: string;
};

type Descriptor = {
  environmentId: string;
  label: string;
  serverVersion: string;
  /** Absent on servers from before protocol negotiation, which all speak protocol 1. */
  orchestrationProtocolVersion?: number;
  platform?: { os: string; arch: string };
};

/** A provider option such as `effort` or `fastMode`; the provider decides which ids it knows. */
type ModelOption = { id: string; value: string | boolean };

type ModelSelection = { instanceId: string; model: string; options?: ModelOption[] };

type Thread = {
  id: string;
  projectId: string;
  title: string;
  branch?: string | null;
  worktreePath?: string | null;
  createdAt?: string;
  updatedAt: string;
  deletedAt?: string | null;
  archivedAt?: string | null;
  settledAt?: string | null;
  unsettledAt?: string | null;
  snoozedUntil?: string | null;
  runtimeMode?: string;
  modelSelection?: ModelSelection | null;
  // Protocol 2 fields.
  providerInstanceId?: string | null;
  /** `idle`, or the status of the latest run (`running`, `failed`, `completed`, ...). */
  status?: string;
  activeRunId?: string | null;
  lastError?: string | null;
  hasActionableProposedPlan?: boolean;
  /** Pull requests linked to the thread (ThreadPullRequestLink); absent on servers from before linking. */
  pullRequests?: PullRequestLink[];
  // Protocol 1 fields.
  session?: { status: string; providerName?: string | null; activeTurnId?: string | null } | null;
  latestTurn?: { state?: string } | null;
  proposedPlans?: unknown[];
  titleRegeneration?: unknown | null;
  /** Only ever populated by the per-thread endpoint; the shell snapshot has no messages. */
  messages?: ThreadMessage[];
};

/**
 * The fields t3ctl reads from a thread's pull request link. `snapshot` is the
 * host state T3 last synced, null until the first sync.
 */
type PullRequestLink = {
  repository: string;
  number: number;
  url: string;
  /** `stack-dismissed` marks a stack member the user unlinked; T3 hides those. */
  source: string;
  snapshot: { state: string } | null;
};

/** A conversation message from a thread projection. */
type ThreadMessage = {
  id?: string;
  /** Protocol 1's name for `id`. */
  messageId?: string;
  /** Protocol 2: `user` for a person's message; `agent` when an agent wrote it into the thread. */
  createdBy?: string;
  role?: string;
  text?: string;
  createdAt?: string;
};

type Project = {
  id: string;
  title: string;
  workspaceRoot: string;
  updatedAt: string;
  deletedAt?: string | null;
};

type Snapshot = { snapshotSequence: number; projects: Project[]; threads: Thread[] };

/** Option names as the command implementations spell them (kebab-case). */
type Flags = Partial<Record<
  'host' | 'model' | 'branch' | 'worktree' | 'name' | 'timeout' | 'runtime-mode' | 'interaction-mode' | 'ttl' | 't3-version' |
  'base' | 'message',
  string
>> & { option?: string[]; 'new-worktree'?: boolean; json?: boolean };

/** An orchestration command; `type` selects the shape the server validates. */
type OrchestrationCommand = { type: string; commandId: string } & Record<string, unknown>;

type ThreadStatus =
  | 'running' | 'error' | 'snoozed' | 'needs-review'
  | 'settled' | 'idle' | 'archived' | 'deleted';


const CONFIG_DIR = path.join(os.homedir(), '.config', 't3ctl');
const HOSTS_FILE = path.join(CONFIG_DIR, 'hosts.json');

const readHosts = (): Host[] => {
  if (!fs.existsSync(HOSTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')).hosts ?? [];
};

const writeHosts = (hosts: Host[]): void => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(HOSTS_FILE, JSON.stringify({ hosts }, null, 2), { mode: 0o600 });
};

// ---- protocol detection ---------------------------------------------------
// T3 Code moved from orchestration protocol 1 to 2 ("Orchestrator V2"), and the
// two share almost no routes: protocol 1 reads /api/orchestration/snapshot and
// takes commands at POST /api/orchestration/dispatch; protocol 2 reads
// /api/orchestration/shell and takes commands only over the websocket, under
// other names. Neither answers the other's routes with an error — an unknown
// GET gets the web app's index.html — so the protocol is asked for, not guessed:
// the environment descriptor carries `orchestrationProtocolVersion`, and is
// missing it on servers from before protocol negotiation, which speak 1.
type Protocol = 1 | 2;

// Asked once per host per run. Not stored in hosts.json: a server can update
// between two runs, and the descriptor is one small unauthenticated request.
const protocols = new Map<string, Promise<Protocol>>();

const protocolOf = (host: Host): Promise<Protocol> => {
  let known = protocols.get(host.origin);
  if (!known) {
    known = (async () => {
      await ensureTunnel(host);
      const { orchestrationProtocolVersion: v } = await probe(host.origin, host.timeoutMs ?? 5000);
      if (v === undefined || v === 1) return 1;
      if (v === 2) return 2;
      throw new Error(`${host.name} speaks orchestration protocol ${v}, which this t3ctl does not know — update t3ctl`);
    })();
    // A failed probe is not remembered, so a later call in the same run can retry.
    known.catch(() => protocols.delete(host.origin));
    protocols.set(host.origin, known);
  }
  return known;
};

// Protocol 2 rejects orchestration reads without this header (HTTP 400) and
// closes a socket opened without the query parameter
// (packages/contracts/src/environment.ts).
const PROTOCOL_2_HEADER = { 'x-t3-orchestration-protocol': '2' };
const PROTOCOL_2_QUERY = 'orchestrationProtocol=2';

const authHeaders = (host: Host): Record<string, string> => (host.token ? { authorization: `Bearer ${host.token}` } : {});

/** GET a JSON orchestration endpoint, failing loudly on anything that is not JSON. */
/** GET a JSON orchestration endpoint in the host's protocol, failing loudly on anything that is not JSON. */
const getJson = async <T>(host: Host, route: string): Promise<T> => {
  const protocol = await protocolOf(host);
  const res = await fetch(`${host.origin}${route}`, {
    headers: { ...authHeaders(host), ...(protocol === 2 ? PROTOCOL_2_HEADER : {}) },
    signal: AbortSignal.timeout(host.timeoutMs ?? 15000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${host.name}: HTTP ${res.status} ${body.slice(0, 300)}`.trim());
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${host.name}: ${route} did not answer with JSON (orchestration protocol ${protocol})`);
  }
};

// Protocol 2's shell snapshot only carries live projects and threads; archived
// threads come in their own list, merged in so `ls --all` still shows them.
const snapshot = async (host: Host): Promise<Snapshot> => {
  if (await protocolOf(host) === 1) return getJson<Snapshot>(host, '/api/orchestration/snapshot');
  const shell = await getJson<Snapshot & { archivedThreads?: Thread[] }>(host, '/api/orchestration/shell');
  return { snapshotSequence: shell.snapshotSequence, projects: shell.projects, threads: [...shell.threads, ...(shell.archivedThreads ?? [])] };
};

// Run statuses that mean the thread is busy (OrchestrationV2RunStatus).
const ACTIVE_RUN_STATUSES = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);

// Derived status. Order matters: most urgent wins. Each line reads the fields
// of both protocols; a thread only ever carries one protocol's set.
const threadStatus = (t: Thread): ThreadStatus => {
  if (t.deletedAt) return 'deleted';
  if (t.archivedAt) return 'archived';
  if (t.activeRunId || ACTIVE_RUN_STATUSES.has(t.status ?? '')) return 'running';
  if (t.session?.activeTurnId || t.session?.status === 'running') return 'running';
  if (t.status === 'failed' || t.lastError) return 'error';
  if (t.session?.status === 'error' || t.latestTurn?.state === 'error') return 'error';
  if (t.snoozedUntil && new Date(t.snoozedUntil) > new Date()) return 'snoozed';
  if (t.hasActionableProposedPlan || t.proposedPlans?.length) return 'needs-review';
  if (t.settledAt && !t.unsettledAt) return 'settled';
  return 'idle';
};

// Colour only on a terminal, and never when NO_COLOR is set to anything
// (https://no-color.org), so piped output and scripts get plain text. Decided
// per stream: `t3ctl ls 2>log` still colours the table on screen.
const colours = (stream: NodeJS.WriteStream): boolean => Boolean(stream.isTTY) && !process.env['NO_COLOR'];
const sgr = (code: string, s: string, stream: NodeJS.WriteStream = process.stdout): string =>
  (colours(stream) ? `\x1b[${code}m${s}\x1b[0m` : s);

const ICON = {
  running: sgr('32', '●'), error: sgr('31', '✕'), 'needs-review': sgr('33', '◆'),
  snoozed: sgr('90', '☾'), settled: sgr('90', '✓'), idle: sgr('90', '·'),
  archived: sgr('90', '▪'), deleted: sgr('90', '✗'),
};
/** `catch` binds `unknown`; every call site wants the same string out of it. */
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const dim = (s: string, stream?: NodeJS.WriteStream) => sgr('90', s, stream);
// Usage errors are user errors: print to stderr and exit non-zero so scripts
// can tell them apart from success.
const usage = (message: string): void => {
  console.error(message);
  process.exitCode = 1;
};
const bold = (s: string) => sgr('1', s);

type Reached = { host: Host; snap: Snapshot };
type Unreached = { host: Host; error: string };

const collect = async (hosts: Host[]): Promise<{ ok: Reached[]; failed: Unreached[] }> => {
  const results = await Promise.allSettled(hosts.map(async (h) => ({ host: h, snap: await snapshot(h) })));
  const ok: Reached[] = [];
  const failed: Unreached[] = [];
  results.forEach((r, i) => {
    const host = hosts[i];
    if (!host) return;
    if (r.status === 'fulfilled') ok.push(r.value);
    else failed.push({ host, error: errorMessage(r.reason) });
  });
  return { ok, failed };
};

type LsOptions = { threads?: boolean; all?: boolean; json?: boolean };

// The same links T3's own list_thread_pull_requests tool reports. `state` is
// left out until T3 has synced the PR with its host.
const pullRequestsOf = (t: Thread) => (t.pullRequests ?? [])
  .filter((l) => l.source !== 'stack-dismissed')
  .map((l) => ({ url: l.url, repository: l.repository, number: l.number, ...(l.snapshot ? { state: l.snapshot.state } : {}) }));

const cmdLs = async ({ threads: showThreads, all: showAll, json: asJson }: LsOptions): Promise<void> => {
  const hosts = readHosts();
  if (!hosts.length) return console.error('No hosts registered. Run: t3ctl host add <origin> <token>');

  const [{ ok, failed }] = await Promise.all([collect(hosts), warnRivals(hosts)]);

  if (asJson) {
    const out = ok.flatMap(({ host, snap }) => snap.projects
      .filter((p) => showAll || !p.deletedAt)
      .map((p) => ({
        host: host.name, id: p.id, title: p.title, workspaceRoot: p.workspaceRoot,
        threads: snap.threads.filter((t) => t.projectId === p.id)
          .filter((t) => showAll || (!t.deletedAt && !t.archivedAt))
          .map((t) => ({ id: t.id, title: t.title, branch: t.branch, status: threadStatus(t), provider: t.providerInstanceId ?? t.session?.providerName ?? null, updatedAt: t.updatedAt, pullRequests: pullRequestsOf(t) })),
      })));
    console.log(JSON.stringify({ projects: out, unreachable: failed.map((f) => ({ host: f.host.name, error: f.error })) }, null, 2));
    return;
  }

  for (const { host, snap } of ok) {
    console.log(`\n${bold(host.name)} ${dim(host.origin)}`);
    const projects = snap.projects.filter((p) => showAll || !p.deletedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    for (const p of projects) {
      const threads = snap.threads.filter((t) => t.projectId === p.id)
        .filter((t) => showAll || (!t.deletedAt && !t.archivedAt))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (!threads.length && !showAll) continue;

      const counts: Partial<Record<ThreadStatus, number>> = {};
      for (const t of threads) counts[threadStatus(t)] = (counts[threadStatus(t)] ?? 0) + 1;
      const badge = Object.entries(counts).map(([k, v]) => `${ICON[k as ThreadStatus] ?? '?'}${v}`).join(' ');

      console.log(`  ${bold(p.title)}  ${badge}  ${dim(p.workspaceRoot.replace(os.homedir(), '~'))}`);
      if (!showThreads) continue;
      for (const t of threads) {
        const s = threadStatus(t);
        const meta = [t.branch, t.providerInstanceId ?? t.session?.providerName].filter(Boolean).join(' ');
        console.log(`    ${ICON[s] ?? '?'} ${(t.title || '(untitled)').slice(0, 62).padEnd(62)} ${dim(meta)}`);
      }
    }
  }
  for (const f of failed) console.error(`\n${sgr('31', 'unreachable', process.stderr)} ${f.host.name}: ${f.error}`);
};

// ---- host registry ------------------------------------------------------
// The descriptor at /.well-known/t3/environment is UNAUTHENTICATED, so probing
// it answers "is anyone home, and is it T3 Code?" without a token — a wrong
// origin fails here instead of as a baffling 401 on the first real call.
// Schema: ExecutionEnvironmentDescriptor in packages/contracts/src/environment.ts.

const DESCRIPTOR_PATH = '/.well-known/t3/environment';

const probe = async (origin: string, timeoutMs = 5000): Promise<Descriptor> => {
  let res: Response;
  try {
    res = await fetch(`${origin}${DESCRIPTOR_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // Node's fetch reports a bare "fetch failed"; the cause carries the real reason.
    const e = error as { name?: string; message?: string; cause?: { message?: string } };
    const why = e.name === 'TimeoutError' ? `no response in ${timeoutMs}ms`
      : (e.cause?.message ?? e.message ?? String(error));
    throw new Error(`cannot reach ${origin}: ${why}`);
  }
  const notT3 = (why: string) => new Error(`not a T3 Code server (${DESCRIPTOR_PATH} ${why})`);
  if (!res.ok) throw notT3(`returned HTTP ${res.status}`);
  let d: Record<string, unknown>;
  try { d = (await res.json()) as Record<string, unknown>; } catch { throw notT3('is not JSON'); }
  const required = ['environmentId', 'label', 'serverVersion'] as const;
  const missing = required.filter((k) => typeof d[k] !== 'string' || !d[k]);
  if (missing.length) throw notT3(`is missing ${missing.join(', ')}`);
  return {
    environmentId: d['environmentId'] as string,
    label: d['label'] as string,
    serverVersion: d['serverVersion'] as string,
    ...(typeof d['orchestrationProtocolVersion'] === 'number' ? { orchestrationProtocolVersion: d['orchestrationProtocolVersion'] } : {}),
  };
};

const shortId = (id?: string | null) => (id ? id.slice(0, 8) : '-');
const warn = (message: string) => console.error(`${sgr('33', 'warning', process.stderr)} ${message}`);

// The name is what you type in --host, so derive a typeable slug from the label
// rather than using the label verbatim.
const slugify = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'host';

const uniqueName = (base: string, hosts: Host[]): string => {
  if (!hosts.some((h) => h.name === base)) return base;
  for (let n = 2; ; n++) if (!hosts.some((h) => h.name === `${base}-${n}`)) return `${base}-${n}`;
};

const isOrigin = (value?: string) => /^https?:\/\//i.test(value ?? '');

const parseHostAdd = (pos: string[]): { origin: string; token: string | null } | null => {
  const [origin, token] = pos;
  return origin && isOrigin(origin) ? { origin, token: token ?? null } : null;
};

const HOST_ADD_USAGE = 'usage: t3ctl host add <origin> [token] [--name <name>]\n' +
  '       an origin needs a scheme, e.g. http://localhost:3773';

const cmdHostAdd = async (pos: string[], flags: Flags, hosts: Host[]): Promise<void> => {
  // Validate before any network or registry work so a bare `host add` prints
  // usage instead of stalling on a probe.
  const parsed = parseHostAdd(pos);
  if (!parsed) return usage(HOST_ADD_USAGE);

  const origin = parsed.origin.replace(/\/$/, '');
  const descriptor = await probe(origin);
  // Re-pointing a named host at another port of the same environment (see the
  // split-brain guard) keeps its token: both ports serve one auth database.
  const existing = hosts.find((h) => h.origin === origin) ??
    hosts.find((h) => !h.ssh && h.name === flags.name && h.environmentId === descriptor.environmentId);

  // A changed environmentId on a known origin means the origin now points at a
  // different machine — the stored token almost certainly belongs to the old one.
  if (existing?.environmentId && existing.environmentId !== descriptor.environmentId) {
    warn(`${origin} is now a DIFFERENT environment\n` +
      `  was ${existing.environmentId} (${existing.label ?? 'unknown'})\n` +
      `  now ${descriptor.environmentId} (${descriptor.label})\n` +
      `  the token stored for "${existing.name}" was issued by the old one and will likely fail`);
  }

  const name = flags.name ?? existing?.name ??
    uniqueName(slugify(descriptor.label), hosts);
  const token = parsed.token ?? existing?.token ?? null;

  const others = hosts.filter((h) => h.name !== name && h.origin !== origin && h.serverVersion);
  const skewed = [...new Set(others.flatMap((h) => (h.serverVersion ? [h.serverVersion] : [])))]
    .filter((v) => v !== descriptor.serverVersion);
  if (skewed.length) warn(`serverVersion ${descriptor.serverVersion} differs from other hosts: ${skewed.join(', ')}`);

  writeHosts(hosts.filter((h) => h.name !== name && h.origin !== origin).concat({
    name, origin, token,
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    serverVersion: descriptor.serverVersion,
  }));
  console.log(`added ${bold(name)} -> ${origin}\n  label   ${descriptor.label}\n` +
    `  env     ${descriptor.environmentId}\n  version ${descriptor.serverVersion}`);
  if (!token) warn(`no token stored for ${name} — reads will fail until you run: t3ctl host add ${origin} <token>`);
};

const cmdHostsList = async (hosts: Host[]): Promise<void> => {
  if (!hosts.length) return console.log('(no hosts)');
  await Promise.allSettled(hosts.filter((h) => h.ssh).map((h) => ensureTunnel(h)));
  const probes = await Promise.allSettled(hosts.map((h) => probe(h.origin)));
  const drifted: { h: Host; live: Descriptor }[] = [];
  hosts.forEach((h, i) => {
    const p = probes[i];
    const live = p?.status === 'fulfilled' ? p.value : null;
    if (live && h.environmentId && h.environmentId !== live.environmentId) drifted.push({ h, live });
    const icon = live ? ICON.running : ICON.error;
    const label = live?.label ?? h.label ?? '-';
    const env = shortId(live?.environmentId ?? h.environmentId);
    const version = live?.serverVersion ?? h.serverVersion ?? '-';
    // Values for an unreachable host are whatever was last stored, so dim the
    // whole row to keep remembered data visually distinct from probed data.
    const cell = (text: string, width: number) => (live ? text.padEnd(width) : dim(text.padEnd(width)));
    const where = dim(h.ssh ? `${h.ssh} -> ${h.origin}` : h.origin);
    console.log(`${icon} ${live ? bold(h.name.padEnd(14)) : dim(h.name.padEnd(14))} ${cell(label, 18)} ${dim(env.padEnd(9))} ${cell(version, 28)} ${where}` +
      (live || !p || p.status !== 'rejected' ? '' : ` ${dim(errorMessage(p.reason))}`));
  });
  for (const { h, live } of drifted) {
    warn(`${h.name} (${h.origin}) is now a DIFFERENT environment\n` +
      `  was ${h.environmentId} (${h.label ?? 'unknown'})\n  now ${live.environmentId} (${live.label})`);
  }
  await warnRivals(hosts);
};

// ---- ssh hosts ----------------------------------------------------------
// `t3ctl host add agent@box` fully bootstraps a remote T3 Code host: detect a
// running server, install the boot service if none, mint a token, and keep a
// local ssh port-forward alive. Three properties of T3 Code make "just an ssh
// login" enough:
//   * the server records {pid, port} in ~/.t3/userdata/server-runtime.json, so
//     the port is discoverable, never hardcoded (3773 or an ephemeral fallback,
//     rewritten on every start);
//   * `t3 auth session issue` mints a bearer token filesystem-locally — no HTTP,
//     no --port — valid for the already-running server sharing ~/.t3, so t3ctl
//     can mint its own token over ssh;
//   * `t3 service install` is per-user launchd/systemd (no sudo, macOS/Linux);
//   * the desktop app runs its server with its own Electron binary in node mode
//     (ELECTRON_RUN_AS_NODE=1), from the server bundle in its app.asar — and
//     that bundle is the t3 CLI too, so a token for a desktop server is minted
//     with the app itself: no npm, and exactly the running server's version.
// Remote shell scripts pass data back on stdout as lines starting with a
// marker, parsed bottom-up: `t3 auth` can leak Effect error logs onto stdout
// (the desktop's own SSH path parses the same way, tunnel.ts:791).

// npm package is literally `t3`; exact versions are pinned because the boot
// service installs that same version into its pinned runtime.
const SSH_READY_MS = 90_000; // server readiness after install (npm download can be slow)
const TUNNEL_WAIT_MS = 30_000; // ssh auth may prompt interactively; give it time
const PROBE_MS = 2500; // liveness probe of the local tunnel end
const T3_PACKAGE = 't3';

const SSH_SCRIPT = `set -eu
# PATH discovery for NON-INTERACTIVE ssh shells, trimmed from T3 Code's own
# remote runner (packages/ssh/src/tunnel.ts REMOTE_NODE_ENV_SCRIPT): plain PATH
# additions, version-manager shims, nvm. Engine checks and the "prefer installed
# t3" branch are dropped on purpose — t3ctl pins an exact version and runs npx.
prepend_path_if_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}
ensure_node_path() {
  command -v node >/dev/null 2>&1 && return 0
  prepend_path_if_dir "$HOME/.local/bin"
  prepend_path_if_dir "$HOME/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/usr/bin"
  prepend_path_if_dir "/bin"
  if [ -z "\${VOLTA_HOME:-}" ]; then VOLTA_HOME="$HOME/.volta"; fi
  prepend_path_if_dir "$VOLTA_HOME/bin"
  prepend_path_if_dir "$HOME/.asdf/shims"
  prepend_path_if_dir "$HOME/.asdf/bin"
  if [ ! -x "$HOME/.asdf/shims/node" ] && [ -s "$HOME/.asdf/asdf.sh" ]; then . "$HOME/.asdf/asdf.sh"; fi
  prepend_path_if_dir "$HOME/.local/share/mise/shims"
  prepend_path_if_dir "$HOME/.mise/shims"
  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then eval "$(mise activate sh)" >/dev/null 2>&1 || true; fi
  if [ -z "\${FNM_DIR:-}" ]; then FNM_DIR="$HOME/.local/share/fnm"; fi
  prepend_path_if_dir "$FNM_DIR"
  prepend_path_if_dir "$HOME/.fnm"
  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)" >/dev/null 2>&1 || true
    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true
  fi
  prepend_path_if_dir "$HOME/.nodenv/bin"
  prepend_path_if_dir "$HOME/.nodenv/shims"
  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then eval "$(nodenv init -)" >/dev/null 2>&1 || true; fi
  if [ -z "\${NVM_DIR:-}" ]; then NVM_DIR="$HOME/.nvm"; fi
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true
    fi
  fi
  if ! command -v node >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
    for NODE_BIN in "$NVM_DIR"/versions/node/*/bin; do
      if [ -x "$NODE_BIN/node" ]; then PATH="$NODE_BIN:$PATH"; fi
    done
  fi
  command -v node >/dev/null 2>&1
}
# npm extracts a package before running its deps' native builds; a failed
# node-pty build leaves the npx cache WITHOUT a t3 bin while \`npx --yes\` still
# exits 0 (same guard as T3 Code's require_installed_t3_cli). Resolve up front
# so the failure is reported here, with npm's own output on stderr.
require_t3_cli() {
  T3_CLI_PATH="$(npx --yes --package t3@"$1" -- sh -c 'command -v t3' 2>/dev/null || true)"
  if [ -n "$T3_CLI_PATH" ]; then return 0; fi
  printf 'npm installed t3@"%s" but produced no t3 executable — usually a native dependency (node-pty) failed to build. Install a C toolchain on this host (Debian/Ubuntu: build-essential, Fedora/RHEL: gcc-c++ make, macOS: xcode-select --install) and retry.\\n' "$1" >&2
  return 1
}
# detect: is there a T3 Code server running on this machine? The runtime file is
# rewritten on every server start and cleared on shutdown, so its pid is
# checked before its port is trusted (stale file, reused port).
RUNTIME_JSON="$HOME/.t3/userdata/server-runtime.json"
detect() {
  if ! ensure_node_path; then
    printf 'T3CTL {"node":false}\\n'
    return 0
  fi
  node - "$RUNTIME_JSON" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
// The server's executable is a desktop app's when an Electron app.asar sits where
// Electron keeps it: Contents/Resources on macOS, resources/ beside it on Linux.
const desktopCli = (pid) => {
  try {
    const mac = process.platform === 'darwin';
    const exe = mac
      ? require('node:child_process').execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()
      : fs.readlinkSync('/proc/' + pid + '/exe');
    const asar = path.join(path.dirname(exe), ...(mac ? ['..', 'Resources'] : ['resources']), 'app.asar');
    // an app upgraded under its running server leaves /proc/<pid>/exe as "<path> (deleted)"
    return fs.existsSync(exe) && fs.existsSync(asar) ? { exe, bin: path.join(asar, 'apps', 'server', 'dist', 'bin.mjs') } : null;
  } catch {
    return null;
  }
};
try {
  const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const pid = Number(r.pid), port = Number(r.port);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) throw 0;
  const origin = new URL(String(r.origin ?? ''));
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)) throw 0;
  process.kill(pid, 0);
  const desktop = desktopCli(pid);
  process.stdout.write('T3CTL ' + JSON.stringify(desktop ? { running: true, port, desktop } : { running: true, port }) + '\\n');
} catch {
  process.stdout.write('T3CTL {"running":false}\\n');
}
NODE
}
case "$1" in
  detect) detect ;;
  install)
    ensure_node_path || { printf 'no node on this machine — install Node 22+ (non-interactive shells may need a version manager configured)\\n' >&2; exit 1; }
    require_t3_cli "$2" || exit 1
    exec npx --yes --package t3@"$2" t3 service install
    ;;
  token)
    # $5 $6: a desktop app's executable and server bundle, from detect
    if [ -n "\${5:-}" ]; then
      exec env ELECTRON_RUN_AS_NODE=1 "$5" "$6" auth session issue --json --label "$3" --ttl "$4"
    fi
    ensure_node_path || { printf 'no node on this machine\\n' >&2; exit 1; }
    require_t3_cli "$2" || exit 1
    exec npx --yes --package t3@"$2" t3 auth session issue --json --label "$3" --ttl "$4"
    ;;
  *) printf 'unknown op: %s\\n' "$1" >&2; exit 2 ;;
esac
`;

// One ssh invocation, script on stdin (`sh -s -- op version ...` — POSIX,
// works on dash/busybox). install/token stream stderr through to the user;
// the piped stdin is required for the script itself. `streamStderr` matters:
// a cold npx on the remote downloads the whole t3 package, which can take
// minutes, and a buffered stderr shows the user nothing while it runs.
type SshResult = { status: number; stdout: string; stderr: string };

// ssh joins its arguments into one string for the remote shell, so each is
// single-quoted to survive it — a desktop app's path has spaces.
const shellQuote = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`;

const sshRun = (target: string, args: string[], { streamStderr = false } = {}): SshResult => {
  const res = spawnSync('ssh', ['-o', 'ConnectTimeout=15', target, 'sh', '-s', '--', ...args.map(shellQuote)], {
    input: SSH_SCRIPT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: streamStderr ? ['pipe', 'pipe', 'inherit'] : 'pipe',
  });
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new Error('ssh not found locally');
  return { status: res.status ?? 1, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
};

type DesktopCli = { exe: string; bin: string };
type DetectResult = { node?: boolean; running?: boolean; port?: number; desktop?: DesktopCli };

// Bottom-up scan for the last T3CTL JSON marker — immune to npm chatter above it.
const sshDetect = (target: string): DetectResult => {
  const res = sshRun(target, ['detect']);
  if (res.status !== 0) throw new Error(`ssh to ${target} failed (exit ${res.status})${res.stderr.trim() ? `: ${res.stderr.trim().split('\n').slice(-2).join('\n')}` : ''}`);
  const line = res.stdout.split('\n').reverse().find((l) => l.startsWith('T3CTL {'));
  if (!line) throw new Error(`detect on ${target} produced no answer`);
  return JSON.parse(line.slice('T3CTL '.length)) as DetectResult;
};

const sshToken = (target: string, version: string, label: string, ttl: string, desktop?: DesktopCli): { token: string; sessionId?: string } => {
  // Without a desktop app, the first run downloads t3@<version> into the remote
  // npx cache — minutes with nothing to show unless npm's progress streams through.
  const res = sshRun(target, ['token', version, label, ttl, ...(desktop ? [desktop.exe, desktop.bin] : [])], { streamStderr: true });
  if (res.status !== 0) throw new Error(`token minting failed on ${target}${res.stderr.trim() ? `: ${res.stderr.trim().split('\n').slice(-3).join('\n')}` : ''}`);
  // The session JSON is pretty-printed over many lines and stray Effect error
  // lines can precede it, so accumulate bottom-up until an object with a token
  // field parses — the token is the only reliable anchor.
  const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
  let buf = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    buf = `${lines[i]}\n${buf}`;
    try {
      const parsed = JSON.parse(buf) as { token?: string; sessionId?: string };
      if (typeof parsed.token === 'string' && parsed.token) return { token: parsed.token, sessionId: parsed.sessionId };
    } catch { /* keep accumulating */ }
  }
  throw new Error(`no token in output from ${target}`);
};

// --t3-version wins; else ask npm locally for the exact latest, nightly only as
// a fallback. An exact version is required by the boot service's pinned runtime.
const resolveT3Version = (flags: Flags): string => {
  if (flags['t3-version']) return flags['t3-version'];
  if (spawnSync('npm', ['--version'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('npm not found locally — install npm or pass --t3-version <version-or-tag>');
  }
  const res = spawnSync('npm', ['view', `${T3_PACKAGE}@latest`, 'version'], { encoding: 'utf8' });
  if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  const nightly = spawnSync('npm', ['view', `${T3_PACKAGE}@nightly`, 'version'], { encoding: 'utf8' });
  if (nightly.status === 0 && nightly.stdout.trim()) return nightly.stdout.trim();
  throw new Error(`cannot resolve a t3 CLI version via npm — pass --t3-version (tried: ${res.stderr?.trim().split('\n')[0] ?? 'npm failed'})`);
};

const freePort = async (): Promise<number> =>
  // TOCTOU between this probe and ssh binding the port is real; ExitOnForwardFailure
  // turns the loss into a nonzero ssh exit, which spawnMaster retries on.
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address();
      s.close(() => resolve(p && typeof p === 'object' ? p.port : 0));
    });
    s.on('error', reject);
  });

const ctlPath = (target: string, port?: number): string => path.join(CONFIG_DIR,
  `ssh-${createHash('sha256').update(`${target}:${port ?? ''}`).digest('hex').slice(0, 12)}`);

// ssh -fN + ControlPersist=yes keeps the master alive after t3ctl exits
// (ssh_config(5)); -f with ExitOnForwardFailure=yes means a clean return from
// spawnSync implies the local listener exists. stderr stays visible so
// passphrase prompts (ssh opens /dev/tty itself) and bind errors surface.
const spawnMaster = async (ssh: string, sshRemotePort: number): Promise<number> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const res = spawnSync('ssh', [
      '-M', '-S', ctlPath(ssh, port), '-fN',
      '-o', 'ConnectTimeout=15', '-o', 'ControlPersist=yes',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-L', `${port}:127.0.0.1:${sshRemotePort}`, ssh,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (res.status === 0) return port;
    if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new Error('ssh not found locally');
  }
  throw new Error(`could not establish the ssh tunnel to ${ssh} (3 attempts)`);
};

const waitForOrigin = async (origin: string, deadline: number): Promise<boolean> => {
  while (Date.now() < deadline) {
    if (await probe(origin, PROBE_MS).then(() => true, () => false)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

// Single-flight per host name: cmdLs fans out concurrently and every write
// command re-enters here.
const tunnelJobs = new Map<string, Promise<void>>();
const ensureTunnel = (host: Host): Promise<void> => {
  if (!host.ssh) return Promise.resolve();
  const inFlight = tunnelJobs.get(host.name);
  if (inFlight) return inFlight;
  const job = (async () => {
    const target = host.ssh; // captured: TS cannot narrow the optional inside the closure
    if (!target) return;
    // Liveness is the HTTP probe, never `ssh -O check` — a live master does not
    // prove the forward works, and the remote port can change on server restart.
    if (await probe(host.origin, PROBE_MS).then(() => true, () => false)) return;
    spawnSync('ssh', ['-O', 'exit', '-S', ctlPath(target, host.sshLocalPort), target], { stdio: 'ignore' });
    const detect = sshDetect(target);
    if (!detect.running) throw new Error(`${target}: no T3 Code server is running — rerun: t3ctl host add ${target}`);
    // Re-pick the local port if something else grabbed it; the origin changes
    // with it, so persist both.
    const localPort = await spawnMaster(target, detect.port ?? 3773);
    const origin = `http://127.0.0.1:${localPort}`;
    writeHosts(readHosts().map((h) => h.name === host.name ? { ...h, sshLocalPort: localPort, sshRemotePort: detect.port ?? 3773, origin } : h));
    if (!(await waitForOrigin(origin, Date.now() + TUNNEL_WAIT_MS))) {
      throw new Error(`${host.ssh}: the ssh tunnel is up but ${origin} is not answering (is the server still running on the remote port?)`);
    }
  })().finally(() => tunnelJobs.delete(host.name));
  tunnelJobs.set(host.name, job);
  return job;
};

// `t3ctl host add agent@box` — the full bootstrap. Idempotent: rerunning
// refreshes the tunnel and keeps the stored token unless the machine behind
// the login changed (different environmentId).
const cmdHostAddSsh = async (target: string, flags: Flags, hosts: Host[]): Promise<void> => {
  const version = resolveT3Version(flags);

  console.log(`probing ${bold(target)} over ssh`);
  let detect = sshDetect(target);
  if (detect.node === false) {
    throw new Error(`${target} has no node on PATH for non-interactive ssh — install Node 22+ there (a version manager may need configuring for non-login shells)`);
  }

  if (!detect.running) {
    console.log(`no T3 Code server on ${target} — installing the t3 boot service (t3@${version})`);
    console.log(dim(`  this downloads packages on ${target} and can take a few minutes; its output follows`));
    // No timeout: t3code itself allows 10 minutes for the pinned-runtime npm
    // install, and the user watches the output stream by.
    const res = sshRun(target, ['install', version], { streamStderr: true });
    if (res.status !== 0) throw new Error(`t3 service install failed on ${target} (exit ${res.status})`);

    const deadline = Date.now() + SSH_READY_MS;
    let ready: DetectResult | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        ready = await sshDetect(target);
        if (ready.running) break;
      } catch { /* transient ssh hiccups while the service boots */ }
    }
    if (!ready?.running) {
      // Nothing is written to the registry — the origin is not proven yet
      // (probe-first discipline). A tunnel master is only spawned after the
      // probe below, so there is nothing to clean up here either.
      usage(`the boot service was installed on ${target} but no server became ready within ${SSH_READY_MS / 1000}s.\n` +
        `  Check its service log on ${target}: ~/.t3/userdata/logs/boot-service.log\n` +
        `  On a Mac this usually means nobody is logged in at that console — a launchd\n` +
        `  agent starts at login, and an ssh install alone cannot start it.\n` +
        `  Rerunning t3ctl host add ${target} is safe once the server is up.`);
      return;
    }
    detect = ready;
  }

  // The stored local port may be taken by now; spawnMaster retries with fresh
  // ports and returns whichever won.
  const existing = hosts.find((h) => h.ssh === target);
  const localPort = await spawnMaster(target, detect.port ?? 3773);
  const origin = `http://127.0.0.1:${localPort}`;
  try {
    if (!(await waitForOrigin(origin, Date.now() + TUNNEL_WAIT_MS))) {
      throw new Error(`the tunnel is up but ${origin} is not answering — is the server listening on 127.0.0.1:${detect.port ?? 3773} on ${target}?`);
    }
    const descriptor = await probe(origin);

    // A changed environmentId on a known login means it now lands on a
    // different machine — same warning as a changed origin, same consequence.
    if (existing?.environmentId && existing.environmentId !== descriptor.environmentId) {
      warn(`${target} is now a DIFFERENT environment\n` +
        `  was ${existing.environmentId} (${existing.label ?? 'unknown'})\n` +
        `  now ${descriptor.environmentId} (${descriptor.label})\n` +
        `  the token stored for "${existing.name}" was issued by the old one and will be replaced`);
    }

    const name = flags.name ?? existing?.name ?? uniqueName(slugify(descriptor.label), hosts);
    let token = existing?.token ?? null;
    let session: { token: string; sessionId?: string } | null = null;
    if (!token || (existing?.environmentId && existing.environmentId !== descriptor.environmentId)) {
      const issued = sshToken(target, version, `t3ctl:${name}`, flags.ttl ?? '30d', detect.desktop);
      token = issued.token;
      session = issued;
    }

    const others = hosts.filter((h) => h.name !== name && h.origin !== origin && h.serverVersion);
    const skewed = [...new Set(others.flatMap((h) => (h.serverVersion ? [h.serverVersion] : [])))]
      .filter((v) => v !== descriptor.serverVersion);
    if (skewed.length) warn(`serverVersion ${descriptor.serverVersion} differs from other hosts: ${skewed.join(', ')}`);

    // A master on a superseded local port would linger forever otherwise.
    if (existing?.sshLocalPort && existing.sshLocalPort !== localPort) {
      spawnSync('ssh', ['-O', 'exit', '-S', ctlPath(target, existing.sshLocalPort), target], { stdio: 'ignore' });
    }

    writeHosts(hosts.filter((h) => h.name !== name && h.ssh !== target).concat({
      name, origin, token,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      serverVersion: descriptor.serverVersion,
      ssh: target, sshLocalPort: localPort, sshRemotePort: detect.port ?? 3773, t3Version: version,
    }));

    console.log(`added ${bold(name)} -> ${origin} (via ssh)\n  label   ${descriptor.label}\n` +
      `  env     ${descriptor.environmentId}\n  version ${descriptor.serverVersion}\n` +
      `  tunnel  127.0.0.1:${localPort} -> 127.0.0.1:${detect.port ?? 3773} on ${target}`);
    if (session) {
      console.log(`  session ${session.sessionId ?? '?'} (label t3ctl:${name})\n` +
        `  revoke on ${target} with: ${detect.desktop
          ? `ELECTRON_RUN_AS_NODE=1 ${shellQuote(detect.desktop.exe)} ${shellQuote(detect.desktop.bin)}`
          : 'npx t3'} auth session revoke ${session.sessionId ?? '?'}`);
    } else {
      console.log('  token   reusing the stored session');
    }
  } catch (error) {
    // Keep no half-registered host: the master would outlive t3ctl otherwise.
    spawnSync('ssh', ['-O', 'exit', '-S', ctlPath(target, localPort), target], { stdio: 'ignore' });
    throw error;
  }
};



// ---- writes -------------------------------------------------------------
// Commands are dispatched directly (no envelope). The CLIENT mints every id;
// commandId is the idempotency key, so retries are safe.
// Schemas: packages/contracts/src/orchestration.ts in pingdotgg/t3code.

const pickHost = (flags: Flags): Host => {
  const hosts = readHosts();
  if (flags.host) {
    const h = hosts.find((x) => x.name === flags.host);
    if (!h) throw new Error(`no such host: ${flags.host}`);
    return h;
  }
  if (!hosts.length) throw new Error('no hosts registered — run: t3ctl host add <origin> <token>');
  if (hosts.length > 1) throw new Error(`multiple hosts; pass --host <${hosts.map((h) => h.name).join('|')}>`);
  const only = hosts[0];
  if (!only) throw new Error('no hosts registered — run: t3ctl host add <origin> <token>');
  return only;
};

// ---- split-brain guard --------------------------------------------------
// Two T3 Code servers can end up running against one ~/.t3 — say the boot
// service on 3773 and a desktop-launched one on 3774. They share one ~/.t3 (and its state database)
// but each keeps its own in-memory read model, built at startup and advanced
// only by its own commands. A thread created through one is unknown to the
// other, which then rejects every command on it with "Thread '…' does not
// exist for command '…'". Both report the same environmentId, so the
// descriptor cannot tell them apart; server-runtime.json names the one that
// started last, and a live pid there on a different port is the tell.

// `moved`: the host's own port no longer answers, so there is one server and it
// simply restarted elsewhere — not two servers splitting the data dir.
type Rival = { origin: string; pid?: number; serverVersion?: string; startedAt?: string; moved?: boolean };

const RUNTIME_JSON = '.t3/userdata/server-runtime.json';

const localRival = async (host: Host): Promise<Rival | null> => {
  let ours: URL;
  try { ours = new URL(host.origin); } catch { return null; }
  if (!LOOPBACK.has(ours.hostname)) return null;
  let r: { pid?: unknown; origin?: unknown; startedAt?: unknown };
  try { r = JSON.parse(fs.readFileSync(path.join(os.homedir(), RUNTIME_JSON), 'utf8')); } catch { return null; }
  const pid = Number(r.pid);
  let theirs: URL;
  try { theirs = new URL(String(r.origin ?? '')); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0 || theirs.port === ours.port) return null;
  try { process.kill(pid, 0); } catch { return null; }
  // Same environmentId means same ~/.t3, i.e. the same database behind both ports.
  const [live, mine] = await Promise.all([
    probe(theirs.origin, PROBE_MS).catch(() => null),
    probe(host.origin, PROBE_MS).catch(() => null),
  ]);
  const env = mine?.environmentId ?? host.environmentId;
  if (!live || !env || live.environmentId !== env) return null;
  return {
    origin: theirs.origin, pid, serverVersion: live.serverVersion,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : undefined,
    moved: !mine,
  };
};

// Over ssh the remote runtime file is only re-read when the tunnel is rebuilt,
// so a server that keeps running on the old port hides a newer one the same way.
const sshRival = (host: Host): Rival | null => {
  // ensureTunnel may have just re-pointed the tunnel and rewritten the registry.
  const current = readHosts().find((h) => h.name === host.name) ?? host;
  if (!current.ssh || !current.sshRemotePort) return null;
  const detect = sshDetect(current.ssh);
  if (!detect.running || !detect.port || detect.port === current.sshRemotePort) return null;
  return { origin: `${current.ssh}:${detect.port} (remote)` };
};

const findRival = (host: Host): Promise<Rival | null> =>
  host.ssh ? Promise.resolve().then(() => sshRival(host)) : localRival(host);

const rivalMessage = (host: Host, rival: Rival): string =>
  (rival.moved
    ? `${host.name} (${host.origin}) is not answering; its T3 Code server now runs at `
    : `${host.name} (${host.origin}) is not the only T3 Code server on this data dir — `) +
  `${rival.origin}${rival.serverVersion ? ` (${rival.serverVersion}` : ''}` +
  `${rival.pid ? `, pid ${rival.pid}` : ''}${rival.startedAt ? `, started ${rival.startedAt}` : ''}` +
  `${rival.serverVersion ? ')' : ''}${rival.moved ? '' : ' started after it'}.\n` +
  (rival.moved ? '  Point t3ctl at it:\n' :
    `  Each server only sees threads created through itself, so the app talking to one\n` +
    `  gets "Thread … does not exist" for threads made on the other.\n` +
    `  Stop the stale server, or point t3ctl at the current one:\n`) +
  (host.ssh
    ? `    t3ctl host rm ${host.name} && t3ctl host add ${host.ssh} --name ${host.name}`
    : `    t3ctl host add ${rival.origin} --name ${host.name}`);

// Writes are what strand threads, so they refuse; reads only warn.
const assertNoRival = async (host: Host): Promise<void> => {
  const rival = await findRival(host);
  if (rival) throw new Error(rivalMessage(host, rival));
};

// ssh hosts are skipped here: a detect round-trip per host per `ls` is too slow.
const warnRivals = async (hosts: Host[]): Promise<void> => {
  const rivals = await Promise.all(hosts.map((h) => (h.ssh ? null : localRival(h).catch(() => null))));
  hosts.forEach((h, i) => { const r = rivals[i]; if (r) warn(rivalMessage(h, r)); });
};

/**
 * Send one or more orchestration commands, in order, and return the sequence of
 * the last one. Protocol 1 takes them at POST /dispatch; protocol 2 only over
 * the websocket, so they share one socket there. Callers build each command in
 * the host's own protocol.
 */
const dispatch = async (host: Host, ...commands: OrchestrationCommand[]): Promise<{ sequence: number }> => {
  if (await protocolOf(host) === 1) {
    await assertNoRival(host);
    let sequence = 0;
    for (const command of commands) {
      const res = await fetch(`${host.origin}/api/orchestration/dispatch`, {
        method: 'POST',
        headers: { ...authHeaders(host), 'content-type': 'application/json' },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(host.timeoutMs ?? 15000),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`${command.type} failed: HTTP ${res.status} ${body}`);
      sequence = body ? (JSON.parse(body) as { sequence: number }).sequence : 0;
    }
    return { sequence };
  }
  const rpc = await openRpc(host);
  try {
    let sequence = 0;
    for (const command of commands) {
      ({ sequence } = (await rpc.call('orchestration.dispatchCommand', command, host.timeoutMs ?? 15000)) as { sequence: number });
    }
    return { sequence };
  } finally {
    rpc.close();
  }
};

// ---- websocket rpc ------------------------------------------------------
// Protocol 2 takes every write over the app's WebSocket; protocol 1 only the
// worktree `bootstrap` on thread.turn.start, which its HTTP dispatch drops
// without a word (apps/server/src/ws.ts, dispatchBootstrapTurnStart). The
// socket speaks Effect RPC as plain JSON frames: {_tag: 'Request', id, tag,
// payload, headers} out, {_tag: 'Exit', requestId, exit} back. A browser cannot
// put a bearer header on a socket, so the server takes a short-lived ticket in
// the query string instead, minted over authenticated HTTP.

type RpcExit = {
  _tag: 'Success' | 'Failure';
  value?: unknown;
  cause?: { _tag: string; error?: { message?: string; detail?: string; bootstrapThreadDisposition?: string }; defect?: unknown }[];
};

type RpcSession = { call: (tag: string, payload: unknown, timeoutMs: number) => Promise<unknown>; close: () => void };

/** A failure the server answered with, as opposed to a dropped or timed-out socket. */
class RpcError extends Error {
  /** Protocol 1, on a failed bootstrap: `deleted` (the thread was rolled back) or `not-created`. */
  disposition?: string;
}

const rpcFailure = (tag: string, exit: RpcExit): RpcError => {
  const failure = exit.cause?.find((c) => c._tag === 'Fail') ?? exit.cause?.[0];
  // Some errors (GitCommandError) build `message` in a getter, so only their
  // fields cross the wire; `detail` is where those keep the reason.
  const reason = failure?.error ?? failure?.defect;
  const message = failure?.error?.message ?? failure?.error?.detail ?? (reason !== undefined ? JSON.stringify(reason) : 'no reason given');
  const error = new RpcError(`${tag} failed: ${message}`);
  error.disposition = failure?.error?.bootstrapThreadDisposition;
  return error;
};

// Only write commands open a socket, so the split-brain guard runs here.
const openRpc = async (host: Host): Promise<RpcSession> => {
  const protocol = await protocolOf(host);
  await assertNoRival(host);
  const res = await fetch(`${host.origin}/api/auth/websocket-ticket`, {
    method: 'POST',
    headers: host.token ? { authorization: `Bearer ${host.token}` } : {},
    signal: AbortSignal.timeout(host.timeoutMs ?? 15000),
  });
  if (!res.ok) throw new Error(`${host.name}: websocket ticket: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  const { ticket } = (await res.json()) as { ticket: string };

  const ws = new WebSocket(`${host.origin.replace(/^http/, 'ws')}/ws?wsTicket=${encodeURIComponent(ticket)}${protocol === 2 ? `&${PROTOCOL_2_QUERY}` : ''}`);
  // Node's own handshake timeout is minutes; a tunnel to a wedged server would sit there.
  const openMs = host.timeoutMs ?? 15000;
  await new Promise<void>((resolve, reject) => {
    // Reject before closing: closing a connecting socket fires `error` synchronously.
    const timer = setTimeout(() => { reject(new Error(`${host.name}: websocket handshake got no answer in ${openMs}ms`)); ws.close(); }, openMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`${host.name}: websocket connection failed`)); }, { once: true });
  });

  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const failAll = (error: Error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  ws.addEventListener('message', (event) => {
    let parsed: unknown;
    // A throw in here would escape as an uncaught exception, not a clean error line.
    try { parsed = JSON.parse(String(event.data)); } catch { return failAll(new Error(`${host.name}: unreadable websocket frame`)); }
    for (const m of (Array.isArray(parsed) ? parsed : [parsed]) as { _tag: string; requestId?: string; exit?: RpcExit; defect?: unknown }[]) {
      // The server rejected a frame itself (bad JSON, unknown tag), so nothing was dispatched.
      if (m._tag === 'Defect') failAll(new RpcError(`server rejected the request: ${JSON.stringify(m.defect)}`));
      const p = m._tag === 'Exit' && m.exit ? pending.get(String(m.requestId)) : undefined;
      if (!p || !m.exit) continue;
      pending.delete(String(m.requestId));
      p.resolve(m.exit);
    }
  });
  ws.addEventListener('close', () => failAll(new Error(`${host.name}: the connection closed before the server answered`)));
  // The server answers a Ping with a Pong; it only keeps an idle socket alive
  // through the ssh tunnel or a proxy while a long call runs.
  const keepalive = setInterval(() => ws.send(JSON.stringify({ _tag: 'Ping' })), 15_000);

  let nextId = 0;
  return {
    call: (tag, payload, timeoutMs) => new Promise<unknown>((resolve, reject) => {
      const id = String(++nextId);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${tag}: no answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (exit) => {
          clearTimeout(timer);
          const e = exit as RpcExit;
          if (e._tag === 'Success') resolve(e.value);
          else reject(rpcFailure(tag, e));
        },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
    }),
    close: () => { clearInterval(keepalive); ws.close(); },
  };
};

const resolveProject = (snap: Snapshot, ref: string): Project | undefined =>
  snap.projects.find((p) => p.id === ref) ??
  snap.projects.find((p) => !p.deletedAt && p.title === ref) ??
  snap.projects.find((p) => !p.deletedAt && p.workspaceRoot === path.resolve(ref.replace(/^~/, os.homedir())));


// Commands whose entire payload is {commandId, threadId}. Verified against
// packages/contracts/src/orchestrationV2.ts — note `unsettle` is NOT one of
// these (it carries extra fields), so it is deliberately absent.
const SIMPLE_THREAD_COMMANDS = ['settle', 'archive', 'unarchive', 'unpin', 'delete'];

const resolveThread = (snap: Snapshot, ref: string): Thread => {
  const live = snap.threads.filter((t) => !t.deletedAt);
  const byId = live.find((t) => t.id === ref);
  if (byId) return byId;
  const exact = live.filter((t) => t.title === ref);
  if (exact[0] && exact.length === 1) return exact[0];
  const fuzzy = live.filter((t) => (t.title ?? '').toLowerCase().includes(ref.toLowerCase()));
  if (fuzzy[0] && fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(`"${ref}" matches ${fuzzy.length} threads:\n` +
      fuzzy.slice(0, 8).map((t) => `  ${t.id}  ${t.title}`).join('\n'));
  }
  throw new Error(`no thread matching "${ref}"`);
};


// RuntimeMode as the contracts spell it, paired with the name the T3 Code app
// shows for it in its "Access" menu. The app's names are what people actually
// say out loud, so they are accepted as input too — `supervised` and `full` are
// the only two that differ from the wire value, the other two already match.
const RUNTIME_MODES: Record<string, string> = {
  'approval-required': 'Supervised',
  'auto-accept-edits': 'Auto-accept edits',
  auto: 'Auto',
  'full-access': 'Full access',
};
const RUNTIME_MODE_ALIASES: Record<string, string> = {
  supervised: 'approval-required',
  full: 'full-access',
};
/** One spelling of the accepted values, shared by the help text and the error. */
const RUNTIME_MODE_HELP = 'approval-required (supervised) | auto-accept-edits | auto | full-access (full)';

const parseRuntimeMode = (raw: string): string => {
  const given = raw.trim().toLowerCase();
  const mode = RUNTIME_MODE_ALIASES[given] ?? given;
  if (!(mode in RUNTIME_MODES)) throw new Error(`unknown runtime mode "${raw}" — expected ${RUNTIME_MODE_HELP}`);
  return mode;
};

const runtimeModeLabel = (mode: string): string => RUNTIME_MODES[mode] ?? mode;

// What `thread snooze <when>` accepts. Deliberately three narrow forms rather
// than a date library: an exact instant, a relative duration, or a named day.
// Named days wake at WAKE_HOUR local — the start of a workday, not midnight.
const WAKE_HOUR = 9;
const WHEN_HELP = 'an ISO time, a duration from now (45m, 2h, 3d, 1w), or a named day '
  + `(tomorrow, monday…sunday, next-week) which wakes at ${String(WAKE_HOUR).padStart(2, '0')}:00 local`;
const DURATION_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Returns the ISO instant to send as `snoozedUntil`. `now` is a parameter so the
// relative forms are pinned to one clock reading rather than re-reading it.
const parseWhen = (raw: string, now: Date = new Date()): string => {
  const given = raw.trim().toLowerCase();
  const duration = /^(\d+(?:\.\d+)?)([mhdw])$/.exec(given);
  const unitMs = duration ? DURATION_MS[duration[2] ?? ''] : undefined;
  const weekday = WEEKDAYS.indexOf(given === 'next-week' ? 'monday' : given);

  let at: Date;
  if (unitMs) {
    at = new Date(now.getTime() + Number(duration?.[1]) * unitMs);
  } else if (given === 'tomorrow' || weekday >= 0) {
    // A named day walks the local calendar (setHours/setDate) rather than adding
    // milliseconds, because a day is not always 24 hours long across a DST
    // change. Always strictly ahead: `monday` on a Monday is the next one.
    const days = given === 'tomorrow' ? 1 : (weekday - now.getDay() + 7) % 7 || 7;
    at = new Date(now);
    at.setHours(WAKE_HOUR, 0, 0, 0);
    at.setDate(at.getDate() + days);
  } else {
    at = new Date(raw);
    if (Number.isNaN(at.getTime())) throw new Error(`cannot read "${raw}" as a time — expected ${WHEN_HELP}`);
  }

  // Checked for every form, not just the explicit one: the server accepts a past
  // wake time and it does nothing, since a thread stops classifying as snoozed
  // the moment the time passes. `0h` is the same mistake as last Tuesday.
  if (at <= now) throw new Error(`${at.toISOString()} is in the past — a snooze has to wake in the future`);
  return at.toISOString();
};

// instanceId is the segment before the FIRST slash; the model keeps the rest,
// because opencode model ids are themselves slashed ("github-copilot/gpt-5.4").
const parseModel = (raw: string): ModelSelection => {
  const slash = raw.indexOf('/');
  if (slash < 1) throw new Error(`--model must be <instance>/<model>, got "${raw}"`);
  return { instanceId: raw.slice(0, slash), model: raw.slice(slash + 1) };
};

// `--option id=value` sets one entry of modelSelection.options, replacing an
// entry with the same id. The server accepts strings and booleans, so `true`
// and `false` are sent as booleans (`fastMode=true`), anything else as a string.
const withOptions = (selection: ModelSelection, raw: string[] = []): ModelSelection => {
  if (raw.length === 0) return selection;
  const options = new Map((selection.options ?? []).map((o) => [o.id, o]));
  for (const entry of raw) {
    const eq = entry.indexOf('=');
    const id = entry.slice(0, eq).trim();
    const text = entry.slice(eq + 1).trim();
    if (eq < 0 || !id || !text) throw new Error(`--option must be <id>=<value>, got "${entry}"`);
    options.set(id, { id, value: text === 'true' ? true : text === 'false' ? false : text });
  }
  return { ...selection, options: [...options.values()] };
};

/** The `--model` spelling of a selection, without its options. */
const modelRef = (m: ModelSelection): string => `${m.instanceId}/${m.model}`;

const describeModel = (m: ModelSelection): string => modelRef(m) +
  (m.options?.length ? ` (${m.options.map((o) => `${o.id}=${o.value}`).join(', ')})` : '');

// Who a command is from, as the server records it. t3ctl acts for the person at
// the keyboard, like the app's own clients, so it reports itself as one: the
// server only treats `server` and `provider` as special.
const FROM_USER = { createdBy: 'user', creationSource: 'web' } as const;

// Protocol 1: thread.turn.start is ONE command carrying the message inline,
// with the access and interaction modes on it. The client-side schema requires
// runtimeMode/interactionMode explicitly (the server-side one defaults them).
const cmdThreadStartV1 = async (thread: Thread, host: Host, text: string, flags: Flags): Promise<void> => {
  const command: OrchestrationCommand = {
    type: 'thread.turn.start',
    commandId: crypto.randomUUID(),
    threadId: thread.id,
    message: { messageId: crypto.randomUUID(), role: 'user', text, attachments: [] },
    runtimeMode: flags['runtime-mode'] ? parseRuntimeMode(flags['runtime-mode']) : thread.runtimeMode ?? 'full-access',
    interactionMode: flags['interaction-mode'] ?? 'default',
    createdAt: new Date().toISOString(),
  };
  const base = flags.model ? parseModel(flags.model) : thread.modelSelection;
  if (!base && flags.option?.length) throw new Error('--option needs a model; the thread has none, so pass --model too');
  if (base) command.modelSelection = withOptions(base, flags.option);
  const { sequence } = await dispatch(host, command);
  if (flags.json) return printJson({ threadId: thread.id, host: host.name, sequence });
  const m = command['modelSelection'] as ModelSelection | undefined;
  console.log(`started ${bold(thread.title || thread.id)}\n  id    ${thread.id}` +
    (m ? `\n  model ${describeModel(m)}` : '') +
    `\n  mode  ${command.runtimeMode} / ${command.interactionMode}\n  seq   ${sequence}`);
};

// Protocol 2: message.dispatch carries no access or interaction mode, unlike protocol 1's
// thread.turn.start, so --runtime-mode and --interaction-mode are set first, on
// the same socket, in order. A thread that is already busy gets the message
// queued behind its active run rather than started over it.
const cmdThreadStart = async (thread: Thread, host: Host, text: string, flags: Flags): Promise<void> => {
  if (await protocolOf(host) === 1) return cmdThreadStartV1(thread, host, text, flags);
  const runtimeMode = flags['runtime-mode'] ? parseRuntimeMode(flags['runtime-mode']) : null;
  const interactionMode = flags['interaction-mode'] ?? null;
  const base = flags.model ? parseModel(flags.model) : thread.modelSelection;
  if (!base && flags.option?.length) throw new Error('--option needs a model; the thread has none, so pass --model too');
  const modelSelection = base && (flags.model || flags.option?.length) ? withOptions(base, flags.option) : undefined;
  const commands: OrchestrationCommand[] = [];
  if (runtimeMode && runtimeMode !== thread.runtimeMode) {
    commands.push({ type: 'thread.runtime-mode.set', commandId: crypto.randomUUID(), threadId: thread.id, runtimeMode });
  }
  if (interactionMode) {
    commands.push({ type: 'thread.interaction-mode.set', commandId: crypto.randomUUID(), threadId: thread.id, interactionMode });
  }
  commands.push({
    type: 'message.dispatch', commandId: crypto.randomUUID(), ...FROM_USER,
    threadId: thread.id, messageId: crypto.randomUUID(), text, attachments: [],
    ...(modelSelection ? { modelSelection } : {}),
    dispatchMode: { type: thread.activeRunId ? 'queue_after_active' : 'start_immediately' },
  });
  const { sequence } = await dispatch(host, ...commands);
  if (flags.json) return printJson({ threadId: thread.id, host: host.name, sequence });
  const m = modelSelection ?? thread.modelSelection;
  console.log(`${thread.activeRunId ? 'queued for' : 'started'} ${bold(thread.title || thread.id)}\n  id    ${thread.id}` +
    (m ? `\n  model ${describeModel(m)}` : '') +
    `\n  mode  ${runtimeMode ?? thread.runtimeMode ?? '?'} / ${interactionMode ?? 'unchanged'}\n  seq   ${sequence}`);
};

// Protocol 2's run.interrupt names the run to stop, so there a thread with
// nothing running is an error here rather than a command the server would reject.
const cmdThreadInterrupt = async (thread: Thread, host: Host): Promise<void> => {
  let command: OrchestrationCommand;
  if (await protocolOf(host) === 1) {
    command = { type: 'thread.turn.interrupt', commandId: crypto.randomUUID(), threadId: thread.id };
  } else {
    if (!thread.activeRunId) throw new Error(`nothing is running in ${thread.title || thread.id}`);
    command = { type: 'run.interrupt', commandId: crypto.randomUUID(), threadId: thread.id, runId: thread.activeRunId };
  }
  const { sequence } = await dispatch(host, command);
  console.log(`interrupted ${bold(thread.title || thread.id)}\n  seq ${sequence}`);
};

const cmdThreadSnooze = async (thread: Thread, host: Host, when: string): Promise<void> => {
  const snoozedUntil = parseWhen(when);
  const { sequence } = await dispatch(host, {
    type: 'thread.snooze', commandId: crypto.randomUUID(), threadId: thread.id, snoozedUntil,
  });
  // The wire value is UTC but the user asked for a local time, so print both.
  console.log(`snoozed ${bold(thread.title || thread.id)}\n  until ${snoozedUntil} ` +
    `${dim(`(${new Date(snoozedUntil).toLocaleString()} local)`)}\n  id    ${thread.id}\n  seq   ${sequence}`);
};

// `reason` is always "user": activity wakes are decided server-side, and a wake
// time that simply passes needs no command at all — the thread stops
// classifying as snoozed on its own.
const cmdThreadUnsnooze = async (thread: Thread, host: Host): Promise<void> => {
  const { sequence } = await dispatch(host, {
    type: 'thread.unsnooze', commandId: crypto.randomUUID(), threadId: thread.id, reason: 'user',
  });
  console.log(`unsnoozed ${bold(thread.title || thread.id)}\n  id  ${thread.id}\n  seq ${sequence}`);
};

// `thread send --runtime-mode` also changes the mode, but only as part of
// starting a turn. This is the standalone switch, the same one the app's
// "Access" menu fires on an idle thread.
const cmdThreadRuntimeMode = async (thread: Thread, host: Host, raw: string): Promise<void> => {
  const runtimeMode = parseRuntimeMode(raw);
  const { sequence } = await dispatch(host, {
    type: 'thread.runtime-mode.set', commandId: crypto.randomUUID(), threadId: thread.id, runtimeMode,
    // Protocol 1 requires a createdAt; protocol 2 has none.
    ...(await protocolOf(host) === 1 ? { createdAt: new Date().toISOString() } : {}),
  });
  // The snapshot carries the old mode, so say what changed rather than just what it is now.
  console.log(`${bold(thread.title || thread.id)}\n  mode ${dim(`${thread.runtimeMode ?? '?'} ->`)} ` +
    `${runtimeMode} ${dim(`(${runtimeModeLabel(runtimeMode)})`)}\n  id   ${thread.id}\n  seq  ${sequence}`);
};


// The thread metadata command: thread.meta.update in protocol 1,
// thread.metadata.update in 2. Both also take regenerateTitle:true, which asks
// the server to derive a title from the thread's own content.
const metadataCommand = async (host: Host): Promise<string> =>
  await protocolOf(host) === 1 ? 'thread.meta.update' : 'thread.metadata.update';

const cmdThreadRename = async (thread: Thread, host: Host, title: string): Promise<void> => {
  const { sequence } = await dispatch(host, {
    type: await metadataCommand(host), commandId: crypto.randomUUID(), threadId: thread.id, title,
  });
  console.log(`renamed ${dim(thread.title || thread.id)} -> ${bold(title)}\n  seq ${sequence}`);
};

// One thread with its messages. `turnLimit` is null for the whole history
// (export); protocol 1 can also cut it to the last few turns, which retitle uses
// to poll cheaply. Protocol 2 always answers with the whole projection.
const threadDetail = async (host: Host, threadId: string, turnLimit: number | null = null): Promise<Thread> => {
  const route = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
  if (await protocolOf(host) === 1) {
    return (await getJson<{ thread: Thread }>(host, `${route}${turnLimit === null ? '' : `?turnLimit=${turnLimit}`}`)).thread;
  }
  const { projection } = await getJson<{ projection: { thread: Thread; messages?: ThreadMessage[] } }>(host, route);
  return { ...projection.thread, messages: projection.messages ?? [] };
};

// `regenerateTitle` does NOT rename anything by itself. The server records an
// intent marker (`titleRegeneration: {requestId, startedAt}`) and expects something
// downstream to generate a title and write it back. Observed on a live server: the
// marker is sometimes cleared a few seconds later with the title untouched, and no
// error is reported anywhere — not in the event, the command receipt, or the server
// trace. So we dispatch, then watch, and say what actually happened.
const cmdThreadRetitle = async (thread: Thread, host: Host, timeoutSeconds: number): Promise<void> => {
  const before = thread.title;
  const { sequence } = await dispatch(host, {
    type: await metadataCommand(host), commandId: crypto.randomUUID(), threadId: thread.id,
    regenerateTitle: true,
  });
  console.log(`asked the server to retitle ${bold(before || thread.id)}${dim(`  (seq ${sequence})`)}`);

  const deadline = Date.now() + timeoutSeconds * 1000;
  let sawMarker = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    // Protocol 1 has `titleRegeneration` on the thread detail, cut to one turn.
    // In protocol 2 only the shell snapshot carries it, not the projection.
    const current = await protocolOf(host) === 1
      ? await threadDetail(host, thread.id, 1)
      : (await snapshot(host)).threads.find((t) => t.id === thread.id);
    if (!current) break;
    if (current.title && current.title !== before) {
      console.log(`retitled -> ${bold(current.title)}`);
      return;
    }
    if (current.titleRegeneration) { sawMarker = true; continue; }
    if (sawMarker) break; // marker appeared and was cleared, title unchanged
  }

  console.error(
    `${sgr('33', 'no title was generated', process.stderr)} — the server ${sawMarker ? 'cleared the request without producing one' : `did not act on it within ${timeoutSeconds}s`}.\n` +
    `  The title is still "${before}". Set one directly:\n` +
    `    t3ctl thread rename ${thread.id} <title...>`,
  );
  process.exitCode = 1;
};


const cmdProjectCreate = async (title: string, root: string, flags: Flags): Promise<void> => {
  const host = pickHost(flags);
  const workspaceRoot = path.resolve(root.replace(/^~/, os.homedir()));
  if (!fs.existsSync(workspaceRoot)) throw new Error(`workspace root does not exist: ${workspaceRoot}`);
  const projectId = crypto.randomUUID();
  if (await protocolOf(host) === 1) {
    const { sequence } = await dispatch(host, {
      type: 'project.create', commandId: crypto.randomUUID(),
      projectId, title, workspaceRoot, createdAt: new Date().toISOString(),
    });
    console.log(`created project ${bold(title)} on ${host.name}\n  id   ${projectId}\n  root ${workspaceRoot}\n  seq  ${sequence}`);
    return;
  }
  // In protocol 2 projects are not orchestration commands; they have their own
  // HTTP mutation (packages/contracts/src/project.ts), which answers with the project.
  await assertNoRival(host);
  const res = await fetch(`${host.origin}/api/projects/mutate`, {
    method: 'POST',
    headers: { ...authHeaders(host), 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'project.create', commandId: crypto.randomUUID(), projectId, title, workspaceRoot }),
    signal: AbortSignal.timeout(host.timeoutMs ?? 15000),
  });
  if (!res.ok) throw new Error(`project.create failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  console.log(`created project ${bold(title)} on ${host.name}\n  id   ${projectId}\n  root ${workspaceRoot}`);
};

const printJson = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

/** What `thread create --json` prints, whichever way the thread was made. */
const createdJson = (host: Host, project: Project, id: string, title: string, model: ModelSelection, sequence: number | null) => ({
  id, title, projectId: project.id, project: project.title, host: host.name, model: modelRef(model), sequence,
});

// The shape the server recognises as temporary (isTemporaryWorktreeBranch in
// packages/shared/src/git.ts) and renames after the first turn. A branch is
// always sent: without one the server adds a detached worktree at the commit.
const temporaryBranch = (): string => `t3code/${crypto.randomUUID().slice(0, 8)}`;

type VcsRef = { name: string; isRemote?: boolean; remoteName?: string; isDefault: boolean };

// The default is origin/HEAD, which the server keeps on the first page of
// vcs.listRefs. It can be listed as `origin/main` when there is no local main.
const defaultBranch = async (rpc: RpcSession, project: Project): Promise<string> => {
  const list = (await rpc.call('vcs.listRefs', { cwd: project.workspaceRoot, limit: 20 }, 30_000)) as { isRepo: boolean; refs: VcsRef[] };
  if (!list.isRepo) throw new Error(`${project.title} (${project.workspaceRoot}) is not a git repository, so it cannot have a worktree`);
  const ref = list.refs.find((r) => r.isDefault);
  if (!ref) throw new Error(`cannot tell the default branch of ${project.title}: origin/HEAD is not set — pass --base <branch>`);
  return ref.isRemote && ref.remoteName ? ref.name.slice(ref.remoteName.length + 1) : ref.name;
};

const worktreeFlagProblem = (flags: Flags): string | null => {
  if (!flags['new-worktree']) return flags.message || flags.base ? '--message and --base only apply with --new-worktree' : null;
  if (flags.worktree) return '--new-worktree makes its own worktree, so it cannot take --worktree <path> as well';
  if (!flags.message?.trim()) return '--new-worktree needs --message <text>: the server only prepares a worktree when the first message is sent';
  return null;
};

// Protocol 1: one thread.turn.start that carries the thread, the worktree and
// the first message, as the app sends it from a new-thread draft. The server
// creates the thread, fetches origin/<base>, adds the worktree, runs the setup
// script, then starts the turn — all before it answers. A failed fetch or
// checkout deletes the thread again; a failed setup script does not.
const BOOTSTRAP_WAIT_MS = 15 * 60_000;

const cmdThreadCreateInWorktreeV1 = async (host: Host, project: Project, title: string, modelSelection: ModelSelection, flags: Flags): Promise<void> => {
  const runtimeMode = parseRuntimeMode(flags['runtime-mode'] ?? 'full-access');
  const interactionMode = flags['interaction-mode'] ?? 'default';
  const rpc = await openRpc(host);
  try {
    const baseBranch = flags.base ?? await defaultBranch(rpc, project);
    const branch = flags.branch ?? temporaryBranch();
    const threadId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    if (!flags.json) console.error(dim(`preparing ${branch} from ${baseBranch} in a new worktree on ${host.name} — this can take a few minutes`, process.stderr));
    const { sequence } = (await rpc.call('orchestration.dispatchCommand', {
      type: 'thread.turn.start', commandId: crypto.randomUUID(), threadId,
      message: { messageId: crypto.randomUUID(), role: 'user', text: flags.message, attachments: [] },
      modelSelection, runtimeMode, interactionMode,
      bootstrap: {
        createThread: {
          projectId: project.id, title, modelSelection, runtimeMode, interactionMode,
          branch: baseBranch, worktreePath: null, createdAt,
        },
        // requireWorktree: fail rather than quietly run in the project checkout
        // when the project is not a repo or the base has no commit.
        prepareWorktree: { projectCwd: project.workspaceRoot, baseBranch, branch, startFromOrigin: true, requireWorktree: true },
        runSetupScript: true,
      },
      createdAt,
    }, BOOTSTRAP_WAIT_MS).catch((error: unknown) => {
      if (!(error instanceof RpcError)) {
        // The bootstrap outlives the connection that asked for it.
        throw new Error(`${errorMessage(error)}\n  any setup already under way carries on on the server — check with: t3ctl ls -t`);
      }
      const outcome = error.disposition === 'deleted' ? 'the server deleted the thread it had created'
        : error.disposition === 'not-created' ? 'no thread was created' : '';
      throw new Error(outcome ? `${error.message}\n  ${outcome}` : error.message);
    })) as { sequence: number };
    if (flags.json) return printJson(createdJson(host, project, threadId, title, modelSelection, sequence));
    // The server picks the worktree path, so read it back rather than guess it.
    const made = await threadDetail(host, threadId, 1).catch(() => null);
    console.log(`started ${bold(title)} in ${project.title} on ${host.name}\n  id       ${threadId}\n` +
      `  branch   ${made?.branch ?? branch} ${dim(`(from ${baseBranch})`)}\n  worktree ${made?.worktreePath ?? '-'}\n` +
      `  model    ${describeModel(modelSelection)}\n  mode     ${runtimeMode} / ${interactionMode}\n  seq      ${sequence}`);
  } finally {
    rpc.close();
  }
};

// Protocol 2: orchestration.launchThread creates the thread, prepares the worktree and sends
// the first message, as the app does from a new-thread draft. It answers once
// the thread exists; fetching origin/<base>, adding the worktree and running
// the setup script carry on in the background as the run's preparation, and a
// failure there shows in the thread rather than here.
const LAUNCH_WAIT_MS = 2 * 60_000;

type LaunchResult = { threadId: string; projection: { thread: Thread } };

const cmdThreadCreateInWorktree = async (host: Host, project: Project, title: string, modelSelection: ModelSelection, flags: Flags): Promise<void> => {
  const runtimeMode = parseRuntimeMode(flags['runtime-mode'] ?? 'full-access');
  const interactionMode = flags['interaction-mode'] ?? 'default';
  const rpc = await openRpc(host);
  try {
    const baseBranch = flags.base ?? await defaultBranch(rpc, project);
    const branch = flags.branch ?? temporaryBranch();
    const threadId = crypto.randomUUID();
    const { projection } = (await rpc.call('orchestration.launchThread', {
      commandId: crypto.randomUUID(), creationSource: FROM_USER.creationSource, threadId,
      projectId: project.id, title, modelSelection, runtimeMode, interactionMode,
      workspaceStrategy: { type: 'worktree', baseRef: baseBranch, branch, startFromOrigin: true },
      initialMessage: { messageId: crypto.randomUUID(), text: flags.message, attachments: [] },
    }, LAUNCH_WAIT_MS).catch((error: unknown) => {
      if (error instanceof RpcError) throw error;
      // The launch outlives the connection that asked for it.
      throw new Error(`${errorMessage(error)}\n  any setup already under way carries on on the server — check with: t3ctl ls -t`);
    })) as LaunchResult;
    const made = projection.thread;
    // launchThread answers with the thread, not a sequence.
    if (flags.json) return printJson(createdJson(host, project, threadId, title, modelSelection, null));
    console.log(`started ${bold(title)} in ${project.title} on ${host.name}\n  id       ${threadId}\n` +
      `  branch   ${made.branch ?? branch} ${dim(`(from ${baseBranch})`)}\n  worktree ${made.worktreePath ?? dim('being prepared — check with: t3ctl ls -t')}\n` +
      `  model    ${describeModel(modelSelection)}\n  mode     ${runtimeMode} / ${interactionMode}`);
  } finally {
    rpc.close();
  }
};

const cmdThreadCreate = async (projectRef: string, title: string, flags: Flags): Promise<void> => {
  const problem = worktreeFlagProblem(flags);
  if (problem) throw new Error(problem);
  const host = pickHost(flags);
  const project = resolveProject(await snapshot(host), projectRef);
  if (!project) throw new Error(`no project matching "${projectRef}" on ${host.name}`);
  const modelSelection = withOptions(parseModel(flags.model ?? 'claudeAgent/claude-opus-5'), flags.option);
  const protocol = await protocolOf(host);
  if (flags['new-worktree']) {
    return protocol === 1
      ? cmdThreadCreateInWorktreeV1(host, project, title, modelSelection, flags)
      : cmdThreadCreateInWorktree(host, project, title, modelSelection, flags);
  }
  const threadId = crypto.randomUUID();
  const { sequence } = await dispatch(host, {
    type: 'thread.create', commandId: crypto.randomUUID(),
    // Protocol 2 records who created the thread; protocol 1 when.
    ...(protocol === 1 ? { createdAt: new Date().toISOString() } : FROM_USER),
    threadId, projectId: project.id, title, modelSelection,
    runtimeMode: parseRuntimeMode(flags['runtime-mode'] ?? 'full-access'),
    interactionMode: flags['interaction-mode'] ?? 'default',
    branch: flags.branch ?? null,
    worktreePath: flags.worktree ?? null,
  });
  if (flags.json) return printJson(createdJson(host, project, threadId, title, modelSelection, sequence));
  console.log(`created thread ${bold(title)} in ${project.title} on ${host.name}\n  id    ${threadId}\n  model ${describeModel(modelSelection)}\n  seq   ${sequence}`);
};

const cmdThreadSimple = async (verb: string, ref: string, flags: Flags): Promise<void> => {
  const host = pickHost(flags);
  const thread = resolveThread(await snapshot(host), ref);
  const { sequence } = await dispatch(host, {
    type: `thread.${verb}`, commandId: crypto.randomUUID(), threadId: thread.id,
  });
  console.log(`${verb}d ${bold(thread.title || thread.id)}\n  id  ${thread.id}\n  seq ${sequence}`);
};

// ---- export -------------------------------------------------------------
// `export prompts` answers one narrow question for other tools: which prompts
// did a human type, where, and when. It is the only read path that avoids the
// HTTP API when it can, because the API answers it in N+1 requests — a snapshot
// to learn the thread ids, then one fetch per thread, since snapshot threads
// carry no messages — for data that is one join in the host's own database.
//
// Two strategies, cheapest first. They are deliberately written to return the
// same rows: a prompt must not appear or vanish depending on how a host happens
// to be reachable. That is why the HTTP path filters only `deletedAt`, matching
// the SQL, and does not also drop archived threads.

/** A row as the SQL returns it. The HTTP strategy fabricates the same shape. */
type PromptRow = {
  message_id: string;
  thread_id: string;
  text: string;
  created_at: string;
  workspace_root: string;
};

type Prompt = {
  host: string;
  threadId: string;
  messageId: string;
  createdAt: string;
  text: string;
  workspaceRoot: string;
  marker: string;
};

type Strategy = 'sqlite' | 'http';

const STRATEGY_LABEL: Record<Strategy, string> = {
  sqlite: 'local state database',
  http: 'snapshot + per-thread fetch',
};


const expandHome = (p: string): string => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));

/**
 * Where a prompt happened, named the way a human would: the workspace path made
 * relative to the watched root it sits under. Longest matching root wins, so
 * `~/Code` and `~/Code/@clients` both configured gives `afa`, not `@clients/afa`.
 * A workspace under no watched root has no marker and the prompt is dropped.
 */
const markerForWorkspace = (workspaceRoot: string, watched: string[]): string | null => {
  const ws = workspaceRoot.replace(/\/+$/, '');
  let best: string | null = null;
  let bestLen = -1;
  for (const root of watched) {
    const r = root.replace(/\/+$/, '');
    if (ws === r) return ws.split('/').pop() ?? ws;
    if (ws.startsWith(`${r}/`) && r.length > bestLen) {
      best = ws.slice(r.length + 1);
      bestLen = r.length;
    }
  }
  return best;
};

/**
 * Prompts arrive with the harness's wrapping still on them. Mirrors
 * `cleanPrompt` in spr-time-entrier, which is the consumer this shape is for:
 * unwrap `<user_query>` when present, then collapse whitespace to one line.
 */
const cleanPrompt = (text: string): string => {
  const tagged = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return (tagged?.[1] ?? text).replace(/\s+/g, ' ').trim();
};

// The local store, one statement per protocol, each matching what the HTTP path
// reconstructs for that protocol. Paths are fixed by T3 Code, relative to the
// home directory. Orchestrator V2 keeps its state in statev2.sqlite and leaves
// the protocol 1 state.sqlite behind, frozen at the switch — so statev2.sqlite
// wins whenever it exists. No server is needed to tell which applies.
const LOCAL_STORES = [
  {
    file: '.t3/userdata/statev2.sqlite',
    // A message's text and author live in its JSON payload. `createdBy` tells a
    // person's prompt from one an agent wrote into a thread (a delegated task's brief).
    sql: `SELECT m.message_id, m.thread_id, json_extract(m.payload_json, '$.text') AS text, m.created_at, p.workspace_root
FROM orchestration_v2_projection_messages m
JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
JOIN projection_projects p ON p.project_id = t.project_id
WHERE m.role = 'user'
  AND json_extract(m.payload_json, '$.createdBy') = 'user'
  AND t.deleted_at IS NULL
  AND p.deleted_at IS NULL
  AND m.created_at >= ? AND m.created_at < ?
ORDER BY m.created_at`,
  },
  {
    file: '.t3/userdata/state.sqlite',
    sql: `SELECT m.message_id, m.thread_id, m.text, m.created_at, p.workspace_root
FROM projection_thread_messages m
JOIN projection_threads t ON t.thread_id = m.thread_id
JOIN projection_projects p ON p.project_id = t.project_id
WHERE m.role = 'user'
  AND t.deleted_at IS NULL
  AND p.deleted_at IS NULL
  AND m.created_at >= ? AND m.created_at < ?
ORDER BY m.created_at`,
  },
];

/**
 * A bare `--since 2026-09-14` is the UTC day boundary, not local midnight: the
 * rows being filtered are UTC, and an export should describe the same window
 * whichever machine runs it. Anything else is handed to `Date` as written.
 */
const isoBound = (value: string, flag: string): string => {
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw new Error(`${flag}: not a date I can read: ${value}`);
  return at.toISOString();
};

/**
 * node:sqlite arrived in Node 22.5 behind `--experimental-sqlite`. Current
 * releases have it unflagged (verified on 22.23 and 24), but `engines` allows
 * `>=22`, which still admits the flagged ones. Importing it lazily means only
 * this command fails there, instead of the whole CLI failing to start.
 */
const loadSqlite = async (): Promise<typeof import('node:sqlite').DatabaseSync> => {
  try {
    return (await import('node:sqlite')).DatabaseSync;
  } catch {
    throw new Error('reading the T3 Code database needs node:sqlite — upgrade to Node >= 22.13, or pass --experimental-sqlite on 22.5-22.12');
  }
};

const queryLocal = async (since: string, until: string): Promise<PromptRow[]> => {
  const store = LOCAL_STORES.find((s) => fs.existsSync(path.join(os.homedir(), s.file)));
  if (!store) throw new Error(`no T3 Code database in ${path.join(os.homedir(), '.t3/userdata')}`);
  const file = path.join(os.homedir(), store.file);
  const DatabaseSync = await loadSqlite();
  // The database is in WAL mode, so this reader neither blocks the running app
  // nor is blocked by it, and no copy is needed — it is ~500 MB.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(store.sql).all(since, until) as unknown as PromptRow[];
  } finally {
    db.close();
  }
};

/** `Date.parse` returns NaN for junk and for null; both mean "cannot compare". */
const instant = (value?: string | null): number | null => {
  const t = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(t) ? null : t;
};

/**
 * Which threads are worth a request. `updatedAt` moves with every new message,
 * so a thread untouched since the window opened cannot hold one, and a thread
 * created after it closed cannot either. Anything unknown is fetched.
 */
const mayHavePrompts = (t: Thread, since: number, until: number): boolean => {
  if (t.deletedAt) return false;
  const updated = instant(t.updatedAt);
  if (updated !== null && updated < since) return false;
  const created = instant(t.createdAt);
  if (created !== null && created >= until) return false;
  return true;
};

/** Bounded fan-out: a host with 200 live threads should not get 200 sockets at once. */
const mapPool = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out = new Array<R>(items.length);
  // Every worker pulls from the same iterator, so each entry goes to exactly one
  // of them and the last to finish is the last item, not the last worker.
  const queue = items.entries();
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (const [i, item] of queue) out[i] = await fn(item);
  }));
  return out;
};

const queryOverHttp = async (host: Host, since: string, until: string): Promise<PromptRow[]> => {
  const snap = await snapshot(host);
  const roots = new Map(snap.projects.filter((p) => !p.deletedAt).map((p) => [p.id, p.workspaceRoot]));
  const from = Date.parse(since);
  const to = Date.parse(until);
  const threads = snap.threads.filter((t) => roots.has(t.projectId) && mayHavePrompts(t, from, to));

  const perThread = await mapPool(threads, 8, async (t) => {
    const workspaceRoot = roots.get(t.projectId);
    if (workspaceRoot === undefined) return [];
    const detail = await threadDetail(host, t.id);
    const rows: PromptRow[] = [];
    for (const m of detail.messages ?? []) {
      // Protocol 1 messages carry no author, and only people wrote user-role ones.
      if (m.role !== 'user' || (m.createdBy !== undefined && m.createdBy !== 'user')) continue;
      const at = instant(m.createdAt);
      if (at === null || at < from || at >= to) continue;
      const messageId = m.messageId ?? m.id;
      if (messageId === undefined) continue;
      rows.push({
        message_id: messageId,
        thread_id: t.id,
        text: m.text ?? '',
        created_at: new Date(at).toISOString(),
        workspace_root: workspaceRoot,
      });
    }
    return rows;
  });
  return perThread.flat();
};

/**
 * Loopback means the database this process can already open is the very one the
 * host serves, so read it and skip the network entirely. Everything else goes
 * over HTTP.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const strategyFor = (host: Host): Strategy => {
  // A host reached over ssh has a loopback origin too, but it is the local end
  // of a tunnel: its database is on the other machine.
  if (host.ssh) return 'http';
  let hostname = '';
  try {
    hostname = new URL(host.origin).hostname;
  } catch { /* an unparseable origin is not loopback; let the HTTP path report it */ }
  return LOOPBACK.has(hostname) ? 'sqlite' : 'http';
};

const readPrompts = (host: Host, strategy: Strategy, since: string, until: string): Promise<PromptRow[]> => {
  if (strategy === 'sqlite') return queryLocal(since, until);
  return queryOverHttp(host, since, until);
};

type ExportOptions = { since: string; until?: string; host?: string; watch?: string[]; json?: boolean };

const cmdExportPrompts = async (o: ExportOptions): Promise<void> => {
  const since = isoBound(o.since, '--since');
  const until = o.until ? isoBound(o.until, '--until') : new Date().toISOString();
  if (until <= since) throw new Error(`--until (${until}) must be after --since (${since})`);

  const registered = readHosts();
  if (!registered.length) throw new Error('no hosts registered — run: t3ctl host add <origin> <token>');
  const hosts = o.host ? registered.filter((h) => h.name === o.host) : registered;
  if (!hosts.length) throw new Error(`no such host: ${o.host}`);

  const watched = (o.watch?.length ? o.watch : ['~/Code']).map(expandHome);

  const settled = await Promise.allSettled(hosts.map(async (h) => {
    const strategy = strategyFor(h);
    return { strategy, rows: await readPrompts(h, strategy, since, until) };
  }));

  const messages: Prompt[] = [];
  const unreachable: { host: string; error: string }[] = [];
  const reached: { host: string; strategy: Strategy; count: number }[] = [];

  settled.forEach((result, i) => {
    const host = hosts[i];
    if (!host) return;
    if (result.status === 'rejected') {
      unreachable.push({ host: host.name, error: errorMessage(result.reason) });
      return;
    }
    const { strategy, rows } = result.value;
    let count = 0;
    for (const row of rows) {
      const marker = markerForWorkspace(row.workspace_root, watched);
      if (marker === null) continue; // outside every watched root
      messages.push({
        host: host.name,
        threadId: row.thread_id,
        messageId: row.message_id,
        createdAt: row.created_at,
        text: cleanPrompt(row.text),
        workspaceRoot: row.workspace_root,
        // Markers have to stay unique across machines, and two hosts routinely
        // hold a checkout of the same repo at the same path. The local host is
        // the unprefixed one so single-machine consumers see plain names.
        marker: strategy === 'sqlite' ? marker : `${host.name}/${marker}`,
      });
      count++;
    }
    reached.push({ host: host.name, strategy, count });
  });

  messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId));

  if (o.json) {
    console.log(JSON.stringify({ messages, unreachable }, null, 2));
  } else {
    const n = messages.length;
    console.log(`${bold(String(n))} prompt${n === 1 ? '' : 's'}  ${dim(`${since} -> ${until}`)}`);
    for (const { host, strategy, count } of reached) {
      console.log(`\n${bold(host)}  ${count}  ${dim(STRATEGY_LABEL[strategy])}`);
      const tally = new Map<string, number>();
      for (const m of messages) {
        if (m.host === host) tally.set(m.marker, (tally.get(m.marker) ?? 0) + 1);
      }
      const width = Math.max(0, ...[...tally.keys()].map((k) => k.length));
      for (const [marker, hits] of [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
        console.log(`  ${marker.padEnd(width)}  ${hits}`);
      }
    }
  }

  for (const u of unreachable) console.error(`${sgr('31', '✕', process.stderr)} ${u.host} ${dim(u.error, process.stderr)}`);
  // Partial results are still useful and `unreachable` reports what is missing,
  // so only a total failure is an error.
  if (unreachable.length === hosts.length) process.exitCode = 1;
};

// ---- cli ----------------------------------------------------------------
// commander's option names arrive camelCased; the command implementations were
// written against the kebab-case spellings, so translate once here rather than
// touching every call site.
const FLAG_NAMES = {
  host: 'host', model: 'model', branch: 'branch', worktree: 'worktree',
  name: 'name', timeout: 'timeout',
  runtimeMode: 'runtime-mode', interactionMode: 'interaction-mode',
  option: 'option', newWorktree: 'new-worktree', base: 'base', message: 'message', json: 'json',
};
// Only carry options that were actually supplied. Emitting every key
// unconditionally made `'name' in flags` always true, which made host add bail
// on every invocation.
const toFlags = (o: Record<string, unknown>): Flags => Object.fromEntries(
  Object.entries(FLAG_NAMES)
    .filter(([from]) => o[from] !== undefined)
    .map(([from, to]) => [to, o[from]]),
);

const resolve = async (ref: string, o: Record<string, unknown>) => {
  const host = pickHost(toFlags(o));
  return { host, thread: resolveThread(await snapshot(host), ref) };
};

// Compiled to dist/t3ctl.js, so package.json is one level up — true in the repo
// and in the published tarball, which ships dist/ alongside package.json.
const pkg = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

// With --json, an error is one JSON object on stderr — commander's own (a
// missing argument, an unknown option) as well as ours — so a caller reads it
// with JSON.parse instead of stripping colour and prose. Read from argv because
// commander's errors arrive before any options are parsed; a `--json` after
// `--` is message text, not the flag.
const jsonErrors = ((args) => args.slice(0, args.includes('--') ? args.indexOf('--') : undefined).includes('--json'))(process.argv.slice(2));
const printJsonError = (message: string): void => { process.stderr.write(`${JSON.stringify({ error: message })}\n`); };

const program = new Command();
// Before any .command(): subcommands copy the output settings when created.
if (jsonErrors) {
  program.configureOutput({
    outputError: (text) => printJsonError(text.replace(/^error: /, '').trim()),
    // Drops the "(run `t3ctl --help` ...)" hint commander adds after an error.
    writeErr: () => {},
  });
}
program
  .name('t3ctl')
  .description('Control T3 Code hosts — list and drive coding-agent threads across every machine you run T3 Code on.')
  .version(pkg.version, '-v, --version', 'print the t3ctl version')
  .showHelpAfterError('(run `t3ctl --help` or `t3ctl <command> --help`)')
  .configureHelp({ showGlobalOptions: true });

const addOption = (value: string, previous?: string[]): string[] => [...(previous ?? []), value];
const hostOption = (cmd: Command) => cmd.option('--host <name>', 'which registered host to talk to (required when several are registered)');

program.command('ls')
  .description('list projects and threads across all registered hosts')
  .option('-t, --threads', 'expand the threads under each project')
  .option('-a, --all', 'include archived and deleted items')
  .option('--json', 'emit JSON instead of a table')
  .action((o: OptionValues) => cmdLs(o));

const host = program.command('host').description('manage the host registry');

host.command('add')
  .argument('<origin>', 'base URL of the host, e.g. https://box.tailnet.ts.net:3773 — or an ssh login like agent@box to bootstrap that machine end to end')
  .argument('[token]', 'bearer token from `t3 auth session issue` on that host (origin form only)')
  .description('register a host — from a URL, or from its ssh login alone')
  .option('--name <name>', 'override the label detected from the host')
  .option('--ttl <duration>', 'session lifetime for the ssh form, e.g. 30d (default 30d)', '30d')
  .option('--t3-version <version>', 'exact t3 CLI version to install remotely (default: npm-resolved latest, nightly as fallback)')
  .action(async (origin: string, token: string | undefined, o: OptionValues) => {
    const flags = toFlags(o);
    const hosts = readHosts();
    // Two shapes, told apart by scheme: an http(s) origin pairs with an existing
    // server; anything else is an ssh login that bootstraps one.
    if (isOrigin(origin)) {
      return cmdHostAdd([origin, ...(token ? [token] : [])], flags, hosts);
    }
    // An origin missing its scheme is still the old, deliberate rejection — not
    // guessed at, and not misread as an ssh target (ssh targets never carry a
    // colon; ports belong to origins).
    if (origin.includes(':')) {
      return usage('an origin needs a scheme, e.g. http://localhost:3773');
    }
    if (token) {
      throw new Error('a token argument only makes sense with an <origin>; the ssh form mints its own');
    }
    return cmdHostAddSsh(origin, flags, hosts);
  });

host.command('rm')
  .argument('<name>', 'registered host name')
  .description('remove a host from the registry')
  .action((name: string) => {
    const hosts = readHosts();
    const gone = hosts.find((h) => h.name === name);
    if (!gone) throw new Error(`no such host: ${name}`);
    // Taking the ssh master down with the entry; a missing socket just exits 255.
    if (gone.ssh) {
      spawnSync('ssh', ['-O', 'exit', '-S', ctlPath(gone.ssh, gone.sshLocalPort), gone.ssh], { stdio: 'ignore' });
    }
    writeHosts(hosts.filter((h) => h.name !== name));
    console.log(`removed ${name}`);
  });

host.command('ls').description('list registered hosts and probe each one')
  .action(() => cmdHostsList(readHosts()));

program.command('hosts').description('list registered hosts and probe each one (alias of `host ls`)')
  .action(() => cmdHostsList(readHosts()));

// Repeatable, because a workspace tree is not always one root. No default value
// is handed to commander: it would print `(default: [])` in the help, which is
// not what happens when the flag is omitted.
const addWatch = (value: string, previous?: string[]): string[] => [...(previous ?? []), value];

const exportGroup = program.command('export').description('read-only exports for other tools');

exportGroup.command('prompts')
  .description('every prompt a human typed, across hosts, with the project it happened in')
  .requiredOption('--since <date>', 'window start, inclusive — a bare YYYY-MM-DD is a UTC day boundary')
  .option('--until <date>', 'window end, exclusive (default: now)')
  .option('--host <name>', 'only this registered host (default: every one of them)')
  .option('--watch <path>', 'only prompts in projects under this root; repeatable (default: ~/Code)', addWatch)
  .option('--json', 'emit JSON instead of a summary')
  .action((o: OptionValues) => cmdExportPrompts(o as ExportOptions));

const project = program.command('project').description('manage projects');
hostOption(project.command('create')
  .argument('<title>', 'name for the project as it appears in T3 Code')
  .argument('<workspace-root>', 'existing directory the project maps to')
  .description('create a project for an existing directory'))
  .action((title: string, root: string, o: OptionValues) => cmdProjectCreate(title, root, toFlags(o)));

const thread = program.command('thread').description('create and drive threads');

hostOption(thread.command('create')
  .argument('<project>', 'project id, title, or workspace root')
  .argument('<title...>', 'thread title; everything after the project is used')
  .description('create a thread (idle — use `thread send` to run it, or --new-worktree to start it in a fresh worktree)')
  .option('--model <instance/model>', 'e.g. claudeAgent/claude-opus-5', 'claudeAgent/claude-opus-5')
  .option('--option <id=value>', 'model option, e.g. effort=high; repeatable', addOption)
  .option('--branch <branch>', 'git branch to associate with the thread; with --new-worktree, the branch to create')
  .option('--worktree <path>', 'existing git worktree the thread should run in')
  .option('--new-worktree', 'have the server create a worktree and start the thread in it; needs --message')
  .option('--base <branch>', "with --new-worktree: branch to start from (default: the repo's default branch)")
  .option('--message <text>', 'with --new-worktree: the first message, which starts the agent (quote it)')
  .option('--runtime-mode <mode>', RUNTIME_MODE_HELP, 'full-access')
  .option('--interaction-mode <mode>', 'default | plan', 'default')
  .option('--json', 'print the new thread as JSON, and errors as {"error": ...} on stderr'))
  .action((ref: string, title: string[], o: OptionValues) => cmdThreadCreate(ref, title.join(' '), toFlags(o)));

hostOption(thread.command('send')
  .alias('start')
  .argument('<thread>', 'thread id, exact title, or unique substring')
  .argument('<message...>', 'the message; everything after the thread is sent')
  .description('send a message to a thread and run the agent')
  .option('--model <instance/model>', "override the thread's model for this turn")
  .option('--option <id=value>', "model option for this turn, e.g. effort=high; repeatable", addOption)
  .option('--runtime-mode <mode>', RUNTIME_MODE_HELP)
  .option('--interaction-mode <mode>', 'default | plan')
  .option('--json', 'print the result as JSON, and errors as {"error": ...} on stderr'))
  .action(async (ref: string, message: string[], o: OptionValues) => {
    const { host: h, thread: t } = await resolve(ref, o);
    return cmdThreadStart(t, h, message.join(' '), toFlags(o));
  });

hostOption(thread.command('rename')
  .argument('<thread>', 'thread id, exact title, or unique substring')
  .argument('<title...>', 'the new title')
  .description('set a thread title directly'))
  .action(async (ref: string, title: string[], o: OptionValues) => {
    const { host: h, thread: t } = await resolve(ref, o);
    return cmdThreadRename(t, h, title.join(' '));
  });

hostOption(thread.command('retitle')
  .argument('<thread>', 'thread id, exact title, or unique substring')
  .description('ask the server to derive a title; warns if it produces none')
  .option('--timeout <seconds>', 'how long to wait for a title', '30'))
  .action(async (ref: string, o: OptionValues) => {
    const { host: h, thread: t } = await resolve(ref, o);
    return cmdThreadRetitle(t, h, Number(o.timeout) > 0 ? Number(o.timeout) : 30);
  });

hostOption(thread.command('interrupt')
  .argument('<thread>', 'thread id, exact title, or unique substring')
  .description('stop the turn currently running in a thread'))
  .action(async (ref: string, o: OptionValues) => {
    const { host: h, thread: t } = await resolve(ref, o);
    return cmdThreadInterrupt(t, h);
  });

hostOption(thread.command('snooze')
  .argument('<thread>', 'thread id, exact title, or unique substring')
  .argument('<when>', WHEN_HELP)
  .description('hide a thread until a wake time'))
  .action(async (ref: string, when: string, o: OptionValues) => {
    const { host: h, thread: t } = await resolve(ref, o);
    return cmdThreadSnooze(t, h, when);
  });

hostOption(thread.command('unsnooze')
  .argument('<thread>', 'thread id, exact title, or unique substring')
  .description('wake a snoozed thread now'))
  .action(async (ref: string, o: OptionValues) => {
    const { host: h, thread: t } = await resolve(ref, o);
    return cmdThreadUnsnooze(t, h);
  });

hostOption(thread.command('runtime-mode')
  .alias('mode')
  .argument('<thread>', 'thread id, exact title, or unique substring')
  .argument('<mode>', RUNTIME_MODE_HELP)
  .description("change an existing thread's runtime (security) mode without sending a message"))
  .action(async (ref: string, mode: string, o: OptionValues) => {
    const { host: h, thread: t } = await resolve(ref, o);
    return cmdThreadRuntimeMode(t, h, mode);
  });

const VERB_HELP: Record<string, string> = {
  settle: 'mark a thread done so it drops out of the active list',
  archive: 'hide a thread from the default listing (reversible)',
  unarchive: 'bring an archived thread back into the default listing',
  unpin: 'remove a thread from the pinned section',
  delete: 'delete a thread',
};
for (const verb of SIMPLE_THREAD_COMMANDS) {
  hostOption(thread.command(verb)
    .argument('<thread>', 'thread id, exact title, or unique substring')
    .description(VERB_HELP[verb] ?? `${verb} a thread`))
    .action((ref: string, o: OptionValues) => cmdThreadSimple(verb, ref, toFlags(o)));
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (jsonErrors) printJsonError(errorMessage(error));
  else console.error(`${sgr('31', 'error', process.stderr)} ${errorMessage(error)}`);
  process.exit(1);
}

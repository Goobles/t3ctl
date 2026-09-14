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
// Shapes are the subset of T3 Code's API that t3ctl actually reads. The full
// schemas live in packages/contracts/src/orchestration.ts upstream.

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
  platform?: { os: string; arch: string };
};

type ModelSelection = { instanceId: string; model: string };

type Session = {
  status: string;
  providerName?: string | null;
  activeTurnId?: string | null;
};

type Thread = {
  id: string;
  projectId: string;
  title: string;
  branch?: string | null;
  worktreePath?: string | null;
  updatedAt: string;
  deletedAt?: string | null;
  archivedAt?: string | null;
  settledAt?: string | null;
  unsettledAt?: string | null;
  snoozedUntil?: string | null;
  runtimeMode?: string;
  modelSelection?: ModelSelection | null;
  session?: Session | null;
  latestTurn?: { state?: string } | null;
  proposedPlans?: unknown[];
  titleRegeneration?: unknown | null;
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
  'host' | 'model' | 'branch' | 'worktree' | 'name' | 'timeout' | 'runtime-mode' | 'interaction-mode' | 'ttl' | 't3-version',
  string
>>;

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

const snapshot = async (host: Host): Promise<Snapshot> => {
  await ensureTunnel(host);
  const res = await fetch(`${host.origin}/api/orchestration/snapshot`, {
    headers: host.token ? { authorization: `Bearer ${host.token}` } : {},
    signal: AbortSignal.timeout(host.timeoutMs ?? 15000),
  });
  if (!res.ok) throw new Error(`${host.name}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  return (await res.json()) as Snapshot;
};

// Derived status. Order matters: most urgent wins.
const threadStatus = (t: Thread): ThreadStatus => {
  if (t.deletedAt) return 'deleted';
  if (t.archivedAt) return 'archived';
  if (t.session?.activeTurnId || t.session?.status === 'running') return 'running';
  if (t.session?.status === 'error' || t.latestTurn?.state === 'error') return 'error';
  if (t.snoozedUntil && new Date(t.snoozedUntil) > new Date()) return 'snoozed';
  if (t.proposedPlans?.length) return 'needs-review';
  if (t.settledAt && !t.unsettledAt) return 'settled';
  return 'idle';
};

const ICON = {
  running: '\x1b[32m●\x1b[0m', error: '\x1b[31m✕\x1b[0m', 'needs-review': '\x1b[33m◆\x1b[0m',
  snoozed: '\x1b[90m☾\x1b[0m', settled: '\x1b[90m✓\x1b[0m', idle: '\x1b[90m·\x1b[0m',
  archived: '\x1b[90m▪\x1b[0m', deleted: '\x1b[90m✗\x1b[0m',
};
/** `catch` binds `unknown`; every call site wants the same string out of it. */
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
// Usage errors are user errors: print to stderr and exit non-zero so scripts
// can tell them apart from success.
const usage = (message: string): void => {
  console.error(message);
  process.exitCode = 1;
};
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

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

const cmdLs = async ({ threads: showThreads, all: showAll, json: asJson }: LsOptions): Promise<void> => {
  const hosts = readHosts();
  if (!hosts.length) return console.error('No hosts registered. Run: t3ctl host add <origin> <token>');

  const { ok, failed } = await collect(hosts);

  if (asJson) {
    const out = ok.flatMap(({ host, snap }) => snap.projects
      .filter((p) => showAll || !p.deletedAt)
      .map((p) => ({
        host: host.name, id: p.id, title: p.title, workspaceRoot: p.workspaceRoot,
        threads: snap.threads.filter((t) => t.projectId === p.id)
          .filter((t) => showAll || (!t.deletedAt && !t.archivedAt))
          .map((t) => ({ id: t.id, title: t.title, branch: t.branch, status: threadStatus(t), provider: t.session?.providerName ?? null, updatedAt: t.updatedAt })),
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
        const meta = [t.branch, t.session?.providerName].filter(Boolean).join(' ');
        console.log(`    ${ICON[s] ?? '?'} ${(t.title || '(untitled)').slice(0, 62).padEnd(62)} ${dim(meta)}`);
      }
    }
  }
  for (const f of failed) console.error(`\n\x1b[31munreachable\x1b[0m ${f.host.name}: ${f.error}`);
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
  };
};

const shortId = (id?: string | null) => (id ? id.slice(0, 8) : '-');
const warn = (message: string) => console.error(`\x1b[33mwarning\x1b[0m ${message}`);

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
  const existing = hosts.find((h) => h.origin === origin);

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
//   * `t3 service install` is per-user launchd/systemd (no sudo, macOS/Linux).
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
try {
  const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const pid = Number(r.pid), port = Number(r.port);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) throw 0;
  const origin = new URL(String(r.origin ?? ''));
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)) throw 0;
  process.kill(pid, 0);
  process.stdout.write('T3CTL {"running":true,"port":' + port + '}\\n');
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

const sshRun = (target: string, args: string[], { streamStderr = false } = {}): SshResult => {
  const res = spawnSync('ssh', ['-o', 'ConnectTimeout=15', target, 'sh', '-s', '--', ...args], {
    input: SSH_SCRIPT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: streamStderr ? ['pipe', 'pipe', 'inherit'] : 'pipe',
  });
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new Error('ssh not found locally');
  return { status: res.status ?? 1, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
};

type DetectResult = { node?: boolean; running?: boolean; port?: number };

// Bottom-up scan for the last T3CTL JSON marker — immune to npm chatter above it.
const sshDetect = (target: string): DetectResult => {
  const res = sshRun(target, ['detect']);
  if (res.status !== 0) throw new Error(`ssh to ${target} failed (exit ${res.status})${res.stderr.trim() ? `: ${res.stderr.trim().split('\n').slice(-2).join('\n')}` : ''}`);
  const line = res.stdout.split('\n').reverse().find((l) => l.startsWith('T3CTL {'));
  if (!line) throw new Error(`detect on ${target} produced no answer`);
  return JSON.parse(line.slice('T3CTL '.length)) as DetectResult;
};

const sshToken = (target: string, version: string, label: string, ttl: string): { token: string; sessionId?: string } => {
  // First run downloads t3@<version> into the remote npx cache — minutes with
  // nothing to show unless npm's progress on stderr streams through.
  const res = sshRun(target, ['token', version, label, ttl], { streamStderr: true });
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
      const issued = sshToken(target, version, `t3ctl:${name}`, flags.ttl ?? '30d');
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
        `  revoke on ${target} with: npx t3 auth session revoke ${session.sessionId ?? '?'}`);
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

const dispatch = async (host: Host, command: OrchestrationCommand): Promise<{ sequence: number }> => {
  await ensureTunnel(host);
  const res = await fetch(`${host.origin}/api/orchestration/dispatch`, {
    method: 'POST',
    headers: { ...(host.token ? { authorization: `Bearer ${host.token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(host.timeoutMs ?? 15000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${command.type} failed: HTTP ${res.status} ${body}`);
  return body ? (JSON.parse(body) as { sequence: number }) : { sequence: 0 };
};

const resolveProject = (snap: Snapshot, ref: string): Project | undefined =>
  snap.projects.find((p) => p.id === ref) ??
  snap.projects.find((p) => !p.deletedAt && p.title === ref) ??
  snap.projects.find((p) => !p.deletedAt && p.workspaceRoot === path.resolve(ref.replace(/^~/, os.homedir())));


// Commands whose entire payload is {commandId, threadId}. Verified against
// packages/contracts/src/orchestration.ts — note `unsettle` is NOT one of
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


// thread.turn.start is ONE command carrying the first message inline — this is
// what the UI fires immediately after thread.create, which is why a thread with
// no messages is a state the UI never produces. The client-side schema requires
// runtimeMode/interactionMode explicitly (the server-side one defaults them).
const cmdThreadStart = async (thread: Thread, host: Host, text: string, flags: Flags): Promise<void> => {
  const command: OrchestrationCommand = {
    type: 'thread.turn.start',
    commandId: crypto.randomUUID(),
    threadId: thread.id,
    message: { messageId: crypto.randomUUID(), role: 'user', text, attachments: [] },
    runtimeMode: flags['runtime-mode'] ?? thread.runtimeMode ?? 'full-access',
    interactionMode: flags['interaction-mode'] ?? 'default',
    createdAt: new Date().toISOString(),
  };
  if (flags.model) {
    const slash = flags.model.indexOf('/');
    if (slash < 1) throw new Error(`--model must be <instance>/<model>, got "${flags.model}"`);
    command.modelSelection = { instanceId: flags.model.slice(0, slash), model: flags.model.slice(slash + 1) };
  } else if (thread.modelSelection) {
    command.modelSelection = thread.modelSelection;
  }
  const { sequence } = await dispatch(host, command);
  const m = command['modelSelection'] as ModelSelection | undefined;
  console.log(`started ${bold(thread.title || thread.id)}\n  id    ${thread.id}` +
    (m ? `\n  model ${m.instanceId}/${m.model}` : '') +
    `\n  mode  ${command.runtimeMode} / ${command.interactionMode}\n  seq   ${sequence}`);
};

const cmdThreadInterrupt = async (thread: Thread, host: Host): Promise<void> => {
  const { sequence } = await dispatch(host, {
    type: 'thread.turn.interrupt', commandId: crypto.randomUUID(), threadId: thread.id,
  });
  console.log(`interrupted ${bold(thread.title || thread.id)}\n  seq ${sequence}`);
};



// thread.meta.update also accepts regenerateTitle:true, which asks the server to
// derive a title from the thread's own content instead of taking one from us.
const cmdThreadRename = async (thread: Thread, host: Host, title: string): Promise<void> => {
  const { sequence } = await dispatch(host, {
    type: 'thread.meta.update', commandId: crypto.randomUUID(), threadId: thread.id, title,
  });
  console.log(`renamed ${dim(thread.title || thread.id)} -> ${bold(title)}\n  seq ${sequence}`);
};

// Lighter than the full snapshot; retitle polls this so it does not refetch every
// thread's history once a second.
const threadDetail = async (host: Host, threadId: string): Promise<Thread> => {
  await ensureTunnel(host);
  const res = await fetch(`${host.origin}/api/orchestration/threads/${threadId}?turnLimit=1`, {
    headers: { authorization: `Bearer ${host.token}` },
    signal: AbortSignal.timeout(host.timeoutMs ?? 15000),
  });
  if (!res.ok) throw new Error(`${host.name}: HTTP ${res.status}`);
  return ((await res.json()) as { thread: Thread }).thread;
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
    type: 'thread.meta.update', commandId: crypto.randomUUID(), threadId: thread.id,
    regenerateTitle: true,
  });
  console.log(`asked the server to retitle ${bold(before || thread.id)}${dim(`  (seq ${sequence})`)}`);

  const deadline = Date.now() + timeoutSeconds * 1000;
  let sawMarker = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const current = await threadDetail(host, thread.id);
    if (current.title && current.title !== before) {
      console.log(`retitled -> ${bold(current.title)}`);
      return;
    }
    if (current.titleRegeneration) { sawMarker = true; continue; }
    if (sawMarker) break; // marker appeared and was cleared, title unchanged
  }

  console.error(
    `\x1b[33mno title was generated\x1b[0m — the server ${sawMarker ? 'cleared the request without producing one' : `did not act on it within ${timeoutSeconds}s`}.\n` +
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
  const { sequence } = await dispatch(host, {
    type: 'project.create', commandId: crypto.randomUUID(),
    projectId, title, workspaceRoot, createdAt: new Date().toISOString(),
  });
  console.log(`created project ${bold(title)} on ${host.name}\n  id   ${projectId}\n  root ${workspaceRoot}\n  seq  ${sequence}`);
};

const cmdThreadCreate = async (projectRef: string, title: string, flags: Flags): Promise<void> => {
  const host = pickHost(flags);
  const project = resolveProject(await snapshot(host), projectRef);
  if (!project) throw new Error(`no project matching "${projectRef}" on ${host.name}`);
  // instanceId is the segment before the FIRST slash; the model keeps the rest,
  // because opencode model ids are themselves slashed ("github-copilot/gpt-5.4").
  const raw = flags.model ?? 'claudeAgent/claude-opus-5';
  const slash = raw.indexOf('/');
  if (slash < 1) throw new Error(`--model must be <instance>/<model>, got "${raw}"`);
  const modelSelection = { instanceId: raw.slice(0, slash), model: raw.slice(slash + 1) };
  const threadId = crypto.randomUUID();
  const { sequence } = await dispatch(host, {
    type: 'thread.create', commandId: crypto.randomUUID(),
    threadId, projectId: project.id, title, modelSelection,
    runtimeMode: flags['runtime-mode'] ?? 'full-access',
    interactionMode: flags['interaction-mode'] ?? 'default',
    branch: flags.branch ?? null,
    worktreePath: flags.worktree ?? null,
    createdAt: new Date().toISOString(),
  });
  console.log(`created thread ${bold(title)} in ${project.title} on ${host.name}\n  id    ${threadId}\n  model ${modelSelection.instanceId}/${modelSelection.model}\n  seq   ${sequence}`);
};

const cmdThreadSimple = async (verb: string, ref: string, flags: Flags): Promise<void> => {
  const host = pickHost(flags);
  const thread = resolveThread(await snapshot(host), ref);
  const { sequence } = await dispatch(host, {
    type: `thread.${verb}`, commandId: crypto.randomUUID(), threadId: thread.id,
  });
  console.log(`${verb}d ${bold(thread.title || thread.id)}\n  id  ${thread.id}\n  seq ${sequence}`);
};

// ---- cli ----------------------------------------------------------------
// commander's option names arrive camelCased; the command implementations were
// written against the kebab-case spellings, so translate once here rather than
// touching every call site.
const FLAG_NAMES = {
  host: 'host', model: 'model', branch: 'branch', worktree: 'worktree',
  name: 'name', timeout: 'timeout',
  runtimeMode: 'runtime-mode', interactionMode: 'interaction-mode',
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

const program = new Command();
program
  .name('t3ctl')
  .description('Control T3 Code hosts — list and drive coding-agent threads across every machine you run T3 Code on.')
  .version(pkg.version, '-v, --version', 'print the t3ctl version')
  .showHelpAfterError('(run `t3ctl --help` or `t3ctl <command> --help`)')
  .configureHelp({ showGlobalOptions: true });

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
  .description('create a thread (idle — use `thread send` to run it)')
  .option('--model <instance/model>', 'e.g. claudeAgent/claude-opus-5', 'claudeAgent/claude-opus-5')
  .option('--branch <branch>', 'git branch to associate with the thread')
  .option('--worktree <path>', 'git worktree the thread should run in')
  .option('--runtime-mode <mode>', 'approval-required | auto-accept-edits | auto | full-access', 'full-access')
  .option('--interaction-mode <mode>', 'default | plan', 'default'))
  .action((ref: string, title: string[], o: OptionValues) => cmdThreadCreate(ref, title.join(' '), toFlags(o)));

hostOption(thread.command('send')
  .alias('start')
  .argument('<thread>', 'thread id, exact title, or unique substring')
  .argument('<message...>', 'the message; everything after the thread is sent')
  .description('send a message to a thread and run the agent')
  .option('--model <instance/model>', "override the thread's model for this turn")
  .option('--runtime-mode <mode>', 'approval-required | auto-accept-edits | auto | full-access')
  .option('--interaction-mode <mode>', 'default | plan'))
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
  console.error(`\x1b[31merror\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

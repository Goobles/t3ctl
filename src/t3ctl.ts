#!/usr/bin/env node
// t3ctl — a controller CLI for T3 Code hosts.
// Peer of the mobile app: pairs once per host, then reads/controls remotely.
// Spike scope: host registry + read-only listing.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
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
  /** `[user@]host` for `export prompts`. Hand-written in hosts.json; nothing sets it. */
  ssh?: string;
  environmentId?: string;
  label?: string;
  serverVersion?: string;
  timeoutMs?: number;
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
  createdAt?: string;
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
  /** Only ever populated by the per-thread endpoint; the snapshot leaves it empty. */
  messages?: ThreadMessage[];
};

/** A message as `thread.message-sent` carries it, which is what the detail endpoint serialises. */
type ThreadMessage = {
  messageId?: string;
  id?: string;
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
  'host' | 'model' | 'branch' | 'worktree' | 'name' | 'timeout' | 'runtime-mode' | 'interaction-mode',
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
    console.log(`${icon} ${live ? bold(h.name.padEnd(14)) : dim(h.name.padEnd(14))} ${cell(label, 18)} ${dim(env.padEnd(9))} ${cell(version, 28)} ${dim(h.origin)}` +
      (live || !p || p.status !== 'rejected' ? '' : ` ${dim(errorMessage(p.reason))}`));
  });
  for (const { h, live } of drifted) {
    warn(`${h.name} (${h.origin}) is now a DIFFERENT environment\n` +
      `  was ${h.environmentId} (${h.label ?? 'unknown'})\n  now ${live.environmentId} (${live.label})`);
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
// `turnLimit` is null for callers that want the whole history (export), 1 for
// callers that only want to poll a field (retitle).
const threadDetail = async (host: Host, threadId: string, turnLimit: number | null = 1): Promise<Thread> => {
  const query = turnLimit === null ? '' : `?turnLimit=${turnLimit}`;
  const res = await fetch(`${host.origin}/api/orchestration/threads/${threadId}${query}`, {
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

// ---- export -------------------------------------------------------------
// `export prompts` answers one narrow question for other tools: which prompts
// did a human type, where, and when. It is the only read path that avoids the
// HTTP API when it can, because the API answers it in N+1 requests — a snapshot
// to learn the thread ids, then one fetch per thread, since snapshot threads
// carry no messages — for data that is one join in the host's own database.
//
// Three strategies, cheapest first. They are deliberately written to return the
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

type Strategy = 'sqlite' | 'ssh' | 'http';

const STRATEGY_LABEL: Record<Strategy, string> = {
  sqlite: 'local state.sqlite',
  ssh: 'state.sqlite over ssh',
  http: 'snapshot + per-thread fetch',
};

/** Fixed by T3 Code. Read relative to whichever machine's home directory applies. */
const STATE_DB = '.t3/userdata/state.sqlite';

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

// One statement, shared by the local and ssh strategies so they cannot drift.
const PROMPT_SQL = `SELECT m.message_id, m.thread_id, m.text, m.created_at, p.workspace_root
FROM projection_thread_messages m
JOIN projection_threads t ON t.thread_id = m.thread_id
JOIN projection_projects p ON p.project_id = t.project_id
WHERE m.role = 'user'
  AND t.deleted_at IS NULL
  AND p.deleted_at IS NULL
  AND m.created_at >= ? AND m.created_at < ?
ORDER BY m.created_at`;

/** `created_at` is stored as an ISO instant, so the bounds must be exactly that too. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
    throw new Error('reading state.sqlite needs node:sqlite — run on Node >= 24, or Node 22 with --experimental-sqlite');
  }
};

const queryLocal = async (since: string, until: string): Promise<PromptRow[]> => {
  const file = path.join(os.homedir(), STATE_DB);
  if (!fs.existsSync(file)) throw new Error(`no T3 Code database at ${file}`);
  const DatabaseSync = await loadSqlite();
  // The database is in WAL mode, so this reader neither blocks the running app
  // nor is blocked by it, and no copy is needed — it is ~500 MB.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(PROMPT_SQL).all(since, until) as unknown as PromptRow[];
  } finally {
    db.close();
  }
};

// Copying the database would move hundreds of megabytes to answer with a few
// kilobytes, so the query runs on the far side and only rows come back. The
// script travels on stdin, which keeps it out of the remote shell's hands
// entirely; only the two bounds are interpolated, and those are checked against
// ISO_INSTANT first.
const REMOTE_QUERY = `const { DatabaseSync } = require('node:sqlite');
const [file, since, until] = process.argv.slice(2);
const db = new DatabaseSync(file, { readOnly: true });
process.stdout.write(JSON.stringify(db.prepare(${JSON.stringify(PROMPT_SQL)}).all(since, until)));
db.close();`;

const sshQuery = (target: string, bounds: [string, string], nodeFlags: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const argv = [...nodeFlags, '-', `"$HOME/${STATE_DB}"`, ...bounds.map((b) => `'${b}'`)];
    const child = spawn('ssh', ['-o', 'BatchMode=yes', target, `node ${argv.join(' ')}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve(out)
      : reject(new Error(err.trim().split('\n').at(-1) || `ssh ${target} exited ${code}`))));
    child.stdin.end(REMOTE_QUERY);
  });

const queryOverSsh = async (target: string, since: string, until: string): Promise<PromptRow[]> => {
  for (const bound of [since, until]) {
    if (!ISO_INSTANT.test(bound)) throw new Error(`refusing to send a malformed bound over ssh: ${bound}`);
  }
  let raw: string;
  try {
    raw = await sshQuery(target, [since, until], []);
  } catch (error) {
    // An early Node 22 on the far machine keeps node:sqlite behind a flag. Retry
    // once rather than make the user care which Node it happens to run.
    if (!/node:sqlite|experimental-sqlite|UNKNOWN_BUILTIN_MODULE/.test(errorMessage(error))) throw error;
    raw = await sshQuery(target, [since, until], ['--experimental-sqlite']);
  }
  return JSON.parse(raw) as PromptRow[];
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
    const detail = await threadDetail(host, t.id, null);
    const rows: PromptRow[] = [];
    for (const m of detail.messages ?? []) {
      if (m.role !== 'user') continue;
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
 * host serves, so read it and skip the network. Otherwise an `ssh` target in
 * hosts.json beats HTTP, because one round trip beats N+1.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const strategyFor = (host: Host): Strategy => {
  let hostname = '';
  try {
    hostname = new URL(host.origin).hostname;
  } catch { /* an unparseable origin is not loopback; let the HTTP path report it */ }
  if (LOOPBACK.has(hostname)) return 'sqlite';
  return host.ssh ? 'ssh' : 'http';
};

const readPrompts = (host: Host, strategy: Strategy, since: string, until: string): Promise<PromptRow[]> => {
  if (strategy === 'sqlite') return queryLocal(since, until);
  if (strategy === 'ssh') return queryOverSsh(host.ssh ?? '', since, until);
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

  for (const u of unreachable) console.error(`${ICON.error} ${u.host} ${dim(u.error)}`);
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
  .argument('<origin>', 'base URL of the host, e.g. https://box.tailnet.ts.net:3773')
  .argument('[token]', 'bearer token from `t3 auth session issue` on that host')
  .description('register a host, probing /.well-known/t3/environment first')
  .option('--name <name>', 'override the label detected from the host')
  .action((origin: string, token: string, o: OptionValues) => cmdHostAdd([origin, token].filter(Boolean), toFlags(o), readHosts()));

host.command('rm')
  .argument('<name>', 'registered host name')
  .description('remove a host from the registry')
  .action((name: string) => {
    const hosts = readHosts();
    if (!hosts.some((h) => h.name === name)) throw new Error(`no such host: ${name}`);
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

#!/usr/bin/env node
// t3ctl — a controller CLI for T3 Code hosts.
// Peer of the mobile app: pairs once per host, then reads/controls remotely.
// Spike scope: host registry + read-only listing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = path.join(os.homedir(), '.config', 't3ctl');
const HOSTS_FILE = path.join(CONFIG_DIR, 'hosts.json');

const readHosts = () => {
  if (!fs.existsSync(HOSTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')).hosts ?? [];
};

const writeHosts = (hosts) => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(HOSTS_FILE, JSON.stringify({ hosts }, null, 2), { mode: 0o600 });
};

const snapshot = async (host) => {
  const res = await fetch(`${host.origin}/api/orchestration/snapshot`, {
    headers: { authorization: `Bearer ${host.token}` },
    signal: AbortSignal.timeout(host.timeoutMs ?? 15000),
  });
  if (!res.ok) throw new Error(`${host.name}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  return res.json();
};

// Derived status. Order matters: most urgent wins.
const threadStatus = (t) => {
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
const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const collect = async (hosts) => {
  const results = await Promise.allSettled(hosts.map(async (h) => ({ host: h, snap: await snapshot(h) })));
  const ok = [], failed = [];
  results.forEach((r, i) => r.status === 'fulfilled' ? ok.push(r.value) : failed.push({ host: hosts[i], error: r.reason.message }));
  return { ok, failed };
};

const cmdLs = async (args) => {
  const showThreads = args.includes('--threads') || args.includes('-t');
  const showAll = args.includes('--all') || args.includes('-a');
  const asJson = args.includes('--json');
  const hosts = readHosts();
  if (!hosts.length) return console.error('No hosts registered. Run: t3ctl host add <name> <origin> <token>');

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

      const counts = {};
      for (const t of threads) counts[threadStatus(t)] = (counts[threadStatus(t)] ?? 0) + 1;
      const badge = Object.entries(counts).map(([k, v]) => `${ICON[k] ?? '?'}${v}`).join(' ');

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

const cmdHost = (args) => {
  const [sub, ...rest] = args;
  const hosts = readHosts();
  if (sub === 'add') {
    const [name, origin, token] = rest;
    if (!name || !origin || !token) return console.error('usage: t3ctl host add <name> <origin> <token>');
    const next = hosts.filter((h) => h.name !== name).concat({ name, origin: origin.replace(/\/$/, ''), token });
    writeHosts(next);
    console.log(`added ${name} -> ${origin}`);
  } else if (sub === 'rm') {
    writeHosts(hosts.filter((h) => h.name !== rest[0]));
    console.log(`removed ${rest[0]}`);
  } else {
    if (!hosts.length) return console.log('(no hosts)');
    for (const h of hosts) console.log(`${h.name.padEnd(16)} ${h.origin}  ${dim('token:' + h.token.slice(0, 8) + '…')}`);
  }
};


// ---- writes -------------------------------------------------------------
// Commands are dispatched directly (no envelope). The CLIENT mints every id;
// commandId is the idempotency key, so retries are safe.
// Schemas: packages/contracts/src/orchestration.ts in pingdotgg/t3code.

const VALUE_FLAGS = ['host', 'model', 'branch', 'runtime-mode', 'interaction-mode', 'worktree'];

const parseArgs = (argv) => {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    flags[k] = VALUE_FLAGS.includes(k) ? argv[++i] : true;
  }
  return { flags, pos };
};

const pickHost = (flags) => {
  const hosts = readHosts();
  if (flags.host) {
    const h = hosts.find((x) => x.name === flags.host);
    if (!h) throw new Error(`no such host: ${flags.host}`);
    return h;
  }
  if (!hosts.length) throw new Error('no hosts registered — run: t3ctl host add <name> <origin> <token>');
  if (hosts.length > 1) throw new Error(`multiple hosts; pass --host <${hosts.map((h) => h.name).join('|')}>`);
  return hosts[0];
};

const dispatch = async (host, command) => {
  const res = await fetch(`${host.origin}/api/orchestration/dispatch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(host.timeoutMs ?? 15000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${command.type} failed: HTTP ${res.status} ${body}`);
  return body ? JSON.parse(body) : {};
};

const resolveProject = (snap, ref) =>
  snap.projects.find((p) => p.id === ref) ??
  snap.projects.find((p) => !p.deletedAt && p.title === ref) ??
  snap.projects.find((p) => !p.deletedAt && p.workspaceRoot === path.resolve(ref.replace(/^~/, os.homedir())));


// Commands whose entire payload is {commandId, threadId}. Verified against
// packages/contracts/src/orchestration.ts — note `unsettle` is NOT one of
// these (it carries extra fields), so it is deliberately absent.
const SIMPLE_THREAD_COMMANDS = ['settle', 'archive', 'unarchive', 'unpin', 'delete'];

const resolveThread = (snap, ref) => {
  const live = snap.threads.filter((t) => !t.deletedAt);
  const byId = live.find((t) => t.id === ref);
  if (byId) return byId;
  const exact = live.filter((t) => t.title === ref);
  if (exact.length === 1) return exact[0];
  const fuzzy = live.filter((t) => (t.title ?? '').toLowerCase().includes(ref.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(`"${ref}" matches ${fuzzy.length} threads:\n` +
      fuzzy.slice(0, 8).map((t) => `  ${t.id}  ${t.title}`).join('\n'));
  }
  throw new Error(`no thread matching "${ref}"`);
};

const cmdProject = async (args) => {
  const [sub, ...rest] = args;
  const { flags, pos } = parseArgs(rest);
  if (sub !== 'create') return console.error('usage: t3ctl project create <title> <workspace-root> [--host <name>]');
  const [title, root] = pos;
  if (!title || !root) return console.error('usage: t3ctl project create <title> <workspace-root> [--host <name>]');
  const host = pickHost(flags);
  const workspaceRoot = path.resolve(root.replace(/^~/, os.homedir()));
  if (!fs.existsSync(workspaceRoot)) return console.error(`workspace root does not exist: ${workspaceRoot}`);
  const projectId = crypto.randomUUID();
  const { sequence } = await dispatch(host, {
    type: 'project.create', commandId: crypto.randomUUID(),
    projectId, title, workspaceRoot, createdAt: new Date().toISOString(),
  });
  console.log(`created project ${bold(title)} on ${host.name}\n  id   ${projectId}\n  root ${workspaceRoot}\n  seq  ${sequence}`);
};

const cmdThread = async (args) => {
  const [sub, ...rest] = args;
  const { flags, pos } = parseArgs(rest);
  if (SIMPLE_THREAD_COMMANDS.includes(sub)) {
    const host = pickHost(flags);
    const thread = resolveThread(await snapshot(host), pos.join(' '));
    const { sequence } = await dispatch(host, {
      type: `thread.${sub}`, commandId: crypto.randomUUID(), threadId: thread.id,
    });
    console.log(`${sub}d ${bold(thread.title || thread.id)}\n  id  ${thread.id}\n  seq ${sequence}`);
    return;
  }
  if (sub !== 'create') return console.error('usage: t3ctl thread create <project> <title> [--model <instance>/<model>] [--branch <b>] [--host <name>]\n       t3ctl thread <settle|archive|unarchive|unpin|delete> <thread>');
  const [projectRef, ...titleParts] = pos;
  const title = titleParts.join(' ');
  if (!projectRef || !title) return console.error('usage: t3ctl thread create <project> <title> [--model <instance>/<model>] [--branch <b>] [--host <name>]');
  const host = pickHost(flags);
  const project = resolveProject(await snapshot(host), projectRef);
  if (!project) throw new Error(`no project matching "${projectRef}" on ${host.name}`);

  // instanceId is the segment before the first slash; model keeps the rest
  // (opencode models look like "github-copilot/gpt-5.4").
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

const [cmd, ...rest] = process.argv.slice(2);
const commands = { ls: cmdLs, host: cmdHost, hosts: () => cmdHost([]), project: cmdProject, thread: cmdThread };
if (!commands[cmd]) {
  console.log(`t3ctl — control T3 Code hosts

  t3ctl ls [-t|--threads] [-a|--all] [--json]   list projects and threads across hosts
  t3ctl host add <name> <origin> <token>        register a host
  t3ctl host rm <name>                          remove a host
  t3ctl hosts                                   list registered hosts

  t3ctl project create <title> <root>           create a project for an existing dir
  t3ctl thread create <project> <title>         start a thread (--model inst/model,
                                                --branch, --host)
  t3ctl thread settle <thread>                  settle a thread (also: archive,
                                                unarchive, unpin, delete)`);
  process.exit(cmd ? 1 : 0);
}
await commands[cmd](rest);

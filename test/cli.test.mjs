// Integration tests: they run the built CLI as a subprocess, because what we
// care about is the contract a user gets — output, exit codes, help — not the
// internals. Run with `npm test` (which builds first).
//
// Deliberately no network: every case here must work with no hosts registered
// and nothing listening, so it is safe on a CI runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/t3ctl.js', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Tests run against the build output, and `npm test` deliberately does not
// build — the workflows do that as their own step. Fail with something useful
// rather than a pile of confusing assertion errors.
try {
  statSync(CLI);
} catch {
  throw new Error(`${CLI} is missing — run \`npm run build\` first`);
}

/** Run the CLI; never throws, so a test can assert on failures too. */
const cli = async (...args) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: '/nonexistent-t3ctl-test-home' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
};

test('--version matches package.json', async () => {
  const { code, stdout } = await cli('--version');
  assert.equal(code, 0);
  assert.equal(stdout.trim(), pkg.version);
});

test('--help lists the commands', async () => {
  const { code, stdout } = await cli('--help');
  assert.equal(code, 0);
  assert.match(stdout, /Commands:/);
  for (const c of ['ls', 'host', 'hosts', 'models', 'project', 'thread', 'export']) {
    assert.match(stdout, new RegExp(`^\\s+${c}\\b`, 'm'), `missing command: ${c}`);
  }
});

test('every command has its own help', async () => {
  const commands = [
    ['ls'], ['host', 'add'], ['host', 'rm'], ['hosts'], ['models'],
    ['project', 'create'],
    ['thread', 'create'], ['thread', 'scratch'], ['thread', 'send'], ['thread', 'rename'],
    ['thread', 'retitle'], ['thread', 'interrupt'],
    ['thread', 'snooze'], ['thread', 'unsnooze'], ['thread', 'runtime-mode'],
    ['thread', 'settle'], ['thread', 'archive'], ['thread', 'unarchive'],
    ['thread', 'unpin'], ['thread', 'delete'],
    ['export', 'prompts'],
  ];
  for (const c of commands) {
    const { code, stdout } = await cli(...c, '--help');
    assert.equal(code, 0, `no help for: ${c.join(' ')}`);
    assert.match(stdout, /^Usage:/m, `help for ${c.join(' ')} has no usage line`);
  }
});

test('thread start is still an alias of send', async () => {
  const { stdout } = await cli('thread', '--help');
  assert.match(stdout, /send\|start/);
});

test('thread create --help names no fixed default model', async () => {
  const { stdout } = await cli('thread', 'create', '--help');
  assert.doesNotMatch(stdout, /default: "claudeAgent/);
  assert.match(stdout, /project's default model/);
  assert.doesNotMatch(stdout, /default: "full-access"|default: "default"/);
  assert.match(stdout.replace(/\s+/g, ' '), /project's default access in T3 Code's settings, else the environment's, else full-access/);
});

test('bad input exits non-zero', async () => {
  const cases = [
    ['thread', 'send'],
    ['thread', 'rename'],
    ['thread', 'retitle'],
    ['thread', 'snooze'],
    ['thread', 'snooze', 'anything'],        // <when> is required
    ['thread', 'unsnooze'],
    ['thread', 'runtime-mode'],
    ['thread', 'runtime-mode', 'anything'],  // <mode> is required
    ['host', 'add'],
    ['host', 'rm'],
    ['project', 'create'],
    ['bogus'],
    ['export', 'prompts'],                                  // --since is required
    ['export', 'prompts', '--since', 'not-a-date'],
    ['export', 'prompts', '--since', '2026-09-15', '--until', '2026-09-14'],  // inverted window
    ['ls', '--nope'],
    ['host', 'add', 'name', 'http://x:1', 'token'], // the removed legacy form
  ];
  for (const c of cases) {
    const { code } = await cli(...c);
    assert.notEqual(code, 0, `expected failure: t3ctl ${c.join(' ')}`);
  }
});

test('an origin without a scheme is rejected, not guessed at', async () => {
  const { code, stderr, stdout } = await cli('host', 'add', 'localhost:3773');
  assert.notEqual(code, 0);
  assert.match(stdout + stderr, /scheme/i);
});

test('commands needing a host fail cleanly when none is registered', async () => {
  const { code, stdout, stderr } = await cli('thread', 'settle', 'anything');
  assert.notEqual(code, 0);
  assert.match(stdout + stderr, /no hosts registered/);
});

// Tools that drive t3ctl (mainframe starts threads with create + send) read
// errors with JSON.parse, so with --json even commander's own errors are JSON,
// and nothing else reaches stderr.
test('with --json, an error is one JSON object on stderr and still exits non-zero', async () => {
  const cases = [
    [['thread', 'create', 'alpha', 'hello', '--json'], /^no hosts registered/],
    [['thread', 'send', 'scratch', 'hi', '--json'], /^no hosts registered/],
    [['thread', 'send', '--json'], /^missing required argument 'thread'$/],
    [['thread', 'create', 'alpha', 'hello', '--json', '--bogus'], /^unknown option '--bogus'$/],
  ];
  for (const [args, message] of cases) {
    const { code, stdout, stderr } = await cli(...args);
    assert.notEqual(code, 0, `expected failure: t3ctl ${args.join(' ')}`);
    assert.equal(stdout, '');
    const lines = stderr.trim().split('\n');
    assert.equal(lines.length, 1, stderr);
    assert.deepEqual(Object.keys(JSON.parse(lines[0])), ['error']);
    assert.match(JSON.parse(lines[0]).error, message);
  }

  // After `--`, --json is part of the message, so the error stays prose.
  const prose = await cli('thread', 'send', 'scratch', '--', '--json');
  assert.notEqual(prose.code, 0);
  assert.match(prose.stderr, /^error no hosts registered/);
});

test('nothing is coloured when the output is not a terminal', async () => {
  // execFile pipes both streams, as a script or a tool driving t3ctl would.
  const { stderr } = await cli('thread', 'create', 'alpha', 'hello');
  assert.match(stderr, /^error no hosts registered/);
  assert.doesNotMatch(stderr, /\x1b/);
});

test('the published bin target exists and is executable', () => {
  assert.equal(pkg.bin.t3ctl, './dist/t3ctl.js');
  const stat = statSync(CLI);
  assert.ok(stat.isFile());
  assert.match(readFileSync(CLI, 'utf8').split('\n')[0], /^#!\/usr\/bin\/env node$/);
});

test('export prompts needs a host registry like every other read', async () => {
  const { code, stdout, stderr } = await cli('export', 'prompts', '--since', '2026-09-14');
  assert.notEqual(code, 0);
  assert.match(stdout + stderr, /no hosts registered/);
});

// The export tests build a world instead of mocking one: a throwaway
// statev2.sqlite plus a host registry, which between them decide which strategy
// the CLI picks. No server and no network — a host on loopback is read from the
// database directly.
//
// Early Node 22 releases keep node:sqlite behind --experimental-sqlite, so these
// skip rather than fail there; current 22.x and 24 run them. That flag is why
// the CLI imports it lazily.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}
const needsSqlite = { skip: DatabaseSync ? false : 'node:sqlite is flagged on this Node' };

/**
 * A URL the CLI will treat as remote (non-loopback host) but that fails
 * instantly with ECONNREFUSED: the test machine's LAN/Tailscale address on a
 * port we borrow and release — connecting to a non-loopback local address on a
 * closed port is refused, not timed out, unlike an unroutable address such as
 * 10.0.0.9. The listener is closed before returning so it cannot keep the test
 * process alive; the rebind window is a few milliseconds.
 */
const refusedRemoteOrigin = async () => {
  const ip = Object.values(networkInterfaces())
    .flat().filter((i) => i?.family === 'IPv4' && !i.internal).map((i) => i.address)[0]
    ?? '127.0.1.1'; // no external IPv4 (bare CI runner): loopback, but not one the CLI special-cases
  const server = createServer();
  const port = await new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server.address().port));
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  server.close();
  return `http://${ip}:${port}`;
};

// The columns PROMPT_SQL reads, from Orchestrator V2's statev2.sqlite. A
// message's text and author sit in its JSON payload.
const SCHEMA = `
  CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT);
  CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, deleted_at TEXT);
  CREATE TABLE orchestration_v2_projection_messages (message_id TEXT, thread_id TEXT, role TEXT, created_at TEXT, payload_json TEXT);
`;

/** One message row's VALUES tuple; `text` may span lines. */
const msg = (id, thread, role, text, at, createdBy = role === 'user' ? 'user' : 'agent') =>
  `('${id}','${thread}','${role}','${at}',json_object('text','${text}','createdBy','${createdBy}'))`;

/** A HOME with a host registry and a seeded state database. Returns its path. */
const fixtureHome = (hosts, seed) => {
  const home = mkdtempSync(join(tmpdir(), 't3ctl-export-'));
  mkdirSync(join(home, '.t3', 'userdata'), { recursive: true });
  mkdirSync(join(home, '.config', 't3ctl'), { recursive: true });
  writeFileSync(join(home, '.config', 't3ctl', 'hosts.json'), JSON.stringify({ hosts }));
  const db = new DatabaseSync(join(home, '.t3', 'userdata', 'statev2.sqlite'));
  db.exec(SCHEMA + seed(home));
  db.close();
  return home;
};

const LOCAL_HOST = { name: 'box', origin: 'http://127.0.0.1:3773', token: null };

/** Run `export prompts --json` against a fixture HOME and parse what comes back. */
const exportPrompts = async (home, args = [], env = {}) => {
  try {
    const { stdout } = await run(process.execPath, [
      CLI, 'export', 'prompts', '--since', '2026-09-14', '--until', '2026-09-15', '--json', ...args,
    ], { env: { ...process.env, HOME: home, ...env } });
    return JSON.parse(stdout);
  } catch (error) {
    // Some worlds make every host unreachable, and the CLI then exits non-zero
    // after still printing the JSON. Surface both rather than throw.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
};

test('export prompts reads the local state database', needsSqlite, async () => {
  const home = fixtureHome([LOCAL_HOST], (h) => `
    INSERT INTO projection_projects VALUES
      ('p1', '${h}/Code/alpha', NULL),
      ('p2', '${h}/elsewhere/beta', NULL),
      ('p3', '${h}/Code/gone', '2026-01-01T00:00:00.000Z');
    INSERT INTO orchestration_v2_projection_threads VALUES
      ('t1','p1',NULL), ('t2','p2',NULL), ('t3','p3',NULL), ('t4','p1','2026-01-01T00:00:00.000Z');
    INSERT INTO orchestration_v2_projection_messages VALUES
      ${msg('m1', 't1', 'user', '  hello   there  ', '2026-09-14T10:00:00.000Z')},
      ${msg('m2', 't1', 'assistant', 'not a prompt', '2026-09-14T11:00:00.000Z')},
      ${msg('m3', 't1', 'user', '<user_query>\nunwrap me\n</user_query>', '2026-09-14T12:00:00.000Z')},
      ${msg('m4', 't2', 'user', 'outside the watched root', '2026-09-14T13:00:00.000Z')},
      ${msg('m5', 't3', 'user', 'project is deleted', '2026-09-14T13:00:00.000Z')},
      ${msg('m6', 't4', 'user', 'thread is deleted', '2026-09-14T13:00:00.000Z')},
      ${msg('m7', 't1', 'user', 'the day before', '2026-09-13T23:59:59.999Z')},
      ${msg('m8', 't1', 'user', 'the day after', '2026-09-15T00:00:00.000Z')},
      ${msg('m9', 't1', 'user', 'a delegated task brief', '2026-09-14T14:00:00.000Z', 'agent')};
  `);
  try {
    const { messages, unreachable } = await exportPrompts(home);
    assert.deepEqual(unreachable, []);
    // m2 is not a prompt, m4 is outside ~/Code, m5 and m6 hang off deleted rows,
    // m7 and m8 fall outside the half-open window, and m9 was written by an
    // agent, not typed by a person. That leaves m1 and m3.
    assert.deepEqual(messages.map((m) => m.messageId), ['m1', 'm3']);
    assert.equal(messages[0].text, 'hello there');   // whitespace collapsed
    assert.equal(messages[1].text, 'unwrap me');     // <user_query> unwrapped
    assert.equal(messages[0].marker, 'alpha');       // no host prefix: this host is local
    assert.equal(messages[0].host, 'box');
    assert.equal(messages[0].workspaceRoot, `${home}/Code/alpha`);
    assert.equal(messages[0].createdAt, '2026-09-14T10:00:00.000Z');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('export prompts falls back to protocol 1\'s state.sqlite where there is no statev2.sqlite', needsSqlite, async () => {
  const home = mkdtempSync(join(tmpdir(), 't3ctl-export-v1-'));
  mkdirSync(join(home, '.t3', 'userdata'), { recursive: true });
  mkdirSync(join(home, '.config', 't3ctl'), { recursive: true });
  writeFileSync(join(home, '.config', 't3ctl', 'hosts.json'), JSON.stringify({ hosts: [LOCAL_HOST] }));
  const db = new DatabaseSync(join(home, '.t3', 'userdata', 'state.sqlite'));
  db.exec(`
    CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE projection_threads (thread_id TEXT, project_id TEXT, deleted_at TEXT);
    CREATE TABLE projection_thread_messages (message_id TEXT, thread_id TEXT, role TEXT, text TEXT, created_at TEXT);
    INSERT INTO projection_projects VALUES ('p1', '${home}/Code/alpha', NULL);
    INSERT INTO projection_threads VALUES ('t1','p1',NULL);
    INSERT INTO projection_thread_messages VALUES
      ('m1','t1','user','from protocol 1','2026-09-14T10:00:00.000Z'),
      ('m2','t1','assistant','not a prompt','2026-09-14T11:00:00.000Z');
  `);
  db.close();
  try {
    const { messages } = await exportPrompts(home);
    assert.deepEqual(messages.map((m) => [m.messageId, m.text]), [['m1', 'from protocol 1']]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the longest matching --watch root wins', needsSqlite, async () => {
  const home = fixtureHome([LOCAL_HOST], (h) => `
    INSERT INTO projection_projects VALUES ('p1', '${h}/Code/clients/acme', NULL);
    INSERT INTO orchestration_v2_projection_threads VALUES ('t1','p1',NULL);
    INSERT INTO orchestration_v2_projection_messages VALUES ${msg('m1', 't1', 'user', 'hi', '2026-09-14T10:00:00.000Z')};
  `);
  try {
    const wide = await exportPrompts(home, ['--watch', `${home}/Code`]);
    assert.equal(wide.messages[0].marker, 'clients/acme');

    const nested = await exportPrompts(home, ['--watch', `${home}/Code`, '--watch', `${home}/Code/clients`]);
    assert.equal(nested.messages[0].marker, 'acme');

    const none = await exportPrompts(home, ['--watch', `${home}/nowhere`]);
    assert.deepEqual(none.messages, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a host off loopback goes over HTTP, and its markers carry the host name', needsSqlite, async () => {
  // The origin points at a port with no listener, so the fetch is refused —
  // that is what the test asserts. What it pins down is the *strategy choice*:
  // the host is not read from the local database, which a wrong loopback check
  // would do. A non-loopback address would also work but resolves slowly when
  // it is unroutable; a closed local port refuses in milliseconds.
  const home = fixtureHome(
    [{ name: 'remotebox', origin: await refusedRemoteOrigin(), token: 'x' }],
    (h) => `
      INSERT INTO projection_projects VALUES ('p1', '${h}/Code/alpha', NULL);
      INSERT INTO orchestration_v2_projection_threads VALUES ('t1','p1',NULL);
      INSERT INTO orchestration_v2_projection_messages VALUES ${msg('m1', 't1', 'user', 'over http', '2026-09-14T10:00:00.000Z')};
    `,
  );
  try {
    const { messages, unreachable } = await exportPrompts(home);
    // Not read from the local store despite the identical rows sitting in it.
    assert.deepEqual(messages, []);
    assert.equal(unreachable.length, 1);
    assert.equal(unreachable[0].host, 'remotebox');
    assert.match(unreachable[0].error, /fetch failed|ECONNREFUSED/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a host behind an ssh tunnel is not read from the local database, despite its loopback origin', needsSqlite, async () => {
  // The tunnel's local end: loopback, closed, so the HTTP path fails fast.
  const tunnel = (await refusedRemoteOrigin()).replace(/\/\/[^:]+:/, '//127.0.0.1:');
  const home = fixtureHome(
    [{ name: 'mac', origin: tunnel, token: 'x', ssh: 'me@mac', sshLocalPort: Number(new URL(tunnel).port), sshRemotePort: 3773 }],
    (h) => `
      INSERT INTO projection_projects VALUES ('p1', '${h}/Code/alpha', NULL);
      INSERT INTO orchestration_v2_projection_threads VALUES ('t1','p1',NULL);
      INSERT INTO orchestration_v2_projection_messages VALUES ${msg('m1', 't1', 'user', 'typed on this machine', '2026-09-14T10:00:00.000Z')};
    `,
  );
  try {
    const { messages } = await exportPrompts(home);
    assert.deepEqual(messages, [], 'this machine\'s prompts must not be filed under the remote host');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- split-brain guard ------------------------------------------------------
// Two fake servers on loopback that report the same environmentId, i.e. two T3
// Code processes sharing one ~/.t3. server-runtime.json names B, the one that
// started last; a host registered at A must refuse to write.

const ENV_ID = 'e3b97f3f-0000-4000-8000-000000000000';

/**
 * The app's WebSocket RPC, as little of it as t3ctl touches: text frames only,
 * one JSON Effect RPC message each. `answer(request)` returns the `exit` to
 * send back; Pings are swallowed. No `ws` dependency, so the RFC 6455 framing
 * is done by hand — client frames are always masked, server frames never.
 */
const acceptWebSocket = (server, rpc, answer) => server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    const head = body.length < 126 ? Buffer.from([0x81, body.length])
      : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
    socket.write(Buffer.concat([head, body]));
  };
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) { len = buf.readUInt16BE(2); at = 4; }
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const body = Buffer.from(buf.subarray(at + 4, at + 4 + len).map((b, i) => b ^ mask[i % 4]));
      buf = buf.subarray(at + 4 + len);
      if (opcode === 0x8) return socket.end();
      if (opcode !== 0x1) continue;
      const message = JSON.parse(body.toString());
      if (message._tag !== 'Request') continue;
      rpc.push({ url: req.url, tag: message.tag, payload: message.payload });
      const exit = answer(message);
      if (exit === DROP) return socket.destroy();
      send({ _tag: 'Exit', requestId: message.id, exit });
    }
  });
  socket.on('error', () => {});
});

const ok = (value) => ({ _tag: 'Success', value });
/** An answer that cuts the connection instead of replying. */
const DROP = Symbol('drop');

/** A fresh install's server settings, as far as t3ctl reads them: no default model anywhere. */
const DEFAULT_SETTINGS = { defaultModelSelection: null, providerInstances: {}, projectSettingsOverrides: {}, projectSettingsFolded: true };

/**
 * What a git project answers by default: a feature branch checked out, `main`
 * the default only on origin. A launched thread comes back already on its
 * branch, with the worktree path the server picked.
 */
const defaultRpc = (request) => {
  if (request.tag === 'server.getSettings') return ok(DEFAULT_SETTINGS);
  if (request.tag === 'vcs.listRefs') {
    return ok({ isRepo: true, hasPrimaryRemote: true, nextCursor: null, totalCount: 2, refs: [
      { name: 'feature', current: true, isDefault: false, worktreePath: '/tmp' },
      { name: 'origin/main', isRemote: true, remoteName: 'origin', current: false, isDefault: true, worktreePath: null },
    ] });
  }
  if (request.tag === 'orchestration.launchThread') {
    const { threadId, workspaceStrategy: { branch } } = request.payload;
    return ok({ threadId, resumed: false, projection: { thread: { id: threadId, branch, worktreePath: `/wt/alpha/${branch.replace(/\//g, '-')}` } } });
  }
  return ok({ sequence: 7 });
};

/**
 * A T3 Code server, as far as t3ctl touches it, speaking orchestration
 * `protocol` 1 or 2. Like the real ones, each serves only its own routes and
 * answers anything else with the web app's index page; protocol 2 also refuses
 * orchestration reads without its header, and is the only one whose descriptor
 * names a protocol. `dispatched` is the commands received, in order: at
 * POST /dispatch for protocol 1, over the socket for protocol 2.
 */
const fakeT3 = async (serverVersion, threads = [], answer = defaultRpc, protocol = 2, address = '127.0.0.1') => {
  const rpc = [];
  const projectMutations = [];
  const httpDispatched = [];
  const PROJECT = { id: 'p1', title: 'alpha', workspaceRoot: '/tmp', updatedAt: '2026-01-01' };
  const server = createHttpServer((req, res) => {
    const json = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.url === '/.well-known/t3/environment') {
      return json({ environmentId: ENV_ID, label: 'box', serverVersion, ...(protocol === 2 ? { orchestrationProtocolVersion: 2 } : {}) });
    }
    if (req.url === '/api/auth/websocket-ticket' && req.method === 'POST') {
      return json({ ticket: `ticket-for-${req.headers.authorization}`, expiresAt: '2026-01-01T00:05:00.000Z' });
    }
    if (protocol === 1) {
      if (req.url === '/api/orchestration/snapshot') return json({ projects: [PROJECT], threads });
      if (req.url === '/api/orchestration/dispatch' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { httpDispatched.push(JSON.parse(body)); json({ sequence: 1 }); });
        return;
      }
      // A thread read back after a bootstrap carries the worktree the server made.
      const detail = /^\/api\/orchestration\/threads\/([^/?]+)/.exec(req.url ?? '');
      const started = detail && rpc.find((r) => r.payload?.threadId === detail[1]);
      if (started) {
        const { branch } = started.payload.bootstrap.prepareWorktree;
        return json({ thread: { id: detail[1], branch, worktreePath: `/wt/alpha/${branch.replace(/\//g, '-')}` } });
      }
    } else if (req.url === '/api/orchestration/shell') {
      if (req.headers['x-t3-orchestration-protocol'] !== '2') { res.statusCode = 400; return res.end(); }
      return json({ schemaVersion: 1, snapshotSequence: 1, archivedThreads: [], threads, projects: [PROJECT] });
    } else if (req.url === '/api/projects/mutate' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { const m = JSON.parse(body); projectMutations.push(m); json({ id: m.projectId, title: m.title }); });
      return;
    }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html></html>');
  });
  acceptWebSocket(server, rpc, answer);
  // Anything but 127.0.0.1 is bound on every interface, so it is reachable at
  // the address the CLI treats as another machine.
  await new Promise((resolve) => server.listen(0, address === '127.0.0.1' ? address : '0.0.0.0', resolve));
  return {
    // `project` is served as it is at each request, so a test can change it.
    origin: `http://${address}:${server.address().port}`, rpc, server, projectMutations, project: PROJECT,
    get dispatched() {
      return protocol === 1 ? httpDispatched
        : rpc.filter((r) => r.tag === 'orchestration.dispatchCommand').map((r) => r.payload);
    },
    close: () => server.close(),
  };
};

const splitHome = (host, runtimeOrigin) => {
  const home = mkdtempSync(join(tmpdir(), 't3ctl-split-'));
  mkdirSync(join(home, '.t3', 'userdata'), { recursive: true });
  mkdirSync(join(home, '.config', 't3ctl'), { recursive: true });
  writeFileSync(join(home, '.config', 't3ctl', 'hosts.json'), JSON.stringify({ hosts: [host] }));
  // pid is this test process: alive for as long as the CLI runs.
  writeFileSync(join(home, '.t3', 'userdata', 'server-runtime.json'), JSON.stringify({
    version: 1, pid: process.pid, origin: runtimeOrigin, startedAt: '2026-09-24T16:14:26.068Z',
  }));
  return home;
};

const cliIn = async (home, ...args) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
};

test('writes refuse a host that is not the newest server on its data dir', async () => {
  const [a, b] = [await fakeT3('0.0.41'), await fakeT3('0.0.43')];
  const home = splitHome({ name: 'box', origin: a.origin, token: 'tok', environmentId: ENV_ID }, b.origin);
  try {
    const { code, stderr } = await cliIn(home, 'thread', 'create', 'alpha', 'hello');
    assert.notEqual(code, 0);
    assert.match(stderr, /not the only T3 Code server/);
    assert.match(stderr, new RegExp(`t3ctl host add ${b.origin} --name box`));
    assert.equal(a.dispatched.length, 0, 'nothing may reach the stale server');
    assert.equal(b.dispatched.length, 0);

    const ls = await cliIn(home, 'hosts');
    assert.equal(ls.code, 0, 'reads only warn');
    assert.match(ls.stderr, /not the only T3 Code server/);
  } finally { a.close(); b.close(); rmSync(home, { recursive: true, force: true }); }
});

test('writes go through when the host is the server named in server-runtime.json', async () => {
  const a = await fakeT3('0.0.43');
  const home = splitHome({ name: 'box', origin: a.origin, token: 'tok', environmentId: ENV_ID }, a.origin);
  try {
    const { code, stderr } = await cliIn(home, 'thread', 'create', 'alpha', 'hello');
    assert.equal(code, 0, stderr);
    assert.equal(a.dispatched[0]?.type, 'thread.create');
  } finally { a.close(); rmSync(home, { recursive: true, force: true }); }
});

test('--option sets model options, with true and false sent as booleans', async () => {
  const a = await fakeT3('0.0.43');
  const home = splitHome({ name: 'box', origin: a.origin, token: 'tok', environmentId: ENV_ID }, a.origin);
  try {
    const { code, stdout, stderr } = await cliIn(home, 'thread', 'create', 'alpha', 'hello',
      '--model', 'claudeAgent/claude-opus-5-5', '--option', 'effort=low', '--option', 'fastMode=false', '--option', 'effort=medium');
    assert.equal(code, 0, stderr);
    assert.deepEqual(a.dispatched[0]?.modelSelection, {
      instanceId: 'claudeAgent', model: 'claude-opus-5-5',
      options: [{ id: 'effort', value: 'medium' }, { id: 'fastMode', value: false }],
    });
    assert.match(stdout, /claude-opus-5-5 \(effort=medium, fastMode=false\)/);

    const bad = await cliIn(home, 'thread', 'create', 'alpha', 'hello', '--option', 'effort');
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /--option must be <id>=<value>/);
    assert.equal(a.dispatched.length, 1);
  } finally { a.close(); rmSync(home, { recursive: true, force: true }); }
});

// ---- snooze and runtime mode -----------------------------------------------
// Both are write commands against one resolvable thread, so they share a world:
// a fake server that serves that thread in its snapshot and records what it was
// sent. What is asserted is the payload shape, because that is what the real
// server validates strictly — a wrong field name fails there, not here.

const THREAD = {
  id: '11111111-1111-4111-8111-111111111111', projectId: 'p1',
  title: 'scratch', updatedAt: '2026-01-01', runtimeMode: 'full-access',
};

/** A fake server plus a HOME whose registry points at it; `dispatched` stays live. */
const world = (server, hostFields = {}) => {
  const home = splitHome({ name: 'box', origin: server.origin, token: 'tok', environmentId: ENV_ID, ...hostFields }, server.origin);
  return Object.defineProperty(
    { ...server, home, close: () => { server.close(); rmSync(home, { recursive: true, force: true }); } },
    'dispatched', { get: () => server.dispatched },
  );
};

/** A fake host serving `threads` (THREAD by default). */
const threadWorld = async (threads = [THREAD]) => world(await fakeT3('0.0.45', threads));

/** Split a recorded command into its generated id and the rest, which is fixed. */
const withoutCommandId = (command) => {
  const { commandId, ...rest } = command;
  assert.match(commandId, /^[0-9a-f-]{36}$/, 'commandId must be a generated uuid');
  return rest;
};

test('snooze sends the wake time as an ISO instant; unsnooze carries reason: user', async () => {
  const w = await threadWorld();
  // Relative to now, so the case does not start failing on a fixed calendar date.
  const wake = new Date(Date.now() + 86_400_000).toISOString();
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'thread', 'snooze', 'scratch', wake);
    assert.equal(code, 0, stderr);
    assert.deepEqual(withoutCommandId(w.dispatched[0]), {
      type: 'thread.snooze', threadId: THREAD.id, snoozedUntil: wake,
    });
    assert.match(stdout, /snoozed .*scratch/);

    const woke = await cliIn(w.home, 'thread', 'unsnooze', 'scratch');
    assert.equal(woke.code, 0, woke.stderr);
    assert.deepEqual(withoutCommandId(w.dispatched[1]), {
      type: 'thread.unsnooze', threadId: THREAD.id, reason: 'user',
    });
  } finally { w.close(); }
});

test('snooze accepts a duration and a named day, both resolved locally', async () => {
  const w = await threadWorld();
  try {
    const before = Date.now();
    assert.equal((await cliIn(w.home, 'thread', 'snooze', 'scratch', '2h')).code, 0);
    const twoHours = new Date(w.dispatched[0].snoozedUntil).getTime() - before;
    assert.ok(Math.abs(twoHours - 7_200_000) < 60_000, `2h resolved to ${twoHours}ms from now`);

    assert.equal((await cliIn(w.home, 'thread', 'snooze', 'scratch', 'tomorrow')).code, 0);
    // Named days wake at 09:00 *local*, which is the whole point of not just
    // adding 24 hours — so the assertion reads the local clock, not UTC.
    const tomorrow = new Date(w.dispatched[1].snoozedUntil);
    assert.equal(tomorrow.getHours(), 9);
    assert.equal(tomorrow.getMinutes(), 0);
    assert.equal(tomorrow.getDate(), new Date(before + 86_400_000).getDate());

    assert.equal((await cliIn(w.home, 'thread', 'snooze', 'scratch', 'next-week')).code, 0);
    const monday = new Date(w.dispatched[2].snoozedUntil);
    assert.equal(monday.getDay(), 1, 'next-week is the coming Monday');
    assert.equal(monday.getHours(), 9);
    assert.ok(monday > new Date(before), 'and it is always ahead, even when run on a Monday');
  } finally { w.close(); }
});

test('an unreadable or past wake time is rejected before anything is dispatched', async () => {
  const w = await threadWorld();
  try {
    const nonsense = await cliIn(w.home, 'thread', 'snooze', 'scratch', 'whenever');
    assert.notEqual(nonsense.code, 0);
    assert.match(nonsense.stderr, /cannot read "whenever" as a time/);

    const past = await cliIn(w.home, 'thread', 'snooze', 'scratch', new Date(Date.now() - 60_000).toISOString());
    assert.notEqual(past.code, 0);
    assert.match(past.stderr, /in the past/);

    // The future check covers the relative forms too, not just explicit times.
    const zero = await cliIn(w.home, 'thread', 'snooze', 'scratch', '0h');
    assert.notEqual(zero.code, 0);
    assert.match(zero.stderr, /in the past/);

    assert.deepEqual(w.dispatched, [], 'a rejected wake time must reach no server');
  } finally { w.close(); }
});

test('runtime-mode sets the mode of an existing thread, app names included', async () => {
  const w = await threadWorld();
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'thread', 'runtime-mode', 'scratch', 'supervised');
    assert.equal(code, 0, stderr);
    assert.deepEqual(withoutCommandId(w.dispatched[0]), {
      type: 'thread.runtime-mode.set', threadId: THREAD.id, runtimeMode: 'approval-required',
    });
    // Protocol 2 only takes commands over the socket, and only with the protocol flag.
    assert.match(w.rpc[0].url, /^\/ws\?wsTicket=ticket-for-Bearer%20tok&orchestrationProtocol=2$/);
    // The thread's old mode comes from the snapshot, so the line says what changed.
    assert.match(stdout, /full-access ->.*approval-required.*\(Supervised\)/);

    // `mode` is the shorter spelling of the same command.
    assert.equal((await cliIn(w.home, 'thread', 'mode', 'scratch', 'full')).code, 0);
    assert.equal(w.dispatched[1].runtimeMode, 'full-access');

    const bad = await cliIn(w.home, 'thread', 'mode', 'scratch', 'yolo');
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /unknown runtime mode "yolo"/);
    assert.equal(w.dispatched.length, 2, 'an unknown mode must reach no server');
  } finally { w.close(); }
});

test('the app names work wherever --runtime-mode is accepted', async () => {
  const w = await threadWorld();
  try {
    assert.equal((await cliIn(w.home, 'thread', 'create', 'alpha', 'hello', '--runtime-mode', 'supervised')).code, 0);
    assert.equal(w.dispatched[0].runtimeMode, 'approval-required');

    // message.dispatch has no mode, so send sets it first, then sends.
    assert.equal((await cliIn(w.home, 'thread', 'send', 'scratch', 'hi', '--runtime-mode', 'supervised')).code, 0);
    assert.deepEqual(w.dispatched.slice(1).map((c) => c.type), ['thread.runtime-mode.set', 'message.dispatch']);
    assert.equal(w.dispatched[1].runtimeMode, 'approval-required');

    const bad = await cliIn(w.home, 'thread', 'create', 'alpha', 'hello', '--runtime-mode', 'yolo');
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /unknown runtime mode/);
    assert.equal(w.dispatched.length, 3);
  } finally { w.close(); }
});

// ---- protocol 2 commands ------------------------------------------------------
// The commands whose shape changed when the server moved to Orchestrator V2.

const BUSY = { ...THREAD, id: '22222222-2222-4222-8222-222222222222', title: 'busy', status: 'running', activeRunId: 'run:busy:1' };

test('send dispatches a message that starts at once, or queues behind a running thread', async () => {
  const w = await threadWorld([THREAD, BUSY]);
  try {
    const idle = await cliIn(w.home, 'thread', 'send', 'scratch', 'hello', 'there');
    assert.equal(idle.code, 0, idle.stderr);
    const { messageId, ...rest } = withoutCommandId(w.dispatched[0]);
    assert.match(messageId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(rest, {
      type: 'message.dispatch', createdBy: 'user', creationSource: 'web', threadId: THREAD.id,
      text: 'hello there', attachments: [], dispatchMode: { type: 'start_immediately' },
    });
    assert.match(idle.stdout, /started .*scratch/);

    const busy = await cliIn(w.home, 'thread', 'send', 'busy', 'and then');
    assert.equal(busy.code, 0, busy.stderr);
    assert.deepEqual(w.dispatched[1].dispatchMode, { type: 'queue_after_active' });
    assert.match(busy.stdout, /queued for .*busy/);
  } finally { w.close(); }
});

test('interrupt stops the active run, and refuses a thread with nothing running', async () => {
  const w = await threadWorld([THREAD, BUSY]);
  try {
    assert.equal((await cliIn(w.home, 'thread', 'interrupt', 'busy')).code, 0);
    assert.deepEqual(withoutCommandId(w.dispatched[0]), { type: 'run.interrupt', threadId: BUSY.id, runId: BUSY.activeRunId });

    const idle = await cliIn(w.home, 'thread', 'interrupt', 'scratch');
    assert.notEqual(idle.code, 0);
    assert.match(idle.stderr, /nothing is running in scratch/);
    assert.equal(w.dispatched.length, 1);
  } finally { w.close(); }
});

test('rename sends thread.metadata.update', async () => {
  const w = await threadWorld();
  try {
    assert.equal((await cliIn(w.home, 'thread', 'rename', 'scratch', 'new', 'name')).code, 0);
    assert.deepEqual(withoutCommandId(w.dispatched[0]), { type: 'thread.metadata.update', threadId: THREAD.id, title: 'new name' });
  } finally { w.close(); }
});

test('thread create says who it is from, as protocol 2 requires', async () => {
  const w = await threadWorld();
  try {
    assert.equal((await cliIn(w.home, 'thread', 'create', 'alpha', 'hello')).code, 0);
    const { threadId, ...rest } = withoutCommandId(w.dispatched[0]);
    assert.deepEqual(rest, {
      type: 'thread.create', createdBy: 'user', creationSource: 'web', projectId: 'p1', title: 'hello',
      modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
      runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
    });
  } finally { w.close(); }
});

// Without --model a thread gets the model T3 itself would give it: the
// project's default, else the environment's, else T3's built-in default.
const settingsWorld = async (settings, protocol = 2) =>
  world(await fakeT3('0.0.45', [THREAD], (request) => request.tag === 'server.getSettings' ? ok(settings) : defaultRpc(request), protocol));

const createdModel = async (w, ...flags) => {
  const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'hello', ...flags);
  assert.equal(code, 0, stderr);
  return w.dispatched.at(-1).modelSelection;
};

test('thread create without --model uses the project\'s default model', async () => {
  const project = { instanceId: 'codex', model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: 'high' }] };
  const w = await settingsWorld({
    ...DEFAULT_SETTINGS,
    defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' },
    projectSettingsOverrides: { p1: { defaultModelSelection: project }, p2: { defaultModelSelection: { instanceId: 'x', model: 'y' } } },
  });
  try {
    assert.deepEqual(await createdModel(w), project);
    // --option adds to the default rather than replacing it.
    assert.deepEqual(await createdModel(w, '--option', 'fastMode=true'), { ...project, options: [...project.options, { id: 'fastMode', value: true }] });
    // --model still wins, and with --runtime-mode too the settings are not read at all.
    const reads = w.rpc.filter((r) => r.tag === 'server.getSettings').length;
    assert.deepEqual(await createdModel(w, '--model', 'claudeAgent/claude-opus-5-5', '--runtime-mode', 'auto'), { instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
    assert.equal(w.rpc.filter((r) => r.tag === 'server.getSettings').length, reads);
  } finally { w.close(); }
});

test('thread create without --model falls back to the environment\'s default, then T3\'s', async () => {
  const environment = { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' };
  const w = await settingsWorld({ ...DEFAULT_SETTINGS, defaultModelSelection: environment });
  try {
    assert.deepEqual(await createdModel(w), environment);
  } finally { w.close(); }

  const fresh = await threadWorld();
  try {
    assert.deepEqual(await createdModel(fresh), { instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
  } finally { fresh.close(); }
});

test('a project default on a provider the project turned off is skipped, as T3 does', async () => {
  const environment = { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' };
  const w = await settingsWorld({
    ...DEFAULT_SETTINGS,
    defaultModelSelection: environment,
    projectSettingsOverrides: { p1: { defaultModelSelection: { instanceId: 'codex', model: 'gpt-6-astra' }, providerInstances: { codex: { enabled: false } } } },
  });
  try {
    assert.deepEqual(await createdModel(w), environment);
  } finally { w.close(); }
});

test('a project default counts only on a provider instance T3 would run', async () => {
  const environment = { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' };
  const project = (instanceId) => ({ instanceId, model: 'm' });
  // [instance the project default is on, providerInstances, project's own providerInstances, picked?]
  const cases = [
    ['work', { work: { driver: 'codex', config: { enabled: false } } }, undefined, false], // legacy config flag
    ['work', { work: { driver: 'codex', enabled: true, config: { enabled: false } } }, undefined, false], // either false wins
    ['work', { work: { driver: 'codex' } }, undefined, true],
    ['cursor', { cursor: { driver: 'cursor' } }, undefined, false], // driver off by default
    ['cursor', { cursor: { driver: 'cursor', config: { enabled: true } } }, undefined, true],
    ['removed', {}, undefined, false], // no such instance any more
    ['claudeAgent', {}, undefined, true], // built-in default instance
    ['cursor', { cursor: { driver: 'cursor' } }, { cursor: { enabled: true } }, true], // the project turned it on
    ['codex', {}, { codex: { enabled: false } }, false], // the project turned it off
  ];
  for (const [instanceId, providerInstances, projectInstances, picked] of cases) {
    const w = await settingsWorld({
      ...DEFAULT_SETTINGS, defaultModelSelection: environment, providerInstances,
      projectSettingsOverrides: { p1: { defaultModelSelection: project(instanceId), providerInstances: projectInstances } },
    });
    try {
      assert.deepEqual(await createdModel(w), picked ? project(instanceId) : environment,
        `${instanceId} with ${JSON.stringify(providerInstances)} / ${JSON.stringify(projectInstances)}`);
    } finally { w.close(); }
  }
});

test('a project default cleared to null is not brought back from the project\'s own field', async () => {
  const environment = { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' };
  const w = await settingsWorld({
    ...DEFAULT_SETTINGS, projectSettingsFolded: false, defaultModelSelection: environment,
    projectSettingsOverrides: { p1: { defaultModelSelection: null } },
  });
  w.project.defaultModelSelection = { instanceId: 'codex', model: 'gpt-5.6-sol' };
  try {
    assert.deepEqual(await createdModel(w), environment);
  } finally { w.close(); }
});

test('until the server folds project settings, the project\'s own default still counts', async () => {
  const legacy = { instanceId: 'codex', model: 'gpt-5.6-sol' };
  const w = await settingsWorld({ ...DEFAULT_SETTINGS, projectSettingsFolded: false });
  w.project.defaultModelSelection = legacy;
  try {
    assert.deepEqual(await createdModel(w), legacy);
  } finally { w.close(); }

  // Once folded, the override record alone decides.
  const folded = await settingsWorld(DEFAULT_SETTINGS);
  folded.project.defaultModelSelection = legacy;
  try {
    assert.deepEqual(await createdModel(folded), { instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
  } finally { folded.close(); }
});

test('protocol 1: thread create without --model reads the settings too', async () => {
  const project = { instanceId: 'codex', model: 'gpt-6-astra' };
  const w = await settingsWorld({ ...DEFAULT_SETTINGS, projectSettingsOverrides: { p1: { defaultModelSelection: project } } }, 1);
  try {
    assert.deepEqual(await createdModel(w), project);
  } finally { w.close(); }
});

test('settings that cannot be read fall back to T3\'s default, and say so', async () => {
  const w = world(await fakeT3('0.0.45', [THREAD], (request) => request.tag === 'server.getSettings' ? {
    _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'ServerSettingsError', message: 'settings.json is unreadable' } }],
  } : defaultRpc(request)));
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'hello');
    assert.equal(code, 0, stderr);
    assert.deepEqual(w.dispatched[0].modelSelection, { instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
    assert.equal(w.dispatched[0].runtimeMode, 'full-access');
    assert.match(stderr, /could not read the new-thread defaults .*settings\.json is unreadable.*built-in claudeAgent\/claude-opus-5-5, full-access/s);
  } finally { w.close(); }
});

// Without --runtime-mode a thread gets the access T3 itself would give it, by
// the same chain: the project's setting, else the environment's, else full access.
const createdRuntimeMode = async (w, ...flags) => {
  const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'hello', ...flags);
  assert.equal(code, 0, stderr);
  return w.dispatched.at(-1).runtimeMode;
};

test('thread create without --runtime-mode takes the project\'s default access, then the environment\'s, then T3\'s', async () => {
  const cases = [
    [{ defaultRuntimeMode: 'auto-accept-edits', projectSettingsOverrides: { p1: { defaultRuntimeMode: 'approval-required' }, p2: { defaultRuntimeMode: 'auto' } } }, 'approval-required'],
    [{ defaultRuntimeMode: 'auto-accept-edits', projectSettingsOverrides: { p2: { defaultRuntimeMode: 'approval-required' } } }, 'auto-accept-edits'],
    [{ defaultRuntimeMode: 'auto' }, 'auto'],
    [{}, 'full-access'], // a server whose settings predate the field
  ];
  for (const [settings, expected] of cases) {
    const w = await settingsWorld({ ...DEFAULT_SETTINGS, ...settings });
    try {
      assert.equal(await createdRuntimeMode(w), expected, JSON.stringify(settings));
    } finally { w.close(); }
  }
});

test('--runtime-mode still wins, and with --model too the settings are not read', async () => {
  const w = await settingsWorld({ ...DEFAULT_SETTINGS, defaultRuntimeMode: 'approval-required' });
  try {
    const { stdout } = await cliIn(w.home, 'thread', 'create', 'alpha', 'hello');
    assert.match(stdout, /mode {2}approval-required \/ default/, 'the summary says which mode was picked');
    assert.equal(await createdRuntimeMode(w, '--runtime-mode', 'full'), 'full-access');
    const reads = w.rpc.filter((r) => r.tag === 'server.getSettings').length;
    assert.equal(await createdRuntimeMode(w, '--runtime-mode', 'auto', '--model', 'claudeAgent/claude-opus-5-5'), 'auto');
    assert.equal(w.rpc.filter((r) => r.tag === 'server.getSettings').length, reads);
    // --model alone still reads them, for the mode.
    assert.equal(await createdRuntimeMode(w, '--model', 'claudeAgent/claude-opus-5-5'), 'approval-required');
  } finally { w.close(); }
});

test('the interaction mode has no setting in T3: default unless --interaction-mode says otherwise', async () => {
  const w = await settingsWorld(DEFAULT_SETTINGS);
  try {
    assert.equal((await cliIn(w.home, 'thread', 'create', 'alpha', 'hello')).code, 0);
    assert.equal(w.dispatched.at(-1).interactionMode, 'default');
    assert.equal((await cliIn(w.home, 'thread', 'create', 'alpha', 'hello', '--interaction-mode', 'plan')).code, 0);
    assert.equal(w.dispatched.at(-1).interactionMode, 'plan');
  } finally { w.close(); }
});

test('protocol 1: thread create without --runtime-mode reads the settings too', async () => {
  const w = await settingsWorld({ ...DEFAULT_SETTINGS, projectSettingsOverrides: { p1: { defaultRuntimeMode: 'auto' } } }, 1);
  try {
    assert.equal(await createdRuntimeMode(w), 'auto');
  } finally { w.close(); }
});

test('thread create --json prints the new thread as one JSON object', async () => {
  const w = await threadWorld();
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'hello', 'there',
      '--model', 'codex/gpt-5.5', '--option', 'effort=high', '--json');
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), {
      id: w.dispatched[0].threadId, title: 'hello there', projectId: 'p1', project: 'alpha',
      host: 'box', model: 'codex/gpt-5.5', sequence: 7,
    });
  } finally { w.close(); }
});

test('thread send --json prints the thread, host and sequence', async () => {
  const w = await threadWorld([THREAD, BUSY]);
  try {
    for (const t of [THREAD, BUSY]) {
      const { code, stdout, stderr } = await cliIn(w.home, 'thread', 'send', t.title, 'hi', '--json');
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(stdout), { threadId: t.id, host: 'box', sequence: 7 });
    }
  } finally { w.close(); }
});

test('project create goes to the projects endpoint, not the orchestrator', async () => {
  const w = await threadWorld();
  try {
    const { code, stderr } = await cliIn(w.home, 'project', 'create', 'beta', tmpdir());
    assert.equal(code, 0, stderr);
    const [{ commandId, projectId, ...rest }] = w.projectMutations;
    assert.match(commandId, /^[0-9a-f-]{36}$/);
    assert.match(projectId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(rest, { type: 'project.create', title: 'beta', workspaceRoot: tmpdir() });
    assert.deepEqual(w.dispatched, []);
  } finally { w.close(); }
});

test('project create checks the workspace root only on a local host', async () => {
  const local = await threadWorld();
  try {
    const missing = join(tmpdir(), 't3ctl-no-such-root');
    const { code, stderr } = await cliIn(local.home, 'project', 'create', 'beta', missing);
    assert.notEqual(code, 0);
    assert.match(stderr, /workspace root does not exist/);
    assert.deepEqual(local.projectMutations, []);
  } finally { local.close(); }

  // Another machine's paths mean nothing here: its server checks them.
  const remote = world(await fakeT3('0.0.45', [THREAD], defaultRpc, 2, new URL(await refusedRemoteOrigin()).hostname));
  try {
    const { code, stderr } = await cliIn(remote.home, 'project', 'create', 'beta', '/srv/only-on-that-box/beta');
    assert.equal(code, 0, stderr);
    assert.equal(remote.projectMutations[0]?.workspaceRoot, '/srv/only-on-that-box/beta');

    // ~ and relative paths would be resolved against this machine, so they are refused.
    for (const root of ['~/Code/beta', 'beta']) {
      const bad = await cliIn(remote.home, 'project', 'create', 'beta', root);
      assert.notEqual(bad.code, 0, root);
      assert.match(bad.stderr, /absolute path on box/);
    }
    assert.equal(remote.projectMutations.length, 1);
  } finally { remote.close(); }
});

// ---- project branches ---------------------------------------------------------
// T3's branch pickers page through vcs.listRefs and merge the pages by name; the
// server has already put the current and default branch first and dropped every
// origin/<x> that has a local <x>.

const ref = (name, extra = {}) => ({ name, current: false, isDefault: false, worktreePath: null, ...extra });
const remoteRef = (name, extra = {}) => ref(name, { isRemote: true, remoteName: 'origin', ...extra });
const REF_PAGES = [
  { isRepo: true, hasPrimaryRemote: true, nextCursor: 3, totalCount: 5, refs: [
    ref('feature', { current: true, worktreePath: '/tmp' }),
    remoteRef('origin/main', { isDefault: true }),
    ref('fix/x', { worktreePath: '/wt/alpha/fix-x' }),
  ] },
  // A ref the first page already listed is not listed twice.
  { isRepo: true, hasPrimaryRemote: true, nextCursor: null, totalCount: 5, refs: [ref('fix/x', { worktreePath: '/wt/alpha/fix-x' }), remoteRef('origin/dev'), ref('old')] },
];
const branchesWorld = async (pages = REF_PAGES) => world(await fakeT3('0.0.45', [THREAD], (request) =>
  request.tag === 'vcs.listRefs' ? ok(pages[request.payload.cursor ? 1 : 0]) : defaultRpc(request)));

test('project branches --json lists every page, locals first, with the current and default branch', async () => {
  const w = await branchesWorld();
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'project', 'branches', 'alpha', '--json');
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), {
      project: { id: 'p1', title: 'alpha' },
      current: 'feature',
      default: 'origin/main',
      branches: [
        { name: 'feature', current: true, default: false, remote: false, worktreePath: '/tmp' },
        { name: 'fix/x', current: false, default: false, remote: false, worktreePath: '/wt/alpha/fix-x' },
        { name: 'old', current: false, default: false, remote: false, worktreePath: null },
        { name: 'origin/main', current: false, default: true, remote: true, worktreePath: null },
        { name: 'origin/dev', current: false, default: false, remote: true, worktreePath: null },
      ],
    });
    // T3's page size, the second page from the first one's cursor; nothing written.
    assert.deepEqual(w.rpc.map((r) => r.payload), [{ cwd: '/tmp', limit: 100 }, { cwd: '/tmp', limit: 100, cursor: 3 }]);
    assert.deepEqual(w.dispatched, []);
  } finally { w.close(); }
});

test('project branches prints one branch per line, * on the current one', async () => {
  const w = await branchesWorld();
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'project', 'branches', 'alpha');
    assert.equal(code, 0, stderr);
    assert.deepEqual(stdout.trimEnd().split('\n'), [
      '* feature      /tmp',
      '  fix/x        /wt/alpha/fix-x',
      '  old',
      '  origin/main  default  remote',
      '  origin/dev   remote',
    ]);
  } finally { w.close(); }
});

test('project branches reports a folder that is not a repository, and an unknown project, as errors', async () => {
  const w = await branchesWorld([{ isRepo: false, hasPrimaryRemote: false, nextCursor: null, totalCount: 0, refs: [] }]);
  try {
    const plain = await cliIn(w.home, 'project', 'branches', 'alpha');
    assert.notEqual(plain.code, 0);
    assert.match(plain.stderr, /alpha \(\/tmp\) is not a git repository/);
    const json = await cliIn(w.home, 'project', 'branches', 'nope', '--json');
    assert.notEqual(json.code, 0);
    assert.deepEqual(JSON.parse(json.stderr), { error: 'no project matching "nope" on box' });
    assert.equal(json.stdout, '');
  } finally { w.close(); }
});

test('ls reads thread status and provider from the shell snapshot', async () => {
  const failed = { ...THREAD, id: '33333333-3333-4333-8333-333333333333', title: 'broken', status: 'failed', providerInstanceId: 'codex' };
  const w = await threadWorld([THREAD, BUSY, failed]);
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'ls', '--json');
    assert.equal(code, 0, stderr);
    const threads = Object.fromEntries(JSON.parse(stdout).projects[0].threads.map((t) => [t.title, t]));
    assert.equal(threads.busy.status, 'running');
    assert.equal(threads.broken.status, 'error');
    assert.equal(threads.broken.provider, 'codex');
    assert.equal(threads.scratch.status, 'idle');
  } finally { w.close(); }
});

// mainframe links tasks to PRs through this field, so its shape is a contract.
test('ls --json lists each thread\'s linked pull requests', async () => {
  const link = (number, extra) => ({
    host: 'github.com', repository: 'sparklink/mainframe', number, url: `https://github.com/Sparklink/mainframe/pull/${number}`,
    source: 'agent', linkedAt: '2026-10-01T00:00:00.000Z', snapshot: null, stack: null, ...extra,
  });
  const linked = {
    ...THREAD, id: '44444444-4444-4444-8444-444444444444', title: 'linked',
    pullRequests: [
      link(5, { snapshot: { state: 'merged', title: 'x', headBranch: 'a', baseBranch: 'main', isDraft: false, updatedAt: null, syncedAt: '2026-10-01T00:00:00.000Z' } }),
      link(6),
      // A tombstone for a stack member the user unlinked; T3 hides it too.
      link(7, { source: 'stack-dismissed' }),
    ],
  };
  const w = await threadWorld([THREAD, linked]);
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'ls', '--json', '--threads');
    assert.equal(code, 0, stderr);
    const threads = Object.fromEntries(JSON.parse(stdout).projects[0].threads.map((t) => [t.title, t]));
    assert.deepEqual(threads.linked.pullRequests, [
      { url: 'https://github.com/Sparklink/mainframe/pull/5', repository: 'sparklink/mainframe', number: 5 },
      { url: 'https://github.com/Sparklink/mainframe/pull/6', repository: 'sparklink/mainframe', number: 6 },
    ]);
    assert.deepEqual(threads.scratch.pullRequests, []);
  } finally { w.close(); }
});

test('ls --json gives each thread its model and runtime mode', async () => {
  const model = { instanceId: 'codex', model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: 'high' }] };
  const w = await threadWorld([{ ...THREAD, modelSelection: model, runtimeMode: 'approval-required' }]);
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'ls', '--json');
    assert.equal(code, 0, stderr);
    const [t] = JSON.parse(stdout).projects[0].threads;
    assert.deepEqual(t.model, model);
    assert.equal(t.runtimeMode, 'approval-required');
  } finally { w.close(); }
});

// ---- models ---------------------------------------------------------------
// What a new thread can run on, per host: the models of every provider T3's
// own picker would offer, with the options each takes, and per project the
// providers it may use and the model and runtime mode T3 would start it on.

const EFFORT = {
  id: 'effort', label: 'Reasoning', type: 'select', currentValue: 'medium',
  options: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium', isDefault: true }, { id: 'high', label: 'High' }],
};
const provider = (instanceId, driver, extra = {}) => ({
  instanceId, driver, enabled: true, installed: true, version: '1', status: 'ready', auth: { status: 'authenticated' },
  checkedAt: '2026-10-01T00:00:00.000Z', slashCommands: [], skills: [], models: [], ...extra,
});
const PROVIDERS = [
  provider('claudeAgent', 'claudeAgent', {
    displayName: 'Claude', supportedRuntimeModes: ['approval-required', 'full-access'],
    models: [
      { slug: 'claude-opus-5-5', name: 'Claude Opus 5.5', isCustom: false, capabilities: { optionDescriptors: [EFFORT] } },
      { slug: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', isCustom: false, isLegacy: true, capabilities: null },
    ],
  }),
  provider('codex', 'codex', { models: [{ slug: 'gpt-6-astra', name: 'GPT-6 Astra', isCustom: false, capabilities: { optionDescriptors: [] } }] }),
  // Neither shows: one is still being checked, the other's driver is missing.
  provider('cursor', 'cursor', { status: 'warning', models: [{ slug: 'auto', name: 'Auto', isCustom: false, capabilities: null }] }),
  provider('grok', 'grok', { availability: 'unavailable', models: [{ slug: 'grok-5', name: 'Grok 5', isCustom: false, capabilities: null }] }),
];
const modelsWorld = async (settings, providers = PROVIDERS) => world(await fakeT3('0.0.45', [THREAD], (request) =>
  request.tag === 'server.getSettings' ? ok(settings)
  : request.tag === 'server.getConfig' ? ok({ providers })
  : defaultRpc(request)));

test('models --json lists what T3 would offer, with each project\'s defaults', async () => {
  const w = await modelsWorld({
    ...DEFAULT_SETTINGS,
    defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
    defaultRuntimeMode: 'auto-accept-edits',
    defaultThreadEnvMode: 'local',
    projectSettingsOverrides: { p1: { defaultModelSelection: { instanceId: 'codex', model: 'gpt-6-astra' }, defaultRuntimeMode: 'approval-required', defaultThreadEnvMode: 'worktree' } },
  });
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'models', '--json');
    assert.equal(code, 0, stderr);
    const out = JSON.parse(stdout);
    assert.deepEqual(out.unreachable, []);
    const [h] = out.hosts;
    assert.equal(h.host, 'box');
    assert.deepEqual(h.providers, [
      {
        instanceId: 'claudeAgent', driver: 'claudeAgent', name: 'Claude', runtimeModes: ['approval-required', 'full-access'],
        models: [
          { slug: 'claude-opus-5-5', name: 'Claude Opus 5.5', options: [EFFORT] },
          { slug: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', legacy: true, options: [] },
        ],
      },
      { instanceId: 'codex', driver: 'codex', name: 'Codex', models: [{ slug: 'gpt-6-astra', name: 'GPT-6 Astra', options: [] }] },
    ]);
    assert.deepEqual(h.projects, [{
      id: 'p1', title: 'alpha', providers: ['claudeAgent', 'codex'],
      model: { instanceId: 'codex', model: 'gpt-6-astra' }, runtimeMode: 'approval-required', threadEnvMode: 'worktree',
    }]);
    assert.deepEqual(h.environment, {
      providers: ['claudeAgent', 'codex'], model: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }, runtimeMode: 'auto-accept-edits',
      threadEnvMode: 'local',
    });
    // One read of each, however many projects, and no t3.json when the settings decide.
    assert.deepEqual(w.rpc.map((r) => r.tag).sort(), ['server.getConfig', 'server.getSettings']);
  } finally { w.close(); }
});

test('models --json: a project falls back to the environment, and leaves out providers it turned off', async () => {
  const w = await modelsWorld({
    ...DEFAULT_SETTINGS,
    projectSettingsOverrides: { p1: { defaultModelSelection: { instanceId: 'codex', model: 'gpt-6-astra' }, providerInstances: { codex: { enabled: false } } } },
  });
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'models', '--json');
    assert.equal(code, 0, stderr);
    const [p] = JSON.parse(stdout).hosts[0].projects;
    assert.deepEqual(p.providers, ['claudeAgent']);
    // No default anywhere: T3's own, and its default runtime mode.
    assert.deepEqual(p.model, { instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
    assert.equal(p.runtimeMode, 'full-access');
  } finally { w.close(); }
});

test('models --json reports a host it cannot read as unreachable, and still exits 0 with others', async () => {
  const w = await modelsWorld(DEFAULT_SETTINGS);
  const home = splitHome({ name: 'box', origin: w.origin, token: 'tok', environmentId: ENV_ID }, w.origin);
  writeFileSync(join(home, '.config', 't3ctl', 'hosts.json'), JSON.stringify({ hosts: [
    { name: 'box', origin: w.origin, token: 'tok', environmentId: ENV_ID },
    { name: 'gone', origin: 'http://127.0.0.1:1', token: 'tok', timeoutMs: 2000 },
  ] }));
  try {
    const { code, stdout, stderr } = await cliIn(home, 'models', '--json');
    assert.equal(code, 0, stderr);
    const out = JSON.parse(stdout);
    assert.deepEqual(out.hosts.map((h) => h.host), ['box']);
    assert.deepEqual(out.unreachable.map((u) => u.host), ['gone']);
    // --host reads just that one.
    const one = JSON.parse((await cliIn(home, 'models', '--json', '--host', 'box')).stdout);
    assert.deepEqual([one.hosts.length, one.unreachable.length], [1, 0]);
  } finally { w.close(); rmSync(home, { recursive: true, force: true }); }
});

// T3's picker (getAppModelOptionsForInstance in apps/web/src/modelSelection.ts) takes built-in
// models from the probe, custom ones from settings (the probe's lag behind an edit), then hides
// and orders them by the instance's preferences.
test('models --json lists the models T3\'s picker shows: hidden ones out, custom ones from settings, in the user\'s order', async () => {
  const claude = PROVIDERS[0];
  const providers = [{ ...claude, models: [
    ...claude.models,
    { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', isCustom: false, capabilities: { optionDescriptors: [EFFORT] } },
    // Removed in settings since the last probe: gone.
    { slug: 'old-custom', name: 'old-custom', isCustom: true, capabilities: null },
    // Still in settings: it keeps the probe's options.
    { slug: 'my-proxy', name: 'My proxy', isCustom: true, capabilities: { optionDescriptors: [EFFORT] } },
  ] }];
  const w = await modelsWorld({
    ...DEFAULT_SETTINGS,
    providerInstances: { claudeAgent: { driver: 'claudeAgent', config: { customModels: [
      { slug: ' my-proxy ', name: 'Proxy' },
      'brand-new', // added since the last probe
      'claude-opus-5-5', // a built-in's slug: not a custom model
      'brand-new',
    ] } } },
    providerModelPreferences: { claudeAgent: { hiddenModels: ['claude-haiku-4-5', 'brand-new'], modelOrder: ['claude-sonnet-5-5', 'brand-new'] } },
  }, providers);
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'models', '--json');
    assert.equal(code, 0, stderr);
    // Ordered ones first, the rest as they come; custom models can't be hidden.
    assert.deepEqual(JSON.parse(stdout).hosts[0].providers[0].models, [
      { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', options: [EFFORT] },
      { slug: 'brand-new', name: 'brand-new', options: [] },
      { slug: 'claude-opus-5-5', name: 'Claude Opus 5.5', options: [EFFORT] },
      { slug: 'my-proxy', name: 'Proxy', options: [EFFORT] },
    ]);
  } finally { w.close(); }
});

// Favourites live in the server's settings; T3's Favourites tab lists the ones still offered by
// provider in the rail's order (each driver's default instance first), then in each provider's
// model order, whatever order they were starred in.
test('models --json lists providers in T3\'s rail order and favourites as its Favourites tab orders them, and plain models stars them', async () => {
  const [claude, codex] = PROVIDERS;
  const providers = [
    { ...provider('codex-work', 'codex', { displayName: 'Codex (work)' }), models: codex.models },
    { ...claude, models: [...claude.models, { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', isCustom: false, capabilities: null }] },
    codex,
  ];
  const w = await modelsWorld({
    ...DEFAULT_SETTINGS,
    providerModelPreferences: { claudeAgent: { hiddenModels: ['claude-haiku-4-5'], modelOrder: ['claude-sonnet-5-5'] } },
    favorites: [
      { provider: 'claudeAgent', model: 'claude-opus-5-5' },
      { provider: 'codex-work', model: 'gpt-6-astra' },
      { provider: 'claudeAgent', model: 'claude-haiku-4-5' }, // hidden
      { provider: 'grok', model: 'grok-5' }, // not offered
      { provider: 'codex', model: 'gpt-6-astra' },
      { provider: 'claudeAgent', model: 'claude-sonnet-5-5' },
    ],
  }, providers);
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'models', '--json');
    assert.equal(code, 0, stderr);
    const [h] = JSON.parse(stdout).hosts;
    assert.deepEqual(h.favorites, [
      { instanceId: 'codex', model: 'gpt-6-astra' },
      { instanceId: 'codex-work', model: 'gpt-6-astra' },
      { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' },
      { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
    ]);
    // providers come in the rail's order too, and favourites aren't pulled to the top of their provider.
    assert.deepEqual(h.providers.map((p) => [p.instanceId, p.models.map((m) => m.slug)]), [
      ['codex', ['gpt-6-astra']], ['codex-work', ['gpt-6-astra']], ['claudeAgent', ['claude-sonnet-5-5', 'claude-opus-5-5']],
    ]);
    assert.deepEqual(h.environment.providers, ['codex', 'claudeAgent']);
    const plain = await cliIn(w.home, 'models');
    assert.equal(plain.code, 0, plain.stderr);
    const starred = plain.stdout.split('\n').filter((l) => l.startsWith('★ ')).map((l) => l.slice(2).split(/\s+/)[0]);
    assert.deepEqual(starred, ['codex/gpt-6-astra', 'codex-work/gpt-6-astra', 'claudeAgent/claude-sonnet-5-5', 'claudeAgent/claude-opus-5-5']);
  } finally { w.close(); }
});

// T3 orders every instance before it leaves out the ones that aren't ready: a codex instance still
// being checked keeps codex's group, and so codex-work, ahead of Claude.
test('models --json orders providers before leaving out unready ones, as T3\'s rail does', async () => {
  const [claude, codex] = PROVIDERS;
  const providers = [
    { ...codex, availability: 'unavailable' },
    claude,
    { ...provider('codex-work', 'codex'), models: codex.models },
  ];
  const w = await modelsWorld({ ...DEFAULT_SETTINGS, favorites: [
    { provider: 'claudeAgent', model: 'claude-opus-5-5' }, { provider: 'codex-work', model: 'gpt-6-astra' },
  ] }, providers);
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'models', '--json');
    assert.equal(code, 0, stderr);
    const [h] = JSON.parse(stdout).hosts;
    assert.deepEqual(h.providers.map((p) => p.instanceId), ['codex-work', 'claudeAgent']);
    assert.deepEqual(h.favorites, [{ instanceId: 'codex-work', model: 'gpt-6-astra' }, { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }]);
  } finally { w.close(); }
});

test('models --json: no favourites in the settings (null before a client migrates its own) is none', async () => {
  const w = await modelsWorld({ ...DEFAULT_SETTINGS, favorites: null });
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'models', '--json');
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).hosts[0].favorites, []);
  } finally { w.close(); }
});

test('models reads a host that has a newer server beside it, and warns, as ls does', async () => {
  const answer = (request) => request.tag === 'server.getSettings' ? ok(DEFAULT_SETTINGS)
    : request.tag === 'server.getConfig' ? ok({ providers: PROVIDERS }) : defaultRpc(request);
  const [a, b] = [await fakeT3('0.0.41', [], answer), await fakeT3('0.0.43', [], answer)];
  const home = splitHome({ name: 'box', origin: a.origin, token: 'tok', environmentId: ENV_ID }, b.origin);
  try {
    const { code, stdout, stderr } = await cliIn(home, 'models', '--json');
    assert.equal(code, 0, stderr);
    const out = JSON.parse(stdout);
    assert.deepEqual([out.hosts.map((h) => h.host), out.unreachable], [['box'], []]);
    assert.match(stderr, /not the only T3 Code server/);
    // No setting picks the workspace, so the project's t3.json is read too.
    assert.deepEqual(a.rpc.map((r) => r.tag).sort(), ['projects.readFile', 'server.getConfig', 'server.getSettings']);
  } finally { a.close(); b.close(); rmSync(home, { recursive: true, force: true }); }
});

// T3 picks a new thread's workspace (resolveProjectSettings and resolveNewThreadEnvMode in
// packages/shared/src/projectSettings.ts): project setting, environment, the repo's t3.json, local.
const envModeWorld = async (settings, { t3json, newProjectsRoot, threads = [THREAD] } = {}) => {
  const w = world(await fakeT3('0.0.45', threads, (request) =>
    request.tag === 'server.getSettings' ? ok(settings)
    : request.tag === 'server.getConfig' ? ok({ providers: PROVIDERS, ...(newProjectsRoot ? { newProjectsRoot } : {}) })
    : request.tag === 'projects.readFile'
      ? t3json === undefined ? { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'ProjectReadFileError', message: 'ENOENT' } }] }
      : ok({ relativePath: 't3.json', contents: t3json, byteLength: t3json.length, truncated: false })
    : defaultRpc(request)));
  return w;
};
const envModeOf = async (w) => {
  const { code, stdout, stderr } = await cliIn(w.home, 'models', '--json');
  assert.equal(code, 0, stderr);
  const [h] = JSON.parse(stdout).hosts;
  return [h.projects[0].threadEnvMode, h.environment.threadEnvMode];
};

test('models --json: with no setting, a project starts where its t3.json says, else local', async () => {
  const w = await envModeWorld(DEFAULT_SETTINGS, { t3json: JSON.stringify({ defaultThreadEnvMode: 'worktree' }) });
  try {
    assert.deepEqual(await envModeOf(w), ['worktree', 'local']);
    assert.deepEqual(w.rpc.find((r) => r.tag === 'projects.readFile').payload, { cwd: '/tmp', relativePath: 't3.json' });
  } finally { w.close(); }
  for (const t3json of [undefined, '{not json', JSON.stringify({ defaultThreadEnvMode: 'cloud' })]) {
    const none = await envModeWorld(DEFAULT_SETTINGS, { t3json });
    try { assert.deepEqual(await envModeOf(none), ['local', 'local'], String(t3json)); } finally { none.close(); }
  }
});

test('models --json: the environment outranks t3.json, the project outranks both', async () => {
  const t3json = JSON.stringify({ defaultThreadEnvMode: 'local' });
  const env = await envModeWorld({ ...DEFAULT_SETTINGS, defaultThreadEnvMode: 'worktree' }, { t3json });
  try {
    assert.deepEqual(await envModeOf(env), ['worktree', 'worktree']);
    assert.ok(!env.rpc.some((r) => r.tag === 'projects.readFile'));
  } finally { env.close(); }
  const project = await envModeWorld({ ...DEFAULT_SETTINGS, defaultThreadEnvMode: 'worktree', projectSettingsOverrides: { p1: { defaultThreadEnvMode: 'local' } } }, { t3json });
  try { assert.deepEqual(await envModeOf(project), ['local', 'worktree']); } finally { project.close(); }
  // Until the server folds project settings, the project's own field counts.
  const unfolded = await envModeWorld({ ...DEFAULT_SETTINGS, projectSettingsFolded: false });
  unfolded.project.defaultThreadEnvMode = 'worktree';
  try { assert.deepEqual(await envModeOf(unfolded), ['worktree', 'local']); } finally { unfolded.close(); }
});

// T3 writes a null project setting over the environment's value, and only then fills the gap
// from t3.json (resolveProjectOverrides, then applyProjectFile).
test('models --json: a project setting of null skips the environment and goes on to t3.json', async () => {
  const settings = { ...DEFAULT_SETTINGS, defaultThreadEnvMode: 'worktree', projectSettingsOverrides: { p1: { defaultThreadEnvMode: null } } };
  for (const [t3json, mode] of [[JSON.stringify({ defaultThreadEnvMode: 'local' }), 'local'], [undefined, 'local'], [JSON.stringify({ defaultThreadEnvMode: 'worktree' }), 'worktree']]) {
    const w = await envModeWorld(settings, { t3json });
    try {
      assert.deepEqual(await envModeOf(w), [mode, 'worktree'], String(t3json));
      assert.ok(w.rpc.some((r) => r.tag === 'projects.readFile'));
    } finally { w.close(); }
  }
  // Before the fold, the null in the record outranks the project's own field too.
  const unfolded = await envModeWorld({ ...settings, projectSettingsFolded: false });
  unfolded.project.defaultThreadEnvMode = 'worktree';
  try { assert.deepEqual(await envModeOf(unfolded), ['local', 'worktree']); } finally { unfolded.close(); }
});

// T3 reads t3.json as JSONC and decodes the whole file (parseT3ProjectFile), so one bad field
// discards a good defaultThreadEnvMode.
test('models --json reads t3.json as T3 does: JSONC, and nothing from a file its schema rejects', async () => {
  const cases = [
    ['{\n  // where threads start\n  "$schema": "https://t3.codes/schema/t3.json",\n  /* a, block */ "defaultThreadEnvMode": "worktree",\n}', 'worktree'],
    ['{ "defaultThreadEnvMode": "worktree", "scripts": [{ "name": "Dev", "command": "a,]", }, ], }', 'worktree'],
    [JSON.stringify({ defaultThreadEnvMode: 'worktree', somethingNewer: { x: 1 } }), 'worktree'],
    [JSON.stringify({ defaultThreadEnvMode: 'worktree', scripts: 42 }), 'local'],
    [JSON.stringify({ defaultThreadEnvMode: 'worktree', scripts: [{ name: '  ', command: 'vp dev' }] }), 'local'],
    [JSON.stringify({ defaultThreadEnvMode: 'worktree', scripts: [{ name: 'Dev', command: 'vp dev', icon: 'rocket' }] }), 'local'],
    [JSON.stringify({ defaultThreadEnvMode: 'worktree', iconPath: null }), 'local'],
    [JSON.stringify({ defaultThreadEnvMode: 'worktree', worktreeSubmodules: 'all' }), 'local'],
    ['[]', 'local'],
  ];
  for (const [t3json, mode] of cases) {
    const w = await envModeWorld(DEFAULT_SETTINGS, { t3json });
    try { assert.deepEqual(await envModeOf(w), [mode, 'local'], t3json); } finally { w.close(); }
  }
});

test('models --json: a project made from just a name starts local until it has a thread', async () => {
  const settings = { ...DEFAULT_SETTINGS, defaultThreadEnvMode: 'worktree' };
  // The fake project lives at /tmp: directly in a newProjectsRoot of /.
  const fresh = await envModeWorld(settings, { newProjectsRoot: '/', threads: [] });
  try { assert.deepEqual(await envModeOf(fresh), ['local', 'worktree']); } finally { fresh.close(); }
  const used = await envModeWorld(settings, { newProjectsRoot: '/' });
  try { assert.deepEqual(await envModeOf(used), ['worktree', 'worktree']); } finally { used.close(); }
  const elsewhere = await envModeWorld(settings, { newProjectsRoot: '/home', threads: [] });
  try { assert.deepEqual(await envModeOf(elsewhere), ['worktree', 'worktree']); } finally { elsewhere.close(); }
});

test('models without --json prints each host\'s providers, models and project defaults', async () => {
  const w = await modelsWorld(DEFAULT_SETTINGS);
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'models');
    assert.equal(code, 0, stderr);
    assert.match(stdout, /claudeAgent\/claude-opus-5-5\s+Claude Opus 5\.5\s+effort=low\|medium\|high/);
    assert.match(stdout, /alpha\s+claudeAgent\/claude-opus-5-5\s+full-access\s+local/);
    assert.doesNotMatch(stdout, /grok/);
  } finally { w.close(); }
});

// ---- thread create --new-worktree --------------------------------------------
// orchestration.launchThread creates the thread, the worktree and the first
// message in one call, so the one thing every case asserts first is that no
// separate thread.create or message.dispatch went out alongside it.

/** A fake host whose RPC answers come from `answer`, with the HOME pointing at it. */
const worktreeWorld = async (answer, hostFields = {}) => world(await fakeT3('0.0.45', [], answer), hostFields);

test('--new-worktree launches the thread in one call, with the app\'s defaults', async () => {
  const w = await worktreeWorld();
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'fix', 'the', 'flake',
      '--new-worktree', '--message', 'find out why ci flakes');
    assert.equal(code, 0, stderr);
    assert.deepEqual(w.dispatched, [], 'the launch makes the thread; nothing else may be dispatched');
    assert.match(w.rpc[0].url, /^\/ws\?wsTicket=ticket-for-Bearer%20tok&orchestrationProtocol=2$/);

    // No --model: the default comes from the server's settings.
    assert.equal(w.rpc[0].tag, 'server.getSettings');
    // No --base: the default comes from the repo, and origin/main means `main`.
    assert.deepEqual(w.rpc[1].payload, { cwd: '/tmp', limit: 20 });
    assert.equal(w.rpc[1].tag, 'vcs.listRefs');

    const { tag, payload } = w.rpc[2];
    assert.equal(tag, 'orchestration.launchThread');
    const { commandId, threadId, initialMessage, workspaceStrategy, ...rest } = payload;
    assert.match(commandId, /^[0-9a-f-]{36}$/);
    assert.match(threadId, /^[0-9a-f-]{36}$/);
    assert.equal(initialMessage.text, 'find out why ci flakes');
    assert.deepEqual(initialMessage.attachments, []);
    assert.deepEqual(rest, {
      creationSource: 'web', projectId: 'p1', title: 'fix the flake',
      modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
      runtimeMode: 'full-access', interactionMode: 'default',
    });
    assert.match(workspaceStrategy.branch, /^t3code\/[0-9a-f]{8}$/, 'a temporary branch the server renames later');
    assert.deepEqual(workspaceStrategy, { type: 'worktree', baseRef: 'main', branch: workspaceStrategy.branch, startFromOrigin: true });

    // The path is the one the server reports, not one t3ctl made up.
    assert.ok(stdout.includes(`worktree /wt/alpha/${workspaceStrategy.branch.replace('/', '-')}`), stdout);
    assert.ok(stdout.includes(threadId), stdout);
  } finally { w.close(); }
});

test('--new-worktree starts from origin or the local branch as T3\'s settings say, with their default access', async () => {
  const cases = [
    [{ newWorktreesStartFromOrigin: true, projectSettingsOverrides: { p1: { newWorktreesStartFromOrigin: false } } }, false],
    [{ newWorktreesStartFromOrigin: false, projectSettingsOverrides: { p1: { newWorktreesStartFromOrigin: true } } }, true],
    [{ newWorktreesStartFromOrigin: false }, false],
    [{}, true], // a server whose settings predate the field
  ];
  for (const [settings, startFromOrigin] of cases) {
    const w = await worktreeWorld((request) => request.tag === 'server.getSettings'
      ? ok({ ...DEFAULT_SETTINGS, defaultRuntimeMode: 'auto', ...settings }) : defaultRpc(request));
    try {
      const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'x', '--new-worktree', '--message', 'go');
      assert.equal(code, 0, stderr);
      const { workspaceStrategy, runtimeMode } = w.rpc.find((r) => r.tag === 'orchestration.launchThread').payload;
      assert.equal(workspaceStrategy.startFromOrigin, startFromOrigin, JSON.stringify(settings));
      assert.equal(runtimeMode, 'auto');
    } finally { w.close(); }
  }
});

test('--new-worktree reads the settings even with --model and --runtime-mode, for where to start from', async () => {
  const w = await worktreeWorld((request) => request.tag === 'server.getSettings'
    ? ok({ ...DEFAULT_SETTINGS, newWorktreesStartFromOrigin: false }) : defaultRpc(request));
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'x', '--new-worktree', '--message', 'go',
      '--model', 'codex/gpt-6-astra', '--runtime-mode', 'auto');
    assert.equal(code, 0, stderr);
    assert.equal(w.rpc[0].tag, 'server.getSettings');
    assert.equal(w.rpc.find((r) => r.tag === 'orchestration.launchThread').payload.workspaceStrategy.startFromOrigin, false);
  } finally { w.close(); }
});

test('--base and --branch are sent as given, and skip the default-branch lookup', async () => {
  const w = await worktreeWorld();
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'pin', 'deps',
      '--new-worktree', '--message', 'pin them', '--base', 'develop', '--branch', 'chore/pin-deps', '--runtime-mode', 'supervised');
    assert.equal(code, 0, stderr);
    assert.deepEqual(w.rpc.map((r) => r.tag), ['server.getSettings', 'orchestration.launchThread']);
    const { workspaceStrategy, runtimeMode } = w.rpc[1].payload;
    assert.equal(workspaceStrategy.baseRef, 'develop');
    assert.equal(workspaceStrategy.branch, 'chore/pin-deps');
    assert.equal(runtimeMode, 'approval-required');
  } finally { w.close(); }
});

test('--new-worktree --json has no sequence to report: the launch answers with the thread', async () => {
  const w = await worktreeWorld();
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'fix', '--new-worktree', '--message', 'go', '--json');
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), {
      id: w.rpc[2].payload.threadId, title: 'fix', projectId: 'p1', project: 'alpha',
      host: 'box', model: 'claudeAgent/claude-opus-5-5', sequence: null,
    });
  } finally { w.close(); }
});

const failWith = (error) => (request) => request.tag === 'vcs.listRefs' ? defaultRpc(request) : {
  _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'OrchestrationV2ThreadLaunchError', ...error } }],
};

test('a refused launch reports the server\'s reason', async () => {
  const error = { message: 'Project p1 has no Git repository to make a worktree in.' };
  const w = await worktreeWorld(failWith(error));
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'doomed', '--new-worktree', '--message', 'go');
    assert.notEqual(code, 0);
    assert.ok(stderr.includes(`orchestration.launchThread failed: ${error.message}`), stderr);
    assert.doesNotMatch(stderr, /carries on on the server/, 'the server answered, so nothing is left running');
  } finally { w.close(); }
});

test('a connection lost mid-dispatch says the setup may still be running', async () => {
  const w = await worktreeWorld((request) => request.tag === 'vcs.listRefs' ? defaultRpc(request) : DROP);
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'x', '--new-worktree', '--message', 'go');
    assert.notEqual(code, 0);
    assert.match(stderr, /closed before the server answered/);
    assert.match(stderr, /carries on on the server — check with: t3ctl ls -t/);
  } finally { w.close(); }
});

test('a websocket handshake that never completes times out instead of hanging', async () => {
  const w = await worktreeWorld(undefined, { timeoutMs: 500 });
  w.server.removeAllListeners('upgrade');
  w.server.on('upgrade', () => {}); // accept the request, never answer it
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'x', '--new-worktree', '--message', 'go');
    assert.notEqual(code, 0);
    assert.match(stderr, /websocket handshake got no answer in 500ms/);
  } finally { w.close(); }
});

test('a git error, which carries detail rather than message, still says what went wrong', async () => {
  const w = await worktreeWorld(() => ({
    _tag: 'Failure',
    cause: [{ _tag: 'Fail', error: { _tag: 'GitCommandError', operation: 'GitVcsDriver.listRefs', command: 'git', cwd: '/tmp', detail: 'fatal: bad object HEAD' } }],
  }));
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'x', '--new-worktree', '--message', 'go');
    assert.notEqual(code, 0);
    assert.match(stderr, /vcs\.listRefs failed: fatal: bad object HEAD/);
  } finally { w.close(); }
});

test('without --base, a repo with no known default branch asks for one', async () => {
  const w = await worktreeWorld((request) => request.tag === 'vcs.listRefs'
    ? ok({ isRepo: true, hasPrimaryRemote: false, nextCursor: null, totalCount: 1, refs: [{ name: 'trunk', current: true, isDefault: false, worktreePath: '/tmp' }] })
    : ok({ sequence: 7 }));
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'x', '--new-worktree', '--message', 'go');
    assert.notEqual(code, 0);
    assert.match(stderr, /origin\/HEAD is not set — pass --base <branch>/);
    assert.doesNotMatch(stderr, /carries on on the server/, 'nothing was dispatched, so nothing is under way');
    assert.deepEqual(w.rpc.map((r) => r.tag), ['server.getSettings', 'vcs.listRefs'], 'nothing may be launched without a base');
  } finally { w.close(); }
});

test('--new-worktree flag mistakes are caught before anything is sent', async () => {
  const w = await worktreeWorld();
  try {
    const cases = [
      [['--new-worktree'], /needs --message/],
      [['--new-worktree', '--message', '  '], /needs --message/],
      [['--message', 'hi'], /only apply with --new-worktree/],
      [['--base', 'main'], /only apply with --new-worktree/],
      [['--new-worktree', '--message', 'hi', '--worktree', '/x'], /cannot take --worktree/],
    ];
    for (const [flags, expected] of cases) {
      const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'x', ...flags);
      assert.notEqual(code, 0, `expected failure: ${flags.join(' ')}`);
      assert.match(stderr, expected);
    }
    assert.deepEqual(w.dispatched, []);
    assert.deepEqual(w.rpc, []);
  } finally { w.close(); }
});

// ---- thread scratch -----------------------------------------------------------
// A thread without a project: the server finds or makes its Scratch project
// ("No project"), and a launch at that project's root claims a fresh folder for
// the thread, as the app does. A plain thread.create would share the root.

const scratchRpc = (request, settings = DEFAULT_SETTINGS) => {
  if (request.tag === 'projects.ensureScratch') return ok({ projectId: 'scratch-1' });
  if (request.tag === 'server.getSettings') return ok(settings);
  if (request.tag === 'orchestration.launchThread') {
    const { threadId } = request.payload;
    return ok({ threadId, resumed: false, projection: { thread: { id: threadId, branch: null, worktreePath: '/home/me/.t3/scratch/look-around' } } });
  }
  return ok({ sequence: 7 });
};

test('thread scratch launches an idle thread in a folder of its own, outside any project', async () => {
  const w = world(await fakeT3('0.0.45', [], scratchRpc));
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'thread', 'scratch', 'look', 'around');
    assert.equal(code, 0, stderr);
    assert.deepEqual(w.dispatched, [], 'the launch makes the thread; nothing else may be dispatched');
    // The Scratch project first, then its default model (none set: T3's own), then the launch.
    assert.deepEqual(w.rpc.map((r) => r.tag), ['projects.ensureScratch', 'server.getSettings', 'orchestration.launchThread']);
    assert.deepEqual(w.rpc[0].payload, {});
    const { commandId, threadId, ...rest } = w.rpc[2].payload;
    assert.match(commandId, /^[0-9a-f-]{36}$/);
    assert.match(threadId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(rest, {
      creationSource: 'web', projectId: 'scratch-1', title: 'look around',
      modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
      runtimeMode: 'full-access', interactionMode: 'default', workspaceStrategy: { type: 'root' },
    });
    assert.ok(stdout.includes(threadId), stdout);
    assert.ok(stdout.includes('folder /home/me/.t3/scratch/look-around'), stdout);
  } finally { w.close(); }
});

test('thread scratch --message starts it, and --json prints it like thread create', async () => {
  const w = world(await fakeT3('0.0.45', [], scratchRpc));
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'thread', 'scratch', 'try', 'it', '--message', 'what is 2+2', '--json');
    assert.equal(code, 0, stderr);
    const { initialMessage, threadId } = w.rpc.find((r) => r.tag === 'orchestration.launchThread').payload;
    assert.equal(initialMessage.text, 'what is 2+2');
    assert.deepEqual(initialMessage.attachments, []);
    assert.deepEqual(JSON.parse(stdout), {
      id: threadId, title: 'try it', projectId: 'scratch-1', project: 'No project',
      host: 'box', model: 'claudeAgent/claude-opus-5-5', sequence: null,
    });
  } finally { w.close(); }
});

test('without --model, thread scratch takes the Scratch project\'s default model, with --option on top', async () => {
  const project = { instanceId: 'codex', model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: 'high' }] };
  const settings = { ...DEFAULT_SETTINGS, defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' },
    projectSettingsOverrides: { 'scratch-1': { defaultModelSelection: project } } };
  const w = world(await fakeT3('0.0.45', [], (request) => scratchRpc(request, settings)));
  const launched = () => w.rpc.findLast((r) => r.tag === 'orchestration.launchThread').payload.modelSelection;
  try {
    let { code, stderr } = await cliIn(w.home, 'thread', 'scratch', 'x', '--option', 'fastMode=true');
    assert.equal(code, 0, stderr);
    assert.deepEqual(launched(), { ...project, options: [...project.options, { id: 'fastMode', value: true }] });
    // --model wins, and with --runtime-mode too the settings aren't read.
    const reads = w.rpc.filter((r) => r.tag === 'server.getSettings').length;
    ({ code, stderr } = await cliIn(w.home, 'thread', 'scratch', 'y', '--model', 'claudeAgent/claude-opus-5-5', '--option', 'effort=low', '--runtime-mode', 'auto'));
    assert.equal(code, 0, stderr);
    assert.deepEqual(launched(), { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'low' }] });
    assert.equal(w.rpc.filter((r) => r.tag === 'server.getSettings').length, reads);
  } finally { w.close(); }
});

test('without --runtime-mode, thread scratch takes the Scratch project\'s default access, else the environment\'s', async () => {
  const cases = [
    [{ defaultRuntimeMode: 'auto', projectSettingsOverrides: { 'scratch-1': { defaultRuntimeMode: 'approval-required' } } }, 'approval-required'],
    [{ defaultRuntimeMode: 'auto', projectSettingsOverrides: { p1: { defaultRuntimeMode: 'approval-required' } } }, 'auto'],
  ];
  for (const [settings, expected] of cases) {
    const w = world(await fakeT3('0.0.45', [], (request) => scratchRpc(request, { ...DEFAULT_SETTINGS, ...settings })));
    try {
      const { code, stderr } = await cliIn(w.home, 'thread', 'scratch', 'x');
      assert.equal(code, 0, stderr);
      assert.equal(w.rpc.find((r) => r.tag === 'orchestration.launchThread').payload.runtimeMode, expected);
    } finally { w.close(); }
  }
});

test('thread scratch rejects a bad --runtime-mode before the server makes the Scratch project', async () => {
  const w = world(await fakeT3('0.0.45', [], scratchRpc));
  try {
    const { code } = await cliIn(w.home, 'thread', 'scratch', 'x', '--runtime-mode', 'yolo');
    assert.notEqual(code, 0);
    assert.deepEqual(w.rpc, []);
  } finally { w.close(); }
});

test('thread scratch reports a host that offers no Scratch project', async () => {
  const w = world(await fakeT3('0.0.45', [], (request) => request.tag === 'projects.ensureScratch'
    ? { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'OrchestrationDispatchCommandError', message: 'Scratch is unavailable here.' } }] }
    : scratchRpc(request)));
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'scratch', 'x');
    assert.notEqual(code, 0);
    assert.match(stderr, /Scratch is unavailable here/);
    assert.deepEqual(w.rpc.map((r) => r.tag), ['projects.ensureScratch']);
  } finally { w.close(); }
});

// ---- protocol 1 servers -------------------------------------------------------
// A server whose descriptor names no protocol is from before Orchestrator V2.
// t3ctl must still drive it exactly as before: reads from /snapshot, commands
// to POST /dispatch in protocol 1's shapes, and the socket only for a worktree
// bootstrap. These pin those shapes, so a protocol 2 change cannot leak in.

const v1World = async (threads = [THREAD], answer = defaultRpc) => world(await fakeT3('0.0.43', threads, answer, 1));

test('protocol 1: thread scratch says the server is too old, and sends nothing', async () => {
  const w = await v1World();
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'scratch', 'x');
    assert.notEqual(code, 0);
    assert.match(stderr, /too old for threads without a project/);
    assert.deepEqual(w.rpc, []);
    assert.deepEqual(w.dispatched, []);
  } finally { w.close(); }
});

/** Split off the fields every protocol 1 command stamps: a uuid commandId and an ISO createdAt. */
const v1Command = (command) => {
  const { createdAt, ...rest } = withoutCommandId(command);
  assert.equal(createdAt, new Date(createdAt).toISOString(), 'createdAt must be an ISO instant');
  return rest;
};

test('protocol 1: an undeclared protocol means /snapshot and /dispatch, never the socket', async () => {
  const w = await v1World();
  try {
    const ls = await cliIn(w.home, 'ls', '--json');
    assert.equal(ls.code, 0, ls.stderr);
    assert.equal(JSON.parse(ls.stdout).projects[0].threads[0].title, 'scratch');

    const { code, stderr } = await cliIn(w.home, 'thread', 'runtime-mode', 'scratch', 'auto');
    assert.equal(code, 0, stderr);
    assert.deepEqual(v1Command(w.dispatched[0]), { type: 'thread.runtime-mode.set', threadId: THREAD.id, runtimeMode: 'auto' });
    assert.deepEqual(w.rpc, [], 'protocol 1 takes plain commands over HTTP');
  } finally { w.close(); }
});

test('protocol 1: send, interrupt and rename keep their protocol 1 commands', async () => {
  const w = await v1World();
  try {
    assert.equal((await cliIn(w.home, 'thread', 'send', 'scratch', 'hi', '--runtime-mode', 'supervised')).code, 0);
    const { message, ...turn } = v1Command(w.dispatched[0]);
    assert.deepEqual(turn, { type: 'thread.turn.start', threadId: THREAD.id, runtimeMode: 'approval-required', interactionMode: 'default' });
    assert.equal(message.role, 'user');
    assert.equal(message.text, 'hi');

    // No active run needed: protocol 1 interrupts the thread, not a run.
    assert.equal((await cliIn(w.home, 'thread', 'interrupt', 'scratch')).code, 0);
    assert.deepEqual(withoutCommandId(w.dispatched[1]), { type: 'thread.turn.interrupt', threadId: THREAD.id });

    assert.equal((await cliIn(w.home, 'thread', 'rename', 'scratch', 'renamed')).code, 0);
    assert.deepEqual(withoutCommandId(w.dispatched[2]), { type: 'thread.meta.update', threadId: THREAD.id, title: 'renamed' });
  } finally { w.close(); }
});

test('protocol 1: thread and project create carry createdAt, and go to /dispatch', async () => {
  const w = await v1World();
  try {
    assert.equal((await cliIn(w.home, 'thread', 'create', 'alpha', 'hello')).code, 0);
    const { threadId, ...thread } = v1Command(w.dispatched[0]);
    assert.deepEqual(thread, {
      type: 'thread.create', projectId: 'p1', title: 'hello',
      modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
      runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
    });

    assert.equal((await cliIn(w.home, 'project', 'create', 'beta', tmpdir())).code, 0);
    const { projectId, ...project } = v1Command(w.dispatched[1]);
    assert.deepEqual(project, { type: 'project.create', title: 'beta', workspaceRoot: tmpdir() });
  } finally { w.close(); }
});

test('protocol 1: create and send --json report the sequence /dispatch answered with', async () => {
  const w = await v1World();
  try {
    const created = await cliIn(w.home, 'thread', 'create', 'alpha', 'hello', '--json');
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(JSON.parse(created.stdout), {
      id: w.dispatched[0].threadId, title: 'hello', projectId: 'p1', project: 'alpha',
      host: 'box', model: 'claudeAgent/claude-opus-5-5', sequence: 1,
    });

    const sent = await cliIn(w.home, 'thread', 'send', 'scratch', 'hi', '--json');
    assert.equal(sent.code, 0, sent.stderr);
    assert.deepEqual(JSON.parse(sent.stdout), { threadId: THREAD.id, host: 'box', sequence: 1 });
  } finally { w.close(); }
});

test('protocol 1: ls reads status and provider from the session', async () => {
  const running = { ...THREAD, id: '44444444-4444-4444-8444-444444444444', title: 'busy', session: { status: 'running', providerName: 'codex', activeTurnId: 't1' } };
  const w = await v1World([THREAD, running]);
  try {
    const threads = Object.fromEntries(JSON.parse((await cliIn(w.home, 'ls', '--json')).stdout).projects[0].threads.map((t) => [t.title, t]));
    assert.equal(threads.busy.status, 'running');
    assert.equal(threads.busy.provider, 'codex');
    assert.equal(threads.scratch.status, 'idle');
    // Protocol 1 has no pull request links; the field is still there, empty.
    assert.deepEqual(threads.scratch.pullRequests, []);
  } finally { w.close(); }
});

test('protocol 1: --new-worktree sends one bootstrapped turn start over the websocket', async () => {
  const w = await v1World([]);
  try {
    const { code, stdout, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'fix', 'the', 'flake',
      '--new-worktree', '--message', 'find out why ci flakes');
    assert.equal(code, 0, stderr);
    assert.deepEqual(w.dispatched, [], 'a bootstrap over HTTP is silently ignored, so nothing may go there');
    assert.match(w.rpc[0].url, /^\/ws\?wsTicket=ticket-for-Bearer%20tok$/, 'no protocol 2 flag on a protocol 1 socket');
    assert.deepEqual(w.rpc.map((r) => r.tag), ['server.getSettings', 'vcs.listRefs', 'orchestration.dispatchCommand']);

    const { type, message, bootstrap, createdAt, modelSelection, runtimeMode, interactionMode } = w.rpc[2].payload;
    assert.equal(type, 'thread.turn.start');
    assert.equal(message.text, 'find out why ci flakes');
    assert.match(bootstrap.prepareWorktree.branch, /^t3code\/[0-9a-f]{8}$/);
    assert.deepEqual(bootstrap, {
      createThread: {
        projectId: 'p1', title: 'fix the flake', modelSelection, runtimeMode, interactionMode,
        branch: 'main', worktreePath: null, createdAt,
      },
      prepareWorktree: {
        projectCwd: '/tmp', baseBranch: 'main', branch: bootstrap.prepareWorktree.branch,
        startFromOrigin: true, requireWorktree: true,
      },
      runSetupScript: true,
    });
    // The path is the one the server reports, read back from the thread.
    assert.ok(stdout.includes(`worktree /wt/alpha/${bootstrap.prepareWorktree.branch.replace('/', '-')}`), stdout);
  } finally { w.close(); }
});

test('protocol 1: --new-worktree starts locally when the project says so', async () => {
  const w = await v1World([], (request) => request.tag === 'server.getSettings'
    ? ok({ ...DEFAULT_SETTINGS, projectSettingsOverrides: { p1: { newWorktreesStartFromOrigin: false, defaultRuntimeMode: 'auto' } } }) : defaultRpc(request));
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'x', '--new-worktree', '--message', 'go');
    assert.equal(code, 0, stderr);
    const { bootstrap, runtimeMode } = w.rpc.find((r) => r.tag === 'orchestration.dispatchCommand').payload;
    assert.equal(bootstrap.prepareWorktree.startFromOrigin, false);
    assert.equal(runtimeMode, 'auto');
  } finally { w.close(); }
});

test('protocol 1: a failed bootstrap reports what became of the thread', async () => {
  const cases = [
    [{ message: 'A separate worktree requires a Git repository and a base branch with a commit.', bootstrapThreadDisposition: 'not-created' }, /no thread was created/],
    [{ message: 'Git command failed in GitVcsDriver.createWorktree: disk full', bootstrapThreadDisposition: 'deleted' }, /the server deleted the thread it had created/],
  ];
  for (const [error, outcome] of cases) {
    const w = await v1World([], (request) => request.tag === 'vcs.listRefs' ? defaultRpc(request) : {
      _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'OrchestrationDispatchCommandError', ...error } }],
    });
    try {
      const { code, stderr } = await cliIn(w.home, 'thread', 'create', 'alpha', 'doomed', '--new-worktree', '--message', 'go');
      assert.notEqual(code, 0);
      assert.ok(stderr.includes(error.message), stderr);
      assert.match(stderr, outcome);
    } finally { w.close(); }
  }
});

test('a protocol newer than t3ctl knows is refused before anything is sent', async () => {
  const w = await threadWorld();
  w.server.removeAllListeners('request');
  w.server.on('request', (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ environmentId: ENV_ID, label: 'box', serverVersion: '0.1.0', orchestrationProtocolVersion: 3 }));
  });
  try {
    const { code, stderr } = await cliIn(w.home, 'thread', 'runtime-mode', 'scratch', 'auto');
    assert.notEqual(code, 0);
    assert.match(stderr, /speaks orchestration protocol 3, which this t3ctl does not know/);
    assert.deepEqual(w.rpc, []);
  } finally { w.close(); }
});

test('host add --name re-points a host to another port and keeps its token', async () => {
  const [a, b] = [await fakeT3('0.0.41'), await fakeT3('0.0.43')];
  const home = splitHome({ name: 'box', origin: a.origin, token: 'tok', environmentId: ENV_ID }, b.origin);
  try {
    const { code, stderr } = await cliIn(home, 'host', 'add', b.origin, '--name', 'box');
    assert.equal(code, 0, stderr);
    const { hosts } = JSON.parse(readFileSync(join(home, '.config', 't3ctl', 'hosts.json'), 'utf8'));
    assert.deepEqual(hosts.map((h) => [h.name, h.origin, h.token]), [['box', b.origin, 'tok']]);
  } finally { a.close(); b.close(); rmSync(home, { recursive: true, force: true }); }
});

test('a host whose server restarted on another port is reported as moved, not split', async () => {
  const b = await fakeT3('0.0.43');
  const dead = await refusedRemoteOrigin().then((o) => o.replace(/\/\/[^:]+:/, '//127.0.0.1:'));
  const home = splitHome({ name: 'box', origin: dead, token: 'tok', environmentId: ENV_ID }, b.origin);
  try {
    const { stderr } = await cliIn(home, 'hosts');
    assert.match(stderr, /is not answering; its T3 Code server now runs at/);
    assert.doesNotMatch(stderr, /not the only/);
    assert.match(stderr, new RegExp(`t3ctl host add ${b.origin} --name box`));
  } finally { b.close(); rmSync(home, { recursive: true, force: true }); }
});

// ---- ssh host on a desktop app ---------------------------------------------
// A fake desktop app (an executable with an app.asar where Electron keeps it)
// runs a fake server; a fake ssh runs the remote script locally. The token must
// come from the app's own server bundle, never from npx.

const fakeDesktopHost = async () => {
  const root = mkdtempSync(join(tmpdir(), 't3ctl-desktop-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.t3', 'userdata'), { recursive: true });

  // the app's path has spaces, as on macOS; its executable is a copy of node, so
  // the server process's executable really is inside the app
  const app = join(root, 'T3 Code.app', 'Contents');
  const exeDir = join(app, process.platform === 'darwin' ? 'MacOS' : 'bin');
  const asar = process.platform === 'darwin' ? join(app, 'Resources', 'app.asar') : join(exeDir, 'resources', 'app.asar');
  const exe = join(exeDir, 'T3 Code');
  const bin = join(asar, 'apps', 'server', 'dist', 'bin.mjs');
  // On Linux the asar sits inside exeDir, so this one mkdir makes both; on
  // macOS the executable lives in Contents/MacOS, a sibling of Resources.
  mkdirSync(dirname(bin), { recursive: true });
  mkdirSync(exeDir, { recursive: true });
  copyFileSync(process.execPath, exe);
  chmodSync(exe, 0o755);
  writeFileSync(bin, `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const [cmd] = process.argv.slice(2);
if (cmd === 'auth') {
  writeFileSync(${JSON.stringify(join(root, 'auth-call.json'))}, JSON.stringify({ argv: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE }));
  console.log('{\\n  "token": "desktop-token",\\n  "sessionId": "s1"\\n}');
} else {
  const server = createServer((req, res) => {
    if (req.url !== '/.well-known/t3/environment') { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ environmentId: '${ENV_ID}', label: 'mac', serverVersion: '0.0.45' }));
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    writeFileSync(${JSON.stringify(join(home, '.t3', 'userdata', 'server-runtime.json'))},
      JSON.stringify({ version: 1, pid: process.pid, port, origin: 'http://127.0.0.1:' + port }));
  });
}
`);

  // ssh: run `sh -s -- …` locally from one joined string, as real ssh hands it
  // to the remote shell; -fN forwards a port; -O is a no-op
  const fakeBin = join(root, 'fakebin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'ssh'), `#!${process.execPath}
const { spawn, spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('-O')) process.exit(0);
if (args.includes('-fN')) {
  const [local, , remote] = args[args.indexOf('-L') + 1].split(':');
  const forward = "require('node:net').createServer((c) => { const r = require('node:net').connect(" + remote + ", '127.0.0.1'); c.pipe(r).pipe(c); c.on('error', () => {}); r.on('error', () => {}); }).listen(" + local + ", '127.0.0.1')";
  const child = spawn(process.execPath, ['-e', forward], { detached: true, stdio: 'ignore' });
  require('node:fs').appendFileSync(${JSON.stringify(join(root, 'pids'))}, child.pid + '\\n');
  child.unref();
  setTimeout(() => process.exit(0), 300);
} else {
  const i = args.indexOf('sh');
  process.exit(spawnSync('sh', ['-c', args.slice(i).join(' ')], { stdio: 'inherit', env: { ...process.env, HOME: ${JSON.stringify(home)} } }).status ?? 1);
}
`);
  chmodSync(join(fakeBin, 'ssh'), 0o755);

  const server = spawn(exe, [bin, 'serve'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
  const runtime = join(home, '.t3', 'userdata', 'server-runtime.json');
  for (let i = 0; i < 100 && !existsSync(runtime); i++) await new Promise((r) => setTimeout(r, 50));

  return {
    root, home, exe, bin, fakeBin,
    close: () => {
      server.kill();
      const pids = existsSync(join(root, 'pids')) ? readFileSync(join(root, 'pids'), 'utf8').split('\n').filter(Boolean) : [];
      for (const pid of pids) { try { process.kill(Number(pid)); } catch { /* already gone */ } }
      rmSync(root, { recursive: true, force: true });
    },
  };
};

test('host add over ssh mints the token with a desktop app\'s own server bundle', async () => {
  const host = await fakeDesktopHost();
  try {
    const { code, stdout, stderr } = await run(process.execPath, [CLI, 'host', 'add', 'g@mac', '--name', 'mac', '--t3-version', '0.0.0'], {
      env: { ...process.env, HOME: host.home, PATH: `${host.fakeBin}:${process.env.PATH}` },
    }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
    assert.equal(code, 0, stderr);

    const call = JSON.parse(readFileSync(join(host.root, 'auth-call.json'), 'utf8'));
    assert.deepEqual(call, { argv: ['auth', 'session', 'issue', '--json', '--label', 't3ctl:mac', '--ttl', '30d'], electron: '1' });
    const { hosts } = JSON.parse(readFileSync(join(host.home, '.config', 't3ctl', 'hosts.json'), 'utf8'));
    assert.deepEqual(hosts.map((h) => [h.name, h.ssh, h.token]), [['mac', 'g@mac', 'desktop-token']]);
    assert.ok(stdout.includes(`ELECTRON_RUN_AS_NODE=1 '${host.exe}' '${host.bin}' auth session revoke s1`), stdout);
  } finally { host.close(); }
});

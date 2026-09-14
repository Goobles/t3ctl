// Integration tests: they run the built CLI as a subprocess, because what we
// care about is the contract a user gets — output, exit codes, help — not the
// internals. Run with `npm test` (which builds first).
//
// Deliberately no network: every case here must work with no hosts registered
// and nothing listening, so it is safe on a CI runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

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
  for (const c of ['ls', 'host', 'hosts', 'project', 'thread', 'export']) {
    assert.match(stdout, new RegExp(`^\\s+${c}\\b`, 'm'), `missing command: ${c}`);
  }
});

test('every command has its own help', async () => {
  const commands = [
    ['ls'], ['host', 'add'], ['host', 'rm'], ['hosts'],
    ['project', 'create'],
    ['thread', 'create'], ['thread', 'send'], ['thread', 'rename'],
    ['thread', 'retitle'], ['thread', 'interrupt'],
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

test('bad input exits non-zero', async () => {
  const cases = [
    ['thread', 'send'],
    ['thread', 'rename'],
    ['thread', 'retitle'],
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
// state.sqlite plus a host registry, which between them decide which strategy
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

const SCHEMA = `
  CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT);
  CREATE TABLE projection_threads (thread_id TEXT, project_id TEXT, deleted_at TEXT);
  CREATE TABLE projection_thread_messages (message_id TEXT, thread_id TEXT, role TEXT, text TEXT, created_at TEXT);
`;

/** A HOME with a host registry and a seeded state database. Returns its path. */
const fixtureHome = (hosts, seed) => {
  const home = mkdtempSync(join(tmpdir(), 't3ctl-export-'));
  mkdirSync(join(home, '.t3', 'userdata'), { recursive: true });
  mkdirSync(join(home, '.config', 't3ctl'), { recursive: true });
  writeFileSync(join(home, '.config', 't3ctl', 'hosts.json'), JSON.stringify({ hosts }));
  const db = new DatabaseSync(join(home, '.t3', 'userdata', 'state.sqlite'));
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
    INSERT INTO projection_threads VALUES
      ('t1','p1',NULL), ('t2','p2',NULL), ('t3','p3',NULL), ('t4','p1','2026-01-01T00:00:00.000Z');
    INSERT INTO projection_thread_messages VALUES
      ('m1','t1','user','  hello   there  ','2026-09-14T10:00:00.000Z'),
      ('m2','t1','assistant','not a prompt','2026-09-14T11:00:00.000Z'),
      ('m3','t1','user','<user_query>
unwrap me
</user_query>','2026-09-14T12:00:00.000Z'),
      ('m4','t2','user','outside the watched root','2026-09-14T13:00:00.000Z'),
      ('m5','t3','user','project is deleted','2026-09-14T13:00:00.000Z'),
      ('m6','t4','user','thread is deleted','2026-09-14T13:00:00.000Z'),
      ('m7','t1','user','the day before','2026-09-13T23:59:59.999Z'),
      ('m8','t1','user','the day after','2026-09-15T00:00:00.000Z');
  `);
  try {
    const { messages, unreachable } = await exportPrompts(home);
    assert.deepEqual(unreachable, []);
    // m2 is not a prompt, m4 is outside ~/Code, m5 and m6 hang off deleted rows,
    // m7 and m8 fall outside the half-open window. That leaves m1 and m3.
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

test('the longest matching --watch root wins', needsSqlite, async () => {
  const home = fixtureHome([LOCAL_HOST], (h) => `
    INSERT INTO projection_projects VALUES ('p1', '${h}/Code/clients/acme', NULL);
    INSERT INTO projection_threads VALUES ('t1','p1',NULL);
    INSERT INTO projection_thread_messages VALUES ('m1','t1','user','hi','2026-09-14T10:00:00.000Z');
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
      INSERT INTO projection_threads VALUES ('t1','p1',NULL);
      INSERT INTO projection_thread_messages VALUES ('m1','t1','user','over http','2026-09-14T10:00:00.000Z');
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

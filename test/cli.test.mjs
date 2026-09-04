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
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  for (const c of ['ls', 'host', 'hosts', 'project', 'thread']) {
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

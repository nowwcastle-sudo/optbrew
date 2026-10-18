import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { tempDir } from './support/temp-dir.mjs';
import { keyHome, readGoogleKey } from '../skills/optbrew/scripts/core/keys.mjs';
import { runKeyCommand } from '../skills/optbrew/scripts/key.mjs';
import { main } from '../lib/cli.mjs';

// The fake key is assembled from fragments so no key-shaped literal exists in this repository.
const KEY = ['AIza', 'Sy', 'Fake', 'Test', 'Value', '0123456789', 'abcdefghij', 'KLMNO'].join('');
const OTHER = ['other', '-', 'fake', '-', 'value'].join('');
const sha8 = value => createHash('sha256').update(value).digest('hex').slice(0, 8);

const sink = () => { const chunks = []; return { write: chunk => { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') }; };
const pipeStdin = text => { const stream = new PassThrough(); stream.end(text); return stream; };

/** A terminal: isTTY, raw mode toggle, and data pushed by the test. */
function fakeTerminal() {
  const terminal = new EventEmitter();
  Object.assign(terminal, { isTTY: true, raw: [], setRawMode(on) { this.raw.push(on); }, setEncoding() {}, pause() {}, resume() {} });
  return terminal;
}

async function run(argv, { stdin = pipeStdin(''), env = {}, home }) {
  const stdout = sink(); const stderr = sink();
  const code = await runKeyCommand(argv, { stdin, stdout, stderr, env, home });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const writeKeyFile = async (home, content) => {
  await mkdir(path.join(home, '.optbrew'), { recursive: true });
  await writeFile(path.join(home, '.optbrew', 'credentials.json'), content);
};

test('empty env key and corrupt key file are treated as missing', async () => {
  const home = await tempDir('optbrew-keys-');
  assert.equal(readGoogleKey({ env: {}, home }), null);
  for (const empty of ['', '   ', '\t\n']) assert.equal(readGoogleKey({ env: { OPTBREW_GOOGLE_API_KEY: empty }, home }), null);
  for (const corrupt of ['{not json', '', '[]', 'null', '{"google": 5}', '{"google": "  "}', '{"google": null}']) {
    await writeKeyFile(home, corrupt);
    assert.equal(readGoogleKey({ env: { OPTBREW_GOOGLE_API_KEY: '' }, home }), null, corrupt);
    const status = await run(['status'], { home, env: { OPTBREW_GOOGLE_API_KEY: '' } });
    assert.equal(status.code, 0);
    // A file that is not a JSON object is reported as corrupt (and still read as "no key"); a valid object without a key is not.
    const broken = ['{not json', '', '[]', 'null'].includes(corrupt);
    assert.deepEqual(JSON.parse(status.stdout), { google: { present: false, sha256_8: null, ...(broken ? { corrupt: true } : {}) } }, corrupt);
    assert.equal(await readFile(path.join(home, '.optbrew', 'credentials.json'), 'utf8'), corrupt, 'status never changes the file');
  }
});

test('the environment key wins over the file and is trimmed; an empty variable falls back to the file', async () => {
  const home = await tempDir('optbrew-keys-');
  await writeKeyFile(home, JSON.stringify({ google: OTHER }));
  assert.equal(readGoogleKey({ env: { OPTBREW_GOOGLE_API_KEY: `  ${KEY}\n` }, home }), KEY);
  assert.equal(readGoogleKey({ env: { OPTBREW_GOOGLE_API_KEY: '' }, home }), OTHER);
  assert.equal(readGoogleKey({ env: {}, home }), OTHER);
});

test('status prints only presence and an 8-char hash', async () => {
  const home = await tempDir('optbrew-keys-');
  const result = await run(['status'], { home, env: { OPTBREW_GOOGLE_API_KEY: KEY } });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { google: { present: true, sha256_8: sha8(KEY) } });
  assert.match(JSON.parse(result.stdout).google.sha256_8, /^[0-9a-f]{8}$/);
  assert.equal(result.stdout.includes(KEY), false);
  assert.equal(result.stderr, '');
  const absent = await run(['status'], { home, env: {} });
  assert.deepEqual(JSON.parse(absent.stdout), { google: { present: false, sha256_8: null } });
});

test('set never echoes the key: a piped line is stored and stays out of stdout and stderr', async () => {
  const home = await tempDir('optbrew-keys-');
  const result = await run(['set', 'google'], { home, stdin: pipeStdin(`${KEY}\r\nsecond line ignored\n`) });
  assert.equal(result.code, 0);
  assert.equal((result.stdout + result.stderr).includes(KEY), false);
  assert.equal(readGoogleKey({ env: {}, home }), KEY);
  const files = await readdir(path.join(home, '.optbrew'));
  assert.deepEqual(files, ['credentials.json']);
  const stored = JSON.parse(await readFile(path.join(home, '.optbrew', 'credentials.json'), 'utf8'));
  assert.deepEqual(stored, { google: KEY });
});

test('set reads a final line without a newline', async () => {
  const home = await tempDir('optbrew-keys-');
  assert.equal((await run(['set', 'google'], { home, stdin: pipeStdin(KEY) })).code, 0);
  assert.equal(readGoogleKey({ env: {}, home }), KEY);
});

test('set on a terminal reads in raw mode and never echoes the typed key', async () => {
  const home = await tempDir('optbrew-keys-');
  const terminal = fakeTerminal();
  const pending = run(['set', 'google'], { home, stdin: terminal });
  await new Promise(resolve => setImmediate(resolve));
  terminal.emit('data', `${KEY}X`);
  terminal.emit('data', '\u007f\r');
  const result = await pending;
  assert.equal(result.code, 0);
  assert.deepEqual(terminal.raw, [true, false]);
  assert.equal((result.stdout + result.stderr).includes(KEY), false);
  assert.equal(readGoogleKey({ env: {}, home }), KEY);
});

test('cancelling hidden input saves nothing and restores the terminal', async () => {
  const home = await tempDir('optbrew-keys-');
  const terminal = fakeTerminal();
  const pending = run(['set', 'google'], { home, stdin: terminal });
  await new Promise(resolve => setImmediate(resolve));
  terminal.emit('data', `${KEY}\u0003`);
  const result = await pending;
  assert.equal(result.code, 1);
  assert.deepEqual(terminal.raw, [true, false]);
  assert.equal(readGoogleKey({ env: {}, home }), null);
  assert.equal((result.stdout + result.stderr).includes(KEY), false);
});

test('an empty line saves nothing', async () => {
  const home = await tempDir('optbrew-keys-');
  const result = await run(['set', 'google'], { home, stdin: pipeStdin('   \n') });
  assert.equal(result.code, 2);
  await assert.rejects(stat(path.join(home, '.optbrew', 'credentials.json')), { code: 'ENOENT' });
});

test('set and remove refuse a corrupt key file and leave its bytes alone', async () => {
  const home = await tempDir('optbrew-keys-');
  const file = path.join(home, '.optbrew', 'credentials.json');
  const typo = `{"other": "${OTHER}", "google": "${KEY}",}`;
  for (const content of ['{broken', '', '[]', 'null', '"text"', typo]) {
    await writeKeyFile(home, content);
    for (const argv of [['set', 'google'], ['remove', 'google']]) {
      const result = await run(argv, { home, stdin: pipeStdin(`${KEY}\n`) });
      assert.equal(result.code, 1, `${argv[0]} on ${JSON.stringify(content)}`);
      assert.ok(result.stderr.includes(file), result.stderr);
      assert.match(result.stderr, /not a valid JSON object/);
      for (const secret of [KEY, OTHER]) assert.equal((result.stdout + result.stderr).includes(secret), false);
      assert.equal(await readFile(file, 'utf8'), content);
      assert.deepEqual(await readdir(path.dirname(file)), ['credentials.json']);
    }
    assert.equal(readGoogleKey({ env: {}, home }), null, content);
  }
});

test('set and remove refuse a key file that cannot be read as a file', async () => {
  const home = await tempDir('optbrew-keys-');
  await mkdir(path.join(home, '.optbrew', 'credentials.json'), { recursive: true });
  for (const argv of [['set', 'google'], ['remove', 'google']]) {
    assert.equal((await run(argv, { home, stdin: pipeStdin(`${KEY}\n`) })).code, 1, argv[0]);
    assert.ok((await stat(path.join(home, '.optbrew', 'credentials.json'))).isDirectory());
  }
});

test('the key file is owner-only on POSIX', { skip: process.platform === 'win32' && 'Windows has no POSIX modes' }, async () => {
  const home = await tempDir('optbrew-keys-');
  await run(['set', 'google'], { home, stdin: pipeStdin(`${KEY}\n`) });
  assert.equal((await stat(path.join(home, '.optbrew', 'credentials.json'))).mode & 0o777, 0o600);
});

test('the key file is created under home only', async () => {
  const root = await tempDir('optbrew-keys-');
  const home = path.join(root, 'home');
  const site = path.join(root, 'site');
  await mkdir(site, { recursive: true });
  await run(['set', 'google'], { home, stdin: pipeStdin(`${KEY}\n`) });
  assert.deepEqual(await readdir(site), []);
  assert.deepEqual((await readdir(root)).sort(), ['home', 'site']);
  assert.deepEqual(await readdir(home), ['.optbrew']);
});

test('remove deletes the file, tolerates a missing one, and names a still-set variable without its value', async () => {
  const home = await tempDir('optbrew-keys-');
  await run(['set', 'google'], { home, stdin: pipeStdin(`${KEY}\n`) });
  const removed = await run(['remove', 'google'], { home });
  assert.equal(removed.code, 0);
  assert.match(removed.stdout, /google key removed/);
  assert.equal(readGoogleKey({ env: {}, home }), null);
  const nothing = await run(['remove', 'google'], { home });
  assert.equal(nothing.code, 0);
  assert.match(nothing.stdout, /nothing to remove/);
  const stillSet = await run(['remove', 'google'], { home, env: { OPTBREW_GOOGLE_API_KEY: KEY } });
  assert.equal(stillSet.code, 0);
  assert.match(stillSet.stderr, /still set outside the key file: OPTBREW_GOOGLE_API_KEY or the Claude plugin setting/);
  assert.equal((stillSet.stdout + stillSet.stderr).includes(KEY), false);
});

test('unknown commands print usage and return 2', async () => {
  const home = await tempDir('optbrew-keys-');
  for (const argv of [[], ['set'], ['set', 'openai'], ['status', 'google'], ['remove'], ['set', 'google', 'extra'], ['reveal', 'google']]) {
    const result = await run(argv, { home });
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.stderr, /^usage: /);
    assert.equal(result.stdout, '');
  }
});

test('optbrew key reaches the key command and keeps the key out of its output', async () => {
  const home = await tempDir('optbrew-keys-');
  const out = sink(); const err = sink();
  const code = await main(['key', 'set', 'google'], { stdin: pipeStdin(`${KEY}\n`), stdout: out, stderr: err, env: { HOME: home, USERPROFILE: home }, cwd: home });
  assert.equal(code, 0);
  assert.equal((out.text() + err.text()).includes(KEY), false);
  const status = sink();
  assert.equal(await main(['key', 'status'], { stdout: status, stderr: err, env: { HOME: home, USERPROFILE: home }, cwd: home }), 0);
  assert.deepEqual(JSON.parse(status.text()), { google: { present: true, sha256_8: sha8(KEY) } });
});

test('keyHome picks USERPROFILE on Windows and HOME elsewhere, then the OS home', () => {
  const env = { HOME: '/posix/home', USERPROFILE: 'C:\\win\\profile' };
  assert.equal(keyHome(env, 'win32'), env.USERPROFILE);
  assert.equal(keyHome(env, 'linux'), env.HOME);
  assert.equal(keyHome({ HOME: '', USERPROFILE: '' }, 'win32'), os.homedir());
  assert.equal(keyHome({}, 'linux'), os.homedir());
});

test('without an explicit home, set and read resolve to the platform home from env', async () => {
  const root = await tempDir('optbrew-keys-');
  const [homeDir, profileDir] = [path.join(root, 'home'), path.join(root, 'profile')];
  const env = { HOME: homeDir, USERPROFILE: profileDir };
  const expected = process.platform === 'win32' ? profileDir : homeDir;
  const stdout = sink();
  assert.equal(await runKeyCommand(['set', 'google'], { stdin: pipeStdin(`${KEY}\n`), stdout, stderr: sink(), env }), 0);
  assert.deepEqual(await readdir(path.join(expected, '.optbrew')), ['credentials.json']);
  assert.equal(readGoogleKey({ env }), KEY);
  assert.equal(readGoogleKey({ env: {}, home: expected }), KEY);
  assert.equal(stdout.text().includes(KEY), false);
});

test('set keeps other entries in an existing key file; remove drops only google and unlinks an empty file', async () => {
  const home = await tempDir('optbrew-keys-');
  const file = path.join(home, '.optbrew', 'credentials.json');
  await writeKeyFile(home, JSON.stringify({ other: OTHER, google: 'old' }));
  assert.equal((await run(['set', 'google'], { home, stdin: pipeStdin(`${KEY}\n`) })).code, 0);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { other: OTHER, google: KEY });
  assert.equal((await run(['remove', 'google'], { home })).code, 0);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { other: OTHER });
  assert.equal(readGoogleKey({ env: {}, home }), null);
  await writeKeyFile(home, JSON.stringify({ google: KEY }));
  assert.equal((await run(['remove', 'google'], { home })).code, 0);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('the key folder is owner-only on POSIX', { skip: process.platform === 'win32' && 'Windows has no POSIX modes' }, async () => {
  const home = await tempDir('optbrew-keys-');
  await mkdir(path.join(home, '.optbrew'), { mode: 0o755 });
  await run(['set', 'google'], { home, stdin: pipeStdin(`${KEY}\n`) });
  assert.equal((await stat(path.join(home, '.optbrew'))).mode & 0o777, 0o700);
});

/** Type into a fake terminal and return the command result. */
async function typeOnTerminal(home, steps) {
  const terminal = fakeTerminal();
  const pending = run(['set', 'google'], { home, stdin: terminal });
  await new Promise(resolve => setImmediate(resolve));
  for (const step of steps) step(terminal);
  return { terminal, result: await pending };
}

test('hidden input drops control characters; Ctrl-D cancels only an empty line', async () => {
  const home = await tempDir('optbrew-keys-');
  const typed = await typeOnTerminal(home, [t => t.emit('data', `\u0001\t${KEY.slice(0, 5)}\u0004`), t => t.emit('data', `${KEY.slice(5)}\r`)]);
  assert.equal(typed.result.code, 0);
  assert.equal(readGoogleKey({ env: {}, home }), KEY);
  const other = await tempDir('optbrew-keys-');
  const cancelled = await typeOnTerminal(other, [t => t.emit('data', '\u0004')]);
  assert.equal(cancelled.result.code, 1);
  assert.deepEqual(cancelled.terminal.raw, [true, false]);
  assert.equal(readGoogleKey({ env: {}, home: other }), null);
});

test('hidden input ends cleanly when the terminal stream ends or fails', async () => {
  const home = await tempDir('optbrew-keys-');
  const ended = await typeOnTerminal(home, [t => t.emit('data', KEY.slice(0, 6)), t => t.emit('end')]);
  assert.equal(ended.result.code, 1);
  assert.deepEqual(ended.terminal.raw, [true, false]);
  assert.equal(ended.terminal.listenerCount('data') + ended.terminal.listenerCount('end') + ended.terminal.listenerCount('error'), 0);
  const failed = await typeOnTerminal(home, [t => t.emit('error', new Error('stream broke'))]);
  assert.equal(failed.result.code, 1);
  assert.match(failed.result.stderr, /stream broke/);
  assert.deepEqual(failed.terminal.raw, [true, false]);
  assert.equal(readGoogleKey({ env: {}, home }), null);
  assert.equal((ended.result.stdout + ended.result.stderr + failed.result.stdout + failed.result.stderr).includes(KEY.slice(0, 6)), false);
});

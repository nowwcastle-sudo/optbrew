import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './support/temp-dir.mjs';
import { googleKeyStatus, readGoogleKey, removeGoogleKey } from '../skills/optbrew/scripts/core/keys.mjs';
import { pluginKey } from '../skills/hooks/plugin-key-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookScript = path.join(root, 'skills/hooks/plugin-key-env.mjs');
// Fake keys assembled from fragments so no key-shaped literal exists in this repository.
const PLUGIN_KEY = ['AIza', 'Sy', 'Plugin', 'Fake', '0123456789', 'abcdefghij', 'KLM_-'].join('');
const ENV_KEY = ['env', '-', 'fake', '-', 'value'].join('');
const FILE_KEY = ['file', '-', 'fake', '-', 'value'].join('');
const NAME = 'CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY';
const pluginFile = home => path.join(home, '.optbrew', 'plugin-key.json');

function runHook(home, env) {
  return spawnSync(process.execPath, [hookScript], { encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? '', HOME: home, USERPROFILE: home, ...env } });
}

test('the Claude plugin setting comes before the environment variable and the key file', async () => {
  const home = await tempDir('optbrew-plugin-key-');
  await mkdir(path.join(home, '.optbrew'), { recursive: true });
  await writeFile(path.join(home, '.optbrew', 'credentials.json'), JSON.stringify({ google: FILE_KEY }));
  // A session started before 0.3.5 still carries the setting in its environment.
  assert.equal(readGoogleKey({ env: { [NAME]: ` ${PLUGIN_KEY}\n`, OPTBREW_GOOGLE_API_KEY: ENV_KEY }, home }), PLUGIN_KEY);
  assert.equal(readGoogleKey({ env: { [NAME]: '  ', OPTBREW_GOOGLE_API_KEY: ENV_KEY }, home }), ENV_KEY);
  assert.equal(readGoogleKey({ env: { [NAME]: '' }, home }), FILE_KEY);
  // The hook's plugin key file is the plugin setting too, and comes first.
  await writeFile(pluginFile(home), JSON.stringify({ google: PLUGIN_KEY }));
  assert.equal(readGoogleKey({ env: { OPTBREW_GOOGLE_API_KEY: ENV_KEY }, home }), PLUGIN_KEY);
  assert.deepEqual(googleKeyStatus({ env: { OPTBREW_GOOGLE_API_KEY: ENV_KEY }, home }).google.sources,
    { plugin_setting: true, env: true, key_file: 'present', used: 'plugin_setting' });
});

test('only a key-shaped setting is stored', () => {
  assert.equal(pluginKey({ [NAME]: ` ${PLUGIN_KEY} ` }), PLUGIN_KEY);
  assert.equal(pluginKey({}), null, 'no setting');
  assert.equal(pluginKey({ [NAME]: '   ' }), null, 'empty setting');
  for (const bad of ["a'b", 'a b', 'a$b', 'a`b', 'a;b', 'a\nb', 'a"b', 'a\\b', 'a/b'])
    assert.equal(pluginKey({ [NAME]: bad }), false, JSON.stringify(bad));
});

// daybreak csf_6c7324c30de94e12802a539b: the hook used to append `export CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY=...` to
// CLAUDE_ENV_FILE, so every later shell command of the session, a site project's scripts included, inherited the key.
test('the hook stores the setting in the owner-only plugin key file and never in CLAUDE_ENV_FILE', async () => {
  const home = await tempDir('optbrew-plugin-hook-');
  const envFile = path.join(home, 'session.env');
  await writeFile(envFile, "export EARLIER='1'\n");

  const ok = runHook(home, { [NAME]: PLUGIN_KEY, CLAUDE_ENV_FILE: envFile });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '');
  assert.equal(ok.stderr, '');
  assert.equal(await readFile(envFile, 'utf8'), "export EARLIER='1'\n", 'the session environment file is not touched');
  assert.equal(JSON.parse(await readFile(pluginFile(home), 'utf8')).google, PLUGIN_KEY);
  if (process.platform !== 'win32') {
    assert.equal((await stat(pluginFile(home))).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(pluginFile(home)))).mode & 0o777, 0o700);
  }
  // The audit scripts read it with no plugin variable in their environment.
  assert.equal(readGoogleKey({ env: {}, home }), PLUGIN_KEY);

  const bad = runHook(home, { [NAME]: "bad'value", CLAUDE_ENV_FILE: envFile });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /was not used/);
  assert.ok(!bad.stderr.includes('bad'), 'the message never repeats the value');
  assert.equal(JSON.parse(await readFile(pluginFile(home), 'utf8')).google, PLUGIN_KEY, 'a malformed setting stores nothing');

  // No setting reached the hook (the desktop app case): one stderr line, nothing on stdout, exit 0, and what a terminal
  // session stored stays.
  for (const env of [{ CLAUDE_ENV_FILE: envFile }, { [NAME]: '  ', CLAUDE_ENV_FILE: envFile }, {}]) {
    const none = runHook(home, env);
    assert.equal(none.status, 0);
    assert.equal(none.stdout, '');
    assert.match(none.stderr, /^optbrew: no google_api_key plugin setting reached this hook;[^\n]*\n$/);
  }
  assert.equal(readGoogleKey({ env: {}, home }), PLUGIN_KEY);
  assert.equal(await readFile(envFile, 'utf8'), "export EARLIER='1'\n");
});

test('key remove google also clears a plugin key file left behind', async () => {
  const home = await tempDir('optbrew-plugin-remove-');
  await mkdir(path.join(home, '.optbrew'), { recursive: true });
  await writeFile(pluginFile(home), JSON.stringify({ google: PLUGIN_KEY }));
  assert.equal(await removeGoogleKey({ home }), true);
  assert.equal(existsSync(pluginFile(home)), false);
  assert.equal(readGoogleKey({ env: {}, home }), null);
  assert.equal(await removeGoogleKey({ home }), false, 'nothing left to remove');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './support/temp-dir.mjs';
import { readGoogleKey } from '../skills/optbrew/scripts/core/keys.mjs';
import { envLine } from '../skills/hooks/plugin-key-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookScript = path.join(root, 'skills/hooks/plugin-key-env.mjs');
// Fake keys assembled from fragments so no key-shaped literal exists in this repository.
const PLUGIN_KEY = ['AIza', 'Sy', 'Plugin', 'Fake', '0123456789', 'abcdefghij', 'KLM_-'].join('');
const ENV_KEY = ['env', '-', 'fake', '-', 'value'].join('');
const FILE_KEY = ['file', '-', 'fake', '-', 'value'].join('');
const NAME = 'CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY';

test('the Claude plugin setting comes before the environment variable and the key file', async () => {
  const home = await tempDir('optbrew-plugin-key-');
  await mkdir(path.join(home, '.optbrew'), { recursive: true });
  await writeFile(path.join(home, '.optbrew', 'credentials.json'), JSON.stringify({ google: FILE_KEY }));
  assert.equal(readGoogleKey({ env: { [NAME]: ` ${PLUGIN_KEY}\n`, OPTBREW_GOOGLE_API_KEY: ENV_KEY }, home }), PLUGIN_KEY);
  assert.equal(readGoogleKey({ env: { [NAME]: '  ', OPTBREW_GOOGLE_API_KEY: ENV_KEY }, home }), ENV_KEY);
  assert.equal(readGoogleKey({ env: { [NAME]: '' }, home }), FILE_KEY);
});

test('the hook line is one plain single-quoted assignment, and only for a key-shaped value with an env file', () => {
  assert.equal(envLine({ [NAME]: ` ${PLUGIN_KEY} `, CLAUDE_ENV_FILE: 'x' }), `export ${NAME}='${PLUGIN_KEY}'\n`);
  assert.equal(envLine({ [NAME]: PLUGIN_KEY }), null, 'no CLAUDE_ENV_FILE: nothing to write to');
  assert.equal(envLine({ CLAUDE_ENV_FILE: 'x' }), null, 'no setting');
  assert.equal(envLine({ [NAME]: '   ', CLAUDE_ENV_FILE: 'x' }), null, 'empty setting');
  for (const bad of ["a'b", 'a b', 'a$b', 'a`b', 'a;b', 'a\nb', 'a"b', 'a\\b', 'a/b'])
    assert.equal(envLine({ [NAME]: bad, CLAUDE_ENV_FILE: 'x' }), null, JSON.stringify(bad));
});

test('the hook appends the setting to CLAUDE_ENV_FILE, keeps lines already there and prints nothing', async () => {
  const dir = await tempDir('optbrew-plugin-hook-');
  const envFile = path.join(dir, 'session.env');
  await writeFile(envFile, "export EARLIER='1'\n");
  const run = env => spawnSync(process.execPath, [hookScript], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? '', ...env }, encoding: 'utf8' });

  const ok = run({ [NAME]: PLUGIN_KEY, CLAUDE_ENV_FILE: envFile });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '');
  assert.equal(ok.stderr, '');
  assert.equal(await readFile(envFile, 'utf8'), `export EARLIER='1'\nexport ${NAME}='${PLUGIN_KEY}'\n`);

  const bad = run({ [NAME]: "bad'value", CLAUDE_ENV_FILE: envFile });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /was not used/);
  assert.ok(!bad.stderr.includes('bad'), 'the message never repeats the value');
  assert.equal((await readFile(envFile, 'utf8')).split('\n').length, 3, 'nothing appended for a value that is not key-shaped');

  const none = run({ CLAUDE_ENV_FILE: envFile });
  assert.equal(none.status, 0);
  assert.equal(none.stdout + none.stderr, '');
});

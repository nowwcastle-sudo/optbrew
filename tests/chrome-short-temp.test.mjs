// Chrome's temp folder when the profile is under a long folder (T22 M-7, ubuntu CI): `<profile>/tmp` would be too long for Chrome's
// Unix socket, and keeping the user's temp folder let Chrome's background downloads leave folders there. A short owner-only folder
// in /tmp takes its place and is removed with the profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromeEnv, chromeTempDir, sweepStaleShortTemps } from '../skills/optbrew/scripts/core/chrome-temp.mjs';

const posixOnly = { skip: process.platform === 'win32' && 'Windows has no POSIX modes' };

test('a profile under a short folder keeps its temp folder inside the profile', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'optbrew-chrome-a');
  await mkdir(profile);
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const temp = await chromeTempDir(profile, { platform });
  if (platform === 'win32' || Buffer.byteLength(path.join(profile, 'tmp')) <= 48) assert.deepEqual(temp, { dir: path.join(profile, 'tmp'), own: false });
  assert.ok((await stat(path.join(profile, 'tmp'))).isDirectory());
});

test('a profile under a long folder gets a short owner-only temp folder in /tmp, and Chrome is given it', posixOnly, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-long-parent-folder-for-the-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'optbrew-chrome-XXXXXXabcdef');
  await mkdir(profile);
  const temp = await chromeTempDir(profile, { platform: 'linux' });
  t.after(() => temp && rm(temp.dir, { recursive: true, force: true }));
  assert.equal(temp.own, true);
  assert.match(temp.dir, /^\/tmp\/optbrew-t-/);
  assert.ok(Buffer.byteLength(temp.dir) <= 48, temp.dir);
  assert.equal((await stat(temp.dir)).mode & 0o777, 0o700);
  assert.equal(await readFile(path.join(temp.dir, 'owner'), 'utf8'), profile);
  assert.equal(chromeEnv({ TMPDIR: '/home/me/tmp', PATH: 'p' }, temp.dir, 'linux').TMPDIR, temp.dir, 'the user temp folder is replaced');
});

test('the sweep removes an old short temp folder whose profile is gone and keeps the rest', posixOnly, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-long-parent-folder-for-the-sweep-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const made = [];
  for (const name of ['optbrew-chrome-gone', 'optbrew-chrome-live', 'optbrew-chrome-young']) {
    await mkdir(path.join(root, name));
    made.push({ name, temp: await chromeTempDir(path.join(root, name), { platform: 'linux' }) });
  }
  t.after(() => Promise.all(made.map(m => rm(m.temp.dir, { recursive: true, force: true }))));
  await rm(path.join(root, 'optbrew-chrome-gone'), { recursive: true });
  await rm(path.join(root, 'optbrew-chrome-young'), { recursive: true });
  const old = new Date(Date.now() - 13 * 60 * 60_000);
  for (const m of made.filter(m => m.name !== 'optbrew-chrome-young')) await utimes(m.temp.dir, old, old);
  const removed = await sweepStaleShortTemps('/tmp');
  const base = m => path.basename(m.temp.dir);
  assert.ok(removed.includes(base(made[0])), 'old, profile gone: removed');
  assert.ok(!removed.includes(base(made[1])), 'old, profile still there: kept');
  assert.ok(!removed.includes(base(made[2])), 'young: kept even with its profile gone');
});

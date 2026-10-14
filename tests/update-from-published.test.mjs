import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { install } from '../lib/install.mjs';
import { update, rollback } from '../lib/update.mjs';
import { doctor } from '../lib/doctor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Source commit of the published 0.1.1 release (bundle_hash 2945f112...).
const published = '5391752';
const reachable = spawnSync('git', ['cat-file', '-e', `${published}^{commit}`], { cwd: root }).status === 0;

test('a managed install of the published 0.1.1 bundle updates to this release and rolls back', { skip: reachable ? false : 'published 0.1.1 commit is not in this clone' }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew update from 0.1.1 '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const archive = path.join(temp, 'published.zip');
  assert.equal(spawnSync('git', ['archive', '--format=zip', '-o', archive, published, 'skills/optbrew'], { cwd: root }).status, 0);
  const extract = spawnSync('python', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, path.join(temp, 'old')], { encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr);
  const oldBundle = path.join(temp, 'old', 'skills', 'optbrew');
  const oldManifest = JSON.parse(await readFile(path.join(oldBundle, 'bundle-manifest.json'), 'utf8'));
  assert.equal(oldManifest.release_version, '0.1.1');
  assert.match(oldManifest.bundle_hash, /^2945f112/);
  const home = path.join(temp, 'home');
  await mkdir(home);
  const installed = await install({ bundleRoot: oldBundle, home, scope: 'user', agents: ['codex', 'claude-code'], strategy: 'copy' });
  const recordRoot = installed.record.managed_root;
  await mkdir(path.join(home, '.optbrew/runs'), { recursive: true });
  await writeFile(path.join(home, '.optbrew/runs/run.json'), 'private run evidence');

  const currentBundle = path.join(root, 'skills', 'optbrew');
  const next = JSON.parse(await readFile(path.join(currentBundle, 'bundle-manifest.json'), 'utf8'));
  assert.equal(next.evaluation_version, oldManifest.evaluation_version);
  assert.equal(next.protocol_version, oldManifest.protocol_version);
  const updated = await update({ bundleRoot: currentBundle, recordRoot });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.record.release_version, next.release_version);
  assert.equal(updated.record.bundle_hash, next.bundle_hash);
  assert.ok((await doctor({ home, scope: 'user', agents: ['codex', 'claude-code'] })).targets.every(x => x.hash_ok));
  assert.equal(await readFile(path.join(home, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');

  const restored = await rollback({ recordRoot, releaseVersion: '0.1.1' });
  assert.equal(restored.status, 'rolled_back');
  assert.equal(restored.record.bundle_hash, oldManifest.bundle_hash);
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createBundleManifest } from '../skills/optbrew/scripts/core/bundle.mjs';
import { main } from '../lib/cli.mjs';

test('CLI validates arguments and reports JSON dry-run without writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleRoot = path.join(root, 'bundle');
  await mkdir(bundleRoot);
  await writeFile(path.join(bundleRoot, 'SKILL.md'), 'skill');
  await writeFile(path.join(bundleRoot, 'bundle-manifest.json'), JSON.stringify(await createBundleManifest({ bundleRoot, releaseVersion: '0.1.0' })));
  let out = '', err = '';
  const io = { stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } }, env: {}, cwd: root, bundleRoot };
  assert.equal(await main(['install', '--agents', 'codex,claude-code', '--scope', 'user', '--home', path.join(root, 'home'), '--dry-run', '--json'], io), 0);
  assert.equal(JSON.parse(out).decision.targets.length, 2);
  assert.equal(await main(['install', '--agents', 'unknown', '--scope', 'user'], io), 2);
  assert.match(err, /agent/i);
  assert.equal(await main(['update', '--agents', 'codex', '--scope', 'user', '--home', path.join(root, 'home')], io), 1);
});

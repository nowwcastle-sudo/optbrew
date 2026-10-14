import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, writeFile, lstat, realpath, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBundleManifest, verifyBundle } from '../skills/optbrew/scripts/core/bundle.mjs';
import { install } from '../lib/install.mjs';
import { resolveTargets } from '../lib/paths.mjs';
import { readInstallRecord } from '../lib/records.mjs';
import { fixture as updateFixture } from './fixtures/releases/create.mjs';
import { update } from '../lib/update.mjs';
import { recoverTransaction } from '../lib/transaction.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew 한글 (8) '));
  const home = path.join(root, 'home (테스트)');
  const bundleRoot = path.join(root, 'bundle');
  await mkdir(bundleRoot, { recursive: true });
  await writeFile(path.join(bundleRoot, 'SKILL.md'), '---\nname: optbrew\n---\n');
  const manifest = await createBundleManifest({ bundleRoot, releaseVersion: '0.1.0' });
  await writeFile(path.join(bundleRoot, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, home, bundleRoot };
}

test('install preserves other skill/config and adds only selected targets', async () => {
  const { home, bundleRoot } = await fixture();
  const seo = path.join(home, '.agents/skills/seo/SKILL.md');
  const config = path.join(home, '.claude/settings.json');
  await mkdir(path.dirname(seo), { recursive: true });
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(seo, 'existing seo');
  await writeFile(config, '{"user":true}');
  const before = [hash(await readFile(seo)), hash(await readFile(config))];
  const result = await install({ bundleRoot, agents: ['codex'], scope: 'user', home });
  assert.equal(result.record.targets.length, 1);
  assert.deepEqual([hash(await readFile(seo)), hash(await readFile(config))], before);
  const codex = resolveTargets({ agents: ['codex'], scope: 'user', home })[0].path;
  assert.equal(await realpath(codex), path.join(home, '.optbrew/installs/user/bundle'));
  const claude = resolveTargets({ agents: ['claude-code'], scope: 'user', home })[0].path;
  await assert.rejects(lstat(claude), { code: 'ENOENT' });
  const added = await install({ bundleRoot, agents: ['claude-code'], scope: 'user', home });
  assert.deepEqual(added.record.targets.map(t => t.agent).sort(), ['claude-code', 'codex']);
  assert.equal(await realpath(codex), await realpath(claude));
});

test('dry-run writes nothing and shows selected targets', async () => {
  const { home, bundleRoot } = await fixture();
  const result = await install({ bundleRoot, agents: ['codex', 'claude-code'], scope: 'user', home, dryRun: true });
  assert.equal(result.status, 'dry_run');
  assert.equal(result.record, null);
  assert.equal(result.changed_paths.length, 0);
  assert.equal(result.decision.targets.length, 2);
  await assert.rejects(lstat(home), { code: 'ENOENT' });
});

test('unowned target, outside junction, and damaged bundle are rejected', async () => {
  const { root, home, bundleRoot } = await fixture();
  const target = resolveTargets({ agents: ['codex'], scope: 'user', home })[0].path;
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'SKILL.md'), 'someone else');
  await assert.rejects(install({ bundleRoot, agents: ['codex'], scope: 'user', home }), /unmanaged|owned|exists/i);
  const otherHome = path.join(root, 'second-home');
  const outside = path.join(root, 'outside');
  await mkdir(otherHome);
  await mkdir(outside);
  await symlink(outside, path.join(otherHome, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(install({ bundleRoot, agents: ['codex'], scope: 'user', home: otherHome }), /outside|link|junction/i);
  await writeFile(path.join(bundleRoot, 'SKILL.md'), 'tampered');
  const check = await verifyBundle({ bundleRoot, manifest: JSON.parse(await readFile(path.join(bundleRoot, 'bundle-manifest.json')))});
  assert.equal(check.status, 'invalid');
  await assert.rejects(install({ bundleRoot, agents: ['claude-code'], scope: 'user', home: otherHome }), /bundle/i);
});

test('copy requires explicit strategy and records it', async () => {
  const { home, bundleRoot } = await fixture();
  const result = await install({ bundleRoot, agents: ['pi'], scope: 'user', home, strategy: 'copy' });
  assert.equal(result.record.targets[0].strategy, 'copy');
  const target = result.record.targets[0].path;
  assert.equal((await lstat(target)).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), '---\nname: optbrew\n---\n');
});

test('project mapping and missing registered link are detected', async () => {
  const { root, bundleRoot } = await fixture();
  const projectRoot = path.join(root, 'project (한글)');
  const target = resolveTargets({ agents: ['pi'], scope: 'project', projectRoot })[0].path;
  assert.equal(target, path.join(projectRoot, '.pi/skills/optbrew'));
  await install({ bundleRoot, agents: ['pi'], scope: 'project', projectRoot });
  await rm(target);
  await assert.rejects(install({ bundleRoot, agents: ['pi'], scope: 'project', projectRoot }), /registered target missing/);
});

test('manifest matches npm-distributed skill files and excludes Python caches', async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'skills/optbrew/bundle-manifest.json')));
  assert.ok(manifest.files.every(f => !f.path.includes('__pycache__') && !f.path.endsWith('.pyc')));
  const packCommand = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const packArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm pack --dry-run --json --offline --ignore-scripts']
    : ['pack', '--dry-run', '--json', '--offline', '--ignore-scripts'];
  const packResult = JSON.parse(execFileSync(packCommand, packArgs, { cwd: repositoryRoot, encoding: 'utf8' }));
  const packed = Array.isArray(packResult) ? packResult[0] : packResult.optbrew;
  const distributed = packed.files.map(f => f.path).filter(p => p.startsWith('skills/optbrew/')).map(p => p.slice('skills/optbrew/'.length)).sort();
  assert.deepEqual(distributed, [...manifest.files.map(f => f.path), 'bundle-manifest.json'].sort());
  const { root, bundleRoot } = await fixture();
  const cache = path.join(bundleRoot, 'scripts/__pycache__/transient.pyc');
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, 'cache');
  const clean = await createBundleManifest({ bundleRoot, releaseVersion: '0.1.0' });
  assert.ok(clean.files.every(f => !f.path.includes('__pycache__') && !f.path.endsWith('.pyc')));
  const shipped = path.join(root, 'shipped');
  await mkdir(shipped);
  for (const file of clean.files) {
    const destination = path.join(shipped, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(bundleRoot, file.path)));
  }
  await writeFile(path.join(shipped, 'bundle-manifest.json'), JSON.stringify(clean));
  assert.equal((await verifyBundle({ bundleRoot: shipped, manifest: clean })).status, 'valid');
});

async function withSymlinkFailure(failAt, action) {
  const original = fs.symlink;
  let calls = 0;
  fs.symlink = async (...args) => {
    if (++calls === failAt) { const error = new Error('injected permission denial'); error.code = 'EPERM'; throw error; }
    return original(...args);
  };
  syncBuiltinESMExports();
  try { await action(); }
  finally { fs.symlink = original; syncBuiltinESMExports(); }
}

test('first link failure retains owned pending state and explicit copy retry succeeds', async () => {
  const { home, bundleRoot } = await fixture();
  await withSymlinkFailure(1, async () => {
    await assert.rejects(install({ bundleRoot, agents: ['codex'], scope: 'user', home }), /retry explicitly with --strategy copy/);
  });
  const managedRoot = path.join(home, '.optbrew/installs/user');
  const pending = await readInstallRecord(managedRoot);
  assert.equal(pending.transaction.state, 'pending');
  assert.deepEqual(pending.targets, []);
  const retry = await install({ bundleRoot, agents: ['codex'], scope: 'user', home, strategy: 'copy' });
  assert.equal(retry.status, 'installed');
  assert.equal(retry.record.targets[0].strategy, 'copy');
  assert.equal(retry.record.transaction.state, 'committed');
});

test('second target failure preserves first registration and copy retry adds only missing target', async () => {
  const { home, bundleRoot } = await fixture();
  await withSymlinkFailure(2, async () => {
    await assert.rejects(install({ bundleRoot, agents: ['codex', 'claude-code'], scope: 'user', home }), /retry explicitly with --strategy copy/);
  });
  const managedRoot = path.join(home, '.optbrew/installs/user');
  const pending = await readInstallRecord(managedRoot);
  assert.equal(pending.transaction.state, 'pending');
  assert.deepEqual(pending.targets.map(t => t.agent), ['codex']);
  const codexPath = resolveTargets({ agents: ['codex'], scope: 'user', home })[0].path;
  assert.equal((await lstat(codexPath)).isSymbolicLink(), true);
  const retry = await install({ bundleRoot, agents: ['codex', 'claude-code'], scope: 'user', home, strategy: 'copy' });
  assert.equal(retry.status, 'installed');
  assert.deepEqual(retry.record.targets.map(t => [t.agent, t.strategy]), [['codex', 'link'], ['claude-code', 'copy']]);
  assert.equal(retry.record.transaction.state, 'committed');
  assert.equal((await lstat(codexPath)).isSymbolicLink(), true);
});

for (const dryRun of [false, true]) test(`installer refuses outstanding journal before ${dryRun ? 'planning' : 'writing'} an added target`, async () => {
  const f = await updateFixture();
  const interrupted = await update({ bundleRoot: f.next, recordRoot: f.recordRoot, faultHook: phase => {
    if (phase === 'after_staging') throw new Error('interrupt update');
  } });
  assert.equal(interrupted.status, 'recovery_required');
  const recordFile = path.join(f.recordRoot, 'install-record.json');
  const journalFile = path.join(f.recordRoot, 'transaction.json');
  const before = await Promise.all([recordFile, journalFile].map(p => readFile(p, 'utf8')));
  await assert.rejects(install({ bundleRoot: f.old, home: f.home, scope: 'user', agents: ['pi'], strategy: 'copy', dryRun }), /recovery_required.*optbrew update/);
  assert.deepEqual(await Promise.all([recordFile, journalFile].map(p => readFile(p, 'utf8'))), before);
  await assert.rejects(lstat(resolveTargets({ home: f.home, scope: 'user', agents: ['pi'] })[0].path), { code: 'ENOENT' });
  assert.equal((await recoverTransaction(f.recordRoot)).status, 'recovered');
});

test('installer rechecks outstanding journal after obtaining its lock', async () => {
  const f = await updateFixture();
  const before = await readFile(path.join(f.recordRoot, 'install-record.json'), 'utf8');
  const original = fs.open;
  let injected = false;
  fs.open = async (file, ...args) => {
    if (!injected && file === path.join(f.recordRoot, 'install.lock') && args[0] === 'wx') {
      injected = true;
      const result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot, faultHook: phase => {
        if (phase === 'after_staging') throw new Error('interrupt between installer inspect and lock');
      } });
      assert.equal(result.status, 'recovery_required');
    }
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(install({ bundleRoot: f.old, home: f.home, scope: 'user', agents: ['pi'], strategy: 'copy' }), /recovery_required.*optbrew update/);
  } finally { fs.open = original; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(await readFile(path.join(f.recordRoot, 'install-record.json'), 'utf8'), before);
  await assert.rejects(lstat(resolveTargets({ home: f.home, scope: 'user', agents: ['pi'] })[0].path), { code: 'ENOENT' });
  assert.equal((await recoverTransaction(f.recordRoot)).status, 'recovered');
});

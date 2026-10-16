import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, lstat, rm, symlink, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, seal } from './fixtures/releases/create.mjs';
import { update, checkUpdates } from '../lib/update.mjs';
import { readInstallRecord, writeInstallRecord } from '../lib/records.mjs';
import { doctor } from '../lib/doctor.mjs';
import { main } from '../lib/cli.mjs';
import { install } from '../lib/install.mjs';
import { isDistributedBundlePath } from '../skills/optbrew/scripts/core/bundle.mjs';

for (const strategy of ['copy', 'link']) test(`verified update preserves selected ${strategy} targets and private files`, async () => {
  const f = await fixture(strategy);
  const before = await Promise.all(f.preserved.map(p => readFile(p, 'utf8')));
  const result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot });
  assert.equal(result.status, 'updated');
  assert.equal(result.record.release_version, '0.1.1');
  assert.deepEqual(result.record.targets, f.record.targets);
  for (const t of result.record.targets) {
    assert.equal(await readFile(path.join(t.path, 'SKILL.md'), 'utf8'), 'optbrew 0.1.1\n');
    assert.equal((await lstat(t.path)).isSymbolicLink(), strategy === 'link');
  }
  assert.deepEqual(await Promise.all(f.preserved.map(p => readFile(p, 'utf8'))), before);
  assert.ok((await doctor({ home: f.home, scope: 'user', agents: ['codex', 'claude-code'] })).targets.every(t => t.hash_ok));
  assert.equal((await update({ bundleRoot: f.next, recordRoot: f.recordRoot })).status, 'unchanged');
});

test('local edit defaults to abort; explicit replacement preserves a readable backup', async () => {
  const f = await fixture();
  const edited = path.join(f.record.targets[0].path, 'SKILL.md');
  await writeFile(edited, 'user edit');
  const recordBefore = await readFile(path.join(f.recordRoot, 'install-record.json'), 'utf8');
  await assert.rejects(update({ bundleRoot: f.next, recordRoot: f.recordRoot }), /local changes/);
  assert.equal(await readFile(edited, 'utf8'), 'user edit');
  assert.equal(await readFile(path.join(f.recordRoot, 'install-record.json'), 'utf8'), recordBefore);
  const result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot, localChanges: 'backup-and-replace' });
  assert.equal(result.status, 'updated');
  assert.ok(result.decision.conflicts.some(c => c.path === f.record.targets[0].path));
  const backup = result.decision.backups.find(b => b.path === f.record.targets[0].path);
  assert.match(backup.backup, /_백업_원본_/);
  assert.equal(await readFile(path.join(backup.backup, 'SKILL.md'), 'utf8'), 'user edit');
});

for (const damage of ['hash', 'manifest', 'source-lock', 'evaluation']) test(`rejects ${damage} before any target change`, async () => {
  const f = await fixture();
  if (damage === 'hash') await writeFile(path.join(f.next, 'SKILL.md'), 'corrupt');
  if (damage === 'manifest') await writeFile(path.join(f.next, 'bundle-manifest.json'), '{}');
  if (damage === 'source-lock') {
    await writeFile(path.join(f.next, 'source-lock.json'), JSON.stringify({ schema_version: '1.0.0', modules: [], files: [{ target_path: 'SKILL.md', distributed_sha256: '0'.repeat(64) }] }));
    await seal(f.next, '0.1.1');
  }
  if (damage === 'evaluation') {
    await writeFile(path.join(f.next, 'references/check-registry.json'), JSON.stringify({ evaluation_version: '2.0.0' }));
    await seal(f.next, '0.1.1');
  }
  await assert.rejects(update({ bundleRoot: f.next, recordRoot: f.recordRoot }), /integrity|manifest|source.lock|migration_required/);
  assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.1.0');
  for (const t of f.record.targets) assert.equal(await readFile(path.join(t.path, 'SKILL.md'), 'utf8'), 'optbrew 0.1.0\n');
});

test('unmanaged link, foreign record and pending initial install are refused', async () => {
  const f = await fixture('link');
  const t = f.record.targets[0];
  await rm(t.path);
  await symlink(f.next, t.path, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(update({ bundleRoot: f.next, recordRoot: f.recordRoot, localChanges: 'backup-and-replace' }), /link|ownership/);
  await rm(t.path); await symlink(t.managed_target, t.path, process.platform === 'win32' ? 'junction' : 'dir');
  await writeInstallRecord(f.recordRoot, { ...f.record, managed_root: path.join(f.root, 'foreign') });
  await assert.rejects(update({ bundleRoot: f.next, recordRoot: f.recordRoot }), /scope|record/);
  await writeInstallRecord(f.recordRoot, { ...f.record, transaction: { state: 'pending' } });
  await assert.rejects(update({ bundleRoot: f.next, recordRoot: f.recordRoot }), /pending|recovery_required/);
});

test('registry check is read-only and unconfirmed package stays local-only', async () => {
  let calls = 0;
  const registryTransport = async name => { calls++; assert.equal(name, '@example/optbrew'); return { 'dist-tags': { latest: '0.1.1' } }; };
  assert.equal((await checkUpdates({ currentVersion: '0.1.0', registryTransport })).status, 'local_only');
  assert.equal(calls, 0);
  assert.equal((await checkUpdates({ packageName: '@example/optbrew', currentVersion: '0.1.0', registryTransport })).status, 'update_available');
  assert.equal(calls, 1);
});

test('CLI updates recorded targets and reports recovery failure with nonzero exit', async () => {
  const f = await fixture();
  let out = '', err = '';
  const io = { bundleRoot: f.next, stdout: { write: s => out += s }, stderr: { write: s => err += s } };
  assert.equal(await main(['update', '--record-root', f.recordRoot, '--json'], io), 0);
  assert.equal(JSON.parse(out).record.release_version, '0.1.1');
  out = '';
  assert.equal(await main(['check-updates', '--json'], io), 0);
  assert.equal(JSON.parse(out).status, 'local_only');
  assert.equal(err, '');
});

test('actual distributed bundle and source-lock update in isolated project with mixed strategies', async () => {
  const f = await fixture();
  const actual = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/optbrew');
  const release = path.join(f.root, 'actual-next');
  await cp(actual, release, { recursive: true, filter: p => isDistributedBundlePath(path.relative(actual, p)) });
  await writeFile(path.join(release, 'SKILL.md'), `${await readFile(path.join(release, 'SKILL.md'), 'utf8')}\nSynthetic update fixture.\n`);
  await seal(release, '0.1.5');
  const projectRoot = path.join(f.root, 'project (한글)');
  const linked = await install({ bundleRoot: actual, agents: ['codex'], scope: 'project', projectRoot });
  await install({ bundleRoot: actual, agents: ['pi'], scope: 'project', projectRoot, strategy: 'copy' });
  const result = await update({ bundleRoot: release, recordRoot: linked.record.managed_root });
  assert.equal(result.status, 'updated');
  assert.equal(result.verification.checked_files,
    JSON.parse(await readFile(path.join(release, 'bundle-manifest.json'), 'utf8')).files.length);
  assert.deepEqual(result.record.targets.map(t => t.strategy), ['link', 'copy']);
  assert.ok((await doctor({ scope: 'project', projectRoot, agents: ['codex', 'pi'] })).targets.every(t => t.hash_ok));
});

test('managed bundle edits require explicit backup and are recoverable from verified original source', async () => {
  const f = await fixture('link');
  const edited = path.join(f.recordRoot, 'bundle/SKILL.md');
  await writeFile(edited, 'edited managed link source');
  await assert.rejects(update({ bundleRoot: f.next, recordRoot: f.recordRoot }), /local changes/);
  const result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot, localChanges: 'backup-and-replace' });
  assert.equal(result.status, 'updated');
  assert.equal(await readFile(path.join(result.decision.backups[0].backup, 'SKILL.md'), 'utf8'), 'edited managed link source');
});

test('scope lock rejects concurrent updates without changing prepared state', async () => {
  const f = await fixture();
  let concurrent;
  const result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot, faultHook: async phase => {
    if (phase === 'after_staging') concurrent = await update({ bundleRoot: f.next, recordRoot: f.recordRoot });
  } });
  assert.equal(concurrent.status, 'recovery_required');
  assert.match(concurrent.decision.recovery.unresolved_paths.join(' '), /lock/);
  assert.equal(result.status, 'updated');
});

test('resolved ancestor substitution is refused before moving outside files', async () => {
  const f = await fixture();
  const ancestor = path.dirname(f.record.targets[0].path);
  const original = `${ancestor}-original`;
  const outside = path.join(f.root, 'outside');
  await mkdir(path.join(outside, 'optbrew'), { recursive: true });
  await writeFile(path.join(outside, 'optbrew/SKILL.md'), 'outside content');
  const result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot, faultHook: async phase => {
    if (phase === 'after_staging') { await rename(ancestor, original); await symlink(outside, ancestor, process.platform === 'win32' ? 'junction' : 'dir'); }
  } });
  assert.equal(result.status, 'recovery_required');
  assert.equal(await readFile(path.join(outside, 'optbrew/SKILL.md'), 'utf8'), 'outside content');
  assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.1.0');
});

test('metadata presence asymmetry requires migration and malformed records cannot authorize writes', async () => {
  const f = await fixture();
  const manifestFile = path.join(f.next, 'bundle-manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  await writeFile(manifestFile, JSON.stringify({ ...manifest, protocol_version: '0.1.0' }));
  await assert.rejects(update({ bundleRoot: f.next, recordRoot: f.recordRoot }), /migration_required/);
  const recordFile = path.join(f.recordRoot, 'install-record.json');
  await writeFile(recordFile, '{corrupt');
  await assert.rejects(update({ bundleRoot: f.next, recordRoot: f.recordRoot }), /JSON|Unexpected|Expected/);
  for (const t of f.record.targets) assert.equal(await readFile(path.join(t.path, 'SKILL.md'), 'utf8'), 'optbrew 0.1.0\n');
});

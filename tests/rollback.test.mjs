import assert from 'node:assert/strict';
import { readFile, writeFile, rm, symlink, lstat, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './fixtures/releases/create.mjs';
import { update, rollback } from '../lib/update.mjs';
import { recoverTransaction } from '../lib/transaction.mjs';
import { readInstallRecord } from '../lib/records.mjs';
import { doctor } from '../lib/doctor.mjs';
import { main } from '../lib/cli.mjs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

test('rollback restores verified previous version/content/doctor and retains snapshots', async () => {
  const f = await fixture();
  const changed = await update({ bundleRoot: f.next, recordRoot: f.recordRoot });
  const snapshot = changed.record.previous_releases[0].bundle_root;
  const result = await rollback({ recordRoot: f.recordRoot, releaseVersion: '0.1.0' });
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.record.release_version, '0.1.0');
  assert.equal(await readFile(path.join(snapshot, 'SKILL.md'), 'utf8'), 'optbrew 0.1.0\n');
  assert.equal(await readFile(path.join(result.record.targets[0].path, 'SKILL.md'), 'utf8'), 'optbrew 0.1.0\n');
  assert.ok((await doctor({ home: f.home, scope: 'user', agents: ['codex', 'claude-code'] })).targets.every(t => t.hash_ok));
  for (const p of f.preserved) assert.equal(await readFile(p, 'utf8'), `private ${path.basename(p)}`);
});

for (const phase of ['after_staging', 'after_first_target', 'before_record_replace']) test(`journal recovers fault ${phase}`, async () => {
  const f = await fixture();
  const seen = [];
  const result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot, faultHook: name => { seen.push(name); if (name === phase) throw new Error(`fault ${phase}`); } });
  assert.equal(result.status, 'recovery_required');
  assert.ok(seen.includes(phase));
  const recovered = await recoverTransaction(f.recordRoot);
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.restored_version, '0.1.0');
  for (const t of f.record.targets) assert.equal(await readFile(path.join(t.path, 'SKILL.md'), 'utf8'), 'optbrew 0.1.0\n');
  assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.1.0');
  assert.equal((await recoverTransaction(f.recordRoot)).status, 'clean');
});

test('tampered snapshot is refused without changing installation', async () => {
  const f = await fixture();
  const changed = await update({ bundleRoot: f.next, recordRoot: f.recordRoot });
  await writeFile(path.join(changed.record.previous_releases[0].bundle_root, 'SKILL.md'), 'tampered rollback');
  await assert.rejects(rollback({ recordRoot: f.recordRoot, releaseVersion: '0.1.0' }), /integrity|snapshot/);
  assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.1.1');
});

test('recovery refuses edited switched target and retains journal evidence', async () => {
  const f = await fixture();
  await update({ bundleRoot: f.next, recordRoot: f.recordRoot, faultHook: phase => { if (phase === 'after_first_target') throw new Error('interrupt'); } });
  await writeFile(path.join(f.record.targets[0].path, 'SKILL.md'), 'later user edit');
  const result = await recoverTransaction(f.recordRoot);
  assert.equal(result.status, 'recovery_required');
  assert.ok(result.unresolved_paths.length);
  assert.equal(await readFile(path.join(f.record.targets[0].path, 'SKILL.md'), 'utf8'), 'later user edit');
  assert.ok(await readFile(path.join(f.recordRoot, 'transaction.json')));
});

test('real process exit leaves journal and stale lock; rerun restores previous release', async () => {
  const f = await fixture('link');
  const moduleUrl = pathToFileURL(path.resolve('lib/update.mjs')).href;
  const script = `import { update } from ${JSON.stringify(moduleUrl)}; await update({ bundleRoot: process.argv[1], recordRoot: process.argv[2], faultHook: p => { if (p === 'after_first_target') process.exit(73); } });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.next, f.recordRoot], { encoding: 'utf8' });
  assert.equal(child.status, 73);
  assert.equal(child.stderr, '');
  assert.ok(await lstat(path.join(f.recordRoot, 'install.lock')));
  const result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot });
  assert.equal(result.status, 'recovered');
  assert.equal(result.record.release_version, '0.1.0');
  for (const t of f.record.targets) assert.equal(await readFile(path.join(t.path, 'SKILL.md'), 'utf8'), 'optbrew 0.1.0\n');
  assert.equal((await update({ bundleRoot: f.next, recordRoot: f.recordRoot })).status, 'updated');
});

test('recovery refuses journal path forgery and substituted links', async () => {
  const f = await fixture('link');
  await update({ bundleRoot: f.next, recordRoot: f.recordRoot, faultHook: p => { if (p === 'after_staging') throw new Error('stop'); } });
  const file = path.join(f.recordRoot, 'transaction.json');
  const journal = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...journal, operations: journal.operations.map(op => ({ ...op, previous: f.next })) }));
  assert.equal((await recoverTransaction(f.recordRoot)).status, 'recovery_required');
  await writeFile(file, JSON.stringify(journal));
  const target = f.record.targets[0].path;
  await rm(target); await symlink(f.next, target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await recoverTransaction(f.recordRoot)).status, 'recovery_required');
  assert.equal(await readFile(path.join(f.next, 'SKILL.md'), 'utf8'), 'optbrew 0.1.1\n');
});

test('CLI reports pending recovery with nonzero exit and rollback selects recorded snapshot', async () => {
  const f = await fixture();
  await update({ bundleRoot: f.next, recordRoot: f.recordRoot, faultHook: p => { if (p === 'after_staging') throw new Error('stop'); } });
  let output = '';
  const io = { bundleRoot: f.next, stdout: { write: s => output += s }, stderr: { write: s => output += s } };
  assert.equal(await main(['update', '--record-root', f.recordRoot, '--json'], io), 1);
  assert.equal(JSON.parse(output).status, 'recovered');
  output = '';
  assert.equal(await main(['update', '--record-root', f.recordRoot], io), 0);
  output = '';
  assert.equal(await main(['rollback', '--record-root', f.recordRoot, '--release-version', '0.1.0'], io), 0);
  assert.equal(JSON.parse(output).record.release_version, '0.1.0');
});

for (const failure of ['target-rename', 'record-replace']) test(`real ${failure} failure returns recoverable partial state`, async () => {
  const f = await fixture();
  const original = fs.rename;
  let injected = false;
  fs.rename = async (from, to) => {
    if (!injected && (failure === 'target-rename' ? to === f.record.targets[0].path : to === path.join(f.recordRoot, 'install-record.json'))) {
      injected = true; const error = new Error(`injected ${failure}`); error.code = 'EPERM'; throw error;
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
  let result;
  try { result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot }); }
  finally { fs.rename = original; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(result.status, 'recovery_required');
  assert.equal((await recoverTransaction(f.recordRoot)).status, 'recovered');
  for (const t of f.record.targets) assert.equal(await readFile(path.join(t.path, 'SKILL.md'), 'utf8'), 'optbrew 0.1.0\n');
});

test('doctor does not report interrupted installation as healthy', async () => {
  const f = await fixture();
  await update({ bundleRoot: f.next, recordRoot: f.recordRoot, faultHook: p => { if (p === 'before_record_replace') throw new Error('stop'); } });
  const result = await doctor({ scope: 'user', home: f.home, agents: ['codex', 'claude-code'] });
  assert.ok(result.targets.every(t => !t.hash_ok));
  assert.ok(result.warnings.some(w => w.includes('recovery_required')));
});

test('an edit just before record replacement cannot be reported as success', async () => {
  const f = await fixture();
  const target = path.join(f.record.targets[0].path, 'SKILL.md');
  const result = await update({ bundleRoot: f.next, recordRoot: f.recordRoot, faultHook: async p => {
    if (p === 'before_record_replace') await writeFile(target, 'late user edit');
  } });
  assert.equal(result.status, 'recovery_required');
  assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.1.0');
  assert.equal((await recoverTransaction(f.recordRoot)).status, 'recovery_required');
  assert.equal(await readFile(target, 'utf8'), 'late user edit');
});

for (const command of ['update', 'rollback']) test(`${command} CLI recovers a dead owner before journal creation`, async t => {
  const f = await fixture();
  if (command === 'rollback') assert.equal((await update({ bundleRoot: f.next, recordRoot: f.recordRoot })).status, 'updated');
  const recordBefore = await readFile(path.join(f.recordRoot, 'install-record.json'), 'utf8');
  const moduleUrl = pathToFileURL(path.resolve('lib/update.mjs')).href;
  const script = `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
    const original = fs.cp; fs.cp = async (from, to, ...rest) => { if (to.endsWith('.stage')) process.exit(74); return original(from, to, ...rest); }; syncBuiltinESMExports();
    const { update, rollback } = await import(${JSON.stringify(moduleUrl)});
    if (process.argv[3] === 'update') await update({ bundleRoot: process.argv[1], recordRoot: process.argv[2] });
    else await rollback({ recordRoot: process.argv[2], releaseVersion: '0.1.0' });`;
  const argv = ['--input-type=module', '-e', script, f.next, f.recordRoot, command];
  const child = spawnSync(process.execPath, argv, { encoding: 'utf8' });
  t.diagnostic(JSON.stringify({ argv: [process.execPath, ...argv], cwd: process.cwd(), child_status: child.status, child_stdout: child.stdout, child_stderr: child.stderr }));
  assert.equal(child.status, 74);
  assert.equal(child.stderr, '');
  await assert.rejects(lstat(path.join(f.recordRoot, 'transaction.json')), { code: 'ENOENT' });
  const deadOwner = JSON.parse(await readFile(path.join(f.recordRoot, 'install.lock'), 'utf8'));
  assert.equal(deadOwner.pid, child.pid);
  assert.equal(await readFile(path.join(f.recordRoot, 'install-record.json'), 'utf8'), recordBefore);
  const snapshots = await readdir(path.join(f.recordRoot, 'releases'));
  let output = '', error = '';
  const args = [command, '--record-root', f.recordRoot, '--json'];
  if (command === 'rollback') args.push('--release-version', '0.1.0');
  const exit = await main(args, { bundleRoot: f.next, stdout: { write: s => output += s }, stderr: { write: s => error += s } });
  assert.equal(exit, 0, error);
  assert.equal(JSON.parse(output).status, command === 'update' ? 'updated' : 'rolled_back');
  await assert.rejects(lstat(path.join(f.recordRoot, 'install.lock')), { code: 'ENOENT' });
  const retained = await readdir(path.join(f.recordRoot, 'releases'));
  assert.ok(snapshots.every(id => retained.includes(id)));
  for (const p of f.preserved) assert.equal(await readFile(p, 'utf8'), `private ${path.basename(p)}`);
});

for (const owner of ['active', 'unknown']) test(`journal-free ${owner} lock is preserved by update CLI`, async () => {
  const f = await fixture();
  const lockFile = path.join(f.recordRoot, 'install.lock');
  const content = owner === 'active' ? JSON.stringify({ pid: process.pid, token: 'active-test-owner' }) : '';
  await writeFile(lockFile, content);
  const before = await readFile(path.join(f.recordRoot, 'install-record.json'), 'utf8');
  let error = '';
  assert.equal(await main(['update', '--record-root', f.recordRoot], { bundleRoot: f.next, stdout: { write() {} }, stderr: { write: s => error += s } }), 1);
  assert.match(error, owner === 'active' ? /lock already held/ : /unknown lock owner/);
  assert.equal(await readFile(lockFile, 'utf8'), content);
  assert.equal(await readFile(path.join(f.recordRoot, 'install-record.json'), 'utf8'), before);
  for (const target of f.record.targets) assert.equal(await readFile(path.join(target.path, 'SKILL.md'), 'utf8'), 'optbrew 0.1.0\n');
});

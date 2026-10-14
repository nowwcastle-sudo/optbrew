import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { install } from '../lib/install.mjs';
import { update, rollback } from '../lib/update.mjs';
import { doctor } from '../lib/doctor.mjs';
import { main } from '../lib/cli.mjs';
import { readInstallRecord } from '../lib/records.mjs';
import { isDistributedBundlePath } from '../skills/optbrew/scripts/core/bundle.mjs';
import { seal } from './fixtures/releases/create.mjs';
import { extractPublished, root, skipUnreachable } from './support/published-011.mjs';

const currentBundle = path.join(root, 'skills', 'optbrew');
const currentManifest = async () => JSON.parse(await readFile(path.join(currentBundle, 'bundle-manifest.json'), 'utf8'));
const agents = ['codex', 'claude-code'];

async function oldInstall(temp, old, { scope = 'user', strategies = { codex: 'copy', 'claude-code': 'copy' } } = {}) {
  const home = path.join(temp, 'home');
  const project = path.join(temp, 'site');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const where = scope === 'user' ? { scope, home } : { scope, projectRoot: project };
  let installed;
  for (const agent of agents) installed = await old.install({ bundleRoot: old.bundle, agents: [agent], strategy: strategies[agent], ...where });
  const scopeRoot = scope === 'user' ? home : project;
  await mkdir(path.join(scopeRoot, '.optbrew/runs'), { recursive: true });
  await writeFile(path.join(scopeRoot, '.optbrew/runs/run.json'), 'private run evidence');
  return { home, project, scopeRoot, where, recordRoot: installed.record.managed_root, record: installed.record };
}

test('managed update of the published 0.1.1 install is refused with migration_required and exact reinstall steps', { skip: skipUnreachable }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew update from 0.1.1 '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const old = await extractPublished(temp);
  const next = await currentManifest();
  assert.equal(next.release_version, '0.1.2');
  assert.equal(next.evaluation_version, '0.2.0');
  assert.equal(next.protocol_version, old.manifest.protocol_version, 'protocol sources are unchanged');
  assert.notEqual(next.evaluation_version, old.manifest.evaluation_version);
  const f = await oldInstall(temp, old);

  await assert.rejects(update({ bundleRoot: currentBundle, recordRoot: f.recordRoot }), error => {
    const text = error.message;
    assert.match(text, /^migration_required: evaluation_version changed/);
    assert.ok(text.includes('0.1.1') && text.includes('0.1.2'), text);
    assert.ok(text.includes(f.recordRoot), 'names the managed root to delete');
    for (const target of f.record.targets) assert.ok(text.includes(target.path), `names ${target.path}`);
    assert.match(text, /Remove-Item -Recurse -Force -LiteralPath/);
    assert.match(text, /rm -r -- /);
    for (const target of f.record.targets) assert.ok(text.includes(`optbrew install --agents ${target.agent} --scope user --home`) && text.includes(`--strategy ${target.strategy}`), text);
    assert.match(text, /optbrew doctor --agents codex,claude-code --scope user/);
    assert.match(text, /runs/);
    assert.match(text, /docs\/platforms\.md/);
    return true;
  });

  // The refusal changed nothing.
  const record = await readInstallRecord(f.recordRoot);
  assert.equal(record.release_version, '0.1.1');
  assert.equal(record.bundle_hash, old.manifest.bundle_hash);
  const report = await doctor({ home: f.home, scope: 'user', agents });
  assert.ok(report.targets.every(x => x.file_present && x.registered && !x.hash_ok), 'doctor cannot vouch for a bundle built for another evaluation version');
  assert.ok(report.warnings.some(w => /migration_required/.test(w) && /Reinstall after a migration_required update/.test(w)), report.warnings.join('\n'));
  assert.equal(await readFile(path.join(f.home, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');

  // The CLI reports the same refusal with a nonzero exit code.
  let err = '';
  const code = await main(['update', '--record-root', f.recordRoot, '--json'], { bundleRoot: currentBundle, stdout: { write() {} }, stderr: { write: s => err += s } });
  assert.equal(code, 1);
  assert.match(err, /^migration_required: evaluation_version changed/);
});

// Shell commands come from docs/platforms.md; README.md and README.ko.md must carry the identical blocks.
const blockPattern = /```(powershell|bash) (user|project)\n([\s\S]*?)```/g;
async function documentedBlocks(file) {
  const text = await readFile(path.join(root, file), 'utf8');
  return Object.fromEntries([...text.matchAll(blockPattern)].map(m => [`${m[1]} ${m[2]}`, m[3]]));
}
const documented = await documentedBlocks('docs/platforms.md');

test('the reinstall command blocks are identical in docs/platforms.md, README.md and README.ko.md', async () => {
  assert.deepEqual(Object.keys(documented).sort(), ['bash project', 'bash user', 'powershell project', 'powershell user']);
  for (const file of ['README.md', 'README.ko.md']) assert.deepEqual(await documentedBlocks(file), documented, file);
});

function shellCommand(shell) {
  if (shell === 'bash') {
    const gitBash = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync);
    const command = process.platform === 'win32' ? gitBash : 'bash';
    return command && spawnSync(command, ['-c', 'true']).status === 0 ? command : null;
  }
  for (const command of process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh']) {
    if (spawnSync(command, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0) return command;
  }
  return null;
}

const shells = [];
for (const shell of ['powershell', 'bash']) for (const command of shell === 'powershell' && process.platform === 'win32' ? ['pwsh', 'powershell'] : [null]) {
  const resolved = command ? (spawnSync(command, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0 ? command : null) : shellCommand(shell);
  if (resolved) shells.push({ shell, command: resolved });
}

for (const { shell, command } of shells) for (const [scope, mixed] of [['user', false], ['project', true]]) {
  test(`documented ${shell} reinstall (${command}, ${scope} scope, ${mixed ? 'link+copy' : 'copy'}) replaces a published 0.1.1 install and keeps runs`, { skip: skipUnreachable }, async t => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew reinstall 한글 '));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const old = await extractPublished(temp);
    const strategies = mixed ? { codex: 'copy', 'claude-code': 'link' } : { codex: 'copy', 'claude-code': 'copy' };
    const f = await oldInstall(temp, old, { scope, strategies });
    const next = await currentManifest();
    let block = documented[`${shell} ${scope}`];
    if (scope === 'project') {
      assert.ok(block.includes('./site'), 'project block names the project folder once');
      block = block.replaceAll('./site', f.project.replaceAll('\\', '/'));
    }
    const env = { ...process.env, HOME: f.home, USERPROFILE: f.home };
    let run;
    if (shell === 'bash') run = spawnSync(command, ['-c', block], { cwd: root, env, encoding: 'utf8' });
    else {
      const script = path.join(temp, 'reinstall.ps1');
      await writeFile(script, `﻿${block}`); // BOM so Windows PowerShell 5.1 reads the Korean temp path as UTF-8
      run = spawnSync(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: root, env, encoding: 'utf8' });
    }
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    const record = await readInstallRecord(f.recordRoot);
    assert.equal(record.release_version, '0.1.2');
    assert.equal(record.bundle_hash, next.bundle_hash);
    assert.equal(record.transaction.state, 'committed');
    assert.deepEqual(record.targets.map(x => [x.agent, x.strategy]), agents.map(a => [a, strategies[a]]));
    const report = await doctor({ agents, ...f.where });
    assert.ok(report.targets.length === 2 && report.targets.every(x => x.registered && x.hash_ok), JSON.stringify(report));
    assert.match(run.stdout, /"hash_ok":true/);
    assert.equal(await readFile(path.join(f.scopeRoot, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');
  });
}

test('updates and rollbacks keep working inside 0.1.2', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew update within 0.1.2 '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  await mkdir(home);
  const current = await currentManifest();
  const next = path.join(temp, 'next');
  await cp(currentBundle, next, { recursive: true, filter: p => isDistributedBundlePath(path.relative(currentBundle, p)) });
  await writeFile(path.join(next, 'SKILL.md'), `${await readFile(path.join(next, 'SKILL.md'), 'utf8')}\nSynthetic follow-up release.\n`);
  await seal(next, '0.1.3');
  const installed = await install({ bundleRoot: currentBundle, home, scope: 'user', agents, strategy: 'copy' });
  const recordRoot = installed.record.managed_root;
  await mkdir(path.join(home, '.optbrew/runs'), { recursive: true });
  await writeFile(path.join(home, '.optbrew/runs/run.json'), 'private run evidence');

  const updated = await update({ bundleRoot: next, recordRoot });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.record.release_version, '0.1.3');
  assert.equal(updated.record.previous_releases.at(-1).release_version, '0.1.2');
  assert.ok((await doctor({ home, scope: 'user', agents })).targets.every(x => x.hash_ok));
  const restored = await rollback({ recordRoot, releaseVersion: '0.1.2' });
  assert.equal(restored.status, 'rolled_back');
  assert.equal(restored.record.release_version, '0.1.2');
  assert.equal(restored.record.bundle_hash, current.bundle_hash);
  assert.ok((await doctor({ home, scope: 'user', agents })).targets.every(x => x.hash_ok));
  assert.equal(await readFile(path.join(home, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');
});

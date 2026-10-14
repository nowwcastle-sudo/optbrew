import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, after, describe, it } from 'node:test';
import { doctor } from '../lib/doctor.mjs';
import { main } from '../lib/cli.mjs';
import { readInstallRecord } from '../lib/records.mjs';
import { extractPublished, releasePublished, root, skipUnreachable } from './support/published-011.mjs';

after(releasePublished);
const currentManifest = async () => JSON.parse(await readFile(path.join(root, 'skills/optbrew/bundle-manifest.json'), 'utf8'));
const agents = ['codex', 'claude-code'];

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

test('the documented blocks delete only what the validated plan prints and never resolve the home or read the record themselves', () => {
  for (const [name, block] of Object.entries(documented)) {
    assert.match(block, /reinstall-plan/, `${name} asks the node CLI for the validated plan`);
    assert.doesNotMatch(block, /\$HOME|\$env:|USERPROFILE|~\//, `${name} does not resolve the home directory itself`);
    assert.doesNotMatch(block, /install-record\.json|ConvertFrom-Json/, `${name} does not read the install record itself`);
    assert.ok(block.indexOf('reinstall-plan') < block.search(/Remove-Item|rm -r/), `${name} validates before it deletes`);
  }
});

const shells = [];
for (const [shell, commands] of [['powershell', process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh']], ['bash', [null]]]) for (const command of commands) {
  let resolved = null;
  if (shell === 'bash') {
    const gitBash = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync);
    const candidate = process.platform === 'win32' ? gitBash : 'bash';
    if (candidate && spawnSync(candidate, ['-c', 'true']).status === 0) resolved = candidate;
  } else if (spawnSync(command, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0) resolved = command;
  if (resolved) shells.push({ shell, command: resolved });
}

async function sandbox(t, { scope = 'project', strategies = { codex: 'copy', 'claude-code': 'copy' } } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew reinstall 한글 '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const old = await extractPublished();
  const home = path.join(temp, 'home'), project = path.join(temp, 'site');
  await mkdir(home, { recursive: true }); await mkdir(project, { recursive: true });
  const where = scope === 'user' ? { scope, home } : { scope, projectRoot: project };
  let installed;
  for (const agent of agents) installed = await old.install({ bundleRoot: old.bundle, agents: [agent], strategy: strategies[agent], ...where });
  const scopeRoot = scope === 'user' ? home : project;
  await mkdir(path.join(scopeRoot, '.optbrew/runs'), { recursive: true });
  await writeFile(path.join(scopeRoot, '.optbrew/runs/run.json'), 'private run evidence');
  return { temp, home, project, scopeRoot, where, recordRoot: installed.record.managed_root, targets: installed.record.targets };
}

async function spawnIn({ shell, command, text, f, env, cwd }) {
  if (shell === 'bash') return spawnSync(command, ['-c', text], { cwd, env, encoding: 'utf8' });
  const script = path.join(f.temp, `block-${Math.random().toString(36).slice(2)}.ps1`);
  await writeFile(script, `\uFEFF${text}`);
  return spawnSync(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd, env, encoding: 'utf8' });
}

/**
 * Run a documented block literally; the only substitution is the project folder placeholder. A user-scope block deletes
 * things, so a read-only plan runs first in the same shell and the block runs only if that shell resolves the sandbox home.
 */
async function runBlock({ shell, command, scope, f, env = {}, cwd = root }) {
  let block = documented[`${shell} ${scope}`];
  if (scope === 'project') {
    assert.ok(block.includes('./site'), 'project block names the project folder once');
    block = block.replaceAll('./site', f.project.replaceAll('\\', '/'));
  }
  const full = { ...process.env, HOME: f.home, USERPROFILE: f.home, ...env };
  for (const key of Object.keys(full)) if (full[key] === undefined) delete full[key];
  if (scope === 'user') {
    const probe = await spawnIn({ shell, command, text: 'node bin/optbrew.mjs reinstall-plan --scope user', f, env: full, cwd });
    const resolved = probe.stdout.split(/\r?\n/).find(line => line.startsWith('delete-dir\t'))?.split('\t')[1] ?? '';
    assert.ok(probe.status === 0 && resolved.toLowerCase().startsWith(f.home.toLowerCase()),
      `refusing to run: this shell would not use the sandbox home (${resolved || probe.stderr.trim()})`);
  }
  return spawnIn({ shell, command, text: block, f, env: full, cwd });
}

describe('documented reinstall blocks, run literally in every available shell', { concurrency: 6 }, () => {
  for (const { shell, command } of shells) for (const [scope, mixed] of [['user', false], ['project', true]]) {
    it(`${shell} (${command}, ${scope} scope, ${mixed ? 'link+copy' : 'copy'}) replaces a published 0.1.1 install and keeps runs`, { skip: skipUnreachable }, async t => {
      const strategies = mixed ? { codex: 'copy', 'claude-code': 'link' } : { codex: 'copy', 'claude-code': 'copy' };
      const f = await sandbox(t, { scope, strategies });
      const next = await currentManifest();
      const run = await runBlock({ shell, command, scope, f });
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

  // T1 (absolute path outside the project) and T6 (a junction that no longer leads to the managed bundle) in every shell.
  for (const { shell, command } of shells) for (const name of ['T1', 'T6']) {
    it(`${shell} (${command}) deletes nothing for a tampered record: ${name}`, { skip: skipUnreachable }, async t => {
      const f = await sandbox(t);
      const v = await tamperRecord(t, f, name);
      const run = await runBlock({ shell, command, scope: 'project', f });
      assert.notEqual(run.status, 0, `the block must fail\n${run.stdout}\n${run.stderr}`);
      await assertNothingDeleted(f, v);
      assert.match(`${run.stdout}${run.stderr}`, /reinstall plan refused/);
    });
  }

  for (const { shell, command } of shells) {
    it(`${shell} (${command}) uses the home directory the node CLI uses, whatever USERPROFILE says`, { skip: skipUnreachable }, async t => {
      const f = await sandbox(t, { scope: 'user' });
      // A decoy home with its own record: a block that trusted USERPROFILE (or the shell's $HOME) would act on it.
      const decoy = path.join(f.temp, 'decoy');
      await mkdir(path.join(decoy, '.optbrew/installs/user'), { recursive: true });
      await writeFile(path.join(decoy, '.optbrew/installs/user/install-record.json'), '{}');
      const run = await runBlock({ shell, command, scope: 'user', f, env: { HOME: f.home, USERPROFILE: decoy } });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.1.2');
      assert.equal(await readFile(path.join(decoy, '.optbrew/installs/user/install-record.json'), 'utf8'), '{}', 'the decoy is untouched');
    });
    // PowerShell leaves the environment alone, so node falls back to USERPROFILE. (Git Bash would invent a HOME of its own.)
    if (process.platform === 'win32' && shell === 'powershell') it(`${shell} (${command}) follows USERPROFILE when HOME is not set, as the node CLI does`, { skip: skipUnreachable }, async t => {
      const f = await sandbox(t, { scope: 'user' });
      const run = await runBlock({ shell, command, scope: 'user', f, env: { HOME: undefined, USERPROFILE: f.home } });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.1.2');
    });
    it(`${shell} (${command}) can be run again after a partial failure`, { skip: skipUnreachable }, async t => {
      const f = await sandbox(t);
      // The first run got as far as deleting the first target and then stopped; the record and the second target remain.
      await rm(f.targets[0].path, { recursive: true, force: true });
      const run = await runBlock({ shell, command, scope: 'project', f });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const report = await doctor({ agents, ...f.where });
      assert.ok(report.targets.every(x => x.registered && x.hash_ok), JSON.stringify(report));
      assert.equal((await readInstallRecord(f.recordRoot)).release_version, '0.1.2');
      assert.equal(await readFile(path.join(f.project, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');
    });
  }
});

// T1-T6: a tampered install record must abort before anything is deleted.
async function tamperRecord(t, f, name) {
  const victim = path.join(f.temp, 'victim');
  await mkdir(victim); await writeFile(path.join(victim, 'precious.txt'), 'keep');
  const relative = `optbrew-tamper-relvictim-${Math.random().toString(36).slice(2)}`;
  const relVictim = path.join(root, relative);
  await mkdir(relVictim); await writeFile(path.join(relVictim, 'precious.txt'), 'keep');
  t.after(() => rm(relVictim, { recursive: true, force: true }));
  const recordFile = path.join(f.recordRoot, 'install-record.json');
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  const first = record.targets[0];
  const second = record.targets[1].path;
  if (name === 'T1') first.path = victim;
  else if (name === 'T2') first.path = relative;
  else if (name === 'T3') first.path = '';
  else if (name === 'T4') first.path = `${f.project}/.agents/skills/optbrew/../../../../${path.basename(victim)}`.replaceAll('\\', '/');
  else if (name === 'T5') first.path = path.join(f.project, '.agents', 'skills', 'other');
  else if (name === 'T6') { await rm(first.path, { recursive: true, force: true }); await symlink(victim, first.path, 'junction'); first.strategy = 'link'; }
  else throw new Error(name);
  await writeFile(recordFile, JSON.stringify(record, null, 2));
  return { victim, relVictim, second, recordFile };
}
async function assertNothingDeleted(f, v) {
  assert.equal(await readFile(path.join(v.victim, 'precious.txt'), 'utf8'), 'keep', 'absolute victim kept');
  assert.equal(await readFile(path.join(v.relVictim, 'precious.txt'), 'utf8'), 'keep', 'relative victim kept');
  assert.ok(existsSync(path.join(v.second, 'SKILL.md')), 'the legitimate second target is kept');
  assert.ok(existsSync(path.join(f.recordRoot, 'bundle/SKILL.md')), 'the managed root is kept');
  assert.ok(existsSync(v.recordFile), 'the install record is kept');
  assert.equal(await readFile(path.join(f.project, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');
}

describe('reinstall-plan refuses a tampered install record before anything could be deleted', { concurrency: 6 }, () => {
  for (const name of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) {
    it(`${name}`, { skip: skipUnreachable }, async t => {
      const f = await sandbox(t);
      const v = await tamperRecord(t, f, name);
      let out = '', err = '';
      const code = await main(['reinstall-plan', '--scope', 'project', '--project', f.project], { cwd: root, stdout: { write: s => out += s }, stderr: { write: s => err += s } });
      assert.equal(code, 1);
      assert.equal(out, '', 'a refused plan prints nothing to delete');
      assert.match(err, /^reinstall plan refused: /);
      await assertNothingDeleted(f, v);
    });
  }
  it('an untouched record prints the targets first, the managed root last, then the installs and the doctor agents', { skip: skipUnreachable }, async t => {
    const f = await sandbox(t, { strategies: { codex: 'copy', 'claude-code': 'link' } });
    let out = '';
    const code = await main(['reinstall-plan', '--scope', 'project', '--project', f.project], { cwd: root, stdout: { write: s => out += s }, stderr: { write() {} } });
    assert.equal(code, 0);
    const rows = out.trimEnd().split('\n').map(line => line.split('\t'));
    assert.deepEqual(rows, [['delete-dir', f.targets[0].path], ['delete-link', f.targets[1].path], ['delete-dir', f.recordRoot],
      ['install', 'codex', 'copy'], ['install', 'claude-code', 'link'], ['agents', 'codex,claude-code']]);
  });
});

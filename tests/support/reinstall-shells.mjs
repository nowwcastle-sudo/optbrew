import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractPublished, root } from './published.mjs';

export const agents = ['codex', 'claude-code'];
export const currentManifest = async () => JSON.parse(await readFile(path.join(root, 'skills/optbrew/bundle-manifest.json'), 'utf8'));

// Shell commands come from docs/platforms.md; the READMEs link there instead of carrying copies.
const blockPattern = /```(powershell|bash) (user|project)\n([\s\S]*?)```/g;
export async function documentedBlocks(file) {
  const text = await readFile(path.join(root, file), 'utf8');
  return Object.fromEntries([...text.matchAll(blockPattern)].map(m => [`${m[1]} ${m[2]}`, m[3]]));
}
export const documented = await documentedBlocks('docs/platforms.md');

/** Shells available on this machine: every PowerShell edition and Git Bash (never the WSL launcher). */
export const shells = [];
for (const [shell, commands] of [['powershell', process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh']], ['bash', [null]]]) for (const command of commands) {
  let resolved = null;
  if (shell === 'bash') {
    const gitBash = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync);
    const candidate = process.platform === 'win32' ? gitBash : 'bash';
    if (candidate && spawnSync(candidate, ['-c', 'true']).status === 0) resolved = candidate;
  } else if (spawnSync(command, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0) resolved = command;
  if (resolved) shells.push({ shell, command: resolved });
}
export const shellNamed = (shell, command) => shells.filter(x => x.shell === shell && (!command || x.command === command));

/** A published 0.1.2 install in a sandbox, installed by the 0.1.2 CLI itself. */
export async function sandbox(t, { scope = 'project', strategies = { codex: 'copy', 'claude-code': 'copy' } } = {}) {
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
export async function runBlock({ shell, command, scope, f, env = {}, cwd = root }) {
  let block = documented[`${shell} ${scope}`];
  if (scope === 'project') {
    assert.ok(block.includes('./site'), 'project block names the project folder once');
    block = block.replaceAll('./site', f.project.replaceAll('\\', '/'));
  }
  // PowerShell keeps a module cache under the local application data folder; keep it out of the working directory.
  const full = { ...process.env, HOME: f.home, USERPROFILE: f.home, PSModuleAnalysisCachePath: path.join(f.temp, 'ModuleAnalysisCache'), ...env };
  for (const key of Object.keys(full)) if (full[key] === undefined) delete full[key];
  if (scope === 'user') {
    const probe = await spawnIn({ shell, command, text: 'node bin/optbrew.mjs reinstall-plan --scope user', f, env: full, cwd });
    const resolved = probe.stdout.split(/\r?\n/).find(line => line.startsWith('delete-dir\t'))?.split('\t')[1] ?? '';
    assert.ok(probe.status === 0 && resolved.toLowerCase().startsWith(f.home.toLowerCase()),
      `refusing to run: this shell would not use the sandbox home (${resolved || probe.stderr.trim()})`);
  }
  return spawnIn({ shell, command, text: block, f, env: full, cwd });
}

/** T1-T6: tamper with the install record (or a target) so that the documented block must abort before it deletes. */
export async function tamperRecord(t, f, name) {
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
  else if (name === 'T7') first.path = `${first.path}${String.fromCharCode(10)}${victim}`;
  else if (name === 'T8') first.path = `${first.path}${String.fromCharCode(9)}${victim}`;
  else if (name === 'T9') first.path = `${first.path}${String.fromCharCode(27)}[2J`;
  else if (name === 'T6') { await rm(first.path, { recursive: true, force: true }); await symlink(victim, first.path, 'junction'); first.strategy = 'link'; }
  else throw new Error(name);
  await writeFile(recordFile, JSON.stringify(record, null, 2));
  return { victim, relVictim, second, recordFile };
}
export async function assertNothingDeleted(f, v) {
  assert.equal(await readFile(path.join(v.victim, 'precious.txt'), 'utf8'), 'keep', 'absolute victim kept');
  assert.equal(await readFile(path.join(v.relVictim, 'precious.txt'), 'utf8'), 'keep', 'relative victim kept');
  assert.ok(existsSync(path.join(v.second, 'SKILL.md')), 'the legitimate second target is kept');
  assert.ok(existsSync(path.join(f.recordRoot, 'bundle/SKILL.md')), 'the managed root is kept');
  assert.ok(existsSync(v.recordFile), 'the install record is kept');
  assert.equal(await readFile(path.join(f.project, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');
  assert.equal(existsSync(path.join(root, 'Microsoft')), false, 'no PowerShell cache leaked into the working directory');
}

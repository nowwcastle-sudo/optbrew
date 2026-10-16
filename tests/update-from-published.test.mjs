import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { install } from '../lib/install.mjs';
import { update, rollback } from '../lib/update.mjs';
import { doctor } from '../lib/doctor.mjs';
import { main } from '../lib/cli.mjs';
import { readInstallRecord } from '../lib/records.mjs';
import { isDistributedBundlePath } from '../skills/optbrew/scripts/core/bundle.mjs';
import { seal } from './fixtures/releases/create.mjs';
import { extractPublished, extractPublished013, releasePublished, root, skipUnreachable, skipUnreachable013 } from './support/published.mjs';

after(releasePublished);

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

test('managed update of the published 0.1.2 install is refused with migration_required and exact reinstall steps', { skip: skipUnreachable, timeout: 540000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew update from 0.1.2 '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const old = await extractPublished();
  const next = await currentManifest();
  assert.equal(next.release_version, '0.1.4');
  assert.equal(next.evaluation_version, '0.3.0');
  assert.equal(next.protocol_version, old.manifest.protocol_version, 'protocol sources are unchanged');
  assert.notEqual(next.evaluation_version, old.manifest.evaluation_version);
  const f = await oldInstall(temp, old);

  await assert.rejects(update({ bundleRoot: currentBundle, recordRoot: f.recordRoot }), error => {
    const text = error.message;
    assert.match(text, /^migration_required: evaluation_version changed/);
    assert.ok(text.includes('0.1.2') && text.includes('0.1.4'), text);
    assert.ok(text.includes(f.recordRoot), 'names the managed root to delete');
    for (const target of f.record.targets) assert.ok(text.includes(target.path), `names ${target.path}`);
    assert.match(text, /Remove-Item -Recurse -Force -LiteralPath/);
    assert.match(text, /rm -r -- /);
    assert.match(text, /optbrew reinstall-plan --scope user --home/, 'the read-only check comes first');
    // Targets are deleted first and the managed root, which holds the install record, last.
    const posixLine = text.split('\n').find(line => line.includes('rm -r -- '));
    assert.ok(posixLine.indexOf(f.record.targets[0].path) < posixLine.indexOf(f.recordRoot) && posixLine.indexOf(f.record.targets[1].path) < posixLine.indexOf(f.recordRoot), posixLine);
    assert.ok(text.indexOf('reinstall-plan') < text.indexOf('rm -r -- '));
    for (const target of f.record.targets) assert.ok(text.includes(`optbrew install --agents ${target.agent} --scope user --home`) && text.includes(`--strategy ${target.strategy}`), text);
    assert.match(text, /optbrew doctor --agents codex,claude-code --scope user/);
    assert.match(text, /runs/);
    assert.match(text, /docs\/platforms\.md/);
    return true;
  });

  // The refusal changed nothing.
  const record = await readInstallRecord(f.recordRoot);
  assert.equal(record.release_version, '0.1.2');
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

test('managed update of the published 0.1.3 install is refused: its protocol sources lack limits.json, evaluation version kept', { skip: skipUnreachable013, timeout: 540000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew update from 0.1.3 '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const old = await extractPublished013(temp);
  const next = await currentManifest();
  assert.equal(next.evaluation_version, old.manifest.evaluation_version, 'evaluation version is unchanged');
  assert.equal(next.protocol_version, old.manifest.protocol_version, 'protocol version is unchanged');
  const f = await oldInstall(temp, old);

  await assert.rejects(update({ bundleRoot: currentBundle, recordRoot: f.recordRoot }), error => {
    const text = error.message;
    assert.match(text, /^migration_required: evaluation_version changed/);
    assert.ok(text.includes('0.1.3') && text.includes('0.1.4'), text);
    assert.match(text, /optbrew reinstall-plan --scope user --home/);
    assert.match(text, /docs\/platforms\.md/);
    return true;
  });

  // The refusal changed nothing; the current CLI no longer recognizes the 0.1.3 protocol source list, so doctor reports migration_required.
  const record = await readInstallRecord(f.recordRoot);
  assert.equal(record.release_version, '0.1.3');
  assert.equal(record.bundle_hash, old.manifest.bundle_hash);
  const report = await doctor({ home: f.home, scope: 'user', agents });
  assert.ok(report.targets.every(x => x.file_present && x.registered && !x.hash_ok));
  assert.ok(report.warnings.some(w => /migration_required/.test(w)), report.warnings.join('\n'));
  assert.equal(await readFile(path.join(f.home, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');
});

test('updates and rollbacks keep working inside 0.1.4', { timeout: 540000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew update within 0.1.4 '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  await mkdir(home);
  const current = await currentManifest();
  const next = path.join(temp, 'next');
  await cp(currentBundle, next, { recursive: true, filter: p => isDistributedBundlePath(path.relative(currentBundle, p)) });
  await writeFile(path.join(next, 'SKILL.md'), `${await readFile(path.join(next, 'SKILL.md'), 'utf8')}\nSynthetic follow-up release.\n`);
  await seal(next, '0.1.5');
  const installed = await install({ bundleRoot: currentBundle, home, scope: 'user', agents: ['codex'], strategy: 'copy' });
  const recordRoot = installed.record.managed_root;
  await mkdir(path.join(home, '.optbrew/runs'), { recursive: true });
  await writeFile(path.join(home, '.optbrew/runs/run.json'), 'private run evidence');

  const updated = await update({ bundleRoot: next, recordRoot });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.record.release_version, '0.1.5');
  assert.equal(updated.record.previous_releases.at(-1).release_version, '0.1.4');
  assert.ok((await doctor({ home, scope: 'user', agents: ['codex'] })).targets.every(x => x.hash_ok));
  const restored = await rollback({ recordRoot, releaseVersion: '0.1.4' });
  assert.equal(restored.status, 'rolled_back');
  assert.equal(restored.record.release_version, '0.1.4');
  assert.equal(restored.record.bundle_hash, current.bundle_hash);
  assert.ok((await doctor({ home, scope: 'user', agents: ['codex'] })).targets.every(x => x.hash_ok));
  assert.equal(await readFile(path.join(home, '.optbrew/runs/run.json'), 'utf8'), 'private run evidence');
});

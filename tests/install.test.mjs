import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, realpath, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createBundleManifest, verifyBundle } from '../skills/optbrew/scripts/core/bundle.mjs';
import { install } from '../lib/install.mjs';
import { resolveTargets } from '../lib/paths.mjs';

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

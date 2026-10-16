import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from '../../support/temp-dir.mjs';
import { createBundleManifest } from '../../../skills/optbrew/scripts/core/bundle.mjs';
import { install } from '../../../lib/install.mjs';

export async function release(root, version) {
  const bundleRoot = path.join(root, `release-${version}`);
  await mkdir(bundleRoot, { recursive: true });
  await writeFile(path.join(bundleRoot, 'SKILL.md'), `optbrew ${version}\n`);
  await writeFile(path.join(bundleRoot, 'source-lock.json'), JSON.stringify({ schema_version: '1.0.0', modules: [], files: [] }));
  await mkdir(path.join(bundleRoot, 'references'));
  await writeFile(path.join(bundleRoot, 'references/check-registry.json'), JSON.stringify({ evaluation_version: '0.1.0' }));
  await seal(bundleRoot, version);
  return bundleRoot;
}
export async function seal(bundleRoot, version) {
  await writeFile(path.join(bundleRoot, 'bundle-manifest.json'), JSON.stringify(await createBundleManifest({ bundleRoot, releaseVersion: version })));
}
export async function fixture(strategy = 'copy') {
  const root = await tempDir('optbrew update 한글 (9) ');
  const home = path.join(root, 'home');
  const old = await release(root, '0.1.0');
  const next = await release(root, '0.1.1');
  const result = await install({ bundleRoot: old, home, scope: 'user', agents: ['codex', 'claude-code'], strategy });
  const recordRoot = result.record.managed_root;
  const preserved = [path.join(home, '.claude/settings.json'), path.join(home, '.optbrew/keys.json'), path.join(home, '.optbrew/runs/run.json')];
  for (const f of preserved) { await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, `private ${path.basename(f)}`); }
  return { root, home, old, next, recordRoot, preserved, record: result.record };
}

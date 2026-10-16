import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The published 0.1.2 release (tag v0.1.2, bundle_hash 780e3eb5..., evaluation 0.2.0).
export const published = 'v0.1.2';
export const reachable = spawnSync('git', ['cat-file', '-e', `${published}^{commit}`], { cwd: root }).status === 0;
export const skipUnreachable = reachable ? false : 'published 0.1.2 tag is not in this clone';

let shared = null;
/** Remove the extracted copy of the published release; call it from an `after` hook of the test file. */
export function releasePublished() {
  if (shared) rmSync(shared.checkout, { recursive: true, force: true });
  shared = null;
}

/**
 * Extract the published 0.1.2 bundle, its CLI and its scoring fixtures once per test file. The extraction is read-only
 * for every test, so tests share it instead of repeating the slow git archive and unzip.
 */
export async function extractPublished() {
  if (shared) return shared;
  const checkout = await tempDir('optbrew published 0.1.2 ');
  const archive = path.join(checkout, 'published.zip');
  const made = spawnSync('git', ['archive', '--format=zip', '-o', archive, published, 'skills/optbrew', 'lib', 'bin', 'package.json', 'tests/fixtures/scoring'], { cwd: root });
  assert.equal(made.status, 0, String(made.stderr));
  const extract = spawnSync('python', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, path.join(checkout, 'tree')], { encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr);
  const tree = path.join(checkout, 'tree');
  const bundle = path.join(tree, 'skills', 'optbrew');
  const manifest = JSON.parse(await readFile(path.join(bundle, 'bundle-manifest.json'), 'utf8'));
  assert.equal(manifest.release_version, '0.1.2');
  assert.match(manifest.bundle_hash, /^780e3eb5/);
  // A real 0.1.2 user installed with the 0.1.2 CLI; the current CLI no longer verifies a 0.1.2 bundle.
  const install = async options => (await import(pathToFileURL(path.join(tree, 'lib/install.mjs')).href)).install(options);
  shared = { checkout, tree, bundle, manifest, install, fixtures: path.join(tree, 'tests', 'fixtures', 'scoring') };
  return shared;
}

// The published 0.1.3 release (tag v0.1.3, bundle_hash c0c5e24d..., evaluation 0.3.0).
export const published013 = 'v0.1.3';
export const skipUnreachable013 = spawnSync('git', ['cat-file', '-e', `${published013}^{commit}`], { cwd: root }).status === 0
  ? false : 'published 0.1.3 tag is not in this clone';

/** Extract the published 0.1.3 bundle and CLI into `checkout`; the caller removes it. */
export async function extractPublished013(checkout) {
  const archive = path.join(checkout, 'published-0.1.3.zip');
  const made = spawnSync('git', ['archive', '--format=zip', '-o', archive, published013, 'skills/optbrew', 'lib', 'bin', 'package.json'], { cwd: root });
  assert.equal(made.status, 0, String(made.stderr));
  const tree = path.join(checkout, 'tree-0.1.3');
  const extract = spawnSync('python', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, tree], { encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr);
  const bundle = path.join(tree, 'skills', 'optbrew');
  const manifest = JSON.parse(await readFile(path.join(bundle, 'bundle-manifest.json'), 'utf8'));
  assert.equal(manifest.release_version, '0.1.3');
  assert.match(manifest.bundle_hash, /^c0c5e24d/);
  const install = async options => (await import(pathToFileURL(path.join(tree, 'lib/install.mjs')).href)).install(options);
  return { tree, bundle, manifest, install };
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Source commit of the published 0.1.1 release (bundle_hash 2945f112...).
export const published = '5391752';
export const reachable = spawnSync('git', ['cat-file', '-e', `${published}^{commit}`], { cwd: root }).status === 0;
export const skipUnreachable = reachable ? false : 'published 0.1.1 commit is not in this clone';

/** Extract the published 0.1.1 bundle and its scoring fixtures into `temp/old`. */
export async function extractPublished(temp) {
  const archive = path.join(temp, 'published.zip');
  const made = spawnSync('git', ['archive', '--format=zip', '-o', archive, published, 'skills/optbrew', 'lib', 'bin', 'package.json', 'tests/fixtures/scoring'], { cwd: root });
  assert.equal(made.status, 0, String(made.stderr));
  const extract = spawnSync('python', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, path.join(temp, 'old')], { encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr);
  const bundle = path.join(temp, 'old', 'skills', 'optbrew');
  const manifest = JSON.parse(await readFile(path.join(bundle, 'bundle-manifest.json'), 'utf8'));
  assert.equal(manifest.release_version, '0.1.1');
  assert.match(manifest.bundle_hash, /^2945f112/);
  const checkout = path.join(temp, 'old');
  // A real 0.1.1 user installed with the 0.1.1 CLI; the current CLI no longer verifies a 0.1.1 bundle.
  const install = async options => (await import(pathToFileURL(path.join(checkout, 'lib/install.mjs')).href)).install(options);
  return { checkout, bundle, manifest, install, fixtures: path.join(checkout, 'tests', 'fixtures', 'scoring') };
}

import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDistributedBundlePath } from '../../skills/optbrew/scripts/core/bundle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const made = [];

/**
 * A private copy of everything a release build, verify and npm pack read. Tests that call buildRelease work on this copy,
 * never on the repository, so a build in one test can never rewrite a manifest another test is reading.
 */
export async function copyReleaseTree() {
  const dest = await mkdtemp(path.join(os.tmpdir(), 'optbrew release copy '));
  made.push(dest);
  for (const name of ['package.json', 'package-lock.json', 'plugin.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'source-lock.json', 'README.md', 'README.ko.md',
    'CHANGELOG.md', 'bin', 'lib', 'scripts', '.codex-plugin', '.claude-plugin', 'docs/platforms.md', 'docs/release.md'])
    await cp(path.join(repo, name), path.join(dest, name), { recursive: true });
  const bundle = path.join(repo, 'skills/optbrew');
  await cp(bundle, path.join(dest, 'skills/optbrew'), { recursive: true, filter: file => isDistributedBundlePath(path.relative(bundle, file)) });
  return dest;
}

/** Remove every copy made by this test file; call it from an `after` hook. */
export async function removeReleaseCopies() {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
}

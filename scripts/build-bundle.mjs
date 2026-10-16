import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBundleManifest } from '../skills/optbrew/scripts/core/bundle.mjs';
import { versions } from '../skills/optbrew/scripts/core/config.mjs';
import { writeManifestAtomic } from './write-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv[0] !== '--bundle' || !(argv.length === 2 || (argv.length === 4 && argv[2] === '--version'))) {
  process.stderr.write('usage: build-bundle.mjs --bundle <directory> [--version <semver>]\n');
  process.exitCode = 2;
} else {
  const bundleRoot = path.resolve(root, argv[1]);
  createBundleManifest({ bundleRoot, releaseVersion: argv[3] ?? versions().release }).then(async manifest => {
    await writeManifestAtomic(bundleRoot, manifest);
    process.stdout.write(`${manifest.bundle_hash} ${manifest.files.length} files\n`);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

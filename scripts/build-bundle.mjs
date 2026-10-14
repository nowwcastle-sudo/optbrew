import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBundleManifest } from '../skills/optbrew/scripts/core/bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.length !== 4 || argv[0] !== '--bundle' || argv[2] !== '--version') {
  process.stderr.write('usage: build-bundle.mjs --bundle <directory> --version <semver>\n');
  process.exitCode = 2;
} else {
  const bundleRoot = path.resolve(root, argv[1]);
  createBundleManifest({ bundleRoot, releaseVersion: argv[3] }).then(async manifest => {
    // Write beside the bundle (never inside it, where a concurrent build would hash the file) and rename over the
    // manifest, so a concurrent reader sees the complete old or the complete new file, never an empty one.
    const temp = path.join(path.dirname(bundleRoot), `.bundle-manifest.${process.pid}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
      // Windows refuses to replace a file another process has open at that instant; retry for a short while.
      for (let attempt = 0; ; attempt++) {
        try { await rename(temp, path.join(bundleRoot, 'bundle-manifest.json')); break; }
        catch (error) {
          if (attempt >= 100 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
    } finally { await rm(temp, { force: true }); }
    process.stdout.write(`${manifest.bundle_hash} ${manifest.files.length} files\n`);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

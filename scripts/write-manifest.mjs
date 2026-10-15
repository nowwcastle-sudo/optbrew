import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Replace bundle-manifest.json through a temporary file beside the bundle (never inside it, where a concurrent build
 * would hash the file) and a rename, so a concurrent reader sees the complete old or the complete new file, never an
 * empty one.
 */
export async function writeManifestAtomic(bundleRoot, manifest) {
  const temp = path.join(path.dirname(bundleRoot), `.bundle-manifest.${process.pid}.${Date.now()}.tmp`);
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
}

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBundleManifest, evaluationSourcePaths, protocolSourcePaths } from '../skills/optbrew/scripts/core/bundle.mjs';
import { releaseMetadataErrors } from './verify-release.mjs';
import { writeManifestAtomic } from './write-manifest.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Build the standalone skill ZIP from the same bytes named by the bundle manifest. */
export async function buildRelease({ root = projectRoot, version, outputDir = path.join(root, 'dist') }) {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json')));
  if (packageJson.version !== version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('release version differs from package.json');
  const metadataErrors = await releaseMetadataErrors(root, version);
  if (metadataErrors.length) throw new Error(`release metadata mismatch: ${JSON.stringify(metadataErrors)}`);
  const bundleRoot = path.join(root, 'skills', 'optbrew');
  await copyFile(path.join(root, 'LICENSE'), path.join(bundleRoot, 'LICENSE'));
  const notices = await readFile(path.join(bundleRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'),
    notices.replace(/\]\(licenses\//g, '](skills/optbrew/licenses/'));
  await copyFile(path.join(bundleRoot, 'source-lock.json'), path.join(root, 'source-lock.json'));
  const manifest = await createBundleManifest({ bundleRoot, releaseVersion: version });
  if (manifest.evaluation_sources.length !== evaluationSourcePaths.length ||
      manifest.protocol_sources.length !== protocolSourcePaths.length)
    throw new Error('release lacks canonical evaluation or protocol sources');
  await writeManifestAtomic(bundleRoot, manifest);
  await mkdir(outputDir, { recursive: true });
  const skill_zip = path.join(outputDir, `optbrew-${version}.zip`);
  const names = [...manifest.files.map(file => file.path), 'bundle-manifest.json'];
  const script = `import json, pathlib, sys, zipfile\nroot=pathlib.Path(sys.argv[1]); names=json.loads(sys.argv[3])\nwith zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.ZIP_DEFLATED) as z:\n for name in names: z.write(root/name, 'optbrew/'+name)\n`;
  const zip = spawnSync('python', ['-c', script, bundleRoot, skill_zip, JSON.stringify(names)], { encoding: 'utf8' });
  if (zip.status !== 0) throw new Error(`ZIP creation failed: ${zip.stderr || zip.error?.message}`);
  return { version, skill_zip, npm_tarball: null, plugin_root: root,
    hashes: { skill_zip: hash(await readFile(skill_zip)), bundle: manifest.bundle_hash,
      evaluation: manifest.evaluation_hash, protocol: manifest.protocol_hash } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--version' || args[2] !== '--output-dir') {
    process.stderr.write('usage: build-release.mjs --version <version> --output-dir <directory>\n');
    process.exitCode = 2;
  } else buildRelease({ root: projectRoot, version: args[1], outputDir: path.resolve(args[3]) })
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

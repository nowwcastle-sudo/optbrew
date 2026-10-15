import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestName = 'bundle-manifest.json';
export const evaluationSourcePaths = ['references/check-registry.json', 'references/profiles.json',
  'references/scoring.md', 'references/measurement.md', 'scripts/core/score.mjs', 'scripts/core/weights.mjs',
  'scripts/core/contracts.mjs', 'scripts/core/compare.mjs', 'scripts/core/metrics.mjs', 'scripts/core/bootstrap.mjs'];
export const protocolSourcePaths = ['references/schemas/contract.schema.json', 'scripts/core/protocol.mjs'];

/** Match the package.json skill exclusions for generated Python cache files. */
export function isDistributedBundlePath(relative) {
  const parts = relative.split(/[\\/]/);
  return !parts.some(part => ['__pycache__', 'tests', 'evals'].includes(part) || part.startsWith('_백업_원본_')) &&
    !relative.endsWith('.pyc') && !/^test_.*\.py$/.test(parts.at(-1));
}

async function listFiles(root, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (name === manifestName) continue;
    if (!isDistributedBundlePath(name)) continue;
    if (entry.isDirectory()) result.push(...await listFiles(root, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`bundle contains link or special file: ${name}`);
  }
  return result.sort();
}

/** Hash every distributed file; the manifest never hashes itself. */
export async function createBundleManifest({ bundleRoot, releaseVersion }) {
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(releaseVersion)) throw new Error('invalid release version');
  const files = [];
  for (const name of await listFiles(bundleRoot)) {
    files.push({ path: name, sha256: digest(await readFile(path.join(bundleRoot, name))) });
  }
  // Synthetic install fixtures contain only SKILL.md; production release checks completeness.
  const selected = paths => paths.every(name => files.some(file => file.path === name))
    ? paths.map(name => files.find(file => file.path === name)) : [];
  const evaluation_sources = selected(evaluationSourcePaths);
  const protocol_sources = selected(protocolSourcePaths);
  const identity = evaluation_sources.length && protocol_sources.length ? {
    evaluation_version: '0.3.0', protocol_version: '0.1.0',
    evaluation_sources, evaluation_hash: digest(JSON.stringify(evaluation_sources)),
    protocol_sources, protocol_hash: digest(JSON.stringify(protocol_sources)) } : {};
  return { schema_version: '1.0.0', release_version: releaseVersion,
    ...identity, files, bundle_hash: digest(JSON.stringify(files)) };
}

/** Verify the exact allowlist, byte hashes, and aggregate hash. */
export async function verifyBundle({ bundleRoot, manifest }) {
  const errors = [];
  let actual;
  try { actual = await createBundleManifest({ bundleRoot, releaseVersion: manifest?.release_version }); }
  catch (error) { return { status: 'invalid', checked_files: 0, errors: [{ path: '', code: error.message }], bundle_hash: null }; }
  if (!Array.isArray(manifest?.files) || manifest.schema_version !== '1.0.0') errors.push({ path: manifestName, code: 'invalid_manifest' });
  const expected = new Map(Array.isArray(manifest?.files) ? manifest.files.map(f => [f.path, f.sha256]) : []);
  const found = new Map(actual.files.map(f => [f.path, f.sha256]));
  if (expected.size !== manifest?.files?.length) errors.push({ path: manifestName, code: 'duplicate_path' });
  for (const [name, sha] of found) {
    if (!expected.has(name)) errors.push({ path: name, code: 'unexpected_file' });
    else if (expected.get(name) !== sha) errors.push({ path: name, code: 'hash_mismatch' });
  }
  for (const name of expected.keys()) if (!found.has(name)) errors.push({ path: name, code: 'missing_file' });
  if (manifest?.bundle_hash !== actual.bundle_hash ||
      JSON.stringify(manifest?.files) !== JSON.stringify(actual.files)) errors.push({ path: manifestName, code: 'bundle_hash_mismatch' });
  for (const field of ['evaluation_version', 'protocol_version', 'evaluation_sources', 'protocol_sources', 'evaluation_hash', 'protocol_hash'])
    if (JSON.stringify(manifest?.[field]) !== JSON.stringify(actual[field]))
      errors.push({ path: manifestName, code: field.endsWith('_version') ? 'migration_required' : `${field}_mismatch` });
  return { status: errors.length ? 'invalid' : 'valid', checked_files: actual.files.length, errors, bundle_hash: actual.bundle_hash };
}

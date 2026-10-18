import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { versions } from './config.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
/** Hash a file as committed: a checkout with core.autocrlf may turn LF into CRLF. A NUL byte marks a binary file, hashed as is. */
export const fileDigest = bytes => digest(bytes.includes(0) ? bytes : Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1'));
const manifestName = 'bundle-manifest.json';
/**
 * The files whose bytes decide a verdict or a score: the registry, profiles and scoring rules, the code that turns evidence into
 * verdicts (derive, every check, the index-target, judgment, fact, link and page-selection rules, the vendored Naver audit) and the
 * Korean catalog the verdict sentences come from. A bundle that changes any of them has a different `evaluation_hash` (T22 S1).
 * `checks/*` is listed file by file; a test fails when a file is added to that folder and not here.
 */
export const evaluationSourcePaths = ['references/check-registry.json', 'references/profiles.json',
  'references/scoring.md', 'references/measurement.md', 'references/messages.ko.json', 'scripts/core/score.mjs', 'scripts/core/weights.mjs',
  'scripts/core/contracts.mjs', 'scripts/core/compare.mjs', 'scripts/core/metrics.mjs', 'scripts/core/bootstrap.mjs',
  'scripts/core/derive.mjs', 'scripts/core/index-targets.mjs', 'scripts/core/judgments.mjs', 'scripts/core/facts.mjs',
  'scripts/core/link-graph.mjs', 'scripts/core/page-select.mjs', 'modules/naver-searchadvisor/scripts/audit.mjs',
  ...['canonical-consistency', 'crawl-policy', 'cwv-field', 'discovery', 'document-title', 'entity-identity', 'fact-consistency', 'fetch-response',
    'index-policy', 'index', 'internal-navigation', 'locale-links', 'naver-markup', 'observation', 'prepare', 'render-content',
    'structured-data-truth'].map(name => `scripts/core/checks/${name}.mjs`)];
export const protocolSourcePaths = ['references/schemas/contract.schema.json', 'references/limits.json', 'scripts/core/protocol.mjs'];

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

/** Hash every distributed file; the manifest never hashes itself. `sources` names the identity files; verification passes the lists a manifest recorded. */
export async function createBundleManifest({ bundleRoot, releaseVersion, sources = { evaluation: evaluationSourcePaths, protocol: protocolSourcePaths } }) {
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(releaseVersion)) throw new Error('invalid release version');
  const files = [];
  for (const name of await listFiles(bundleRoot)) {
    files.push({ path: name, sha256: fileDigest(await readFile(path.join(bundleRoot, name))) });
  }
  // Synthetic install fixtures contain only SKILL.md; production release checks completeness.
  const selected = paths => paths.every(name => files.some(file => file.path === name))
    ? paths.map(name => files.find(file => file.path === name)) : [];
  const evaluation_sources = selected(sources.evaluation);
  const protocol_sources = selected(sources.protocol);
  const identity = evaluation_sources.length && protocol_sources.length ? {
    evaluation_version: versions().evaluation, protocol_version: versions().protocol,
    evaluation_sources, evaluation_hash: digest(JSON.stringify(evaluation_sources)),
    protocol_sources, protocol_hash: digest(JSON.stringify(protocol_sources)) } : {};
  return { schema_version: versions().bundle_manifest_schema, release_version: releaseVersion,
    ...identity, files, bundle_hash: digest(JSON.stringify(files)) };
}

const recordedPaths = (list, fallback) => Array.isArray(list) ? list.map(file => file?.path) : fallback;

/** Verify the exact allowlist, byte hashes, and aggregate hash. Identity is recomputed over the source lists the manifest recorded, so an older bundle with fewer sources still verifies. */
export async function verifyBundle({ bundleRoot, manifest }) {
  const errors = [];
  let actual;
  try { actual = await createBundleManifest({ bundleRoot, releaseVersion: manifest?.release_version, sources: {
    evaluation: recordedPaths(manifest?.evaluation_sources, evaluationSourcePaths), protocol: recordedPaths(manifest?.protocol_sources, protocolSourcePaths) } }); }
  catch (error) { return { status: 'invalid', checked_files: 0, errors: [{ path: '', code: error.message }], bundle_hash: null }; }
  if (!Array.isArray(manifest?.files) || manifest.schema_version !== versions().bundle_manifest_schema) errors.push({ path: manifestName, code: 'invalid_manifest' });
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

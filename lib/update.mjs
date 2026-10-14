import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBundleManifest } from '../skills/optbrew/scripts/core/bundle.mjs';
import { readInstallRecord, writeDurableJson, writeInstallRecord } from './records.mjs';
import { reinstallGuidance } from './reinstall.mjs';
import { assertManagedPath, copyBundle, fingerprint, finishJournal, managedRename, operationPaths,
  readJournal, recoverTransaction, statOrNull, validateScope, verifiedBundle, withScopeLock } from './transaction.mjs';

const versionPattern = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
function compareVersions(a, b) {
  const parse = v => v.split('+')[0].split('-');
  const [aBase, ...aPre] = parse(a), [bBase, ...bPre] = parse(b);
  const x = aBase.split('.').map(Number), y = bBase.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  if (!aPre.length || !bPre.length) return Math.sign(bPre.length - aPre.length);
  const ap = aPre.join('-').split('.'), bp = bPre.join('-').split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue;
    if (ap[i] === undefined || bp[i] === undefined) return ap[i] === undefined ? -1 : 1;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) return Math.sign(Number(ap[i]) - Number(bp[i]));
    if (an !== bn) return an ? -1 : 1;
    return ap[i] < bp[i] ? -1 : 1;
  }
  return 0;
}

/** Registry metadata only. An explicitly confirmed package name is required. */
export async function checkUpdates({ packageName, currentVersion, registryTransport }) {
  if (!versionPattern.test(currentVersion)) throw new TypeError('invalid current version');
  if (!packageName) return { current_version: currentVersion, latest_version: null, status: 'local_only', source_ref: 'bundled release; registry package unconfirmed' };
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(packageName)) throw new TypeError('invalid registry package name');
  const source_ref = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
  const transport = registryTransport ?? (async () => {
    const response = await fetch(source_ref, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
    return response.json();
  });
  const metadata = await transport(packageName);
  const latest = metadata?.['dist-tags']?.latest;
  if (!versionPattern.test(latest)) throw new Error('registry latest version missing or invalid');
  return { current_version: currentVersion, latest_version: latest, status: compareVersions(latest, currentVersion) > 0 ? 'update_available' : 'current', source_ref };
}

function matchesRecord(manifest, record) {
  return manifest.bundle_hash === record.bundle_hash && manifest.release_version === record.release_version &&
    JSON.stringify(Object.fromEntries(manifest.files.map(f => [f.path, f.sha256]))) === JSON.stringify(record.file_hashes);
}

async function inspect(recordRoot, record, localChanges) {
  const scopeRoot = await validateScope(recordRoot, record);
  if (record.transaction.state !== 'committed') throw new Error('recovery_required: pending initial install; finish optbrew install first');
  const conflicts = [];
  const bundle = path.join(recordRoot, 'bundle');
  for (const target of [{ path: bundle, strategy: 'copy' }, ...record.targets]) {
    await assertManagedPath(scopeRoot, target.path);
    const stat = await statOrNull(target.path);
    if (target.strategy === 'link') {
      if (!stat?.isSymbolicLink() || await realpath(target.path) !== await realpath(bundle)) throw new Error(`link ownership changed: ${target.path}`);
      continue;
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`copy ownership changed: ${target.path}`);
    // Hash the current bytes against the recorded allowlist, never trust a rewritten manifest.
    const actual = await createBundleManifest({ bundleRoot: target.path, releaseVersion: record.release_version });
    const manifestPath = path.join(target.path, 'bundle-manifest.json');
    if ((await lstat(manifestPath)).isSymbolicLink()) throw new Error('manifest ownership changed');
    const saved = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!matchesRecord(actual, record) || !matchesRecord(saved, record)) conflicts.push({ path: target.path, reason: 'recorded file hashes or manifest changed' });
  }
  if (conflicts.length && localChanges === 'abort') throw new Error(`local changes: ${conflicts.map(c => c.path).join(', ')}; use --local-changes backup-and-replace to preserve and replace`);
  return { scopeRoot, conflicts };
}

async function compatible(previous, next) {
  // No migration is shipped. Changes to the persisted schema or evaluation contract require one.
  const contractFiles = ['references/schemas/contract.schema.json', 'references/check-registry.json',
    'references/profiles.json', 'references/scoring.md', 'references/measurement.md', 'scripts/core/score.mjs',
    'scripts/core/weights.mjs', 'scripts/core/protocol.mjs', 'scripts/core/contracts.mjs',
    'scripts/core/compare.mjs', 'scripts/core/metrics.mjs', 'scripts/core/bootstrap.mjs'];
  for (const name of contractFiles) {
    const old = previous.files.find(f => f.path === name)?.sha256;
    const current = next.files.find(f => f.path === name)?.sha256;
    if (old !== current) throw new Error(`migration_required: ${name} changed; use a release with an explicit migration before updating this scope`);
  }
  for (const field of ['evaluation_version', 'protocol_version']) {
    if (previous[field] !== next[field]) throw new Error(`migration_required: ${field} changed or became unknown`);
  }
}

async function applyRelease({ bundleRoot, recordRoot, localChanges, faultHook, kind, expectedSnapshot }) {
  if (!['abort', 'backup-and-replace'].includes(localChanges)) throw new TypeError('localChanges must be abort or backup-and-replace');
  recordRoot = path.resolve(recordRoot);
  const original = await readInstallRecord(recordRoot);
  if (!original) throw new Error('install record missing');
  await validateScope(recordRoot, original);
  if (await readJournal(recordRoot)) {
    const recovery = await recoverTransaction(recordRoot);
    return { status: recovery.status === 'recovery_required' ? 'recovery_required' : 'recovered', record: await readInstallRecord(recordRoot), changed_paths: [], decision: { recovery, instruction: 'rerun the requested update after recovery' }, verification: null };
  }
  return withScopeLock(recordRoot, async () => {
    // A different writer may have left a journal between preflight and lock acquisition.
    if (await readJournal(recordRoot)) throw new Error('recovery_required: transaction appeared; rerun update or rollback to recover');
    const before = await readInstallRecord(recordRoot);
    const { scopeRoot, conflicts } = await inspect(recordRoot, before, localChanges);
    const source = await verifiedBundle(bundleRoot);
    if (expectedSnapshot && (source.manifest.bundle_hash !== expectedSnapshot.bundle_hash || source.manifest.release_version !== expectedSnapshot.release_version)) throw new Error('rollback snapshot identity mismatch');
    if (source.manifest.release_version === before.release_version && source.manifest.bundle_hash !== before.bundle_hash) throw new Error('release version reused with different bundle');
    if (kind === 'update' && compareVersions(source.manifest.release_version, before.release_version) < 0) throw new Error('older bundle requires rollback');
    if (source.manifest.bundle_hash === before.bundle_hash && source.manifest.release_version === before.release_version && !conflicts.length) return { status: 'unchanged', record: before, changed_paths: [], decision: {}, verification: source.verification };
    const managed = path.join(recordRoot, 'bundle');
    let previousRoot = managed;
    if (conflicts.some(c => c.path === managed)) previousRoot = before.source;
    // The guard stays as is. A refusal for another evaluation version carries the exact manual reinstall steps.
    const refuse = error => {
      if (!/migration_required/.test(error.message)) throw error;
      const reason = error.message.startsWith('migration_required') ? error.message
        : 'migration_required: evaluation_version changed (the installed bundle was built for another evaluation version)';
      throw new Error(`${reason}\n${reinstallGuidance({ record: before, recordRoot, from: before.release_version, to: source.manifest.release_version })}`);
    };
    const previous = await verifiedBundle(previousRoot).catch(refuse);
    if (!matchesRecord(previous.manifest, before)) throw new Error('previous verified bundle unavailable; preserve edits and recover original release first');
    await compatible(previous.manifest, source.manifest).catch(refuse);
    const id = randomUUID();
    const snapshotRoot = path.join(recordRoot, 'releases', id, 'bundle');
    await assertManagedPath(scopeRoot, snapshotRoot);
    await mkdir(path.dirname(snapshotRoot), { recursive: true });
    const snapshot = await copyBundle(previousRoot, snapshotRoot);
    if (!matchesRecord(snapshot.manifest, before)) throw new Error('previous snapshot integrity failed');
    const operations = [];
    for (const destination of [managed, ...before.targets.filter(t => t.strategy === 'copy').map(t => t.path)]) {
      const op = operationPaths(destination, id);
      await assertManagedPath(scopeRoot, op.staging);
      if (await statOrNull(op.previous) || await statOrNull(op.staging)) throw new Error('transaction staging already exists');
      const staged = await copyBundle(bundleRoot, op.staging);
      if (JSON.stringify(staged.manifest) !== JSON.stringify(source.manifest)) throw new Error('staged bundle identity changed');
      operations.push({ ...op, before_hash: await fingerprint(destination), after_hash: await fingerprint(op.staging) });
    }
    const decision = { local_changes: localChanges, conflicts, backups: operations.map(op => ({ path: op.path, backup: op.previous })) };
    const after = { ...before, release_version: source.manifest.release_version, bundle_hash: source.manifest.bundle_hash,
      source: path.resolve(bundleRoot), file_hashes: Object.fromEntries(source.manifest.files.map(f => [f.path, f.sha256])),
      previous_releases: [...before.previous_releases, { release_version: before.release_version, bundle_hash: before.bundle_hash, bundle_root: snapshotRoot }],
      transaction: { state: 'committed', id, kind, conflicts, backups: decision.backups } };
    const journal = { schema_version: '1.0.0', id, state: 'prepared', before, after, operations };
    await writeDurableJson(path.join(recordRoot, 'transaction.json'), journal);
    try {
      await faultHook?.('after_staging');
      // Reinspect after staging so edits made while preparing cannot be silently overwritten.
      await inspect(recordRoot, before, localChanges);
      for (const [index, op] of operations.entries()) {
        if (await fingerprint(op.path) !== op.before_hash || await fingerprint(op.staging) !== op.after_hash) throw new Error('local changes during transaction preparation');
        await managedRename(scopeRoot, op.path, op.previous);
        if (await fingerprint(op.previous) !== op.before_hash) throw new Error('backup readback failed');
        await managedRename(scopeRoot, op.staging, op.path);
        if (await fingerprint(op.path) !== op.after_hash) throw new Error('target readback failed');
        if (index === 1 || (index === 0 && operations.length === 1)) await faultHook?.('after_first_target');
      }
      await faultHook?.('before_record_replace');
      await inspect(recordRoot, after, 'abort');
      if (JSON.stringify(await readInstallRecord(recordRoot)) !== JSON.stringify(before)) throw new Error('install record changed during transaction');
      await writeInstallRecord(recordRoot, after);
      if (JSON.stringify(await readInstallRecord(recordRoot)) !== JSON.stringify(after)) throw new Error('record readback failed');
      await inspect(recordRoot, after, 'abort');
      await finishJournal(recordRoot, journal, 'committed');
      return { status: kind === 'rollback' ? 'rolled_back' : 'updated', record: after, changed_paths: [managed, ...after.targets.map(t => t.path)], decision, verification: source.verification };
    } catch (error) {
      return { status: 'recovery_required', record: await readInstallRecord(recordRoot), changed_paths: [], decision: { ...decision, error: error.message, recovery: 'rerun update or call recoverTransaction(recordRoot)', journal: path.join(recordRoot, 'transaction.json') }, verification: null };
    }
  }, { recover: true });
}

/** Apply this running, locally verified release; obtaining npm packages is the caller's job. */
export async function update({ bundleRoot, recordRoot, localChanges = 'abort', faultHook }) {
  return applyRelease({ bundleRoot, recordRoot, localChanges, faultHook, kind: 'update' });
}

export async function rollback({ recordRoot, releaseVersion, faultHook }) {
  recordRoot = path.resolve(recordRoot);
  const record = await readInstallRecord(recordRoot);
  if (!record) throw new Error('install record missing');
  const scopeRoot = await validateScope(recordRoot, record);
  if (await readJournal(recordRoot)) return applyRelease({ recordRoot, localChanges: 'abort', faultHook, kind: 'rollback' });
  const snapshot = [...record.previous_releases].reverse().find(r => r.release_version === releaseVersion);
  if (!snapshot) throw new Error('verified previous release not found');
  const relative = path.relative(path.join(recordRoot, 'releases'), snapshot.bundle_root);
  if (!/^[a-f0-9-]{36}[\\/]bundle$/.test(relative)) throw new Error('rollback snapshot outside managed releases');
  await assertManagedPath(scopeRoot, snapshot.bundle_root);
  return applyRelease({ bundleRoot: snapshot.bundle_root, recordRoot, localChanges: 'abort', faultHook, kind: 'rollback', expectedSnapshot: snapshot });
}

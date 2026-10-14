import { cp, lstat, mkdir, open, readFile, readlink, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createBundleManifest, isDistributedBundlePath, verifyBundle } from '../skills/optbrew/scripts/core/bundle.mjs';
import { readInstallRecord, validateInstallRecord, writeDurableJson, writeInstallRecord } from './records.mjs';
import { resolveTargets, scopePaths } from './paths.mjs';

export async function statOrNull(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Check the resolved absolute parent immediately before every managed rename. */
export async function assertManagedPath(scopeRoot, destination) {
  scopeRoot = path.resolve(scopeRoot);
  destination = path.resolve(destination);
  const relative = path.relative(scopeRoot, destination);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`outside managed scope: ${destination}`);
  let current = path.parse(scopeRoot).root;
  for (const part of path.relative(current, path.dirname(destination)).split(path.sep)) {
    current = path.join(current, part);
    const stat = await statOrNull(current);
    if (stat?.isSymbolicLink()) throw new Error(`linked ancestor: ${current}`);
    if (stat && !stat.isDirectory()) throw new Error(`invalid ancestor: ${current}`);
    if (stat && path.resolve(await realpath(current)).toLowerCase() !== current.toLowerCase()) throw new Error(`resolved path changed: ${current}`);
  }
}

export async function validateScope(recordRoot, record) {
  validateInstallRecord(record);
  const match = /^(user|project):(.+)$/.exec(record.scope_id);
  if (!match) throw new Error('invalid record scope');
  const [, scope, scopeRoot] = match;
  const options = { scope, home: scopeRoot, projectRoot: scopeRoot };
  if (scopePaths(options).managedRoot !== recordRoot || record.managed_root !== recordRoot) throw new Error('install record scope mismatch');
  await assertManagedPath(scopeRoot, path.join(recordRoot, 'install-record.json'));
  const agents = record.targets.map(t => t.agent);
  if (new Set(agents).size !== agents.length) throw new Error('duplicate record target');
  for (const target of record.targets) {
    const expected = resolveTargets({ ...options, agents: [target.agent] })[0];
    if (target.path !== expected.path || target.managed_target !== expected.managed_target || !['copy', 'link'].includes(target.strategy)) throw new Error('install record target ownership mismatch');
    await assertManagedPath(scopeRoot, target.path);
  }
  return scopeRoot;
}

export async function verifiedBundle(bundleRoot) {
  if (!(await lstat(bundleRoot)).isDirectory() || (await lstat(bundleRoot)).isSymbolicLink()) throw new Error('bundle ownership: expected real directory');
  if ((await lstat(path.join(bundleRoot, 'bundle-manifest.json'))).isSymbolicLink()) throw new Error('manifest is a link');
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'bundle-manifest.json'), 'utf8'));
  if (manifest.schema_version !== '1.0.0') throw new Error('migration_required: unsupported bundle manifest schema');
  const verification = await verifyBundle({ bundleRoot, manifest });
  if (verification.status !== 'valid') throw new Error(`bundle integrity failed: ${JSON.stringify(verification.errors)}`);
  const lock = JSON.parse(await readFile(path.join(bundleRoot, 'source-lock.json'), 'utf8'));
  if (lock.schema_version !== '1.0.0' || !Array.isArray(lock.files) || !Array.isArray(lock.modules)) throw new Error('invalid source-lock');
  const hashes = new Map(manifest.files.map(f => [f.path, f.sha256]));
  const seen = new Set();
  for (const file of lock.files) {
    const name = file.package_path?.startsWith('skills/optbrew/') ? file.package_path.slice('skills/optbrew/'.length) : null;
    if (!name || seen.has(name) || (isDistributedBundlePath(name) && hashes.get(name) !== file.distributed_sha256))
      throw new Error('source-lock hash/mapping mismatch');
    seen.add(name);
  }
  return { manifest, verification };
}

export async function copyBundle(source, destination) {
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true, dereference: false,
    filter: file => isDistributedBundlePath(path.relative(source, file)) });
  return verifiedBundle(destination);
}

/** Fingerprint bytes, including the manifest, to recognize pre/post rename states. */
export async function fingerprint(file) {
  const stat = await statOrNull(file);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `link:${await readlink(file)}`;
  if (!stat.isDirectory()) throw new Error(`unexpected managed path type: ${file}`);
  const manifest = await createBundleManifest({ bundleRoot: file, releaseVersion: '0.0.0' });
  const meta = await readFile(path.join(file, 'bundle-manifest.json'));
  return createHash('sha256').update(manifest.bundle_hash).update(meta).digest('hex');
}

export async function withScopeLock(recordRoot, action, { recover = false } = {}) {
  const file = path.join(recordRoot, 'install.lock');
  let handle;
  try { handle = await open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!recover || (await lstat(file)).isSymbolicLink()) throw new Error('scope install lock already held');
    // Serialize stale-owner reclamation so two recoverers cannot remove a new live lock.
    const reclaimPath = path.join(recordRoot, 'recovery.lock');
    const reclaim = await open(reclaimPath, 'wx');
    try {
      let owner;
      try { owner = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('recovery_required: unknown lock owner'); }
      if (!Number.isInteger(owner.pid) || owner.pid < 1 || !owner.token) throw new Error('recovery_required: unknown lock owner');
      try { process.kill(owner.pid, 0); throw new Error('scope install lock already held'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      await rm(file);
      handle = await open(file, 'wx');
    } finally { await reclaim.close(); await rm(reclaimPath); }
  }
  const token = randomUUID();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync();
    return await action();
  } finally {
    await handle.close();
    const owner = JSON.parse(await readFile(file, 'utf8'));
    if (owner.token === token) await rm(file);
  }
}

export function operationPaths(destination, id) {
  return { path: destination, staging: `${destination}.optbrew-${id}.stage`, previous: path.join(path.dirname(destination), `_백업_원본_optbrew-${id}-${path.basename(destination)}`) };
}

export async function managedRename(scopeRoot, from, to) {
  await assertManagedPath(scopeRoot, from);
  await assertManagedPath(scopeRoot, to);
  if (await statOrNull(to)) throw new Error(`rename destination exists: ${to}`);
  await rename(from, to);
}

export async function readJournal(recordRoot) {
  const file = path.join(recordRoot, 'transaction.json');
  if (!(await statOrNull(file))) return null;
  if ((await lstat(file)).isSymbolicLink()) throw new Error('journal is a link');
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function finishJournal(recordRoot, journal, state) {
  journal.state = state;
  await writeDurableJson(path.join(recordRoot, 'transaction.json'), journal);
  const directory = path.join(recordRoot, 'transactions', journal.id);
  await mkdir(directory, { recursive: true });
  await managedRename(await validateScope(recordRoot, journal.before), path.join(recordRoot, 'transaction.json'), path.join(directory, 'receipt.json'));
}

async function recoverLocked(recordRoot) {
  const journal = await readJournal(recordRoot);
  if (!journal) return { status: 'clean', restored_version: null, unresolved_paths: [], evidence_ref: null };
  const evidence_ref = path.join(recordRoot, 'transaction.json');
  try {
    if (journal.schema_version !== '1.0.0' || !/^[a-f0-9-]{36}$/.test(journal.id) || !Array.isArray(journal.operations)) throw new Error('invalid journal');
    const scopeRoot = await validateScope(recordRoot, journal.before);
    await validateScope(recordRoot, journal.after);
    const expected = [path.join(recordRoot, 'bundle'), ...journal.before.targets.filter(t => t.strategy === 'copy').map(t => t.path)];
    if (journal.operations.length !== expected.length || journal.after.scope_id !== journal.before.scope_id || JSON.stringify(journal.after.targets) !== JSON.stringify(journal.before.targets)) throw new Error('journal target mismatch');
    for (const [i, op] of journal.operations.entries()) {
      const canonical = operationPaths(expected[i], journal.id);
      if (Object.keys(canonical).some(k => canonical[k] !== op[k])) throw new Error('journal path ownership mismatch');
      for (const p of Object.values(canonical)) await assertManagedPath(scopeRoot, p);
      const current = await fingerprint(op.path), old = await fingerprint(op.previous), staged = await fingerprint(op.staging);
      if (old !== null && old !== op.before_hash || staged !== null && staged !== op.after_hash ||
          current !== null && current !== op.before_hash && current !== op.after_hash ||
          old === null && current !== op.before_hash) throw new Error(`unresolved managed path: ${op.path}`);
    }
    const currentRecord = await readInstallRecord(recordRoot);
    if (JSON.stringify(currentRecord) !== JSON.stringify(journal.before) && JSON.stringify(currentRecord) !== JSON.stringify(journal.after)) throw new Error('install record changed during transaction');
    const snapshot = path.join(recordRoot, 'releases', journal.id, 'bundle');
    await assertManagedPath(scopeRoot, snapshot);
    const verified = await verifiedBundle(snapshot);
    if (verified.manifest.bundle_hash !== journal.before.bundle_hash || verified.manifest.release_version !== journal.before.release_version) throw new Error('previous snapshot changed');
    for (const target of journal.before.targets.filter(t => t.strategy === 'link')) {
      if (!(await statOrNull(target.path))?.isSymbolicLink() || path.resolve(path.dirname(target.path), await readlink(target.path)) !== path.join(recordRoot, 'bundle')) throw new Error(`link ownership changed: ${target.path}`);
    }
    if (journal.state === 'committed') {
      if (JSON.stringify(currentRecord) !== JSON.stringify(journal.after)) throw new Error('committed record mismatch');
      for (const op of journal.operations) if (await fingerprint(op.path) !== op.after_hash) throw new Error('committed readback mismatch');
      await finishJournal(recordRoot, journal, 'committed');
      return { status: 'committed', restored_version: journal.after.release_version, unresolved_paths: [], evidence_ref };
    }
    for (const op of [...journal.operations].reverse()) {
      if (await statOrNull(op.previous)) {
        if (await statOrNull(op.path)) {
          if (await statOrNull(op.staging)) throw new Error(`staging conflict: ${op.path}`);
          await managedRename(scopeRoot, op.path, op.staging);
        }
        await managedRename(scopeRoot, op.previous, op.path);
      }
      if (await fingerprint(op.path) !== op.before_hash) throw new Error(`restore readback failed: ${op.path}`);
    }
    await writeInstallRecord(recordRoot, journal.before);
    for (const op of journal.operations) {
      const restored = await verifiedBundle(op.path);
      if (restored.manifest.bundle_hash !== journal.before.bundle_hash || restored.manifest.release_version !== journal.before.release_version) throw new Error(`restored local edits require review: ${op.path}`);
    }
    await finishJournal(recordRoot, journal, 'recovered');
    return { status: 'recovered', restored_version: journal.before.release_version, unresolved_paths: [], evidence_ref: path.join(recordRoot, 'transactions', journal.id, 'receipt.json') };
  } catch (error) {
    return { status: 'recovery_required', restored_version: null, unresolved_paths: [error.message], evidence_ref };
  }
}

/** Never replace unknown paths, edited recovery material, or an active process's lock. */
export async function recoverTransaction(recordRoot) {
  recordRoot = path.resolve(recordRoot);
  try {
    const record = await readInstallRecord(recordRoot);
    if (!record) throw new Error('install record missing');
    await validateScope(recordRoot, record);
    return await withScopeLock(recordRoot, () => recoverLocked(recordRoot), { recover: true });
  } catch (error) { return { status: 'recovery_required', restored_version: null, unresolved_paths: [error.message], evidence_ref: path.join(recordRoot, 'transaction.json') }; }
}

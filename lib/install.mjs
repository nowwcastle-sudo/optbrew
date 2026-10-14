import { cp, lstat, mkdir, open, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { isDistributedBundlePath, verifyBundle } from '../skills/optbrew/scripts/core/bundle.mjs';
import { readInstallRecord, writeInstallRecord } from './records.mjs';
import { resolveTargets, scopePaths } from './paths.mjs';

async function statOrNull(name) {
  try { return await lstat(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function rejectLinkedAncestors(scopeRoot, destination) {
  const relative = path.relative(scopeRoot, destination);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`outside scope: ${destination}`);
  let current = scopeRoot;
  if ((await statOrNull(current))?.isSymbolicLink()) throw new Error(`scope root is a link: ${current}`);
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    if ((await statOrNull(current))?.isSymbolicLink()) throw new Error(`junction/link ancestor outside trusted scope: ${current}`);
  }
}

async function verifiedManifest(bundleRoot) {
  if ((await lstat(bundleRoot)).isSymbolicLink()) throw new Error(`bundle root is a link: ${bundleRoot}`);
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'bundle-manifest.json'), 'utf8'));
  const verification = await verifyBundle({ bundleRoot, manifest });
  if (verification.status !== 'valid') throw new Error(`bundle integrity failed: ${verification.errors.map(e => `${e.path}:${e.code}`).join(', ')}`);
  return { manifest, verification };
}

async function targetOwned(target, record, managedBundle) {
  const existing = await statOrNull(target.path);
  const saved = record?.targets.find(item => item.agent === target.agent && item.path === target.path);
  if (!existing) {
    if (saved) throw new Error(`registered target missing: ${target.path}`);
    return false;
  }
  if (!saved || saved.managed_target !== managedBundle) throw new Error(`unmanaged optbrew target exists: ${target.path}`);
  if (saved.strategy === 'link') {
    if (!existing.isSymbolicLink() || await realpath(target.path) !== await realpath(managedBundle)) throw new Error(`registered link changed: ${target.path}`);
  } else if (saved.strategy === 'copy') {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`registered copy changed: ${target.path}`);
    const check = await verifiedManifest(target.path);
    if (check.manifest.bundle_hash !== record.bundle_hash) throw new Error(`registered copy changed: ${target.path}`);
  } else throw new Error(`invalid recorded strategy: ${saved.strategy}`);
  return true;
}

/** Initial install and additive target registration; version changes belong to update. */
export async function install({ bundleRoot, agents, scope, home, projectRoot, dryRun = false, strategy = 'link' }) {
  if (!['link', 'copy'].includes(strategy)) throw new TypeError('strategy must be link or copy');
  const { scopeRoot, managedRoot } = scopePaths({ scope, home, projectRoot });
  const targets = resolveTargets({ agents, scope, home, projectRoot }).map(t => ({ ...t, strategy }));
  const source = await verifiedManifest(bundleRoot);
  for (const target of targets) await rejectLinkedAncestors(scopeRoot, target.path);
  await rejectLinkedAncestors(scopeRoot, path.join(managedRoot, 'bundle'));

  async function inspect() {
    if (await statOrNull(path.join(managedRoot, 'transaction.json'))) {
      // Single-quoted literals: neither PowerShell nor a POSIX shell expands $ or backticks inside them.
      const powershell = `'${managedRoot.replaceAll("'", "''")}'`, posix = `'${managedRoot.replaceAll("'", "'\\''")}'`;
      throw new Error(`recovery_required: interrupted transaction; run optbrew update before install. PowerShell: optbrew update --record-root ${powershell}; POSIX shell: optbrew update --record-root ${posix}`);
    }
    const record = await readInstallRecord(managedRoot);
    if (record) {
      if (record.managed_root !== managedRoot || record.scope_id !== `${scope}:${scopeRoot}`) throw new Error('install record scope mismatch');
      if (record.bundle_hash !== source.manifest.bundle_hash || record.release_version !== source.manifest.release_version) throw new Error('existing release differs; use optbrew update');
      const managed = await verifiedManifest(path.join(managedRoot, 'bundle'));
      if (managed.manifest.bundle_hash !== record.bundle_hash) throw new Error('managed bundle differs from record');
      for (const saved of record.targets) {
        const canonical = resolveTargets({ agents: [saved.agent], scope, home, projectRoot })[0];
        if (saved.path !== canonical.path || saved.managed_target !== canonical.managed_target) throw new Error('install record target path mismatch');
        await rejectLinkedAncestors(scopeRoot, saved.path);
        await targetOwned(saved, record, path.join(managedRoot, 'bundle'));
      }
    } else if (await statOrNull(path.join(managedRoot, 'bundle'))) throw new Error('unmanaged bundle exists');
    for (const target of targets) await targetOwned(target, record, path.join(managedRoot, 'bundle'));
    return record;
  }

  const before = await inspect();
  const pending = targets.filter(t => !before?.targets.some(saved => saved.agent === t.agent));
  const decision = { strategy, targets, pending: pending.map(t => t.path), release_version: source.manifest.release_version };
  if (dryRun) return { status: 'dry_run', dry_run: true, record: null, changed_paths: [], decision, verification: source.verification };

  await mkdir(managedRoot, { recursive: true });
  const lockPath = path.join(managedRoot, 'install.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('scope install lock already held'); throw error; }
  const changed = [];
  try {
    const record = await inspect();
    const toAdd = targets.filter(t => !record?.targets.some(saved => saved.agent === t.agent));
    const managedBundle = path.join(managedRoot, 'bundle');
    let next = record;
    if (!record) {
      const staging = path.join(managedRoot, `bundle.${process.pid}.${Date.now()}.tmp`);
      try {
        await cp(bundleRoot, staging, { recursive: true, errorOnExist: true, force: false, dereference: false,
          filter: sourcePath => isDistributedBundlePath(path.relative(bundleRoot, sourcePath)) });
        const copied = await verifiedManifest(staging);
        if (copied.manifest.bundle_hash !== source.manifest.bundle_hash) throw new Error('staged bundle changed');
        await rename(staging, managedBundle);
        changed.push(managedBundle);
      } finally { await rm(staging, { recursive: true, force: true }); }
      next = {
        schema_version: '1.0.0', scope_id: `${scope}:${scopeRoot}`, release_version: source.manifest.release_version,
        bundle_hash: source.manifest.bundle_hash, source: path.resolve(bundleRoot), managed_root: managedRoot,
        targets: [], file_hashes: Object.fromEntries(source.manifest.files.map(f => [f.path, f.sha256])),
        previous_releases: [], transaction: { state: 'pending' }, source_ref: 'bundle-manifest.json',
      };
      try { await writeInstallRecord(managedRoot, next); }
      catch (error) {
        // Only remove the bundle this invocation created, if no record took ownership of it.
        if (!(await readInstallRecord(managedRoot)) &&
            (await verifiedManifest(managedBundle)).manifest.bundle_hash === source.manifest.bundle_hash) {
          await rm(managedBundle, { recursive: true, force: true });
        }
        throw error;
      }
    }
    for (const target of toAdd) {
      await rejectLinkedAncestors(scopeRoot, target.path);
      if (await statOrNull(target.path)) throw new Error(`unmanaged optbrew target exists: ${target.path}`);
      await mkdir(path.dirname(target.path), { recursive: true });
      if (strategy === 'link') {
        try { await symlink(managedBundle, target.path, process.platform === 'win32' ? 'junction' : 'dir'); }
        catch (error) { throw new Error(`link unavailable for ${target.path}; retry explicitly with --strategy copy (${error.message})`); }
      } else {
        const staging = `${target.path}.${process.pid}.${Date.now()}.tmp`;
        try {
          await cp(managedBundle, staging, { recursive: true, errorOnExist: true, force: false });
          await verifiedManifest(staging);
          await rename(staging, target.path);
        } finally { await rm(staging, { recursive: true, force: true }); }
      }
      changed.push(target.path);
      next.targets = [...next.targets, target];
      next.transaction = { state: 'pending' };
      try { await writeInstallRecord(managedRoot, next); }
      catch (error) {
        // A write failure leaves the previous record intact. Undo only this newly created target.
        const current = await statOrNull(target.path);
        if (current?.isSymbolicLink() && await realpath(target.path) === await realpath(managedBundle)) await rm(target.path);
        else if (current?.isDirectory() && !current.isSymbolicLink() &&
                 (await verifiedManifest(target.path)).manifest.bundle_hash === source.manifest.bundle_hash) {
          await rm(target.path, { recursive: true });
        }
        throw error;
      }
    }
    if (next.transaction.state !== 'committed') {
      next.transaction = { state: 'committed' };
      await writeInstallRecord(managedRoot, next);
    }
    return { status: changed.length ? 'installed' : 'unchanged', dry_run: false, record: next, changed_paths: changed, decision, verification: source.verification };
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { verifyBundle } from '../skills/optbrew/scripts/core/bundle.mjs';
import { readInstallRecord } from './records.mjs';
import { resolveTargets, scopePaths } from './paths.mjs';
import { validateScope } from './transaction.mjs';

async function exists(name) {
  try { await lstat(name); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function doctor({ agents, scope, home, projectRoot }) {
  const { scopeRoot, managedRoot } = scopePaths({ scope, home, projectRoot });
  const selected = resolveTargets({ agents, scope, home, projectRoot });
  const warnings = [];
  let record;
  try { record = await readInstallRecord(managedRoot); if (record) await validateScope(managedRoot, record); }
  catch (error) { warnings.push(`install record unreadable: ${error.message}`); record = null; }
  const recoveryPending = await exists(path.join(managedRoot, 'transaction.json'));
  if (recoveryPending) warnings.push('recovery_required: interrupted transaction; rerun update/rollback to recover before use');
  if (record?.transaction?.state === 'pending') warnings.push('initial install pending: finish optbrew install before updating');
  const results = [];
  for (const target of selected) {
    const saved = record?.targets.find(t => t.agent === target.agent && t.path === target.path);
    const filePresent = await exists(path.join(target.path, 'SKILL.md'));
    let hashOk = false;
    if (filePresent && saved && record) {
      try {
        if (saved.strategy === 'link' && await realpath(target.path) !== await realpath(path.join(managedRoot, 'bundle'))) throw new Error('link target changed');
        if (saved.strategy === 'copy' && (await lstat(target.path)).isSymbolicLink()) throw new Error('copy replaced by link');
        const manifest = JSON.parse(await readFile(path.join(target.path, 'bundle-manifest.json'), 'utf8'));
        const check = await verifyBundle({ bundleRoot: target.path, manifest });
        hashOk = !recoveryPending && record.transaction.state === 'committed' && check.status === 'valid' && check.bundle_hash === record.bundle_hash && manifest.release_version === record.release_version;
      } catch (error) { warnings.push(`${target.agent}: ${error.message}`); }
    }
    results.push({ agent: target.agent, path: target.path, file_present: filePresent, hash_ok: hashOk,
      registered: Boolean(saved), session_discovery: 'not_verified', invocation_verified: 'not_verified' });
  }
  if (agents.includes('codex') || agents.includes('cursor') || agents.includes('opencode') || agents.includes('pi')) {
    warnings.push('Shared .agents skill paths may also be discovered by other hosts; only selected targets are registered here.');
  }
  if (agents.includes('pi')) warnings.push('Pi custom PI_CODING_AGENT_DIR and project trust settings are not inspected.');
  return { scope_id: `${scope}:${scopeRoot}`, release_version: record?.release_version ?? null, targets: results, warnings };
}

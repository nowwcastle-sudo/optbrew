import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readInstallRecord } from './records.mjs';
import { scopePaths } from './paths.mjs';
import { validateScope, statOrNull } from './transaction.mjs';

const powershell = value => `'${String(value).replaceAll("'", "''")}'`;
const posix = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * Read-only plan for the manual reinstall of a managed scope. It validates the install record before anything is
 * deleted: the record belongs to this scope, every recorded target is exactly the expected skills/optbrew path of its
 * agent (absolute, no "..", no linked ancestor, inside the scope), and every target that exists is what the installer
 * created (a link to the managed bundle, or a real directory holding a bundle manifest). Any failed check throws, so a
 * caller that deletes only what this returns never deletes anything for a tampered record.
 *
 * Rows: `delete-link|delete-dir <path>` (recorded targets first, the managed root last), then `install <agent> <strategy>`
 * per recorded agent in record order, then `agents <csv>` for the final doctor call.
 */
export async function reinstallPlan({ scope, home, projectRoot }) {
  const refuse = message => { throw new Error(`reinstall plan refused: ${message}`); };
  // One output line per path: a line break, tab or other control character would split a row or inject another one.
  const plain = value => typeof value === 'string' && [...value].every(ch => { const c = ch.codePointAt(0); return c > 31 && (c < 127 || c > 159) && c !== 8232 && c !== 8233; });
  const { scopeRoot, managedRoot } = scopePaths({ scope, home, projectRoot });
  if (!plain(scopeRoot) || !plain(managedRoot)) refuse('the scope path contains a control character (a line break, tab or similar)');
  const record = await readInstallRecord(managedRoot).catch(error => refuse(`install record unreadable (${error.message})`));
  if (!record) refuse(`no install record in ${managedRoot}`);
  if (record.scope_id !== `${scope}:${scopeRoot}` || record.managed_root !== managedRoot) refuse('the install record belongs to another scope');
  if (!record.targets.length) refuse('the install record lists no target');
  for (const target of record.targets) {
    if (!plain(target.path) && typeof target.path === 'string') refuse('a recorded target path contains a control character (a line break, tab or similar)');
    if (typeof target.path !== 'string' || !path.isAbsolute(target.path) || target.path.split(/[\\/]/).includes('..'))
      refuse(`recorded target is not a plain absolute path: ${JSON.stringify(target.path)}`);
  }
  try { await validateScope(managedRoot, record); }
  catch (error) { refuse(`${error.message} (expected exactly the agent's skills/optbrew path inside ${scopeRoot})`); }
  const managedBundle = path.join(managedRoot, 'bundle');
  const rows = [];
  for (const target of record.targets) {
    const found = await statOrNull(target.path);
    if (!found) continue;
    if (found.isSymbolicLink()) {
      if (target.strategy !== 'link' || await realpath(target.path) !== await realpath(managedBundle))
        refuse(`${target.path} is a link that does not lead to the managed bundle`);
      rows.push(['delete-link', target.path]);
    } else if (found.isDirectory()) {
      if (target.strategy !== 'copy') refuse(`${target.path} was recorded as a link but is a directory`);
      try { await lstat(path.join(target.path, 'bundle-manifest.json')); }
      catch { refuse(`${target.path} holds no optbrew bundle manifest`); }
      rows.push(['delete-dir', target.path]);
    } else refuse(`${target.path} is neither a link nor a directory`);
  }
  rows.push(['delete-dir', managedRoot]);
  for (const target of record.targets) rows.push(['install', target.agent, target.strategy]);
  rows.push(['agents', record.targets.map(target => target.agent).join(',')]);
  if (!rows.every(row => row.every(plain))) refuse('a path or name in the plan contains a control character (a line break, tab or similar)');
  return rows;
}

/**
 * Exact manual reinstall steps for a managed scope whose update was refused with migration_required.
 * Targets are deleted first and the managed root (which holds the install record) last, so the steps can be repeated
 * after a partial failure. `.optbrew/runs` is never deleted.
 */
export function reinstallGuidance({ record, recordRoot, from, to }) {
  const separator = record.scope_id.indexOf(':');
  const scope = record.scope_id.slice(0, separator), scopeRoot = record.scope_id.slice(separator + 1);
  const agents = record.targets.map(target => target.agent).join(',');
  const place = quote => scope === 'user' ? `--scope user --home ${quote(scopeRoot)}` : `--scope project --project ${quote(scopeRoot)}`;
  const removePowershell = record.targets.map(target => target.strategy === 'link' ?
    `[IO.Directory]::Delete(${powershell(target.path)})` : `Remove-Item -Recurse -Force -LiteralPath ${powershell(target.path)}`);
  removePowershell.push(`Remove-Item -Recurse -Force -LiteralPath ${powershell(recordRoot)}`);
  const removePosix = `rm -r -- ${[...record.targets.map(target => target.path), recordRoot].map(posix).join(' ')}`;
  const install = quote => record.targets.map(target =>
    `optbrew install --agents ${target.agent} ${place(quote)} --strategy ${target.strategy}`);
  const doctor = quote => `optbrew doctor --agents ${agents} ${place(quote)}`;
  return [
    `Release ${to} uses a new evaluation contract, so a managed update from ${from} cannot carry this install over, and scores from the two releases are not comparable. Reinstall instead; your runs folder (${scopeRoot}/.optbrew/runs) is not touched, so never delete it.`,
    '1. Check the install record first. This read-only command refuses a tampered record and prints exactly what will be deleted:',
    `   optbrew reinstall-plan ${place(posix)}`,
    '2. Delete only those paths, the targets first and the managed root last (repeat the same steps if one fails):',
    '   PowerShell:',
    ...removePowershell.map(line => `     ${line}`),
    `   POSIX shell: ${removePosix}`,
    '3. Install again, one command per recorded agent, from the checkout of the new release:',
    ...['PowerShell', 'POSIX shell'].flatMap((label, i) => [`   ${label}:`, ...install(i ? posix : powershell).map(line => `     ${line}`)]),
    '4. Verify:',
    `   PowerShell: ${doctor(powershell)}`,
    `   POSIX shell: ${doctor(posix)}`,
    'The same steps as copy-paste blocks that do these checks for you: docs/platforms.md, "Reinstall after a migration_required update".',
  ].join('\n');
}

const powershell = value => `'${String(value).replaceAll("'", "''")}'`;
const posix = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * Exact manual reinstall steps for a managed scope whose update was refused with migration_required.
 * Deleted paths: the managed root (bundle, record, snapshots) and the recorded targets. Never `.optbrew/runs`.
 */
export function reinstallGuidance({ record, recordRoot, from, to }) {
  const separator = record.scope_id.indexOf(':');
  const scope = record.scope_id.slice(0, separator), scopeRoot = record.scope_id.slice(separator + 1);
  const paths = [recordRoot, ...record.targets.map(target => target.path)];
  const agents = record.targets.map(target => target.agent).join(',');
  const place = quote => scope === 'user' ? `--scope user --home ${quote(scopeRoot)}` : `--scope project --project ${quote(scopeRoot)}`;
  const install = quote => record.targets.map(target =>
    `optbrew install --agents ${target.agent} ${place(quote)} --strategy ${target.strategy}`);
  const doctor = quote => `optbrew doctor --agents ${agents} ${place(quote)}`;
  return [
    `Release ${to} uses a new evaluation contract, so a managed update from ${from} cannot carry this install over, and scores from the two releases are not comparable. Reinstall instead; your runs folder (${scopeRoot}/.optbrew/runs) is not touched, so never delete it.`,
    '1. Delete only these paths, in this order:',
    `   PowerShell: Remove-Item -Recurse -Force -LiteralPath ${paths.map(powershell).join(',')}`,
    `   POSIX shell: rm -r -- ${paths.map(posix).join(' ')}`,
    '2. Install again, one command per recorded agent, from the checkout of the new release:',
    ...['PowerShell', 'POSIX shell'].flatMap((label, i) => [`   ${label}:`, ...install(i ? posix : powershell).map(line => `     ${line}`)]),
    '3. Verify:',
    `   PowerShell: ${doctor(powershell)}`,
    `   POSIX shell: ${doctor(posix)}`,
    'Step by step with copy-paste blocks: docs/platforms.md, "Reinstall after a migration_required update".',
  ].join('\n');
}

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from './install.mjs';
import { doctor } from './doctor.mjs';
import { supportedAgents, scopePaths } from './paths.mjs';
import { checkUpdates, update, rollback } from './update.mjs';
import { readFile } from 'node:fs/promises';
import { readInstallRecord } from './records.mjs';
import { runCli } from '../skills/optbrew/scripts/cli.mjs';

const defaultBundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/optbrew');
class UsageError extends Error {}
const usage = 'usage: optbrew <install|doctor|check-updates|update|rollback|score|compare|report> [options]';

function parseOptions(argv, allowed) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!allowed.includes(key) || key in options) throw new UsageError(`unknown or repeated option: ${key}`);
    if (key === '--json' || key === '--dry-run') options[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new UsageError(`missing value for ${key}`);
      options[key] = argv[++i];
    }
  }
  return options;
}

function installOptions(argv, command, { cwd, env }) {
  const allowed = ['--agents', '--scope', '--project', '--home', '--json'];
  if (command === 'install') allowed.push('--dry-run', '--strategy');
  const parsed = parseOptions(argv, allowed);
  if (!parsed['--agents']) throw new UsageError('--agents is required');
  const agents = parsed['--agents'].split(',');
  if (agents.some(agent => !supportedAgents.includes(agent)) || new Set(agents).size !== agents.length) throw new UsageError('invalid or duplicate agent');
  const scope = parsed['--scope'] ?? 'user';
  if (!['user', 'project'].includes(scope)) throw new UsageError('--scope must be user or project');
  if (scope === 'project' && !parsed['--project']) throw new UsageError('project scope requires --project');
  if (scope === 'user' && parsed['--project']) throw new UsageError('--project requires project scope');
  const strategy = parsed['--strategy'] ?? 'link';
  if (!['link', 'copy'].includes(strategy)) throw new UsageError('--strategy must be link or copy');
  return { agents, scope, home: parsed['--home'] ? path.resolve(cwd, parsed['--home']) : env?.HOME ?? os.homedir(),
    projectRoot: parsed['--project'] ? path.resolve(cwd, parsed['--project']) : undefined,
    dryRun: Boolean(parsed['--dry-run']), strategy, json: Boolean(parsed['--json']) };
}

function computeArgs(argv, command, cwd) {
  const keys = command === 'score' ? ['--input', '--output'] : command === 'compare' ? ['--before', '--after', '--output'] : ['--input', '--output-dir'];
  const opts = parseOptions(argv, keys);
  if (keys.some(k => !opts[k])) throw new UsageError(`missing ${keys.filter(k => !opts[k]).join(', ')}`);
  return [command, ...keys.flatMap(k => [k, path.resolve(cwd, opts[k])])];
}

/** Return CLI process code: 0 success, 2 argument error, 1 environment or file failure. */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd(), bundleRoot = defaultBundle, registryTransport } = {}) {
  try {
    const [command, ...rest] = argv;
    if (['score', 'compare', 'report'].includes(command)) {
      await runCli(computeArgs(rest, command, cwd));
      stdout.write(`${command} complete\n`);
      return 0;
    }
    if (!['install', 'doctor', 'check-updates', 'update', 'rollback'].includes(command)) throw new UsageError(usage);
    if (command === 'check-updates') {
      const parsed = parseOptions(rest, ['--package', '--json']);
      const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'bundle-manifest.json'), 'utf8'));
      const result = await checkUpdates({ packageName: parsed['--package'], currentVersion: manifest.release_version, registryTransport });
      stdout.write(`${JSON.stringify(result, null, parsed['--json'] ? 2 : 0)}\n`);
      return 0;
    }
    if (command === 'update' || command === 'rollback') {
      const allowed = ['--record-root', '--scope', '--home', '--project', '--agents', '--json'];
      allowed.push(command === 'update' ? '--local-changes' : '--release-version');
      const parsed = parseOptions(rest, allowed);
      if (parsed['--record-root'] && ['--scope', '--home', '--project'].some(k => parsed[k])) throw new UsageError('--record-root cannot be combined with scope options');
      const scope = parsed['--scope'] ?? 'user';
      if (scope === 'user' && parsed['--project']) throw new UsageError('--project requires project scope');
      const recordRoot = parsed['--record-root'] ? path.resolve(cwd, parsed['--record-root']) : scopePaths({ scope,
        home: parsed['--home'] ? path.resolve(cwd, parsed['--home']) : env?.HOME ?? os.homedir(),
        projectRoot: parsed['--project'] ? path.resolve(cwd, parsed['--project']) : undefined }).managedRoot;
      if (parsed['--agents']) {
        const selected = parsed['--agents'].split(',');
        if (selected.some(agent => !supportedAgents.includes(agent)) || new Set(selected).size !== selected.length) throw new UsageError('invalid or duplicate agent');
        const record = await readInstallRecord(recordRoot);
        if (!record) throw new Error('install record missing');
        if (JSON.stringify(selected.sort()) !== JSON.stringify(record.targets.map(t => t.agent).sort())) throw new UsageError('update/rollback requires all recorded targets; partial updates are unavailable');
      }
      if (command === 'rollback' && !parsed['--release-version']) throw new UsageError('--release-version is required');
      const result = command === 'update' ? await update({ bundleRoot, recordRoot, localChanges: parsed['--local-changes'] ?? 'abort' }) :
        await rollback({ recordRoot, releaseVersion: parsed['--release-version'] });
      stdout.write(`${JSON.stringify(result, null, parsed['--json'] ? 2 : 0)}\n`);
      return ['updated', 'rolled_back', 'unchanged'].includes(result.status) ? 0 : 1;
    }
    const options = installOptions(rest, command, { cwd, env });
    const result = command === 'install' ? await install({ ...options, bundleRoot }) : await doctor(options);
    stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return error instanceof UsageError || error instanceof TypeError ? 2 : 1;
  }
}

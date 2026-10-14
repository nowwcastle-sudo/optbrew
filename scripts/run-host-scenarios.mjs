import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const binaries = { codex: 'codex.exe', claude: 'claude.exe' };
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function executable(host) {
  const name = binaries[host];
  if (!name) throw new Error('host must be codex or claude');
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  throw new Error(`native ${name} not found on PATH`);
}

function run(file, args, cwd, timeoutMs) {
  return new Promise(resolve => {
    const started = new Date().toISOString();
    const child = spawn(file, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let size = 0, reason = null;
    const collect = target => chunk => {
      size += chunk.length;
      if (size > 10_000_000) { reason = 'output_limit'; child.kill(); return; }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', error => { reason = `spawn_error:${error.code ?? 'unknown'}`; });
    const timer = setTimeout(() => { reason = 'timeout'; child.kill(); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ started, ended: new Date().toISOString(),
      exit_code: code, reason, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
  });
}

/** Run fresh account-host sessions. Scenario input contains only a request and optional raw material. */
export async function runHostScenarios({ host, scenarios, workspaceRoot, outputDir, timeoutMs = 120000 }) {
  if (!Array.isArray(scenarios) || !scenarios.length || !Number.isInteger(timeoutMs) || timeoutMs < 1000)
    throw new Error('scenarios and positive timeoutMs required');
  const binary = await executable(host);
  await access(workspaceRoot);
  await mkdir(outputDir, { recursive: true });
  const versionRun = await run(binary, ['--version'], workspaceRoot, Math.min(timeoutMs, 15000));
  if (versionRun.exit_code !== 0) throw new Error(`${host} --version failed`);
  const host_version = versionRun.stdout.toString('utf8').trim();
  const receipts = [];
  for (const scenario of scenarios) {
    if (!/^[a-z0-9-]+$/.test(scenario.id) || typeof scenario.request !== 'string' || !scenario.request.trim() ||
        Object.keys(scenario).some(key => !['id', 'request', 'material'].includes(key)))
      throw new Error('scenario may contain only id, request and raw material');
    const prompt = scenario.material ? `${scenario.request}\n\n제공 자료:\n${scenario.material}` : scenario.request;
    const scenarioRoot = path.join(workspaceRoot, scenario.id);
    await mkdir(scenarioRoot, { recursive: true });
    const output = path.join(outputDir, scenario.id);
    await mkdir(output, { recursive: true });
    const finalPath = path.join(output, 'final.txt');
    const argv = host === 'codex' ? ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '-C', scenarioRoot,
      '-o', finalPath, prompt] : ['-p', prompt, '--no-session-persistence', '--output-format', 'json',
      '--plugin-dir', pluginRoot];
    const result = await run(binary, argv, scenarioRoot, timeoutMs);
    const stdoutPath = path.join(output, 'stdout.log'), stderrPath = path.join(output, 'stderr.log');
    await writeFile(stdoutPath, result.stdout, { flag: 'wx' });
    await writeFile(stderrPath, result.stderr, { flag: 'wx' });
    const hashes = { stdout: digest(result.stdout), stderr: digest(result.stderr) };
    try { hashes.final = digest(await readFile(finalPath)); } catch { /* host did not produce final output */ }
    receipts.push({ scenario_id: scenario.id, request: scenario.request, actual_version: host_version,
      binary, argv, started: result.started, ended: result.ended, exit_code: result.exit_code,
      discovery_status: 'pending_independent_review', invocation_status: result.exit_code === 0 ?
        (hashes.final || result.stdout.length ? 'host_returned_output' : 'no_output') : 'host_error',
      artifact_hashes: hashes, verdict: 'pending_independent_review', limitations: result.reason ? [result.reason] : [],
      stdout_ref: stdoutPath, stderr_ref: stderrPath, final_ref: hashes.final ? finalPath : null });
  }
  const receipt = { host, host_version, binary_sha256: digest(await readFile(binary)), installation: 'isolated_plugin_or_explicit_skill',
    scenarios: receipts, evidence_ref: path.join(outputDir, 'receipt.json') };
  await writeFile(receipt.evidence_ref, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [host, scenarioFile, workspaceRoot, outputDir, timeoutText] = process.argv.slice(2);
  if (!host || !scenarioFile || !workspaceRoot || !outputDir) {
    process.stderr.write('usage: node scripts/run-host-scenarios.mjs <codex|claude> <scenarios.json> <workspace-root> <output-dir> [timeout-ms]\n');
    process.exitCode = 2;
  } else runHostScenarios({ host, scenarios: JSON.parse(await readFile(scenarioFile, 'utf8')),
    workspaceRoot: path.resolve(workspaceRoot), outputDir: path.resolve(outputDir),
    timeoutMs: timeoutText ? Number(timeoutText) : 120000 })
    .then(receipt => process.stdout.write(`${receipt.evidence_ref}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

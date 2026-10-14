import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
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

export async function runOwnedProcess(file, args, cwd, timeoutMs, stdoutPath, stderrPath,
  { graceMs = 500, spawnChild = spawn } = {}) {
  const stdoutFile = await open(stdoutPath, 'wx');
  let stderrFile;
  try { stderrFile = await open(stderrPath, 'wx'); }
  catch (error) { await stdoutFile.close(); throw error; }
  return new Promise(resolve => {
    const started = new Date().toISOString();
    const child = spawnChild(file, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0, reason = null, exitCode = null, closeObserved = false, settled = false, writeError = null;
    let writes = Promise.resolve(), graceTimer;
    const append = handle => chunk => {
      if (settled || writeError) return;
      size += chunk.length;
      if (size > 10_000_000) { stop('output_limit'); return; }
      const bytes = Buffer.from(chunk);
      writes = writes.then(async () => {
        for (let offset = 0; offset < bytes.length;) {
          const { bytesWritten } = await handle.write(bytes, offset);
          if (!bytesWritten) throw new Error('log write made no progress');
          offset += bytesWritten;
        }
      }).catch(error => { writeError = error; stop('log_write_error'); });
    };
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(graceTimer);
      child.stdout?.destroy(); child.stderr?.destroy();
      await writes;
      await Promise.all([stdoutFile.sync(), stderrFile.sync()]);
      await Promise.all([stdoutFile.close(), stderrFile.close()]);
      const stdout = await readFile(stdoutPath), stderr = await readFile(stderrPath);
      resolve({ started, ended: new Date().toISOString(), exit_code: exitCode, reason: reason ??
        (writeError ? 'log_write_error' : null), close_observed: closeObserved, stdout, stderr });
    };
    const grace = () => { if (!graceTimer) graceTimer = setTimeout(() => {
      reason ??= 'close_missing'; void finish();
    }, graceMs); };
    const stop = why => {
      reason ??= why;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      grace();
    };
    child.stdout.on('data', append(stdoutFile));
    child.stderr.on('data', append(stderrFile));
    child.on('exit', code => { exitCode = code; grace(); });
    child.on('error', error => { reason ??= `spawn_error:${error.code ?? 'unknown'}`; grace(); });
    child.on('close', code => { closeObserved = true; exitCode ??= code; void finish(); });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
  });
}

/** Run fresh account-host sessions. Scenario input contains only a request and optional raw material. */
export async function runHostScenarios({ host, scenarios, workspaceRoot, outputDir, timeoutMs = 120000 }) {
  if (!Array.isArray(scenarios) || !scenarios.length || !Number.isInteger(timeoutMs) || timeoutMs < 1000)
    throw new Error('scenarios and positive timeoutMs required');
  const binary = await executable(host);
  await access(workspaceRoot);
  await mkdir(outputDir, { recursive: true });
  const receipt = { host, host_version: null, binary_sha256: digest(await readFile(binary)),
    installation: 'isolated_plugin_or_explicit_skill', scenarios: [], evidence_ref: path.join(outputDir, 'receipt.json') };
  const saveReceipt = async (initial = false) => {
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
    if (initial) await writeFile(receipt.evidence_ref, bytes, { flag: 'wx' });
    else { const temporary = `${receipt.evidence_ref}.tmp`; await writeFile(temporary, bytes);
      await rename(temporary, receipt.evidence_ref); }
  };
  await saveReceipt(true);
  const versionRun = await runOwnedProcess(binary, ['--version'], workspaceRoot, Math.min(timeoutMs, 15000),
    path.join(outputDir, 'version.stdout.log'), path.join(outputDir, 'version.stderr.log'));
  if (versionRun.exit_code !== 0 || versionRun.reason) {
    receipt.version_check = { status: 'incomplete', exit_code: versionRun.exit_code,
      reason: versionRun.reason, stdout_ref: path.join(outputDir, 'version.stdout.log'),
      stderr_ref: path.join(outputDir, 'version.stderr.log') };
    await saveReceipt();
    throw new Error(`${host} --version failed; receipt: ${receipt.evidence_ref}`);
  }
  const host_version = versionRun.stdout.toString('utf8').trim();
  receipt.host_version = host_version;
  await saveReceipt();
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
    const stdoutPath = path.join(output, 'stdout.log'), stderrPath = path.join(output, 'stderr.log');
    const scenarioReceipt = { scenario_id: scenario.id, request: scenario.request, actual_version: host_version,
      binary, argv, started: new Date().toISOString(), ended: null, exit_code: null,
      discovery_status: 'pending_independent_review', invocation_status: 'running',
      artifact_hashes: {}, verdict: 'pending_independent_review', limitations: [],
      stdout_ref: stdoutPath, stderr_ref: stderrPath, final_ref: null };
    receipt.scenarios.push(scenarioReceipt);
    await saveReceipt();
    const result = await runOwnedProcess(binary, argv, scenarioRoot, timeoutMs, stdoutPath, stderrPath);
    const hashes = { stdout: digest(result.stdout), stderr: digest(result.stderr) };
    try { hashes.final = digest(await readFile(finalPath)); } catch { /* host did not produce final output */ }
    Object.assign(scenarioReceipt, { started: result.started, ended: result.ended, exit_code: result.exit_code,
      close_observed: result.close_observed,
      invocation_status: result.reason ? 'incomplete' : result.exit_code === 0 ?
        (hashes.final || result.stdout.length ? 'host_returned_output' : 'no_output') : 'host_error',
      artifact_hashes: hashes, limitations: result.reason ? [result.reason] : [],
      final_ref: hashes.final ? finalPath : null });
    await saveReceipt();
    if (result.reason) break;
  }
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runHostScenarios, runOwnedProcess } from '../scripts/run-host-scenarios.mjs';

test('owned fake host writes logs and an incomplete receipt on timeout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-owned-host-'));
  const bin = path.join(root, 'bin'), workspaceRoot = path.join(root, 'workspace');
  const scenarioRoot = path.join(workspaceRoot, 'held-pipe'), outputDir = path.join(root, 'output');
  // The fake host and its grandchild inherit this environment, so keep them out of the real home.
  const home = path.join(root, 'home'), pidFile = path.join(scenarioRoot, 'grandchild.pid');
  const envKeys = ['PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
  const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  let grandchildPid;
  try {
    await mkdir(bin);
    await mkdir(home);
    await mkdir(scenarioRoot, { recursive: true });
    await copyFile(process.execPath, path.join(bin, 'codex.exe'));
    // The grandchild holds the inherited pipes far longer than the run may take, and reports its pid
    // so the test can show completion did not wait for it. Detached, so Windows does not end it along
    // with the killed host's job object.
    await writeFile(path.join(scenarioRoot, 'exec'), `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'],
        { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: true });
      require('node:fs').writeFileSync('grandchild.pid', String(grandchild.pid));
      process.stdout.write('owned parent stdout\\n');
      process.stderr.write('owned parent stderr\\n');
      setInterval(() => {}, 1000);
    `);
    Object.assign(process.env, { PATH: `${bin}${path.delimiter}${previousEnv.PATH}`, HOME: home,
      USERPROFILE: home, HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''),
      HOMEPATH: home.slice(path.parse(home).root.length - 1) });
    const start = Date.now();
    // 3 s leaves room for a slow node start under load before the fake host writes its logs.
    const receipt = await runHostScenarios({ host: 'codex', scenarios: [{ id: 'held-pipe', request: 'fixture only' }],
      workspaceRoot, outputDir, timeoutMs: 3000 });
    const elapsed = Date.now() - start;
    grandchildPid = Number(await readFile(pidFile, 'utf8'));
    assert.doesNotThrow(() => process.kill(grandchildPid, 0), 'grandchild still holds the pipe at completion');
    const saved = JSON.parse(await readFile(receipt.evidence_ref, 'utf8'));
    assert.equal(saved.scenarios.length, 1);
    assert.equal(saved.scenarios[0].invocation_status, 'incomplete');
    assert.deepEqual(saved.scenarios[0].limitations, ['timeout']);
    assert.equal(typeof saved.scenarios[0].close_observed, 'boolean');
    assert.equal(saved.scenarios[0].exit_code, null);
    assert.match(await readFile(saved.scenarios[0].stdout_ref, 'utf8'), /owned parent stdout/);
    assert.match(await readFile(saved.scenarios[0].stderr_ref, 'utf8'), /owned parent stderr/);
    assert.ok(elapsed < 10000, `bounded completion took ${elapsed} ms`);
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
    }
    grandchildPid ??= Number(await readFile(pidFile, 'utf8').catch(() => NaN));
    if (grandchildPid) { try { process.kill(grandchildPid); } catch { /* already exited */ } }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('missing close control still finalizes bounded logs with unknown host exit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-missing-close-'));
  try {
    const stdoutPath = path.join(root, 'stdout.log'), stderrPath = path.join(root, 'stderr.log');
    const spawnWithoutClose = (file, args, options) => {
      const child = spawn(file, args, options);
      const controlled = new EventEmitter();
      controlled.stdout = child.stdout; controlled.stderr = child.stderr;
      controlled.kill = () => child.kill();
      Object.defineProperties(controlled, {
        exitCode: { get: () => child.exitCode },
        signalCode: { get: () => child.signalCode },
      });
      child.on('exit', code => controlled.emit('exit', code));
      child.on('error', error => controlled.emit('error', error));
      return controlled;
    };
    const started = Date.now();
    const result = await runOwnedProcess(process.execPath, ['-e',
      "process.stdout.write('captured before timeout\\n'); setInterval(() => {}, 1000)"],
    root, 1500, stdoutPath, stderrPath, { graceMs: 150, spawnChild: spawnWithoutClose });
    assert.equal(result.reason, 'timeout');
    assert.equal(result.close_observed, false);
    assert.equal(result.exit_code, null);
    assert.match(await readFile(stdoutPath, 'utf8'), /captured before timeout/);
    assert.ok(Date.now() - started < 4000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

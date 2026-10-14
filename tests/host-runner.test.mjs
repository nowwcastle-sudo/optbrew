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
  const previousPath = process.env.PATH;
  try {
    await mkdir(bin);
    await mkdir(scenarioRoot, { recursive: true });
    await copyFile(process.execPath, path.join(bin, 'codex.exe'));
    await writeFile(path.join(scenarioRoot, 'exec'), `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4500)'],
        { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
      process.stdout.write('owned parent stdout\\n');
      process.stderr.write('owned parent stderr\\n');
      setInterval(() => {}, 1000);
    `);
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    const start = Date.now();
    const receipt = await runHostScenarios({ host: 'codex', scenarios: [{ id: 'held-pipe', request: 'fixture only' }],
      workspaceRoot, outputDir, timeoutMs: 1000 });
    const elapsed = Date.now() - start;
    const saved = JSON.parse(await readFile(receipt.evidence_ref, 'utf8'));
    assert.equal(saved.scenarios.length, 1);
    assert.equal(saved.scenarios[0].invocation_status, 'incomplete');
    assert.deepEqual(saved.scenarios[0].limitations, ['timeout']);
    assert.equal(typeof saved.scenarios[0].close_observed, 'boolean');
    assert.equal(saved.scenarios[0].exit_code, null);
    assert.match(await readFile(saved.scenarios[0].stdout_ref, 'utf8'), /owned parent stdout/);
    assert.match(await readFile(saved.scenarios[0].stderr_ref, 'utf8'), /owned parent stderr/);
    assert.ok(elapsed < 3300, `bounded completion took ${elapsed} ms`);
  } finally {
    process.env.PATH = previousPath;
    await new Promise(resolve => setTimeout(resolve, 3200));
    await rm(root, { recursive: true, force: true });
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
    root, 100, stdoutPath, stderrPath, { graceMs: 150, spawnChild: spawnWithoutClose });
    assert.equal(result.reason, 'timeout');
    assert.equal(result.close_observed, false);
    assert.equal(result.exit_code, null);
    assert.match(await readFile(stdoutPath, 'utf8'), /captured before timeout/);
    assert.ok(Date.now() - started < 1500);
  } finally { await rm(root, { recursive: true, force: true }); }
});

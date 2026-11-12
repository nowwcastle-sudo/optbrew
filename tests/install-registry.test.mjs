// daybreak csf_2c602f70ee5e3014b473562b: the install commands must not take the npm registry or npm options from the folder
// they start in. A site project can carry an .npmrc that points npx at an attacker registry serving a fake optbrew@<version>.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tempDir } from './support/temp-dir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(root, 'install.ps1');
const OFFICIAL = 'https://registry.npmjs.org/';
const shells = (process.platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh'])
  .filter(shell => spawnSync(shell, ['-NoProfile', '-Command', '1']).status === 0);

// A stand-in npx: records where it ran and what it was given, and answers like the optbrew CLI does.
const RECORDER = `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.OPTBREW_NPX_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
const command = args[args.indexOf('optbrew') + 1];
const answer = command === 'doctor' ? { targets: [{ agent: 'codex', file_present: true, hash_ok: true, registered: true }] }
  : args.includes('--dry-run') ? { decision: { targets: [{ path: 'planned' }] } } : { status: 'installed' };
console.log(JSON.stringify(answer));
`;

async function fakeNpx(dir) {
  await writeFile(path.join(dir, 'rec.mjs'), RECORDER);
  if (process.platform === 'win32') await writeFile(path.join(dir, 'npx.cmd'), `@"${process.execPath}" "%~dp0rec.mjs" %*\r\n`);
  else {
    await writeFile(path.join(dir, 'npx'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/rec.mjs" "$@"\n`);
    await chmod(path.join(dir, 'npx'), 0o755);
  }
}

function runInstaller(shell, cwd, extra, env) {
  const policy = process.platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : [];
  return spawnSync(shell, ['-NoProfile', '-NonInteractive', ...policy, '-File', installer, ...extra], { cwd, encoding: 'utf8', env });
}

for (const shell of shells) {
  test(`${shell}: install.ps1 ignores the starting folder's .npmrc and names the official registry`, async () => {
    const temp = await tempDir('optbrew-registry-');
    const bin = path.join(temp, 'bin');
    const project = path.join(temp, 'untrusted-site');
    await mkdir(bin);
    await mkdir(project);
    await fakeNpx(bin);
    // The attack: the project's own npm config redirects the registry and adds a node option.
    await writeFile(path.join(project, '.npmrc'), 'registry=http://127.0.0.1:9/\nnode-options=--require ./evil.js\n');
    const log = path.join(temp, 'npx.log');
    const env = { ...process.env, OPTBREW_NPX_LOG: log, PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter) };
    const result = runInstaller(shell, project, ['-Agents', 'codex', '-Scope', 'project', '-Project', '.'], env);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.args[call.args.indexOf('optbrew') + 1]), ['install', 'install', 'doctor']);
    for (const call of calls) {
      assert.notEqual(path.resolve(call.cwd), path.resolve(project), 'npx must not run in the project folder');
      assert.ok(!path.resolve(call.cwd).startsWith(path.resolve(project) + path.sep), 'npx must not run under the project folder');
      const at = call.args.indexOf('--registry');
      assert.ok(at >= 0 && call.args[at + 1] === OFFICIAL, `registry not named: ${call.args.join(' ')}`);
      assert.equal(call.args[call.args.indexOf('--project') + 1], project, 'a relative -Project is passed as an absolute path');
      // The working folder was a fresh one and is gone afterwards.
      assert.equal(existsSync(call.cwd), false, 'the temporary working folder is removed');
    }
  });

  test(`${shell}: install.ps1 takes a private mirror from -Registry and refuses a plain-http one`, async () => {
    const temp = await tempDir('optbrew-registry-');
    const bin = path.join(temp, 'bin');
    await mkdir(bin);
    await fakeNpx(bin);
    const log = path.join(temp, 'npx.log');
    const env = { ...process.env, OPTBREW_NPX_LOG: log, PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter) };
    const mirror = 'https://npm.example.internal/';
    const ok = runInstaller(shell, temp, ['-Agents', 'codex', '-Registry', mirror], env);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    const [first] = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(first.args[first.args.indexOf('--registry') + 1], mirror);
    const refused = runInstaller(shell, temp, ['-Agents', 'codex', '-Registry', 'http://npm.example.internal/'], env);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr + refused.stdout, /https:\/\/ URL/);
  });
}

// The agent guide and both READMEs are the other install path. Every npx or npm command that fetches optbrew names the
// registry, and nothing runs the moving `latest` tag (the version an update installs is the one it just looked up).
test('install and update docs name the registry and never execute optbrew@latest', async () => {
  for (const name of ['AGENT_INSTALL.md', 'README.md', 'README.ko.md']) {
    const text = await readFile(path.join(root, name), 'utf8');
    const lines = text.split('\n').filter(line => /\b(?:npx|npm (?:install|view|exec))\b[^`]*\boptbrew\b/.test(line));
    assert.ok(lines.length, `${name}: no install command found`);
    for (const line of lines) {
      assert.match(line, /--registry[= ]https:\/\/registry\.npmjs\.org\//, `${name}: registry not named in: ${line.trim()}`);
      assert.doesNotMatch(line, /optbrew@latest/, `${name}: runs optbrew@latest: ${line.trim()}`);
    }
  }
});

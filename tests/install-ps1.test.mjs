import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(root, 'install.ps1');
const shells = (process.platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh'])
  .filter(shell => spawnSync(shell, ['-NoProfile', '-Command', '1']).status === 0);

test('install.ps1 is ASCII without a byte order mark, so irm | iex can parse it', async () => {
  const bytes = await readFile(installer);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'irm keeps a UTF-8 BOM as a character and iex then fails');
  assert.equal(bytes.findIndex(byte => byte > 0x7f), -1, 'install.ps1 must stay ASCII');
});

for (const shell of shells) {
  test(`${shell}: irm | iex parses install.ps1 and leaves nothing in the caller's session`, () => {
    // Decode the way irm does (a BOM would survive as U+FEFF), then run it with node absent so it stops at the first check.
    const script = `
      $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($env:OPTBREW_INSTALLER))
      $encoding = [Console]::OutputEncoding.WebName
      $env:PATH = $env:OPTBREW_EMPTY_PATH
      try { $text | Invoke-Expression; 'result=finished' } catch { "result=$($_.Exception.Message)" }
      "preference=$ErrorActionPreference"
      "encoding_restored=$([Console]::OutputEncoding.WebName -eq $encoding)"
      "leaked=$(@('npx', 'agentList', 'target', 'plan', 'doctor' | Where-Object { Get-Variable $_ -ErrorAction SilentlyContinue }).Count + @(Get-Command Invoke-Optbrew -ErrorAction SilentlyContinue).Count)"`;
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', env: { ...process.env, OPTBREW_INSTALLER: installer, OPTBREW_EMPTY_PATH: path.join(root, 'no-such-dir') } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /result=Node\.js 22 or later is required/);
    assert.match(result.stdout, /preference=Continue/);
    assert.match(result.stdout, /encoding_restored=True/);
    assert.match(result.stdout, /leaked=0/);
  });
}

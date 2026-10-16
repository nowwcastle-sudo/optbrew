import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scanSecrets, readGitScanInputs, scanTrackedAndStaged } from '../scripts/scan-secrets.mjs';
import { requestAnthropic } from '../skills/optbrew/scripts/adapters/anthropic.mjs';

test('scanner reports four fake secret classes without values and ignores public SHA', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optbrew-secret-'));
  try {
    const file = path.join(dir, 'sample.txt');
    const fake = [
      'sk-ant-api03-' + 'a'.repeat(70),
      'sk-proj-' + 'b'.repeat(70),
      'ghp_' + 'c'.repeat(36),
      'AKIA' + 'D'.repeat(16),
    ];
    await writeFile(file, [...fake, 'public git SHA 5b2c0007766c6a1cf1d53fd8fc73e979e0821022'].join('\n'));
    const result = await scanSecrets({ root: dir, files: ['sample.txt'] });
    assert.equal(result.checked, 1);
    assert.equal(result.checkedPaths, 1);
    assert.equal(result.checkedVersions, 1);
    assert.equal(result.findings.length, 4);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.findings.map(x => x.line), [1, 2, 3, 4]);
    assert.ok(!fake.some(secret => JSON.stringify(result).includes(secret)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Git scan reads staged bytes, even if working copy differs or is deleted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optbrew-index-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    await writeFile(path.join(dir, 'changed.txt'), 'staged-A\n');
    await writeFile(path.join(dir, 'deleted.txt'), 'staged-D\n');
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '--', 'changed.txt', 'deleted.txt'], { cwd: dir });
    await writeFile(path.join(dir, 'changed.txt'), 'working-B\n');
    await unlink(path.join(dir, 'deleted.txt'));
    await writeFile(path.join(dir, 'untracked.txt'), 'disk-C\n');
    const inputs = await readGitScanInputs({ root: dir });
    const byVersion = new Map(inputs.map(x => [`${x.path}:${x.version}`, x.bytes.toString('utf8')]));
    assert.equal(byVersion.get('changed.txt:index'), 'staged-A\n');
    assert.equal(byVersion.get('changed.txt:working-tree'), 'working-B\n');
    assert.equal(byVersion.get('deleted.txt:index'), 'staged-D\n');
    assert.equal(byVersion.get('untracked.txt:untracked'), 'disk-C\n');
    assert.equal(byVersion.size, 4);
    const result = await scanTrackedAndStaged({ root: dir });
    assert.equal(result.checked, 4);
    assert.equal(result.checkedPaths, 3);
    assert.equal(result.checkedVersions, 4);
    assert.equal(result.findings.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('scan-secrets finds a Google API key pattern', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optbrew-google-scan-'));
  try {
    // Assembled from fragments: the repository never contains a literal key.
    const fake = ['AI', 'za', 'Sy', 'x'.repeat(33)].join('');
    const nearMisses = ['AI' + 'za' + 'short', ['AI', 'za', 'x'.repeat(34)].join('')];
    await writeFile(path.join(dir, 'hit.txt'), `key=${fake}\n${nearMisses.join('\n')}\n`);
    const result = await scanSecrets({ root: dir, files: ['hit.txt'] });
    assert.deepEqual(result.findings, [{ path: 'hit.txt', line: 1, rule: 'google_api_key' }]);
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.stringify(result).includes(fake), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('endpoints.json has no key parameter', async () => {
  const endpoints = JSON.parse(await readFile(new URL('../skills/optbrew/references/endpoints.json', import.meta.url), 'utf8'));
  for (const [name, value] of Object.entries(endpoints)) {
    assert.doesNotMatch(name, /key/i, name);
    assert.doesNotMatch(value, /[?&;]key=|api[_-]?key/i, name);
    if (/^https?:/.test(value)) assert.equal(new URL(value).searchParams.has('key'), false, name);
  }
});

test('requestAnthropic does not call transport when env has no key', async () => {
  let calls = 0;
  const transport = async () => { calls++; throw new Error('transport must not be called'); };
  const context = { run_id: 'test', cost_decision: { approval_ref: 'approved/test', providers: { anthropic: { upper_bounds: [{ unit: 'tokens', amount: 1 }] } } } };
  for (const env of [{}, { ANTHROPIC_API_KEY: '' }]) {
    const result = await requestAnthropic({ context, request: { model: 'claude-sonnet-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }, env, transport, ledgerPath: 'unused-ledger.json' });
    assert.equal(result.valid, false);
    assert.equal(result.error, 'api_key_missing');
  }
  assert.equal(calls, 0);
});

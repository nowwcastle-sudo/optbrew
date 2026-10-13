import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scanSecrets, readGitScanInputs, scanTrackedAndStaged } from '../scripts/scan-secrets.mjs';

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
    const byPath = new Map(inputs.map(x => [x.path, x.bytes.toString('utf8')]));
    assert.equal(byPath.get('changed.txt'), 'staged-A\n');
    assert.equal(byPath.get('deleted.txt'), 'staged-D\n');
    assert.equal(byPath.get('untracked.txt'), 'disk-C\n');
    assert.equal(byPath.size, 3);
    const result = await scanTrackedAndStaged({ root: dir });
    assert.equal(result.checked, 3);
    assert.equal(result.findings.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

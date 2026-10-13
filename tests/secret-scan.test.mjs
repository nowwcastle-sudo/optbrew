import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scanSecrets } from '../scripts/scan-secrets.mjs';

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

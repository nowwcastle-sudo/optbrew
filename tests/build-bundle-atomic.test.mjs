import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDistributedBundlePath } from '../skills/optbrew/scripts/core/bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/build-bundle.mjs');

test('build-bundle replaces bundle-manifest.json atomically: a concurrent reader never sees an empty or partial file', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew build bundle '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const bundle = path.join(temp, 'skills', 'optbrew');
  const source = path.join(root, 'skills/optbrew');
  await cp(source, bundle, { recursive: true, filter: p => isDistributedBundlePath(path.relative(source, p)) });
  const manifest = path.join(bundle, 'bundle-manifest.json');
  const build = async () => {
    const run = spawn(process.execPath, [script, '--bundle', bundle, '--version', '0.1.2'], { stdio: 'inherit' });
    assert.equal(await new Promise(resolve => run.on('close', resolve)), 0);
  };
  await build(); // the copy's manifest may be older than its files
  const expected = await readFile(manifest, 'utf8');
  let running = true, reads = 0, bad = [];
  const reader = (async () => {
    while (running) {
      try {
        const text = await readFile(manifest, 'utf8');
        reads++;
        if (text !== expected) bad.push(text.length);
      } catch (error) { bad.push(error.code); }
      await new Promise(resolve => setImmediate(resolve));
    }
  })();
  for (let i = 0; i < 8; i++) await build();
  running = false;
  await reader;
  assert.ok(reads > 50, `the reader ran ${reads} times`);
  assert.deepEqual(bad, [], 'the manifest is always the complete previous or the complete new file');
  // No temporary file is left behind, inside the bundle or beside it.
  assert.deepEqual((await readdir(path.dirname(bundle))).filter(name => name !== 'optbrew'), []);
  assert.equal((await readdir(bundle)).filter(name => name.endsWith('.tmp')).length, 0);
});

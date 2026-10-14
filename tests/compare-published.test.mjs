import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { extractPublished, root, skipUnreachable } from './support/published-011.mjs';

const json = async file => JSON.parse(await readFile(file, 'utf8'));

test('0.1.1 baselines are not comparable with 0.1.2 inputs: real published output vs current inputs', { skip: skipUnreachable }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew compare from 0.1.1 '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const old = await extractPublished(temp);

  // Real 0.1.1 output: the published bundle's own CLI scores its own fixture.
  const oldOutput = path.join(temp, 'score-0.1.1.json');
  const ran = spawnSync(process.execPath, [path.join(old.bundle, 'scripts/cli.mjs'), 'score',
    '--input', path.join(old.fixtures, 'before.json'), '--output', oldOutput], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const oldScores = await json(oldOutput);
  assert.ok(oldScores.length > 0);
  assert.ok(oldScores.every(item => item.evaluation_version === '0.1.0'));

  // The matching 0.1.2 input is the current fixture, scored by the current bundle.
  const before = await json(path.join(old.fixtures, 'before.json'));
  const after = await json(path.join(root, 'tests/fixtures/scoring/before.json'));
  const current = JSON.parse(await readFile(path.join(root, 'skills/optbrew/bundle-manifest.json'), 'utf8'));
  assert.equal(before.run_context.evaluation_version, '0.1.0');
  assert.equal(after.run_context.evaluation_version, current.evaluation_version);
  assert.notEqual(current.evaluation_version, '0.1.0');
  assert.ok(score(after).every(item => item.evaluation_version === current.evaluation_version));
  assert.throws(() => score(before), /evaluation/i, 'the current bundle must not score a 0.1.1 baseline');

  const result = compare(before, after);
  assert.equal(result.status, 'not_comparable');
  assert.ok(result.reasons.includes('evaluation_version_changed'), JSON.stringify(result.reasons));
  assert.deepEqual(result.score_deltas, []);

  // The shipped CLI reports the same verdict.
  const output = path.join(temp, 'compare.json');
  const cli = spawnSync(process.execPath, [path.join(root, 'skills/optbrew/scripts/cli.mjs'), 'compare',
    '--before', path.join(old.fixtures, 'before.json'), '--after', path.join(root, 'tests/fixtures/scoring/before.json'), '--output', output], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal((await json(output)).status, 'not_comparable');
});

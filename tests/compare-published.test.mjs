import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, after } from 'node:test';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { extractPublished, releasePublished, root, skipUnreachable } from './support/published.mjs';
import { environmentProbe } from './support/probe.mjs';

after(releasePublished);

const json = async file => JSON.parse(await readFile(file, 'utf8'));

test('0.1.2 baselines are not comparable with 0.1.3 inputs: real published output vs current inputs', { skip: skipUnreachable }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'optbrew compare from 0.1.2 '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const old = await extractPublished();

  // Real 0.1.2 output: the published bundle's own CLI scores its own fixture.
  const oldOutput = path.join(temp, 'score-0.1.2.json');
  const ran = spawnSync(process.execPath, [path.join(old.bundle, 'scripts/cli.mjs'), 'score',
    '--input', path.join(old.fixtures, 'before.json'), '--output', oldOutput], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const oldScores = await json(oldOutput);
  assert.ok(oldScores.length > 0);
  assert.ok(oldScores.every(item => item.evaluation_version === '0.2.0'));

  // The matching 0.1.3 input is the current fixture, scored by the current bundle.
  const before = await json(path.join(old.fixtures, 'before.json'));
  const after = await json(path.join(root, 'tests/fixtures/scoring/before.json'));
  const current = JSON.parse(await readFile(path.join(root, 'skills/optbrew/bundle-manifest.json'), 'utf8'));
  assert.equal(before.run_context.evaluation_version, '0.2.0');
  assert.equal(after.run_context.evaluation_version, current.evaluation_version);
  assert.notEqual(current.evaluation_version, '0.2.0');
  assert.ok(score(after).every(item => item.evaluation_version === current.evaluation_version));
  // The current bundle refuses to score a 0.1.2 baseline, in one plain sentence (its version labels are older) ...
  assert.throws(() => score(before), /^ContractError: migration_required: this score input was made with audit protocol .+ run the audit again/);
  // ... and comparing against it is answered in plain words, not with a schema error.
  const result = compare(before, after);
  assert.equal(result.status, 'not_comparable');
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /^the baseline was made with audit protocol .+, which is older than the current one; run a new audit to compare$/);
  assert.deepEqual(result.score_deltas, []);
  assert.equal(compare(before, null).status, 'no_after');

  // Adding the render field and the probe does not make an old input current: its version labels still say which release made it.
  const completed = structuredClone(before);
  completed.run_context.environment_probe = environmentProbe();
  completed.run_context.protocol.render = { enabled: false, pages: [], max_render_requests: 300 };
  assert.throws(() => score(completed), /migration_required/);
  assert.equal(compare(completed, after).status, 'not_comparable');

  // The shipped CLI reports the same verdict for the real 0.1.2 file.
  const output = path.join(temp, 'compare.json');
  const cli = spawnSync(process.execPath, [path.join(root, 'skills/optbrew/scripts/cli.mjs'), 'compare',
    '--before', path.join(old.fixtures, 'before.json'), '--after', path.join(root, 'tests/fixtures/scoring/before.json'), '--output', output], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const verdict = await json(output);
  assert.equal(verdict.status, 'not_comparable');
  assert.deepEqual(verdict.reasons, result.reasons);
});

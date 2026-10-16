import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, after } from 'node:test';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { extractPublished, releasePublished, root, skipUnreachable } from './support/published.mjs';

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
  // A 0.1.2 baseline has no protocol.render (Task 6 made it required), so the current bundle rejects the file itself.
  assert.throws(() => score(before), /protocol\.render: required/, 'the current bundle must not score a 0.1.2 baseline');
  assert.throws(() => compare(before, after), /protocol\.render: required/);
  // With only that field added, the original guarantee holds: another evaluation version is never scored or compared.
  const completed = structuredClone(before);
  completed.run_context.protocol.render = { enabled: false, pages: [], max_render_requests: 300 };
  assert.throws(() => score(completed), /evaluation/i, 'the current bundle must not score a 0.1.2 baseline');

  const result = compare(completed, after);
  assert.equal(result.status, 'not_comparable');
  assert.ok(result.reasons.includes('evaluation_version_changed'), JSON.stringify(result.reasons));
  assert.deepEqual(result.score_deltas, []);

  // The shipped CLI refuses the real 0.1.2 file and reports the same verdict for the completed one.
  const compareWith = async beforeFile => {
    const output = path.join(temp, 'compare.json');
    const cli = spawnSync(process.execPath, [path.join(root, 'skills/optbrew/scripts/cli.mjs'), 'compare',
      '--before', beforeFile, '--after', path.join(root, 'tests/fixtures/scoring/before.json'), '--output', output], { encoding: 'utf8' });
    return { cli, output };
  };
  const refused = await compareWith(path.join(old.fixtures, 'before.json'));
  assert.notEqual(refused.cli.status, 0);
  assert.match(refused.cli.stderr, /protocol\.render: required/);
  const completedFile = path.join(temp, 'before-with-render.json');
  await writeFile(completedFile, JSON.stringify(completed));
  const verdict = await compareWith(completedFile);
  assert.equal(verdict.cli.status, 0, verdict.cli.stderr);
  assert.equal((await json(verdict.output)).status, 'not_comparable');
});

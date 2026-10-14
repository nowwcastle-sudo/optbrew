import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/scoring/partial.json', import.meta.url)));
const pass = (unit, id = unit) => ({ schema_version: '1.0.0', observation_id: id,
  check_id: unit.split('|')[0], family_id: unit.split('|')[0], unit_key: unit,
  state: 'pass', q: 1, partial_basis: null, reason: 'synthetic evidence',
  evaluator_type: 'code', source_ref: 'synthetic', evidence_ref: `synthetic/${id}` });

test('missing after is explicit; same protocol compares unrounded score', () => {
  const before = fixture();
  assert.deepEqual(compare(before, null), { status: 'no_after', score_deltas: [], reasons: ['after_missing'] });
  const after = fixture();
  after.run_context.run_id = 'after';
  after.run_context.evidence_ref = 'synthetic/after';
  after.observations.push({ ...pass('document-title|https://example.com/'), state: 'fail', q: 0 });
  const result = compare(before, after);
  assert.equal(result.status, 'comparable');
  assert.equal(result.reasons.length, 0);
  assert.equal(result.score_deltas[0].profile, 'SEO');
  assert.ok(result.score_deltas[0].raw_difference < 0);
  assert.equal(result.score_deltas[0].relative_change, result.score_deltas[0].raw_difference / 100);
  assert.equal(result.score_deltas[0].percentage_point_delta, result.score_deltas[0].raw_difference);
});

test('target, URLs, page type, conditions, questions, surface, model, environment and evaluation version are comparison conditions', () => {
  const mutate = [
    x => { x.run_context.target = 'other.example'; },
    x => { x.run_context.protocol.page_types[0].urls[0].normalized = 'https://example.com/new'; },
    x => { x.run_context.protocol.page_types[0].id = 'other'; },
    x => { const f = x.run_context.protocol.families.find(f => f.family_id === 'render-content'); f.applicable = true; delete f.applicability_decision; },
    x => { x.run_context.protocol.question_panel = [{ id: 'q', question: 'Who?', category: 'brand' }]; const f = x.run_context.protocol.families.find(f => f.family_id === 'question-coverage'); f.applicable = true; delete f.applicability_decision; },
    x => { x.run_context.protocol.surfaces = ['claude_web']; },
    x => { x.run_context.protocol.models = ['model-v2']; },
    x => { x.run_context.environment = 'production'; },
    x => { x.run_context.evaluation_version = '0.3.0'; },
  ];
  for (const change of mutate) {
    const before = fixture(), after = fixture(); change(after);
    const result = compare(before, after);
    assert.equal(result.status, 'not_comparable');
    assert.ok(result.reasons.length, JSON.stringify(after.run_context));
    assert.deepEqual(result.score_deltas, []);
  }
});

test('changed applicable unit denominator is not an improvement even under the same protocol hash', () => {
  const before = fixture(), after = fixture();
  after.observations.push({ ...pass('document-title|https://example.com/about'),
    state: 'not_applicable', q: null, applicability_decision: { condition: 'not_html',
      reason: 'verified non-HTML', evidence_ref: 'synthetic/non-html' } });
  const result = compare(before, after);
  assert.equal(result.status, 'not_comparable');
  assert.ok(result.reasons.includes('applicable_units_changed'));
});

test('zero baseline leaves relative change undefined', () => {
  const before = fixture(), after = fixture();
  before.observations = [pass('fetch-response|https://example.com/', 'fetch')];
  before.observations[0].state = 'fail'; before.observations[0].q = 0;
  after.observations = [pass('fetch-response|https://example.com/', 'fetch')];
  const result = compare(before, after);
  assert.equal(result.status, 'comparable');
  assert.equal(result.score_deltas[0].relative_change, null);
});

test('compare CLI readback equals the library result for stored before/after inputs', () => {
  const root = new URL('..', import.meta.url);
  const before = 'tests/fixtures/scoring/before.json', after = 'tests/fixtures/scoring/after.json';
  const expected = compare(JSON.parse(readFileSync(new URL('./fixtures/scoring/before.json', import.meta.url))),
    JSON.parse(readFileSync(new URL('./fixtures/scoring/after.json', import.meta.url))));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'optbrew-compare-'));
  try {
    const output = path.join(dir, 'result.json');
    const child = spawnSync(process.execPath, ['skills/optbrew/scripts/cli.mjs', 'compare',
      '--before', before, '--after', after, '--output', output], { cwd: root, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), expected);
    assert.equal(expected.status, 'comparable');
    assert.ok(expected.score_deltas[0].raw_difference < 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compare CLI rejects changed conditions without writing a misleading score delta', () => {
  const before = JSON.parse(readFileSync(new URL('./fixtures/scoring/before.json', import.meta.url)));
  const after = structuredClone(before);
  after.run_context.environment = 'production';
  const result = compare(before, after);
  assert.equal(result.status, 'not_comparable');
  assert.deepEqual(result.score_deltas, []);
  assert.ok(result.reasons.includes('environment_changed'));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ContractError } from '../skills/optbrew/scripts/core/contracts.mjs';
import { compileUnits, scoreWeighted } from '../skills/optbrew/scripts/core/weights.mjs';
import { score, cwvVerdict } from '../skills/optbrew/scripts/core/score.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync as readOutput, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/scoring/partial.json', import.meta.url)));
const weightedCase = () => [
  { key: 'a', family_id: 'a', engine: null, url: null, weight: 58, state: 'pass', q: 1 },
  { key: 'b', family_id: 'b', engine: null, url: null, weight: 22, state: 'fail', q: 0 },
  { key: 'c', family_id: 'c', engine: null, url: null, weight: 20, state: 'unknown', q: null },
];

test('weighted score keeps measured score, coverage and missing bounds separate', () => {
  assert.deepEqual(scoreWeighted(weightedCase()), { A: 100, M: 80, N: 58,
    score: 72.5, coverage: 80, missing_bounds: [58, 78] });
  assert.equal(scoreWeighted([{ ...weightedCase()[0], state: 'unknown', q: null }]).score, null);
  assert.equal(scoreWeighted([{ ...weightedCase()[0], state: 'not_applicable', q: null }]).A, 0);
  assert.throws(() => scoreWeighted([{ ...weightedCase()[0], q: 0.6 }]), ContractError);
  const near = scoreWeighted([
    { ...weightedCase()[0], weight: 79.96 },
    { ...weightedCase()[2], weight: 20.04 },
  ]);
  assert.equal(near.coverage, 80);
  assert.equal(near.M, 79.96);
  assert.throws(() => scoreWeighted([{ ...weightedCase()[0], family_id: 'index-policy',
    state: 'partial', q: 0.5 }]), ContractError);
  assert.throws(() => scoreWeighted([{ ...weightedCase()[0], family_id: 'fetch-response',
    state: 'not_applicable', q: null }]), ContractError);
});

test('registry has 22 unique families and every profile sums to 100', () => {
  const registry = JSON.parse(readFileSync(new URL('../skills/optbrew/references/check-registry.json', import.meta.url)));
  const profiles = JSON.parse(readFileSync(new URL('../skills/optbrew/references/profiles.json', import.meta.url)));
  assert.equal(new Set(registry.families.map(x => x.family_id)).size, 22);
  for (const weights of Object.values(profiles.profiles))
    assert.equal(Object.values(weights).reduce((a, b) => a + b, 0), 100);
});

test('unobserved expected unit is unknown and conflicting or unregistered observations fail', () => {
  const input = fixture();
  const units = compileUnits(input, 'SEO');
  assert.ok(units.some(x => x.state === 'unknown'));
  assert.throws(() => compileUnits({ ...input, observations: [...input.observations,
    { ...input.observations[0], observation_id: 'duplicate', state: 'fail', q: 0 }] }, 'SEO'), ContractError);
  assert.throws(() => compileUnits({ ...input, observations: [...input.observations,
    { ...input.observations[0], observation_id: 'rogue', unit_key: 'rogue' }] }, 'SEO'), ContractError);
});

test('blocker and unknown core policy override a high measured score', () => {
  const input = fixture();
  const blocked = structuredClone(input);
  blocked.observations.push({ schema_version: '1.0.0', observation_id: 'noindex', check_id: 'index-policy',
    family_id: 'index-policy', unit_key: 'index-policy|https://example.com/', state: 'fail', q: 0,
    partial_basis: null, reason: 'unexpected noindex', evaluator_type: 'code', source_ref: 'synthetic', evidence_ref: 'e/noindex' });
  assert.equal(score(blocked)[0].readiness_status, 'blocked');
  const unknown = structuredClone(input);
  assert.equal(score(unknown)[0].readiness_status, 'unverified');
});

test('URL type weighting and duplicate observations do not multiply family weight', () => {
  const input = fixture();
  const units = compileUnits(input, 'SEO');
  const title = units.filter(x => x.family_id === 'document-title');
  assert.equal(title.length, 3);
  assert.ok(Math.abs(title[0].weight - title[1].weight) < 1e-9);
  assert.ok(Math.abs(title[1].weight * 2 - title[2].weight) < 1e-9);
  const dup = structuredClone(input);
  dup.observations.push({ ...dup.observations[0], observation_id: 'same-result' });
  assert.deepEqual(score(dup), score(input));
});

test('not applicable units redistribute within family and an empty axis is excluded', () => {
  const input = fixture();
  input.observations.push({ schema_version: '1.0.0', observation_id: 'title-na', check_id: 'document-title',
    family_id: 'document-title', unit_key: 'document-title|https://example.com/about',
    state: 'not_applicable', q: null, partial_basis: null, reason: 'non-HTML page',
    evaluator_type: 'code', source_ref: 'synthetic', evidence_ref: 'synthetic/title',
    applicability_decision: { condition: 'not_html', reason: 'verified non-HTML response', evidence_ref: 'synthetic/title' } });
  const units = compileUnits(input, 'SEO');
  const title = units.filter(x => x.family_id === 'document-title');
  assert.equal(title.length, 2);
  assert.ok(Math.abs(title[0].weight * 2 - title[1].weight) < 1e-9);
  assert.ok(Math.abs(units.reduce((sum, x) => sum + x.weight, 0) - 100) < 1e-9);
  input.run_context.protocol.families.filter(x => x.family_id.endsWith('-field')).forEach(x => {
    x.applicable = false;
    x.applicability_decision = { condition: 'outside_performance_scope',
      reason: 'synthetic intake excludes performance evaluation', evidence_ref: 'synthetic/intake' };
  });
  assert.equal(compileUnits(input, 'SEO').filter(x => x.family_id.endsWith('-field')).length, 0);
  assert.ok(Math.abs(compileUnits(input, 'SEO').reduce((sum, x) => sum + x.weight, 0) - 100) < 1e-9);
});

test('CWV exact p75 field boundaries and source restrictions', () => {
  for (const [family, good, poor, unit] of [
    ['lcp-field', 2500, 4000, 'ms'], ['inp-field', 200, 500, 'ms'], ['cls-field', 0.1, 0.25, 'unitless']]) {
    const source = { percentile: 75, source_type: 'field', unit };
    assert.deepEqual(cwvVerdict(family, good, source), { state: 'pass', q: 1, partial_basis: null });
    assert.equal(cwvVerdict(family, (good + poor) / 2, source).q, 0.5);
    assert.equal(cwvVerdict(family, poor, source).state, 'partial');
    assert.equal(cwvVerdict(family, poor + 0.000001, source).state, 'fail');
    assert.throws(() => cwvVerdict(family, good, { ...source, source_type: 'lab' }), ContractError);
  }
  const units = compileUnits(fixture(), 'SEO');
  assert.ok(units.filter(x => x.family_id.endsWith('-field')).every(x => x.state === 'unknown'));
});

test('skill CLI writes the same ScoreResult array as the library', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'optbrew-score-'));
  try {
    const output = path.join(dir, 'score.json');
    const child = spawnSync(process.execPath, ['skills/optbrew/scripts/cli.mjs', 'score', '--input',
      'tests/fixtures/scoring/partial.json', '--output', output], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(readOutput(output, 'utf8')), score(fixture()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('skill CLI rejects a partial noindex verdict before creating output', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'optbrew-score-invalid-'));
  try {
    const input = fixture();
    input.observations.push({ schema_version: '1.0.0', observation_id: 'noindex-partial',
      check_id: 'index-policy', family_id: 'index-policy',
      unit_key: 'index-policy|https://example.com/', state: 'partial', q: 0.5,
      partial_basis: { kind: 'threshold_half' }, reason: 'confirmed noindex', evaluator_type: 'code',
      source_ref: 'synthetic', evidence_ref: 'e/noindex' });
    const source = path.join(dir, 'input.json');
    const output = path.join(dir, 'score.json');
    writeFileSync(source, JSON.stringify(input));
    const child = spawnSync(process.execPath, ['skills/optbrew/scripts/cli.mjs', 'score',
      '--input', source, '--output', output], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /index-policy is binary/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fixed question coverage denominator cannot differ from the panel', () => {
  const input = fixture();
  input.run_context.protocol.question_panel = [{ id: 'q1', question: 'Who?', category: 'brand' },
    { id: 'q2', question: 'Where?', category: 'non_brand' }];
  const coveragePlan = input.run_context.protocol.families.find(x => x.family_id === 'question-coverage');
  coveragePlan.applicable = true;
  delete coveragePlan.applicability_decision;
  input.observations.push({ schema_version: '1.0.0', observation_id: 'coverage',
    check_id: 'question-coverage', family_id: 'question-coverage', unit_key: 'question-coverage|site',
    state: 'partial', q: 1 / 3, partial_basis: { kind: 'ratio', numerator: 1, denominator: 3 },
    reason: 'one evidenced answer', evaluator_type: 'human', source_ref: 'synthetic', evidence_ref: 'e/questions' });
  assert.throws(() => compileUnits(input, 'SEO'), ContractError);
  input.observations.at(-1).partial_basis.denominator = 2;
  input.observations.at(-1).q = 0.5;
  assert.ok(compileUnits(input, 'SEO').some(x => x.family_id === 'question-coverage' && x.q === 0.5));
});

test('high score and full coverage do not conceal a confirmed noindex blocker', () => {
  const input = fixture();
  const measurements = { 'lcp-field': { value: 2500, percentile: 75, source_type: 'field', unit: 'ms' },
    'inp-field': { value: 200, percentile: 75, source_type: 'field', unit: 'ms' },
    'cls-field': { value: 0.1, percentile: 75, source_type: 'field', unit: 'unitless' } };
  const present = new Set(input.observations.map(x => x.unit_key));
  for (const unit of compileUnits(input, 'SEO')) if (!present.has(unit.key))
    input.observations.push({ schema_version: '1.0.0', observation_id: `pass-${unit.key}`,
      check_id: unit.family_id, family_id: unit.family_id, unit_key: unit.key,
      state: 'pass', q: 1, partial_basis: null, reason: 'synthetic pass', evaluator_type: 'code',
      source_ref: 'synthetic', evidence_ref: `synthetic/${unit.family_id}`,
      ...(measurements[unit.family_id] ? { measurement: measurements[unit.family_id] } : {}) });
  const measured = score(input)[0];
  assert.equal(measured.score, 100);
  assert.equal(measured.readiness_status, 'measured');
  const noindex = input.observations.find(x => x.unit_key === 'index-policy|https://example.com/');
  noindex.state = 'fail'; noindex.q = 0; noindex.reason = 'unexpected noindex';
  const blocked = score(input)[0];
  assert.ok(blocked.score >= 80);
  assert.equal(blocked.coverage, 100);
  assert.equal(blocked.readiness_status, 'blocked');
  input.observations.splice(input.observations.indexOf(noindex), 1);
  assert.equal(score(input)[0].readiness_status, 'unverified');
});

test('duplicate matching blocker verdicts yield stable evidence independent of input order', () => {
  const input = fixture();
  const first = { schema_version: '1.0.0', observation_id: 'a', check_id: 'index-policy',
    family_id: 'index-policy', unit_key: 'index-policy|https://example.com/', state: 'fail', q: 0,
    partial_basis: null, reason: 'first evidence', evaluator_type: 'code',
    source_ref: 'synthetic', evidence_ref: 'e/first' };
  const second = { ...first, observation_id: 'z', reason: 'second evidence', evidence_ref: 'e/second' };
  input.observations.push(first, second);
  const reversed = structuredClone(input);
  reversed.observations.reverse();
  assert.deepEqual(score(input), score(reversed));
  assert.equal(score(input)[0].blockers[0].evidence_ref, 'e/first');
});

test('unit N/A requires an allowed condition decision and core units cannot disappear', () => {
  const input = fixture();
  input.observations.push({ schema_version: '1.0.0', observation_id: 'fetch-na',
    check_id: 'fetch-response', family_id: 'fetch-response',
    unit_key: 'fetch-response|https://example.com/about', state: 'not_applicable', q: null,
    partial_basis: null, reason: 'no data', evaluator_type: 'code',
    source_ref: 'synthetic', evidence_ref: 'e/na' });
  assert.throws(() => compileUnits(input, 'SEO'), ContractError);
  input.observations.pop();
  const titleNa = { schema_version: '1.0.0', observation_id: 'title-na',
    check_id: 'document-title', family_id: 'document-title',
    unit_key: 'document-title|https://example.com/about', state: 'not_applicable', q: null,
    partial_basis: null, reason: 'non-HTML page', evaluator_type: 'code',
    source_ref: 'synthetic', evidence_ref: 'e/title' };
  input.observations.push(titleNa);
  assert.throws(() => compileUnits(input, 'SEO'), ContractError);
  titleNa.applicability_decision = { condition: 'not_html', reason: 'verified non-HTML response', evidence_ref: 'e/title' };
  assert.equal(compileUnits(input, 'SEO').filter(x => x.family_id === 'document-title').length, 2);
});

test('unknown public-indexing intent keeps core units; evidenced non-target excludes only that URL', () => {
  const input = fixture();
  input.run_context.protocol.families.find(x => x.family_id === 'search-crawl-policy').applicable = true;
  const publicBefore = compileUnits(input, 'SEO');
  assert.equal(publicBefore.filter(x => x.family_id === 'index-policy').length, 3);
  assert.equal(publicBefore.filter(x => x.family_id === 'search-crawl-policy').length, 3);
  const url = input.run_context.protocol.page_types[0].urls[1];
  url.public_indexing = false;
  url.indexing_decision = { condition: 'not_public_index_target', reason: 'support route deliberately excluded', evidence_ref: 'e/intake' };
  const publicAfter = compileUnits(input, 'SEO');
  assert.equal(publicAfter.filter(x => x.family_id === 'index-policy').length, 2);
  assert.equal(publicAfter.filter(x => x.family_id === 'search-crawl-policy').length, 2);
  assert.equal(publicAfter.filter(x => x.family_id === 'fetch-response').length, 3);
});

test('unit N/A cannot contradict fixed panel, public URL, or target engine facts', () => {
  const input = fixture();
  const example = { schema_version: '1.0.0', observation_id: 'na',
    state: 'not_applicable', q: null, partial_basis: null, reason: 'synthetic exclusion',
    evaluator_type: 'code', source_ref: 'synthetic', evidence_ref: 'e/na' };
  const decision = condition => ({ condition, reason: 'synthetic condition evidence', evidence_ref: 'e/na' });
  input.observations.push({ ...example, check_id: 'discovery', family_id: 'discovery',
    unit_key: 'discovery|https://example.com/', applicability_decision: decision('no_public_index_target') });
  assert.throws(() => compileUnits(input, 'SEO'), ContractError);
  input.observations.pop();
  input.run_context.protocol.question_panel = [{ id: 'q1', question: 'What?', category: 'brand' }];
  const coveragePlan = input.run_context.protocol.families.find(x => x.family_id === 'question-coverage');
  coveragePlan.applicable = true; delete coveragePlan.applicability_decision;
  input.observations.push({ ...example, check_id: 'question-coverage', family_id: 'question-coverage',
    unit_key: 'question-coverage|site', applicability_decision: decision('no_fixed_questions') });
  assert.throws(() => compileUnits(input, 'SEO'), ContractError);
  input.observations.pop();
  input.run_context.protocol.engines.push('naver');
  const naverPlan = input.run_context.protocol.families.find(x => x.family_id === 'naver-markup');
  naverPlan.applicable = true; delete naverPlan.applicability_decision;
  input.observations.push({ ...example, check_id: 'naver-markup', family_id: 'naver-markup',
    unit_key: 'naver-markup|naver|https://example.com/', applicability_decision: decision('naver_not_target') });
  assert.throws(() => compileUnits(input, 'SEO'), ContractError);
});

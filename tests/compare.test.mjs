import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { cwvVerdict } from '../skills/optbrew/scripts/core/contracts.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/scoring/partial.json', import.meta.url)));
const pass = (unit, id = unit) => ({ schema_version: '2.0.0', observation_id: id,
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

test('target, URLs, page type, conditions, questions, goals, confirmed facts, surface, model, environment and evaluation version are comparison conditions', () => {
  const mutate = [
    x => { x.run_context.target = 'other.example'; },
    x => { x.run_context.protocol.page_types[0].urls[0].normalized = 'https://example.com/new'; },
    x => { x.run_context.protocol.page_types[0].id = 'other'; },
    x => { const f = x.run_context.protocol.families.find(f => f.family_id === 'render-content'); f.applicable = true; delete f.applicability_decision; },
    x => { x.run_context.protocol.question_panel = [{ id: 'q', question: 'Who?', category: 'brand' }]; const f = x.run_context.protocol.families.find(f => f.family_id === 'question-coverage'); f.applicable = true; delete f.applicability_decision; },
    x => { x.run_context.protocol.surfaces = ['claude_web']; },
    x => { x.run_context.protocol.models = ['model-v2']; },
    x => { x.run_context.environment = 'production'; },
    x => { x.run_context.evaluation_version = '0.7.0'; },
  ];
  for (const change of mutate) {
    const before = fixture(), after = fixture(); change(after);
    const result = compare(before, after);
    assert.equal(result.status, 'not_comparable');
    assert.ok(result.reasons.length, JSON.stringify(after.run_context));
    assert.deepEqual(result.score_deltas, []);
  }
  const named = change => { const after = fixture(); change(after.run_context.protocol); return compare(fixture(), after).reasons; };
  assert.deepEqual(named(protocol => { protocol.goals = ['search']; }), ['goals_changed'], 'a goal that switches no family on still changes the conditions');
  assert.deepEqual(named(protocol => { protocol.confirmed_facts = [{ key: 'phone', value: '02-555-0142' }]; }), ['confirmed_facts_changed']);
});

test('a baseline of the release before goals (evaluation 0.4.0, protocol 0.2.0) is not comparable with a current follow-up, without a crash', () => {
  const current = fixture();
  const previous = structuredClone(current);
  Object.assign(previous.run_context, { evaluation_version: '0.4.0', protocol_version: '0.2.0' });
  // That release planned neither goal-bound nor AI crawler families and wrote no goals or confirmed facts into the protocol.
  delete previous.run_context.protocol.goals;
  delete previous.run_context.protocol.confirmed_facts;
  previous.run_context.protocol.families = previous.run_context.protocol.families.filter(family => !['ai-crawler-policy', 'conversion-path'].includes(family.family_id));
  for (const [before, after, who] of [[previous, current, 'baseline'], [current, previous, 'follow-up']]) {
    const result = compare(before, after);
    assert.deepEqual([result.status, result.score_deltas], ['not_comparable', []]);
    assert.deepEqual(result.reasons, [`the ${who} was made with audit protocol 0.2.0, which is older than the current one; run a new audit to compare`]);
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

test('an input made by an older release is not comparable, in plain words, found by its version labels', () => {
  const current = fixture();
  const older = structuredClone(current);
  Object.assign(older.run_context, { schema_version: '1.0.0', evaluation_version: '0.3.0', protocol_version: '0.1.0' });
  for (const [before, after, who] of [[older, current, 'baseline'], [current, older, 'follow-up']]) {
    const result = compare(before, after);
    assert.equal(result.status, 'not_comparable');
    assert.deepEqual(result.score_deltas, []);
    assert.equal(result.reasons.length, 1);
    assert.ok(result.reasons[0].startsWith(`the ${who} was made with audit protocol 0.1.0, which is older than the current one`), result.reasons[0]);
  }
  assert.equal(compare(older, null).status, 'no_after');
  const shapeOnly = structuredClone(current);
  delete shapeOnly.run_context.protocol.render;
  assert.throws(() => compare(shapeOnly, current), /render/, 'a current file that lacks render is a broken file, not an old one');
  const broken = structuredClone(current);
  delete broken.run_context.target;
  assert.throws(() => compare(broken, current), /target/);
});

// A re-audit after the fixes the report asks for: the unit table is told even when the two runs cannot be scored against each other.
const home = 'https://example.com/', about = 'https://example.com/about', help = 'https://example.com/help';
const plan = (input, familyId) => { const family = input.run_context.protocol.families.find(f => f.family_id === familyId); family.applicable = true; delete family.applicability_decision; };
const notApplicable = (unit, condition) => ({ ...pass(unit), state: 'not_applicable', q: null,
  applicability_decision: { condition, reason: 'verified', evidence_ref: 'synthetic/decision' } });
const model = (unit, state) => ({ ...pass(unit), evaluator_type: 'host_model', state, q: state === 'pass' ? 1 : state === 'fail' ? 0 : null,
  ...(state === 'unknown' ? {} : { evidence_span: [{ evidence_sha256: 'a'.repeat(64), start: 0, end: 1 }] }) });
/** The baseline: /help is kept out of the index, the title of the home page fails and no page has JSON-LD. */
function baseline() {
  const input = fixture();
  const url = input.run_context.protocol.page_types[1].urls[0];
  url.public_indexing = false;
  url.indexing_decision = { condition: 'not_public_index_target', reason: 'noindex', evidence_ref: 'synthetic/decision' };
  plan(input, 'structured-data-truth');
  input.observations = [{ ...pass(`document-title|${home}`), state: 'fail', q: 0 }, pass(`document-title|${about}`),
    ...[home, about, help].map(url => notApplicable(`structured-data-truth|${url}`, 'markup_not_used_or_selected'))];
  return input;
}
const transitionOf = (result, unit) => result.unit_transitions.changed.find(x => x.unit_key === unit);

test('the fixes the report asks for (title, noindex removed) leave a unit table although the runs are not comparable', () => {
  const after = baseline();
  after.run_context.protocol.page_types[1].urls[0] = { original: help, normalized: help };
  after.observations = [pass(`document-title|${home}`), pass(`document-title|${about}`), pass(`document-title|${help}`),
    ...[home, about, help].map(url => notApplicable(`structured-data-truth|${url}`, 'markup_not_used_or_selected'))];
  const result = compare(baseline(), after);
  assert.equal(result.status, 'not_comparable');
  assert.deepEqual(result.reasons, ['page_types_changed']);
  assert.deepEqual(result.score_deltas, []);
  assert.deepEqual(transitionOf(result, `document-title|${home}`), { unit_key: `document-title|${home}`, family_id: 'document-title',
    evaluator_type: 'code', before: 'fail', after: 'pass' });
  assert.deepEqual(result.unit_transitions.only_before, []);
  assert.deepEqual(result.unit_transitions.only_after.map(x => x.unit_key), [`document-title|${help}`, `index-policy|${help}`,
    `discovery|${help}`, `search-crawl-policy|google|${help}`].sort());
  assert.equal(result.unit_transitions.changed.length, 1, 'only the title of the home page changed state');
  assert.ok(result.unit_transitions.unchanged > 0);
});

test('adding JSON-LD (a not-applicable unit becomes a verdict) leaves a unit table and names the unit that appeared', () => {
  const after = baseline();
  after.observations = [pass(`document-title|${home}`), pass(`document-title|${about}`), pass(`structured-data-truth|${home}`),
    notApplicable(`structured-data-truth|${about}`, 'markup_not_used_or_selected'), notApplicable(`structured-data-truth|${help}`, 'markup_not_used_or_selected')];
  const result = compare(baseline(), after);
  assert.equal(result.status, 'not_comparable');
  assert.deepEqual(result.reasons, ['applicable_units_changed']);
  assert.deepEqual(result.unit_transitions.only_after, [{ unit_key: `structured-data-truth|${home}`, family_id: 'structured-data-truth',
    evaluator_type: 'code', state: 'pass' }]);
  assert.equal(transitionOf(result, `document-title|${home}`).after, 'pass');
});

test('a model verdict that flips between not applicable and unknown on unchanged evidence shows as one unit that appeared, with its evaluator', () => {
  const before = baseline(), after = baseline();
  for (const input of [before, after]) {
    plan(input, 'claim-support');
    input.observations.push(model(`claim-support|${home}`, 'pass'), notApplicable(`claim-support|${about}`, 'no_material_claims'),
      notApplicable(`claim-support|${help}`, 'no_material_claims'));
  }
  after.observations = after.observations.filter(x => x.unit_key !== `claim-support|${about}`);
  after.observations.push(model(`claim-support|${about}`, 'unknown'));
  const result = compare(before, after);
  assert.equal(result.status, 'not_comparable');
  assert.deepEqual(result.reasons, ['applicable_units_changed']);
  assert.deepEqual(result.unit_transitions.only_after, [{ unit_key: `claim-support|${about}`, family_id: 'claim-support',
    evaluator_type: 'host_model', state: 'unknown' }]);
  assert.deepEqual(result.unit_transitions.changed, []);
});

test('a comparable result splits the score change by who judged: only the model verdict moved', () => {
  const before = baseline(), after = baseline();
  for (const [input, state] of [[before, 'pass'], [after, 'fail']]) {
    plan(input, 'claim-support');
    input.observations.push(model(`claim-support|${home}`, state), notApplicable(`claim-support|${about}`, 'no_material_claims'),
      notApplicable(`claim-support|${help}`, 'no_material_claims'));
  }
  const result = compare(before, after);
  assert.equal(result.status, 'comparable', JSON.stringify(result.reasons));
  const { by_evaluator } = result.score_deltas[0];
  assert.deepEqual(by_evaluator.host_model, { before: 100, after: 0, raw_difference: -100 });
  assert.equal(by_evaluator.code.raw_difference, 0);
  assert.equal(result.unit_transitions.changed.length, 1);
});

test('report.md counts the units that moved on the comparison line, and says nothing when none did', async () => {
  const { composeReport, renderReport } = await import('../skills/optbrew/scripts/core/report-compose.mjs');
  const { verifiedOf } = await import('./support/compose.mjs');
  const verified = verifiedOf();
  const markdown = value => renderReport(composeReport(value), value).markdown;
  assert.ok(!markdown(verified).includes('단위 변화'));
  const unit = { unit_key: `document-title|${home}`, family_id: 'document-title', evaluator_type: 'code' };
  const moved = { ...verified, comparison: { ...verified.comparison, unit_transitions: { unchanged: 3,
    changed: [{ ...unit, before: 'fail', after: 'pass' }], only_before: [], only_after: [{ ...unit, state: 'pass' }] } } };
  assert.ok(markdown(moved).includes('단위 변화: 상태가 바뀐 1건, 한쪽 실행에만 있는 1건'));
});

// What the later run says about each fix the earlier run listed (the finding ids of its fixes.md).
const failing = unit => ({ ...pass(unit), state: 'fail', q: 0 });
const findingOf = unit => `finding-${unit}`;
function threeFixes() {
  const before = fixture();
  before.observations = [failing(`document-title|${home}`), failing(`index-policy|${home}`), failing(`discovery|${home}`)];
  return before;
}
const outcomesOf = (result, ids) => Object.fromEntries(result.finding_outcomes.filter(x => ids.includes(x.finding_id)).map(x => [x.finding_id, x.outcome]));

test('of three fixes listed, the one that was done is resolved, the one that still fails remains, the one with no verdict is unknown', () => {
  const after = threeFixes();
  after.observations = [pass(`document-title|${home}`), failing(`index-policy|${home}`)];
  const ids = [`document-title|${home}`, `index-policy|${home}`, `discovery|${home}`].map(findingOf);
  const result = compare(threeFixes(), after, { fixIds: ids });
  assert.equal(result.status, 'comparable', JSON.stringify(result.reasons));
  assert.deepEqual(outcomesOf(result, ids), { [ids[0]]: 'resolved', [ids[1]]: 'remaining', [ids[2]]: 'unknown' });
  assert.deepEqual(result.finding_outcomes.find(x => x.finding_id === ids[0]).units, [{ unit_key: `document-title|${home}`, after: 'pass' }]);
  assert.equal(compare(threeFixes(), after).finding_outcomes, undefined, 'without a fix list there is no outcome list');
});

test('a fix that touches several pages is resolved only when every page passes', () => {
  const before = fixture();
  before.observations = [failing(`document-title|${home}`), failing(`document-title|${about}`)];
  const after = fixture();
  after.observations = [pass(`document-title|${home}`), pass(`document-title|${about}`)];
  const id = findingOf(`document-title|${home}`);
  assert.equal(compare(before, after, { fixIds: [id] }).finding_outcomes[0].units.length, 2, 'one finding names both pages');
  assert.equal(compare(before, after, { fixIds: [id] }).finding_outcomes[0].outcome, 'resolved');
  after.observations[1] = failing(`document-title|${about}`);
  assert.equal(compare(before, after, { fixIds: [id] }).finding_outcomes[0].outcome, 'remaining');
});

test('the outcome of a fix is told when only the units that apply changed (not_comparable), and an id the baseline never listed is unknown', () => {
  const after = baseline();
  after.run_context.protocol.page_types[1].urls[0] = { original: help, normalized: help };
  after.observations = [pass(`document-title|${home}`), pass(`document-title|${about}`)];
  const ids = [findingOf(`document-title|${home}`), 'finding-not-in-the-baseline'];
  const result = compare(baseline(), after, { fixIds: ids });
  assert.equal(result.status, 'not_comparable');
  assert.deepEqual(outcomesOf(result, ids), { [ids[0]]: 'resolved', [ids[1]]: 'unknown' });
  assert.deepEqual(result.finding_outcomes[1].units, []);
});

test('no outcome is told when the runs were made under other conditions: a pass there proves nothing', () => {
  const after = threeFixes();
  after.run_context.environment = 'production';
  after.observations = [pass(`document-title|${home}`)];
  const result = compare(threeFixes(), after, { fixIds: [findingOf(`document-title|${home}`)] });
  assert.equal(result.status, 'not_comparable');
  assert.equal(result.finding_outcomes, undefined);
  assert.ok(result.unit_transitions, 'the unit table is still told');
});

test('compare CLI takes the previous fixes.md and writes the outcome of each fix it lists', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'optbrew-compare-fixes-'));
  try {
    const after = threeFixes();
    after.observations = [pass(`document-title|${home}`), failing(`index-policy|${home}`)];
    for (const [name, value] of Object.entries({ before: threeFixes(), after })) writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
    writeFileSync(path.join(dir, 'fixes.md'), ['# 고칠 것 목록', '', `## ${findingOf(`document-title|${home}`)}`, '', '- 문제: x', '',
      `## ${findingOf(`index-policy|${home}`)}`, '', '- 문제: y', ''].join('\n'));
    const output = path.join(dir, 'result.json');
    const child = spawnSync(process.execPath, ['skills/optbrew/scripts/cli.mjs', 'compare', '--before', path.join(dir, 'before.json'),
      '--after', path.join(dir, 'after.json'), '--fixes', path.join(dir, 'fixes.md'), '--output', output],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(result.finding_outcomes.map(x => x.outcome), ['resolved', 'remaining']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The 28-day window the field data of a run was collected in: an after window that overlaps the before window still holds days from before the deploy.
const origin = 'https://example.com';
const field = (value, period) => {
  const measurement = { value, percentile: 75, source_type: 'field', unit: 'ms', ...(period === undefined ? {} : { collection_period: period }) };
  return { ...pass(`lcp-field|${origin}`), ...cwvVerdict('lcp-field', value, measurement), measurement };
};
const during = (first_date, last_date) => ({ first_date, last_date });
const withField = (...observations) => { const input = fixture(); input.observations = observations; return input; };

test('an after window that overlaps the before window is refused, naming both windows and the unit', () => {
  const before = withField(field(3000, during('2026-09-01', '2026-09-28')));
  const after = withField(field(2000, during('2026-09-20', '2026-10-17')));
  const result = compare(before, after);
  assert.equal(result.status, 'not_comparable');
  assert.deepEqual(result.reasons, ['cwv_window_overlap']);
  assert.deepEqual(result.score_deltas, []);
  assert.deepEqual(result.cwv_windows, [{ unit_key: `lcp-field|${origin}`, before: during('2026-09-01', '2026-09-28'),
    after: during('2026-09-20', '2026-10-17'), state: 'overlap' }]);
  assert.equal(result.warnings, undefined);
  const touching = compare(before, withField(field(2000, during('2026-09-28', '2026-10-25'))));
  assert.deepEqual(touching.reasons, ['cwv_window_overlap'], 'a shared last day is an overlap');
});

test('a window that starts after the before window ends compares as before, and its dates are told', () => {
  const result = compare(withField(field(3000, during('2026-09-01', '2026-09-28'))), withField(field(2000, during('2026-09-29', '2026-10-26'))));
  assert.equal(result.status, 'comparable', JSON.stringify(result.reasons));
  assert.deepEqual(result.cwv_windows.map(x => x.state), ['separate']);
  assert.equal(result.warnings, undefined);
  assert.ok(result.score_deltas[0].raw_difference > 0);
});

test('a missing, null or unreadable window never refuses the comparison; it is a warning that the window cannot be checked', () => {
  const dated = field(3000, during('2026-09-01', '2026-09-28'));
  for (const later of [field(2000), field(2000, null), field(2000, during('2026-09-29', null)), field(2000, during('soon', 'later'))]) {
    const result = compare(withField(dated), withField(later));
    assert.equal(result.status, 'comparable', JSON.stringify(result.reasons));
    assert.deepEqual(result.warnings, ['cwv_window_unverifiable']);
    assert.deepEqual(result.cwv_windows.map(x => [x.state, x.before !== null]), [['unverifiable', true]]);
  }
  assert.equal(compare(withField(field(3000)), withField(field(2000))).warnings[0], 'cwv_window_unverifiable', 'an old evidence file has no window at all');
  assert.equal(compare(fixture(), fixture()).cwv_windows, undefined, 'no field data, nothing to say');
});

test('under an overlapping window a field pass is not told as resolved, while a fix that is not field data still is', () => {
  const before = withField(failing(`document-title|${home}`), field(3000, during('2026-09-01', '2026-09-28')));
  const after = withField(pass(`document-title|${home}`), field(2000, during('2026-09-20', '2026-10-17')));
  const ids = [`document-title|${home}`, `lcp-field|${origin}`].map(findingOf);
  const result = compare(before, after, { fixIds: ids });
  assert.deepEqual(result.reasons, ['cwv_window_overlap']);
  assert.deepEqual(outcomesOf(result, ids), { [ids[0]]: 'resolved', [ids[1]]: 'unknown' });
});

test('report.md says which window overlaps and which could not be checked', async () => {
  const { composeReport, markdownText, renderReport } = await import('../skills/optbrew/scripts/core/report-compose.mjs');
  const { verifiedOf } = await import('./support/compose.mjs');
  const verified = verifiedOf();
  const unitText = markdownText(`lcp-field|${origin}`);
  const markdown = comparison => {
    const told = { ...verified, comparison: { ...verified.comparison, ...comparison } };
    return renderReport(composeReport(told), told).markdown;
  };
  const overlap = markdown({ status: 'not_comparable', reasons: ['cwv_window_overlap'], cwv_windows: [{ unit_key: `lcp-field|${origin}`,
    before: during('2026-09-01', '2026-09-28'), after: during('2026-09-20', '2026-10-17'), state: 'overlap' }] });
  assert.ok(overlap.includes(`CWV 수집 창이 겹칩니다: ${unitText} 이전 2026-09-01~2026-09-28, 이후 2026-09-20~2026-10-17`));
  const unknown = markdown({ warnings: ['cwv_window_unverifiable'], cwv_windows: [{ unit_key: `lcp-field|${origin}`, before: null, after: null, state: 'unverifiable' }] });
  assert.ok(unknown.includes(`CWV 수집 창 확인 불가: ${unitText}`));
  assert.ok(!markdown({}).includes('CWV 수집 창'));
});

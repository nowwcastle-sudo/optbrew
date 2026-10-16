import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { composeReport, renderReport } from '../skills/optbrew/scripts/core/report-compose.mjs';
import { loadRunbook, runbookEntry } from '../skills/optbrew/scripts/core/runbooks.mjs';
import { keySetRunbook } from '../skills/optbrew/scripts/core/probe.mjs';
import { compileUnits } from '../skills/optbrew/scripts/core/weights.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { CONTENT_AFTER_RENDER } from '../skills/optbrew/scripts/core/checks/render-content.mjs';
import { environmentProbe } from './support/probe.mjs';
import { fixturePacket, headlineOf, verifiedOf } from './support/compose.mjs';

const withProbe = (probe, over = {}) => {
  const verified = verifiedOf(over);
  const environment_probe = environmentProbe(probe);
  const phase = value => value && { ...value, input: { ...value.input, run_context: { ...value.input.run_context, environment_probe } } };
  return { ...verified, run_context: { ...verified.run_context, environment_probe }, baseline: phase(verified.baseline), after: phase(verified.after) };
};
const finding = (id, over) => ({ schema_version: '1.0.0', finding_id: id, check_id: 'index-policy', unit_key: `index-policy|https://example.com/${id}`,
  priority: 'P1', blocker: false, message: `problem ${id}`, source_ref: 'module:a', evidence_ref: 'module-a.html', remediation_ids: [],
  status: 'proposed_only', finding_ids: [id], sources: [], remediation: null, resolution: null, ...over });
const order = composed => composed.fixes.map(item => item.finding_id);
/** A phase result of the first profile as score() would give it, with the coverage and score the test needs. */
const result = over => ({ ...verifiedOf().baseline.scores[0], score: 91.2, A: 100, M: 90, N: 82, coverage: 90, unknown_core: [], blockers: [], readiness_status: 'unverified', ...over });
const unscored = observations => ({ input: { run_context: verifiedOf().baseline.input.run_context, observations }, scores: [] });
const later = (observations = []) => {
  const { baseline } = verifiedOf();
  return { input: { ...baseline.input, observations: [...baseline.input.observations, ...observations] }, scores: baseline.scores };
};

test('fixes sort blocker, then priority, then affected pages', () => {
  const same = { check_id: 'canonical-consistency', message: 'canonical points elsewhere' };
  const findings = [
    finding('p2', { priority: 'P2' }),
    finding('z1', { message: 'only here' }),
    finding('y3', { message: 'on many pages' }), finding('y1', { message: 'on many pages' }), finding('y2', { message: 'on many pages' }),
    finding('n0', { priority: 'P0' }),
    finding('b1', { priority: 'P0', blocker: true }),
    finding('b2b', { priority: 'P0', blocker: true, ...same, unit_key: 'canonical-consistency|https://example.com/b' }),
    finding('b2a', { priority: 'P0', blocker: true, ...same, unit_key: 'canonical-consistency|https://example.com/a' }),
  ];
  const expected = ['b2a', 'b2b', 'b1', 'n0', 'y1', 'y2', 'y3', 'z1', 'p2'];
  assert.deepEqual(order(composeReport(verifiedOf({ findings }))), expected);
  assert.deepEqual(order(composeReport(verifiedOf({ findings: [...findings].reverse() }))), expected);
});

test('open fixes come before resolved ones, and an unknown priority sorts last', () => {
  const findings = [finding('done', { priority: 'P0', blocker: true, status: 'verified_production' }), finding('odd', { priority: 'P10' }),
    finding('low', { priority: 'P3' }), finding('lower', { priority: 'p1' }), finding('open', { priority: 'P2' })];
  assert.deepEqual(order(composeReport(verifiedOf({ findings }))), ['open', 'low', 'odd', 'lower', 'done']);
  assert.deepEqual(composeReport(verifiedOf({ findings })).headline, { open: 4, blocking: 0, already_fixed: 1, text: '4 thing(s) to fix first.' });
});

test('findings come before scores in json and md', () => {
  const { json, markdown } = buildReport(fixturePacket());
  const text = JSON.stringify(json);
  assert.deepEqual(Object.keys(json.composed), ['headline', 'fixes', 'completeness', 'remaining', 'conditions']);
  assert.ok(text.indexOf('"fixes"') < text.indexOf('"completeness"'));
  for (const scoreField of ['"headline_score"', '"measured_subset_score"', '"pass_rate_in_measured"', '"score"'])
    assert.ok(text.indexOf('"fixes"') < text.indexOf(scoreField), scoreField);
  assert.deepEqual(json.findings, json.composed.fixes);
  assert.equal(json.headline, undefined, 'the conclusion is composed.headline; the per-profile headlines are in completeness');
  assert.equal(json.composed.headline.open, 1);
  const at = value => { assert.ok(markdown.includes(value), value); return markdown.indexOf(value); };
  assert.ok(at('Result:') < at('## Fix first'));
  assert.ok(at('## Fix first') < at('## Completeness (pass rate within what was measured)'));
  assert.ok(at('Headline:') > at('## Fix first'), 'no score before the fixes');
  assert.doesNotMatch(markdown.slice(0, at('## Fix first')), /\bscore|coverage/i);
  const sections = ['## Fix first', '## Completeness', '## Still blank', '## Run conditions', '## Remaining work', '## Actual outcomes'].map(at);
  assert.deepEqual(sections, [...sections].sort((a, b) => a - b), 'design order: fixes, completeness, blanks, conditions, then the rest');
});

test('completeness holds both phases, the difference and the coverage without field CWV', () => {
  const [seo] = composeReport(verifiedOf()).completeness;
  assert.equal(seo.after, null);
  assert.equal(seo.before.coverage, seo.coverage);
  assert.ok(seo.coverage_without_cwv > seo.coverage, 'unknown field checks no longer weigh the coverage down');
  assert.equal(seo.pass_rate_in_measured, buildReport(fixturePacket()).json.baseline.scores[0].score);
  const both = composeReport(verifiedOf({ after: { ...later(), scores: [result({ score: 95, coverage: 95 })] },
    comparison: { status: 'comparable', score_deltas: [{ profile: 'SEO', percentage_point_delta: 3.5 }], reasons: [] } })).completeness[0];
  assert.equal(both.pass_rate_in_measured, 95, 'the latest phase gives the figures');
  assert.equal(both.before.coverage, seo.coverage);
  assert.equal(both.after.coverage, 95);
  assert.equal(both.difference, 3.5);
  assert.equal(both.between_measured_subsets, true, 'the before phase is not sufficient');
});

test('lab CWV appears only under conditions', () => {
  const lab = { lcp: 1234.5, cls: 0.0421 };
  assert.equal(composeReport(verifiedOf()).conditions.lab_cwv, null);
  const verified = verifiedOf({ lab_cwv: lab });
  const composed = composeReport(verified);
  assert.deepEqual(composed.conditions.lab_cwv, lab);
  const { markdown, tables } = renderReport(composed, verified);
  assert.doesNotMatch(JSON.stringify({ ...composed, conditions: undefined, tables }), /1234\.5|0\.0421/);
  const before = markdown.slice(0, markdown.indexOf('## Run conditions'));
  assert.doesNotMatch(before, /1234\.5|0\.0421|Lab Core Web Vitals/);
  assert.match(markdown.slice(markdown.indexOf('## Run conditions')), /Lab Core Web Vitals \(reference, not scored\): LCP 1234\.5 ms; CLS 0\.0421/);
  const packet = fixturePacket(); packet.lab_cwv = lab;
  const { json } = buildReport(packet);
  assert.deepEqual(json.composed.conditions.lab_cwv, lab);
  assert.equal(JSON.stringify(json).split('1234.5').length, 2, 'the value is written once, under conditions');
});

test('a malformed lab CWV or an unknown answered runbook is refused', () => {
  for (const lab_cwv of [{ lcp: '1200', cls: null }, {}, { lcp: 1, cls: 2, fid: 3 }]) {
    const packet = fixturePacket(); packet.lab_cwv = lab_cwv;
    assert.throws(() => buildReport(packet), /lab_cwv|lcp|cls/, JSON.stringify(lab_cwv));
  }
  const answered = fixturePacket(); answered.answered_runbooks = ['no-such-runbook'];
  assert.throws(() => buildReport(answered), /unknown runbook/);
});

test('the JavaScript note shows only when a page showed its content after rendering', () => {
  assert.deepEqual(composeReport(verifiedOf()).conditions.notes, []);
  const observation = (state, reason) => ({ ...verifiedOf().baseline.input.observations[0], observation_id: 'render', check_id: 'render-content',
    family_id: 'render-content', unit_key: 'render-content|https://example.com/', state, q: state === 'pass' ? 1 : null, reason });
  const note = renderedState => composeReport(verifiedOf({ after: unscored([observation(...renderedState)]) })).conditions.notes;
  assert.deepEqual(note(['unknown', 'chrome_missing']), []);
  assert.deepEqual(note(['pass', 'The raw HTML holds 400 body characters and the render is empty']), []);
  const [text] = note(['pass', `${CONTENT_AFTER_RENDER}: 900 body characters rendered, 40 in the raw HTML`]);
  assert.match(text, /Naver and AI crawlers may not run JavaScript/);
  assert.match(text, /not part of any score/);
  const verified = verifiedOf({ after: unscored([observation('pass', `${CONTENT_AFTER_RENDER}: 900 body characters rendered`)]) });
  const composed = composeReport(verified);
  const { markdown, tables } = renderReport(composed, verified);
  for (const part of [composed.fixes, composed.completeness, tables]) assert.ok(!JSON.stringify(part).includes('run JavaScript'));
  assert.ok(markdown.indexOf('run JavaScript') > markdown.indexOf('## Run conditions'));
});

test('conditions report the run: probe, model judgments and the key', () => {
  const { conditions } = composeReport(withProbe({ harness: 'codex', source_tools: ['graft'], google_key: true }));
  assert.equal(conditions.probe.harness, 'codex');
  assert.deepEqual(conditions.probe.source_tools, ['graft']);
  assert.deepEqual(conditions.model_judgments, []);
});

test('each remaining item has runbook ids that exist', () => {
  for (const harness of ['claude-code', 'codex', 'claude-code-cloud', 'other']) {
    const { remaining } = composeReport(withProbe({ harness, google_key: false, chrome: { found: false, kind: null, reason: 'chrome_not_found' } }));
    assert.ok(remaining.length >= 2, harness);
    for (const row of remaining) {
      assert.match(row.item, / — /, `${row.item}: item says what it is and what it adds`);
      assert.ok(Array.isArray(row.fills) && row.runbook_ids.length > 0, harness);
      for (const id of row.runbook_ids) {
        assert.ok(runbookEntry(id), `${harness}: ${id} is in the index`);
        assert.equal(loadRunbook(id, 'brief', { skillRoot: 'x' }).id, id);
      }
    }
  }
});

test('the Google key item adds the key-saving runbook that matches the harness', () => {
  const expected = { 'claude-code': ['local', 'key-set-local'], codex: ['codex', 'key-set-codex'],
    'claude-code-cloud': ['claude-code-cloud', 'key-set-claude-cloud'], other: ['local', 'key-set-local'] };
  for (const [harness, [family, id]] of Object.entries(expected)) {
    const { remaining } = composeReport(withProbe({ harness, google_key: false }));
    const key = remaining.find(row => row.runbook_ids[0] === 'google-api-key');
    assert.deepEqual(key.runbook_ids, ['google-api-key', id], harness);
    assert.equal(keySetRunbook(harness), id);
    assert.equal(loadRunbook(id, 'brief', { skillRoot: 'x' }).harness, family, harness);
    assert.equal(remaining.filter(row => row.runbook_ids.includes(id)).length, 1, 'once');
  }
  assert.throws(() => keySetRunbook('somewhere-else'), /unknown harness/);
});

test('a user who has a Google key is never sent to get or save one', () => {
  const unknown = reason => unscored([{ state: 'unknown', reason }]);
  const ids = verified => composeReport(verified).remaining.flatMap(row => row.runbook_ids);
  const keyed = withProbe({ google_key: true }, { after: unknown('field_data_unavailable') });
  assert.deepEqual(ids(keyed), ['cwv-site-collection', 'gsc-export', 'naver-searchadvisor-export']);
  assert.ok(!ids(keyed).some(id => id === 'google-api-key' || id.startsWith('key-set-')));
  const keyless = withProbe({ google_key: false }, { after: unknown('field_data_unavailable') });
  assert.deepEqual(ids(keyless), ['google-api-key', 'key-set-local', 'cwv-site-collection', 'gsc-export', 'naver-searchadvisor-export']);
  assert.ok(!ids(withProbe({ chrome: { found: true, kind: 'chrome', reason: null } }, { after: unknown('chrome_missing') })).includes('chrome-install'),
    'a run that has Chrome is not told to install it');
});

test('remaining joins the unknown reasons with the start items the user did not answer', () => {
  const unknown = reason => unscored([{ state: 'unknown', reason }]);
  const ids = verified => composeReport(verified).remaining.map(row => row.runbook_ids[0]);
  const base = withProbe({ google_key: true, chrome: { found: true, kind: 'chrome', reason: null } });
  assert.deepEqual(ids(base), ['gsc-export'], 'only the export file is always missing');
  const missing = withProbe({ google_key: false, chrome: { found: false, kind: null, reason: 'chrome_not_found' } });
  assert.deepEqual(ids(missing), ['google-api-key', 'chrome-install', 'gsc-export']);
  assert.deepEqual(ids({ ...missing, answered_runbooks: ['chrome-install', 'gsc-export'] }), ['google-api-key']);
  assert.deepEqual(ids({ ...missing, answered_runbooks: ['chrome-install'], after: { ...unknown('chrome_missing'), input: { ...unknown('chrome_missing').input, run_context: missing.baseline.input.run_context } } }), ['chrome-install', 'google-api-key', 'gsc-export'],
    'an unknown reason keeps its runbook even when the start item was answered');
  assert.deepEqual(composeReport(base).remaining[0].runbook_ids, ['gsc-export', 'naver-searchadvisor-export']);
  assert.match(composeReport(base).remaining[0].item, /점수에는 들어가지 않음/, 'the export fills actual outcomes, not a score');
});

test('the blanks and the figures come from the same phase', () => {
  const { input } = later();
  const blank = { ...input.observations[1], observation_id: 'blank', state: 'unknown', q: null, reason: 'field_data_unavailable' };
  const after = { input: { ...input, observations: [input.observations[0], blank] }, scores: [result({ score: 95, coverage: 95 })] };
  const composed = composeReport(withProbe({ google_key: false }, { after }));
  assert.equal(composed.completeness[0].pass_rate_in_measured, 95);
  assert.ok(composed.remaining.some(row => row.runbook_ids.includes('cwv-site-collection')), 'the latest phase still has the blank');
  assert.ok(!composeReport(withProbe({ google_key: false })).remaining.some(row => row.runbook_ids.includes('cwv-site-collection')));
});

test('a phase without an audit never reads as a sufficient score', () => {
  assert.equal(headlineOf(result(), { audited: true }).status, 'sufficient');
  assert.equal(headlineOf(result(), { audited: true }).headline_score, 91.2);
  for (const audited of [false, null]) {
    const headline = headlineOf(result(), { audited });
    assert.equal(headline.status, 'unaudited');
    assert.equal(headline.headline_score, null);
    assert.equal(headline.measured_subset_score, 91.2);
    assert.equal(headline.audited, false);
  }
  assert.equal(headlineOf(result({ M: 50, coverage: 50 }), { audited: false }).audited, false, 'every status of an unaudited phase says so');
  const render = scores => {
    const verified = verifiedOf();
    const unaudited = { ...verified, baseline: { ...verified.baseline, scores } };
    const composed = composeReport(unaudited);
    return { composed, markdown: renderReport(composed, unaudited).markdown };
  };
  const strong = render([result()]);
  assert.equal(strong.composed.completeness[0].before.headline.status, 'unaudited');
  assert.match(strong.markdown, /SEO: not audited: 91\.2 is the pass rate within what was measured, and no audit backs it/);
  assert.doesNotMatch(strong.markdown, /SEO: 91\.2/);
  assert.match(render([result({ M: 50, coverage: 50 })]).markdown, /insufficient coverage .*this phase was not audited, so its verdicts could not be replayed/);
});

test('an unaudited report with 80% coverage shows no score and is never measured', () => {
  const packet = fixturePacket();
  const input = packet.baseline.input;
  const fieldValues = { 'lcp-field': [2000, 'ms'], 'inp-field': [150, 'ms'], 'cls-field': [0.05, 'unitless'] };
  const observations = compileUnits(input, 'SEO').map((unit, index) => ({ schema_version: '1.0.0', observation_id: `pass-${index}`,
    check_id: unit.family_id, family_id: unit.family_id, unit_key: unit.key, state: 'pass', q: 1, partial_basis: null, reason: 'fixture',
    evaluator_type: 'code', source_ref: 'synthetic', evidence_ref: 'raw.html',
    ...(fieldValues[unit.family_id] ? { measurement: { value: fieldValues[unit.family_id][0], percentile: 75, source_type: 'field', unit: fieldValues[unit.family_id][1] } } : {}) }));
  packet.baseline.input = { ...input, observations };
  packet.baseline.scores = score(packet.baseline.input);
  packet.comparison = compare(packet.baseline.input, null);
  packet.findings = [];
  const { json, markdown } = buildReport(packet);
  assert.notEqual(json.baseline.input.run_context.audited, true);
  assert.ok(json.baseline.scores.every(item => item.coverage >= 80), 'the packet has the coverage a score would need');
  assert.ok(json.baseline.scores.every(item => item.readiness_status !== 'measured'));
  for (const row of json.composed.completeness) {
    assert.equal(row.before.headline.status, 'unaudited', row.profile);
    assert.equal(row.before.headline.headline_score, null, row.profile);
  }
  assert.match(markdown, /SEO: not audited/);
  assert.equal(json.composed.headline.text, 'Nothing failed in what was checked, but the check is incomplete; see Still blank.');
});

test('the conclusion never reassures while the check is thin', () => {
  const thin = composeReport(verifiedOf({ findings: [] }));
  assert.ok(thin.completeness.every(row => row.before.headline.status === 'insufficient_coverage'));
  assert.equal(thin.headline.open, 0);
  assert.equal(thin.headline.text, 'Nothing failed in what was checked, but the check is incomplete; see Still blank.');
  const verified = verifiedOf({ findings: [] });
  const input = { ...verified.baseline.input, run_context: { ...verified.baseline.input.run_context, audited: true } };
  const full = composeReport({ ...verified, baseline: { input, scores: [result()] } });
  assert.equal(full.completeness[0].before.headline.status, 'sufficient');
  assert.equal(full.headline.text, 'Nothing is left to fix in what was checked.');
  assert.match(composeReport(verifiedOf()).headline.text, /^1 thing\(s\) to fix first/, 'open fixes are stated first, whatever the coverage');
});

test('change paths and blocker counts are composed, and the renderer only formats them', () => {
  const change = { finding_ids: ['a'], path: 'site/page.html' };
  const verified = verifiedOf({ findings: [finding('a'), finding('b')], changes: [change, { finding_ids: ['a'], path: 'site/other.html' }] });
  const composed = composeReport(verified);
  assert.deepEqual(composed.fixes.map(item => [item.finding_id, item.change_paths]), [['a', ['site/page.html', 'site/other.html']], ['b', []]]);
  assert.match(renderReport(composed, verified).markdown, /site\/page\.html; site\/other\.html/);
  const { before, after } = composed.conditions.blockers;
  const scores = verified.baseline.scores[0];
  assert.deepEqual(before, { count: scores.blockers.length, items: scores.blockers.map(x => `${x.family_id} ${x.unit_key}`), core_unknown: scores.unknown_core.length });
  assert.equal(after, null);
  const both = composeReport({ ...verified, after: { ...later(), scores: [result()] } }).conditions.blockers.after;
  assert.deepEqual(both, { count: 0, items: [], core_unknown: 0 });
  const rendered = renderReport(composed, { ...verified, changes: [], baseline: { ...verified.baseline, scores: [] } }).markdown;
  assert.match(rendered, /Baseline blockers: \d+ \(/, 'the line is formatted from composed.conditions.blockers alone');
});

test('the blanks follow the probe of the latest phase', () => {
  const marked = withProbe({ google_key: true });
  assert.ok(!composeReport(marked).remaining.some(row => row.runbook_ids.includes('google-api-key')));
  const keyless = { ...unscored([]), input: { ...unscored([]).input, run_context: { ...marked.baseline.input.run_context, environment_probe: environmentProbe({ google_key: false }) } } };
  const composed = composeReport({ ...marked, after: keyless });
  assert.ok(composed.remaining.some(row => row.runbook_ids.includes('google-api-key')));
  assert.equal(composed.conditions.probe.google_key, false);
});

test('an unaudited fixture report has no verified finding', () => {
  const { json } = buildReport(fixturePacket());
  assert.ok(json.composed.fixes.every(item => !item.status.startsWith('verified_')));
});

test('references/report.md describes the composed report and has no stale wording', () => {
  const text = readFileSync('skills/optbrew/references/report.md', 'utf8');
  assert.doesNotMatch(text, /model-attested/);
  assert.match(text, /bound to spans of the stored judge queue/);
  assert.match(text, /follow_ups/);
  assert.match(text, /latest phase/);
});

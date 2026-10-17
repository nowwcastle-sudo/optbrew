import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildReport, writeReport } from '../skills/optbrew/scripts/core/report.mjs';
import { renderHtmlReport } from '../skills/optbrew/scripts/core/report-html.mjs';
import { SECTION_TITLES, composeReport, coverageOf, renderReport } from '../skills/optbrew/scripts/core/report-compose.mjs';
import { loadRunbook, runbookEntry } from '../skills/optbrew/scripts/core/runbooks.mjs';
import { keySetRunbook } from '../skills/optbrew/scripts/core/probe.mjs';
import { compileUnits } from '../skills/optbrew/scripts/core/weights.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { CONTENT_AFTER_RENDER } from '../skills/optbrew/scripts/core/checks/render-content.mjs';
import { environmentProbe } from './support/probe.mjs';
import { fixturePacket, headlineOf, verifiedOf } from './support/compose.mjs';
import { tempDir } from './support/temp-dir.mjs';

const THIN_TEXT = "확인한 범위에서는 실패한 것이 없지만 점검이 끝나지 않았습니다. '얼마나 확인했나' 구역에서 이유를 확인하세요.";
const withProbe = (probe, over = {}) => {
  const verified = verifiedOf(over);
  const environment_probe = environmentProbe(probe);
  const phase = value => value && { ...value, input: { ...value.input, run_context: { ...value.input.run_context, environment_probe } } };
  return { ...verified, run_context: { ...verified.run_context, environment_probe }, baseline: phase(verified.baseline), after: phase(verified.after) };
};
const finding = (id, over) => ({ schema_version: '2.0.0', finding_id: id, check_id: 'index-policy', unit_key: `index-policy|https://example.com/${id}`,
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
  assert.deepEqual(composeReport(verifiedOf({ findings })).headline, { open: 4, blocking: 0, already_fixed: 1, text: '먼저 고칠 것이 4건 있습니다.', not_indexed: null });
});

test('findings come before scores in json and md', () => {
  const { json, markdown } = buildReport(fixturePacket());
  const text = JSON.stringify(json);
  assert.deepEqual(Object.keys(json.composed), ['headline', 'fixes', 'completeness', 'remaining', 'conditions', 'follow_ups']);
  assert.ok(text.indexOf('"fixes"') < text.indexOf('"completeness"'));
  for (const scoreField of ['"headline_score"', '"measured_subset_score"', '"pass_rate_in_measured"', '"score"'])
    assert.ok(text.indexOf('"fixes"') < text.indexOf(scoreField), scoreField);
  assert.deepEqual(json.findings, json.composed.fixes);
  assert.equal(json.headline, undefined, 'the conclusion is composed.headline; the per-profile headlines are in completeness');
  assert.equal(json.composed.headline.open, 1);
  const at = value => { assert.ok(markdown.includes(value), value); return markdown.indexOf(value); };
  assert.ok(at('결론:') < at('## 먼저 고칠 것'));
  assert.ok(at('## 먼저 고칠 것') < at('## 얼마나 확인했나 (확인한 범위 안의 통과율)'));
  assert.ok(at('요약:') > at('## 먼저 고칠 것'), 'no score before the fixes');
  assert.doesNotMatch(markdown.slice(0, at('## 먼저 고칠 것')), /점수|확인 범위|통과율/);
  const sections = ['## 먼저 고칠 것', '## 얼마나 확인했나', '## 아직 비어 있는 곳', '## 실행 조건', '## 남은 일', '## 실제 결과'].map(at);
  assert.deepEqual(sections, [...sections].sort((a, b) => a - b), 'design order: fixes, completeness, blanks, conditions, then the rest');
});

test('completeness holds both phases, the difference and the coverage without field CWV', () => {
  const [seo] = composeReport(verifiedOf()).completeness;
  assert.equal(seo.after, null);
  assert.equal(seo.before.coverage, seo.coverage);
  assert.ok(seo.coverage_without_cwv > seo.coverage, 'unknown field checks no longer weigh the coverage down');
  assert.equal(seo.pass_rate_in_measured, buildReport(fixturePacket()).json.baseline.scores[0].score);
  const both = composeReport(verifiedOf({ after: { ...later(), scores: [result({ score: 95, A: 100, M: 95, coverage: 95 })] },
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
  const before = markdown.slice(0, markdown.indexOf('## 실행 조건'));
  assert.doesNotMatch(before, /1234\.5|0\.0421|실험실 Core Web Vitals/);
  assert.match(markdown.slice(markdown.indexOf('## 실행 조건')), /실험실 Core Web Vitals \(참고용, 점수에 넣지 않음\): LCP 1234\.5 ms; CLS 0\.0421/);
  const packet = fixturePacket(); packet.lab_cwv = lab;
  const { json } = buildReport(packet);
  assert.deepEqual(json.composed.conditions.lab_cwv, lab);
  assert.doesNotMatch(JSON.stringify({ ...json, composed: { ...json.composed, conditions: null } }), /1234\.5/, 'the value is written only under conditions');
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
  assert.match(text, /네이버와 AI 크롤러는 자바스크립트를 실행하지 못할 수 있어서/);
  assert.match(text, /어떤 점수에도 들어가지 않습니다/);
  const verified = verifiedOf({ after: unscored([observation('pass', `${CONTENT_AFTER_RENDER}: 900 body characters rendered`)]) });
  const composed = composeReport(verified);
  const { markdown, tables } = renderReport(composed, verified);
  for (const part of [composed.fixes, composed.completeness, tables]) assert.ok(!JSON.stringify(part).includes('자바스크립트를 실행'));
  assert.ok(markdown.indexOf('자바스크립트를 실행') > markdown.indexOf('## 실행 조건'));
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
  assert.match(strong.markdown, /SEO: 감사 안 됨 — 확인한 범위 안의 통과율은 91\.2이지만, 이를 뒷받침하는 감사가 없어 점수로 내지 않습니다/);
  assert.doesNotMatch(strong.markdown, /SEO: 91\.2점/);
  assert.match(render([result({ M: 50, coverage: 50 })]).markdown, /확인 범위 부족 .*이 단계는 감사되지 않아 판정을 다시 계산할 수 없었습니다/);
});

test('an unaudited report with 80% coverage shows no score and is never measured', () => {
  const packet = fixturePacket();
  const input = packet.baseline.input;
  const fieldValues = { 'lcp-field': [2000, 'ms'], 'inp-field': [150, 'ms'], 'cls-field': [0.05, 'unitless'] };
  const observations = compileUnits(input, 'SEO').map((unit, index) => ({ schema_version: '2.0.0', observation_id: `pass-${index}`,
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
  assert.match(markdown, /SEO: 감사 안 됨/);
  assert.equal(json.composed.headline.text, THIN_TEXT);
});

test('the conclusion never reassures while the check is thin', () => {
  const thin = composeReport(verifiedOf({ findings: [] }));
  assert.ok(thin.completeness.every(row => row.before.headline.status === 'insufficient_coverage'));
  assert.equal(thin.headline.open, 0);
  assert.equal(thin.headline.text, THIN_TEXT);
  const verified = verifiedOf({ findings: [] });
  const input = { ...verified.baseline.input, run_context: { ...verified.baseline.input.run_context, audited: true } };
  const full = composeReport({ ...verified, baseline: { input, scores: [result()] } });
  assert.equal(full.completeness[0].before.headline.status, 'sufficient');
  assert.equal(full.headline.text, '확인한 범위에서는 고칠 것이 남지 않았습니다.');
  assert.match(composeReport(verifiedOf()).headline.text, /^먼저 고칠 것이 1건 있습니다/, 'open fixes are stated first, whatever the coverage');
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
  assert.match(rendered, /이전 막는 문제: \d+건 \(/, 'the line is formatted from composed.conditions.blockers alone');
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

// The HTML report (Task 16): the same composed report in a third format.
const runbooksOf = (composed, level = 'beginner') => [...new Set(composed.remaining.flatMap(row => row.runbook_ids))].map(id => loadRunbook(id, level, { skillRoot: '/skill' }));
const htmlOf = (composed, over = {}) => renderHtmlReport(composed, { runbooks: runbooksOf(composed, over.level), level: 'beginner', target: 'https://example.com/', ...over });
const stepCount = runbooks => runbooks.reduce((sum, runbook) => sum + runbook.text.split('\n').filter(line => /^(\d+\.|[-*])\s/.test(line)).length, 0);

test('the three formats carry the same numbers', () => {
  const verified = verifiedOf({ findings: [finding('a', { blocker: true, priority: 'P0' }), finding('b')],
    after: { ...later(), scores: [result({ score: 95, coverage: 95, A: 100, M: 95 })] },
    comparison: { status: 'comparable', score_deltas: [{ profile: 'SEO', percentage_point_delta: 3.5 }], reasons: [] } });
  const composed = composeReport(verified);
  const { markdown } = renderReport(composed, verified);
  const page = htmlOf(composed);
  const json = JSON.stringify(composed);
  const [row] = composed.completeness;
  const before = coverageOf(row.before.headline), after = coverageOf(row.after.headline);
  assert.equal(after, 95);
  assert.ok(typeof before === 'number' && before !== after && row.difference === 3.5, 'the scenario has two phases and a difference');
  const { open, blocking, already_fixed: fixed } = composed.headline;
  for (const fragment of [`<b>${open}건</b>먼저 고칠 것`, `<b>${blocking}건</b>가장 급한 것`, `<b>${fixed}건</b>이미 고친 것`,
    `<meter min="0" max="100" value="${after}"`, `확인 범위 이전 ${before}% → 이후 ${after}%; 이전 → 이후 차이 3.5점`,
    `방문자 실측(CWV)을 뺀 확인 범위 ${row.coverage_without_cwv}%`]) assert.ok(page.includes(fragment), `report.html has ${fragment}`);
  for (const fragment of [`먼저 고칠 것이 ${open}건 있습니다`, `확인 범위 이전 → 이후 | `, `${before}% → ${after}%`, `| 3.5 (확인한 범위끼리의 비교) |`, `${row.coverage_without_cwv}%`])
    assert.ok(markdown.includes(fragment), `report.md has ${fragment}`);
  for (const key of [`"open":${open}`, `"blocking":${blocking}`, `"already_fixed":${fixed}`, `"difference":3.5`, `"coverage":95`]) assert.ok(json.includes(key), `report.json has ${key}`);
  assert.ok(page.includes(composed.headline.text.replace(/'/g, '&#39;')) && markdown.includes(composed.headline.text), 'one conclusion in both pages');
  for (const fix of composed.fixes) assert.ok(page.includes(fix.message) && markdown.includes(fix.message), fix.message);
  assert.ok(page.indexOf('id="fixes"') < page.indexOf('id="completeness"') && page.indexOf('id="completeness"') < page.indexOf('id="blank"'), 'fixes, completeness, blanks, in the design order');
});

test('the units a model declared not applicable are counted under model judgments in md and on each profile card in html (M1)', () => {
  const row = { phase: 'baseline', family_id: 'claim-support', unit_key: 'claim-support|https://s.test/', state: 'not_applicable', evidence_ref: 'e', evidence_span: [{ start: 0, end: 3 }], label: 'l' };
  const verified = verifiedOf({ model_judgments: [row, { ...row, unit_key: 'claim-support|https://s.test/b' }, { ...row, family_id: 'freshness-truth', unit_key: 'freshness-truth|https://s.test/' }] });
  const composed = composeReport(verified);
  assert.deepEqual(composed.conditions.model_not_applicable, { 'claim-support': 2, 'freshness-truth': 1 });
  const markdown = renderReport(composed, verified).markdown;
  assert.ok(markdown.slice(markdown.indexOf('## 모델 판단')).includes('모델이 해당 없음으로 판정한 단위: 3건 (claim-support 2건, freshness-truth 1건)'));
  assert.ok(htmlOf(composed).includes('이번 실행에서 모델이 해당 없음으로 뺀 단위는 모두 3건이고'));
  assert.ok(!htmlOf(composeReport(verifiedOf())).includes('모델이 해당 없음으로 뺀 단위는'), 'no note when the model declared none');
});

test('a coverage that shows as 79.9% is not sufficient (M12)', () => {
  const verified = verifiedOf();
  const at = M => composeReport({ ...verified, baseline: { ...verified.baseline, scores: [result({ A: 1000, M, N: M, score: 95, coverage: 80 })] } }).completeness[0].before.headline;
  assert.deepEqual([at(799.99999).status, at(799.99999).coverage], ['insufficient_coverage', 79.9]);
  assert.deepEqual([at(800).status !== 'insufficient_coverage', at(800).coverage], [true, 80], 'at 80.0 the coverage rule is met (the fixture is unaudited, so it is not called sufficient)');
});

test('one rounding rule shows every coverage', () => {
  const verified = verifiedOf();
  const changed = { ...verified, baseline: { ...verified.baseline, scores: [result({ A: 1000, M: 87.9, score: 50, coverage: 8.8 })] } };
  const composed = composeReport(changed);
  assert.equal(composed.completeness[0].coverage, 8.7, 'the JSON shows the floor the threshold reads, like the other two formats');
  assert.equal(composed.completeness[0].before.headline.coverage, 8.7);
  assert.ok(Math.abs(composed.completeness[0].before.headline.coverage_exact - 8.79) < 1e-9, 'the exact value stays in its own field');
  for (const text of [renderReport(composed, changed).markdown, htmlOf(composed)]) {
    assert.ok(text.includes('8.7%'), 'both formats show the floor the threshold is judged on');
    assert.ok(!text.includes('8.8%'), 'and never the rounded value');
  }
});

test('html has no external script or stylesheet', () => {
  const composed = composeReport(withProbe({ google_key: false, chrome: { found: false, kind: null, reason: 'chrome_not_found' } }));
  const page = htmlOf(composed);
  assert.match(page, /^<!doctype html>/);
  assert.doesNotMatch(page, /<script|<link|<img|<iframe|<object|<embed|@import|url\(/i);
  assert.doesNotMatch(page, /\s(src|href|action|data|poster|srcset)\s*=/i, 'no attribute can load or open an outside address');
  assert.doesNotMatch(page, /\son[a-z]+\s*=/i, 'no event handler');
  assert.match(page, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
  assert.match(page, /prefers-color-scheme:dark/);
  assert.match(page, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(page, /<html lang="ko">/);
  assert.ok(page.includes('<meter') && page.includes('<details'));
});

test('html opens each runbook in details as a plain numbered list', () => {
  for (const level of ['beginner', 'brief']) {
    const composed = composeReport(withProbe({ google_key: false, chrome: { found: false, kind: null, reason: 'chrome_not_found' } }));
    const runbooks = runbooksOf(composed, level);
    const page = htmlOf(composed, { level, runbooks });
    const ids = composed.remaining.flatMap(row => row.runbook_ids);
    assert.ok(ids.length >= 3, level);
    for (const id of ids) assert.match(page, new RegExp(`<details class="runbook" data-runbook="${id}" data-level="${level}"><summary>[^<]+</summary>`), `${level}: ${id}`);
    assert.equal(page.split('<details class="runbook"').length - 1, ids.length, 'one fold per runbook of each blank item');
    assert.equal(page.split('<li>').length - 1 >= stepCount(runbooks), true, `${level}: every step is a list item`);
    assert.ok(!page.includes('<svg'), 'no drawing where no runbook names a zone');
    assert.ok(!page.includes('그림은 화면 위치'), 'and no note about drawings');
    assert.doesNotMatch(page, /\{\{skill_root\}\}/);
    assert.ok(page.includes('/skill/scripts/key.mjs'), 'the skill folder is filled in');
  }
  const composed = composeReport(withProbe({ google_key: false }));
  assert.throws(() => renderHtmlReport(composed, { runbooks: [], level: 'beginner', target: 'x' }), /runbook missing for the report: google-api-key/);
});

test('a step that names its screen zone gets one drawing, and a bullet never does', () => {
  const composed = composeReport(withProbe({ google_key: false }));
  const [first] = runbooksOf(composed);
  const text = ['앞 문장입니다.', '1. 주소창에 주소를 적습니다. {화면: 주소창}', '2. 아무 표시가 없는 단계입니다.', '3. **터미널**에서 `node x`를 실행합니다. {화면: 터미널}',
    '4. 모르는 구역입니다. {화면: 달나라}', '', '- 글머리표는 단계가 아닙니다. {화면: 주소창}', '', '```', '1. 코드 안의 줄 {화면: 주소창}', '```'].join('\n');
  const runbooks = runbooksOf(composed).map(runbook => runbook.id === first.id ? { ...runbook, text } : runbook);
  const page = htmlOf(composed, { runbooks });
  assert.equal(page.split('<svg class="shot"').length - 1, 2, 'one drawing for each tagged step with a known zone');
  assert.ok(page.includes('aria-label="1단계 대략의 화면 위치: 주소창"') && page.includes('aria-label="3단계 대략의 화면 위치: 터미널"'));
  assert.ok(page.includes('<ol start="1"><li><div class="step"><span class="say">주소창에 주소를 적습니다.</span><svg'), 'the tag is not shown in the step');
  assert.ok(page.includes('<li>아무 표시가 없는 단계입니다.</li>'));
  assert.ok(page.includes('<span class="say"><strong>터미널</strong>에서 <code>node x</code>를 실행합니다.</span>'), 'bold and code do not cross');
  assert.ok(page.includes('<ul><li>글머리표는 단계가 아닙니다.</li></ul>'));
  assert.ok(page.includes('그림은 화면 위치를 보여 주는 도식입니다'), 'the note appears once something is drawn');
  assert.ok(page.includes('<code>1. 코드 안의 줄 {화면: 주소창}</code>'), 'a code block is shown as written');
});

test('every shipped runbook is plain enough for the page', () => {
  const zones = ['주소창', '화면 위쪽', '왼쪽 메뉴', '화면 가운데', '새 창', '터미널'];
  const ids = JSON.parse(readFileSync('skills/optbrew/references/runbooks/index.json', 'utf8')).map(entry => entry.id);
  for (const id of ids) for (const level of ['beginner', 'brief']) {
    const { text } = loadRunbook(id, level, { skillRoot: '/skill' });
    for (const line of text.split('\n')) {
      assert.doesNotMatch(line, /^\s+(\d+\.|[-*])\s|^\s+```/, `${id}/${level}: no indented list or fence`);
      const tag = /\{화면:\s*([^}]+?)\s*\}/.exec(line);
      if (tag) assert.ok(zones.includes(tag[1]), `${id}/${level}: ${tag[1]} is a known zone`);
    }
  }
});

test('every value from the site or the user is escaped in html', () => {
  const hostile = `<script>alert("x")</script> 'quote' & "double"`;
  const unit = `index-policy|https://example.com/"><img src=x onerror=alert(1)>`;
  const verified = verifiedOf({ findings: [finding('evil', { message: hostile, unit_key: unit, remediation: null })] });
  const composed = composeReport(verified);
  const page = htmlOf(composed, { target: `https://example.com/?t=${hostile}` });
  assert.doesNotMatch(page, /<script|<img/i, 'no tag from the site survives');
  assert.ok(page.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &#39;quote&#39; &amp; &quot;double&quot;'), 'the title shows as text');
  assert.ok(page.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'), 'the address cannot close its tag');
  const { markdown } = renderReport(composed, verified);
  assert.doesNotMatch(markdown, /<script/, 'report.md escapes it too');
});

test('an empty completeness never reads as nothing left', () => {
  const verified = verifiedOf({ findings: [] });
  const composed = composeReport({ ...verified, baseline: { ...verified.baseline, scores: [] } });
  assert.deepEqual(composed.completeness, []);
  assert.equal(composed.headline.text, THIN_TEXT);
  assert.ok(THIN_TEXT.includes(`'${SECTION_TITLES.completeness}'`), 'the sentence names the section that shows the cause');
  const { markdown } = renderReport(composed, { ...verified, baseline: { ...verified.baseline, scores: [] } });
  assert.ok(markdown.includes(`## ${SECTION_TITLES.completeness}`));
  const page = htmlOf(composed);
  assert.ok(page.includes(`<h2>${SECTION_TITLES.completeness}</h2>`) && page.includes('확인 범위를 알 수 없습니다'));
  assert.ok(!page.includes('남지 않았습니다'));
});

test('writeReport writes report.html beside the others, all or none', async () => {
  const dir = await tempDir('optbrew report html ');
  const first = await writeReport(fixturePacket(), path.join(dir, 'with'), { renderHtml: composed => htmlOf(composed) });
  assert.deepEqual(Object.keys(first), ['jsonPath', 'markdownPath', 'htmlPath']);
  assert.deepEqual(readdirSync(path.join(dir, 'with')).sort(), ['report.html', 'report.json', 'report.md']);
  assert.match(readFileSync(first.htmlPath, 'utf8'), /^<!doctype html>/);
  await assert.rejects(writeReport(fixturePacket(), path.join(dir, 'with'), { renderHtml: () => '<p>again</p>' }), /report output already exists/);
  assert.equal(readFileSync(first.htmlPath, 'utf8').includes('again'), false);
  await assert.rejects(writeReport(fixturePacket(), path.join(dir, 'broken'), { renderHtml: () => { throw new Error('render failed'); } }), /render failed/);
  assert.equal(existsSync(path.join(dir, 'broken')), false, 'nothing is written when the page cannot be made');
  const plain = await writeReport(fixturePacket(), path.join(dir, 'plain'));
  assert.deepEqual(Object.keys(plain), ['jsonPath', 'markdownPath']);
});

test('a fix names its address, not the internal unit key', () => {
  const verified = verifiedOf({ findings: [finding('one'), finding('site', { check_id: 'entity-identity', unit_key: 'entity-identity|site' })] });
  const composed = composeReport(verified);
  const { markdown } = renderReport(composed, verified);
  const page = htmlOf(composed);
  assert.ok(markdown.includes('problem one https://example.com/one') && !markdown.includes('index-policy|https'));
  assert.ok(page.includes('<p class="pages">https://example.com/one</p>') && page.includes('<p class="pages">https://example.com/</p>'), 'the identity of the site is read and fixed on its home page (T22 M-2)');
  assert.doesNotMatch(page, /index-policy\|/);
});

test('fix rows carry plain labels and one place to fix, composed once', () => {
  const change = { finding_ids: ['a'], path: 'site/page.html' };
  const composed = composeReport(verifiedOf({ findings: [finding('a', { priority: 'P1', status: 'confirmed' }), finding('b', { priority: 'P2' })], changes: [change] }));
  const [a, b] = composed.fixes;
  assert.deepEqual([a.priority_label, a.status_label, a.where], ['중요', '확인됨', 'site/page.html']);
  assert.deepEqual([b.priority_label, b.status_label, b.where], ['보통', '제안만 함', '고칠 위치는 사이트 소유자가 정해야 합니다']);
  const page = htmlOf(composed);
  assert.ok(page.includes('<span class="chip">중요</span>') && !page.includes('>P1<') && !page.includes('proposed_only'));
});

test('the run conditions have no unit without a number and no raw reason code', () => {
  const composed = composeReport(withProbe({ chrome: { found: false, kind: null, reason: 'chrome_not_found' } }));
  const lines = Object.fromEntries(composed.conditions.lines.map(({ label, value }) => [label, value]));
  assert.equal(lines['이후 결과 없는 핵심 검사'], '알 수 없음');
  assert.equal(lines['크롬'], '찾지 못함 (설치된 크롬을 찾지 못함)');
  const { markdown } = renderReport(composed, verifiedOf());
  assert.doesNotMatch(markdown, /알 수 없음건|알 수 없음%|chrome_not_found/);
  const page = htmlOf(composed);
  assert.ok(page.includes('<dt>크롬</dt><dd>찾지 못함 (설치된 크롬을 찾지 못함)</dd>') && !page.includes('chrome_not_found'));
  assert.doesNotMatch(page, /알 수 없음건|알 수 없음%/);
});

test('a profile card gives a verdict word, a meter and one plain sentence, and folds the long line', () => {
  const composed = composeReport(verifiedOf());
  const page = htmlOf(composed);
  const card = page.slice(page.indexOf('<li class="profile">'), page.indexOf('</li>', page.indexOf('<li class="profile">')));
  assert.ok(card.includes('<span class="chip">확인 부족</span>') && card.includes('<meter') && card.includes('이상 확인해야 점수를 냅니다. 지금 '));
  assert.ok(card.indexOf('<details><summary>자세히</summary>') > card.indexOf('<meter'), 'the long line waits in a fold');
  const fold = card.slice(card.indexOf('<details>'));
  assert.ok(fold.includes('적용 가중치') && !card.slice(0, card.indexOf('<details>')).includes('적용 가중치'));
});

test('follow-ups are composed, and the page folds them under 남은 일', () => {
  const row = { problem: 'The export could not be used', reason: 'export_file_missing', required_input_or_authority: 'A new file', next_action: 'Export again', reobserve_when: 'next run' };
  const verified = verifiedOf({ follow_ups: [row] });
  const composed = composeReport(verified);
  // A row without a catalog key keeps its own words as its text.
  assert.deepEqual(composed.follow_ups, [{ ...row, text_ko: { problem: row.problem, reason: row.reason, required_input_or_authority: row.required_input_or_authority, next_action: row.next_action, reobserve_when: row.reobserve_when } }]);
  assert.deepEqual(renderReport(composed, verified).tables.remaining_work, [[row.problem, row.reason, row.required_input_or_authority, row.next_action, row.reobserve_when]]);
  const page = htmlOf(composed);
  assert.ok(page.includes(`<section id="remaining"><h2>${SECTION_TITLES.remaining}</h2><details><summary>1건 보기</summary>`) && page.includes(row.problem));
  assert.ok(page.indexOf('id="blank"') < page.indexOf('id="remaining"') && page.indexOf('id="remaining"') < page.indexOf('id="conditions"'));
});

test('a synthetic example says so in the html too', () => {
  const composed = composeReport(verifiedOf());
  assert.ok(htmlOf(composed, { synthetic: true }).includes('<p class="banner">예시 보고서 — 실제 사이트나 외부 서비스의 결과가 아닙니다.</p>'));
  assert.ok(!htmlOf(composed).includes('class="banner"'));
});

test('every status a fix can carry has a Korean label', () => {
  // The statuses are the quoted words of statusFor in report.mjs, minus the words that are not statuses; a new status must get a label.
  const source = readFileSync('skills/optbrew/scripts/core/report.mjs', 'utf8').replace(/\r\n/g, '\n');
  const body = source.slice(source.indexOf('function statusFor'), source.indexOf('\n}\n', source.indexOf('function statusFor')));
  const notStatuses = new Set(['after', 'failed', 'local', 'partial', 'pass', 'passed', 'production']);
  const statuses = [...new Set([...body.matchAll(/'([a-z_]+)'/g)].map(match => match[1]).filter(word => !notStatuses.has(word)))];
  assert.ok(statuses.length >= 7 && statuses.includes('verified_local') && statuses.includes('verification_failed'), statuses.join());
  const findings = statuses.map(status => finding(status, { status }));
  const composed = composeReport(verifiedOf({ findings }));
  const page = htmlOf(composed);
  const { markdown } = renderReport(composed, verifiedOf({ findings }));
  for (const fix of composed.fixes) {
    assert.match(fix.status_label, /[가-힣]/, `${fix.status} has a Korean label`);
    assert.ok(page.includes(`<dt>상태</dt><dd>${fix.status_label}</dd>`));
  }
  assert.doesNotMatch(page, /<dd>(confirmed|unknown|proposed_only|modified_unverified|verification_failed|verified_local|verified_production)<\/dd>/);
  for (const fix of composed.fixes) assert.ok(markdown.includes(`| ${fix.status_label} |`), fix.status);
});

test('a comparison that cannot be made says so in plain words', () => {
  const verified = verifiedOf({ after: { ...later(), scores: [result({ score: 95, coverage: 90 })] },
    comparison: { status: 'not_comparable', score_deltas: [], reasons: ['older_protocol'] } });
  const composed = composeReport(verified);
  assert.equal(composed.completeness[0].difference, null);
  const page = htmlOf(composed);
  assert.ok(page.includes('두 단계를 비교할 수 없어 차이는 알 수 없습니다'));
  assert.doesNotMatch(page, /알 수 없음점|알 수 없음%/);
});

test('an unknown screen zone in a runbook tag is ignored, never a crash', () => {
  const composed = composeReport(withProbe({ google_key: false }));
  const [first] = runbooksOf(composed);
  const text = ['1. 하나입니다. {화면: constructor}', '2. 둘입니다. {화면: __proto__}', '3. 셋입니다. {화면: toString}', '4. 넷입니다. {화면: hasOwnProperty}'].join('\n');
  const runbooks = runbooksOf(composed).map(runbook => runbook.id === first.id ? { ...runbook, text } : runbook);
  const page = htmlOf(composed, { runbooks });
  assert.ok(!page.includes('<svg'));
  assert.ok(page.includes('<li>하나입니다. {화면: constructor}</li>') === false, 'the tag is stripped from the step text');
  assert.ok(page.includes('<li>하나입니다.</li>') && page.includes('<li>넷입니다.</li>'));
});

test('a fix address that holds a bar stays whole', () => {
  const unit = 'index-policy|https://example.com/a|b?x=c|d';
  const composed = composeReport(verifiedOf({ findings: [finding('bar', { unit_key: unit })] }));
  assert.ok(htmlOf(composed).includes('<p class="pages">https://example.com/a|b?x=c|d</p>'));
  const many = composeReport(verifiedOf({ findings: [finding('m', { unit_keys: [unit, 'index-policy|https://example.com/z'] })] }));
  assert.ok(htmlOf(many).includes('(2개 페이지: https://example.com/a|b?x=c|d, https://example.com/z)'));
});

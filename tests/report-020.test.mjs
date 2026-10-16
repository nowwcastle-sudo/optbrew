import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { composeReport, renderReport } from '../skills/optbrew/scripts/core/report-compose.mjs';
import { loadRunbook, runbookEntry } from '../skills/optbrew/scripts/core/runbooks.mjs';
import { ContractError } from '../skills/optbrew/scripts/core/contracts.mjs';
import { environmentProbe } from './support/probe.mjs';

const fixtureRoot = path.resolve('tests/fixtures/reports');
const packetOf = () => ({ ...JSON.parse(readFileSync(path.join(fixtureRoot, 'remote-only.json'), 'utf8')), evidence_root: fixtureRoot });

/** What buildReport hands the composer, rebuilt from the report JSON of the remote-only fixture. */
function verifiedOf(over = {}) {
  const { json } = buildReport(packetOf());
  return { ...json, outcome_rows: json.tables.actual_outcomes, lab_cwv: null, answered_runbooks: [], ...over };
}
const withProbe = probe => {
  const verified = verifiedOf();
  return { ...verified, run_context: { ...verified.run_context, environment_probe: environmentProbe(probe) } };
};
const finding = (id, over) => ({ schema_version: '1.0.0', finding_id: id, check_id: 'index-policy', unit_key: `index-policy|https://example.com/${id}`,
  priority: 'P1', blocker: false, message: `problem ${id}`, source_ref: 'module:a', evidence_ref: 'module-a.html', remediation_ids: [],
  status: 'proposed_only', finding_ids: [id], sources: [], remediation: null, resolution: null, ...over });
const order = composed => composed.fixes.map(item => item.finding_id);

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
  assert.deepEqual(order(composeReport(verifiedOf({ findings }))), ['b2a', 'b2b', 'b1', 'n0', 'y1', 'y2', 'y3', 'z1', 'p2']);
  assert.deepEqual(order(composeReport(verifiedOf({ findings: [...findings].reverse() }))), ['b2a', 'b2b', 'b1', 'n0', 'y1', 'y2', 'y3', 'z1', 'p2']);
});

test('findings come before scores in json and md', () => {
  const { json, markdown } = buildReport(packetOf());
  const keys = Object.keys(json);
  assert.deepEqual(Object.keys(json.composed), ['headline', 'fixes', 'completeness', 'remaining', 'conditions']);
  assert.ok(keys.indexOf('composed') < keys.indexOf('baseline') && keys.indexOf('composed') < keys.indexOf('comparison'));
  assert.deepEqual(json.findings, json.composed.fixes);
  const at = text => { assert.ok(markdown.includes(text), text); return markdown.indexOf(text); };
  assert.ok(at('Result:') < at('## Fix first'));
  assert.ok(at('## Fix first') < at('## Completeness (pass rate within what was measured)'));
  assert.ok(at('Headline:') > at('## Fix first'), 'no score before the fixes');
  assert.ok(at('## Completeness') < at('## Still blank') && at('## Still blank') < at('## Run conditions'));
  assert.doesNotMatch(markdown.slice(0, at('## Fix first')), /\bscore|coverage/i);
  assert.ok(json.composed.completeness.every(row => 'pass_rate_in_measured' in row && 'coverage_without_cwv' in row));
});

test('coverage without field CWV leaves the three field-data checks out of the denominator', () => {
  const { completeness } = composeReport(verifiedOf());
  const seo = completeness.find(row => row.profile === 'SEO');
  assert.ok(seo.coverage_without_cwv > seo.coverage, 'unknown field checks no longer weigh the coverage down');
  assert.equal(seo.pass_rate_in_measured, buildReport(packetOf()).json.baseline.scores[0].score);
});

test('lab CWV appears only under conditions', () => {
  const lab = { lcp: 1234.5, cls: 0.0421 };
  const none = composeReport(verifiedOf());
  assert.equal(none.conditions.lab_cwv, null);
  const verified = verifiedOf({ lab_cwv: lab });
  const composed = composeReport(verified);
  assert.deepEqual(composed.conditions.lab_cwv, lab);
  const { markdown, tables } = renderReport(composed, verified);
  const everythingElse = JSON.stringify({ ...composed, conditions: undefined, tables });
  assert.doesNotMatch(everythingElse, /1234\.5|0\.0421/);
  const before = markdown.slice(0, markdown.indexOf('## Run conditions'));
  assert.doesNotMatch(before, /1234\.5|0\.0421|Lab Core Web Vitals/);
  assert.match(markdown.slice(markdown.indexOf('## Run conditions')), /Lab Core Web Vitals \(reference, not scored\): LCP 1234\.5 ms; CLS 0\.0421/);
  const packet = packetOf(); packet.lab_cwv = lab;
  assert.deepEqual(buildReport(packet).json.composed.conditions.lab_cwv, lab);
  assert.equal(JSON.stringify(buildReport(packet).json).split('1234.5').length, 2, 'the value is written once, under conditions');
});

test('a malformed lab CWV or an unknown answered runbook is refused', () => {
  const lab = packetOf(); lab.lab_cwv = { lcp: '1200', cls: null };
  assert.throws(() => buildReport(lab), ContractError);
  const answered = packetOf(); answered.answered_runbooks = ['no-such-runbook'];
  assert.throws(() => buildReport(answered), /unknown runbook/);
});

test('conditions carry an unscored JavaScript note that no fix or score holds', () => {
  const { json, markdown } = buildReport(packetOf());
  const [note] = json.composed.conditions.notes;
  assert.match(note, /Naver and AI crawlers may not run JavaScript/);
  assert.match(note, /not part of any score/);
  assert.ok(!JSON.stringify(json.composed.fixes).includes('run JavaScript'));
  assert.ok(!JSON.stringify(json.composed.completeness).includes('run JavaScript'));
  assert.ok(!JSON.stringify(json.tables).includes('run JavaScript'));
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
      assert.ok(row.item && Array.isArray(row.fills) && row.runbook_ids.length > 0, harness);
      for (const id of row.runbook_ids) {
        assert.ok(runbookEntry(id), `${harness}: ${id} is in the index`);
        assert.equal(loadRunbook(id, 'brief', { skillRoot: 'x' }).id, id);
      }
      for (const id of row.fills) assert.match(id, /^[a-z-]+$/);
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
    assert.equal(loadRunbook(id, 'brief', { skillRoot: 'x' }).harness, family, harness);
    assert.equal(remaining.filter(row => row.runbook_ids.includes(id)).length, 1, 'once');
  }
});

test('remaining joins the unknown reasons with the start items the user did not answer', () => {
  const unknown = reason => ({ input: { observations: [{ state: 'unknown', reason }] }, scores: [] });
  const ids = verified => composeReport(verified).remaining.map(row => row.runbook_ids[0]);
  const base = withProbe({ google_key: true, chrome: { found: true, kind: 'chrome', reason: null } });
  assert.deepEqual(ids(base), ['gsc-export'], 'only the export file is always missing');
  assert.deepEqual(ids({ ...base, after: unknown('field_data_unavailable') }), ['google-api-key', 'cwv-site-collection', 'gsc-export']);
  assert.deepEqual(ids({ ...base, after: unknown('chrome_missing') }), ['chrome-install', 'gsc-export']);
  const missing = withProbe({ google_key: false, chrome: { found: false, kind: null, reason: 'chrome_not_found' } });
  assert.deepEqual(ids(missing), ['google-api-key', 'chrome-install', 'gsc-export']);
  assert.deepEqual(ids({ ...missing, answered_runbooks: ['chrome-install', 'gsc-export'] }), ['google-api-key']);
  assert.deepEqual(ids({ ...missing, answered_runbooks: ['chrome-install'], after: unknown('chrome_missing') }), ['chrome-install', 'google-api-key', 'gsc-export'],
    'an unknown reason keeps its runbook even when the start item was answered');
  const export_ = composeReport(base).remaining[0];
  assert.deepEqual(export_.runbook_ids, ['gsc-export', 'naver-searchadvisor-export']);
});

test('a phase without an audit never reads as a sufficient score', () => {
  const verified = verifiedOf();
  const result = { ...verified.baseline.scores[0], score: 91.2, A: 100, M: 90, N: 82, coverage: 90, unknown_core: [], blockers: [], readiness_status: 'unverified' };
  const input = audited => {
    const context = { ...verified.baseline.input.run_context };
    delete context.audited;
    return { ...verified.baseline.input, run_context: audited === undefined ? context : { ...context, audited } };
  };
  const headlineOf = audited => composeReport({ ...verified, baseline: { input: input(audited), scores: [result] } }).headline[0];
  assert.equal(headlineOf(true).status, 'sufficient');
  assert.equal(headlineOf(true).headline_score, 91.2);
  for (const audited of [false, undefined]) {
    const headline = headlineOf(audited);
    assert.equal(headline.status, 'unaudited');
    assert.equal(headline.headline_score, null);
    assert.equal(headline.measured_subset_score, 91.2);
  }
  const unaudited = { ...verified, baseline: { input: input(false), scores: [result] } };
  const { markdown, tables } = renderReport(composeReport(unaudited), unaudited);
  assert.match(markdown, /SEO: not audited, so no score is shown/);
  assert.match(tables.score[0][1], /^not audited \(measured subset 91\.2/);
  assert.doesNotMatch(markdown, /SEO: 91\.2/);
});

test('an unaudited fixture report has no verified finding and no measured readiness', () => {
  const { json } = buildReport(packetOf());
  assert.notEqual(json.baseline.input.run_context.audited, true);
  assert.ok(json.composed.fixes.every(item => !item.status.startsWith('verified_')));
  assert.ok(json.baseline.scores.every(item => item.readiness_status !== 'measured'));
  assert.ok(json.composed.headline.every(item => item.status !== 'sufficient'));
});

test('report.md reference no longer calls a resolution model-attested', () => {
  const text = readFileSync('skills/optbrew/references/report.md', 'utf8');
  assert.doesNotMatch(text, /model-attested/);
  assert.match(text, /bound to spans of the stored judge queue/);
});

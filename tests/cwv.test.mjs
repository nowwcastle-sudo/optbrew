import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectCwv, labCwv } from '../skills/optbrew/scripts/core/cwv.mjs';
import { lcpField, inpField, clsField } from '../skills/optbrew/scripts/core/checks/cwv-field.mjs';
import { deriveObservations } from '../skills/optbrew/scripts/core/derive.mjs';
import { endpoints, limits } from '../skills/optbrew/scripts/core/config.mjs';
import { openStore } from '../skills/optbrew/scripts/core/evidence-store.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { buildScenario, page, startSite } from './support/review-scenario.mjs';
import { tempDir } from './support/temp-dir.mjs';

// Assembled from fragments: the repository never contains a literal key.
const KEY = ['AI', 'za', 'Sy', 'Fake', 'Cwv', 'Key', '0123456789', 'abcdefghij', 'KLMN'].join('');
const ORIGIN = 'https://example.test';
const FAMILIES = ['lcp-field', 'inp-field', 'cls-field'];
const NOT_FOUND = { error: { code: 404, message: 'chrome ux report data not found', status: 'NOT_FOUND' } };

const reply = (status, body) => ({ status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
const crux = metrics => ({ record: { key: { origin: ORIGIN }, metrics: Object.fromEntries(Object.entries(metrics)
  .map(([name, p75]) => [name, { percentiles: { p75 } }])) } });
/** A fake fetch that answers from a script, one answer per call, and remembers every call. */
function fakeFetch(...answers) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, fetchFn };
}
const sha = text => createHash('sha256').update(text).digest('hex');

async function newStore() {
  const dir = await tempDir('optbrew-cwv-');
  return { dir, store: openStore(dir, { run_id: 'cwv-test' }) };
}
/** The stored answers of a store, in the order they were kept. */
async function stored(store) {
  const { cwv } = await store.index();
  return Promise.all(cwv.map(async entry => ({ ...entry, record: JSON.parse(await store.read(entry.evidence_ref, entry.sha256)) })));
}
const filesText = dir => readdirSync(dir).map(name => readFileSync(path.join(dir, name), 'utf8')).join('\n');

test('uses CrUX when the key works', async () => {
  const { store } = await newStore();
  const { calls, fetchFn } = fakeFetch(reply(200, crux({ largest_contentful_paint: 2100 })));
  await collectCwv({ origin: ORIGIN, key: KEY, fetchFn, store });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { origin: ORIGIN });
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, endpoints().crux);
  assert.equal(url.searchParams.get('key'), KEY);
  const [entry] = await stored(store);
  assert.equal(entry.source, 'crux');
  assert.equal(entry.sha256, sha(readFileSync(entry.evidence_ref)));
  assert.deepEqual([entry.record.source, entry.record.origin, entry.record.status], ['crux', ORIGIN, 200]);
  assert.equal(entry.record.body.record.metrics.largest_contentful_paint.percentiles.p75, 2100);
});

test('falls back to PSI on CrUX 404', async () => {
  const { store } = await newStore();
  const { calls, fetchFn } = fakeFetch(reply(404, NOT_FOUND), reply(200, { originLoadingExperience: { metrics: {} } }));
  await collectCwv({ origin: ORIGIN, key: KEY, fetchFn, store });
  assert.equal(calls.length, 2);
  const psi = new URL(calls[1].url);
  assert.equal(`${psi.origin}${psi.pathname}`, endpoints().psi.split('?')[0]);
  assert.equal(psi.searchParams.get('url'), `${ORIGIN}/`);
  assert.equal(psi.searchParams.get('key'), KEY);
  assert.deepEqual((await stored(store)).map(x => [x.source, x.record.status]), [['crux', 404], ['psi', 200]]);
});

test('does not fall back to PSI when CrUX fails for another reason', async () => {
  const { store } = await newStore();
  const { calls, fetchFn } = fakeFetch(reply(403, { error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } }));
  await collectCwv({ origin: ORIGIN, key: KEY, fetchFn, store });
  assert.equal(calls.length, 1);
  assert.deepEqual((await stored(store)).map(x => [x.source, x.record.status]), [['crux', 403]]);
});

test('tries PSI once without a key', async () => {
  const { store } = await newStore();
  const { calls, fetchFn } = fakeFetch(reply(429, { error: { code: 429, message: 'quota' } }));
  await collectCwv({ origin: ORIGIN, key: null, fetchFn, store });
  assert.equal(limits().psi_attempts, 1);
  assert.equal(calls.length, limits().psi_attempts);
  assert.equal(new URL(calls[0].url).searchParams.has('key'), false);
  assert.deepEqual((await stored(store)).map(x => [x.source, x.record.status]), [['psi', 429]]);
});

test('a network failure leaves evidence and no exception', async () => {
  const { store } = await newStore();
  await collectCwv({ origin: ORIGIN, key: null, fetchFn: fakeFetch(new Error('socket closed')).fetchFn, store });
  const [entry] = await stored(store);
  assert.deepEqual([entry.record.status, entry.record.error], [null, 'socket closed']);
});

test('stored CWV evidence never contains the key', async () => {
  const { dir, store } = await newStore();
  const echo = fakeFetch(reply(400, { error: { message: `API key not valid: ${KEY}`, echoed: encodeURIComponent(KEY) } }));
  await collectCwv({ origin: ORIGIN, key: KEY, fetchFn: echo.fetchFn, store });
  assert.ok(echo.calls[0].url.includes(KEY), 'the key travels in the request, so this test can see a leak');
  const failing = fakeFetch(reply(404, NOT_FOUND), new Error(`request to https://api.test/?key=${KEY} failed`));
  await collectCwv({ origin: ORIGIN, key: KEY, fetchFn: failing.fetchFn, store });
  const all = filesText(dir);
  assert.equal(all.includes(KEY), false);
  assert.equal(all.includes(encodeURIComponent(KEY)), false);
  const records = (await stored(store)).map(x => x.record);
  assert.equal(records.length, 3);
  assert.match(records[2].error, /failed/);
});

/** A prepared-like value for one block: the origin's pages are selected and `cwv` holds the stored answers. */
const judge = (block, cwv) => block.derive({ context: { evidence_ref: 'context.json' }, artifacts: [], selected: new Map([[`${ORIGIN}/`, {}]]), cwv })[0];
const answer = (source, body, extra = {}) => ({ source, origin: ORIGIN, status: 200, body, evidence_ref: `evidence/${source}.json`, ...extra });
const psiBody = metrics => ({ originLoadingExperience: { metrics } });

test('field families judge the p75 against the registry thresholds', () => {
  const field = answer('crux', crux({ largest_contentful_paint: 2500, interaction_to_next_paint: 350, cumulative_layout_shift: '0.3' }));
  const [lcp, inp, cls] = [lcpField, inpField, clsField].map(block => judge(block, [field]));
  assert.deepEqual([lcp, inp, cls].map(x => [x.state, x.q]), [['pass', 1], ['partial', 0.5], ['fail', 0]]);
  assert.deepEqual(inp.partial_basis, { kind: 'threshold_half' });
  assert.deepEqual(cls.measurement, { value: 0.3, percentile: 75, source_type: 'field', unit: 'unitless' });
  assert.equal(lcp.evidence_ref, 'evidence/crux.json');
  assert.equal(lcp.unit_key, `lcp-field|${ORIGIN}`);
});

test('missing field data is unknown, not a failure', () => {
  assert.deepEqual([lcpField, inpField, clsField].map(block => judge(block, [])).map(x => [x.state, x.reason]),
    FAMILIES.map(() => ['unknown', 'field_data_unavailable']));
  const partial = answer('crux', crux({ largest_contentful_paint: 1800 }));
  assert.deepEqual([lcpField, inpField].map(block => judge(block, [partial]).state), ['pass', 'unknown']);
  const failed = answer('psi', null, { status: 429 });
  assert.equal(judge(lcpField, [failed]).evidence_ref, 'evidence/psi.json', 'the unknown points at the answer that held nothing');
  assert.equal(judge(lcpField, [{ ...partial, origin: 'https://other.test' }]).state, 'unknown', 'another origin proves nothing');
});

test('PSI answers are read from the origin experience and CLS is unscaled by its bucket bound', () => {
  const buckets = [{ min: 0, max: 10, proportion: 0.7 }, { min: 10, max: 25, proportion: 0.2 }, { min: 25, proportion: 0.1 }];
  const metrics = (cls, distributions = buckets) => psiBody({ LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4100 },
    CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: cls, distributions } });
  assert.equal(judge(lcpField, [answer('psi', metrics(10))]).state, 'fail');
  const cls = value => judge(clsField, [answer('psi', metrics(value))]);
  assert.deepEqual([cls(10), cls(18), cls(30)].map(x => [x.state, x.measurement.value]), [['pass', 0.1], ['partial', 0.18], ['fail', 0.3]]);
  assert.equal(judge(clsField, [answer('psi', metrics(10, []))]).state, 'unknown', 'without a bucket bound the scale is not known');
});

test('lab values never create observations', async () => {
  const fake = { evaluate: async () => JSON.stringify({ lcp: [900, 1200], shifts: [{ startTime: 100, value: 0.05, hadRecentInput: false },
    { startTime: 150, value: 0.4, hadRecentInput: true }, { startTime: 5000, value: 0.04, hadRecentInput: false }, { startTime: 5100, value: 0.03, hadRecentInput: false }] }) };
  const lab = await labCwv({ page: fake });
  assert.deepEqual(lab, { lcp: 1200, cls: 0.07 });
  assert.equal(Object.hasOwn(lab, 'family_id'), false);
  const none = await labCwv({ page: { evaluate: async () => JSON.stringify({ lcp: [], shifts: [] }) } });
  assert.deepEqual(none, { lcp: null, cls: 0 });
  // The blocks read stored field answers only: whatever the lab measured, an origin without field data stays unknown.
  assert.deepEqual([lcpField, inpField, clsField].map(block => judge(block, [])).map(x => x.state), ['unknown', 'unknown', 'unknown']);
});

test('CLS windows end after a one second gap and after five seconds', async () => {
  const shifts = [[0, 0.02], [900, 0.02], [1800, 0.02], [2700, 0.02], [3600, 0.02], [4500, 0.02], [5400, 0.02], [7000, 0.5]]
    .map(([startTime, value]) => ({ startTime, value, hadRecentInput: false }));
  const { cls } = await labCwv({ page: { evaluate: async () => JSON.stringify({ lcp: [], shifts }) } });
  assert.equal(cls, 0.5, 'the 7000 ms shift opens its own window, which is the largest');
});

/** An audited local site whose protocol judges the three field families; its evidence directory is the replay root. */
async function replayable() {
  const site = await startSite({ '/': () => ({ body: page('', 'Home', 'Home') }) });
  try {
    const scenario = await buildScenario(site, ['/'], { enable: FAMILIES, name: 'cwv' });
    const store = openStore(scenario.evidence(''));
    await collectCwv({ origin: site.origin, key: KEY, store, fetchFn: fakeFetch(reply(200, crux({ largest_contentful_paint: 2000,
      interaction_to_next_paint: 350, cumulative_layout_shift: '0.3' }))).fetchFn });
    const indexRef = scenario.evidence('evidence-index.json');
    const { cwv: entries } = await store.index();
    for (const entry of entries) await scenario.add(entry.evidence_ref, 'cwv', 'optbrew:collector');
    await scenario.rewrite(indexRef, () => {});
    const cwv = entries.map(entry => ({ ...JSON.parse(readFileSync(entry.evidence_ref, 'utf8')), evidence_ref: entry.evidence_ref }));
    const derived = deriveObservations({ context: scenario.context, artifacts: scenario.audit.artifacts, collection: scenario.audit,
      textOf: x => x.content_hash ? readFileSync(x.evidence_ref, 'utf8') : null, cwv });
    const forged = () => scenario.forgeObservations(list => list.splice(0, list.length, ...list.filter(x => !FAMILIES.includes(x.family_id)),
      ...derived.filter(x => FAMILIES.includes(x.family_id))));
    return { site, scenario, derived, forged, entry: entries[0] };
  } catch (error) { await site.close(); throw error; }
}

test('field families replay from stored CWV evidence', { timeout: 120000 }, async () => {
  const run = await replayable();
  try {
    assert.deepEqual(Object.fromEntries(run.derived.filter(x => FAMILIES.includes(x.family_id)).map(x => [x.family_id, x.state])),
      { 'lcp-field': 'pass', 'inp-field': 'partial', 'cls-field': 'fail' });
    assert.throws(() => buildReport(run.scenario.packet), /collector verdict differs from raw evidence: lcp-field/,
      'the audit saw no field data, the stored CWV evidence says otherwise');
    await run.forged();
    assert.ok(buildReport(run.scenario.packet).json.baseline.scores.length > 0);
    await run.scenario.forgeObservations(list => { list.find(x => x.family_id === 'lcp-field').reason = 'p75 9000 ms from crux'; });
    assert.throws(() => buildReport(run.scenario.packet), /collector verdict differs from raw evidence/);
  } finally { await run.site.close(); }
});

test('report replay rejects CWV evidence that no longer matches the audit index', { timeout: 120000 }, async () => {
  const run = await replayable();
  try {
    await run.forged();
    await run.scenario.rewrite(run.entry.evidence_ref, record => { record.body.record.metrics.largest_contentful_paint.percentiles.p75 = 9000; });
    assert.throws(() => buildReport(run.scenario.packet), /CWV record hash differs from the audit index/);
  } finally { await run.site.close(); }
});

test('report replay scans stored CWV evidence for a Google key', { timeout: 120000 }, async () => {
  const run = await replayable();
  try {
    await run.forged();
    const leaked = `{"source":"crux","origin":"${run.site.origin}","status":200,"body":"${KEY}"}\n`;
    await writeFile(run.entry.evidence_ref, leaked);
    run.scenario.packet.evidence_index.find(x => x.ref === run.entry.evidence_ref).sha256 = sha(leaked);
    assert.throws(() => buildReport(run.scenario.packet), /private identifier or secret in report evidence/);
  } finally { await run.site.close(); }
});

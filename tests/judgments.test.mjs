import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildJudgeQueue, checkSpan, mergeJudgments } from '../skills/optbrew/scripts/core/judgments.mjs';
import { blocks } from '../skills/optbrew/scripts/core/checks/index.mjs';
import { makeObservation, unitKey } from '../skills/optbrew/scripts/core/checks/observation.mjs';
import { openStore } from '../skills/optbrew/scripts/core/evidence-store.mjs';
import { validateEntity } from '../skills/optbrew/scripts/core/contracts.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { buildScenario, page, startSite } from './support/review-scenario.mjs';
import { tempDir } from './support/temp-dir.mjs';

const URL_A = 'https://example.com/guide';
const FIRST = '옵트브루는 홈페이지의 검색 노출 상태를 점검하고 근거와 함께 보고서를 만든다.';
const MIDDLE = '이 가운데 문단은 판정에 인용되지 않았으므로 근거 범위에 들어가면 안 되는 글이다.';
const LAST = '보고서는 모델이 내린 판정과 코드가 내린 판정을 구분해서 보여 주도록 만들어져 있다.';
const HTML = `<!doctype html><html><head><title>옵트브루 소개</title><script>var 가 = "이 스크립트는 보이지 않는 글자입니다 보이지 않는 글자입니다";</script></head>` +
  `<body><h1>검색 점검 도구</h1><p>${FIRST}</p><!-- 주석은 보이지 않는 글자입니다 보이지 않는 글자입니다 --><p>${MIDDLE}</p><p>${LAST}</p><p>짧음</p></body></html>`;

async function fixtureStore(html = HTML, extra = []) {
  const dir = await tempDir('optbrew-judge-');
  const store = openStore(dir, { run_id: 'run-judge', context_ref: 'context.json' });
  const bytes = Buffer.from(html);
  const { ref, sha256 } = await store.write('html', bytes);
  await store.append('raw', { normalized_url: URL_A, evidence_ref: ref, content_hash: sha256 });
  const fetched = makeObservation({ family_id: 'fetch-response', unit_key: unitKey('fetch-response', URL_A), state: 'pass', reason: 'HTTP 200', evidence_ref: ref });
  return { store, ref, sha256, bytes, observations: [fetched, ...extra] };
}
const unit = family => unitKey(family, URL_A);
const queuedItem = (queue, family) => queue.items.find(item => item.family_id === family);
const queueRefOf = async store => (await store.index()).judge_queue.at(-1).evidence_ref;
const pass = (family, span_ids, extra = {}) => ({ family_id: family, unit_key: unit(family), state: 'pass', q: 1, reason: '근거가 본문에 있다', span_ids, ...extra });

test('buildJudgeQueue offers visible text runs and stores the queue in the run evidence', async () => {
  const { store, observations, sha256 } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  assert.deepEqual(queue.items.map(item => item.family_id).sort(),
    ['answer-clarity', 'claim-support', 'freshness-truth', 'original-value', 'source-transparency']);
  const item = queuedItem(queue, 'claim-support');
  assert.equal(item.unit_key, unit('claim-support'));
  assert.equal(item.evidence_sha256, sha256);
  assert.deepEqual(item.spans.map(span => span.text), [FIRST, MIDDLE, LAST]);
  assert.equal(JSON.stringify(queue).includes('스크립트'), false, 'script text is not offered');
  assert.equal(JSON.stringify(queue).includes('주석'), false, 'comment text is not offered');
  const listed = (await store.index()).judge_queue;
  assert.equal(listed.length, 1);
  assert.deepEqual(JSON.parse(await store.read(listed[0].evidence_ref, listed[0].sha256)), queue);
  await buildJudgeQueue({ observations, store });
  assert.equal((await store.index()).judge_queue.length, 1, 'the same queue is listed once');
});

test('spans are UTF-8 byte ranges over Hangul text', async () => {
  const { store, observations, bytes, sha256 } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [span] = queuedItem(queue, 'claim-support').spans;
  assert.deepEqual(Object.keys(span), ['span_id', 'evidence_sha256', 'start', 'end', 'text']);
  assert.equal(span.start, bytes.indexOf(Buffer.from(FIRST)));
  assert.equal(span.end - span.start, Buffer.byteLength(FIRST));
  assert.notEqual(span.end - span.start, FIRST.length);
  assert.notEqual(HTML.indexOf(FIRST), span.start, 'byte offset and code-unit offset differ');
  assert.equal(bytes.subarray(span.start, span.end).toString('utf8'), span.text);
  const merged = await mergeJudgments({ observations, store, judgments: [pass('claim-support', [span.span_id])] });
  const made = merged.find(x => x.family_id === 'claim-support');
  assert.deepEqual(made.evidence_span, [{ evidence_sha256: sha256, start: span.start, end: span.end }]);
  assert.equal(made.evaluator_type, 'host_model');
  assert.equal(made.source_ref, 'optbrew:model-judgment');
  assert.equal(merged.length, observations.length + 1);
  checkSpan(bytes, made.evidence_span[0]);
});

test('several cited spans stay separate ranges and the text between them is not cited', async () => {
  const { store, observations, bytes } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [first, middle, last] = queuedItem(queue, 'claim-support').spans;
  const merged = await mergeJudgments({ observations, store, judgments: [pass('claim-support', [first.span_id, last.span_id])] });
  const ranges = merged.find(x => x.family_id === 'claim-support').evidence_span;
  assert.deepEqual(ranges.map(x => [x.start, x.end]), [[first.start, first.end], [last.start, last.end]]);
  assert.ok(ranges.every(x => x.end <= middle.start || x.start >= middle.end), 'no range touches the middle paragraph');
  assert.equal(bytes.indexOf(Buffer.from(MIDDLE)), middle.start);
  await assert.rejects(mergeJudgments({ observations, store, judgments: [pass('claim-support', [first.span_id, first.span_id])] }), /repeat a span/);
});

test('a span cannot start or end inside a multi-byte character', async () => {
  const { store, observations, bytes } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [span] = queuedItem(queue, 'claim-support').spans;
  assert.throws(() => checkSpan(bytes, { start: span.start + 1, end: span.end }), /multi-byte/);
  assert.throws(() => checkSpan(bytes, { start: span.start, end: span.end - 2 }), /multi-byte/);
  assert.throws(() => checkSpan(bytes, { start: span.start, end: bytes.length + 1 }), /inside the evidence/);
  assert.throws(() => checkSpan(bytes, { start: span.end, end: span.end }), /inside the evidence/);
});

test('merge reads the queue from the run evidence: a tampered queue file fails', async () => {
  const { store, observations } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [span] = queuedItem(queue, 'claim-support').spans;
  const forged = structuredClone(queue);
  queuedItem(forged, 'claim-support').spans[0].start += 1;
  writeFileSync(await queueRefOf(store), `${JSON.stringify(forged, null, 2)}\n`);
  await assert.rejects(mergeJudgments({ observations, store, judgments: [pass('claim-support', [span.span_id])] }), /hash mismatch/);
  const empty = await fixtureStore();
  await assert.rejects(mergeJudgments({ observations: empty.observations, store: empty.store, judgments: [] }), /no judge queue/);
});

test('a judgment cannot overwrite a code-judged family', async () => {
  const { store, observations } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [span] = queuedItem(queue, 'claim-support').spans;
  for (const { family_id } of blocks) {
    await assert.rejects(mergeJudgments({ observations, store,
      judgments: [{ family_id, unit_key: unitKey(family_id, URL_A), state: 'pass', q: 1, reason: 'x', span_ids: [span.span_id] }] }), /judged by code/, family_id);
  }
  assert.equal(queue.items.some(item => blocks.some(block => block.family_id === item.family_id)), false);
});

test('an unknown span_id is rejected', async () => {
  const { store, observations } = await fixtureStore();
  await buildJudgeQueue({ observations, store });
  const judgment = pass('claim-support', []);
  await assert.rejects(mergeJudgments({ observations, store, judgments: [{ ...judgment, span_ids: ['0-9'] }] }), /unknown span_id 0-9/);
  await assert.rejects(mergeJudgments({ observations, store, judgments: [judgment] }), /needs span_ids/);
  await assert.rejects(mergeJudgments({ observations, store, judgments: [{ ...judgment, unit_key: unitKey('claim-support', 'https://other.example/'), span_ids: ['0-9'] }] }), /no queued unit/);
});

test('unknown state needs no span', async () => {
  const { store, observations, ref } = await fixtureStore();
  await buildJudgeQueue({ observations, store });
  const merged = await mergeJudgments({ observations, store,
    judgments: [{ family_id: 'answer-clarity', unit_key: unit('answer-clarity'), state: 'unknown', q: null, reason: '질문이 없어 판단할 수 없다', span_ids: [] }] });
  const made = merged.find(x => x.family_id === 'answer-clarity');
  assert.equal(made.state, 'unknown');
  assert.equal(made.evidence_ref, ref);
  assert.equal(Object.hasOwn(made, 'evidence_span'), false);
});

test('a judged unit is not queued again and an unknown placeholder is replaced', async () => {
  const known = makeObservation({ family_id: 'claim-support', unit_key: unit('claim-support'), state: 'pass', reason: 'x', evidence_ref: 'e' });
  const placeholder = makeObservation({ family_id: 'original-value', unit_key: unit('original-value'), state: 'unknown', reason: 'x', evidence_ref: 'e' });
  const { store, observations } = await fixtureStore(HTML, [known, placeholder]);
  const queue = await buildJudgeQueue({ observations, store });
  assert.equal(queuedItem(queue, 'claim-support'), undefined);
  const [span] = queuedItem(queue, 'original-value').spans;
  const merged = await mergeJudgments({ observations, store,
    judgments: [{ family_id: 'original-value', unit_key: unit('original-value'), state: 'partial', q: 0.5, reason: '설명은 있으나 독자 자료가 없다', span_ids: [span.span_id] }] });
  assert.equal(merged.filter(x => x.unit_key === unit('original-value')).length, 1);
  assert.deepEqual(merged.find(x => x.unit_key === unit('original-value')).partial_basis, { kind: 'threshold_half' });
  const fresh = await fixtureStore();
  await buildJudgeQueue({ observations: fresh.observations, store: fresh.store });
  await assert.rejects(mergeJudgments({ observations: [...fresh.observations, known], store: fresh.store, judgments: [pass('claim-support', [span.span_id])] }), /already has a verdict/);
});

test('a partial judgment must fit the verdict mode of its family', async () => {
  const { store, observations } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [span] = queuedItem(queue, 'claim-support').spans;
  const partial = (family, extra = {}) => ({ family_id: family, unit_key: unit(family), state: 'partial', reason: 'x', span_ids: [span.span_id], ...extra });
  await assert.rejects(mergeJudgments({ observations, store, judgments: [partial('claim-support', { q: 0.5 })] }), /needs partial_basis/);
  await assert.rejects(mergeJudgments({ observations, store, judgments: [partial('claim-support', { q: 0.5, partial_basis: { kind: 'ratio', numerator: 2, denominator: 2 } })] }), /0 < numerator < denominator/);
  await assert.rejects(mergeJudgments({ observations, store, judgments: [partial('freshness-truth', { q: 0.5 })] }), /binary/);
  const merged = await mergeJudgments({ observations, store, judgments: [partial('claim-support', { partial_basis: { kind: 'ratio', numerator: 1, denominator: 4 } })] });
  assert.equal(merged.find(x => x.family_id === 'claim-support').q, 0.25);
});

test('a secret in a text run never enters the queue, and a secret in a reason is refused', async () => {
  const key = `AKIA${'ABCDEFGHIJKLMNOP'}`;
  const html = `<body><p>${FIRST}</p><p>이 문단에는 비밀 값 ${key} 이(가) 들어 있어서 목록에서 빠져야 한다.</p></body>`;
  const { store, observations } = await fixtureStore(html);
  const queue = await buildJudgeQueue({ observations, store });
  assert.equal(JSON.stringify(queue).includes(key), false);
  assert.equal(readFileSync(await queueRefOf(store), 'utf8').includes(key), false);
  const [span] = queuedItem(queue, 'claim-support').spans;
  assert.equal(queuedItem(queue, 'claim-support').spans.length, 1);
  await assert.rejects(mergeJudgments({ observations, store, judgments: [pass('claim-support', [span.span_id], { reason: key })] }), /secret/);
});

test('evidence that no longer matches its hash fails the queue', async () => {
  const { store, observations, ref } = await fixtureStore();
  writeFileSync(ref, `${HTML} `);
  await assert.rejects(buildJudgeQueue({ observations, store }), /hash mismatch/);
});

test('ChangeRecord without analysis is rejected', () => {
  const record = { schema_version: '1.0.0', change_id: 'c1', finding_ids: ['f'], environment: 'local', path: 'p', before_hash: 'a', after_hash: 'b',
    backup_ref: 'x', verification: { status: 'passed' }, evidence_ref: 'e' };
  assert.throws(() => validateEntity('ChangeRecord', record), /analysis: required/);
  const analysis = { tools: ['optbrew'], queries: ['index-policy 점검'], self_analysis: false };
  assert.equal(validateEntity('ChangeRecord', { ...record, analysis }).analysis, analysis);
  assert.throws(() => validateEntity('ChangeRecord', { ...record, analysis: { ...analysis, self_analysis: 'no' } }), /self_analysis/);
  assert.throws(() => validateEntity('ChangeRecord', { ...record, analysis: { tools: [], queries: [] } }), /self_analysis: required/);
});

test('a host-model verdict needs evidence spans unless it is unknown', () => {
  const base = { schema_version: '1.0.0', observation_id: 'o', check_id: 'claim-support', family_id: 'claim-support', unit_key: 'claim-support|u',
    state: 'pass', q: 1, partial_basis: null, reason: 'x', evaluator_type: 'host_model', source_ref: 's', evidence_ref: 'e' };
  const span = { evidence_sha256: 'h', start: 0, end: 3 };
  assert.throws(() => validateEntity('CheckObservation', base), /evidence_span: required/);
  validateEntity('CheckObservation', { ...base, evidence_span: [span, { ...span, start: 5, end: 9 }] });
  assert.throws(() => validateEntity('CheckObservation', { ...base, evidence_span: [] }), /too few items/);
  assert.throws(() => validateEntity('CheckObservation', { ...base, evidence_span: span }), /expected array/);
  validateEntity('CheckObservation', { ...base, state: 'unknown', q: null });
  validateEntity('CheckObservation', { ...base, evaluator_type: 'code' });
  assert.throws(() => validateEntity('CheckObservation', { ...base, evidence_span: [{ ...span, start: -1 }] }), /start/);
});

/** A real local audit of Hangul pages with claim-support planned and a judge queue stored in the run evidence. */
async function modelRun(name, routes = ['/']) {
  const site = await startSite(Object.fromEntries(routes.map(route => [route, { body: page('', `<p>${FIRST}</p><p>${MIDDLE}</p><p>${LAST}</p>`, `옵트브루 ${route}`) }])));
  try {
    const scenario = await buildScenario(site, routes, { enable: ['claim-support'], name });
    const store = openStore(scenario.evidence(''));
    const observations = scenario.packet.baseline.input.observations;
    const queue = await buildJudgeQueue({ observations, store });
    const queueRef = await queueRefOf(store);
    await scenario.add(queueRef, 'judge-queue');
    await scenario.rewrite(scenario.evidence('evidence-index.json'), index => index);
    const units = routes.map(route => unitKey('claim-support', `${site.origin}${route}`));
    /** The judgment of one unit citing its first and last candidate span, merged through the stored queue. */
    const judge = async (unit_key, picks = [0, 2]) => {
      const item = queue.items.find(x => x.unit_key === unit_key);
      const merged = await mergeJudgments({ observations, store, judgments: [{ family_id: 'claim-support', unit_key, state: 'pass', q: 1,
        reason: '근거 문장이 본문에 있다', span_ids: picks.map(i => item.spans[i].span_id) }] });
      return merged.find(x => x.unit_key === unit_key);
    };
    return { site, scenario, queueRef, units, judge };
  } catch (error) { await site.close(); throw error; }
}
/** Change the packet's baseline observations and recompute everything derived from them, as a forger would. */
const forge = (run, change) => {
  const input = run.scenario.packet.baseline.input;
  change(input.observations);
  run.scenario.packet.baseline.scores = score(input);
  run.scenario.packet.comparison = compare(input, null);
};

test('report marks model judgments', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-ok');
  try {
    const made = await run.judge(run.units[0]);
    forge(run, list => list.push(made));
    const report = buildReport(run.scenario.packet);
    assert.deepEqual(report.json.model_judgments, [{ phase: 'baseline', family_id: 'claim-support', unit_key: made.unit_key, state: 'pass',
      evidence_ref: made.evidence_ref, evidence_span: made.evidence_span, label: '근거 확인됨, 판정은 모델' }]);
    assert.equal(made.evidence_span.length, 2);
    assert.ok(report.markdown.includes('## Model judgments'));
    assert.ok(report.markdown.includes('근거 확인됨, 판정은 모델'));
    assert.ok(report.markdown.includes(`bytes ${made.evidence_span.map(x => `${x.start}–${x.end}`).join(', ')}`));
  } finally { await run.site.close(); }
});

test('a tampered model-judgment span fails report replay', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-span');
  try {
    const made = await run.judge(run.units[0]);
    const original = structuredClone(made.evidence_span);
    const cases = [
      ['past the end of the evidence', span => { span.end += 100000; }, /inside the evidence/],
      ['inside a multi-byte character', span => { span.start += 1; }, /multi-byte/],
      ['another evidence hash', span => { span.evidence_sha256 = '0'.repeat(64); }, /names evidence other than the unit page/],
      ['a range that is no text run of the page', span => { span.start = 0; span.end = 5; }, /is not a text run of the page/],
    ];
    forge(run, list => list.push(made));
    for (const [name, tamper, expected] of cases) {
      made.evidence_span = structuredClone(original);
      tamper(made.evidence_span[0]);
      assert.throws(() => buildReport(run.scenario.packet), expected, name);
    }
    made.evidence_span = original;
    buildReport(run.scenario.packet);
  } finally { await run.site.close(); }
});

test('a tampered judge queue fails report replay', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-queue');
  try {
    const made = await run.judge(run.units[0]);
    forge(run, list => list.push(made));
    buildReport(run.scenario.packet);
    const forged = JSON.parse(readFileSync(run.queueRef, 'utf8'));
    forged.items[0].spans.push({ ...forged.items[0].spans[0], span_id: '0-5', start: 0, end: 5 });
    writeFileSync(run.queueRef, `${JSON.stringify(forged, null, 2)}\n`);
    assert.throws(() => buildReport(run.scenario.packet), /hash mismatch/, 'the queue file no longer matches the packet index');
    await run.scenario.rewrite(run.queueRef, () => forged);
    assert.throws(() => buildReport(run.scenario.packet), /judge queue hash differs from the audit index/, 'a refreshed packet hash still contradicts the audit index');
  } finally { await run.site.close(); }
});

test('a host-model observation for a code-judged family, or without the model source, is rejected', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-code');
  try {
    const made = await run.judge(run.units[0]);
    forge(run, list => list.push({ ...made, source_ref: 'optbrew:collector' }));
    assert.throws(() => buildReport(run.scenario.packet), /judged by a model through the judge queue/);
    forge(run, list => list.pop());
    const code = run.scenario.packet.baseline.input.observations.find(x => x.family_id === 'fetch-response');
    forge(run, () => Object.assign(code, { evaluator_type: 'host_model', source_ref: 'optbrew:model-judgment', evidence_span: made.evidence_span }));
    assert.throws(() => buildReport(run.scenario.packet), /fetch-response is judged by code/);
  } finally { await run.site.close(); }
});

test('an external_model verdict for a code-judged family is refused', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-external');
  try {
    const code = run.scenario.packet.baseline.input.observations.find(x => x.family_id === 'index-policy');
    forge(run, () => Object.assign(code, { evaluator_type: 'external_model' }));
    assert.throws(() => buildReport(run.scenario.packet), /index-policy is judged by code; a external_model observation/);
    forge(run, () => Object.assign(code, { evaluator_type: 'human' }));
    assert.throws(() => buildReport(run.scenario.packet), /index-policy is judged by code; a human observation/);
  } finally { await run.site.close(); }
});

test('a human verdict with an unknown source_ref is refused', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-human');
  try {
    const { evidence_span, ...rest } = await run.judge(run.units[0]);
    assert.ok(evidence_span);
    await run.scenario.record('reviewer-note.json', { note: '검토 의견' }, 'record', 'custom:reviewer');
    forge(run, list => list.push({ ...rest, evaluator_type: 'human', source_ref: 'custom:reviewer', evidence_ref: 'reviewer-note.json' }));
    assert.throws(() => buildReport(run.scenario.packet), /claim-support is judged by a model through the judge queue; evaluator_type human with source_ref custom:reviewer/);
  } finally { await run.site.close(); }
});

test('a relabelled host_model judgment is refused', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-relabel');
  try {
    const made = await run.judge(run.units[0]);
    // The relabelled verdict borrows the collector's source, the one pair that passes the evidence source pin.
    for (const evaluator_type of ['external_model', 'human', 'code']) {
      const relabel = { evaluator_type, source_ref: 'optbrew:collector' };
      forge(run, list => list.splice(0, list.length, ...list.filter(x => x.family_id !== 'claim-support'), { ...made, ...relabel }));
      assert.throws(() => buildReport(run.scenario.packet), /claim-support is judged by a model through the judge queue/, JSON.stringify(relabel));
    }
  } finally { await run.site.close(); }
});

/** Rewrite the stored queue and every hash that names it, as a forger who controls the whole evidence directory would. */
async function forgeQueue(run, mutate) {
  const forged = JSON.parse(readFileSync(run.queueRef, 'utf8'));
  mutate(forged);
  writeFileSync(run.queueRef, `${JSON.stringify(forged, null, 2)}\n`);
  await run.scenario.rewrite(run.queueRef, () => forged);
  const sha256 = run.scenario.packet.evidence_index.find(x => x.ref === run.queueRef).sha256;
  await run.scenario.rewrite(run.scenario.evidence('evidence-index.json'), index => { index.judge_queue.at(-1).sha256 = sha256; });
}

test('a consistently forged queue cannot offer a range that is not a text run of the page', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-forged');
  try {
    const made = await run.judge(run.units[0]);
    const [first, second] = made.evidence_span;
    const odd = { ...first, start: first.start + 3, end: first.end - 4 };
    await forgeQueue(run, queue => {
      const item = queue.items.find(x => x.unit_key === made.unit_key);
      item.spans = item.spans.filter(x => x.start !== first.start);
      item.spans.push({ span_id: `${odd.start}-${odd.end}`, ...odd, text: 'forged' });
    });
    forge(run, list => list.push({ ...made, evidence_span: [odd, second] }));
    assert.throws(() => buildReport(run.scenario.packet), /is not a text run of the page/);
  } finally { await run.site.close(); }
});

test('a text run of the page that the stored queue never offered is refused', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-unoffered');
  try {
    const made = await run.judge(run.units[0]);
    await forgeQueue(run, queue => { queue.items.find(x => x.unit_key === made.unit_key).spans.shift(); });
    forge(run, list => list.push(made));
    assert.throws(() => buildReport(run.scenario.packet), /is not a candidate of the stored judge queue/);
  } finally { await run.site.close(); }
});

test('queue evidence indexed under another kind is refused', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-kind');
  try {
    const made = await run.judge(run.units[0]);
    forge(run, list => list.push(made));
    run.scenario.packet.evidence_index.find(x => x.ref === run.queueRef).kind = 'record';
    assert.throws(() => buildReport(run.scenario.packet), /has kind record, not judge-queue/);
  } finally { await run.site.close(); }
});

test('a host-model verdict without a span is refused when the report is built', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-nospan');
  try {
    const { evidence_span, ...bare } = await run.judge(run.units[0]);
    assert.ok(evidence_span);
    run.scenario.packet.baseline.input.observations.push(bare);
    assert.throws(() => buildReport(run.scenario.packet), /evidence_span: required/);
  } finally { await run.site.close(); }
});

test('a model judgment citing another page\'s evidence is rejected', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-page', ['/', '/b']);
  try {
    const made = await run.judge(run.units[1]);
    forge(run, list => list.push({ ...made, unit_key: run.units[0] }));
    assert.throws(() => buildReport(run.scenario.packet), /not the audit raw entry of the unit page/);
    forge(run, list => list.pop());
    forge(run, list => list.push(made));
    buildReport(run.scenario.packet);
  } finally { await run.site.close(); }
});

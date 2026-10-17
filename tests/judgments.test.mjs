import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { ENTITY_UNIT, QUESTION_UNIT, buildJudgeQueue, candidateSpans, checkSpan, deriveQuestionCoverage, homeOf, mergeJudgments } from '../skills/optbrew/scripts/core/judgments.mjs';
import { blocks } from '../skills/optbrew/scripts/core/checks/index.mjs';
import { makeObservation, unitKey } from '../skills/optbrew/scripts/core/checks/observation.mjs';
import { openStore } from '../skills/optbrew/scripts/core/evidence-store.mjs';
import { validateEntity } from '../skills/optbrew/scripts/core/contracts.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { compileUnits } from '../skills/optbrew/scripts/core/weights.mjs';
import { limits } from '../skills/optbrew/scripts/core/config.mjs';
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
const PANEL = [{ id: 'q1', question: '운영 시간은 언제인가?', category: 'brand' }, { id: 'q2', question: '비용은 얼마인가?', category: 'non_brand' }];
const unit = family => unitKey(family, URL_A);
const queuedItem = (queue, family) => queue.items.find(item => item.family_id === family);
const queueRefOf = async store => (await store.index()).judge_queue.at(-1).evidence_ref;
const pass = (family, span_ids, extra = {}) => ({ family_id: family, unit_key: unit(family), state: 'pass', q: 1, reason: '근거가 본문에 있다', span_ids, ...extra });

test('buildJudgeQueue offers visible text runs and stores the queue in the run evidence', async () => {
  const { store, observations, sha256 } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  assert.deepEqual(queue.items.map(item => item.family_id).sort(),
    ['answer-clarity', 'claim-support', 'entity-identity', 'freshness-truth', 'original-value', 'source-transparency']);
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
  assert.deepEqual(queue.items.filter(item => blocks.some(block => block.family_id === item.family_id)).map(item => item.unit_key), [ENTITY_UNIT],
    'the only code-judged unit the queue offers is the site identity, where code gave no verdict');
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

test("a judgment's own q is ignored", async () => {
  const { store, observations } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const span = id => queuedItem(queue, id).spans[0].span_id;
  const merged = await mergeJudgments({ observations, store, questions: PANEL, judgments: [
    pass('claim-support', [span('claim-support')], { q: 0.3 }),
    { family_id: 'original-value', unit_key: unit('original-value'), state: 'fail', q: 0.9, reason: '자기 자료가 없다', span_ids: [span('original-value')] },
    { family_id: 'answer-clarity', unit_key: unit('answer-clarity'), state: 'partial', q: 0.9, reason: '일부만 답한다', span_ids: [span('answer-clarity')], question_id: 'q1' },
    { family_id: 'freshness-truth', unit_key: unit('freshness-truth'), state: 'unknown', q: 0.4, reason: '날짜가 없다', span_ids: [] }] });
  const q = id => merged.find(x => x.unit_key === unit(id)).q;
  assert.deepEqual(['claim-support', 'original-value', 'answer-clarity', 'freshness-truth'].map(q), [1, 0, 0.5, null]);
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
  const record = { schema_version: '2.0.0', change_id: 'c1', finding_ids: ['f'], environment: 'local', path: 'p', before_hash: 'a', after_hash: 'b',
    backup_ref: 'x', verification: { status: 'passed' }, evidence_ref: 'e' };
  assert.throws(() => validateEntity('ChangeRecord', record), /analysis: required/);
  const analysis = { tools: ['optbrew'], queries: ['index-policy 점검'], self_analysis: false };
  assert.equal(validateEntity('ChangeRecord', { ...record, analysis }).analysis, analysis);
  assert.throws(() => validateEntity('ChangeRecord', { ...record, analysis: { ...analysis, self_analysis: 'no' } }), /self_analysis/);
  assert.throws(() => validateEntity('ChangeRecord', { ...record, analysis: { tools: [], queries: [] } }), /self_analysis: required/);
});

test('a host-model verdict needs evidence spans unless it is unknown', () => {
  const base = { schema_version: '2.0.0', observation_id: 'o', check_id: 'claim-support', family_id: 'claim-support', unit_key: 'claim-support|u',
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
async function modelRun(name, routes = ['/'], { enable = ['claim-support'], questions = [], bodyOf = () => '', withContext = false } = {}) {
  const site = await startSite(Object.fromEntries(routes.map(route => [route, { body: page('', `<p>${FIRST}</p><p>${MIDDLE}</p><p>${LAST}</p>${bodyOf(route)}`, `옵트브루 ${route}`) }])));
  try {
    const scenario = await buildScenario(site, routes, { enable, name, questions });
    const store = openStore(scenario.evidence(''));
    const observations = scenario.packet.baseline.input.observations;
    const queue = await buildJudgeQueue({ observations, store, ...(withContext ? { context: scenario.context } : {}) });
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
    /** Any judgments merged through the stored queue; returns the merged observation list. */
    const merge = judgments => mergeJudgments({ observations, store, judgments, questions });
    return { site, scenario, queue, queueRef, units, judge, merge, observations };
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
    assert.ok(report.markdown.includes('## 모델 판단'));
    assert.ok(report.markdown.includes('근거 확인됨, 판정은 모델'));
    assert.ok(report.markdown.includes(`바이트 ${made.evidence_span.map(x => `${x.start}–${x.end}`).join(', ')}`));
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

// ---- Task 21b lane A: F8 spans, F7 model N/A, F2 question coverage, F3 identity fallback ----

const ATTRIBUTE = '이 문장은 속성 값이라서 보이는 글이 아니므로 후보가 되면 안 되는 긴 글입니다';
const ATTRIBUTE_HTML = `<html lang="ko" data-note="${ATTRIBUTE}"><head><meta name="description" content="${ATTRIBUTE}"><link rel="preload" href="/a.woff2">` +
  `<style>.a>b{color:red}</style></head><body><a href="/x" title="a > b ${ATTRIBUTE}">${FIRST}</a><svg viewBox="0 0 1 1" class="${ATTRIBUTE}"><path d="M0 0"/></svg>` +
  `<p class='${ATTRIBUTE}'>${MIDDLE}</p><p data-x="1">2026-10-01</p><p>문의 02-555-0142</p><p>help@example.org</p><p>짧은 글</p><p>10월 소식</p></body></html>`;

test('candidate spans are the text between tags: attribute values and inert bodies are never offered, offsets stay byte exact', () => {
  const bytes = Buffer.from(ATTRIBUTE_HTML);
  const spans = candidateSpans(bytes, 'hash');
  assert.deepEqual(spans.map(span => span.text), [FIRST, MIDDLE, '2026-10-01', '문의 02-555-0142', 'help@example.org']);
  for (const span of spans) {
    assert.equal(bytes.subarray(span.start, span.end).toString('utf8'), span.text, 'the range holds exactly the text');
    assert.equal(span.span_id, `${span.start}-${span.end}`);
  }
  assert.equal(spans.some(span => span.text.includes('속성 값')), false, 'no attribute value, even one holding a > sign');
  assert.equal(spans.some(span => span.text.includes('color')), false, 'no style body');
});

test('a short run is offered only when it is a date or a contact', () => {
  const html = '<p>짧은 글</p><p>2026년 10월 1일</p><p>Oct 3, 2026</p><p>1588-1234</p><p>03/04/2026</p><p>가나다</p><p>12345</p>';
  assert.deepEqual(candidateSpans(Buffer.from(html), 'h').map(span => span.text), ['2026년 10월 1일', 'Oct 3, 2026', '1588-1234', '03/04/2026']);
});

test('text outside any tag, around inert bodies, and an unterminated tag are handled', () => {
  const lead = '태그 앞에 놓인 글도 보이는 글이므로 후보가 되어야 하는 긴 문장입니다';
  const html = `${lead}<script>var 가 = "스크립트 안의 글은 보이지 않는 글자입니다 보이지 않는 글자입니다";</script>${FIRST}<p class="x`;
  assert.deepEqual(candidateSpans(Buffer.from(html), 'h').map(span => span.text), [lead, FIRST]);
});

test('inline tags do not split a sentence: the span covers them and its text has them left out (R78)', () => {
  const html = '<p>이 문장 안에는 <a href="/x" class="y">링크</a>와 <code>코드</code>가 들어 있어서 <b>한 문장으로</b> 읽혀야 하며<br>태그는 보이지 않는다</p>';
  const bytes = Buffer.from(html);
  const spans = candidateSpans(bytes, 'h');
  assert.equal(spans.length, 1, 'one sentence, one span');
  assert.equal(spans[0].text, '이 문장 안에는 링크와 코드가 들어 있어서 한 문장으로 읽혀야 하며 태그는 보이지 않는다', 'no tag in the text; a line break reads as a space');
  const range = bytes.subarray(spans[0].start, spans[0].end).toString('utf8');
  assert.ok(range.startsWith('이 문장') && range.endsWith('보이지 않는다'), 'the range runs from the first to the last text byte');
  assert.ok(range.includes('<a href'), 'and covers the inline tags');
  assert.deepEqual(candidateSpans(bytes, 'h'), spans, 'the same bytes give the same spans and text');
  const blocks = `<p>${FIRST}</p><div>${MIDDLE}</div><li>${LAST}</li>`;
  assert.deepEqual(candidateSpans(Buffer.from(blocks), 'h').map(span => span.text), [FIRST, MIDDLE, LAST], 'p, div and li still end a span');
});

test('date and contact spans have their own allowance beside the cap of long spans (R78)', () => {
  const long = Array.from({ length: 31 }, (_, n) => `<p>${n}번째 문단은 길이 순서로 상한을 채우기 위한 글이며 마흔 바이트를 넘도록 충분히 길게 쓴 글입니다</p>`).join('');
  const shorts = Array.from({ length: 12 }, (_, n) => `<p>2026-10-${String(n + 10).padStart(2, '0')}</p>`).join('') + '<p>2026-10-10</p><p>문의 02-555-0142</p>';
  const spans = candidateSpans(Buffer.from(long + shorts), 'h');
  const texts = spans.map(span => span.text);
  assert.equal(texts.filter(text => text.includes('번째 문단')).length, 30, 'the long spans keep their cap');
  assert.equal(texts.filter(text => text.length < 20).length, 10, 'the short date and contact spans keep a cap of their own');
  assert.equal(texts.filter(text => text === '2026-10-10').length, 1, 'the same short text once');
  assert.ok(spans.every((span, i) => i === 0 || spans[i - 1].start < span.start), 'in document order');
});

test('the home page is chosen the same way whatever the order of the pages', () => {
  const urls = ['https://example.com/ko/about', 'https://example.com/ko', 'https://example.com/en/'];
  assert.equal(homeOf(urls), 'https://example.com/ko');
  assert.equal(homeOf([...urls].reverse()), 'https://example.com/ko');
  assert.equal(homeOf(['https://example.com/b', 'https://example.com/']), 'https://example.com/');
  assert.equal(homeOf([]), null);
});

const MAX_SPAN = limits().judge_span_max_bytes;

/** The spans of a page must tile its text: each range exact, inside the cap, in order, and no text lost between them. */
function assertTiled(bytes, spans, text) {
  for (const span of spans) {
    assert.ok(Buffer.byteLength(span.text) <= MAX_SPAN, `a span is at most ${MAX_SPAN} bytes`);
    const range = bytes.subarray(span.start, span.end).toString('utf8');
    assert.equal(range.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '), span.text.replace(/\s+/g, ' '), 'the range holds exactly the text, tags aside');
    checkSpan(bytes, span);
  }
  assert.ok(spans.every((span, i) => i === 0 || spans[i - 1].end <= span.start), 'in order, without overlap');
  assert.equal(spans.map(span => span.text).join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' ').trim(), 'nothing is lost');
}

test('a page of lines separated only by <br> is cut into spans of at most the maximum, each with an exact range (N3)', () => {
  const lines = Array.from({ length: 4000 }, (_, n) => `줄 ${n}번은 한 줄짜리 문장이며 마흔 바이트가 넘도록 쓴 글입니다`);
  const html = `<body>${lines.join('<br>')}</body>`;
  const bytes = Buffer.from(html);
  assert.ok(bytes.length > 150000, 'a page with one huge run');
  const spans = candidateSpans(bytes, 'h');
  assert.equal(spans.length, limits().judge_spans_per_unit, 'the longest spans fill the cap');
  for (const span of spans) {
    assert.ok(Buffer.byteLength(span.text) <= MAX_SPAN);
    assert.equal(bytes.subarray(span.start, span.end).toString('utf8').replaceAll('<br>', ' '), span.text, 'the range, with each <br> read as a space, is the text');
    assert.ok(!span.text.includes('<'), 'no tag in the text');
  }
  assert.deepEqual(candidateSpans(bytes, 'h'), spans, 'the same split every time');
  const few = Buffer.from(`<body>${lines.slice(0, 60).join('<br>')}</body>`);
  const cutLines = candidateSpans(few, 'h');
  assertTiled(few, cutLines, lines.slice(0, 60).join(' '));
  assert.ok(cutLines.every(span => span.text.endsWith('입니다') && span.text.startsWith('줄 ')), 'cut at line breaks, whole lines only');
});

test('one 330 KB paragraph is cut at sentence ends, at a space, or at a character, never inside one (N3)', () => {
  const sentence = '이 문장은 마침표로 끝나며 한 문단 안에서 아주 길게 반복된다. ';
  const paragraph = sentence.repeat(Math.ceil(330000 / Buffer.byteLength(sentence)));
  const bytes = Buffer.from(`<p>${paragraph}</p>`);
  assert.ok(bytes.length >= 330000);
  const [first, second] = candidateSpans(bytes, 'h');
  assert.ok(first.text.endsWith('된다.') && second.text.startsWith('이 문장은'), 'cut after a sentence end');
  assert.ok(candidateSpans(bytes, 'h').length >= 1);
  const small = Buffer.from(`<p>${sentence.repeat(120)}</p>`);
  const spans = candidateSpans(small, 'h');
  assert.ok(spans.length > 1);
  assertTiled(small, spans, sentence.repeat(120));
  assert.ok(spans.slice(0, -1).every(span => span.text.endsWith('된다.')), 'every cut is a sentence end');
  const words = Buffer.from(`<p>${'단어 '.repeat(2010)}</p>`);
  const cut = candidateSpans(words, 'h');
  assert.ok(cut.length > 1 && cut.every(span => span.text.endsWith('단어')), 'no sentence end: cut at a space');
  assertTiled(words, cut, '단어 '.repeat(2010));
  const solid = Buffer.from(`<p>${'가'.repeat(2500)}</p>`);
  const solidSpans = candidateSpans(solid, 'h');
  assert.deepEqual(solidSpans.map(span => Buffer.byteLength(span.text) % 3), solidSpans.map(() => 0), 'no cut inside a three-byte character');
  assert.equal(solidSpans.map(span => span.text).join(''), '가'.repeat(2500), 'nothing is lost, and each range is exact');
  assert.ok(solidSpans.every((span, i) => solid.subarray(span.start, span.end).toString('utf8') === span.text && (i === 0 || solidSpans[i - 1].end === span.start)), 'contiguous exact ranges');
});

test('a sentence inside the maximum is not cut, and a long one with inline tags keeps exact ranges (N3)', () => {
  const sentence = '이 문장은 <a href="/x">링크</a>와 <code>코드</code>가 있고 마침표로 끝난다. ';
  const bytes = Buffer.from(`<p>${sentence.repeat(60)}</p>`);
  const spans = candidateSpans(bytes, 'h');
  assert.ok(spans.length > 1);
  for (const span of spans) {
    assert.ok(span.text.startsWith('이 문장은 링크와 코드가 있고') && span.text.endsWith('끝난다.'));
    assert.ok(!span.text.includes('<'));
    assert.ok(bytes.subarray(span.start, span.end).toString('utf8').includes('<a href'), 'the range covers the inline tags');
  }
  const short = Buffer.from(`<p>${sentence.repeat(3)}</p>`);
  assert.equal(candidateSpans(short, 'h').length, 1);
});

test('a custom element is not an inline tag, and two elements side by side are not glued (N2)', () => {
  const html = `<p>${FIRST}</p><b-card>${MIDDLE}</b-card><code-block>${LAST}</code-block>`;
  assert.deepEqual(candidateSpans(Buffer.from(html), 'h').map(span => span.text), [FIRST, MIDDLE, LAST]);
  const glued = '<div><span>9월 23일(수)</span><strong>추석 민속놀이로 함께한 날을 기록한 글입니다</strong></div>';
  assert.equal(candidateSpans(Buffer.from(glued), 'h')[0].text, '9월 23일(수) 추석 민속놀이로 함께한 날을 기록한 글입니다');
  const particle = '<p>이 문장은 <a href="/x">링크</a>와 이어지는 조사가 붙은 글이며 길이를 맞추려고 길게 쓴다</p>';
  assert.ok(candidateSpans(Buffer.from(particle), 'h')[0].text.includes('링크와 이어지는'), 'a word and its particle stay together');
});

const naFor = (family, condition, span_ids, extra = {}) => ({ family_id: family, unit_key: unit(family), state: 'not_applicable', condition,
  reason: '쪽이 안내 문구뿐이라 항목이 적용되지 않는다', span_ids, ...extra });

test('a model may declare a unit not applicable with a registry condition, a reason and a queued span (F7)', async () => {
  const { store, observations, ref, sha256 } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [span] = queuedItem(queue, 'freshness-truth').spans;
  const merged = await mergeJudgments({ observations, store, judgments: [naFor('freshness-truth', 'no_date_or_currentness', [span.span_id])] });
  const made = merged.find(x => x.unit_key === unit('freshness-truth'));
  assert.equal(made.state, 'not_applicable');
  assert.equal(made.q, null);
  assert.equal(made.partial_basis, null);
  assert.deepEqual(made.applicability_decision, { condition: 'no_date_or_currentness', reason: '쪽이 안내 문구뿐이라 항목이 적용되지 않는다', evidence_ref: ref });
  assert.deepEqual(made.evidence_span, [{ evidence_sha256: sha256, start: span.start, end: span.end }]);
  assert.equal(made.evaluator_type, 'host_model');
  assert.equal(made.source_ref, 'optbrew:model-judgment');
  const conditions = { 'claim-support': 'no_material_claims', 'answer-clarity': 'no_matching_questions', 'original-value': 'simple_contact_or_support',
    'freshness-truth': 'no_date_or_currentness', 'source-transparency': 'not_required_for_purpose' };
  for (const [family, condition] of Object.entries(conditions)) {
    const one = await mergeJudgments({ observations, store, judgments: [naFor(family, condition, [queuedItem(queue, family).spans[0].span_id])] });
    assert.equal(one.find(x => x.unit_key === unit(family)).applicability_decision.condition, condition, family);
  }
});

test('a model not_applicable needs the family\'s own condition, a reason and a span the queue offered (F7)', async () => {
  const { store, observations } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [span] = queuedItem(queue, 'freshness-truth').spans;
  const merge = judgment => mergeJudgments({ observations, store, judgments: [judgment] });
  await assert.rejects(merge(naFor('freshness-truth', undefined, [span.span_id])), /needs a condition of the family/);
  await assert.rejects(merge(naFor('freshness-truth', 'no_matching_questions', [span.span_id])), /needs a condition of the family/, 'another family\'s condition');
  await assert.rejects(merge(naFor('freshness-truth', 'single_locale', [span.span_id])), /needs a condition of the family/, 'a condition of no model family');
  await assert.rejects(merge(naFor('freshness-truth', 'no_date_or_currentness', [])), /needs span_ids/);
  await assert.rejects(merge(naFor('freshness-truth', 'no_date_or_currentness', ['0-9'])), /unknown span_id/);
  await assert.rejects(merge(naFor('freshness-truth', 'no_date_or_currentness', [span.span_id], { reason: '' })), /reason and evidence_ref required/);
  await assert.rejects(merge({ family_id: 'fetch-response', unit_key: unit('fetch-response'), state: 'not_applicable', condition: 'not_html', reason: 'x', span_ids: [span.span_id] }), /judged by code/);
});

const answerPass = (unit_key, question_id, extra = {}) => ({ family_id: 'answer-clarity', unit_key, state: 'pass', reason: '질문에 직접 답한다', question_id, ...extra });

test('an answer-clarity verdict other than unknown names a question of the panel and keeps it in its measurement (F2)', async () => {
  const { store, observations } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const spans = [queuedItem(queue, 'answer-clarity').spans[0].span_id];
  const merge = (judgment, questions = PANEL) => mergeJudgments({ observations, store, questions, judgments: [judgment] });
  const made = (await merge(answerPass(unit('answer-clarity'), 'q2', { span_ids: spans }))).find(x => x.family_id === 'answer-clarity');
  assert.deepEqual(made.measurement, { question_id: 'q2' });
  await assert.rejects(merge(answerPass(unit('answer-clarity'), undefined, { span_ids: spans })), /needs question_id from the question list/);
  await assert.rejects(merge(answerPass(unit('answer-clarity'), 'q9', { span_ids: spans })), /needs question_id from the question list/);
  await assert.rejects(merge(answerPass(unit('answer-clarity'), 'q1', { span_ids: spans }), []), /needs question_id from the question list/);
  const unknown = (await merge({ ...answerPass(unit('answer-clarity'), undefined), state: 'unknown' })).find(x => x.family_id === 'answer-clarity');
  assert.equal(unknown.state, 'unknown');
  assert.equal(Object.hasOwn(unknown, 'measurement'), false, 'an unknown verdict names no question');
  const other = (await merge({ ...naFor('claim-support', 'no_material_claims', [queuedItem(queue, 'claim-support').spans[0].span_id]) })).find(x => x.family_id === 'claim-support');
  assert.equal(Object.hasOwn(other, 'measurement'), false);
});

/** An answer-clarity verdict as the merge makes it, for the derivation tests. */
const answer = (n, state, question_id, evaluator_type = 'host_model') => makeObservation({ family_id: 'answer-clarity', unit_key: `answer-clarity|https://example.com/${n}`, state, reason: 'x',
  evidence_ref: 'e', ...(state === 'partial' ? { q: 0.5, partial_basis: { kind: 'threshold_half' } } : {}),
  extra: { evaluator_type, source_ref: 'optbrew:model-judgment', ...(question_id ? { measurement: { question_id } } : {}),
    ...(state === 'not_applicable' ? { applicability_decision: { condition: 'no_matching_questions', reason: 'x', evidence_ref: 'e' } } : {}),
    ...(state === 'unknown' ? {} : { evidence_span: [{ evidence_sha256: 'h', start: 0, end: 3 }] }) } });
const PANEL4 = ['q1', 'q2', 'q3', 'q4'].map(id => ({ id, question: `질문 ${id}`, category: 'brand' }));
const derive = (observations, panel = PANEL4) => deriveQuestionCoverage({ observations, panel, evidence_ref: 'context.json' }).find(x => x.unit_key === QUESTION_UNIT);

test('question coverage counts each answered question once over the panel and lists them (F2)', () => {
  const partial = derive([answer(1, 'pass', 'q1'), answer(2, 'partial', 'q1'), answer(3, 'pass', 'q2'), answer(4, 'fail', 'q3'), answer(5, 'unknown'), answer(6, 'pass', 'q9')]);
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.partial_basis, { kind: 'ratio', numerator: 2, denominator: 4 });
  assert.equal(partial.q, 0.5);
  assert.equal(partial.evaluator_type, 'code');
  assert.equal(partial.source_ref, 'optbrew:judgment-derived');
  assert.equal(partial.evidence_ref, 'context.json');
  assert.deepEqual(partial.measurement, { answered: 2, questions: 4, list: [
    { question_id: 'q1', answered_by: ['answer-clarity|https://example.com/1', 'answer-clarity|https://example.com/2'] },
    { question_id: 'q2', answered_by: ['answer-clarity|https://example.com/3'] }, { question_id: 'q3', answered_by: [] }, { question_id: 'q4', answered_by: [] }] },
  'a fail names a question without answering it, an unknown or unlisted question counts for nothing');
  assert.deepEqual(derive([answer(1, 'pass', 'q1'), answer(2, 'pass', 'q2'), answer(3, 'pass', 'q3'), answer(4, 'partial', 'q4')]).state, 'pass');
  const none = derive([answer(1, 'fail', 'q1'), answer(2, 'unknown')]);
  assert.equal(none.state, 'fail');
  assert.equal(none.q, 0);
  assert.equal(none.problem_messages[0].message_key, 'question-coverage.none-answered');
});

test('question coverage exists only once a page was judged against a question, and never replaces another verdict (F2)', () => {
  assert.equal(derive([]), undefined);
  assert.equal(derive([answer(1, 'unknown'), answer(2, 'not_applicable')]), undefined, 'no verdict about a question, no figure');
  assert.equal(derive([answer(1, 'pass', 'q1', 'code')]), undefined, 'only the model\'s answers count');
  assert.equal(deriveQuestionCoverage({ observations: [answer(1, 'pass', 'q1')], panel: [], evidence_ref: 'c' }).some(x => x.unit_key === QUESTION_UNIT), false, 'no panel, no unit');
  const observations = [answer(1, 'pass', 'q1')];
  const once = deriveQuestionCoverage({ observations, panel: PANEL4, evidence_ref: 'c' });
  assert.deepEqual(deriveQuestionCoverage({ observations: once, panel: PANEL4, evidence_ref: 'c' }), once, 'deriving again changes nothing');
  const other = makeObservation({ family_id: 'question-coverage', unit_key: QUESTION_UNIT, state: 'pass', reason: 'outside verdict', evidence_ref: 'e', extra: { evaluator_type: 'human', source_ref: 'custom:x' } });
  assert.deepEqual(deriveQuestionCoverage({ observations: [...observations, other], panel: PANEL4, evidence_ref: 'c' }).filter(x => x.unit_key === QUESTION_UNIT), [other]);
});

test('the queue offers the site identity to the model only where code gave no verdict, with the names to judge against (F3)', async () => {
  const { store, observations, ref, sha256 } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store, names: ['옵트브루 센터'], facts: [{ key: 'phone', value: '02-555-0142' }] });
  const item = queuedItem(queue, 'entity-identity');
  assert.equal(item.unit_key, ENTITY_UNIT);
  assert.equal(item.url, URL_A);
  assert.equal(item.evidence_ref, ref);
  assert.equal(item.evidence_sha256, sha256);
  assert.deepEqual(item.identity, { names: ['옵트브루 센터'], facts: [{ key: 'phone', value: '02-555-0142' }], host: 'example.com' });
  assert.deepEqual(item.spans.map(span => span.text), [FIRST, MIDDLE, LAST]);
  for (const state of ['pass', 'fail']) {
    const code = makeObservation({ family_id: 'entity-identity', unit_key: ENTITY_UNIT, state, reason: 'x', evidence_ref: ref });
    assert.equal(queuedItem(await buildJudgeQueue({ observations: [...observations, code], store }), 'entity-identity'), undefined, `a code ${state} is final`);
  }
  const placeholder = makeObservation({ family_id: 'entity-identity', unit_key: ENTITY_UNIT, state: 'unknown', reason: 'x', evidence_ref: ref });
  assert.ok(queuedItem(await buildJudgeQueue({ observations: [...observations, placeholder], store }), 'entity-identity'), 'an unknown placeholder is not a verdict');
  const planned = { protocol: { families: [{ family_id: 'claim-support', applicable: true }, { family_id: 'entity-identity', applicable: false }] } };
  assert.deepEqual((await buildJudgeQueue({ observations, store, context: planned })).items.map(x => x.family_id), ['claim-support'], 'only the planned families are offered');
});

test('the home page is the identity page: the root of the site, else the first page (F3)', async () => {
  const { store, observations, ref } = await fixtureStore();
  const root = 'https://example.com/';
  await store.append('raw', { normalized_url: root, evidence_ref: ref, content_hash: (await store.index()).raw[0].content_hash });
  const second = makeObservation({ family_id: 'fetch-response', unit_key: unitKey('fetch-response', root), state: 'pass', reason: 'HTTP 200', evidence_ref: ref });
  assert.equal(queuedItem(await buildJudgeQueue({ observations: [...observations, second], store }), 'entity-identity').url, root);
});

test('a model judges the site identity from the home page spans, and only when it was queued (F3)', async () => {
  const { store, observations, ref, sha256 } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [span] = queuedItem(queue, 'entity-identity').spans;
  const judgment = { family_id: 'entity-identity', unit_key: ENTITY_UNIT, state: 'pass', reason: '홈 글이 사이트 이름을 말한다', span_ids: [span.span_id] };
  const made = (await mergeJudgments({ observations, store, judgments: [judgment] })).find(x => x.unit_key === ENTITY_UNIT);
  assert.equal(made.state, 'pass');
  assert.equal(made.evaluator_type, 'host_model');
  assert.equal(made.evidence_ref, ref);
  assert.deepEqual(made.evidence_span, [{ evidence_sha256: sha256, start: span.start, end: span.end }]);
  await assert.rejects(mergeJudgments({ observations, store, judgments: [{ ...judgment, state: 'not_applicable', condition: 'no_identified_entity' }] }), /is a site unit and cannot be not_applicable/);
  const code = makeObservation({ family_id: 'entity-identity', unit_key: ENTITY_UNIT, state: 'fail', reason: 'x', evidence_ref: ref });
  await assert.rejects(mergeJudgments({ observations: [...observations, code], store, judgments: [judgment] }), /already has a verdict/);
  const sameUnitOtherPage = { ...judgment, unit_key: unit('entity-identity') };
  await assert.rejects(mergeJudgments({ observations, store, judgments: [sameUnitOtherPage] }), /judged by code/);
});

test('the model\'s identity verdict: pass needs the name and another fact, name only is partial, no name is fail (R77)', async () => {
  const { store, observations, ref } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const spans = queuedItem(queue, 'entity-identity').spans.map(span => span.span_id);
  const verdict = (state, extra = {}) => ({ family_id: 'entity-identity', unit_key: ENTITY_UNIT, state, reason: '홈 글을 읽고 판단했다', span_ids: spans.slice(0, 2), ...extra });
  const made = async judgment => (await mergeJudgments({ observations, store, judgments: [judgment] })).find(x => x.unit_key === ENTITY_UNIT);
  const named = await made(verdict('partial'));
  assert.deepEqual([named.state, named.q, named.partial_basis, named.measurement], ['partial', 0.5, { kind: 'threshold_half' }, { identity_basis: 'name_only' }], 'the name alone is half');
  assert.deepEqual((await made(verdict('pass'))).measurement, { identity_basis: 'name_and_fact' });
  const missing = await made(verdict('fail'));
  assert.deepEqual([missing.state, missing.q, missing.measurement], ['fail', 0, { identity_basis: 'no_matching_name' }]);
  assert.equal(Object.hasOwn(await made(verdict('unknown', { span_ids: [] })), 'measurement'), false, 'nothing to compare: unknown');
  assert.equal(named.evidence_ref, ref);
  await assert.rejects(mergeJudgments({ observations, store, judgments: [{ family_id: 'freshness-truth', unit_key: unit('freshness-truth'), state: 'partial', reason: 'x', span_ids: spans.slice(0, 1) }] }), /is binary/, 'the other binary families still refuse a partial');
});

test('answer-clarity: a page about a question that does not answer it is a fail; not applicable names no question and needs the registry condition (R79)', async () => {
  const { store, observations } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const span = [queuedItem(queue, 'answer-clarity').spans[0].span_id];
  const merge = judgment => mergeJudgments({ observations, store, questions: PANEL, judgments: [{ family_id: 'answer-clarity', unit_key: unit('answer-clarity'), reason: '판단했다', span_ids: span, ...judgment }] });
  const failed = (await merge({ state: 'fail', question_id: 'q1' })).find(x => x.family_id === 'answer-clarity');
  assert.deepEqual([failed.state, failed.q, failed.measurement], ['fail', 0, { question_id: 'q1' }], 'relevant but unanswered');
  await assert.rejects(merge({ state: 'fail' }), /needs question_id from the question list/, 'a fail names the question it fails');
  const free = (await merge({ state: 'not_applicable', condition: 'no_matching_questions' })).find(x => x.family_id === 'answer-clarity');
  assert.deepEqual([free.state, free.applicability_decision.condition, Object.hasOwn(free, 'measurement')], ['not_applicable', 'no_matching_questions', false]);
  await assert.rejects(merge({ state: 'not_applicable', condition: 'no_matching_questions', question_id: 'q1' }), /names no question/, 'naming a question means pass, partial or fail');
  await assert.rejects(merge({ state: 'not_applicable' }), /needs a condition of the family/);
  await assert.rejects(merge({ state: 'not_applicable', condition: 'no_material_claims' }), /needs a condition of the family/);
  assert.match(readFileSync(new URL('../skills/optbrew/references/judging.md', import.meta.url), 'utf8'), /질문에 관련된 쪽이 답하지 않으면 `fail`이지 `not_applicable`이 아니다/);
});

test('replay checks the identity basis against the state, and the report shows it (N4)', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-basis', ['/'], { enable: ['entity-identity'], withContext: true });
  try {
    const item = run.queue.items.find(x => x.unit_key === ENTITY_UNIT);
    const made = (await run.merge([{ family_id: 'entity-identity', unit_key: ENTITY_UNIT, state: 'partial', reason: '이름만 말한다', span_ids: [item.spans[0].span_id] }]))
      .find(x => x.unit_key === ENTITY_UNIT);
    assert.deepEqual(made.measurement, { identity_basis: 'name_only' });
    forge(run, list => list.push(made));
    const report = buildReport(run.scenario.packet);
    assert.equal(report.json.model_judgments[0].identity_basis, 'name_only');
    assert.ok(report.markdown.includes('일부 통과 (이름만 맞음)'), 'the judgment row says what it rests on');
    forge(run, list => list.pop());
    forge(run, list => list.push({ ...made, measurement: { identity_basis: 'name_and_fact' } }));
    assert.throws(() => buildReport(run.scenario.packet), /its identity basis is not the one its state records/);
    forge(run, list => list.pop());
    const { measurement, ...bare } = made;
    assert.ok(measurement);
    forge(run, list => list.push(bare));
    assert.throws(() => buildReport(run.scenario.packet), /its identity basis is not the one its state records/);
  } finally { await run.site.close(); }
});

test('the queued text is taken from the item of the same evidence that offered the span (N7)', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-text', ['/']);
  try {
    const made = await run.judge(run.units[0]);
    await forgeQueue(run, queue => {
      const item = queue.items.find(x => x.unit_key === made.unit_key);
      queue.items.push({ ...structuredClone(item), evidence_ref: 'elsewhere', spans: item.spans.map(span => ({ ...span })) });
      item.spans.find(span => span.start === made.evidence_span[0].start).text = '다른 글을 읽었다고 속인 문장';
    });
    forge(run, list => list.push(made));
    assert.throws(() => buildReport(run.scenario.packet), /queued text of span .* differs from the text of the page/);
  } finally { await run.site.close(); }
});

test('replay derives the same split of a long run, and refuses a range that spans two of its parts (N3)', { timeout: 120000 }, async () => {
  const long = `<p>${'이 문단은 문장 하나가 마침표로 끝나며 한 쪽에 아주 길게 이어진다. '.repeat(100)}</p>`;
  const run = await modelRun('judge-long', ['/'], { bodyOf: () => long });
  try {
    const item = run.queue.items.find(x => x.unit_key === run.units[0]);
    const parts = item.spans.filter(span => span.text.startsWith('이 문단은'));
    assert.ok(parts.length >= 3 && parts.every(span => Buffer.byteLength(span.text) <= MAX_SPAN), 'the long run is several spans within the cap');
    const made = await run.judge(run.units[0], [0, 1]);
    forge(run, list => list.push(made));
    buildReport(run.scenario.packet);
    forge(run, list => list.pop());
    const [a, b] = parts;
    const spanning = { evidence_sha256: a.evidence_sha256, start: a.start, end: b.end };
    forge(run, list => list.push({ ...made, evidence_span: [spanning] }));
    assert.throws(() => buildReport(run.scenario.packet), /is not a text run of the page/);
  } finally { await run.site.close(); }
});

const SITE_BODY = route => `<p>페이지 ${route} 에만 있는 고유한 문장이며 다른 쪽과 바이트가 달라지도록 쓴 글입니다</p>`;

test('report replay counts the units a model declared not applicable, apart from the rest (F7)', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-na');
  try {
    const [first] = run.queue.items.filter(x => x.unit_key === run.units[0]);
    const merged = await run.merge([{ family_id: 'claim-support', unit_key: run.units[0], state: 'not_applicable', condition: 'no_material_claims',
      reason: '수치나 효과를 말하는 문장이 없다', span_ids: [first.spans[0].span_id] }]);
    const made = merged.find(x => x.unit_key === run.units[0]);
    forge(run, list => list.push(made));
    const report = buildReport(run.scenario.packet);
    assert.deepEqual(report.json.composed.conditions.model_not_applicable, { 'claim-support': 1 });
    assert.deepEqual(report.json.model_judgments.map(x => x.state), ['not_applicable']);
    assert.ok(report.markdown.includes('모델이 해당 없음으로 판정한 단위: 1건 (claim-support 1건)'));
    assert.ok(report.json.composed.conditions.lines.some(x => x.label === '모델이 해당 없음으로 판정한 단위' && x.value === '1건 (claim-support 1건)'), 'the conditions list both formats print');
    assert.equal(compileUnits(run.scenario.packet.baseline.input, 'SEO').some(x => x.key === run.units[0]), false, 'the unit leaves the denominator');
  } finally { await run.site.close(); }
});

test('a forged model not_applicable fails replay: the condition, the decision evidence or the span (F7)', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-na-forged');
  try {
    const [first] = run.queue.items.filter(x => x.unit_key === run.units[0]);
    const made = (await run.merge([{ family_id: 'claim-support', unit_key: run.units[0], state: 'not_applicable', condition: 'no_material_claims',
      reason: '수치나 효과를 말하는 문장이 없다', span_ids: [first.spans[0].span_id] }])).find(x => x.unit_key === run.units[0]);
    const decision = made.applicability_decision;
    const list = run.scenario.packet.baseline.input.observations;
    assert.throws(() => forge(run, observations => observations.push({ ...made, applicability_decision: { ...decision, condition: 'no_matching_questions' } })), /condition not allowed/, 'another family\'s condition');
    list.pop();
    forge(run, observations => observations.push({ ...made, applicability_decision: { ...decision, evidence_ref: 'context.json' } }));
    assert.throws(() => buildReport(run.scenario.packet), /N\/A decision does not cite the verdict's evidence/);
    forge(run, observations => observations.pop());
    forge(run, observations => observations.push({ ...made, evaluator_type: 'external_model', source_ref: 'custom:reviewer' }));
    assert.throws(() => buildReport(run.scenario.packet), /judged by a model through the judge queue|evidence.source link missing/, 'the model pair only');
    forge(run, observations => observations.pop());
    await forgeQueue(run, queue => { queue.items.find(x => x.unit_key === made.unit_key).spans.shift(); });
    forge(run, observations => observations.push(made));
    assert.throws(() => buildReport(run.scenario.packet), /is not a candidate of the stored judge queue/, 'a span the queue never offered');
  } finally { await run.site.close(); }
});

test('report replay recomputes the question coverage from the answers and refuses any other figure (F2)', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-questions', ['/', '/b'], { enable: ['answer-clarity', 'question-coverage'], questions: PANEL, withContext: true });
  try {
    const clarity = route => unitKey('answer-clarity', `${run.site.origin}${route}`);
    const span = unit_key => [run.queue.items.find(x => x.unit_key === unit_key).spans[0].span_id];
    const merged = await run.merge(['/', '/b'].map(route => answerPass(clarity(route), 'q1', { span_ids: span(clarity(route)) })));
    const withCoverage = deriveQuestionCoverage({ observations: merged, panel: PANEL, evidence_ref: run.scenario.context.evidence_ref });
    const derived = withCoverage.find(x => x.unit_key === QUESTION_UNIT);
    assert.deepEqual(derived.partial_basis, { kind: 'ratio', numerator: 1, denominator: 2 }, 'two pages answer one question: counted once');
    const put = list => forge(run, observations => observations.splice(0, observations.length, ...list));
    put(withCoverage);
    const report = buildReport(run.scenario.packet);
    assert.equal(report.json.model_judgments.length, 2, 'the derived verdict is code\'s, not a model judgment row');
    assert.deepEqual(report.json.composed.conditions.question_coverage.map(x => [x.question_id, x.pages.length]), [['q1', 2], ['q2', 0]]);
    const section = report.markdown.slice(report.markdown.indexOf('## 모델 판단'));
    assert.ok(section.includes('| 운영 시간은 언제인가? |') && section.includes('| 비용은 얼마인가? | 없음 |'), 'the model-judgment section lists each question with the pages that answer it');
    assert.ok(run.scenario.packet.baseline.input.observations.some(x => x.unit_key === QUESTION_UNIT));
    const swapped = change => put(withCoverage.map(x => x.unit_key === QUESTION_UNIT ? { ...x, ...change } : x));
    const follows = /does not follow from the answer-clarity judgments/;
    swapped({ state: 'pass', q: 1, partial_basis: null });
    assert.throws(() => buildReport(run.scenario.packet), follows, 'a figure that is not the count');
    swapped({ measurement: { ...derived.measurement, list: derived.measurement.list.map(x => ({ ...x, answered_by: [] })) } });
    assert.throws(() => buildReport(run.scenario.packet), follows, 'a list that is not the answers');
    swapped({ evidence_ref: 'intake.json' });
    assert.throws(() => buildReport(run.scenario.packet), follows, 'evidence other than the context');
    put(withCoverage.filter(x => x.family_id !== 'answer-clarity'));
    assert.throws(() => buildReport(run.scenario.packet), follows, 'a figure with no answers behind it');
    put(withCoverage.map(({ evidence_span, ...x }) => x.unit_key === clarity('/') ? { ...x, evaluator_type: 'code', source_ref: 'optbrew:judgment-derived' } : { ...x, ...(evidence_span ? { evidence_span } : {}) }));
    assert.throws(() => buildReport(run.scenario.packet), /does not follow from the answer-clarity judgments|is judged by a model through the judge queue/, 'the derived source on any other unit');
    put(withCoverage);
    buildReport(run.scenario.packet);
  } finally { await run.site.close(); }
});

test('replay refuses an answer-clarity verdict whose question is not on the panel, and a queue that shows other text than the page has (R79, R78)', { timeout: 120000 }, async () => {
  const inline = '<p>이 문장 안에는 <a href="/x">링크</a>와 <code>코드</code>가 들어 있어서 한 문장으로 읽혀야 하며 태그는 보이지 않는다</p>';
  const run = await modelRun('judge-inline', ['/'], { enable: ['answer-clarity', 'question-coverage'], questions: PANEL, bodyOf: () => inline, withContext: true });
  try {
    const unit_key = unitKey('answer-clarity', `${run.site.origin}/`);
    const item = run.queue.items.find(x => x.unit_key === unit_key);
    const sentence = item.spans.find(span => span.text.includes('링크와 코드가'));
    assert.equal(sentence.text, '이 문장 안에는 링크와 코드가 들어 있어서 한 문장으로 읽혀야 하며 태그는 보이지 않는다');
    const made = (await run.merge([answerPass(unit_key, 'q1', { span_ids: [sentence.span_id] })])).find(x => x.unit_key === unit_key);
    forge(run, list => list.push(made));
    buildReport(run.scenario.packet);
    forge(run, list => list.pop());
    forge(run, list => list.push({ ...made, measurement: { question_id: 'q9' } }));
    assert.throws(() => buildReport(run.scenario.packet), /names a question of the fixed panel/);
    forge(run, list => list.pop());
    const { measurement, ...bare } = made;
    assert.ok(measurement);
    forge(run, list => list.push(bare));
    assert.throws(() => buildReport(run.scenario.packet), /names a question of the fixed panel/);
    forge(run, list => list.pop());
    await forgeQueue(run, queue => { queue.items.find(x => x.unit_key === unit_key).spans.find(span => span.span_id === sentence.span_id).text = '다른 글을 읽었다고 속인 문장'; });
    forge(run, list => list.push(made));
    assert.throws(() => buildReport(run.scenario.packet), /queued text of span .* differs from the text of the page/);
  } finally { await run.site.close(); }
});

test('report replay accepts the model\'s identity verdict only on the home page and only where code gave none (F3)', { timeout: 120000 }, async () => {
  const run = await modelRun('judge-entity', ['/b', '/'], { enable: ['entity-identity'], bodyOf: SITE_BODY, withContext: true });
  try {
    const item = run.queue.items.find(x => x.unit_key === ENTITY_UNIT);
    assert.equal(item.url, `${run.site.origin}/`, 'the root page, though it is not the first');
    const made = (await run.merge([{ family_id: 'entity-identity', unit_key: ENTITY_UNIT, state: 'pass', reason: '홈 글이 사이트 이름을 말한다', span_ids: [item.spans[0].span_id] }]))
      .find(x => x.unit_key === ENTITY_UNIT);
    forge(run, list => list.push(made));
    const report = buildReport(run.scenario.packet);
    assert.deepEqual(report.json.model_judgments.map(x => [x.family_id, x.unit_key, x.state]), [['entity-identity', ENTITY_UNIT, 'pass']]);
    const other = run.scenario.audit.artifacts.find(x => x.normalized_url === `${run.site.origin}/b`);
    const bytes = readFileSync(other.evidence_ref);
    const [otherSpan] = candidateSpans(bytes, other.content_hash);
    forge(run, list => list.pop());
    forge(run, list => list.push({ ...made, evidence_ref: other.evidence_ref, evidence_span: [{ evidence_sha256: other.content_hash, start: otherSpan.start, end: otherSpan.end }] }));
    assert.throws(() => buildReport(run.scenario.packet), /not the audit raw entry of the unit page/, 'a page that is not the home page');
  } finally { await run.site.close(); }
});

test('report replay refuses a model identity verdict beside a code verdict of the unit (F3)', { timeout: 120000 }, async () => {
  const ld = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"옵트브루","sameAs":["https://example.org/x"]}</script>';
  const run = await modelRun('judge-entity-code', ['/'], { enable: ['entity-identity'], bodyOf: () => ld, withContext: true });
  try {
    const code = run.observations.find(x => x.unit_key === ENTITY_UNIT);
    assert.equal(code?.evaluator_type, 'code', 'code judges the unit: the home page has an Organization');
    assert.equal(run.queue.items.some(x => x.unit_key === ENTITY_UNIT), false, 'so the queue does not offer it');
    const store = openStore(run.scenario.evidence(''));
    const forcedQueue = await buildJudgeQueue({ observations: run.observations.filter(x => x.unit_key !== ENTITY_UNIT), store, context: run.scenario.context });
    await run.scenario.add(await queueRefOf(store), 'judge-queue');
    await run.scenario.rewrite(run.scenario.evidence('evidence-index.json'), index => index);
    const item = forcedQueue.items.find(x => x.unit_key === ENTITY_UNIT);
    const made = (await mergeJudgments({ observations: run.observations.filter(x => x.unit_key !== ENTITY_UNIT), store,
      judgments: [{ family_id: 'entity-identity', unit_key: ENTITY_UNIT, state: 'fail', reason: '이름이 다르다', span_ids: [item.spans[0].span_id] }] })).find(x => x.unit_key === ENTITY_UNIT);
    forge(run, list => list.splice(0, list.length, ...list.filter(x => x.unit_key !== ENTITY_UNIT), made));
    assert.throws(() => buildReport(run.scenario.packet), /has a collector verdict; a model verdict cannot stand beside it/);
  } finally { await run.site.close(); }
});

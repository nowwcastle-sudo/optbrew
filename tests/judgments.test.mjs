import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildJudgeQueue, checkSpan, mergeJudgments } from '../skills/optbrew/scripts/core/judgments.mjs';
import { blocks } from '../skills/optbrew/scripts/core/checks/index.mjs';
import { makeObservation, unitKey } from '../skills/optbrew/scripts/core/checks/observation.mjs';
import { openStore } from '../skills/optbrew/scripts/core/evidence-store.mjs';
import { validateEntity } from '../skills/optbrew/scripts/core/contracts.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { tempDir } from './support/temp-dir.mjs';

const URL_A = 'https://example.com/guide';
const PARAGRAPH = '옵트브루는 홈페이지의 검색 노출 상태를 점검하고 근거와 함께 보고서를 만든다.';
const HTML = `<!doctype html><html><head><title>옵트브루 소개</title><script>var 가 = "이 스크립트는 보이지 않는 글자입니다 보이지 않는 글자입니다";</script></head>` +
  `<body><h1>검색 점검 도구</h1><p>${PARAGRAPH}</p><!-- 주석은 보이지 않는 글자입니다 보이지 않는 글자입니다 --><p>짧음</p></body></html>`;

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

test('buildJudgeQueue offers visible text runs for each model-judged family and page', async () => {
  const { store, observations, sha256 } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  assert.deepEqual(queue.items.map(item => item.family_id).sort(),
    ['answer-clarity', 'claim-support', 'freshness-truth', 'original-value', 'source-transparency']);
  const item = queuedItem(queue, 'claim-support');
  assert.equal(item.unit_key, unit('claim-support'));
  assert.equal(item.evidence_sha256, sha256);
  assert.deepEqual(item.spans.map(span => span.text), [PARAGRAPH]);
  assert.equal(JSON.stringify(queue).includes('스크립트'), false, 'script text is not offered');
  assert.equal(JSON.stringify(queue).includes('주석'), false, 'comment text is not offered');
});

test('spans are UTF-8 byte ranges over Hangul text', async () => {
  const { store, observations, bytes, sha256 } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [span] = queuedItem(queue, 'claim-support').spans;
  assert.deepEqual(Object.keys(span), ['span_id', 'evidence_sha256', 'start', 'end', 'text']);
  assert.equal(span.start, bytes.indexOf(Buffer.from(PARAGRAPH)));
  assert.equal(span.end - span.start, Buffer.byteLength(PARAGRAPH));
  assert.notEqual(span.end - span.start, PARAGRAPH.length);
  assert.notEqual(HTML.indexOf(PARAGRAPH), span.start, 'byte offset and code-unit offset differ');
  assert.equal(bytes.subarray(span.start, span.end).toString('utf8'), span.text);
  const merged = await mergeJudgments({ observations, queue, store,
    judgments: [{ family_id: 'claim-support', unit_key: unit('claim-support'), state: 'pass', q: 1, reason: '주장이 본문에 있다', span_ids: [span.span_id] }] });
  const made = merged.find(x => x.family_id === 'claim-support');
  assert.deepEqual(made.evidence_span, { evidence_sha256: sha256, start: span.start, end: span.end });
  assert.equal(made.evaluator_type, 'host_model');
  assert.equal(made.q, 1);
  assert.equal(merged.length, observations.length + 1);
  checkSpan(bytes, made.evidence_span);
});

test('a span cannot start or end inside a multi-byte character', async () => {
  const { store, observations, bytes } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [span] = queuedItem(queue, 'claim-support').spans;
  assert.throws(() => checkSpan(bytes, { start: span.start + 1, end: span.end }), /multi-byte/);
  assert.throws(() => checkSpan(bytes, { start: span.start, end: span.end - 2 }), /multi-byte/);
  assert.throws(() => checkSpan(bytes, { start: span.start, end: bytes.length + 1 }), /inside the evidence/);
  assert.throws(() => checkSpan(bytes, { start: span.end, end: span.end }), /inside the evidence/);
  const forged = structuredClone(queue);
  queuedItem(forged, 'claim-support').spans[0].start = span.start + 1;
  await assert.rejects(mergeJudgments({ observations, queue: forged, store,
    judgments: [{ family_id: 'claim-support', unit_key: unit('claim-support'), state: 'pass', q: 1, reason: 'x', span_ids: [span.span_id] }] }), /multi-byte/);
});

test('a judgment cannot overwrite a code-judged family', async () => {
  const { store, observations } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const [span] = queuedItem(queue, 'claim-support').spans;
  for (const { family_id } of blocks) {
    await assert.rejects(mergeJudgments({ observations, queue, store,
      judgments: [{ family_id, unit_key: unitKey(family_id, URL_A), state: 'pass', q: 1, reason: 'x', span_ids: [span.span_id] }] }), /judged by code/, family_id);
  }
  assert.equal(queue.items.some(item => blocks.some(block => block.family_id === item.family_id)), false);
});

test('an unknown span_id is rejected', async () => {
  const { store, observations } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const judgment = { family_id: 'claim-support', unit_key: unit('claim-support'), state: 'pass', q: 1, reason: 'x' };
  await assert.rejects(mergeJudgments({ observations, queue, store, judgments: [{ ...judgment, span_ids: ['0-9'] }] }), /unknown span_id 0-9/);
  await assert.rejects(mergeJudgments({ observations, queue, store, judgments: [{ ...judgment, span_ids: [] }] }), /needs span_ids/);
  await assert.rejects(mergeJudgments({ observations, queue, store, judgments: [{ ...judgment, unit_key: unitKey('claim-support', 'https://other.example/') , span_ids: ['0-9'] }] }), /no queued unit/);
});

test('unknown state needs no span', async () => {
  const { store, observations, ref } = await fixtureStore();
  const queue = await buildJudgeQueue({ observations, store });
  const merged = await mergeJudgments({ observations, queue, store,
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
  const merged = await mergeJudgments({ observations, queue, store,
    judgments: [{ family_id: 'original-value', unit_key: unit('original-value'), state: 'partial', q: 0.5, reason: '설명은 있으나 독자 자료가 없다', span_ids: [span.span_id] }] });
  assert.equal(merged.filter(x => x.unit_key === unit('original-value')).length, 1);
  assert.deepEqual(merged.find(x => x.unit_key === unit('original-value')).partial_basis, { kind: 'threshold_half' });
  const stale = { family_id: 'claim-support', unit_key: unit('claim-support'), state: 'pass', q: 1, reason: 'x', span_ids: [span.span_id] };
  const other = structuredClone(queue);
  other.items.push({ ...queue.items[0], family_id: 'claim-support', unit_key: unit('claim-support') });
  await assert.rejects(mergeJudgments({ observations, queue: other, store, judgments: [stale] }), /already has a verdict/);
});

test('a secret in a text run never enters the queue, and a secret in a reason is refused', async () => {
  const key = `AKIA${'ABCDEFGHIJKLMNOP'}`;
  const html = `<body><p>${PARAGRAPH}</p><p>이 문단에는 비밀 값 ${key} 이(가) 들어 있어서 목록에서 빠져야 한다.</p></body>`;
  const { store, observations } = await fixtureStore(html);
  const queue = await buildJudgeQueue({ observations, store });
  assert.equal(JSON.stringify(queue).includes(key), false);
  const [span] = queuedItem(queue, 'claim-support').spans;
  assert.equal(queuedItem(queue, 'claim-support').spans.length, 1);
  await assert.rejects(mergeJudgments({ observations, queue, store,
    judgments: [{ family_id: 'claim-support', unit_key: unit('claim-support'), state: 'pass', q: 1, reason: key, span_ids: [span.span_id] }] }), /secret/);
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
  assert.throws(() => validateEntity('ChangeRecord', { ...record, analysis: { tools: [] , queries: [] } }), /self_analysis: required/);
});

test('a host-model verdict needs an evidence span unless it is unknown', () => {
  const base = { schema_version: '1.0.0', observation_id: 'o', check_id: 'claim-support', family_id: 'claim-support', unit_key: 'claim-support|u',
    state: 'pass', q: 1, partial_basis: null, reason: 'x', evaluator_type: 'host_model', source_ref: 's', evidence_ref: 'e' };
  assert.throws(() => validateEntity('CheckObservation', base), /evidence_span: required/);
  validateEntity('CheckObservation', { ...base, evidence_span: { evidence_sha256: 'h', start: 0, end: 3 } });
  validateEntity('CheckObservation', { ...base, state: 'unknown', q: null });
  validateEntity('CheckObservation', { ...base, evaluator_type: 'code' });
  assert.throws(() => validateEntity('CheckObservation', { ...base, evidence_span: { evidence_sha256: 'h', start: -1, end: 3 } }), /start/);
});

function reportRun(dir) {
  const packet = JSON.parse(readFileSync(new URL('./fixtures/reports/remote-only.json', import.meta.url)));
  packet.evidence_root = dir;
  for (const item of packet.evidence_index) copyFileSync(path.resolve('tests/fixtures/reports', item.ref), path.join(dir, item.ref));
  const html = `<html><body><p>${PARAGRAPH}</p></body></html>\n`;
  writeFileSync(path.join(dir, 'ko.html'), html);
  const sha256 = createHash('sha256').update(html).digest('hex');
  packet.evidence_index.push({ ref: 'ko.html', sha256, kind: 'raw_html', run_id: 'synthetic-report', source_ref: 'synthetic' });
  const start = Buffer.from(html).indexOf(Buffer.from(PARAGRAPH));
  // The fixture plans only code-judged families, so one of its observations stands in for a model verdict.
  const observation = packet.baseline.input.observations.find(x => x.family_id === 'fetch-response');
  Object.assign(observation, { reason: '근거 문장이 본문에 있다', evaluator_type: 'host_model', source_ref: 'optbrew:model-judgment', evidence_ref: 'ko.html',
    evidence_span: { evidence_sha256: sha256, start, end: start + Buffer.byteLength(PARAGRAPH) } });
  packet.baseline.scores = score(packet.baseline.input);
  return { packet, observation, start };
}

test('report marks model judgments', async () => {
  const dir = await tempDir('optbrew-judge-report-');
  const { packet, observation } = reportRun(dir);
  const report = buildReport(packet);
  assert.deepEqual(report.json.model_judgments, [{ phase: 'baseline', family_id: 'fetch-response', unit_key: observation.unit_key, state: 'pass',
    evidence_ref: 'ko.html', evidence_span: observation.evidence_span, label: '근거 확인됨, 판정은 모델' }]);
  assert.ok(report.markdown.includes('## Model judgments'));
  assert.ok(report.markdown.includes('근거 확인됨, 판정은 모델'));
  assert.ok(report.markdown.includes(`bytes ${observation.evidence_span.start}–${observation.evidence_span.end}`));
});

test('a tampered model-judgment span fails report replay', async () => {
  const cases = [
    ['past the end of the evidence', span => { span.end += 1000; }, /inside the evidence/],
    ['inside a multi-byte character', span => { span.start += 1; }, /multi-byte/],
    ['another evidence hash', span => { span.evidence_sha256 = '0'.repeat(64); }, /not bound to stored evidence/],
  ];
  for (const [name, tamper, expected] of cases) {
    const dir = await tempDir('optbrew-judge-tamper-');
    const { packet, observation } = reportRun(dir);
    tamper(observation.evidence_span);
    packet.baseline.scores = score(packet.baseline.input);
    assert.throws(() => buildReport(packet), expected, name);
  }
  const dir = await tempDir('optbrew-judge-bytes-');
  const { packet, start } = reportRun(dir);
  writeFileSync(path.join(dir, 'ko.html'), `<html><body><p>${PARAGRAPH}</p> </body></html>\n`);
  assert.throws(() => buildReport(packet), /hash mismatch/, `bytes changed under start ${start}`);
});

test('a host-model verdict without a span is refused when the report is built', async () => {
  const dir = await tempDir('optbrew-judge-nospan-');
  const { packet, observation } = reportRun(dir);
  delete observation.evidence_span;
  assert.throws(() => buildReport(packet), /evidence_span: required/);
});

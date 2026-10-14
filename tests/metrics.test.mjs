import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeImport, completeWindows } from '../skills/optbrew/scripts/adapters/imports.mjs';
import { measurePanel } from '../skills/optbrew/scripts/core/metrics.mjs';
import { clusterBootstrap } from '../skills/optbrew/scripts/core/bootstrap.mjs';
import { readFileSync } from 'node:fs';

const meta = { property: 'https://example.com/', hostname: 'example.com', search_type: 'web',
  device: 'mobile', country: 'KR', timezone: 'Asia/Seoul', aggregation: 'property',
  window: { start: '2026-09-16', end: '2026-10-13', timezone: 'Asia/Seoul' },
  collected_at: '2026-10-14T10:00:00+09:00', source_ref: 'owner-export', evidence_ref: 'fixture/export',
  sample_selection: { kind: 'all' }, provider_definition: 'owner export native field' };

test('provider imports preserve native definition, filters, period and zero mask', () => {
  const exportFixture = JSON.parse(readFileSync(new URL('./fixtures/metrics/google-ai-export.json', import.meta.url)));
  const [exportedMissing, exportedZero] = normalizeImport(exportFixture.provider, exportFixture.rows, exportFixture.metadata);
  assert.equal(exportedMissing.value_state, 'zero_or_missing');
  assert.equal(exportedZero.value_state, 'measured');
  assert.equal(exportedZero.value, 0);
  for (const provider of ['gsc', 'ga4', 'google_ai', 'bing_ai', 'naver', 'se_ranking']) {
    const [item] = normalizeImport(provider, [{ metric_id: 'native_count', value: 7,
      provider_definition: `${provider} native count` }], meta);
    assert.equal(item.value_state, 'measured');
    assert.equal(item.provider_definition, `${provider} native count`);
    assert.equal(item.filters.property, meta.property);
    assert.equal(item.filters.hostname, meta.hostname);
    assert.equal(item.filters.search_type, meta.search_type);
    assert.equal(item.filters.aggregation, meta.aggregation);
    assert.deepEqual(item.window, meta.window);
    assert.equal(item.filters.collected_at, meta.collected_at);
  }
  const [uncertain] = normalizeImport('google_ai', [{ metric_id: 'impressions', value: 0 }], meta);
  assert.equal(uncertain.value_state, 'zero_or_missing');
  assert.equal(uncertain.value, null);
  const [masked] = normalizeImport('google_ai', [{ metric_id: 'impressions', value: 0, missing_mask: false }], meta);
  assert.equal(masked.value_state, 'measured');
  assert.equal(masked.value, 0);
  const [tilde] = normalizeImport('google_ai', [{ metric_id: 'impressions', value: 0, display_state: '~' }], meta);
  assert.equal(tilde.value_state, 'zero_or_missing');
  assert.equal(normalizeImport('google_ai', [{ metric_id: 'impressions', value: '~' }], meta)[0].value_state, 'zero_or_missing');
  assert.equal(normalizeImport('google_ai', [{ metric_id: 'impressions', value: 7, missing_mask: true }], meta)[0].value_state, 'zero_or_missing');
  const sparse = { ...meta };
  delete sparse.device;
  assert.equal(normalizeImport('naver', [{ metric_id: 'native_count', value: 1 }], sparse)[0].filters.device, 'unknown');
});

test('panel denominator follows 24 valid of 30 planned and six target citations', () => {
  const responses = panel.questions.flatMap(q => Array.from({ length: 3 }, (_, repeat) => {
    const number = Number(q.id.slice(1)) * 3 + repeat;
    return { response_id: `r${number}`, question_id: q.id, repeat, valid: number < 24,
      cited_urls: number < 6 ? ['https://example.com/source'] : [],
      target_mentioned: number < 6, brand_mentions: number < 6 ? ['Example'] : [] };
  }));
  const metrics = Object.fromEntries(measurePanel(panel, responses, []).map(x => [x.metric_id, x]));
  assert.equal(metrics.target_citation_response_rate.value, 0.25);
  assert.equal(metrics.target_citation_response_rate.numerator, 6);
  assert.equal(metrics.target_citation_response_rate.denominator, 24);
  assert.equal(metrics.observation_completion_rate.value, 0.8);
  assert.equal(metrics.observation_completion_rate.denominator, 30);
});

test('citation support needs accessible source and facts need an approved list', () => {
  const response = { response_id: 'r1', question_id: 'q0', repeat: 0, valid: true,
    cited_urls: ['https://example.com/'], target_mentioned: true, brand_mentions: ['Example'] };
  const evaluation = { response_id: 'r1', citations: [{ evaluable: true, source_accessible: false, supported: true }],
    claims: [{ evaluable: true, matches: true }] };
  const unknown = Object.fromEntries(measurePanel(panel, [response], [evaluation]).map(x => [x.metric_id, x]));
  assert.equal(unknown.citation_support_rate.value_state, 'unknown');
  assert.equal(unknown.fact_consistency_rate.value_state, 'unknown');
  const known = Object.fromEntries(measurePanel({ ...panel, fact_list_ref: 'approved/facts' }, [response],
    [{ ...evaluation, citations: [{ evaluable: true, source_accessible: true, supported: true }] }]).map(x => [x.metric_id, x]));
  assert.equal(known.citation_support_rate.value, 1);
  assert.equal(known.fact_consistency_rate.value, 1);
});

test('positive-only exports cannot claim an all-question citation rate', () => {
  const positive = { ...meta, sample_selection: { kind: 'positive_only' } };
  assert.throws(() => normalizeImport('se_ranking', [{ metric_id: 'citation_response_rate', value: 1,
    numerator: 3, denominator: 3 }], positive));
  const [item] = normalizeImport('se_ranking', [{ metric_id: 'observed_mentions', value: 3 }], positive);
  assert.equal(item.sample_selection.kind, 'positive_only');
});

test('missing provider data cannot be relabelled not applicable without an exclusion', () => {
  assert.throws(() => normalizeImport('gsc', [{ metric_id: 'native_count', value_state: 'not_applicable', value: null }], meta));
  const [excluded] = normalizeImport('gsc', [{ metric_id: 'native_count', value_state: 'not_applicable', value: null,
    not_applicable_reason: 'field is outside this property export' }], meta);
  assert.equal(excluded.value_state, 'not_applicable');
  assert.equal(excluded.sample_selection.exclusion_reason, 'field is outside this property export');
});

test('28-day windows use a supplied complete local date and remain adjacent', () => {
  assert.deepEqual(completeWindows('2026-10-13', 'Asia/Seoul'), {
    before: { start: '2026-08-19', end: '2026-09-15', timezone: 'Asia/Seoul' },
    after: { start: '2026-09-16', end: '2026-10-13', timezone: 'Asia/Seoul' } });
  assert.throws(() => completeWindows('2026-02-30', 'Asia/Seoul'));
});

const panel = { panel_hash: 'protocol-hash-from-freezeProtocol', questions: Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, category: i % 2 ? 'non_brand' : 'brand' })),
  repeats: 3, engine: 'claude', surface: 'claude_api', model: 'test-model', search_enabled: false,
  locale: 'ko-KR', region: 'KR', target_entity: 'Example', target_domains: ['example.com'],
  competitor_entities: ['Other'], window: { start: '2026-10-13', end: '2026-10-13', timezone: 'Asia/Seoul' },
  source_ref: 'synthetic-panel', evidence_ref: 'fixture/panel' };

test('AI panel counts valid responses and keeps support and facts unknown without evidence', () => {
  const responses = panel.questions.flatMap(q => Array.from({ length: 3 }, (_, repeat) => ({
    response_id: `${q.id}-${repeat}`, question_id: q.id, repeat, valid: !(q.id === 'q0' || q.id === 'q1') || repeat !== 0,
    cited_urls: ['https://example.com/source'], target_mentioned: true, brand_mentions: ['Example'] })));
  const observed = measurePanel(panel, responses, []);
  const byId = Object.fromEntries(observed.map(x => [x.metric_id, x]));
  assert.equal(byId.observation_completion_rate.numerator, 28);
  assert.equal(byId.observation_completion_rate.denominator, 30);
  assert.equal(byId.target_citation_response_rate.denominator, 28);
  assert.equal(byId.target_citation_response_rate.value, 1);
  assert.equal(byId.citation_support_rate.value_state, 'unknown');
  assert.equal(byId.fact_consistency_rate.value_state, 'unknown');
  assert.equal(byId.target_entity_mention_rate.value, 1);
  assert.equal(byId.observed_brand_share.value, 1);
  assert.equal(byId.target_citation_response_rate.filters.surface, 'claude_api');
  assert.equal(byId.target_citation_response_rate.filters.search_enabled, false);
});

test('panel rejects duplicate planned responses and keeps fewer than 10 questions exploratory', () => {
  const short = { ...panel, questions: panel.questions.slice(0, 1) };
  const responses = [{ response_id: 'r1', question_id: 'q0', repeat: 0, valid: true, cited_urls: [],
    target_mentioned: false, brand_mentions: [] }];
  assert.equal(measurePanel(short, responses, [])[0].sample_selection.inference, 'exploratory');
  assert.throws(() => measurePanel(short, [...responses, { ...responses[0], response_id: 'r2' }], []));
  assert.throws(() => measurePanel(short, [{ ...responses[0], cited_urls: ['not a URL'] }], []));
});

test('question-cluster bootstrap is reproducible and constant data has a point interval', () => {
  const input = { questionIds: ['q1', 'q2', 'q3'], valuesByQuestion: { q1: [1, 1], q2: [0, 0], q3: [0, 1] }, seed: 91 };
  assert.deepEqual(clusterBootstrap(input), clusterBootstrap(input));
  assert.deepEqual(clusterBootstrap({ ...input, valuesByQuestion: { q1: [0.25], q2: [0.25], q3: [0.25] } }).interval, [0.25, 0.25]);
  assert.equal(clusterBootstrap(input).unique_questions, 3);
  assert.equal(clusterBootstrap(input).iterations, 2000);
});

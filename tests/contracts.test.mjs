import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEntity, ContractError } from '../skills/optbrew/scripts/core/contracts.mjs';
import { freezeProtocol } from '../skills/optbrew/scripts/core/protocol.mjs';

const context = () => ({
  schema_version: '1.0.0', run_id: 'run-a', target: 'example.com', environment: 'local',
  goals: ['SEO'], allowed_changes: [], scope: {}, evaluation_version: '0.1.0',
  protocol_version: '0.1.0', data_sources: [], cost_decision: {}, evidence_ref: 'evidence/context.json',
  protocol: {
    page_types: [{ id: 'primary', urls: [{ original: 'https://example.com/', normalized: 'https://example.com/' }] }],
    engines: ['google'], families: [{ family_id: 'fetch-response', applicable: true }],
    locale: 'ko-KR', region: 'KR', browser: 'Chrome', device: 'mobile',
    question_panel: [], surfaces: [], models: [], search_enabled: null,
  },
});

test('RunContext and frozen protocol are deterministic across run identifiers', () => {
  const first = freezeProtocol(context());
  const changed = { ...context(), run_id: 'run-b', evidence_ref: 'other' };
  assert.deepEqual(first, freezeProtocol(changed));
  assert.equal(first.protocol_hash.length, 64);
  assert.equal(validateEntity('RunContext', context()).run_id, 'run-a');
});

test('auxiliary resources are fixed comparison inputs and cannot duplicate or escape scope', () => {
  const first = context();
  first.scope = { allowed: [{ origin: 'https://example.com', path_prefix: '/' }] };
  first.protocol.auxiliary_resources = [{ kind: 'robots', original: 'https://example.com/robots.txt', normalized: 'https://example.com/robots.txt' }];
  const second = structuredClone(first);
  assert.equal(freezeProtocol(first).protocol_hash, freezeProtocol(second).protocol_hash);
  second.protocol.auxiliary_resources[0].original = 'https://example.com/sitemap.xml';
  second.protocol.auxiliary_resources[0].normalized = 'https://example.com/sitemap.xml';
  assert.notEqual(freezeProtocol(first).protocol_hash, freezeProtocol(second).protocol_hash);
  second.protocol.auxiliary_resources[0].normalized = 'https://example.com/';
  assert.throws(() => freezeProtocol(second), /duplicate|selected/i);
  second.protocol.auxiliary_resources[0].normalized = 'https://example.com/off-path';
  second.scope.allowed[0].path_prefix = '/owned/';
  assert.throws(() => freezeProtocol(second), /scope|outside/i);
});

test('invalid q, ratio, duplicate URL and nonfinite JSON values are rejected', () => {
  const observation = { schema_version: '1.0.0', observation_id: 'o1', check_id: 'fetch-response',
    family_id: 'fetch-response', unit_key: 'fetch-response|google|https://example.com/',
    state: 'unknown', q: 0.7, partial_basis: null, reason: 'timeout',
    evaluator_type: 'code', source_ref: 'local', evidence_ref: 'e1' };
  assert.throws(() => validateEntity('CheckObservation', observation), ContractError);
  assert.throws(() => validateEntity('CheckObservation', { ...observation, state: 'fail', q: null }), ContractError);
  assert.throws(() => validateEntity('CheckObservation', { ...observation, state: 'partial', q: 0.3,
    partial_basis: { kind: 'ratio', numerator: 1, denominator: 3 } }), ContractError);
  assert.throws(() => validateEntity('ScoreInput', { schema_version: '1.0.0', run_context: context(),
    observations: [], extra: Infinity }), ContractError);
  const invalidContext = context();
  invalidContext.scope = new Date('2026-10-14T00:00:00Z');
  assert.throws(() => validateEntity('RunContext', invalidContext), ContractError);
  const duplicate = context();
  duplicate.protocol.page_types[0].urls.push(duplicate.protocol.page_types[0].urls[0]);
  assert.throws(() => freezeProtocol(duplicate), ContractError);
});

test('protocol hash treats fixed set ordering as immaterial', () => {
  const first = context();
  first.protocol.page_types[0].urls.push({ original: 'https://example.com/about', normalized: 'https://example.com/about' });
  first.protocol.engines.push('bing');
  const second = structuredClone(first);
  second.protocol.page_types[0].urls.reverse();
  second.protocol.engines.reverse();
  assert.equal(freezeProtocol(first).protocol_hash, freezeProtocol(second).protocol_hash);
  second.target = 'different.example';
  assert.notEqual(freezeProtocol(first).protocol_hash, freezeProtocol(second).protocol_hash);
  second.protocol.evidence_ref = 'ephemeral/path';
  assert.throws(() => freezeProtocol(second), ContractError);
});

test('question panel has fixed question identity and category', () => {
  const invalid = context();
  invalid.protocol.question_panel = [{ id: 'q1', question: 'Who?', category: 'unknown' }];
  assert.throws(() => freezeProtocol(invalid), ContractError);
  invalid.protocol.question_panel = [{ id: 'q1', question: 'Who?', category: 'brand' },
    { id: 'q1', question: 'Where?', category: 'non_brand' }];
  assert.throws(() => freezeProtocol(invalid), ContractError);
  const valid = context();
  valid.protocol.question_panel = [{ id: 'q1', question: 'Who?', category: 'brand' }];
  assert.equal(freezeProtocol(valid).protocol.question_panel.length, 1);
});

test('selected URLs cannot opt out of fetch or public index policy with bare flags', () => {
  for (const familyId of ['fetch-response', 'search-crawl-policy', 'index-policy']) {
    const changed = context();
    changed.protocol.families.push({ family_id: familyId, applicable: false });
    if (familyId === 'fetch-response') changed.protocol.families.shift();
    assert.throws(() => freezeProtocol(changed), ContractError, familyId);
  }
  const changed = context();
  changed.protocol.page_types[0].urls[0].public_indexing = false;
  assert.throws(() => freezeProtocol(changed), ContractError);
});

test('family-specific verdict modes reject partial core policy and invented ratios', () => {
  const base = { schema_version: '1.0.0', observation_id: 'policy', check_id: 'index-policy',
    family_id: 'index-policy', unit_key: 'index-policy|https://example.com/',
    state: 'partial', q: 0.5, partial_basis: { kind: 'threshold_half' },
    reason: 'confirmed noindex', evaluator_type: 'code', source_ref: 'synthetic', evidence_ref: 'e/policy' };
  for (const family_id of ['fetch-response', 'search-crawl-policy', 'index-policy', 'document-title'])
    assert.throws(() => validateEntity('CheckObservation', { ...base, family_id, check_id: family_id }), ContractError);
  assert.throws(() => validateEntity('CheckObservation', { ...base, family_id: 'question-coverage',
    check_id: 'question-coverage', unit_key: 'question-coverage|site' }), ContractError);
  assert.throws(() => validateEntity('CheckObservation', { ...base, state: 'partial', q: 1 / 2,
    partial_basis: { kind: 'ratio', numerator: 1, denominator: 2 } }), ContractError);
  assert.equal(validateEntity('CheckObservation', { ...base, family_id: 'answer-clarity',
    check_id: 'answer-clarity' }).state, 'partial');
});

test('condition codes affect protocol hash but evidence paths do not', () => {
  const first = context();
  first.protocol.families.push({ family_id: 'document-title', applicable: false,
    applicability_decision: { condition: 'not_html', reason: 'verified type', evidence_ref: 'e/one' } });
  const second = structuredClone(first);
  second.protocol.families[1].applicability_decision.reason = 'same condition from another run';
  second.protocol.families[1].applicability_decision.evidence_ref = 'e/two';
  assert.equal(freezeProtocol(first).protocol_hash, freezeProtocol(second).protocol_hash);
  const indexed = structuredClone(first);
  indexed.protocol.page_types[0].urls[0].public_indexing = false;
  indexed.protocol.page_types[0].urls[0].indexing_decision = {
    condition: 'not_public_index_target', reason: 'documented exclusion', evidence_ref: 'e/index' };
  assert.notEqual(freezeProtocol(first).protocol_hash, freezeProtocol(indexed).protocol_hash);
});

test('a family cannot silently omit selected URL units', () => {
  const changed = context();
  changed.protocol.page_types[0].urls.push({ original: 'https://example.com/about', normalized: 'https://example.com/about' });
  changed.protocol.families[0].urls = ['https://example.com/'];
  assert.throws(() => freezeProtocol(changed), ContractError);
});

test('a fixed question panel cannot be called absent to remove question coverage', () => {
  const changed = context();
  changed.protocol.question_panel = [{ id: 'q1', question: 'What?', category: 'brand' }];
  changed.protocol.families.push({ family_id: 'question-coverage', applicable: false,
    applicability_decision: { condition: 'no_fixed_questions', reason: 'claimed absent', evidence_ref: 'e/panel' } });
  assert.throws(() => freezeProtocol(changed), ContractError);
});

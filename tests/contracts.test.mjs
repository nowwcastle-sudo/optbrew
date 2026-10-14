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

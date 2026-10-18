import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEntity, ContractError } from '../skills/optbrew/scripts/core/contracts.mjs';
import { freezeProtocol } from '../skills/optbrew/scripts/core/protocol.mjs';
import { checkRegistry } from '../skills/optbrew/scripts/core/config.mjs';
import { environmentProbe } from './support/probe.mjs';

const context = () => ({
  schema_version: '2.0.0', run_id: 'run-a', target: 'example.com', environment: 'local',
  goals: ['SEO'], allowed_changes: [], scope: {}, evaluation_version: '0.4.0',
  protocol_version: '0.2.0', data_sources: [], cost_decision: {}, environment_probe: environmentProbe(), evidence_ref: 'evidence/context.json',
  protocol: {
    page_types: [{ id: 'primary', urls: [{ original: 'https://example.com/', normalized: 'https://example.com/' }] }],
    engines: ['google'], families: [{ family_id: 'fetch-response', applicable: true }],
    locale: 'ko-KR', region: 'KR', browser: 'Chrome', device: 'mobile',
    question_panel: [], surfaces: [], models: [], search_enabled: null, render: { enabled: false, pages: [], max_render_requests: 300 },
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

test('robots and sitemap documents cannot be scored page URLs', () => {
  for (const pathname of ['/robots.txt', '/sitemap.xml']) {
    const changed = context();
    changed.protocol.page_types[0].urls[0] = { original: `https://example.com${pathname}`, normalized: `https://example.com${pathname}` };
    assert.throws(() => freezeProtocol(changed), /auxiliary|policy|resource/i);
  }
});

test('invalid q, ratio, duplicate URL and nonfinite JSON values are rejected', () => {
  const observation = { schema_version: '2.0.0', observation_id: 'o1', check_id: 'fetch-response',
    family_id: 'fetch-response', unit_key: 'fetch-response|google|https://example.com/',
    state: 'unknown', q: 0.7, partial_basis: null, reason: 'timeout',
    evaluator_type: 'code', source_ref: 'local', evidence_ref: 'e1' };
  assert.throws(() => validateEntity('CheckObservation', observation), ContractError);
  assert.throws(() => validateEntity('CheckObservation', { ...observation, state: 'fail', q: null }), ContractError);
  assert.throws(() => validateEntity('CheckObservation', { ...observation, state: 'partial', q: 0.3,
    partial_basis: { kind: 'ratio', numerator: 1, denominator: 3 } }), ContractError);
  assert.throws(() => validateEntity('ScoreInput', { schema_version: '2.0.0', run_context: context(),
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
  const base = { schema_version: '2.0.0', observation_id: 'policy', check_id: 'index-policy',
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

test('the render plan is a fixed comparison input bounded by the selected pages and the render limits', () => {
  const [page] = context().protocol.page_types[0].urls;
  const about = { original: 'https://example.com/about', normalized: 'https://example.com/about' };
  const planned = (pages, extra = {}) => {
    const changed = context();
    changed.protocol.page_types[0].urls.push(about);
    changed.protocol.render = { enabled: true, pages, max_render_requests: 300, ...extra };
    return changed;
  };
  const baseline = freezeProtocol(context()).protocol_hash;
  const hash = freezeProtocol(planned([page, about])).protocol_hash;
  assert.notEqual(hash, freezeProtocol(planned([])).protocol_hash, 'the pages are part of the protocol');
  assert.equal(freezeProtocol(planned([about, page])).protocol_hash, hash, 'page order is immaterial');
  assert.notEqual(freezeProtocol(planned([page], { max_render_requests: 200 })).protocol_hash, freezeProtocol(planned([page])).protocol_hash);
  assert.notEqual(freezeProtocol(planned([], { enabled: false })).protocol_hash, freezeProtocol(planned([])).protocol_hash);
  assert.equal(baseline.length, 64);
  assert.throws(() => freezeProtocol(planned([{ original: 'https://example.com/other', normalized: 'https://example.com/other' }])), /not a selected URL/);
  assert.throws(() => freezeProtocol(planned([page, page])), /duplicate/);
  assert.throws(() => freezeProtocol(planned([page], { max_render_requests: 301 })), /above maximum/);
  assert.throws(() => freezeProtocol(planned([page], { max_render_requests: 2.5 })), /expected integer/);
  assert.throws(() => freezeProtocol(planned([page], { max_render_requests: 0 })), ContractError);
  const missing = context();
  delete missing.protocol.render;
  assert.throws(() => validateEntity('RunContext', missing), /render/);
  const extra = planned([page]);
  extra.protocol.render.timeout = 1;
  assert.throws(() => freezeProtocol(extra), /unexpected field/);
  const tooMany = context();
  tooMany.protocol.page_types[0].urls = Array.from({ length: 11 }, (_, i) => ({ original: `https://example.com/${i}`, normalized: `https://example.com/${i}` }));
  tooMany.protocol.render = { enabled: true, pages: tooMany.protocol.page_types[0].urls, max_render_requests: 300 };
  assert.throws(() => freezeProtocol(tooMany), /render page limit/);
});

test('indexing decision evidence paths on a render page do not change the protocol hash', () => {
  const make = evidence => {
    const changed = context();
    const url = { ...changed.protocol.page_types[0].urls[0], public_indexing: false,
      indexing_decision: { condition: 'not_public_index_target', reason: 'documented', evidence_ref: evidence } };
    changed.protocol.page_types[0].urls[0] = url;
    changed.protocol.render = { enabled: true, pages: [url], max_render_requests: 300 };
    return changed;
  };
  assert.equal(freezeProtocol(make('e/one')).protocol_hash, freezeProtocol(make('e/two')).protocol_hash);
});

// Task 21e (R94): families that matter only for indexed pages have no unit for a page that is not an index target.
test('document-title, canonical-consistency and naver-markup plan only the public index targets, like the index families (R94)', () => {
  const about = { original: 'https://example.com/about', normalized: 'https://example.com/about', public_indexing: false,
    indexing_decision: { condition: 'not_public_index_target', reason: 'documented exclusion', evidence_ref: 'e/index' } };
  const planned = (familyId, urls) => {
    const changed = context();
    changed.protocol.page_types[0].urls.push(about);
    changed.protocol.families.push({ family_id: familyId, applicable: true, ...(urls ? { urls } : {}) });
    return changed;
  };
  for (const familyId of ['document-title', 'canonical-consistency']) {
    assert.doesNotThrow(() => freezeProtocol(planned(familyId, ['https://example.com/'])), `${familyId} lists the public page only`);
    assert.throws(() => freezeProtocol(planned(familyId, ['https://example.com/', 'https://example.com/about'])), ContractError, `${familyId} cannot list the excluded page`);
  }
  const allExcluded = planned('document-title', undefined);
  allExcluded.protocol.page_types[0].urls[0] = { ...about, original: 'https://example.com/', normalized: 'https://example.com/' };
  assert.throws(() => freezeProtocol(allExcluded), /document-title: applicable family has no public index target/);
});

// Task 22 (S2): the fixed applicability rules are read from the registry flags, not from lists of family names; this holds the two together.
test('the fixed applicability rules agree with the registry public_only flags (S2)', () => {
  const excluded = { condition: 'not_public_index_target', reason: 'documented exclusion', evidence_ref: 'e/index' };
  const withFamilyOf = (family, { publicPage = true, engines = ['google'] } = {}) => {
    const changed = context();
    changed.protocol.engines = engines;
    if (!publicPage) Object.assign(changed.protocol.page_types[0].urls[0], { public_indexing: false, indexing_decision: excluded });
    if (family.family_id === 'fetch-response') changed.protocol.families = [family]; else changed.protocol.families.push(family);
    return changed;
  };
  const decision = condition => ({ condition, reason: 'fixed condition', evidence_ref: 'e/fixed' });
  const families = checkRegistry().families;
  assert.ok(families.filter(item => item.public_only === true).length >= 6, 'the registry still marks its public-only families');
  for (const item of families) {
    const publicOnly = item.public_only === true, id = item.family_id;
    // A family bound to engines is judged with one of its own engines targeted, so only the public pages decide it here.
    const targeted = { engines: [...new Set(['google', ...(item.engines ?? [])])] };
    const withFamily = (family, options = {}) => withFamilyOf(family, { ...targeted, ...options });
    if (item.na_conditions.includes('no_public_index_target')) {
      assert.equal(publicOnly, true, `${id} names no_public_index_target, so the registry must flag it public_only`);
      // Public pages: the family is applicable, and calling it inapplicable is refused. Only non-index pages: it is inapplicable with exactly that condition.
      assert.doesNotThrow(() => freezeProtocol(withFamily({ family_id: id, applicable: true })), `${id} applies to public pages`);
      assert.throws(() => freezeProtocol(withFamily({ family_id: id, applicable: false, applicability_decision: decision('no_public_index_target') })), /contradicts fixed/, id);
      assert.doesNotThrow(() => freezeProtocol(withFamily({ family_id: id, applicable: false, applicability_decision: decision('no_public_index_target') }, { publicPage: false })), `${id} has no unit without a public page`);
      assert.throws(() => freezeProtocol(withFamily({ family_id: id, applicable: true }, { publicPage: false })), /no public index target|contradicts fixed/, id);
      if (item.na_conditions.includes('no_target_engine')) {
        assert.doesNotThrow(() => freezeProtocol(withFamily({ family_id: id, applicable: false, applicability_decision: decision('no_target_engine') }, { engines: [] })), `${id} without a target engine`);
        assert.throws(() => freezeProtocol(withFamily({ family_id: id, applicable: false, applicability_decision: decision('no_public_index_target') }, { engines: [] })), /conflicts/, id);
      }
    } else if (publicOnly) {
      // A flagged family with no fixed condition still has no unit without a public page: the generic refusal stands.
      assert.throws(() => freezeProtocol(withFamily({ family_id: id, applicable: true }, { publicPage: false, engines: ['google', 'naver'] })), ContractError, `${id} cannot plan units with no public page`);
    } else if (!item.na_conditions.length || item.na_conditions.every(code => !['no_fixed_questions', 'naver_not_target'].includes(code))) {
      // An unflagged family does not follow the public pages.
      const attempt = () => freezeProtocol(withFamily({ family_id: id, applicable: true }, { publicPage: false }));
      try { attempt(); } catch (error) { assert.doesNotMatch(String(error.message), /public index target/, `${id} is not a public-only family`); }
    }
  }
});

test('an engine-bound family follows its own engines among the targets', () => {
  const planned = (engines, family) => {
    const changed = context();
    changed.protocol.engines = engines;
    changed.protocol.families.push(family);
    return changed;
  };
  const off = condition => ({ applicable: false, applicability_decision: { condition, reason: 'fixed condition', evidence_ref: 'e/fixed' } });
  const ai = { family_id: 'ai-crawler-policy' };
  assert.doesNotThrow(() => freezeProtocol(planned(['google'], { ...ai, ...off('ai_not_target') })), 'no AI engine targeted');
  assert.throws(() => freezeProtocol(planned(['google'], { ...ai, applicable: true })), /contradicts fixed/);
  assert.doesNotThrow(() => freezeProtocol(planned(['google', 'perplexity'], { ...ai, applicable: true })));
  assert.throws(() => freezeProtocol(planned(['google', 'perplexity'], { ...ai, ...off('ai_not_target') })), /contradicts fixed/);
  const crawl = { family_id: 'search-crawl-policy' };
  assert.doesNotThrow(() => freezeProtocol(planned(['claude'], { ...crawl, ...off('no_target_engine') })), 'an AI engine is no search crawl target');
  assert.throws(() => freezeProtocol(planned(['google', 'claude'], { ...crawl, applicable: true, engines: ['google', 'claude'] })), /target engine units cannot be omitted/);
  assert.doesNotThrow(() => freezeProtocol(planned(['google', 'claude'], { ...crawl, applicable: true, engines: ['google'] })));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { blocks } from '../skills/optbrew/scripts/core/checks/index.mjs';
import { composeReport, fixMethod, renderReport } from '../skills/optbrew/scripts/core/report-compose.mjs';
import { verifiedOf } from './support/compose.mjs';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const catalog = JSON.parse(read('../skills/optbrew/references/messages.ko.json'));
const remediations = JSON.parse(read('../skills/optbrew/references/remediations.json')).items;

const STEPS = ['mechanism', 'validation', 'effort', 'location_hint'];
const keysOf = family => blocks.find(item => item.family_id === family).message_keys;
const allKeys = blocks.flatMap(item => item.message_keys);
const PLACEHOLDER = /\{(\w+)(?::[\w-]+)?\}/g;
const namesOf = template => new Set([...template.matchAll(PLACEHOLDER)].map(match => match[1]));
const SENTENCE = /(?:^|[^A-Za-z0-9_\-.:/@])(?:[A-Za-z][A-Za-z']*[,.]?\s+){2,}[A-Za-z][A-Za-z']*/;
const withoutMarkup = text => text.replace(/<[^>]+>/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/"[^"]*"/g, ' ');

const finding = (key, over = {}) => ({ schema_version: '2.0.0', finding_id: 'f1', check_id: key.split('.')[0], unit_key: `${key.split('.')[0]}|https://s.test/a`, priority: 'P2', blocker: false,
  message: 'English problem', message_key: key, message_values: {}, source_ref: 'optbrew:collector', evidence_ref: 'e', remediation_ids: [], status: 'confirmed',
  finding_ids: ['f1'], sources: [], remediation: null, resolution: null, ...over });
const fixOf = item => composeReport(verifiedOf({ findings: [item] })).fixes[0];

test('every message key a check can state has a method, a check, an effort and a place, in plain Korean', () => {
  assert.ok(allKeys.length >= 36, `${allKeys.length} keys declared`);
  for (const key of allKeys) {
    const problem = catalog[key];
    for (const step of STEPS) {
      const text = catalog[`${key}.${step}`];
      assert.equal(typeof text, 'string', `${key}.${step}`);
      assert.ok(text.trim().length > 0, `${key}.${step} is empty`);
      assert.doesNotMatch(text, /[—–]/, `${key}.${step} has a long dash`);
      assert.doesNotMatch(text, /쪽/, `${key}.${step} says page, not 쪽`);
      assert.doesNotMatch(withoutMarkup(text), SENTENCE, `${key}.${step} has an English sentence`);
      // The steps are filled with the values of the problem they answer; a name the problem does not carry would read as unknown.
      for (const name of namesOf(text)) assert.ok(namesOf(problem).has(name), `${key}.${step} uses {${name}}, which ${key} does not state`);
    }
    for (const step of ['mechanism', 'validation', 'effort']) assert.match(catalog[`${key}.${step}`], /[.)]$/, `${key}.${step} ends a sentence`);
  }
});

test('the steps are read by the report: method, check, effort and place of a check problem, with no catalog remediation', () => {
  const fix = fixOf(finding('canonical-consistency.redirect-chain'));
  assert.equal(fix.remediation, null);
  assert.deepEqual(fix.text_ko.remediation, { mechanism: catalog['canonical-consistency.redirect-chain.mechanism'], validation: catalog['canonical-consistency.redirect-chain.validation'],
    effort: catalog['canonical-consistency.redirect-chain.effort'], location_hint: catalog['canonical-consistency.redirect-chain.location_hint'], cost: null });
  assert.equal(fix.where, catalog['canonical-consistency.redirect-chain.location_hint'], 'the place the owner is sent to is the key\'s location hint');
  const key = 'canonical-consistency.redirect-chain';
  const verified = verifiedOf({ findings: [finding(key)] });
  const [priority, , , method, where, effort, check] = renderReport(composeReport(verified), verified).tables.remediation[0];
  assert.deepEqual([method, where, effort, check], [catalog[`${key}.mechanism`], catalog[`${key}.location_hint`], catalog[`${key}.effort`], catalog[`${key}.validation`]]);
  assert.equal(priority, '보통');
});

test('the values of the problem fill the steps', () => {
  assert.match(fixOf(finding('fetch-response.http-error', { message_values: { status: 503 } })).text_ko.remediation.mechanism, /^서버 로그나 호스팅 관리 화면에서 503 오류/);
  const crawler = fixOf(finding('search-crawl-policy.disallowed', { message_values: { agent: 'Googlebot' } }));
  assert.match(crawler.text_ko.remediation.mechanism, /구글 크롤러\(Googlebot\)에게 적용되는 묶음/);
  const slow = fixOf(finding('lcp-field.slow', { message_values: { value: 5200, source: 'crux', good: 2500, poor: 4000 } }));
  assert.match(slow.text_ko.remediation.validation, /LCP가 2500 ms 이하로/);
});

test('a catalog remediation covers a family, but the message key decides the words (precedence: key, then catalog, then its own words)', () => {
  const title = remediations.find(item => item.remediation_id === 'repair-document-title');
  assert.equal(title.check_id, 'document-title');
  const duplicate = fixOf(finding('document-title.duplicate', { remediation: title }));
  const missing = fixOf(finding('document-title.missing', { remediation: title }));
  // One catalog entry for the family says "add a title"; only the key that is about a missing title may say so.
  assert.equal(duplicate.text_ko.remediation.mechanism, catalog['document-title.duplicate.mechanism']);
  assert.notEqual(duplicate.text_ko.remediation.mechanism, catalog['remediation.repair-document-title.mechanism']);
  assert.equal(missing.text_ko.remediation.mechanism, catalog['document-title.missing.mechanism']);
  for (const fix of [duplicate, missing]) {
    const key = fix.message_key;
    assert.equal(fix.text_ko.remediation.validation, catalog[`${key}.validation`]);
    assert.equal(fix.text_ko.remediation.effort, catalog[`${key}.effort`]);
    assert.equal(fix.text_ko.remediation.location_hint, catalog[`${key}.location_hint`]);
    assert.equal(fix.where, catalog[`${key}.location_hint`]);
    // What only the catalog knows still comes from it: the cost and the official source beside the method.
    assert.equal(fix.text_ko.remediation.cost, catalog['remediation.repair-document-title.cost']);
    assert.equal(fixMethod(fix), `${catalog[`${key}.mechanism`]} (${title.source_url}, 확인일 ${title.checked_date})`);
  }
});

test('a finding whose key has no steps (or no key) falls back to the catalog\'s Korean text, and then to the catalog\'s own words', () => {
  const noindex = remediations.find(item => item.remediation_id === 'remove-unintended-noindex');
  for (const over of [{ message_key: undefined, message_values: undefined }, { message_key: 'not.in.catalog' }]) {
    const fix = fixOf(finding('index-policy.noindex', { ...over, remediation: noindex }));
    for (const field of ['mechanism', 'validation', 'effort', 'cost', 'location_hint']) assert.equal(fix.text_ko.remediation[field], catalog[`remediation.${noindex.remediation_id}.${field}`], field);
    assert.equal(fix.where, catalog['remediation.remove-unintended-noindex.location_hint']);
  }
  const foreign = { ...noindex, remediation_id: 'someone-elses', mechanism: 'Fix it the English way', location_hint: 'English place' };
  const fix = fixOf(finding('index-policy.noindex', { message_key: undefined, message_values: undefined, remediation: foreign }));
  assert.equal(fix.text_ko.remediation.mechanism, 'Fix it the English way');
  assert.equal(fix.where, 'English place');
});

test('every key of a family the catalog covers has steps of its own, so the catalog\'s Korean text is only ever the fallback', () => {
  assert.ok(remediations.length >= 5);
  for (const item of remediations) {
    const keys = keysOf(item.check_id);
    assert.ok(keys.length, `${item.remediation_id} covers a check`);
    for (const key of keys) for (const step of STEPS) assert.ok(catalog[`${key}.${step}`], `${item.remediation_id}: ${key}.${step}`);
  }
});

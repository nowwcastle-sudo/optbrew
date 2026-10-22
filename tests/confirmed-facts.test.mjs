import test from 'node:test';
import assert from 'node:assert/strict';
import { factConsistency } from '../skills/optbrew/scripts/core/checks/fact-consistency.mjs';
import { compareFacts, confirmedReferences, pageFacts } from '../skills/optbrew/scripts/core/facts.mjs';

const ORIGIN = 'https://flower.test';
const page = body => `<html><head><title>동네 꽃집</title></head><body><h1>동네 꽃집</h1>${body}</body></html>`;
const factList = pages => Object.entries(pages).map(([route, html]) => ({ url: `${ORIGIN}${route}`,
  row: { artifact: { evidence_ref: `evidence${route}.html` } }, facts: pageFacts(html) }));
/** The fact-consistency verdict of each page, by route, with the owner's confirmed facts in the protocol. */
const judge = (pages, confirmed_facts) => {
  const facts = factList(pages);
  const observations = factConsistency.derive({ context: { protocol: { confirmed_facts } }, facts, comparison: compareFacts(facts) });
  return Object.fromEntries(observations.map(observation => [observation.unit_key.slice(`fact-consistency|${ORIGIN}`.length), observation]));
};
const phone = value => ({ key: 'phone', value });

test('a page phone that differs from the confirmed phone fails, naming the fact, the page value and the confirmed value', () => {
  const result = judge({ '/': page('<p>전화: 02-555-0142</p>') }, [phone('02-555-0199')]);
  assert.equal(result['/'].state, 'fail');
  assert.equal(result['/'].reason, 'Confirmed fact comparison: phone "02-555-0142" differs from the confirmed "02-555-0199"');
  assert.deepEqual(result['/'].problem_messages, [{ message_key: 'fact-consistency.confirmed-differs',
    message_values: { type: 'phone', found: '02-555-0142', confirmed: '02-555-0199' } }]);
  assert.equal(result['/'].unit_key, `fact-consistency|${ORIGIN}/`, 'the unit names the page');
});

test('one page alone is judged against the confirmed facts, which the cross-page vote needs two pages for', () => {
  assert.deepEqual(Object.keys(judge({ '/': page('<p>전화: 02-555-0142</p>') }, [])), [], 'without a confirmed list one page stays unknown');
  assert.equal(judge({ '/': page('<p>전화: 02-555-0142</p>') }, [phone('02 555 0142')])['/'].state, 'pass', 'the same number written another way agrees');
});

test('a mobile tel: link beside the confirmed landline is no conflict', () => {
  const result = judge({ '/': page('<p>전화: 02-555-0142</p><a href="tel:010-1234-5678">휴대폰으로 상담</a>') }, [phone('02-555-0142')]);
  assert.equal(result['/'].state, 'pass');
  assert.match(result['/'].reason, /match the confirmed facts/);
});

test('a landline and a mobile number can both be confirmed, and either one on a page agrees', () => {
  const confirmed = [phone('02-555-0142'), phone('010-1234-5678')];
  const result = judge({ '/': page('<p>전화: 02-555-0142</p>'), '/order': page('<p>전화: 010-1234-5678</p>') }, confirmed);
  assert.deepEqual([result['/'].state, result['/order'].state], ['pass', 'pass']);
  assert.equal(confirmedReferences(confirmed).get('phone').label, '02-555-0142 / 010-1234-5678');
});

test('a confirmed fact replaces the cross-page vote for its type, and other types keep the vote', () => {
  // Two pages show the old number and one the confirmed number: the vote would fail the one right page.
  const pages = { '/': page('<p>전화: 02-555-0199</p><p>주소: 서울 마포구 성미산로 10</p>'), '/a': page('<p>전화: 02-555-0199</p><p>주소: 서울 마포구 성미산로 10</p>'),
    '/b': page('<p>전화: 02-555-0142</p><p>주소: 서울 마포구 동교로 99</p>') };
  const result = judge(pages, [phone('02-555-0142')]);
  assert.deepEqual(['/', '/a', '/b'].map(route => result[route].state), ['fail', 'fail', 'fail']);
  assert.deepEqual(result['/b'].problem_messages.map(item => [item.message_key, item.message_values.type]), [['fact-consistency.differs', 'address']],
    'the right phone passes; the address that differs from the other pages still fails');
  assert.deepEqual(result['/'].problem_messages.map(item => item.message_key), ['fact-consistency.confirmed-differs']);
});

test('addresses, names and years compare the way the cross-page check does; an unusable confirmed value compares nothing', () => {
  const confirmed = [{ key: 'address', value: '서울특별시 마포구 성미산로 10' }, { key: 'year', value: '2015년' }, phone('곧 알려 드림')];
  const result = judge({ '/': page('<p>주소: 서울 마포구 성미산로 10</p><p>설립연도: 2015</p><p>전화: 02-555-0142</p>') }, confirmed);
  assert.equal(result['/'].state, 'pass');
  const moved = judge({ '/': page('<p>주소: 서울 마포구 동교로 99</p>') }, confirmed);
  assert.deepEqual(moved['/'].problem_messages[0].message_values, { type: 'address', found: '서울 마포구 동교로 99', confirmed: '서울특별시 마포구 성미산로 10' });
  const named = judge({ '/': page(`<script type="application/ld+json">${JSON.stringify({ '@type': 'LocalBusiness', name: 'Other Flowers' })}</script>`) },
    [{ key: 'name', value: '동네 꽃집' }]);
  assert.equal(named['/'].state, 'fail');
});

test('an empty confirmed list leaves the cross-page comparison as it was', () => {
  const pages = { '/': page('<p>전화: 02-555-0142</p>'), '/a': page('<p>전화: 02-555-0142</p>'), '/b': page('<p>전화: 02-555-0199</p>') };
  const facts = factList(pages);
  const without = factConsistency.derive({ context: { protocol: {} }, facts, comparison: compareFacts(facts) });
  assert.deepEqual(judge(pages, []), Object.fromEntries(without.map(observation => [observation.unit_key.slice(`fact-consistency|${ORIGIN}`.length), observation])));
  assert.equal(judge(pages, [])['/b'].state, 'fail');
  assert.match(judge(pages, [])['/b'].reason, /^Cross-page fact comparison \(no approved fact list\): phone/);
});

test('a Korean address written in the other order agrees with the confirmed one (도/시 written out on either side)', () => {
  const confirmed = [{ key: 'address', value: '예시읍 샘플로 12-34, 가상시, 경기도' }];
  assert.equal(judge({ '/privacy': page('<p>주소: 경기도 가상시 예시읍 샘플로 12-34</p>') }, confirmed)['/privacy'].state, 'pass');
  assert.equal(judge({ '/privacy': page('<p>주소: 경기도 가상시 예시읍 샘플로 12-43</p>') }, confirmed)['/privacy'].state, 'fail', 'a different number still differs');
});

test('a Korean PostalAddress in JSON-LD is offered in Korean order, an English one keeps its commas', () => {
  const ld = address => page(`<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'LocalBusiness',
    name: '동네 꽃집', address: { '@type': 'PostalAddress', ...address } })}</script>`);
  const linkedAddress = html => [...pageFacts(html).linked.address.values()];
  assert.deepEqual(linkedAddress(ld({ streetAddress: '예시읍 샘플로 12-34', addressLocality: '가상시', addressRegion: '경기도' })),
    ['경기도 가상시 예시읍 샘플로 12-34']);
  assert.deepEqual(linkedAddress(ld({ streetAddress: '27 Wausan-ro', addressLocality: 'Mapo-gu', addressRegion: 'Seoul' })),
    ['27 Wausan-ro, Mapo-gu, Seoul']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { pageFacts, compareFacts, addressKey } from '../skills/optbrew/scripts/core/facts.mjs';

const wrap = (main, head = '') => `<!doctype html><html><head><title>Page</title>${head}</head><body>${main}</body></html>`;
function run(pages) {
  const list = Object.entries(pages).map(([url, html]) => ({ url, facts: pageFacts(html) }));
  const comparison = compareFacts(list);
  const fails = new Map([...comparison.deviations.entries()].filter(([url, found]) => found.length && !comparison.separate.has(url)));
  return { list, comparison, fails };
}
const phoneKeys = html => [...pageFacts(html).visible.phone.keys()];
const ld = o => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Brew', ...o })}</script>`;

test('N1b: a phone number never continues across a line break into the next block', () => {
  assert.deepEqual(phoneKeys(wrap('<ul><li>Phone: 02-555-0142</li><li>42 seats</li></ul>')), ['025550142']);
  assert.deepEqual(phoneKeys(wrap('<p>Phone: 02-555-0142</p>\n<p>2014 opening</p>')), ['025550142']);
  const { fails } = run({
    '/': wrap('<ul><li>Phone: 02-555-0142</li><li>Open daily</li></ul>'),
    '/a': wrap('<ul><li>Phone: 02-555-0142</li><li>Open daily</li></ul>'),
    '/b': wrap('<ul><li>Phone: 02-555-0142</li><li>42 seats</li></ul>'),
  });
  assert.equal(fails.size, 0, JSON.stringify([...fails]));
  // A real difference is still found.
  assert.equal(run({ '/': wrap('<p>Phone: 02-555-0142</p>'), '/a': wrap('<p>Phone: 02-555-0142</p>'), '/b': wrap('<p>Phone: 02-555-0199</p>') }).fails.size, 1);
});

test('N2: a tel: link is its own evidence class; a mobile inquiry link does not fail against the landline', () => {
  const facts = pageFacts(wrap('<p>Phone: 02-555-0142</p><a href="tel:010-1234-5678">Text us</a>', ld({ telephone: '02-555-0142' })));
  assert.deepEqual([...facts.tel.phone.keys()], ['01012345678']);
  assert.deepEqual([...facts.linked.phone.keys()], ['025550142'], 'JSON-LD keeps only JSON-LD values');
  const { fails } = run({
    '/': wrap('<p>Phone: 02-555-0142</p>'),
    '/a': wrap('<p>Phone: 02-555-0142</p>'),
    '/b': wrap('<p>Phone: 02-555-0142</p><p><a href="tel:010-1234-5678">Text us on mobile</a></p>'),
  });
  assert.equal(fails.size, 0, JSON.stringify([...fails]));
  // Same with JSON-LD present on every page.
  const withLd = run({
    '/': wrap('<p>Phone: 02-555-0142</p>', ld({ telephone: '02-555-0142' })),
    '/a': wrap('<p>Phone: 02-555-0142</p>', ld({ telephone: '02-555-0142' })),
    '/b': wrap('<p>Phone: 02-555-0142</p><a href="tel:010-1234-5678">Text us</a>', ld({ telephone: '02-555-0142' })),
  });
  assert.equal(withLd.fails.size, 0, JSON.stringify([...withLd.fails]));
});

test('N2: tel: links still catch a wrong number when they are the only phone evidence, and are never called JSON-LD', () => {
  const { fails } = run({
    '/': wrap('<a href="tel:02-555-0142">Call</a>'),
    '/a': wrap('<a href="tel:02-555-0142">Call</a>'),
    '/b': wrap('<a href="tel:02-555-0199">Call</a>'),
  });
  assert.equal(fails.size, 1);
  const [message] = fails.get('/b');
  assert.match(message, /phone "02-555-0199" differs from "02-555-0142" on 2 pages/);
  assert.doesNotMatch(message, /JSON-LD/);
  // A visible landline and a JSON-LD landline that disagree are still reported as such.
  const mismatch = run({ '/': wrap('<p>Phone: 02-555-0142</p>', ld({ telephone: '02-555-0199' })) });
  assert.match([...mismatch.comparison.deviations.get('/')].join(), /phone in JSON-LD "02-555-0199" differs from visible "02-555-0142"/);
});

test('M1: a street number that differs only by a leading digit is a different address', () => {
  const { fails } = run({
    '/': wrap('<p>Address: 10 Main Street, Springfield</p>'),
    '/a': wrap('<p>Address: 10 Main Street, Springfield</p>'),
    '/b': wrap('<p>Address: 110 Main Street, Springfield</p>'),
  });
  assert.deepEqual([...fails.keys()], ['/b']);
  assert.match(fails.get('/b')[0], /address/);
  // Abbreviation, city detail and country remain the same address.
  const same = run({
    '/': wrap('<p>Address: 10 Main Street, Springfield</p>'),
    '/a': wrap('<p>Address: 10 Main St</p>'),
    '/b': wrap('<p>Address: 10 Main St, Springfield, South Korea</p>'),
  });
  assert.equal(same.fails.size, 0, JSON.stringify([...same.fails]));
});

test('M2: a five-digit street number is not a postal code; a postal code in its own position still is', () => {
  const different = run({
    '/': wrap('<p>Address: 12345 Ocean Avenue, Springfield</p>'),
    '/a': wrap('<p>Address: 12345 Ocean Avenue, Springfield</p>'),
    '/b': wrap('<p>Address: 54321 Ocean Avenue, Springfield</p>'),
  });
  assert.deepEqual([...different.fails.keys()], ['/b']);
  assert.notEqual(addressKey('12345 Ocean Avenue, Springfield'), addressKey('54321 Ocean Avenue, Springfield'));
  const same = run({
    '/': wrap('<p>Address: 12345 Ocean Avenue, Springfield</p>'),
    '/a': wrap('<p>Address: 12345 Ocean Avenue, Springfield 90210</p>'),
    '/b': wrap('<p>Address: 12345 Ocean Ave, Springfield, CA 90210, USA</p>'),
  });
  assert.equal(same.fails.size, 0, JSON.stringify([...same.fails]));
  // JSON-LD keeps the postal code in its own field.
  const structured = run({
    '/': wrap('<p>Address: 12345 Ocean Avenue, Springfield</p>', ld({ address: { '@type': 'PostalAddress', streetAddress: '12345 Ocean Avenue', addressLocality: 'Springfield', postalCode: '90210' } })),
    '/a': wrap('<p>Address: 12345 Ocean Avenue, Springfield</p>'),
    '/b': wrap('<p>Address: 12345 Ocean Avenue, Springfield</p>'),
  });
  assert.equal(structured.fails.size, 0, JSON.stringify([...structured.fails]));
  // Korean addresses: formal and short city forms agree, a different number does not, a labelled postal code is dropped.
  const korean = run({
    '/': wrap('<p>주소: 서울특별시 마포구 와우산로 27</p>'),
    '/a': wrap('<p>주소: 서울 마포구 와우산로 27</p>'),
    '/b': wrap('<p>주소: 서울 마포구 와우산로 127</p>'),
  });
  assert.deepEqual([...korean.fails.keys()], ['/b']);
  const postal = run({
    '/': wrap('<p>Address: (04050) 서울 마포구 와우산로 27</p>'),
    '/a': wrap('<p>Address: 서울 마포구 와우산로 27</p>'),
    '/b': wrap('<p>Address: 서울 마포구 와우산로 27 우편번호 04050</p>'),
  });
  assert.equal(postal.fails.size, 0, JSON.stringify([...postal.fails]));
});

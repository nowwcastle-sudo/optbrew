import test from 'node:test';
import assert from 'node:assert/strict';
import { pageFacts, compareFacts } from '../skills/optbrew/scripts/core/facts.mjs';

const wrap = (main, head = '', title = 'Page') => `<!doctype html><html><head><title>${title}</title>${head}</head><body>${main}</body></html>`;
function run(pages) {
  const list = Object.entries(pages).map(([url, html]) => ({ url, facts: pageFacts(html) }));
  const comparison = compareFacts(list);
  const fails = new Map([...comparison.deviations.entries()].filter(([url, found]) => found.length && !comparison.separate.has(url)));
  return { list, comparison, fails };
}
const three = (a, c, b = a) => ({ '/': wrap(a), '/a': wrap(b), '/b': wrap(c) });
const keys = html => [...pageFacts(html).visible.phone.keys()];
const ld = o => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Brew', ...o })}</script>`;

test('L4 S1: the same spaced national number on every page is no difference', () => {
  assert.deepEqual(keys(wrap('<p>Phone: 02 555 0142</p>')), ['025550142']);
  assert.equal(run(three('<p>Phone: 02 555 0142</p>', '<p>Phone: 02 555 0142</p>')).fails.size, 0);
  assert.equal(run(three('<p>Phone: 02-555-0142</p>', '<p>Phone: 02 555 0142</p>')).fails.size, 0, 'spaced and dashed are one number');
});

test('L4 S2: a wrong spaced national number is found', () => {
  const { fails } = run(three('<p>Phone: 02 555 0142</p>', '<p>Phone: 02 555 0199</p>'));
  assert.deepEqual([...fails.keys()], ['/b']);
  assert.deepEqual(keys(wrap('<p>Mobile: 010 1234 5678</p>')), ['01012345678']);
  assert.deepEqual(keys(wrap('<p>전화 031 123 4567</p>')), ['0311234567']);
});

test('L4 S4: a Korean nationwide representative number is read in a label, a tel: link and JSON-LD', () => {
  assert.deepEqual(keys(wrap('<p>대표번호 1588-1234</p>')), ['15881234']);
  assert.deepEqual(keys(wrap('<p>Tel: 1544 1234</p>')), ['15441234']);
  assert.deepEqual([...pageFacts(wrap('<a href="tel:1588-1234">call</a>')).tel.phone.keys()], ['15881234']);
  assert.deepEqual([...pageFacts(wrap('<p>x</p>', ld({ telephone: '1688-1234' }))).linked.phone.keys()], ['16881234']);
  const { fails } = run(three('<p>대표번호 1588-1234</p>', '<p>대표번호 1588-9999</p>'));
  assert.deepEqual([...fails.keys()], ['/b']);
});

test('L4: spaced numbers are only read in a label; prose and look-alike figures stay unread', () => {
  assert.deepEqual(keys(wrap('<p>Call 02 555 0142 to order.</p>')), []);
  assert.deepEqual(keys(wrap('<p>Phone: 2024 0517</p>')), [], 'a date is not a number');
  assert.deepEqual(keys(wrap('<p>Phone: 1900-1234</p>')), [], '19xx is not a representative prefix');
  assert.deepEqual(keys(wrap('<p>Phone: 12345678</p>')), [], 'another eight-digit run');
  assert.deepEqual(keys(wrap('<p>Fax: 02 555 0143</p>')), [], 'a fax number is not the phone');
  assert.deepEqual(keys(wrap('<p>Tel 02 555 0142 42 seats</p>')), [], 'a spaced number followed by more digits is ambiguous');
  assert.deepEqual(keys(wrap('<p>Phone: 02 555 0142</p><p>2014 opening</p>')), ['025550142']);
  assert.equal(run(three('<p>Phone: 02 555 0142</p>', '<p>Phone: 02 555 0142 (9am-6pm)</p>')).fails.size, 0, 'hours after the number are not part of it');
});

test('the 0.1.2 phone cases still hold', () => {
  for (const formatted of ['02-555-0142', '(02) 555-0142', '02.555.0142', '+82-2-555-0142', '+82 (0)2 555 0142', '+82 2 555 0142', '02-555-0142 ext. 12'])
    assert.deepEqual(keys(wrap(`<p>Phone: ${formatted}</p>`)), ['025550142'], formatted);
  assert.equal(run(three('<p>Phone: 02-555-0142</p>', '<p><span>Phone: 02-555-0142</span> <span>42 seats</span></p>')).fails.size, 0);
  assert.equal(run(three('<p>Phone: 02-555-0142</p>', '<p>Phone: 02-555-0199</p>')).fails.size, 1);
});

// ---- L5: a branch word is not enough; a separate entity needs structure
const withTitle = (main, title) => wrap(main, '', title);
const addr = a => `<p>Address: ${a}</p>`;
const branchSite = (bTitle, bMain, bUrl = '/b') => ({
  '/': withTitle(`${addr('10 Main Street, Springfield')}<p>Phone: 02-555-0142</p>`, 'Home'),
  '/a': withTitle(`${addr('10 Main Street, Springfield')}<p>Phone: 02-555-0142</p>`, 'About'),
  [bUrl]: withTitle(bMain, bTitle),
});

test('L5 M3: a wrong phone on a page that only says "Branch news" in its title is a failure', () => {
  const { fails } = run(branchSite('Branch news', `${addr('10 Main Street, Springfield')}<p>Phone: 02-555-0199</p>`));
  assert.deepEqual([...fails.keys()], ['/b']);
  const noAddress = run(branchSite('Branch news', '<p>Phone: 02-555-0199</p>'));
  assert.deepEqual([...noAddress.fails.keys()], ['/b'], 'a title word and no address of its own is still the main entity');
  const heading = run(branchSite('News', `<h1>지점 소식</h1>${addr('10 Main Street, Springfield')}<p>전화: 02-555-0199</p>`));
  assert.deepEqual([...heading.fails.keys()], ['/b']);
});

test('L5: a branch word with an address of its own is a separate entity and is not compared', () => {
  const { fails, comparison } = run(branchSite('Gangnam branch', `${addr('55 Teheran-ro, Gangnam-gu')}<p>Phone: 02-555-0999</p>`));
  assert.equal(fails.size, 0);
  assert.ok(comparison.separate.has('/b'));
});

test('L5: a page under a branch-list path is a separate entity whatever its title says', () => {
  for (const p of ['/branches/gangnam', '/locations/gangnam', '/stores/gangnam', '/branch/gangnam', '/지점/강남']) {
    const { fails, comparison } = run(branchSite('Gangnam', `${addr('10 Main Street, Springfield')}<p>Phone: 02-555-0199</p>`, p));
    assert.equal(fails.size, 0, p);
    assert.ok(comparison.separate.has(p), p);
  }
  // a path that only contains the word is not a branch list
  assert.deepEqual([...run(branchSite('Gangnam', `${addr('10 Main Street, Springfield')}<p>Phone: 02-555-0199</p>`, '/branching-out')).fails.keys()], ['/branching-out']);
});

test('L5: JSON-LD that names a parent organization or another @id makes the page a separate entity', () => {
  const pages = branchSite('Gangnam', `${addr('55 Teheran-ro')}<p>Phone: 02-555-0999</p>`);
  pages['/b'] = wrap(`${addr('10 Main Street, Springfield')}<p>Phone: 02-555-0199</p>`, ld({ branchOf: { name: 'Brew HQ' } }));
  const { fails, comparison } = run(pages);
  assert.equal(fails.size, 0);
  assert.ok(comparison.separate.has('/b'));
});

test('L5 control: a healthy multi-branch site does not fail', () => {
  const pages = { '/': withTitle(`${addr('10 Main Street, Springfield')}<p>Phone: 02-555-0142</p>`, 'Home'),
    '/a': withTitle(`${addr('10 Main Street, Springfield')}<p>Phone: 02-555-0142</p>`, 'About'),
    '/branches/north': withTitle(`${addr('1 North Road')}<p>Phone: 02-555-0301</p>`, 'North branch'),
    '/branches/south': withTitle(`${addr('2 South Road')}<p>Phone: 02-555-0302</p>`, 'South branch'),
    '/locations': withTitle(`${addr('10 Main Street, Springfield')}<p>Phone: 02-555-0142</p>`, 'Our locations') };
  assert.equal(run(pages).fails.size, 0);
});

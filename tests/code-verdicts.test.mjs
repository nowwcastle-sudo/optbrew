import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../skills/optbrew/scripts/core/checks/prepare.mjs';
import { blocks } from '../skills/optbrew/scripts/core/checks/index.mjs';
import { compareFacts, jsonLdTruth, pageFacts } from '../skills/optbrew/scripts/core/facts.mjs';
import { thresholds } from '../skills/optbrew/scripts/core/config.mjs';

const ORIGIN = 'https://site.test';
const url = route => `${ORIGIN}${route}`;
const FAMILIES = blocks.map(block => block.family_id);
const block = familyId => blocks.find(item => item.family_id === familyId);
const doc = (body, head = '', title = 'Page') => `<html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
const ld = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const RICH = '<h1>Welcome to the brew house</h1><p>Fresh coffee roasted every morning, pastries baked on site, and a quiet room to work in until late.</p>';
const SHELL = doc('<div id="app"></div><script src="/app.js"></script>');

/**
 * The shared values the check blocks read, for collected pages answered 200. `pages` maps a route to its HTML; `types` maps a
 * page type id to its routes (one type holds every page by default); `hops` gives a route a redirect chain of that length.
 */
function prepared(pages, { types = { primary: Object.keys(pages) }, renders = [], renderHtml = {}, chrome = { found: true, reason: null }, render, hops = {}, collection = {} } = {}) {
  const artifacts = Object.entries(pages).map(([route, body]) => ({ normalized_url: url(route), requested_url: url(route), final_url: url(route),
    capability: 'raw_html', status: 200, content_hash: 'hash', evidence_ref: `evidence/${route}`, redirect_chain: Array(hops[route] ?? 0).fill('hop'), header_lines: [], body }));
  const context = { protocol: { engines: ['google'], auxiliary_resources: [], families: FAMILIES.map(family_id => ({ family_id, applicable: true })),
    page_types: Object.entries(types).map(([id, routes]) => ({ id, urls: routes.map(route => ({ normalized: url(route) })) })), ...(render ? { render } : {}) } };
  return prepare({ context, artifacts, collection, textOf: artifact => artifact.body, renders, renderTextOf: record => renderHtml[record.url] ?? '', chrome });
}
const judge = (familyId, pages, options) => Object.fromEntries(block(familyId).derive(prepared(pages, options))
  .map(observation => [observation.unit_key.slice(familyId.length + 1 + ORIGIN.length), observation]));
const states = result => Object.fromEntries(Object.entries(result).map(([route, observation]) => [route, observation.state]));

// F3a: facts.mjs branch rule.
const node = (extra = {}) => ({ '@type': 'Organization', name: 'Brew Cafe', sameAs: ['https://social.example/brew'], telephone: '02-555-0142', ...extra });
const subOrganization = (name, extra = {}) => node({ '@type': 'LocalBusiness', '@id': `${ORIGIN}/#${name}`, name, sameAs: undefined, telephone: '031-111-2222',
  parentOrganization: { '@id': `${ORIGIN}/#organization` }, ...extra });

test('a page with the main organization and its sub-organizations is the main entity, and only the main node speaks for it', () => {
  const home = pageFacts(doc('<p>Phone: 02-555-0142</p>', ld({ '@graph': [node({ '@id': `${ORIGIN}/#organization` }), subOrganization('Brew Annex'), subOrganization('Brew Kiosk')] })));
  assert.equal(home.branch, false);
  assert.equal(home.orgs.length, 1, 'the sub-organizations are not the page\'s organizations');
  assert.deepEqual([...home.linked.phone.values()], ['02-555-0142'], 'a sub-organization\'s phone is not the page\'s phone');
});

test('a page whose every organization node is a sub-organization is a separate branch page', () => {
  const branch = pageFacts(doc('<p>Phone: 031-111-2222</p>', ld(subOrganization('Brew Annex'))));
  assert.equal(branch.branch, true);
  assert.equal(branch.orgs.length, 1);
  const named = pageFacts(doc('', ld(node({ name: 'Brew Cafe Branch Office' }))));
  assert.equal(named.branch, true, 'a branch word in the only node\'s name still makes it a branch');
});

test('real branch site: the home page with department nodes is compared, the branch page is not', () => {
  const pages = {
    '/': doc('<p>Phone: 02-555-0142</p>', ld({ '@graph': [node({ '@id': `${ORIGIN}/#organization` }), subOrganization('Brew Annex')] })),
    '/about': doc('<p>Phone: 02-555-0142</p>', ld(node({ '@id': `${ORIGIN}/#organization` }))),
    '/annex': doc('<p>Phone: 031-111-2222</p>', ld(subOrganization('Brew Annex'))),
  };
  const facts = Object.entries(pages).map(([route, html]) => ({ url: url(route), facts: pageFacts(html) }));
  const comparison = compareFacts(facts);
  assert.deepEqual([...comparison.separate], [url('/annex')], 'only the page that is all sub-organization is separate');
  assert.deepEqual(comparison.deviations.get(url('/')), []);
  assert.equal(comparison.references.phone.pages, 2);
  const [identity] = block('entity-identity').derive(prepared(pages));
  assert.equal(identity.state, 'pass', 'the department nodes do not make the home page a branch, so the site has an organization to identify');
});

// F1: render-content for pages outside the render sample.
const renderRef = route => `evidence/render-${route.replace(/\W/g, '_')}.json`;
const rec = (route, overrides = {}) => ({ url: url(route), final_url: url(route), status: 200, dom_ref: `dom${route}`, dom_sha256: 'hash',
  title: 'Page', links: [], console_errors: [], requests: [], blocked_reason: null, address_vetting: 'pinned', evidence_ref: renderRef(route), ...overrides });
const richDom = `<html><head><title>Page</title></head><body>${RICH}</body></html>`;
const sampled = (route, dom = richDom, overrides = {}) => ({ renders: [rec(route, overrides)], renderHtml: { [url(route)]: dom } });

test('render-content: a page inherits a not-applicable verdict from the sampled page of its type', () => {
  const result = judge('render-content', { '/': doc(RICH), '/a': doc(RICH), '/b': doc(RICH) }, { ...sampled('/'), render: { enabled: true, pages: [{ normalized: url('/') }] } });
  assert.deepEqual(states(result), { '/': 'not_applicable', '/a': 'not_applicable', '/b': 'not_applicable' });
  const inherited = result['/a'];
  assert.equal(inherited.applicability_decision.condition, 'not_render_dependent');
  assert.ok(inherited.reason.includes(`Inferred from ${url('/')}`), 'the reason names the sampled page');
  assert.equal(inherited.evidence_ref, renderRef('/'), 'the evidence is the sample\'s render record');
  assert.equal(inherited.applicability_decision.evidence_ref, inherited.evidence_ref);
  assert.deepEqual(inherited.measurement.inherited_from, { url: url('/'), state: 'not_applicable', page_type: 'primary', render_ref: renderRef('/') });
});

test('render-content: a page inherits a pass from the sampled page of its type, and its reason keeps the JavaScript note\'s prefix', () => {
  const result = judge('render-content', { '/': SHELL, '/a': SHELL }, { ...sampled('/'), render: { enabled: true, pages: [{ normalized: url('/') }] } });
  assert.deepEqual(states(result), { '/': 'pass', '/a': 'pass' });
  assert.ok(result['/a'].reason.startsWith(result['/'].reason), result['/a'].reason);
  assert.match(result['/a'].reason, /inferred from https:\/\/site\.test\//);
  assert.equal(result['/a'].q, 1);
});

test('render-content: nothing is inherited from an unknown or failed sample, from another page type, or without any sample', () => {
  const pages = { '/': SHELL, '/a': SHELL, '/c': SHELL };
  const options = { types: { first: ['/', '/a'], second: ['/c'] }, render: { enabled: true, pages: [{ normalized: url('/') }] } };
  const blocked = judge('render-content', pages, { ...options, ...sampled('/', richDom, { status: 403 }) });
  assert.deepEqual(states(blocked), { '/': 'unknown' }, 'a challenge page gives its type nothing to inherit');
  const failed = judge('render-content', pages, { ...options, renders: [rec('/', { dom_ref: null, status: null, blocked_reason: 'render_failed' })] });
  assert.deepEqual(states(failed), { '/': 'unknown' });
  const fine = judge('render-content', pages, { ...options, ...sampled('/') });
  assert.deepEqual(states(fine), { '/': 'pass', '/a': 'pass' }, '/c is another page type: it has no sample');
  const none = judge('render-content', pages, { ...options, renders: [], chrome: { found: true, reason: null } });
  assert.deepEqual(none, {}, 'no stored render at all, so no verdict');
});

test('render-content: a not-applicable is inherited only by a page whose own raw HTML has body text, and a sampled page never inherits', () => {
  const empty = doc('');
  const result = judge('render-content', { '/': doc(RICH), '/blank': empty }, { ...sampled('/'), render: { enabled: true, pages: [{ normalized: url('/') }] } });
  assert.deepEqual(states(result), { '/': 'not_applicable' }, 'the blank page breaks the template assumption');
  const two = judge('render-content', { '/': SHELL, '/b': SHELL }, { ...sampled('/'), chrome: { found: false, reason: 'chrome_not_found' },
    render: { enabled: true, pages: [{ normalized: url('/') }, { normalized: url('/b') }] } });
  assert.deepEqual(Object.fromEntries(Object.entries(two).map(([route, x]) => [route, x.reason])), { '/': 'Content shows after rendering', '/b': 'chrome_missing' },
    'a page of the sample that was not rendered is unknown, not inherited');
});

// F4: structured-data-truth.
const phoneNode = telephone => ld(node({ telephone }));

test('structured-data-truth: a page with no markup is not applicable under markup_not_used_or_selected, microdata stays unknown', () => {
  const result = judge('structured-data-truth', { '/': doc('<p>Hello</p>'), '/micro': doc('<div itemscope itemtype="https://schema.org/Product">x</div>') });
  assert.equal(result['/'].state, 'not_applicable');
  assert.equal(result['/'].applicability_decision.condition, 'markup_not_used_or_selected');
  assert.equal(result['/'].applicability_decision.evidence_ref, result['/'].evidence_ref);
  assert.deepEqual(result['/'].measurement, { jsonld_blocks: 0 });
  assert.equal(result['/micro'].state, 'unknown');
});

test('structured-data-truth: JSON-LD facts the page shows pass, a different labelled value fails, nothing to compare stays unknown', () => {
  const pass = judge('structured-data-truth', { '/': doc('<p>Brew Cafe, call 02-555-0142</p>', phoneNode('02-555-0142')) });
  assert.equal(pass['/'].state, 'pass');
  assert.deepEqual(pass['/'].measurement.matched.map(x => x.type), ['name', 'phone']);
  const fail = judge('structured-data-truth', { '/': doc('<p>Brew Cafe</p><p>Phone: 02-555-0199</p>', phoneNode('02-555-0142')) });
  assert.equal(fail['/'].state, 'fail');
  assert.equal(fail['/'].reason, 'JSON-LD phone "02-555-0142" differs from visible "02-555-0199"');
  assert.deepEqual(fail['/'].problem_messages, [{ message_key: 'structured-data-truth.fact-differs', message_values: { type: 'phone', linked: '02-555-0142', visible: '02-555-0199' } }]);
  const nothing = judge('structured-data-truth', { '/': doc('<p>Welcome</p>', ld({ '@type': 'WebPage', name: 'Welcome' })) });
  assert.equal(nothing['/'].state, 'unknown');
  const broken = judge('structured-data-truth', { '/': doc('', '<script type="application/ld+json">{"@type":</script>') });
  assert.equal(broken['/'].state, 'fail');
  assert.equal(broken['/'].reason, 'JSON-LD block(s) fail to parse');
});

test('jsonLdTruth: an address matches by its street run in any order of the surrounding words, and a name only ever matches', () => {
  const address = { '@type': 'PostalAddress', streetAddress: '10 Main Street', addressLocality: 'Springfield' };
  const shown = jsonLdTruth(doc('<p>Brew Cafe: visit us at 10 Main St, Springfield</p>', ld(node({ telephone: undefined, address }))));
  assert.deepEqual(shown.matched.map(x => x.type), ['name', 'address']);
  const other = jsonLdTruth(doc('<p>Address: 99 Elm Road</p>', ld(node({ telephone: undefined, address }))));
  assert.deepEqual(other.mismatched.map(x => [x.type, x.visible]), [['address', '99 Elm Road']]);
  const unnamed = jsonLdTruth(doc('<p>Welcome</p>', ld(node({ telephone: undefined, name: 'Other Name' }))));
  assert.deepEqual([unnamed.matched, unnamed.mismatched], [[], []], 'a name the page does not show cannot be told from a variant of it');
});

// F6: document-title.
test('document-title: a present, unique title that is more than the site name or a generic word passes with its basis', () => {
  const result = judge('document-title', { '/': doc('', '', 'Brew House coffee and pastries'), '/menu': doc('', '', 'Menu | Brew House') });
  assert.deepEqual(states(result), { '/': 'pass', '/menu': 'pass' });
  assert.deepEqual(result['/menu'].measurement, { title: 'Menu | Brew House', audited_pages: 2, site_name_only: false, generic_word_only: false });
});

test('document-title: the site name alone or a generic word stays unknown, and a missing or repeated title still fails', () => {
  const result = judge('document-title', { '/': doc('', '', 'Site'), '/home': doc('', '', 'Home'), '/ko': doc('', '', '홈페이지'), '/none': '<html><body>x</body></html>',
    '/x': doc('', '', 'Same title'), '/y': doc('', '', 'Same title'), '/dashes': doc('', '', ' - ') });
  assert.deepEqual(states(result), { '/': 'unknown', '/home': 'unknown', '/ko': 'unknown', '/none': 'fail', '/x': 'fail', '/y': 'fail', '/dashes': 'unknown' });
  assert.equal(result['/'].measurement.site_name_only, true, 'the host\'s first label is the site name');
  assert.equal(result['/home'].measurement.generic_word_only, true);
  assert.equal(result['/'].reason, 'Raw HTML has a title; uniqueness and descriptiveness are not established');
});

test('document-title: the generic words are config, in the registry', () => {
  const words = thresholds('document-title').generic_titles;
  assert.ok(words.includes('home') && words.includes('untitled') && words.includes('홈'));
});

// F5: fact-consistency.
test('fact-consistency: a page that states no contact fact is not applicable, one that states a fact without a reference stays unknown', () => {
  const pages = { '/': doc('<p>Phone: 02-555-0142</p>'), '/a': doc('<p>Phone: 02-555-0142</p>'), '/bare': doc('<p>Just a story</p>') };
  const result = judge('fact-consistency', pages);
  assert.deepEqual(states(result), { '/': 'pass', '/a': 'pass', '/bare': 'not_applicable' });
  assert.equal(result['/bare'].applicability_decision.condition, 'no_evaluable_facts');
  assert.equal(result['/bare'].applicability_decision.evidence_ref, result['/bare'].evidence_ref);
  const lone = judge('fact-consistency', { '/': doc('<p>Phone: 02-555-0142</p>'), '/bare': doc('<p>Just a story</p>') });
  assert.deepEqual(states(lone), { '/bare': 'not_applicable' }, 'one page with a phone has nothing to meet: unknown, not excluded');
});

// canonical-consistency.
test('canonical-consistency: no canonical and no redirect is not applicable, one redirect hop passes, a chain still fails', () => {
  const link = `<link rel="canonical" href="${url('/ok')}">`;
  const result = judge('canonical-consistency', { '/': doc(''), '/hop': doc(''), '/chain': doc(''), '/ok': doc('', link) }, { hops: { '/hop': 1, '/chain': 2 } });
  assert.deepEqual(states(result), { '/': 'not_applicable', '/hop': 'pass', '/chain': 'fail', '/ok': 'pass' });
  assert.equal(result['/'].applicability_decision.condition, 'no_representative_url_policy');
});

// discovery.
test('discovery: a page that is neither listed nor linked and cannot be proven an orphan is unknown, with what leaves it open', () => {
  const pages = { '/': doc('<a href="/a">A</a>'), '/a': doc(''), '/lonely': doc('') };
  const cut = judge('discovery', pages, { collection: { limit_reached: true } });
  assert.equal(cut['/lonely'].state, 'unknown');
  assert.equal(cut['/lonely'].measurement.crawl_complete, false);
  assert.equal(cut['/a'].state, 'pass');
  const whole = judge('discovery', pages);
  assert.equal(whole['/lonely'].state, 'fail', 'on a complete crawl the same page is a proven orphan');
});

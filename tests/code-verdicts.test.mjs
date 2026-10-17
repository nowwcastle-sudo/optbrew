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
// The pages of one template load the same stylesheet and script; the render inheritance reads that as its template signal.
const ASSETS = '<link rel="stylesheet" href="/site.css"><script src="/site.js"></script>';
const OTHER_ASSETS = '<link rel="stylesheet" href="/other.css">';
const SHELL = doc('<div id="app">Loading</div>', ASSETS);

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
  const home = pageFacts(doc('<p>Phone: 02-555-0142</p>', ld({ '@graph': [node({ '@id': `${ORIGIN}/#organization` }), subOrganization('Brew Annex'), subOrganization('Brew Kiosk')] })), [url('/')]);
  assert.equal(home.branch, false, 'sub-organization ids are fragments of the home address, which are not the home page itself');
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

test('a branch page that carries the site\'s main organization in its graph is still the branch\'s page (R74)', () => {
  const graph = extra => ld({ '@graph': [node({ '@id': `${ORIGIN}/#organization` }), subOrganization('Brew Gangnam', { '@id': `${ORIGIN}/branches/gangnam#org`, ...extra }), ...(extra.page ? [extra.page] : [])] });
  const html = extra => doc('<p>Phone: 031-111-2222</p>', graph(extra));
  const byUrl = pageFacts(html({ url: url('/gangnam') }), [url('/gangnam')]);
  assert.equal(byUrl.branch, true, 'the sub-organization\'s own url is this page');
  assert.deepEqual([...byUrl.linked.phone.values()], ['031-111-2222'], 'the branch speaks for the page, not the main organization');
  const byId = pageFacts(html({ '@id': url('/gangnam') }), [url('/gangnam')]);
  assert.equal(byId.branch, true, 'an @id that is the page address');
  const branchId = `${ORIGIN}/branches/gangnam#org`;
  const byAbout = pageFacts(html({ '@id': branchId, page: { '@type': 'WebPage', about: { '@id': branchId } } }), [url('/gangnam')]);
  assert.equal(byAbout.branch, true, 'the page names the sub-organization as what it is about');
  const elsewhere = pageFacts(html({ url: url('/gangnam') }), [url('/about')]);
  assert.equal(elsewhere.branch, false, 'on another page the brief rule holds: the main organization is the entity');
  // The same shape on a real run: no deviation is reported against the main phone, the page is separate, and the check on its markup does not fail.
  const pages = { '/': doc('<p>Phone: 02-555-0142</p>', ld(node({ '@id': `${ORIGIN}/#organization` }))), '/a': doc('<p>Phone: 02-555-0142</p>', ld(node({ '@id': `${ORIGIN}/#organization` }))),
    '/gangnam': html({ url: url('/gangnam') }) };
  const shared = prepared(pages);
  assert.deepEqual([...shared.comparison.separate], [url('/gangnam')]);
  assert.deepEqual(shared.comparison.deviations.get(url('/gangnam')), []);
  assert.notEqual(block('structured-data-truth').derive(shared).find(x => x.unit_key.endsWith('/gangnam')).state, 'fail');
});

test('a sub-organization at the site home address never makes the home page a branch page (N-2)', () => {
  for (const address of [url('/'), `${url('/')}#annex`, `${url('/')}?x=1`]) {
    const home = doc('<p>Brew Cafe. Phone: 02-555-0142</p>', ld({ '@graph': [node({ '@id': `${ORIGIN}/#organization` }), subOrganization('Brew Annex', { url: address })] }));
    const facts = pageFacts(home, [url('/')]);
    assert.equal(facts.branch, false, address);
    assert.deepEqual([...facts.linked.phone.values()], ['02-555-0142']);
    assert.equal(judge('structured-data-truth', { '/': home })['/'].state, 'pass', 'the home page is compared on the main organization');
  }
  const byId = pageFacts(doc('', ld({ '@graph': [node({ '@id': `${ORIGIN}/#organization` }), subOrganization('Brew Annex', { '@id': url('/') })] })), [url('/')]);
  assert.equal(byId.branch, false, 'an @id that is the home address');
});

test('about and mainEntity name a branch only when they name exactly one sub-organization (N-3)', () => {
  const idOf = name => `${ORIGIN}/branches/${name}#org`;
  const page = (...names) => doc('<p>Phone: 031-111-2222</p>', ld({ '@graph': [node({ '@id': `${ORIGIN}/#organization` }),
    subOrganization('Gangnam', { '@id': idOf('gangnam') }), subOrganization('Busan', { '@id': idOf('busan'), telephone: '032-222-3333' }),
    { '@type': 'CollectionPage', mainEntity: names.map(name => ({ '@id': name === 'main' ? `${ORIGIN}/#organization` : idOf(name) })) }] }));
  assert.equal(pageFacts(page('gangnam', 'busan'), [url('/locations-page')]).branch, false, 'a page that lists two branches is nobody\'s branch page');
  assert.equal(pageFacts(page('gangnam'), [url('/locations-page')]).branch, true);
  assert.equal(pageFacts(page('main', 'gangnam'), [url('/locations-page')]).branch, true, 'the main organization is not a sub-organization');
  assert.deepEqual([...pageFacts(page('gangnam', 'busan'), [url('/locations-page')]).linked.phone.values()], ['02-555-0142'], 'the brief rule: the main organization speaks');
});

test('real branch site: the home page with department nodes is compared, the branch page is not', () => {
  const pages = {
    '/': doc('<p>Phone: 02-555-0142</p>', ld({ '@graph': [node({ '@id': `${ORIGIN}/#organization` }), subOrganization('Brew Annex')] })),
    '/about': doc('<p>Phone: 02-555-0142</p>', ld(node({ '@id': `${ORIGIN}/#organization` }))),
    '/annex': doc('<p>Phone: 031-111-2222</p>', ld(subOrganization('Brew Annex'))),
  };
  const facts = Object.entries(pages).map(([route, html]) => ({ url: url(route), facts: pageFacts(html, [url(route)]) }));
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
const sampleOf = route => ({ render: { enabled: true, pages: [{ normalized: url(route) }] } });
const styled = (body, assets = ASSETS) => doc(body, assets);

test('render-content: a page inherits a not-applicable verdict from the sampled page of its type', () => {
  const result = judge('render-content', { '/': styled(RICH), '/a': styled(RICH), '/b': styled(RICH) }, { ...sampled('/'), ...sampleOf('/') });
  assert.deepEqual(states(result), { '/': 'not_applicable', '/a': 'not_applicable', '/b': 'not_applicable' });
  const inherited = result['/a'];
  assert.equal(inherited.applicability_decision.condition, 'not_render_dependent');
  assert.ok(inherited.reason.includes(`Inferred from ${url('/')}`), 'the reason names the sampled page');
  assert.equal(inherited.evidence_ref, renderRef('/'), 'the evidence is the sample\'s render record');
  assert.equal(inherited.applicability_decision.evidence_ref, inherited.evidence_ref);
  assert.deepEqual(inherited.measurement.inherited_from, { url: url('/'), state: 'not_applicable', page_type: 'primary', render_ref: renderRef('/') });
  assert.deepEqual(inherited.measurement.template, { scripts: 1, head_assets: 1 }, 'the template signal is in the measurement');
});

test('render-content: a page inherits a pass from the sampled page of its type, and its reason keeps the JavaScript note\'s prefix', () => {
  const shell = styled('<div id="app">loading</div>');
  const result = judge('render-content', { '/': shell, '/a': shell }, { ...sampled('/'), ...sampleOf('/') });
  assert.deepEqual(states(result), { '/': 'pass', '/a': 'pass' });
  assert.ok(result['/a'].reason.startsWith(result['/'].reason), result['/a'].reason);
  assert.match(result['/a'].reason, /inferred from https:\/\/site\.test\/.*raw HTML holds body text too/);
  assert.equal(result['/a'].q, 1);
  assert.ok(result['/a'].measurement.raw_body_characters > 0, 'the page\'s own raw body is the named basis');
});

test('render-content: a blank-raw page gets no verdict under a pass sample, nor under a not-applicable one (R76)', () => {
  const blank = doc('', ASSETS);
  const pass = judge('render-content', { '/': SHELL, '/blank': blank }, { ...sampled('/'), ...sampleOf('/') });
  assert.deepEqual(states(pass), { '/': 'pass' }, 'an empty raw page with the same template has no evidence of its own');
  const notApplicable = judge('render-content', { '/': styled(RICH), '/blank': blank }, { ...sampled('/'), ...sampleOf('/') });
  assert.deepEqual(states(notApplicable), { '/': 'not_applicable' });
});

test('render-content: inheritance needs the sampled page\'s template, also inside a catch-all type (R76)', () => {
  const pages = { '/': styled(RICH), '/same': styled(RICH), '/other': styled(RICH, OTHER_ASSETS), '/bare': doc(RICH) };
  const result = judge('render-content', pages, { ...sampled('/'), ...sampleOf('/') });
  assert.deepEqual(states(result), { '/': 'not_applicable', '/same': 'not_applicable' },
    'a page that loads other assets, or none, is not made by the sample\'s template');
});

test('render-content: nothing is inherited from an unknown or failed sample, from another page type, or without any sample', () => {
  const pages = { '/': SHELL, '/a': SHELL, '/c': SHELL };
  const options = { types: { first: ['/', '/a'], second: ['/c'] }, ...sampleOf('/') };
  const blocked = judge('render-content', pages, { ...options, ...sampled('/', richDom, { status: 403 }) });
  assert.deepEqual(states(blocked), { '/': 'unknown' }, 'a challenge page gives its type nothing to inherit');
  const failed = judge('render-content', pages, { ...options, renders: [rec('/', { dom_ref: null, status: null, blocked_reason: 'render_failed' })] });
  assert.deepEqual(states(failed), { '/': 'unknown' });
  const fine = judge('render-content', pages, { ...options, ...sampled('/') });
  assert.deepEqual(states(fine), { '/': 'pass', '/a': 'pass' }, '/c is another page type: it has no sample');
  const none = judge('render-content', pages, { ...options, renders: [] });
  assert.deepEqual(none, {}, 'no stored render at all, so no verdict');
  const empty = judge('render-content', { '/': doc('', ASSETS), '/a': SHELL }, { ...options, ...sampled('/', '<html><head><title>Page</title></head><body></body></html>') });
  assert.deepEqual(states(empty), { '/': 'fail' }, 'a failed sample is not inherited');
});

test('render-content: the rendered pages of a type must agree, and a record without a ref is not a basis', () => {
  const pages = { '/': styled(RICH), '/b': SHELL, '/c': styled(RICH) };
  const two = judge('render-content', pages, { renders: [rec('/'), rec('/b')], renderHtml: { [url('/')]: richDom, [url('/b')]: richDom },
    render: { enabled: true, pages: [{ normalized: url('/') }, { normalized: url('/b') }] } });
  assert.deepEqual(states(two), { '/': 'not_applicable', '/b': 'pass' }, 'one type holds a not-applicable and a pass, so /c inherits neither');
  const noRef = judge('render-content', { '/': styled(RICH), '/a': styled(RICH) }, { ...sampled('/', richDom, { evidence_ref: undefined }), ...sampleOf('/') });
  assert.deepEqual(states(noRef), { '/': 'not_applicable' }, 'the sampled page\'s render record is the evidence, so without its ref there is nothing to cite');
});

test('render-content: a sampled page never inherits', () => {
  const two = judge('render-content', { '/': SHELL, '/b': SHELL }, { ...sampled('/'), chrome: { found: false, reason: 'chrome_not_found' },
    render: { enabled: true, pages: [{ normalized: url('/') }, { normalized: url('/b') }] } });
  assert.deepEqual(Object.fromEntries(Object.entries(two).map(([route, x]) => [route, x.reason])), { '/': 'Content shows after rendering', '/b': 'chrome_missing' },
    'a page of the sample that was not rendered is unknown, not inherited');
});

// F4: structured-data-truth.
test('structured-data-truth: a page with no markup is not applicable under markup_not_used_or_selected, microdata stays unknown', () => {
  const result = judge('structured-data-truth', { '/': doc('<p>Hello</p>'), '/micro': doc('<div itemscope itemtype="https://schema.org/Product">x</div>') });
  assert.equal(result['/'].state, 'not_applicable');
  assert.equal(result['/'].applicability_decision.condition, 'markup_not_used_or_selected');
  assert.equal(result['/'].applicability_decision.evidence_ref, result['/'].evidence_ref);
  assert.deepEqual(result['/'].measurement, { jsonld_blocks: 0 });
  assert.equal(result['/micro'].state, 'unknown');
});

test('structured-data-truth: every stated fact shown passes, a different labelled value fails, anything else is unknown', () => {
  const pass = judge('structured-data-truth', { '/': doc('<p>Brew Cafe, call 02-555-0142</p>', ld(node())) });
  assert.equal(pass['/'].state, 'pass');
  assert.deepEqual(pass['/'].measurement.matched.map(x => x.type), ['name', 'phone']);
  const fail = judge('structured-data-truth', { '/': doc('<p>Brew Cafe</p><p>Phone: 02-555-0199</p>', ld(node())) });
  assert.equal(fail['/'].state, 'fail');
  assert.equal(fail['/'].reason, 'JSON-LD phone "02-555-0142" differs from visible "02-555-0199"');
  assert.deepEqual(fail['/'].problem_messages, [{ message_key: 'structured-data-truth.fact-differs', message_values: { type: 'phone', linked: '02-555-0142', visible: '02-555-0199' } }]);
  const nothing = judge('structured-data-truth', { '/': doc('<p>Welcome</p>', ld({ '@type': 'WebPage', name: 'Welcome' })) });
  assert.equal(nothing['/'].state, 'unknown');
  const broken = judge('structured-data-truth', { '/': doc('', '<script type="application/ld+json">{"@type":</script>') });
  assert.equal(broken['/'].state, 'fail');
  assert.equal(broken['/'].reason, 'JSON-LD block(s) fail to parse');
});

test('structured-data-truth: a matched name does not pass a page whose stated phone is not shown (R75)', () => {
  const result = judge('structured-data-truth', { '/': doc('<p>Brew Cafe: call us on 010-9999-8888</p>', ld(node())) });
  assert.equal(result['/'].state, 'unknown', 'the phone differs from the only number on the page, but the page does not label it');
  assert.deepEqual(result['/'].measurement.matched.map(x => x.type), ['name']);
  assert.deepEqual(result['/'].measurement.unevaluated.map(x => x.type), ['phone']);
});

test('structured-data-truth: a publisher name alone never passes an Article, its own headline and date do (R75)', () => {
  const article = (extra = {}) => ld({ '@type': 'Article', headline: 'Spring menu announced', datePublished: '2026-03-04T09:00:00+09:00',
    publisher: { '@type': 'Organization', name: 'Brew Cafe' }, ...extra });
  const only = judge('structured-data-truth', { '/': doc('<p>Brew Cafe, 2026 menu</p>', article({ headline: undefined, datePublished: undefined })) });
  assert.equal(only['/'].state, 'unknown', 'a nested publisher is not the page\'s entity and its name proves nothing');
  const shown = judge('structured-data-truth', { '/': doc('<h1>Spring menu announced</h1><time datetime="2026-03-04T09:00">Mar 4</time>', article()),
    '/ko': doc('<h1>Spring menu announced</h1><p>2026년 3월 4일</p>', article()) });
  assert.deepEqual(states(shown), { '/': 'pass', '/ko': 'pass' });
  assert.deepEqual(shown['/'].measurement.matched.map(x => x.type), ['headline', 'date']);
  assert.deepEqual(shown['/'].measurement.matched[1].shown, { text: 'Mar 4', source: 'time' }, 'the matched text and where it came from are recorded');
  assert.deepEqual(shown['/ko'].measurement.matched[1].shown, { text: '2026년 3월 4일', source: 'text' });
  const wrong = judge('structured-data-truth', { '/': doc('<h1>Autumn menu</h1><p>3월 4일</p>', article()) });
  assert.equal(wrong['/'].state, 'fail');
  assert.equal(wrong['/'].reason, 'JSON-LD headline "Spring menu announced" differs from visible "Autumn menu"');
  const undated = judge('structured-data-truth', { '/': doc('<h1>Spring menu announced</h1>', article()) });
  assert.equal(undated['/'].state, 'unknown', 'a date the page does not show is not confirmed');
  assert.deepEqual(undated['/'].measurement.unevaluated.map(x => x.type), ['date']);
});

test('structured-data-truth: a date matches only when year, month and day all match, and a time element must show text (N-1)', () => {
  const article = ld({ '@type': 'Article', headline: 'Spring menu announced', datePublished: '2026-03-04T09:00:00+09:00' });
  const head = '<h1>Spring menu announced</h1>';
  const dateState = body => {
    const result = judge('structured-data-truth', { '/': doc(head + body, article) })['/'];
    return [result.state, result.measurement.matched.some(x => x.type === 'date')];
  };
  assert.deepEqual(dateState('<p>2026년 3월 4일</p>'), ['pass', true]);
  assert.deepEqual(dateState('<p>2025년 3월 4일</p>'), ['unknown', false], 'a different year');
  assert.deepEqual(dateState('<p>3월 4일</p>'), ['unknown', false], 'a month and day without a year is not a date');
  assert.deepEqual(dateState('<p>Mar 4</p>'), ['unknown', false]);
  assert.deepEqual(dateState('<p>2026.03.05</p><p>Posted 2026-02-04</p>'), ['unknown', false], 'unrelated dates on the page');
  assert.deepEqual(dateState('<p>March 4, 2026</p>'), ['pass', true]);
  assert.deepEqual(dateState('<time datetime="2026-03-04">March</time>'), ['pass', true], 'a time element with visible text and a full datetime');
  assert.deepEqual(dateState('<time datetime="2026-03-04"></time>'), ['unknown', false], 'a time element with no visible text');
  assert.deepEqual(dateState('<time datetime="2026-03">March 2026</time>'), ['unknown', false], 'a datetime without a day');
  assert.deepEqual(dateState('<time hidden datetime="2026-03-04">March 4</time>'), ['unknown', false], 'a hidden element');
  assert.deepEqual(dateState('<template><time datetime="2026-03-04">March 4</time></template><script>var t = \'<time datetime="2026-03-04">x</time>\'</script>'),
    ['unknown', false], 'inside template or script');
});

test('structured-data-truth: a headline matches the h1 or title only at four fifths of its length or more (N-4)', () => {
  const article = ld({ '@type': 'Article', headline: 'Brew Cafe news about roasting', datePublished: '2026-03-04' });
  const state = (h1, title) => judge('structured-data-truth', { '/': doc(`<h1>${h1}</h1><p>2026-03-04</p>`, article, title) })['/'];
  assert.equal(state('Brew Cafe news about roasting', 'Brew').state, 'pass');
  assert.equal(state('Totally different story', 'Brew').state, 'fail', 'a short title no longer excuses an h1 that differs');
  assert.equal(state('Brew Cafe news about roasting today', 'x').state, 'pass', 'the headline is more than four fifths of the h1');
  assert.equal(state('Brew Cafe news about roasting and the long history of coffee in town', 'x').state, 'fail', 'the headline is a small part of the h1');
  assert.equal(state('Roasting', 'x').state, 'fail');
});

test('structured-data-truth: a nested parent organization is not the entity of its branch page (R74, review I-1)', () => {
  const branch = { '@type': 'LocalBusiness', name: 'Brew Cafe Gangnam', telephone: '031-111-2222',
    parentOrganization: { '@type': 'Organization', name: 'Brew Cafe', telephone: '02-555-0142' } };
  const result = judge('structured-data-truth', { '/': doc('<p>Brew Cafe Gangnam. Phone: 031-111-2222</p>', ld(branch)) });
  assert.equal(result['/'].state, 'pass', 'the branch is compared with its own phone; the parent\'s phone is not read');
  assert.deepEqual(result['/'].measurement.mismatched, []);
});

test('jsonLdTruth: an address matches by its street run, and a name only matches as whole words or an unspaced script', () => {
  const address = { '@type': 'PostalAddress', streetAddress: '10 Main Street', addressLocality: 'Springfield' };
  const truth = html => jsonLdTruth(html, pageFacts(html));
  const shown = truth(doc('<p>Brew Cafe: visit us at 10 Main St, Springfield</p>', ld(node({ telephone: undefined, address }))));
  assert.deepEqual(shown.matched.map(x => x.type), ['name', 'address']);
  const other = truth(doc('<p>Address: 99 Elm Road</p>', ld(node({ telephone: undefined, address }))));
  assert.deepEqual(other.mismatched.map(x => [x.type, x.visible]), [['address', '99 Elm Road']]);
  assert.deepEqual(other.unevaluated.map(x => x.type), ['name']);
  const short = truth(doc('<p>Welcome to Co and the laboratory</p>', ld(node({ telephone: undefined, name: 'Co' }))));
  assert.deepEqual([short.matched, short.unevaluated.map(x => x.type)], [[], ['name']], 'three letters at least');
  const longer = truth(doc('<p>Welcome to our laboratory</p>', ld(node({ telephone: undefined, name: 'Lab' }))));
  assert.deepEqual(longer.matched, [], 'Lab is not a word of "laboratory"');
  const inside = truth(doc('<p>Brew Cafeteria opens at nine</p>', ld(node({ telephone: undefined }))));
  assert.deepEqual(inside.matched, [], 'Brew Cafe is not a word run of Brew Cafeteria');
  const korean = truth(doc('<p>더청춘요양원 안내</p>', ld(node({ telephone: undefined, name: '더청춘' }))));
  assert.deepEqual(korean.matched.map(x => x.type), ['name'], 'an unspaced script is found as a run of characters');
});

// F6: document-title.
test('document-title: a present, unique title that is more than the site name or a generic word passes with its basis', () => {
  const result = judge('document-title', { '/': doc('', '', 'Brew House coffee and pastries'), '/menu': doc('', '', 'Menu | Brew House') });
  assert.deepEqual(states(result), { '/': 'pass', '/menu': 'pass' });
  assert.deepEqual(result['/menu'].measurement, { title: 'Menu | Brew House', audited_pages: 2, site_name_only: false, generic_word_only: false });
});

test('document-title: one audited page proves no uniqueness, so its title stays unknown (I9 kept)', () => {
  const result = judge('document-title', { '/': doc('', '', 'Brew House coffee and pastries') });
  assert.equal(result['/'].state, 'unknown');
  assert.equal(result['/'].reason, 'Raw HTML has a title; uniqueness and descriptiveness are not established');
  assert.equal(result['/'].measurement.audited_pages, 1);
});

test('document-title: the site name alone or a generic word stays unknown, and a missing or repeated title still fails', () => {
  const result = judge('document-title', { '/': doc('', '', 'Site'), '/home': doc('', '', 'Home'), '/ko': doc('', '', '홈페이지'), '/none': '<html><body>x</body></html>',
    '/x': doc('', '', 'Same title'), '/y': doc('', '', 'Same title'), '/dashes': doc('', '', ' - ') });
  assert.deepEqual(states(result), { '/': 'unknown', '/home': 'unknown', '/ko': 'unknown', '/none': 'fail', '/x': 'fail', '/y': 'fail', '/dashes': 'unknown' });
  assert.equal(result['/'].measurement.site_name_only, true, 'the host\'s first label is the site name');
  assert.equal(result['/home'].measurement.generic_word_only, true);
  assert.equal(result['/'].reason, 'Raw HTML has a title; uniqueness and descriptiveness are not established');
});

test('document-title: og:site_name and the organization name of the JSON-LD are the site name too', () => {
  const result = judge('document-title', {
    '/': doc('', '<meta property="og:site_name" content="Brew House Co">' + ld(node({ name: '청춘데이케어' })), 'Brew House Co'),
    '/ko': doc('', '', '청춘데이케어'), '/about': doc('', '', 'About the roastery') });
  assert.deepEqual(states(result), { '/': 'unknown', '/ko': 'unknown', '/about': 'pass' });
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
  assert.match(result['/bare'].reason, /no labelled, marked-up or tel: contact fact/, 'the reason says what was read, not that the page has no phone at all');
  const lone = judge('fact-consistency', { '/': doc('<p>Phone: 02-555-0142</p>'), '/bare': doc('<p>Just a story</p>') });
  assert.deepEqual(states(lone), { '/bare': 'not_applicable' }, 'one page with a phone has nothing to meet: unknown, not excluded');
});

// canonical-consistency.
test('canonical-consistency: no canonical and no redirect is not applicable, one redirect hop passes, a chain still fails', () => {
  const link = `<link rel="canonical" href="${url('/ok')}">`;
  const result = judge('canonical-consistency', { '/': doc('home', '', 'Home page'), '/hop': doc('hop', '', 'Hop page'), '/chain': doc('chain', '', 'Chain page'), '/ok': doc('ok', link, 'Ok page') },
    { hops: { '/hop': 1, '/chain': 2 } });
  assert.deepEqual(states(result), { '/': 'not_applicable', '/hop': 'pass', '/chain': 'fail', '/ok': 'pass' });
  assert.equal(result['/'].applicability_decision.condition, 'no_representative_url_policy');
});

test('canonical-consistency: a page another audited page repeats by title or body text needs a policy, so it is unknown (I-10)', () => {
  const result = judge('canonical-consistency', { '/': doc('home', '', 'Home page'), '/a': doc('same words', '', 'Alpha'), '/b': doc('same words', '', 'Beta'),
    '/c': doc('other words', '', 'Gamma'), '/d': doc('more words', '', 'Gamma'), '/e': doc('last words', '', 'Epsilon') }, { hops: { '/e': 1 } });
  assert.deepEqual(states(result), { '/': 'not_applicable', '/a': 'unknown', '/b': 'unknown', '/c': 'unknown', '/d': 'unknown', '/e': 'pass' });
  assert.deepEqual(result['/a'].measurement.repeated_with, [url('/b')]);
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

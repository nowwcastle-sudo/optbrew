import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { prepare } from '../skills/optbrew/scripts/core/checks/prepare.mjs';
import { internalNavigation } from '../skills/optbrew/scripts/core/checks/internal-navigation.mjs';
import { localeLinks } from '../skills/optbrew/scripts/core/checks/locale-links.mjs';
import { renderContent } from '../skills/optbrew/scripts/core/checks/render-content.mjs';
import { deriveObservations } from '../skills/optbrew/scripts/core/derive.mjs';
import { openStore } from '../skills/optbrew/scripts/core/evidence-store.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { buildScenario, page, startSite } from './support/review-scenario.mjs';

const ORIGIN = 'https://example.test';
const url = route => `${ORIGIN}${route}`;
const FAMILIES = ['internal-navigation', 'locale-links', 'render-content'];
const doc = (body, head = '', title = 'Page') => `<html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
const link = (route, text) => `<a href="${route}">${text}</a>`;
const alternate = (lang, route) => `<link rel="alternate" hreflang="${lang}" href="${url(route)}">`;

/** Collected raw pages as the check blocks see them: every selected URL answered 200 with its HTML. */
function prepared(pages, { renders = [], renderHtml = {}, chrome, render } = {}) {
  const artifacts = Object.entries(pages).map(([route, body]) => ({ normalized_url: url(route), requested_url: url(route), final_url: url(route),
    capability: 'raw_html', status: 200, content_hash: 'hash', evidence_ref: `evidence/${route}`, redirect_chain: [], header_lines: [], body }));
  const context = { protocol: { engines: ['google'], auxiliary_resources: [],
    families: FAMILIES.map(family_id => ({ family_id, applicable: true })),
    page_types: [{ id: 'primary', urls: artifacts.map(x => ({ normalized: x.normalized_url })) }], ...(render ? { render } : {}) } };
  return prepare({ context, artifacts, textOf: x => x.body, renders, renderTextOf: x => renderHtml[x.url] ?? '',
    ...(chrome === undefined ? {} : { chrome }) });
}
/** One block's observations keyed by the page route. */
const judge = (block, pages, extra) => Object.fromEntries(block.derive(prepared(pages, extra)).map(x => [x.unit_key.slice(block.family_id.length + 1 + ORIGIN.length), x]));
const states = result => Object.fromEntries(Object.entries(result).map(([route, x]) => [route, x.state]));
const record = (route, overrides = {}) => ({ url: url(route), final_url: url(route), status: 200, dom_ref: `dom${route}`, dom_sha256: 'hash',
  title: 'Page', links: [], console_errors: [], requests: [], blocked_reason: null, address_vetting: 'pinned', ...overrides });
const registry = JSON.parse(readFileSync(new URL('../skills/optbrew/references/check-registry.json', import.meta.url), 'utf8')).families;
const thresholdsOf = id => registry.find(x => x.family_id === id).thresholds;

test('internal-navigation: descriptive links within the click limit pass', () => {
  const result = judge(internalNavigation, { '/': doc(link('/about', 'About the cafe')), '/about': doc(link('/menu', 'Our menu')), '/menu': doc('<p>Menu</p>') });
  assert.deepEqual(states(result), { '/': 'pass', '/about': 'pass', '/menu': 'pass' });
  assert.equal(result['/about'].evaluator_type, 'code');
});

test('internal-navigation: a page deeper than max_click_depth fails and the limit itself passes', () => {
  const chain = { '/': doc(link('/a', 'Page A')), '/a': doc(link('/b', 'Page B')), '/b': doc(link('/c', 'Page C')), '/c': doc(link('/d', 'Page D')), '/d': doc('<p>end</p>') };
  const result = judge(internalNavigation, chain);
  assert.deepEqual(states(result), { '/': 'pass', '/a': 'pass', '/b': 'pass', '/c': 'pass', '/d': 'fail' });
  assert.match(result['/d'].reason, /4 clicks/);
  assert.match(result['/d'].reason, /3/);
});

test('internal-navigation: empty and generic anchors above the ratio fail', () => {
  const links = [link('/a', '여기'), link('/b', 'Click HERE'), '<a href="/c"></a>', link('/d', 'Pricing')].join(' ');
  const result = judge(internalNavigation, { '/': doc(links), '/a': doc(''), '/b': doc(''), '/c': doc(''), '/d': doc('') });
  assert.equal(result['/'].state, 'fail');
  assert.match(result['/'].reason, /3 of 4/);
  const fine = judge(internalNavigation, { '/': doc([link('/a', 'Pricing'), link('/b', 'Contact us'), link('/c', 'Menu'), link('/d', 'More')].join(' ')),
    '/a': doc(''), '/b': doc(''), '/c': doc(''), '/d': doc('') });
  assert.equal(fine['/'].state, 'pass', 'one generic anchor in four is at the ratio, not above it');
});

test('internal-navigation: a link counts as weak only when no anchor to its target on the page is descriptive', () => {
  const nav = [link('/menu', '메뉴'), '<a href="/menu"><img src="/i.png"></a>', link('/news', '소식'), link('/news', '더보기'),
    link('/about', '회사소개'), link('/contact', '문의'), '<a href="/contact"></a>'].join('');
  const result = judge(internalNavigation, { '/': doc(nav), '/menu': doc(''), '/news': doc(''), '/about': doc(''), '/contact': doc('') });
  assert.equal(result['/'].state, 'pass');
  assert.match(result['/'].reason, /0 of 4/);
});

test('internal-navigation: an image-only link is labelled by its alt text and an aria-label', () => {
  const result = judge(internalNavigation, { '/': doc('<a href="/a"><img src="/x.png" alt="Home logo"></a><a href="/b" aria-label="Contact us"><svg></svg></a>'), '/a': doc(''), '/b': doc('') });
  assert.equal(result['/'].state, 'pass');
});

test('internal-navigation: a page nothing links to is left to discovery', () => {
  const result = judge(internalNavigation, { '/': doc(link('/a', 'Page A')), '/a': doc(''), '/lost': doc(link('/', 'Back to the home page')), '/lost2': doc('') });
  assert.equal(result['/lost'].state, 'pass');
  assert.equal(result['/lost2'], undefined, 'no click depth and no anchors: nothing to judge here');
});

test('internal-navigation: a site without any internal link is not link based, and unreadable script navigation is unknown', () => {
  const single = judge(internalNavigation, { '/': doc('<p>Hello</p>') });
  assert.equal(single['/'].state, 'not_applicable');
  assert.equal(single['/'].applicability_decision.condition, 'not_link_based');
  const scripted = judge(internalNavigation, { '/': doc('<div id="app"></div><script src="/app.js"></script>') });
  assert.equal(scripted['/'].state, 'unknown');
});

test('locale-links: reciprocal hreflang with x-default passes', () => {
  const head = alternate('en', '/en') + alternate('ko', '/ko') + alternate('x-default', '/en');
  const result = judge(localeLinks, { '/en': doc('', head), '/ko': doc('', head) });
  assert.deepEqual(states(result), { '/en': 'pass', '/ko': 'pass' });
});

test('locale-links: a missing x-default and a missing return link fail', () => {
  const noDefault = alternate('en', '/en') + alternate('ko', '/ko');
  const result = judge(localeLinks, { '/en': doc('', noDefault), '/ko': doc('', noDefault) });
  assert.deepEqual(states(result), { '/en': 'fail', '/ko': 'fail' });
  assert.match(result['/en'].reason, /x-default/);
  const oneWay = judge(localeLinks, { '/en': doc('', alternate('ko', '/ko') + alternate('x-default', '/en')), '/ko': doc('', alternate('x-default', '/ko')) });
  assert.equal(oneWay['/en'].state, 'fail');
  assert.match(oneWay['/en'].reason, /\/ko does not link back/);
});

test('locale-links: a page that others list as an alternate but declares none fails', () => {
  const result = judge(localeLinks, { '/en': doc('', alternate('ko', '/ko') + alternate('x-default', '/en')), '/ko': doc('') });
  assert.equal(result['/ko'].state, 'fail');
  assert.match(result['/ko'].reason, /\/en/);
});

test('locale-links: no hreflang anywhere is a single-locale site', () => {
  const result = judge(localeLinks, { '/': doc(''), '/about': doc('') });
  assert.deepEqual(states(result), { '/': 'not_applicable', '/about': 'not_applicable' });
  assert.equal(result['/'].applicability_decision.condition, 'single_locale');
});

test('locale-links: a page whose only hreflang points at itself is a single-locale page', () => {
  for (const head of [alternate('ko', '/'), alternate('ko', '/') + alternate('x-default', '/')]) {
    const result = judge(localeLinks, { '/': doc('', head), '/about': doc('') });
    assert.deepEqual([result['/'].state, result['/'].applicability_decision.condition], ['not_applicable', 'single_locale']);
  }
});

test('locale-links: an alternate that was not collected cannot be checked and stays unknown', () => {
  const result = judge(localeLinks, { '/en': doc('', alternate('ko', '/ko') + alternate('x-default', '/en')) });
  assert.equal(result['/en'].state, 'unknown');
});

const RICH = '<h1>Welcome to the brew house</h1><p>Fresh coffee roasted every morning, pastries baked on site, and a quiet room to work in until late.</p>';
const richDom = `<html><head><title>Page</title></head><body>${RICH}${link('/a', 'Page A')}</body></html>`;

test('render-content: a page whose raw HTML already has the content is not render dependent', () => {
  const result = judge(renderContent, { '/': doc(RICH + link('/a', 'Page A')) },
    { renders: [record('/', { links: [url('/a')] })], renderHtml: { [url('/')]: richDom }, chrome: { found: true, reason: null } });
  assert.equal(result['/'].state, 'not_applicable');
  assert.equal(result['/'].applicability_decision.condition, 'not_render_dependent');
});

test('render-content: content that only the render shows passes, and a blank page in both fails', () => {
  const shell = doc('<div id="app"></div><script src="/app.js"></script>');
  const options = dom => ({ renders: [record('/')], renderHtml: { [url('/')]: dom }, chrome: { found: true, reason: null } });
  const shown = judge(renderContent, { '/': shell }, options(richDom));
  assert.equal(shown['/'].state, 'pass');
  assert.equal(shown['/'].reason, 'Content shows after rendering', 'the reason is the same for every page');
  assert.ok(shown['/'].measurement.rendered_body_characters > shown['/'].measurement.raw_body_characters, 'the counts are in the measurement');
  const blank = judge(renderContent, { '/': shell }, options('<html><head><title>Page</title></head><body></body></html>'));
  assert.equal(blank['/'].state, 'fail');
});

test('render-content: a challenge page is unknown, not fail', () => {
  const shell = doc('<div id="app"></div>');
  const byStatus = judge(renderContent, { '/': shell }, { renders: [record('/', { status: 403 })],
    renderHtml: { [url('/')]: '<html><body></body></html>' }, chrome: { found: true, reason: null } });
  assert.deepEqual([byStatus['/'].state, byStatus['/'].reason], ['unknown', 'render_blocked']);
  const byMarker = judge(renderContent, { '/': shell }, { renders: [record('/', { title: 'Just a moment...' })],
    renderHtml: { [url('/')]: '<html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing the site.</p></body></html>' },
    chrome: { found: true, reason: null } });
  assert.deepEqual([byMarker['/'].state, byMarker['/'].reason], ['unknown', 'render_blocked']);
});

test('render-content: missing chrome is unknown with chrome_missing, for the pages of the render sample only', () => {
  const shell = { '/': doc('<div id="app"></div>'), '/other': doc('<div id="app"></div>') };
  for (const chrome of [{ found: false, reason: 'chrome_not_found' }, undefined, null]) {
    const result = judge(renderContent, shell, chrome === undefined ? {} : { chrome });
    assert.deepEqual([result['/'].state, result['/'].reason], ['unknown', 'chrome_missing'], JSON.stringify(chrome));
    assert.equal(result['/other'], undefined, 'the first URL of a page type is rendered, the others are not');
  }
});

test('chrome_missing follows the run\'s fixed render pages', () => {
  const pages = { '/': doc('<div id="app"></div>'), '/other': doc('<div id="app"></div>'), '/third': doc('<div id="app"></div>') };
  const fixed = judge(renderContent, pages, { chrome: { found: false, reason: 'chrome_not_found' },
    render: { enabled: true, pages: [{ original: url('/third'), normalized: url('/third') }, { original: url('/other'), normalized: url('/other') }] } });
  assert.deepEqual(Object.keys(fixed).sort(), ['/other', '/third'], 'selectRenderPages would pick / instead');
  assert.deepEqual(Object.values(fixed).map(x => x.reason), ['chrome_missing', 'chrome_missing']);
  const off = judge(renderContent, pages, { chrome: null, render: { enabled: false, pages: [] } });
  assert.deepEqual(off, {}, 'rendering was not requested, so no page is waiting for Chrome');
});

test('render-content: a render matches its page by canonical URL, whether recorded under url or final_url', () => {
  const pages = { '/': doc('<div id="app"></div>') };
  const options = overrides => ({ renders: [record('/', overrides)], renderHtml: { [url('/')]: richDom, [url('/index.html')]: richDom, [url('/start')]: richDom }, chrome: { found: true, reason: null } });
  assert.equal(judge(renderContent, pages, options({ url: url('/index.html'), final_url: url('/index.html') }))['/']?.state, 'pass');
  assert.equal(judge(renderContent, pages, options({ url: `${ORIGIN}/start`, final_url: url('/') }))['/']?.state, 'pass');
});

test('render-content: a long page that mentions a challenge phrase is judged, a short one is blocked', () => {
  const article = `<h1>Notes</h1><p>Attention required: renew the permit before May. ${'The brew house keeps its permits current. '.repeat(30)}</p>`;
  const options = { renders: [record('/')], renderHtml: { [url('/')]: `<html><head><title>Page</title></head><body>${article}</body></html>` }, chrome: { found: true, reason: null } };
  assert.equal(judge(renderContent, { '/': doc('<div id="app"></div>') }, options)['/'].state, 'pass');
  const short = { ...options, renderHtml: { [url('/')]: '<html><head><title>Page</title></head><body><p>Attention required</p></body></html>' } };
  assert.equal(judge(renderContent, { '/': doc('<div id="app"></div>') }, short)['/'].reason, 'render_blocked');
});

test('render-content: a page outside the render sample gets no verdict, and a failed render is unknown', () => {
  const pages = { '/': doc('<div id="app"></div>'), '/other': doc('<div id="app"></div>') };
  const failed = judge(renderContent, pages, { renders: [record('/', { dom_ref: null, status: null, blocked_reason: 'render_failed' })], chrome: { found: true, reason: null } });
  assert.deepEqual([failed['/'].state, failed['/'].reason], ['unknown', 'render_failed']);
  assert.equal(failed['/other'], undefined);
});

test('the three new thresholds are pinned', () => {
  assert.deepEqual(thresholdsOf('internal-navigation'), { max_click_depth: 3, empty_anchor_ratio: 0.25,
    generic_anchor_terms: ['여기', '클릭', 'click here', 'more', '더보기'] });
  assert.deepEqual(thresholdsOf('locale-links'), {});
  assert.deepEqual(thresholdsOf('render-content'), { min_body_ratio: 0.8, challenge_status: [403, 429, 503], challenge_max_body_chars: 600,
    challenge_markers: ['just a moment', 'checking your browser', 'attention required', 'verify you are human', 'enable javascript and cookies to continue'] });
});

/**
 * An audited local site: `/` is a script shell and `/ko` carries the content, both with a reciprocal hreflang pair. The shell has a
 * stored render, as the render stage will leave it, and Chrome is recorded as found. The packet's observations are still the ones the
 * audit derived without the render until `forged()` replaces them with what the replay derives.
 */
async function replayable() {
  let origin = '';
  const hreflang = () => [['en', '/'], ['ko', '/ko'], ['x-default', '/']]
    .map(([lang, route]) => `<link rel="alternate" hreflang="${lang}" href="${origin}${route}">`).join('');
  const site = await startSite({
    '/': () => ({ body: page(hreflang(), `<div id="app"></div>${link('/ko', 'Korean site')}`, 'Brew') }),
    '/ko': () => ({ body: page(hreflang(), RICH + link('/', 'English site'), '브루') }),
  });
  origin = site.origin;
  try { return await storedRender(site, origin); } catch (error) { await site.close(); throw error; }
}

async function storedRender(site, origin) {
  const scenario = await buildScenario(site, ['/', '/ko'], { enable: FAMILIES, name: 'checks-new', render: ['/'] });
  const dom =`<html><head><title>Brew</title></head><body>${RICH}${link('/ko', 'Korean site')}</body></html>`;
  const store = openStore(scenario.evidence(''));
  const domFile = await store.write('render-dom', dom);
  const rendered = { url: `${origin}/`, final_url: `${origin}/`, status: 200, dom_ref: domFile.ref, dom_sha256: domFile.sha256, title: 'Brew',
    links: [`${origin}/ko`], console_errors: [], requests: [], blocked_reason: null, address_vetting: 'pinned' };
  const recordFile = await store.write('render', `${JSON.stringify(rendered, null, 2)}\n`);
  await store.append('renders', { url: rendered.url, evidence_ref: recordFile.ref, sha256: recordFile.sha256 });
  await scenario.add(domFile.ref, 'render_dom');
  await scenario.add(recordFile.ref, 'render');
  const chrome = { found: true, reason: null };
  const indexRef = scenario.evidence('evidence-index.json');
  await scenario.rewrite(indexRef, index => { index.chrome = chrome; });
  const derived = deriveObservations({ context: scenario.context, artifacts: scenario.audit.artifacts, collection: scenario.audit,
    textOf: x => x.content_hash ? readFileSync(x.evidence_ref, 'utf8') : null, renders: [rendered], renderTextOf: () => dom, chrome });
  const forged = () => scenario.forgeObservations(list => list.splice(0, list.length, ...list.filter(x => x.family_id !== 'render-content'),
    ...derived.filter(x => x.family_id === 'render-content')));
  return { site, scenario, derived, forged, indexRef, domFile, recordFile, origin };
}

const sha = text => createHash('sha256').update(text).digest('hex');
const verdicts = (observations, family) => Object.fromEntries(observations.filter(x => x.family_id === family)
  .map(x => [x.unit_key.split('|')[1].replace(/^http:\/\/[^/]+/, ''), x.state]));

test('report replay recomputes the three new families from stored evidence', { timeout: 120000 }, async () => {
  const run = await replayable();
  try {
    assert.deepEqual(verdicts(run.derived, 'internal-navigation'), { '/': 'pass', '/ko': 'pass' });
    assert.deepEqual(verdicts(run.derived, 'locale-links'), { '/': 'pass', '/ko': 'pass' });
    assert.deepEqual(verdicts(run.derived, 'render-content'), { '/': 'pass' }, 'only the rendered page has a render verdict');
    assert.throws(() => buildReport(run.scenario.packet), /collector verdict differs from raw evidence: render-content/,
      'the audit derived chrome_missing, the stored render says otherwise');
    await run.forged();
    assert.ok(buildReport(run.scenario.packet).json.baseline.scores.length > 0);
    await run.scenario.forgeObservations(list => {
      const forgedRow = list.find(x => x.family_id === 'render-content');
      forgedRow.state = 'fail'; forgedRow.q = 0;
    });
    assert.throws(() => buildReport(run.scenario.packet), /collector verdict differs from raw evidence/);
  } finally { await run.site.close(); }
});

test('report replay rejects a render ledger that does not match the stored requests', { timeout: 120000 }, async () => {
  const run = await replayable();
  try {
    await run.forged();
    const entry = page => ({ page, url: `${run.origin}/x.js`, requests: 1, outcome: 'response', skipped_reason: null, error: null });
    await run.scenario.rewrite(run.indexRef, index => { index.render_ledger = [entry(`${run.origin}/`)]; });
    assert.throws(() => buildReport(run.scenario.packet), /render ledger/);
    await run.scenario.rewrite(run.indexRef, index => { index.render_ledger = [entry(`${run.origin}/ko`)]; });
    assert.throws(() => buildReport(run.scenario.packet), /render ledger/, 'an entry for a page that was not rendered');
  } finally { await run.site.close(); }
});

test('report replay rejects render evidence that no longer matches the audit index', { timeout: 120000 }, async () => {
  const run = await replayable();
  try {
    await run.forged();
    await run.scenario.rewrite(run.recordFile.ref, record => { record.title = 'Other'; });
    assert.throws(() => buildReport(run.scenario.packet), /render record hash differs from the audit index/);
  } finally { await run.site.close(); }
  const second = await replayable();
  try {
    await second.forged();
    const dom = '<html><body><p>swapped</p></body></html>';
    await writeFile(second.domFile.ref, dom);
    second.scenario.packet.evidence_index.find(x => x.ref === second.domFile.ref).sha256 = sha(dom);
    assert.throws(() => buildReport(second.scenario.packet), /render DOM hash differs from its record/);
  } finally { await second.site.close(); }
});

test('report replay scans stored renders for secrets', { timeout: 120000 }, async () => {
  const run = await replayable();
  try {
    await run.forged();
    const dom = `<html><body><p>${'sk-ant-' + 'api03-' + 'a'.repeat(40)}</p></body></html>`;
    await writeFile(run.domFile.ref, dom);
    run.scenario.packet.evidence_index.find(x => x.ref === run.domFile.ref).sha256 = sha(dom);
    assert.throws(() => buildReport(run.scenario.packet), /private identifier or secret in report evidence/);
  } finally { await run.site.close(); }
});

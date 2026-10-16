import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { buildScenario, startSite } from './support/review-scenario.mjs';

const base = req => `http://${req.headers.host}`;
/** Full document; every part can be dropped or replaced to seed one defect. */
const doc = (req, path, o = {}) => ({ body: `<!doctype html><html lang="en"><head><meta charset="utf-8">${o.viewport === false ? '' : '<meta name="viewport" content="width=device-width">'}` +
  `<title>${o.title ?? `Page ${path}`}</title>${o.desc === false ? '' : '<meta name="description" content="A page with enough description to summarize it.">'}` +
  `${o.canonical === null ? '' : `<link rel="canonical" href="${o.canonical ?? `${base(req)}${path}`}">`}` +
  `${o.og === false ? '' : `<meta property="og:title" content="t"><meta property="og:description" content="d"><meta property="og:image" content="${base(req)}/i.png"><meta property="og:url" content="${base(req)}${path}"><meta property="og:type" content="website">`}` +
  `${o.head ?? ''}</head><body>${o.main ?? `<h1>${path}</h1><p>Body text for ${path}.</p>`}</body></html>` });
const hub = (req, paths) => doc(req, '/hub', { canonical: null, main: `<h1>Hub</h1><ul>${paths.map(p => `<li><a href="${p}">${p}</a></li>`).join('')}</ul>` });
const text = body => ({ headers: { 'content-type': 'text/plain' }, body });

const sites = [];
const open = async routes => { const site = await startSite(routes); sites.push(site); return site; };
after(() => Promise.all(sites.map(x => x.close())));
let counter = 0;
async function run(t, site, paths, options = {}) {
  const scenario = await buildScenario(site, paths, { ...options, name: `d${++counter}` });
  t.after(() => rm(scenario.dir, { recursive: true, force: true }));
  return scenario;
}
const stateOf = (scenario, family, urlPath, engine) => scenario.packet.baseline.input.observations
  .find(x => x.unit_key === `${family}|${engine ? `${engine}|` : ''}${scenario.context.target.replace(/\/[^/]*$/, '')}${urlPath}`)?.state;
const reasonOf = (scenario, family, urlPath) => scenario.packet.baseline.input.observations
  .find(x => x.unit_key === `${family}|${scenario.context.target.replace(/\/[^/]*$/, '')}${urlPath}`)?.reason ?? '';

// ---- Fix 3: Naver markup on collected evidence
const naverSite = await open({
  '/n-clean': (req) => doc(req, '/n-clean'),
  '/n-no-og': (req) => doc(req, '/n-no-og', { og: false }),
  '/n-rel-canon': (req) => doc(req, '/n-rel-canon', { canonical: '/n-rel-canon' }),
  '/n-stuff': (req) => doc(req, '/n-stuff', { title: 'Coffee coffee coffee coffee beans' }),
  '/n-no-desc': (req) => doc(req, '/n-no-desc', { desc: false }),
  '/n-css': (req) => doc(req, '/n-css', { head: '<link rel="stylesheet" href="/assets/site.css">' }),
  '/robots.txt': text('User-agent: Yeti\nDisallow: /assets/\n'),
});

test('Fix 3: Naver markup checks run on collected evidence and emit naver-markup observations', async t => {
  const paths = ['/n-clean', '/n-no-og', '/n-rel-canon', '/n-stuff', '/n-no-desc', '/n-css'];
  const scenario = await run(t, naverSite, paths, { engines: ['naver'], robots: true });
  const state = path => scenario.packet.baseline.input.observations.find(x => x.unit_key === `naver-markup|naver|${naverSite.origin}${path}`);
  assert.equal(state('/n-clean')?.state, 'pass');
  for (const [path, pattern] of [['/n-no-og', /og:image is missing/], ['/n-rel-canon', /canonical is relative/], ['/n-stuff', /title repeats: coffee/],
    ['/n-no-desc', /meta description is missing/], ['/n-css', /Yeti cannot fetch \/assets\/site\.css/]]) {
    assert.equal(state(path)?.state, 'fail', path);
    assert.match(state(path).reason, pattern, path);
  }
  assert.doesNotThrow(() => buildReport(scenario.packet));
  await scenario.forgeObservations(list => Object.assign(list.find(x => x.unit_key.endsWith('/n-no-og') && x.family_id === 'naver-markup'), { state: 'pass', q: 1, reason: 'forged' }));
  assert.throws(() => buildReport(scenario.packet), /collector verdict differs from raw evidence: naver-markup/);
  const dropped = await run(t, naverSite, paths, { engines: ['naver'], robots: true });
  await dropped.forgeObservations(list => list.splice(list.findIndex(x => x.unit_key.endsWith('/n-css') && x.family_id === 'naver-markup'), 1));
  assert.throws(() => buildReport(dropped.packet), /planned collector observation missing: naver-markup/);
});

// ---- Fix 4: duplicate titles, canonical, redirect chain, sitemap, AI crawler rules
const linkPaths = ['/c-ok', '/c-bad', '/chain-a'];
const structure = listOrphan => ({
  '/hub': req => hub(req, linkPaths),
  '/c-ok': req => doc(req, '/c-ok'),
  '/c-bad': req => doc(req, '/c-bad', { canonical: `${base(req)}/gone` }),
  '/chain-a': { status: 301, headers: { location: '/chain-b' } },
  '/chain-b': { status: 302, headers: { location: '/chain-c' } },
  '/chain-c': req => doc(req, '/chain-c'),
  '/orphan': req => doc(req, '/orphan'),
  '/dup-1': req => doc(req, '/dup-1', { title: 'Same title' }),
  '/dup-2': req => doc(req, '/dup-2', { title: 'Same title' }),
  ...(listOrphan ? { '/sitemap.xml': req => ({ headers: { 'content-type': 'application/xml' }, body: `<urlset><url><loc>${base(req)}/orphan</loc></url></urlset>` }) } : {}),
});
const noSitemap = await open(structure(false));
const withSitemap = await open(structure(true));

test('Fix 4: canonical target, redirect chain, orphan page and sitemap status become observations', async t => {
  const paths = ['/hub', '/c-ok', '/c-bad', '/chain-a', '/orphan'];
  const scenario = await run(t, noSitemap, paths, { enable: ['canonical-consistency'], sitemap: true });
  assert.equal(stateOf(scenario, 'canonical-consistency', '/c-ok'), 'pass');
  assert.equal(stateOf(scenario, 'canonical-consistency', '/c-bad'), 'fail');
  assert.match(reasonOf(scenario, 'canonical-consistency', '/c-bad'), /returns HTTP 404/);
  assert.equal(stateOf(scenario, 'canonical-consistency', '/chain-a'), 'fail');
  assert.match(reasonOf(scenario, 'canonical-consistency', '/chain-a'), /Redirect chain of 2 hops/);
  assert.equal(stateOf(scenario, 'canonical-consistency', '/hub'), undefined, 'no canonical and no chain stays unknown');
  assert.equal(stateOf(scenario, 'discovery', '/orphan'), 'fail');
  assert.match(reasonOf(scenario, 'discovery', '/orphan'), /declared sitemap unusable: .*sitemap\.xml \(404\)/);
  assert.equal(stateOf(scenario, 'discovery', '/c-ok'), 'pass');
  assert.doesNotThrow(() => buildReport(scenario.packet));
  await scenario.forgeObservations(list => Object.assign(list.find(x => x.family_id === 'canonical-consistency' && x.unit_key.endsWith('/c-bad')), { state: 'pass', q: 1, reason: 'forged' }));
  assert.throws(() => buildReport(scenario.packet), /collector verdict differs from raw evidence: canonical-consistency/);
  const orphanForged = await run(t, noSitemap, paths, { enable: ['canonical-consistency'], sitemap: true });
  await orphanForged.forgeObservations(list => list.splice(list.findIndex(x => x.family_id === 'discovery' && x.unit_key.endsWith('/orphan')), 1));
  assert.throws(() => buildReport(orphanForged.packet), /planned collector observation missing: discovery/);
});

test('Fix 4: a page listed in a reachable declared sitemap is discoverable, and duplicate titles fail', async t => {
  const scenario = await run(t, withSitemap, ['/hub', '/orphan', '/dup-1', '/dup-2'], { sitemap: true });
  assert.equal(stateOf(scenario, 'discovery', '/orphan'), 'pass');
  assert.match(reasonOf(scenario, 'discovery', '/orphan'), /Listed in a declared sitemap/);
  assert.equal(stateOf(scenario, 'document-title', '/dup-1'), 'fail');
  assert.equal(stateOf(scenario, 'document-title', '/dup-2'), 'fail');
  assert.equal(reasonOf(scenario, 'document-title', '/dup-1'), 'Title duplicates the title of other pages', 'the reason is the same on every page');
  const dup = scenario.packet.baseline.input.observations.find(x => x.unit_key.endsWith('/dup-1') && x.family_id === 'document-title');
  assert.match(dup.measurement.duplicate_pages.join(' '), /\/dup-2/, 'the other page is in the measurement');
  assert.equal(stateOf(scenario, 'document-title', '/hub'), 'unknown');
  assert.doesNotThrow(() => buildReport(scenario.packet));
});

const aiSite = await open({
  '/ai-page': req => doc(req, '/ai-page'),
  '/private/x': req => doc(req, '/private/x'),
  '/robots.txt': text('User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /private\n\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n'),
});

test('Fix 4: AI search bots are judged per declared engine; training bots earn and cost nothing', async t => {
  const engines = ['google', 'chatgpt', 'claude', 'perplexity'];
  const scenario = await run(t, aiSite, ['/ai-page', '/private/x'], { engines, robots: true });
  const crawl = (engine, path) => stateOf(scenario, 'search-crawl-policy', path, engine);
  assert.equal(crawl('google', '/ai-page'), 'pass');
  assert.equal(crawl('chatgpt', '/ai-page'), 'pass');
  assert.equal(crawl('chatgpt', '/private/x'), 'fail');
  assert.equal(crawl('claude', '/ai-page'), 'pass', 'ClaudeBot (training) is blocked but Claude-SearchBot is allowed');
  assert.equal(crawl('perplexity', '/ai-page'), 'fail');
  const units = scenario.packet.baseline.input.observations.filter(x => x.family_id === 'search-crawl-policy').map(x => x.unit_key);
  assert.ok(!units.some(x => /gptbot|claudebot|google-extended/i.test(x)));
  assert.equal(units.length, 8);
  assert.doesNotThrow(() => buildReport(scenario.packet));
  await scenario.forgeObservations(list => Object.assign(list.find(x => x.unit_key.includes('|perplexity|') && x.unit_key.endsWith('/ai-page')), { state: 'pass', q: 1, reason: 'forged' }));
  assert.throws(() => buildReport(scenario.packet), /crawl verdict differs from bound robots evidence/);
});

// ---- Fix 5: LLMO cross-page facts
const N = 'Brewline Coffee Roasters', ADDR = '27 Wausan-ro, Mapo-gu, Seoul 04050', TEL = '+82-2-555-0142';
const facts = (o = {}) => `<p>Address: ${o.addr ?? ADDR}</p><p>Phone: ${o.tel ?? TEL}</p><p>Founded: ${o.year ?? 2014}</p>`;
const orgLd = (o = {}) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: o.name ?? N, url: 'https://x.test/',
  telephone: o.tel ?? TEL, address: ADDR, ...(o.sameAs === false ? {} : { sameAs: ['https://example.org/brewline'] }) })}</script>`;
const factPaths = ['/', '/contact', '/faq', '/press', '/store', '/support', '/history', '/about', '/ld-phone'];
const factPage = (path, o = {}) => req => doc(req, path, { title: `Title ${path}`, head: o.ld ?? '', main: `<h1>${path}</h1>${facts(o)}${o.extra ?? ''}` });
const llmoSite = await open({
  '/': req => doc(req, '/', { title: 'Home', main: `<h1>${N}</h1>${facts()}<ul>${factPaths.slice(1).map(p => `<li><a href="${p}">${p}</a></li>`).join('')}</ul>` }),
  '/contact': factPage('/contact', { ld: orgLd() }), '/faq': factPage('/faq', { ld: orgLd() }),
  '/press': factPage('/press', { ld: orgLd({ name: 'BrewLine Coffee Co.' }) }), '/store': factPage('/store', { addr: '112 Seongsu-ro, Seongdong-gu, Seoul 04790' }),
  '/support': factPage('/support', { tel: '+82-2-555-0199' }), '/history': factPage('/history', { year: 2016 }),
  '/about': factPage('/about', { ld: orgLd({ sameAs: false }) }), '/ld-phone': factPage('/ld-phone', { ld: orgLd({ tel: '+82-2-555-0188' }) }),
});

test('Fix 5: cross-page entity facts produce fact-consistency and entity-identity observations', async t => {
  const scenario = await run(t, llmoSite, factPaths, { enable: ['fact-consistency', 'entity-identity'] });
  const fact = path => scenario.packet.baseline.input.observations.find(x => x.family_id === 'fact-consistency' && x.unit_key === `fact-consistency|${llmoSite.origin}${path}`);
  for (const path of ['/', '/contact', '/faq']) assert.equal(fact(path)?.state, 'pass', path);
  for (const [path, pattern] of [['/press', /name "BrewLine Coffee Co\."/], ['/store', /address "112 Seongsu-ro/], ['/support', /phone "\+82-2-555-0199"/],
    ['/history', /year "2016" differs from "2014"/], ['/ld-phone', /phone in JSON-LD "\+82-2-555-0188" differs from visible/]]) {
    assert.equal(fact(path)?.state, 'fail', path);
    assert.match(fact(path).reason, pattern, path);
  }
  const entity = scenario.packet.baseline.input.observations.find(x => x.family_id === 'entity-identity');
  assert.equal(entity.unit_key, 'entity-identity|site');
  assert.equal(entity.state, 'fail');
  assert.match(entity.reason, /the business name differs between pages/);
  assert.match(entity.reason, /Organization JSON-LD lacks sameAs on some pages/);
  assert.match(entity.reason, /no Organization or LocalBusiness JSON-LD on the home page/);
  assert.equal(entity.measurement.name_reference, 'Brewline Coffee Roasters');
  assert.match(entity.measurement.name_differs_on.join(' '), /\/press/);
  assert.match(entity.measurement.without_same_as_on.join(' '), /\/about/);
  assert.doesNotThrow(() => buildReport(scenario.packet));
  await scenario.forgeObservations(list => Object.assign(list.find(x => x.family_id === 'fact-consistency' && x.unit_key.endsWith('/support')), { state: 'pass', q: 1, reason: 'forged' }));
  assert.throws(() => buildReport(scenario.packet), /collector verdict differs from raw evidence: fact-consistency/);
  const dropped = await run(t, llmoSite, factPaths, { enable: ['fact-consistency', 'entity-identity'] });
  await dropped.forgeObservations(list => list.splice(list.findIndex(x => x.family_id === 'entity-identity'), 1));
  assert.throws(() => buildReport(dropped.packet), /planned collector observation missing: entity-identity/);
});

test('Fix 5: too little data stays unknown, never a pass', async t => {
  const scenario = await run(t, llmoSite, ['/', '/store'], { enable: ['fact-consistency', 'entity-identity'] });
  assert.equal(scenario.packet.baseline.input.observations.some(x => x.family_id === 'entity-identity'), false, 'no Organization data');
  const one = await run(t, llmoSite, ['/press'], { enable: ['fact-consistency'] });
  assert.equal(one.packet.baseline.input.observations.some(x => x.family_id === 'fact-consistency'), false, 'one page cannot establish a reference');
});

// ---- Fix 6: module-only signals
const ldSite = await open({
  '/bad-ld': req => doc(req, '/bad-ld', { head: '<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[</script>' }),
  '/good-ld': req => doc(req, '/good-ld', { head: '<script type="application/ld+json">{"@type":"WebPage"}</script>' }),
});

test('Fix 6: a JSON-LD parse error reaches the report as a structured-data-truth failure bound to raw evidence', async t => {
  const scenario = await run(t, ldSite, ['/bad-ld', '/good-ld'], { enable: ['structured-data-truth'] });
  assert.equal(stateOf(scenario, 'structured-data-truth', '/bad-ld'), 'fail');
  assert.equal(stateOf(scenario, 'structured-data-truth', '/good-ld'), undefined);
  assert.equal(scenario.audit.module_outputs['naver-searchadvisor'].find(x => x.url.endsWith('/bad-ld')).jsonld_parse_errors, 1);
  const bad = scenario.observation('structured-data-truth', '/bad-ld');
  scenario.packet.findings = [scenario.finding(bad, { blocker: false, priority: 'P1', message: 'JSON-LD does not parse' })];
  const report = buildReport(scenario.packet);
  assert.equal(report.json.findings.find(x => x.check_id === 'structured-data-truth').unit_key, bad.unit_key);
  await scenario.forgeObservations(list => list.splice(list.findIndex(x => x.family_id === 'structured-data-truth'), 1));
  scenario.packet.findings = [];
  assert.throws(() => buildReport(scenario.packet), /planned collector observation missing: structured-data-truth/);
});

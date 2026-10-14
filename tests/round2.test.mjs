import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, scoreHeadline } from '../skills/optbrew/scripts/core/report.mjs';
import { buildScenario, startSite } from './support/review-scenario.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = req => `http://${req.headers.host}`;
const doc = (req, p, o = {}) => ({ body: `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>${o.title ?? `Page ${p}`}</title>` +
  `<meta name="description" content="Description for ${p}"><link rel="canonical" href="${base(req)}${o.canonicalPath ?? p}">${o.head ?? ''}</head><body>${o.main ?? `<p>${p}</p>`}</body></html>` });
const nav = '<nav><a href="/">Home</a><a href="/a">A</a><a href="/b">B</a></nav>';
const family = ['fact-consistency', 'entity-identity', 'discovery', 'canonical-consistency', 'structured-data-truth'];
const sites = [];
after(() => Promise.all(sites.map(x => x.close())));
let counter = 0;
async function build(t, routes, paths, options = {}) {
  const site = await startSite(routes); sites.push(site);
  const scenario = await buildScenario(site, paths, { enable: family, ...options, name: `r2-${++counter}` });
  t.after(() => rm(scenario.dir, { recursive: true, force: true }));
  scenario.site = site;
  return scenario;
}
const fails = s => s.packet.baseline.input.observations.filter(x => x.state === 'fail' && x.family_id !== 'fetch-response');
const failAt = (s, fam, p) => s.packet.baseline.input.observations.find(x => x.family_id === fam && x.state === 'fail' && x.unit_key.endsWith(s.site.origin + p));
const description = s => fails(s).map(x => `${x.family_id} ${x.unit_key.replace(s.site.origin, '')} [${x.reason}]`).join(' || ');

test('V1: a branch page with its own phone and address is a separate entity, but a wrong phone on a normal page still fails', async t => {
  const routes = tel => ({
    '/': req => doc(req, '/', { main: `${nav}<p>Address: 10 Main Street, Springfield</p><p>Phone: 02-555-0142</p>` }),
    '/a': req => doc(req, '/a', { main: `${nav}<p>Address: 10 Main Street, Springfield</p><p>Phone: 02-555-0142</p>` }),
    '/b': req => doc(req, '/b', { title: 'Gangnam branch', main: `${nav}<h1>Gangnam branch</h1><p>Address: 55 Teheran-ro, Gangnam-gu</p><p>Phone: ${tel}</p>` }),
  });
  const branch = await build(t, routes('02-555-0999'), ['/', '/a', '/b']);
  assert.equal(fails(branch).filter(x => x.family_id === 'fact-consistency').length, 0, description(branch));
  assert.equal(branch.packet.baseline.input.observations.some(x => x.family_id === 'fact-consistency' && x.unit_key.endsWith('/b')), false);
  const normal = await build(t, { ...routes('02-555-0142'), '/b': req => doc(req, '/b', { main: `${nav}<p>Address: 10 Main Street, Springfield</p><p>Phone: 02-555-0199</p>` }) }, ['/', '/a', '/b']);
  assert.match(failAt(normal, 'fact-consistency', '/b')?.reason ?? '', /phone "02-555-0199" differs from "02-555-0142"/);
});

test('V2: address abbreviations, postal codes, country codes and phone formats are the same fact', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', { main: `${nav}<p>Address: 10 Main Street, Springfield</p><p>Phone: (02) 555-0142</p>` }),
    '/a': req => doc(req, '/a', { main: `${nav}<p>Address: 10 Main Street, Springfield 04050, South Korea</p><p>Phone: 02.555.0142</p>` }),
    '/b': req => doc(req, '/b', { main: `${nav}<p>Address: 10 Main St, Springfield</p><p>Phone: +82 (0)2 555 0142</p>` }),
  }, ['/', '/a', '/b']);
  assert.equal(fails(s).length, 0, description(s));
  assert.equal(s.packet.baseline.input.observations.filter(x => x.family_id === 'fact-consistency' && x.state === 'pass').length, 3);
});

test('V3: JSON-LD PostalAddress agrees with the visible address on the same page', async t => {
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Acme Bakery', sameAs: ['https://x.example/acme'], telephone: '+82-2-555-0142',
    address: { '@type': 'PostalAddress', streetAddress: '10 Main Street', addressLocality: 'Springfield', postalCode: '04050', addressCountry: 'KR' } });
  const s = await build(t, {
    '/': req => doc(req, '/', { head: `<script type="application/ld+json">${ld}</script>`, main: `${nav}<p>Address: 10 Main Street, Springfield 04050</p><p>Phone: 02-555-0142</p>` }),
    '/a': req => doc(req, '/a', { main: `${nav}<p>Phone: 02-555-0142</p>` }),
    '/b': req => doc(req, '/b', { main: `${nav}<p>Phone: 02-555-0142</p>` }),
  }, ['/', '/a', '/b']);
  assert.equal(fails(s).length, 0, description(s));
});

test('V4: dates, times, "since" prose and capitalised sentence subjects are not facts', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', { main: `${nav}<p>Acme Bakery is a family bakery founded in 1998.</p><p>Phone: 02-555-0142</p>` }),
    '/a': req => doc(req, '/a', { main: `${nav}<p>Acme Bakery is a family bakery founded in 1998.</p><p>Phone: 02-555-0142</p>` }),
    '/b': req => doc(req, '/b', { main: `${nav}<p>Posted 2026-10-15 12:30</p><p>Sourdough Bread is a staple. Flour prices have risen since 2020.</p>` }),
  }, ['/', '/a', '/b']);
  assert.equal(fails(s).length, 0, description(s));
});

test('V5: fax and business registration numbers do not tie with the phone, so a wrong phone is caught', async t => {
  const footer = tel => `<footer>Tel ${tel} Fax 02-555-0143 Business reg. 123-45-67890</footer>`;
  const s = await build(t, {
    '/': req => doc(req, '/', { main: `${nav}${footer('02-555-0142')}` }),
    '/a': req => doc(req, '/a', { main: `${nav}${footer('02-555-0142')}` }),
    '/b': req => doc(req, '/b', { main: `${nav}${footer('02-555-0199')}` }),
  }, ['/', '/a', '/b']);
  assert.equal(fails(s).length, 1, description(s));
  assert.match(failAt(s, 'fact-consistency', '/b')?.reason ?? '', /phone "02-555-0199" differs from "02-555-0142"/);
});

test('V6: JavaScript-only navigation and a sitemap index leave discovery unknown, not failed', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', { main: '<div id="app"></div><script src="/app.js"></script>' }),
    '/a': req => doc(req, '/a', { main: '<div id="app"></div>' }),
    '/sitemap.xml': req => ({ headers: { 'content-type': 'application/xml' }, body: `<sitemapindex><sitemap><loc>${base(req)}/sitemap-pages.xml</loc></sitemap></sitemapindex>` }),
  }, ['/', '/a'], { sitemap: true });
  assert.equal(fails(s).filter(x => x.family_id === 'discovery').length, 0, description(s));
  const spa = await build(t, {
    '/': req => doc(req, '/', { main: '<div id="app"></div><script src="/app.js"></script>' }),
    '/a': req => doc(req, '/a', { main: '<div id="app"></div>' }),
  }, ['/', '/a']);
  assert.equal(fails(spa).filter(x => x.family_id === 'discovery').length, 0, description(spa));
});

test('V7: entity-encoded hrefs and index.html links still count as links', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', { main: '<a href="/p?x=1&amp;y=2">p</a>' }),
    '/p?x=1&y=2': req => doc(req, '/p?x=1&y=2', { main: '<a href="/index.html">home</a>' }),
    '/index.html': req => doc(req, '/index.html', { main: '<p>home</p>' }),
  }, ['/', '/p?x=1&y=2']);
  assert.equal(fails(s).filter(x => x.family_id === 'discovery').length, 0, description(s));
});

test('V8: an empty JSON-LD placeholder and JSON-LD inside an HTML comment are not parse errors', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', { head: '<script type="application/ld+json"></script>', main: nav }),
    '/a': req => doc(req, '/a', { head: '<!-- <script type="application/ld+json">{ "todo": </script> -->', main: nav }),
    '/b': req => doc(req, '/b', { main: nav }),
  }, ['/', '/a', '/b']);
  assert.equal(fails(s).filter(x => x.family_id === 'structured-data-truth').length, 0, description(s));
  assert.equal(s.audit.module_outputs['naver-searchadvisor'].every(x => x.jsonld_parse_errors === 0), true);
  const bad = await build(t, { '/': req => doc(req, '/', { head: '<script type="application/ld+json">{ "todo": </script>', main: nav }) }, ['/']);
  assert.equal(fails(bad).filter(x => x.family_id === 'structured-data-truth').length, 1);
});

const forgeRoutes = {
  '/': req => doc(req, '/', { main: '<a href="/a">a</a><a href="/b">b</a>' }),
  '/a': req => doc(req, '/a', { main: '<p>a</p>' }),
  '/b': req => doc(req, '/b', { head: '<meta name="robots" content="noindex">', main: '<p>b</p>' }),
  '/orphan': req => doc(req, '/orphan', { main: '<p>orphan</p>' }),
};
const forgePaths = ['/', '/a', '/b', '/orphan'];
const forge = (t, options = {}) => build(t, forgeRoutes, forgePaths, options);

test('P9: deleting the module output cannot remove title, index or any 0.1.2 observation', async t => {
  const s = await forge(t);
  assert.doesNotThrow(() => buildReport(s.packet));
  await s.rewrite(s.evidence('modules.json'), v => { delete v['naver-searchadvisor']; });
  await s.forgeObservations(list => { for (let i = list.length - 1; i >= 0; i--) if (list[i].family_id !== 'fetch-response') list.splice(i, 1); });
  assert.throws(() => buildReport(s.packet), /planned module output missing|planned collector observation missing/);
});

test('a run without the Naver module still derives title, index and discovery from the collector evidence', async t => {
  const site = await startSite(forgeRoutes); sites.push(site);
  const s = await buildScenario(site, forgePaths, { enable: family, modules: ['magnus-seo'], name: `r2-${++counter}` });
  t.after(() => rm(s.dir, { recursive: true, force: true }));
  s.site = site;
  assert.equal(failAt(s, 'index-policy', '/b')?.state, 'fail');
  assert.equal(failAt(s, 'discovery', '/orphan')?.state, 'fail');
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('P5c/P6c: limit_reached and skipped are bound to the request ledger and the response records', async t => {
  const dropDiscovery = list => { for (let i = list.length - 1; i >= 0; i--) if (list[i].family_id === 'discovery' && list[i].state === 'fail') list.splice(i, 1); };
  const limit = await forge(t);
  await limit.rewrite(limit.evidence('collection.json'), v => { v.limit_reached = true; });
  await limit.forgeObservations(dropDiscovery);
  assert.throws(() => buildReport(limit.packet), /request ledger/);
  const unrelated = await forge(t);
  await unrelated.rewrite(unrelated.evidence('collection.json'), v => { v.skipped = [...(v.skipped ?? []), { url: `${unrelated.site.origin}/zzz`, reason: 'url_limit' }]; });
  await unrelated.forgeObservations(dropDiscovery);
  assert.throws(() => buildReport(unrelated.packet), /request ledger/);
  for (const reason of ['out_of_scope', 'whatever', 'url_limit']) {
    const moved = await forge(t);
    const gone = `${moved.site.origin}/b`;
    await moved.rewrite(moved.evidence('collection.json'), v => {
      v.artifacts = v.artifacts.filter(x => x.normalized_url !== gone);
      v.skipped = [...(v.skipped ?? []), { url: gone, reason }];
    });
    await moved.forgeObservations(list => { for (let i = list.length - 1; i >= 0; i--) if (list[i].unit_key.endsWith(gone)) list.splice(i, 1); });
    assert.throws(() => buildReport(moved.packet), /request ledger|response record|selected page/, reason);
  }
});

test('a genuine request limit is recorded in the ledger and reports cleanly', async t => {
  const s = await build(t, { '/': req => doc(req, '/', { main: '<a href="/a">a</a><a href="/b">b</a>' }), '/a': req => doc(req, '/a'), '/b': req => doc(req, '/b') }, ['/'], { maxUrls: 2 });
  const collection = JSON.parse(await (await import('node:fs/promises')).readFile(s.evidence('collection.json'), 'utf8'));
  assert.equal(collection.limit_reached, true);
  assert.ok(collection.skipped.some(x => x.reason === 'url_limit'));
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('P3/P4: rewriting the reason or the evaluator of a collector observation is rejected', async t => {
  const reason = await forge(t);
  await reason.forgeObservations(list => Object.assign(list.find(x => x.family_id === 'index-policy' && x.state === 'fail'), { reason: 'Facts match (forged reason)' }));
  assert.throws(() => buildReport(reason.packet), /collector verdict differs from raw evidence|title\/index verdict differs/);
  const evaluator = await forge(t);
  await evaluator.forgeObservations(list => Object.assign(list.find(x => x.family_id === 'index-policy' && x.state === 'fail'), { evaluator_type: 'human' }));
  assert.throws(() => buildReport(evaluator.packet), /collector verdict differs from raw evidence|title\/index verdict differs/);
});

test('an audit index from an older release is refused with a message that says what to do', async t => {
  const s = await forge(t);
  await s.rewrite(s.evidence('evidence-index.json'), v => { delete v.ledger_ref; delete v.modules; });
  assert.throws(() => buildReport(s.packet), /produced by an older optbrew release.*re-run the audit/i);
});

test('headline: unresolved core checks and 79.95% coverage never read as sufficient', () => {
  const result = (over = {}) => ({ profile: 'SEO', score: 90, coverage: 80, A: 100, M: 80, N: 72, missing_bounds: [72, 92], readiness_status: 'unverified', unknown_core: [], ...over });
  assert.equal(scoreHeadline(result()).status, 'sufficient');
  const core = scoreHeadline(result({ unknown_core: [{ family_id: 'fetch-response', unit_key: 'fetch-response|x' }] }));
  assert.equal(core.status, 'insufficient_core');
  assert.equal(core.headline_score, null);
  const near = scoreHeadline(result({ M: 79.95, coverage: 80 }));
  assert.equal(near.status, 'insufficient_coverage');
  assert.equal(near.coverage_exact, 79.95);
});

test('vendor tests fail, not skip, when OPTBREW_SOURCES_ROOT is set but missing', () => {
  const missing = path.join(root, 'no-such-sources-root');
  const env = { ...process.env, OPTBREW_SOURCES_ROOT: missing };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-timeout=60000', 'tests/vendor.test.mjs'], { cwd: root, encoding: 'utf8', env });
  assert.notEqual(run.status, 0, run.stdout.slice(-400));
  assert.doesNotMatch(run.stdout, /ℹ skipped [1-9]/);
});

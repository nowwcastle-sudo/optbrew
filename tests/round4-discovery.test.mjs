import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { buildScenario, startSite } from './support/review-scenario.mjs';

const base = req => `http://${req.headers.host}`;
const doc = (req, p, main) => ({ body: `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Page ${p}</title>` +
  `<link rel="canonical" href="${base(req)}${p}"></head><body>${main}</body></html>` });
const sites = [];
after(() => Promise.all(sites.map(x => x.close())));
let counter = 0;
async function build(t, routes, paths, options = {}) {
  const site = await startSite(routes); sites.push(site);
  const s = await buildScenario(site, paths, { enable: ['discovery'], name: `r4d-${++counter}`, ...options });
  t.after(() => rm(s.dir, { recursive: true, force: true }));
  s.site = site;
  return s;
}
const discovery = (s, p) => s.packet.baseline.input.observations.find(x => x.family_id === 'discovery' && x.unit_key.endsWith(s.site.origin + p));
const sitemap = (...urls) => req => ({ headers: { 'content-type': 'application/xml' }, body: `<urlset>${urls.map(u => `<url><loc>${base(req)}${u}</loc></url>`).join('')}</urlset>` });

test('D1: when a page builds its navigation in the browser, an unlinked page is unknown, not a false failure', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', '<div id="app"></div><script src="/app.js"></script>'),
    '/about': req => doc(req, '/about', '<a href="/">Home</a><p>About</p>'),
    '/deep': req => doc(req, '/deep', '<a href="/">Home</a><p>Deep page</p>'),
  }, ['/', '/about', '/deep']);
  assert.deepEqual(s.packet.baseline.input.observations.filter(x => x.family_id === 'discovery' && x.state === 'fail'), []);
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('D2: with one script-only widget page an orphan stays unknown, the linked widget passes', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', '<a href="/a">a</a><a href="/widget">w</a>'),
    '/a': req => doc(req, '/a', '<a href="/">home</a>'),
    '/widget': req => doc(req, '/widget', '<div id="w"></div><script>render()</script>'),
    '/orphan': req => doc(req, '/orphan', '<a href="/">home</a>'),
  }, ['/', '/a', '/widget', '/orphan']);
  assert.equal(discovery(s, '/widget')?.state, 'pass');
  assert.equal(discovery(s, '/a')?.state, 'pass');
  assert.equal(discovery(s, '/orphan'), undefined, 'the script-only widget might link it');
});

test('a fetched sitemap that lists other pages proves an unlinked page is an orphan even with script-built navigation', async t => {
  const routes = {
    '/': req => doc(req, '/', '<a href="/a">a</a><a href="/widget">w</a>'),
    '/a': req => doc(req, '/a', '<a href="/">home</a>'),
    '/widget': req => doc(req, '/widget', '<div id="w"></div><script>render()</script>'),
    '/orphan': req => doc(req, '/orphan', '<a href="/">home</a>'),
    '/sitemap.xml': sitemap('/', '/a', '/widget'),
  };
  const s = await build(t, routes, ['/', '/a', '/widget', '/orphan'], { sitemap: true });
  assert.equal(discovery(s, '/orphan')?.state, 'fail');
  assert.equal(discovery(s, '/widget')?.state, 'pass');
  assert.doesNotThrow(() => buildReport(s.packet));
  // A page the sitemap does list is not an orphan.
  const listed = await build(t, { ...routes, '/sitemap.xml': sitemap('/', '/a', '/widget', '/orphan') }, ['/', '/a', '/widget', '/orphan'], { sitemap: true });
  assert.equal(discovery(listed, '/orphan')?.state, 'pass');
});

test('a site whose pages expose no anchors at all and ship scripts stays unknown everywhere', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', '<div id="app"></div><script src="/app.js"></script>'),
    '/a': req => doc(req, '/a', '<div id="app"></div>'),
    '/orphan': req => doc(req, '/orphan', '<div id="app"></div><script src="/app.js"></script>'),
  }, ['/', '/a', '/orphan']);
  assert.deepEqual(s.packet.baseline.input.observations.filter(x => x.family_id === 'discovery' && x.state === 'fail'), []);
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('a static site with no scripts and no links still reports its unlinked pages', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', '<p>home</p>'),
    '/a': req => doc(req, '/a', '<p>a</p>'),
  }, ['/', '/a']);
  assert.equal(discovery(s, '/a')?.state, 'fail');
});

test('an orphan on a site without any script-driven page is still reported', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', '<a href="/a">a</a>'),
    '/a': req => doc(req, '/a', '<a href="/">home</a>'),
    '/orphan': req => doc(req, '/orphan', '<a href="/">home</a>'),
  }, ['/', '/a', '/orphan']);
  assert.equal(discovery(s, '/orphan')?.state, 'fail');
});

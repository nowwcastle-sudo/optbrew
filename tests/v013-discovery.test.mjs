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
  const s = await buildScenario(site, paths, { enable: ['discovery'], name: `v013d-${++counter}`, ...options });
  t.after(() => rm(s.dir, { recursive: true, force: true }));
  s.site = site;
  return s;
}
const discovery = (s, p) => s.packet.baseline.input.observations.find(x => x.family_id === 'discovery' && x.unit_key.endsWith(s.site.origin + p));
const sitemap = (...urls) => req => ({ headers: { 'content-type': 'application/xml' }, body: `<urlset>${urls.map(u => `<url><loc>${base(req)}${u}</loc></url>`).join('')}</urlset>` });
const widget = script => ({ '/': req => doc(req, '/', '<a href="/a">a</a><a href="/widget">w</a>'), '/a': req => doc(req, '/a', '<a href="/">home</a>'),
  '/widget': req => doc(req, '/widget', `<div id="w"></div>${script}`), '/orphan': req => doc(req, '/orphan', '<a href="/">home</a>') });
const paths = ['/', '/a', '/widget', '/orphan'];

test('L3 D2: an orphan next to a script-only widget page that never mentions it is reported', async t => {
  const s = await build(t, widget('<script>render()</script>'), paths);
  assert.equal(discovery(s, '/orphan')?.state, 'fail');
  assert.equal(discovery(s, '/widget')?.state, 'pass');
  assert.equal(discovery(s, '/a')?.state, 'pass');
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('L3: an orphan whose path an inline script mentions stays unknown (the script can build the link)', async t => {
  const s = await build(t, widget('<script>go("/orphan")</script>'), paths);
  assert.equal(discovery(s, '/orphan')?.state, 'unknown', 'neither listed nor linked, and not provable as an orphan');
  assert.equal(discovery(s, '/widget')?.state, 'pass');
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('L3: a path that only shares a prefix with a mentioned path is not mentioned', async t => {
  const s = await build(t, widget('<script>go("/orphan-two"); go("/a-longer-path")</script>'), paths);
  assert.equal(discovery(s, '/orphan')?.state, 'fail', '/orphan-two is another page');
});

test('L3 D1: a script-only page that loads a same-origin script nobody collected leaves orphans unknown', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', '<div id="app"></div><script src="/app.js"></script>'),
    '/about': req => doc(req, '/about', '<a href="/">Home</a><p>About</p>'),
    '/deep': req => doc(req, '/deep', '<a href="/">Home</a><p>Deep page</p>'),
  }, ['/', '/about', '/deep']);
  assert.deepEqual(s.packet.baseline.input.observations.filter(x => x.family_id === 'discovery' && x.state === 'fail'), []);
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('L3: a cross-origin script does not hide an orphan; only a same-origin one that was not collected does', async t => {
  const s = await build(t, widget('<script src="https://cdn.example.net/widget.js"></script>'), paths);
  assert.equal(discovery(s, '/orphan')?.state, 'fail');
});

test('L3: a fetched sitemap that lists other pages still proves an orphan next to script-built navigation', async t => {
  const routes = { ...widget('<script src="/app.js"></script>'), '/sitemap.xml': sitemap('/', '/a', '/widget') };
  const s = await build(t, routes, paths, { sitemap: true });
  assert.equal(discovery(s, '/orphan')?.state, 'fail');
  const listed = await build(t, { ...routes, '/sitemap.xml': sitemap('/', '/a', '/widget', '/orphan') }, paths, { sitemap: true });
  assert.equal(discovery(listed, '/orphan')?.state, 'pass');
});

test('a site whose pages expose no anchors and load a script nobody collected stays unknown everywhere', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', '<div id="app"></div><script src="/app.js"></script>'),
    '/a': req => doc(req, '/a', '<div id="app"></div>'),
    '/orphan': req => doc(req, '/orphan', '<div id="app"></div><script src="/app.js"></script>'),
  }, ['/', '/a', '/orphan']);
  assert.deepEqual(s.packet.baseline.input.observations.filter(x => x.family_id === 'discovery' && x.state === 'fail'), []);
});

test('a static site with no scripts still reports its unlinked page', async t => {
  const s = await build(t, { '/': req => doc(req, '/', '<p>home</p>'), '/a': req => doc(req, '/a', '<p>a</p>') }, ['/', '/a']);
  assert.equal(discovery(s, '/a')?.state, 'fail');
});

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
async function build(t, routes, paths) {
  const site = await startSite(routes); sites.push(site);
  const s = await buildScenario(site, paths, { enable: ['discovery'], name: `r4d-${++counter}` });
  t.after(() => rm(s.dir, { recursive: true, force: true }));
  s.site = site;
  return s;
}
const discovery = (s, p) => s.packet.baseline.input.observations.find(x => x.family_id === 'discovery' && x.unit_key.endsWith(s.site.origin + p));

test('one script-only page makes only its own discovery unknown; a plain orphan elsewhere is still found', async t => {
  const s = await build(t, {
    '/': req => doc(req, '/', '<a href="/a">a</a>'),
    '/a': req => doc(req, '/a', '<p>plain page</p>'),
    '/spa': req => doc(req, '/spa', '<div id="app"></div><script src="/app.js"></script>'),
    '/orphan': req => doc(req, '/orphan', '<p>nobody links here</p>'),
  }, ['/', '/a', '/spa', '/orphan']);
  assert.equal(discovery(s, '/a')?.state, 'pass');
  assert.equal(discovery(s, '/orphan')?.state, 'fail');
  assert.equal(discovery(s, '/spa'), undefined, 'the script-only page itself stays unknown');
  assert.doesNotThrow(() => buildReport(s.packet));
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

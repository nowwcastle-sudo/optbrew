import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { buildScenario, startSite } from './support/review-scenario.mjs';

const base = req => `http://${req.headers.host}`;
const doc = (req, p, main = `<p>${p}</p>`) => ({ body: `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Page ${p}</title>` +
  `<link rel="canonical" href="${base(req)}${p}"></head><body>${main}</body></html>` });
const N = 'Brewline Coffee Roasters';
const facts = tel => `<p>${N} is a specialty coffee roastery founded in 2014.</p><p>Address: 27 Wausan-ro, Mapo-gu. Phone: ${tel}.</p>`;
const sites = [];
after(() => Promise.all(sites.map(x => x.close())));
let counter = 0;
async function build(t, routes, paths, options = {}) {
  const site = await startSite(routes); sites.push(site);
  const s = await buildScenario(site, paths, { enable: ['fact-consistency', 'discovery'], ...options, name: `r4-${++counter}` });
  t.after(() => rm(s.dir, { recursive: true, force: true }));
  s.site = site;
  return s;
}
const routes = {
  '/': req => doc(req, '/', `${facts('+82-2-555-0142')}<a href="/a">a</a><a href="/b">b</a>`),
  '/a': req => doc(req, '/a', facts('+82-2-555-0142')),
  '/b': req => doc(req, '/b', facts('+82-2-555-0199')),
  '/orphan': req => doc(req, '/orphan', facts('+82-2-555-0142')),
};
const paths = ['/', '/a', '/b', '/orphan'];
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const dropDiscoveryFails = list => { for (let i = list.length - 1; i >= 0; i--) if (list[i].family_id === 'discovery' && list[i].state === 'fail') list.splice(i, 1); };

test('baseline of the ledger scenario reports cleanly with seeded defects', async t => {
  const s = await build(t, routes, paths);
  assert.equal(s.observation('fact-consistency', '/b')?.state, 'fail');
  assert.equal(s.observation('discovery', '/orphan')?.state, 'fail');
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('P5d: a fake skipped url_limit entry that carries the remaining requests is rejected', async t => {
  const s = await build(t, routes, paths);
  const ledger = await readJson(s.evidence('ledger.json'));
  const total = ledger.entries.reduce((a, e) => a + e.requests, 0);
  const fake = { url: `${s.site.origin}/never-linked`, requests: ledger.limit - total, outcome: 'skipped', skipped_reason: 'url_limit', error: null };
  await s.rewrite(s.evidence('ledger.json'), v => { v.entries.push(fake); });
  await s.rewrite(s.evidence('collection.json'), v => {
    v.skipped = [...(v.skipped ?? []), { url: fake.url, reason: 'url_limit' }];
    v.limit_reached = true; v.request_count = ledger.limit; v.evaluated_count += 1;
  });
  await s.forgeObservations(dropDiscoveryFails);
  assert.throws(() => buildReport(s.packet), /request ledger: a skipped entry carries requests/);
});

test('P6d: a failing selected page moved to a url_limit skip with the remaining requests is rejected', async t => {
  const s = await build(t, routes, paths);
  const url = `${s.site.origin}/b`;
  const ledger = await readJson(s.evidence('ledger.json'));
  const total = ledger.entries.reduce((a, e) => a + e.requests, 0);
  await s.rewrite(s.evidence('collection.json'), v => {
    v.artifacts = v.artifacts.filter(x => x.normalized_url !== url);
    v.skipped = [...(v.skipped ?? []), { url, reason: 'url_limit' }]; v.limit_reached = true; v.request_count = ledger.limit;
  });
  await s.rewrite(s.evidence('ledger.json'), v => {
    const e = v.entries.find(x => x.url === url && x.outcome === 'response');
    e.outcome = 'skipped'; e.skipped_reason = 'url_limit'; e.requests += ledger.limit - total;
  });
  await s.rewrite(s.evidence('evidence-index.json'), v => {
    v.responses = v.responses.filter(x => x.normalized_url !== url);
    v.raw = v.raw.filter(x => x.normalized_url !== url);
  });
  await s.forgeObservations(list => { for (let i = list.length - 1; i >= 0; i--) if (list[i].unit_key.endsWith(url) || (list[i].family_id === 'discovery' && list[i].state === 'fail')) list.splice(i, 1); });
  assert.throws(() => buildReport(s.packet), /request ledger: a skipped entry carries requests/);
});

test('an error entry must count exactly the requests its failure artifact shows (no padding to reach a limit)', async t => {
  const outside = 'http://203.0.113.9/elsewhere';
  const s = await build(t, { ...routes, '/b': () => ({ status: 302, headers: { location: outside } }) }, paths);
  const entry = (await readJson(s.evidence('ledger.json'))).entries.find(x => x.outcome === 'error');
  assert.ok(entry, 'the redirect to another origin is an error entry');
  assert.equal(entry.requests, 1);
  const artifact = (await readJson(s.evidence('collection.json'))).artifacts.find(x => x.error);
  assert.equal(artifact.requests_made, entry.requests);
  assert.doesNotThrow(() => buildReport(s.packet));
  // Pad the error entry and the totals so the ledger looks self-consistent and exhausted.
  const ledger = await readJson(s.evidence('ledger.json'));
  const total = ledger.entries.reduce((a, e) => a + e.requests, 0);
  const pad = ledger.limit - total;
  await s.rewrite(s.evidence('ledger.json'), v => { v.entries.find(x => x.outcome === 'error').requests += pad; v.entries.push({ url: `${s.site.origin}/never-linked`, requests: 0, outcome: 'skipped', skipped_reason: 'url_limit', error: null }); });
  await s.rewrite(s.evidence('collection.json'), v => {
    v.skipped = [...(v.skipped ?? []), { url: `${s.site.origin}/never-linked`, reason: 'url_limit' }];
    v.limit_reached = true; v.request_count = ledger.limit;
  });
  await s.forgeObservations(dropDiscoveryFails);
  assert.throws(() => buildReport(s.packet), /request ledger: failed fetch of .* does not match its request count/);
});

test('an error artifact whose own request count is raised together with the ledger is still bound to its redirect chain', async t => {
  const outside = 'http://203.0.113.9/elsewhere';
  const s = await build(t, { ...routes, '/b': () => ({ status: 302, headers: { location: outside } }) }, paths);
  const ledger = await readJson(s.evidence('ledger.json'));
  const pad = ledger.limit - ledger.entries.reduce((a, e) => a + e.requests, 0);
  await s.rewrite(s.evidence('ledger.json'), v => { v.entries.find(x => x.outcome === 'error').requests += pad; v.entries.push({ url: `${s.site.origin}/never-linked`, requests: 0, outcome: 'skipped', skipped_reason: 'url_limit', error: null }); });
  await s.rewrite(s.evidence('collection.json'), v => {
    v.artifacts.find(x => x.error).requests_made += pad;
    v.skipped = [...(v.skipped ?? []), { url: `${s.site.origin}/never-linked`, reason: 'url_limit' }];
    v.limit_reached = true; v.request_count = ledger.limit;
  });
  await s.forgeObservations(dropDiscoveryFails);
  assert.throws(() => buildReport(s.packet), /request ledger: failed fetch of .* does not match its request count/);
});

test('a selected page may not be skipped for the request limit while a discovered page was fetched', async t => {
  // /a is selected, /extra is only discovered. Mark /a as url_limit skipped, keep every request on /extra.
  const site = { '/': req => doc(req, '/', `${facts('+82-2-555-0142')}<a href="/a">a</a><a href="/extra">e</a>`),
    '/a': req => doc(req, '/a', facts('+82-2-555-0142')), '/extra': req => doc(req, '/extra', facts('+82-2-555-0142')) };
  const s = await build(t, site, ['/', '/a'], { maxUrls: 3 });
  const ledger = await readJson(s.evidence('ledger.json'));
  assert.ok(ledger.entries.some(x => x.url.endsWith('/extra') && x.requests > 0), 'the discovered page was fetched');
  const url = `${s.site.origin}/a`;
  const aEntry = ledger.entries.find(x => x.url === url);
  // /a loses its request; the freed request is given to /extra's redirect-free response record by listing /extra's request twice is not possible,
  // so the forger tops the total up on a second error-free entry for /extra: still impossible because response entries are exact.
  await s.rewrite(s.evidence('collection.json'), v => { v.artifacts = v.artifacts.filter(x => x.normalized_url !== url); v.skipped = [...(v.skipped ?? []), { url, reason: 'url_limit' }]; v.limit_reached = true; v.request_count -= aEntry.requests; v.evaluated_count -= 1; });
  await s.rewrite(s.evidence('ledger.json'), v => { const e = v.entries.find(x => x.url === url); e.outcome = 'skipped'; e.skipped_reason = 'url_limit'; e.requests = 0; });
  await s.rewrite(s.evidence('evidence-index.json'), v => { v.responses = v.responses.filter(x => x.normalized_url !== url); v.raw = v.raw.filter(x => x.normalized_url !== url); });
  await s.forgeObservations(list => { for (let i = list.length - 1; i >= 0; i--) if (list[i].unit_key.endsWith(url)) list.splice(i, 1); });
  assert.throws(() => buildReport(s.packet), /request ledger/);
});

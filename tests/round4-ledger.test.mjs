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

// A failed fetch has no hashed response record, so its claimed requests cannot be proven: it always counts as one request.
const brokenRoutes = { ...routes, '/broken': req => { req.socket.destroy(); return { status: 200, body: '' }; } };
const brokenPaths = [...paths, '/broken'];
const brokenUrl = s => `${s.site.origin}/broken`;

/** Pad the run to the limit by inflating the failed fetch's redirect chain and request counts consistently (reviewer P5f/P6f). */
async function padThroughFailedChain(s) {
  const ledger = await readJson(s.evidence('ledger.json'));
  const total = ledger.entries.reduce((a, e) => a + e.requests, 0);
  const entry = ledger.entries.find(x => x.url === brokenUrl(s));
  const made = entry.requests + (ledger.limit - total);
  await s.rewrite(s.evidence('ledger.json'), v => { v.entries.find(x => x.url === brokenUrl(s)).requests = made; });
  await s.rewrite(s.evidence('collection.json'), v => {
    const artifact = v.artifacts.find(x => x.normalized_url === brokenUrl(s));
    artifact.redirect_chain = Array.from({ length: made - 1 }, (_, i) => ({ url: `${s.site.origin}/hop${i}`, status: 302, location: `${s.site.origin}/hop${i + 1}` }));
    v.request_count = ledger.limit;
  });
}

test('a failed fetch is booked as exactly one request and the honest report builds', async t => {
  const s = await build(t, brokenRoutes, brokenPaths);
  const ledger = await readJson(s.evidence('ledger.json'));
  const entry = ledger.entries.find(x => x.url === brokenUrl(s));
  assert.equal(entry.outcome, 'error');
  assert.equal(entry.requests, 1);
  assert.equal((await readJson(s.evidence('collection.json'))).request_count, ledger.entries.reduce((a, e) => a + e.requests, 0));
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('P5f: padding the request total through a failed fetch and faking a url_limit skip is rejected', async t => {
  const s = await build(t, brokenRoutes, brokenPaths);
  await padThroughFailedChain(s);
  const fake = `${s.site.origin}/never-linked`;
  await s.rewrite(s.evidence('ledger.json'), v => { v.entries.push({ url: fake, requests: 0, outcome: 'skipped', skipped_reason: 'url_limit', error: null }); });
  await s.rewrite(s.evidence('collection.json'), v => { v.skipped = [...(v.skipped ?? []), { url: fake, reason: 'url_limit' }]; v.limit_reached = true; });
  await s.forgeObservations(dropDiscoveryFails);
  assert.throws(() => buildReport(s.packet), /request ledger/);
});

test('P6f: padding through a failed fetch and moving a failing selected page to a url_limit skip is rejected', async t => {
  const s = await build(t, brokenRoutes, brokenPaths);
  const url = `${s.site.origin}/b`;
  await s.rewrite(s.evidence('ledger.json'), v => { const e = v.entries.find(x => x.url === url && x.outcome === 'response'); e.outcome = 'skipped'; e.skipped_reason = 'url_limit'; e.requests = 0; });
  await s.rewrite(s.evidence('collection.json'), v => { v.artifacts = v.artifacts.filter(x => x.normalized_url !== url); v.skipped = [...(v.skipped ?? []), { url, reason: 'url_limit' }]; v.limit_reached = true; v.evaluated_count -= 1; });
  await s.rewrite(s.evidence('evidence-index.json'), v => { v.responses = v.responses.filter(x => x.normalized_url !== url); v.raw = v.raw.filter(x => x.normalized_url !== url); });
  await padThroughFailedChain(s);
  await s.forgeObservations(list => { for (let i = list.length - 1; i >= 0; i--) if (list[i].unit_key.endsWith(url) || (list[i].family_id === 'discovery' && list[i].state === 'fail')) list.splice(i, 1); });
  assert.throws(() => buildReport(s.packet), /request ledger/);
});

/** Add fake failed fetches of URLs nothing links to: collection artifact, ledger error entry, bodyless raw entry. */
async function fakeFailures(s, urls) {
  const index = await readJson(s.evidence('evidence-index.json'));
  await s.rewrite(s.evidence('collection.json'), v => {
    for (const url of urls) v.artifacts.push({ requested_url: url, normalized_url: url, final_url: null, status: null, headers: {}, header_lines: [],
      redirect_chain: [], raw_html_ref: null, content_hash: null, capability: 'none', source_ref: 'optbrew:collector', evidence_ref: index.collection_ref, error: 'fetch_failed' });
    v.request_count += urls.length; v.evaluated_count += urls.length;
  });
  await s.rewrite(s.evidence('ledger.json'), v => { for (const url of urls) v.entries.push({ url, requests: 1, outcome: 'error', skipped_reason: null, error: 'fetch_failed' }); });
  await s.rewrite(s.evidence('evidence-index.json'), v => { for (const url of urls) v.raw.push({ normalized_url: url, evidence_ref: index.collection_ref, content_hash: null }); });
}

test('P5g: fake failed fetches of never-linked URLs cannot pad the total to a false request-limit claim', async t => {
  const s = await build(t, routes, paths);
  const ledger = await readJson(s.evidence('ledger.json'));
  const total = ledger.entries.reduce((a, e) => a + e.requests, 0);
  await fakeFailures(s, Array.from({ length: ledger.limit - total }, (_, i) => `${s.site.origin}/ghost-${i}`));
  const fake = `${s.site.origin}/never-linked`;
  await s.rewrite(s.evidence('ledger.json'), v => { v.entries.push({ url: fake, requests: 0, outcome: 'skipped', skipped_reason: 'url_limit', error: null }); });
  await s.rewrite(s.evidence('collection.json'), v => { v.skipped = [...(v.skipped ?? []), { url: fake, reason: 'url_limit' }]; v.limit_reached = true; });
  await s.forgeObservations(dropDiscoveryFails);
  assert.throws(() => buildReport(s.packet), /request ledger: .* has no provenance/);
});

test('P5g: a fake failed fetch of a never-linked URL is refused even without a limit claim', async t => {
  const s = await build(t, routes, paths);
  await fakeFailures(s, [`${s.site.origin}/ghost-0`]);
  assert.throws(() => buildReport(s.packet), /request ledger: .* has no provenance/);
});

test('a real network failure of a selected page and of a discovered link still reports cleanly (provenance control)', async t => {
  const site = { '/': req => doc(req, '/', `${facts('+82-2-555-0142')}<a href="/a">a</a><a href="/dead">dead</a>`),
    '/a': req => doc(req, '/a', facts('+82-2-555-0142')), '/dead': req => { req.socket.destroy(); return { status: 200, body: '' }; },
    '/broken': req => { req.socket.destroy(); return { status: 200, body: '' }; } };
  const s = await build(t, site, ['/', '/a', '/broken']);
  const ledger = await readJson(s.evidence('ledger.json'));
  assert.deepEqual(ledger.entries.filter(x => x.outcome === 'error').map(x => x.url.replace(s.site.origin, '')).sort(), ['/broken', '/dead']);
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('a redirect that ends in a transport failure is one request in the ledger and still reports cleanly', async t => {
  const chain = { '/hop1': req => ({ status: 302, headers: { location: `${base(req)}/hop2` } }), '/hop2': req => ({ status: 302, headers: { location: `${base(req)}/hop3` } }),
    '/hop3': req => { req.socket.destroy(); return { status: 200, body: '' }; } };
  const s = await build(t, { ...routes, ...chain }, [...paths, '/hop1']);
  const ledger = await readJson(s.evidence('ledger.json'));
  const entry = ledger.entries.find(x => x.url === `${s.site.origin}/hop1`);
  assert.equal(entry.outcome, 'error');
  assert.equal(entry.requests, 1);
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('a redirect chain that has started is allowed to finish after the request limit, and the limited run still reports cleanly', async t => {
  const site = { '/': req => doc(req, '/', `${facts('+82-2-555-0142')}<a href="/r1">r</a><a href="/x">x</a><a href="/y">y</a>`),
    '/r1': req => ({ status: 302, headers: { location: `${base(req)}/r2` } }), '/r2': req => doc(req, '/r2', facts('+82-2-555-0142')),
    '/x': req => doc(req, '/x', facts('+82-2-555-0142')), '/y': req => doc(req, '/y', facts('+82-2-555-0142')) };
  const s = await build(t, site, ['/'], { maxUrls: 3 });
  const ledger = await readJson(s.evidence('ledger.json'));
  const collection = await readJson(s.evidence('collection.json'));
  assert.equal(collection.limit_reached, true);
  assert.ok(ledger.entries.some(x => x.outcome === 'skipped' && x.skipped_reason === 'url_limit'));
  assert.equal(collection.request_count, ledger.entries.reduce((a, e) => a + e.requests, 0));
  assert.doesNotThrow(() => buildReport(s.packet));
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

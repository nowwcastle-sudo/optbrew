import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { buildScenario, startSite } from './support/review-scenario.mjs';

const base = req => `http://${req.headers.host}`;
const doc = (req, p, main = `<p>${p}</p>`) => ({ body: `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Page ${p}</title>` +
  `<link rel="canonical" href="${base(req)}${p}"></head><body>${main}</body></html>` });
const sites = [];
after(() => Promise.all(sites.map(x => x.close())));
let counter = 0;
async function build(t, routes, paths, options = {}) {
  const site = await startSite(routes); sites.push(site);
  const s = await buildScenario(site, paths, { enable: ['discovery'], ...options, name: `v013-${++counter}` });
  t.after(() => rm(s.dir, { recursive: true, force: true }));
  s.site = site;
  return s;
}
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const destroy = req => { req.socket.destroy(); return { status: 200, body: '' }; };
const dropDiscoveryFails = list => { for (let i = list.length - 1; i >= 0; i--) if (list[i].family_id === 'discovery' && list[i].state === 'fail') list.splice(i, 1); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// ---- the reviewer's P5h site: 30 linked pages, a real dead link, an orphan
const N = 30;
const p5hRoutes = {
  '/': req => doc(req, '/', `${Array.from({ length: N }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('')}<a href="/dead-linked">x</a>`),
  '/orphan': req => doc(req, '/orphan', '<a href="/">home</a>'),
  '/dead-linked': destroy,
};
for (let i = 0; i < N; i++) p5hRoutes[`/p${i}`] = req => doc(req, `/p${i}`, '<a href="/">home</a>');

/** Add failed-fetch entries (collection artifact, ledger entry, hashed failure record, index entries) the way a forger would. */
async function forgeFailures(s, urls, { requests = 1, chain = [] } = {}) {
  const index = await readJson(s.evidence('evidence-index.json'));
  const records = [];
  for (const url of urls) {
    const record = { record_version: '1', kind: 'failure', requested_url: url, normalized_url: url, redirect_chain: chain, unanswered: requests - chain.length, error: 'fetch_failed' };
    const bytes = `${JSON.stringify(record, null, 2)}\n`;
    const ref = path.join(s.dir, 'evidence', `${sha(bytes)}.failure.json`);
    await writeFile(ref, bytes);
    await s.add(ref, 'failure_record', 'optbrew:collector');
    records.push({ url, ref, hash: sha(bytes), record });
  }
  await s.rewrite(s.evidence('collection.json'), v => {
    for (const { url, ref, record } of records) v.artifacts.push({ requested_url: url, normalized_url: url, final_url: null, status: null, headers: {}, header_lines: [],
      redirect_chain: record.redirect_chain, unanswered: record.unanswered, failure_ref: ref, raw_html_ref: null, content_hash: null, capability: 'none',
      source_ref: 'optbrew:collector', evidence_ref: index.collection_ref, error: 'fetch_failed' });
    v.request_count += urls.length * requests; v.evaluated_count += urls.length;
  });
  await s.rewrite(s.evidence('ledger.json'), v => { for (const { url } of records) v.entries.push({ url, requests, outcome: 'error', skipped_reason: null, error: 'fetch_failed' }); });
  await s.rewrite(s.evidence('evidence-index.json'), v => {
    for (const { url, ref, hash } of records) { v.raw.push({ normalized_url: url, evidence_ref: index.collection_ref, content_hash: null }); v.failures.push({ normalized_url: url, evidence_ref: ref, content_hash: hash }); }
  });
}

test('honest run with real network failures reports cleanly and records a hashed failure record per failed fetch', async t => {
  const s = await build(t, p5hRoutes, ['/', '/orphan']);
  const ledger = await readJson(s.evidence('ledger.json'));
  assert.deepEqual(ledger.entries.filter(x => x.outcome === 'error').map(x => x.url.replace(s.site.origin, '')), ['/dead-linked']);
  assert.equal((await readJson(s.evidence('evidence-index.json'))).failures.length, 1);
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('P5h: duplicate failed-fetch entries for already fetched linked URLs cannot pad the total to a false limit claim', async t => {
  const s = await build(t, p5hRoutes, ['/', '/orphan']);
  const ledger = await readJson(s.evidence('ledger.json'));
  const total = ledger.entries.reduce((a, e) => a + e.requests, 0);
  const fetched = ledger.entries.filter(x => x.outcome === 'response' && /\/p\d+$/.test(x.url)).map(x => x.url);
  await forgeFailures(s, fetched.slice(0, ledger.limit - total));
  const skipUrl = fetched.at(-1);
  await s.rewrite(s.evidence('ledger.json'), v => { v.entries.push({ url: skipUrl, requests: 0, outcome: 'skipped', skipped_reason: 'url_limit', error: null }); });
  await s.rewrite(s.evidence('collection.json'), v => { v.skipped = [...(v.skipped ?? []), { url: skipUrl, reason: 'url_limit' }]; v.limit_reached = true; });
  await s.forgeObservations(dropDiscoveryFails);
  assert.throws(() => buildReport(s.packet), /request ledger: duplicate ledger url/);
});

test('L1: the same URL as a response and as a url_limit skip is a duplicate entry', async t => {
  const s = await build(t, p5hRoutes, ['/', '/orphan']);
  const url = `${s.site.origin}/p1`;
  await s.rewrite(s.evidence('ledger.json'), v => { v.entries.push({ url, requests: 0, outcome: 'skipped', skipped_reason: 'depth_limit', error: null }); });
  await s.rewrite(s.evidence('collection.json'), v => { v.skipped = [...(v.skipped ?? []), { url, reason: 'depth_limit' }]; });
  assert.throws(() => buildReport(s.packet), /duplicate ledger url/);
});

test('a link repeated on many pages, and an out-of-scope link repeated, are not duplicates in an honest run', async t => {
  const routes = { '/': req => doc(req, '/', '<a href="/a">a</a><a href="/a">a again</a><a href="https://elsewhere.test/x">x</a>'),
    '/a': req => doc(req, '/a', '<a href="/">home</a><a href="https://elsewhere.test/x">x</a>') };
  const s = await build(t, routes, ['/', '/a']);
  const ledger = await readJson(s.evidence('ledger.json'));
  assert.ok(ledger.entries.filter(x => x.skipped_reason === 'outside_scope').length >= 2, 'the repeated out-of-scope link is skipped once per link');
  assert.doesNotThrow(() => buildReport(s.packet));
});

const hopRoutes = { '/': req => doc(req, '/', '<a href="/hopfail">h</a>'),
  '/hopfail': req => ({ status: 302, headers: { location: `${base(req)}/hopfail2` } }),
  '/hopfail2': req => ({ status: 302, headers: { location: `${base(req)}/hopfail3` } }), '/hopfail3': destroy };

test('L2: a redirect that ends in a transport failure counts its answered hops, from a hashed failure record', async t => {
  const s = await build(t, hopRoutes, ['/']);
  const entry = (await readJson(s.evidence('ledger.json'))).entries.find(x => x.url.endsWith('/hopfail'));
  assert.equal(entry.outcome, 'error');
  assert.equal(entry.requests, 3, 'two answered redirects and the attempt that got no answer');
  const artifact = (await readJson(s.evidence('collection.json'))).artifacts.find(x => x.normalized_url.endsWith('/hopfail'));
  const record = await readJson(artifact.failure_ref);
  assert.equal(record.redirect_chain.length, 2);
  assert.equal(record.unanswered, 1);
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('L2: raising a failed fetch\'s requests in the ledger or lowering the record is refused', async t => {
  const s = await build(t, hopRoutes, ['/']);
  const url = `${s.site.origin}/hopfail`;
  await s.rewrite(s.evidence('ledger.json'), v => { v.entries.find(x => x.url === url).requests += 2; });
  await s.rewrite(s.evidence('collection.json'), v => { v.request_count += 2; });
  assert.throws(() => buildReport(s.packet), /does not match its hashed failure record/);
  const t2 = await build(t, hopRoutes, ['/']);
  const artifact = (await readJson(t2.evidence('collection.json'))).artifacts.find(x => x.normalized_url.endsWith('/hopfail'));
  await t2.rewrite(artifact.failure_ref, v => { v.redirect_chain.push({ url: v.redirect_chain.at(-1).location, status: 302, location: `${t2.site.origin}/x` }); });
  assert.throws(() => buildReport(t2.packet), /failure record hash differs from the audit index|failure record differs from collection record|does not match/);
});

test('L2: a forged failure chain longer than the hop limit is refused', async t => {
  const s = await build(t, p5hRoutes, ['/', '/orphan']);
  const ledger = await readJson(s.evidence('ledger.json'));
  const total = ledger.entries.reduce((a, e) => a + e.requests, 0);
  const url = `${s.site.origin}/p1`;
  const need = ledger.limit - total;
  const chain = Array.from({ length: need }, (_, i) => ({ url: i ? `${s.site.origin}/h${i - 1}` : `${s.site.origin}/ghost`, status: 302, location: `${s.site.origin}/h${i}` }));
  await forgeFailures(s, [`${s.site.origin}/ghost`], { requests: need, chain });
  await s.rewrite(s.evidence('ledger.json'), v => { v.entries.push({ url: `${s.site.origin}/never-linked`, requests: 0, outcome: 'skipped', skipped_reason: 'url_limit', error: null }); });
  await s.rewrite(s.evidence('collection.json'), v => { v.skipped = [...(v.skipped ?? []), { url: `${s.site.origin}/never-linked`, reason: 'url_limit' }]; v.limit_reached = true; });
  assert.throws(() => buildReport(s.packet), /failure record is malformed|no provenance/);
  assert.ok(url);
});

test('L2/L6: an honest run that reaches the request limit in the middle of redirect chains passes replay', async t => {
  const routes = { '/': req => doc(req, '/', ['r1', 'r2', 'r3', 'r4'].map(r => `<a href="/${r}">${r}</a>`).join('')) };
  for (const r of ['r1', 'r2', 'r3', 'r4']) {
    routes[`/${r}`] = req => ({ status: 302, headers: { location: `${base(req)}/${r}-final` } });
    routes[`/${r}-final`] = req => doc(req, `/${r}-final`);
  }
  for (const limit of [3, 4, 5, 6]) {
    const s = await build(t, routes, ['/'], { maxUrls: limit });
    const ledger = await readJson(s.evidence('ledger.json'));
    const total = ledger.entries.reduce((a, e) => a + e.requests, 0);
    assert.equal(total, limit, `max_urls ${limit}: the budget is used up exactly`);
    assert.equal((await readJson(s.evidence('collection.json'))).limit_reached, true);
    assert.doesNotThrow(() => buildReport(s.packet), `max_urls ${limit}`);
    assert.ok(s.site.requests.length <= limit * 40);
  }
});

test('an honest run that ends exactly at the limit without skipping anything passes replay', async t => {
  const s = await build(t, { '/': req => doc(req, '/', '<a href="/a">a</a>'), '/a': req => doc(req, '/a', '<a href="/">home</a>') }, ['/'], { maxUrls: 2 });
  const ledger = await readJson(s.evidence('ledger.json'));
  assert.equal(ledger.entries.reduce((a, e) => a + e.requests, 0), 2);
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('P5g: fake failed fetches of never-linked URLs (with failure records) still have no provenance', async t => {
  const s = await build(t, p5hRoutes, ['/', '/orphan']);
  const ledger = await readJson(s.evidence('ledger.json'));
  const total = ledger.entries.reduce((a, e) => a + e.requests, 0);
  await forgeFailures(s, Array.from({ length: ledger.limit - total }, (_, i) => `${s.site.origin}/ghost-${i}`));
  const fake = `${s.site.origin}/never-linked`;
  await s.rewrite(s.evidence('ledger.json'), v => { v.entries.push({ url: fake, requests: 0, outcome: 'skipped', skipped_reason: 'url_limit', error: null }); });
  await s.rewrite(s.evidence('collection.json'), v => { v.skipped = [...(v.skipped ?? []), { url: fake, reason: 'url_limit' }]; v.limit_reached = true; });
  await s.forgeObservations(dropDiscoveryFails);
  assert.throws(() => buildReport(s.packet), /request ledger: .* has no provenance/);
});

test('P5g: a single fake failed fetch of a never-linked URL is refused even without a limit claim', async t => {
  const s = await build(t, p5hRoutes, ['/', '/orphan']);
  await forgeFailures(s, [`${s.site.origin}/ghost-0`]);
  assert.throws(() => buildReport(s.packet), /request ledger: .* has no provenance/);
});

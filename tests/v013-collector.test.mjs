import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../skills/optbrew/scripts/core/collector.mjs';

const scope = { allowed: [{ origin: 'https://example.test', path_prefix: '/owned/' }] };
const context = (urls, extra = {}) => ({ scope: { ...scope, ...extra }, protocol: { page_types: [{ id: 'main', urls: urls.map(url => ({ original: url, normalized: url })) }] } });
const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (body = '<html><head><title>Page</title></head></html>', status = 200, headers = {}) => ({ status, headers: { 'content-type': 'text/html', ...headers }, body: Buffer.from(body) });

/** /owned/cN answers with a redirect chain of `depth` hops before it answers 200; /owned/cN-x-fail destroys the connection at the last hop. */
const chainTransport = (depth, requested, failAt = null) => async ({ url }) => {
  requested.push(url.href);
  const match = /^\/owned\/c(\d+)(?:-(\d+))?$/.exec(url.pathname);
  const hop = Number(match?.[2] ?? 0);
  if (failAt !== null && hop === failAt) throw new Error('connection reset');
  return hop < depth ? response('', 302, { location: `/owned/c${match[1]}-${hop + 1}` }) : response('<title>done</title>');
};
const urlsOf = count => Array.from({ length: count }, (_, n) => `https://example.test/owned/c${n}`);

for (const limit of [5, 50]) test(`0.1.3 L6: requests never exceed max_urls ${limit}; a chain cut by the limit is a request_limit unknown with its answered hops recorded`, async () => {
  const requested = [];
  const result = await collect(context(urlsOf(60), { max_urls: limit }), { resolve, transport: chainTransport(3, requested) });
  assert.equal(requested.length, limit, 'the budget is a hard ceiling that is used up exactly');
  assert.equal(result.request_count, limit);
  assert.equal(result.request_count, result.ledger.reduce((sum, entry) => sum + entry.requests, 0));
  assert.equal(result.limit_reached, true);
  const cut = result.artifacts.filter(x => x.error === 'request_limit');
  assert.ok(cut.length <= 2, 'at most the chains in flight are cut');
  for (const artifact of cut) {
    const entry = result.ledger.find(x => x.url === artifact.normalized_url);
    assert.equal(entry.outcome, 'error');
    assert.equal(artifact.unanswered, 0, 'the refused request was never made');
    assert.equal(entry.requests, artifact.redirect_chain.length + artifact.unanswered, 'every answered hop is recorded and counted');
  }
  assert.ok(result.skipped.some(x => x.reason === 'url_limit' || x.reason === 'request_limit'));
});

test('0.1.3 L2: a transport failure after answered hops counts the hops plus the one unanswered attempt', async () => {
  const requested = [];
  const result = await collect(context(urlsOf(1)), { resolve, transport: chainTransport(3, requested, 2) });
  assert.equal(result.artifacts.length, 1);
  const [artifact] = result.artifacts;
  assert.equal(artifact.error, 'fetch_failed');
  assert.equal(artifact.redirect_chain.length, 2, 'both answered redirects are kept');
  assert.equal(artifact.unanswered, 1);
  assert.equal(result.ledger[0].requests, 3);
  assert.equal(result.request_count, requested.length);
});

test('0.1.3 L2: a redirect the hop limit refuses is an answered hop and a blocked redirect is an answered hop', async () => {
  const requested = [];
  const endless = await collect(context(urlsOf(1)), { resolve, transport: chainTransport(99, requested) });
  const [artifact] = endless.artifacts;
  assert.equal(artifact.error, 'fetch_failed');
  assert.equal(artifact.unanswered, 0);
  assert.equal(endless.ledger[0].requests, requested.length);
  assert.equal(artifact.redirect_chain.length, requested.length, 'the 11th answer (the refused redirect) is in the chain too');
  const blocked = [];
  const out = await collect(context(urlsOf(1)), { resolve, transport: async ({ url }) => { blocked.push(url.href); return response('', 302, { location: 'https://elsewhere.test/x' }); } });
  assert.equal(out.artifacts[0].error, 'redirect_outside_scope');
  assert.equal(out.ledger[0].requests, 1);
  assert.equal(out.artifacts[0].redirect_chain.length, 1);
  assert.equal(out.artifacts[0].unanswered, 0);
});

test('0.1.3 L2: a failure before any request counts nothing', async () => {
  const result = await collect(context(urlsOf(1)), { resolve: async () => [{ address: '10.0.0.5', family: 4 }], transport: async () => { throw new Error('never called'); } });
  assert.equal(result.artifacts[0].error, 'scope_rejected');
  assert.equal(result.ledger[0].requests, 0);
  assert.equal(result.request_count, 0);
  assert.equal(result.evaluated_count, 0);
});

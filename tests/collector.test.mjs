import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { assertInScope } from '../skills/optbrew/scripts/core/scope.mjs';
import { collect, fetchScoped } from '../skills/optbrew/scripts/core/collector.mjs';

const scope = { allowed: [{ origin: 'https://example.test', path_prefix: '/owned/' }] };
const context = (urls, extra = {}) => ({ scope: { ...scope, ...extra }, protocol: { page_types: [{ id: 'main', urls: urls.map(url => ({ original: url, normalized: url })) }] } });
const resolve = async () => [{ address: '93.184.215.14', family: 4 }];
const response = (body = '<html><head><title>Page</title></head></html>', status = 200, headers = {}) => ({ status, headers: { 'content-type': 'text/html', ...headers }, body: Buffer.from(body) });

test('path, host, port, userinfo and IP boundaries', () => {
  assert.equal(assertInScope('https://example.test/owned/page', scope, ['93.184.215.14']).href, 'https://example.test/owned/page');
  for (const url of ['https://example.test/other', 'https://example.test/ownedness', 'https://other.test/owned/', 'https://example.test:444/owned/', 'https://user@example.test/owned/', 'file:///owned/'])
    assert.throws(() => assertInScope(url, scope, ['93.184.215.14']));
  for (const ip of ['127.0.0.1', '10.1.1.1', '169.254.1.1', '::1', 'fc00::1', '::ffff:127.0.0.1'])
    assert.throws(() => assertInScope('https://example.test/owned/', scope, [ip]));
  const local = { allowed: [{ origin: 'http://localhost:8765', path_prefix: '/' }], local_targets: [{ host: 'localhost', port: 8765 }] };
  assert.equal(assertInScope('http://localhost:8765/', local, ['127.0.0.1']).host, 'localhost:8765');
  assert.throws(() => assertInScope('http://localhost:8766/', local, ['127.0.0.1']));
});

test('redirect and DNS change are rejected before transport can contact target', async () => {
  let calls = 0;
  const transport = async () => { calls++; return response('', 302, { location: 'https://example.test/other' }); };
  await assert.rejects(fetchScoped('https://example.test/owned/a', { context: context([]), transport, resolve }));
  assert.equal(calls, 1);
  for (const location of ['https://elsewhere.test/owned/b', 'http://127.0.0.1/owned/b']) {
    calls = 0;
    await assert.rejects(fetchScoped('https://example.test/owned/a', { context: context([]), resolve,
      transport: async () => { calls++; return response('', 302, { location }); } }));
    assert.equal(calls, 1);
  }
  calls = 0;
  const changingResolve = async () => ++calls === 1 ? ['93.184.215.14'] : ['10.0.0.1'];
  let requested = 0;
  await assert.rejects(fetchScoped('https://example.test/owned/a', { context: context([]), resolve: changingResolve, transport: async () => { requested++; return response('', 302, { location: '/owned/b' }); } }));
  assert.equal(requested, 1);
  await assert.rejects(fetchScoped('https://example.test/owned/a', { context: context([]), resolve,
    timeoutMs: 20, transport: async () => new Promise(() => {}) }), /timeout/);
});

test('50 URL, depth 3, concurrency 2 and byte limit are enforced', async () => {
  const urls = Array.from({ length: 51 }, (_, n) => `https://example.test/owned/${n}`);
  let active = 0; let maxActive = 0; let calls = 0;
  const transport = async ({ url }) => { active++; maxActive = Math.max(active, maxActive); calls++; await new Promise(r => setTimeout(r, 1)); active--; return response(`<a href="/owned/child">child</a>${url.pathname}`); };
  const result = await collect(context(urls), { transport, resolve });
  assert.equal(result.evaluated_count, 50);
  assert.equal(calls, 50);
  assert.ok(maxActive <= 2);
  assert.ok(result.skipped.some(x => x.reason === 'url_limit'));
  assert.equal(result.limit_reached, true);
  await assert.rejects(fetchScoped(urls[0], { context: context([]), transport: async () => response('x'.repeat(20)), resolve, maxBytes: 10 }));
  const chain = await collect(context([urls[0]]), { transport: async ({ url }) => response(`<a href="${url.pathname}/next">next</a>`), resolve });
  assert.equal(chain.artifacts.length, 4);
  assert.ok(chain.skipped.some(x => x.reason === 'depth_limit'));
});

test('HTTP errors remain artifacts and do not stop free collection', async () => {
  let n = 0;
  const result = await collect(context(['https://example.test/owned/a', 'https://example.test/owned/b', 'https://example.test/owned/c']), {
    resolve, transport: async () => response('', [403, 429, 200][n++])
  });
  assert.deepEqual(result.artifacts.map(x => x.status), [403, 429, 200]);
});

test('blocked redirect is recorded without contacting the destination', async () => {
  let calls = 0;
  const result = await collect(context(['https://example.test/owned/a']), { resolve,
    transport: async () => { calls++; return response('', 302, { location: 'https://other.test/private' }); } });
  assert.equal(calls, 1);
  assert.equal(result.artifacts[0].error, 'redirect_outside_scope');
  assert.deepEqual(result.skipped.map(x => x.reason), ['redirect_outside_scope']);
  assert.equal(result.artifacts[0].redirect_chain[0].location, '[blocked]');
});

test('default transport connects to a vetted localhost address for hostname and IP URLs', async () => {
  const server = createServer((_request, reply) => { reply.setHeader('content-type', 'text/html'); reply.end('<title>local</title>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const ipScope = { allowed: [{ origin: `http://127.0.0.1:${port}`, path_prefix: '/' }], local_targets: [{ host: '127.0.0.1', port }] };
    const ip = await fetchScoped(`http://127.0.0.1:${port}/`, { context: { scope: ipScope } });
    assert.equal(ip.status, 200);
    const hostScope = { allowed: [{ origin: `http://localhost:${port}`, path_prefix: '/' }], local_targets: [{ host: 'localhost', port }] };
    const named = await fetchScoped(`http://localhost:${port}/`, { context: { scope: hostScope }, resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    assert.equal(named.status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('DNS resolution shares the request deadline and cannot trigger late transport', async () => {
  let calls = 0;
  await assert.rejects(fetchScoped('https://example.test/owned/a', { context: context([]), timeoutMs: 10,
    resolve: () => new Promise(resolve => setTimeout(() => resolve(['93.184.215.14']), 80)),
    transport: async () => { calls++; return response(); } }), /timeout/);
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(calls, 0);
});

test('redirect DNS uses the same deadline as the first response', async () => {
  let resolutions = 0; let calls = 0;
  await assert.rejects(fetchScoped('https://example.test/owned/a', { context: context([]), timeoutMs: 15,
    resolve: () => ++resolutions === 1 ? ['93.184.215.14'] : new Promise(resolve => setTimeout(() => resolve(['93.184.215.14']), 80)),
    transport: async () => { calls++; return response('', 302, { location: '/owned/b' }); } }), /timeout/);
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(calls, 1);
});

test('TLS transport preserves hostname verification and pins the vetted IP in both lookup forms', async () => {
  const original = https.request;
  let checked = false;
  https.request = (url, options, callback) => {
    assert.equal(url.hostname, 'example.test');
    assert.equal(options.servername, 'example.test');
    assert.equal(options.rejectUnauthorized, true);
    options.lookup('example.test', { all: true }, (error, records) => {
      assert.equal(error, null);
      assert.deepEqual(records, [{ address: '93.184.215.14', family: 4 }]);
    });
    options.lookup('example.test', {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, '93.184.215.14');
      assert.equal(family, 4);
    });
    checked = true;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/html' };
      callback(response);
      response.emit('end');
    });
    return request;
  };
  try {
    const result = await fetchScoped('https://example.test/owned/a', { context: context([]), resolve });
    assert.equal(result.status, 200);
    assert.equal(checked, true);
  } finally { https.request = original; }
});

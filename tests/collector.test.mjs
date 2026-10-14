import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertInScope } from '../skills/optbrew/scripts/core/scope.mjs';
import { collect, fetchScoped } from '../skills/optbrew/scripts/core/collector.mjs';
import { runAudit } from '../skills/optbrew/scripts/audit.mjs';

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

test('declared auxiliary policy is fetched without links and shares the 50-request cap', async () => {
  const page = 'https://example.test/owned/page';
  const robots = 'https://example.test/owned/robots.txt';
  const policy = 'https://example.test/owned/policy.txt';
  const requested = [];
  const input = context([page], { max_urls: 3 });
  input.protocol.auxiliary_resources = [
    { kind: 'robots', original: robots, normalized: robots },
    { kind: 'policy', original: policy, normalized: policy },
  ];
  const result = await collect(input, { resolve, transport: async ({ url }) => {
    requested.push(url.href);
    return response(url.href === page ? '<title>Page</title><a href="/policy.txt">off path</a>' : 'noindex\n<a href="/owned/secret">ignore</a>');
  } });
  assert.deepEqual(new Set(requested), new Set([page, robots, policy]));
  assert.equal(result.evaluated_count, 3);
  assert.ok(!requested.includes('https://example.test/owned/secret'));
  assert.ok(!requested.includes('https://example.test/policy.txt'));
  assert.equal(result.artifacts.length, 3);
  let calls = 0;
  const over = context([page], { max_urls: 2 });
  over.protocol.auxiliary_resources = input.protocol.auxiliary_resources;
  await assert.rejects(collect(over, { resolve, transport: async () => { calls++; return response(); } }), /exceed request scope/);
  assert.equal(calls, 0);
});

test('declared robots with no page link reaches Naver audit without a scored resource unit', async () => {
  const page = 'https://example.test/owned/page';
  const robots = 'https://example.test/robots.txt';
  const run = {
    schema_version: '1.0.0', run_id: 'aux-audit', target: 'example.test', environment: 'local', goals: ['naver'],
    allowed_changes: [], scope: { allowed: [...scope.allowed, { origin: 'https://example.test', path_prefix: '/robots.txt' }] }, evaluation_version: '0.2.0', protocol_version: '0.1.0',
    data_sources: [], cost_decision: {}, evidence_ref: 'evidence/context.json',
    protocol: { page_types: [{ id: 'main', urls: [{ original: page, normalized: page }] }],
      auxiliary_resources: [{ kind: 'robots', original: robots, normalized: robots }],
      engines: ['naver'], families: [{ family_id: 'fetch-response', applicable: true }, { family_id: 'search-crawl-policy', applicable: true }],
      locale: 'ko-KR', region: 'KR', browser: 'Chrome', device: 'desktop',
      question_panel: [], surfaces: [], models: [], search_enabled: null }
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optbrew-aux-audit-'));
  const requested = [];
  try {
    const result = await runAudit({ context: run, modules: ['naver-searchadvisor'], outputDir: dir, resolve,
      transport: async ({ url }) => {
        requested.push(url.href);
        return url.href === robots ? { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: Yeti\nDisallow: /owned/page') } : response('<title>Page</title>');
      } });
    assert.deepEqual(new Set(requested), new Set([page, robots]));
    assert.equal(result.artifacts.length, 2);
    assert.deepEqual(result.observations.map(x => x.unit_key), [`fetch-response|${page}`, `search-crawl-policy|naver|${page}`]);
    assert.ok(result.module_outputs['naver-searchadvisor'][0].robots_evidence_ref);
    const index = JSON.parse(await readFile(result.evidence_ref, 'utf8'));
    assert.equal(index.raw.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a declared policy-kind robots file is retained but cannot drive crawl-policy evidence', async () => {
  const origin = 'https://example.test';
  const page = `${origin}/owned/page`;
  const robots = `${origin}/robots.txt`;
  const run = {
    schema_version: '1.0.0', run_id: 'policy-not-robots', target: 'example.test', environment: 'local', goals: ['naver'],
    allowed_changes: [], scope: { allowed: [{ origin, path_prefix: '/' }] },
    evaluation_version: '0.2.0', protocol_version: '0.1.0', data_sources: [], cost_decision: {}, evidence_ref: 'evidence/context.json',
    protocol: { page_types: [{ id: 'main', urls: [{ original: page, normalized: page }] }],
      auxiliary_resources: [{ kind: 'policy', original: robots, normalized: robots }],
      engines: ['naver'], families: [{ family_id: 'search-crawl-policy', applicable: true }],
      locale: 'ko-KR', region: 'KR', browser: 'Chrome', device: 'desktop',
      question_panel: [], surfaces: [], models: [], search_enabled: null }
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optbrew-policy-kind-'));
  try {
    const result = await runAudit({ context: run, modules: ['naver-searchadvisor'], outputDir: dir, resolve,
      transport: async ({ url }) => url.href === robots
        ? { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: Yeti\nDisallow: /owned/page') }
        : response('<title>Page</title>') });
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.module_outputs['naver-searchadvisor'][0].robots_evidence_ref, null);
    assert.equal(result.observations.some(x => x.family_id === 'search-crawl-policy'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('undeclared in-scope robots link is not contacted or used while ordinary pages are explored', async () => {
  const origin = 'https://example.test';
  const page = `${origin}/owned/page`;
  const child = `${origin}/owned/child`;
  const robots = `${origin}/robots.txt`;
  const run = {
    schema_version: '1.0.0', run_id: 'no-aux-policy', target: 'example.test', environment: 'local', goals: ['naver'],
    allowed_changes: [], scope: { allowed: [{ origin, path_prefix: '/' }] },
    evaluation_version: '0.2.0', protocol_version: '0.1.0', data_sources: [], cost_decision: {}, evidence_ref: 'evidence/context.json',
    protocol: { page_types: [{ id: 'main', urls: [{ original: page, normalized: page }] }], auxiliary_resources: [],
      engines: ['naver'], families: [{ family_id: 'fetch-response', applicable: true }, { family_id: 'search-crawl-policy', applicable: true }],
      locale: 'ko-KR', region: 'KR', browser: 'Chrome', device: 'desktop',
      question_panel: [], surfaces: [], models: [], search_enabled: null }
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optbrew-undeclared-'));
  const requested = [];
  try {
    const result = await runAudit({ context: run, modules: ['naver-searchadvisor'], outputDir: dir, resolve,
      transport: async ({ url }) => {
        requested.push(url.href);
        if (url.href === robots) return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: Yeti\nDisallow: /owned/page') };
        return response(url.href === page ? '<title>Page</title><a href="/robots.txt">robots</a><a href="/robo%74s.txt">encoded</a><a href="/owned/policy.txt">policy</a><a href="/owned/child">child</a>' : '<title>Child</title>');
      } });
    assert.deepEqual(new Set(requested), new Set([page, child]));
    assert.equal(result.artifacts.length, 2);
    assert.deepEqual(result.observations.map(x => x.unit_key), [`fetch-response|${page}`]);
    assert.equal(result.module_outputs['naver-searchadvisor'][0].robots_evidence_ref, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ordinary page redirect cannot contact an undeclared auxiliary policy URL', async () => {
  const origin = 'https://example.test';
  const page = `${origin}/owned/page`;
  const redirect = `${origin}/owned/redirect`;
  const robots = `${origin}/robots.txt`;
  const requested = [];
  const result = await collect(context([page], { allowed: [{ origin, path_prefix: '/' }] }), { resolve,
    transport: async ({ url }) => {
      requested.push(url.href);
      if (url.href === page) return response('<a href="/owned/redirect">next</a>');
      if (url.href === redirect) return response('', 302, { location: '/robots.txt' });
      return response('User-agent: Yeti\nDisallow: /');
    } });
  assert.deepEqual(requested, [page, redirect]);
  assert.ok(result.skipped.some(x => x.url === redirect));
  assert.ok(!requested.includes(robots));
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

test('final review I6: redirect hops draw from the shared request budget and keep the URL as a limit unknown', async () => {
  const redirecting = { page: 'https://example.test/owned/redirect', final: 'https://example.test/owned/final' };
  const requested = [];
  const transport = async ({ url }) => {
    requested.push(url.href);
    return url.href.endsWith('/redirect') || /\/owned\/r\d+$/.test(url.pathname) ?
      response('', 302, { location: `${url.pathname}-final` }) : response('<title>done</title>');
  };
  const one = await collect(context([redirecting.page], { max_urls: 1 }), { resolve, transport });
  assert.equal(requested.length, 1, `actual requests: ${requested.join(', ')}`);
  assert.equal(one.request_count, 1);
  assert.equal(one.evaluated_count, 1);
  assert.equal(one.discovered_count, 1);
  assert.equal(one.limit_reached, true);
  assert.equal(one.artifacts.length, 1);
  assert.equal(one.artifacts[0].status, null);
  assert.equal(one.artifacts[0].error, 'request_limit');
  assert.equal(one.artifacts[0].redirect_chain.length, 1);
  assert.ok(one.skipped.some(x => x.url === redirecting.page && x.reason === 'request_limit'));

  requested.length = 0;
  const urls = Array.from({ length: 30 }, (_, n) => `https://example.test/owned/r${n}`);
  const many = await collect(context(urls, { max_urls: 50 }), { resolve, transport });
  assert.equal(requested.length, 50, 'redirect hops count against the fifty-request ceiling');
  assert.equal(many.request_count, 50);
  assert.equal(many.discovered_count, 30);
  const cut = many.artifacts.filter(x => x.error === 'request_limit');
  const complete = many.artifacts.filter(x => x.status === 200);
  assert.equal(complete.length * 2 + cut.length, 50, 'every actual request belongs to one evaluated URL');
  assert.ok(cut.length <= 2);
  assert.equal(many.artifacts.length, many.evaluated_count);
  assert.equal(many.evaluated_count + many.skipped.filter(x => x.reason === 'url_limit').length, 30);
  assert.equal(many.skipped.filter(x => x.reason === 'request_limit').length, cut.length);
  assert.equal(many.limit_reached, true);

  requested.length = 0;
  const roomy = await collect(context(urls.slice(0, 5), { max_urls: 50 }), { resolve, transport });
  assert.equal(roomy.request_count, 10);
  assert.equal(roomy.evaluated_count, 5);
  assert.equal(roomy.limit_reached, false);
});

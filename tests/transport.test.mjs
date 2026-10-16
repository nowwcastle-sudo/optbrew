import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { inspect } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collect, fetchScoped } from '../skills/optbrew/scripts/core/collector.mjs';
import { directTransport, parseProxy, proxyTransport, selectTransport, transportFetch } from '../skills/optbrew/scripts/core/transport.mjs';
import { collectCwv } from '../skills/optbrew/scripts/core/cwv.mjs';
import { endpoints, limits } from '../skills/optbrew/scripts/core/config.mjs';
import { openStore } from '../skills/optbrew/scripts/core/evidence-store.mjs';
import { tempDir } from './support/temp-dir.mjs';
import { assertInScope } from '../skills/optbrew/scripts/core/scope.mjs';
import { runAudit } from '../skills/optbrew/scripts/audit.mjs';

const servers = [];
const sockets = new Set();
const listen = server => new Promise(resolve => { servers.push(server); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });

after(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  assert.ok(servers.length > 0 && servers.every(server => !server.listening), 'every test server is closed');
});

const targetSeen = [];
const targetPort = await listen(createServer((req, res) => {
  targetSeen.push({ url: req.url, headers: req.headers });
  if (req.method === 'POST') {
    // Echo what arrived; /owned/crux answers like the CrUX API, which needs the key header.
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const answer = req.url === '/owned/crux' ?
        (req.headers['x-goog-api-key'] ? { record: { metrics: { largest_contentful_paint: { percentiles: { p75: 2100 } } } } } : { error: { code: 403 } }) :
        { method: req.method, length: req.headers['content-length'], type: req.headers['content-type'], body };
      res.writeHead(req.url === '/owned/crux' && !req.headers['x-goog-api-key'] ? 403 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
    return;
  }
  if (req.url === '/owned/redir') { res.writeHead(302, { location: '/owned/page' }); res.end(); }
  else if (req.url === '/owned/out') { res.writeHead(302, { location: 'http://elsewhere.test/x' }); res.end(); }
  else if (req.url === '/owned/to-mapped') { res.writeHead(302, { location: `http://[::ffff:127.0.0.1]:${targetPort}/owned/page` }); res.end(); }
  else if (req.url === '/owned/big') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('x'.repeat(2000)); }
  else if (req.url === '/owned/chunked') { res.writeHead(200, { 'content-type': 'text/html' }); res.write('x'.repeat(60)); setTimeout(() => res.end('y'.repeat(60)), 5); }
  else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>ok</title></head><body>hello</body></html>'); }
}));

/** A CONNECT proxy that tunnels every requested name to the local target, like a proxy that has working DNS. */
async function startProxy({ authorization = null } = {}) {
  const connects = [];
  const proxy = createServer();
  proxy.on('connect', (req, client, head) => {
    connects.push({ url: req.url, authorization: req.headers['proxy-authorization'] ?? null });
    sockets.add(client);
    if (authorization && req.headers['proxy-authorization'] !== authorization) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return { port: await listen(proxy), connects };
}

const origin = `http://example.test:${targetPort}`;
const scope = { allowed: [{ origin, path_prefix: '/owned/' }] };
const context = urls => ({ scope, protocol: { page_types: [{ id: 'main', urls: urls.map(url => ({ original: url, normalized: url })) }] } });
const dnsDown = code => async host => { throw Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code }); };
const proxyEnv = (port, userinfo = '') => ({ HTTPS_PROXY: `http://${userinfo}127.0.0.1:${port}` });
const viaProxy = chosen => ({ transport: chosen.transport, resolve: chosen.resolve, addressVetting: chosen.address_vetting });

test('direct DNS success keeps direct', async () => {
  const proxy = await startProxy();
  const chosen = await selectTransport({ env: proxyEnv(proxy.port), resolve: async () => [{ address: '127.0.0.1', family: 4 }], probeHost: 'example.test' });
  assert.equal(chosen.address_vetting, 'direct');
  assert.equal(chosen.proxy, null);
  assert.equal(chosen.transport, directTransport);
  const local = { allowed: scope.allowed, local_targets: [{ host: 'example.test', port: targetPort }] };
  const result = await fetchScoped(`${origin}/owned/page`, { context: { scope: local }, transport: chosen.transport, resolve: chosen.resolve });
  assert.equal(result.status, 200);
  assert.deepEqual(proxy.connects, []);
});

test('DNS failure with HTTPS_PROXY switches to proxy', async () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
    const proxy = await startProxy();
    const chosen = await selectTransport({ env: proxyEnv(proxy.port), resolve: dnsDown(code), probeHost: 'example.test' });
    assert.equal(chosen.address_vetting, 'proxy');
    assert.deepEqual(chosen.proxy, { host: '127.0.0.1', port: proxy.port });
    assert.deepEqual(await chosen.resolve('example.test'), []);
    const result = await fetchScoped(`${origin}/owned/page`, { context: context([]), ...viaProxy(chosen) });
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /hello/);
    assert.deepEqual(proxy.connects.map(x => x.url), [`example.test:${targetPort}`]);
  }
});

test('DNS failure without a proxy is a classified error', async () => {
  for (const env of [{}, { HTTPS_PROXY: '' }, { HTTPS_PROXY: 'socks5://127.0.0.1:1080' }, { HTTPS_PROXY: 'https://127.0.0.1:3128' }]) {
    await assert.rejects(selectTransport({ env, resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' }), error => {
      assert.equal(error.code, 'dns_unresolvable');
      assert.equal(error.dns_code, 'ENOTFOUND');
      assert.match(error.message, /example\.test/);
      return true;
    });
  }
  const refused = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
  await assert.rejects(selectTransport({ env: proxyEnv(1), resolve: async () => { throw refused; }, probeHost: 'example.test' }), error => error === refused);
});

test('NO_PROXY host stays direct', async () => {
  const proxy = await startProxy();
  const base = proxyEnv(proxy.port);
  const select = noProxy => selectTransport({ env: { ...base, NO_PROXY: noProxy }, resolve: dnsDown('ENOTFOUND'), probeHost: 'a.Example.test' });
  for (const noProxy of ['*', 'a.example.test', 'EXAMPLE.TEST', '.example.test', 'other.test, example.test ', 'example.test:8080', '*.example.test'])
    await assert.rejects(select(noProxy), /no usable HTTPS_PROXY/, noProxy);
  for (const noProxy of ['', 'other.test', 'ample.test', 'b.example.test', 'test.example'])
    assert.equal((await select(noProxy)).address_vetting, 'proxy', noProxy);
  assert.equal((await selectTransport({ env: { ...base, no_proxy: 'example.test' }, resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' }).catch(error => error)).code, 'dns_unresolvable');
  assert.equal((await selectTransport({ env: { ...base, NO_PROXY: '*' }, resolve: async () => [], probeHost: 'example.test' })).address_vetting, 'direct');
  assert.deepEqual(proxy.connects, []);
});

test('parseProxy reads the environment without keeping the userinfo', () => {
  assert.deepEqual(parseProxy({ HTTPS_PROXY: 'http://proxy.local:3128' }), { host: 'proxy.local', port: 3128 });
  assert.deepEqual(parseProxy({ https_proxy: 'proxy.local:3128' }), { host: 'proxy.local', port: 3128 });
  assert.deepEqual(parseProxy({ HTTPS_PROXY: 'http://proxy.local' }), { host: 'proxy.local', port: 80 });
  assert.deepEqual(parseProxy({ HTTPS_PROXY: 'http://[::1]:8080' }), { host: '::1', port: 8080 });
  assert.equal(parseProxy({ HTTPS_PROXY: 'http://proxy.local:3128' }).authorization, null);
  const withUser = parseProxy({ HTTPS_PROXY: 'http://us%20er:p%40ss%2Fw%3Ard@proxy.local:3128' });
  assert.equal(withUser.authorization, `Basic ${Buffer.from('us er:p@ss/w:rd').toString('base64')}`);
  assert.equal(parseProxy({ HTTPS_PROXY: 'http://only@proxy.local' }).authorization, `Basic ${Buffer.from('only:').toString('base64')}`);
  assert.equal(parseProxy({ HTTPS_PROXY: 'http://proxy.local', https_proxy: 'http://other.local' }).host, 'proxy.local');
  for (const value of ['', '   ', 'http://', 'https://proxy.local:3128', 'socks5://proxy.local:1080', 'http://proxy.local:99999', 'http://:3128'])
    assert.equal(parseProxy({ HTTPS_PROXY: value }), null, value);
  assert.equal(parseProxy({}), null);
});

test('authenticating proxy gets Proxy-Authorization', async () => {
  const user = 'audit user'; const password = ['pw', Date.now(), '@/:'].join('-');
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const proxy = await startProxy({ authorization });
  const userinfo = `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`;
  const chosen = await selectTransport({ env: proxyEnv(proxy.port, userinfo), resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' });
  assert.equal(chosen.proxy.authorization, authorization);
  targetSeen.length = 0;
  const result = await fetchScoped(`${origin}/owned/page`, { context: context([]), ...viaProxy(chosen) });
  assert.equal(result.status, 200);
  assert.deepEqual(proxy.connects.map(x => x.authorization), [authorization]);
  assert.ok(targetSeen.length === 1 && !('proxy-authorization' in targetSeen[0].headers), 'the target never sees the proxy credential');
  const anonymous = await selectTransport({ env: proxyEnv(proxy.port), resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' });
  await assert.rejects(fetchScoped(`${origin}/owned/page`, { context: context([]), ...viaProxy(anonymous) }), /status 407/);
});

test('proxy credentials never reach evidence or errors', async () => {
  const user = 'canary-user'; const password = `canary-pw-${Date.now()}`;
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const secrets = [password, `${user}:${password}`, authorization, authorization.slice('Basic '.length)];
  const leaks = text => secrets.filter(secret => text.includes(secret));
  const proxy = await startProxy({ authorization });
  const env = proxyEnv(proxy.port, `${user}:${password}@`);
  const chosen = await selectTransport({ env, resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' });
  assert.deepEqual(leaks(JSON.stringify(chosen)), []);
  assert.deepEqual(leaks(inspect(chosen, { depth: 6, showHidden: false })), []);
  assert.deepEqual(leaks(JSON.stringify({ ...chosen.proxy })), []);

  const collected = await collect(context([`${origin}/owned/redir`]), viaProxy(chosen));
  assert.equal(collected.artifacts[0].status, 200);
  assert.deepEqual(leaks(JSON.stringify(collected)), []);

  const wrong = await selectTransport({ env: proxyEnv(proxy.port, `${user}:wrong@`), resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' });
  const refused = await fetchScoped(`${origin}/owned/page`, { context: context([]), ...viaProxy(wrong) }).catch(error => error);
  assert.equal(refused.code, 'proxy_connect_refused');
  assert.match(refused.message, new RegExp(`status 407 .*via 127\\.0\\.0\\.1:${proxy.port}$`));
  assert.match(refused.message, new RegExp(`CONNECT to port 443 only; the target port is ${targetPort}\\)`));
  assert.deepEqual(leaks(`${refused.message}${inspect(refused, { depth: 6 })}`), []);
  assert.equal(inspect(refused, { depth: 6 }).includes('wrong'), false);

  const idle = createServer(); const closedPort = await listen(idle);
  await new Promise(resolve => idle.close(resolve));
  const down = await selectTransport({ env: proxyEnv(closedPort, `${user}:${password}@`), resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' });
  const unreachable = await fetchScoped(`${origin}/owned/page`, { context: context([]), ...viaProxy(down) }).catch(error => error);
  assert.equal(unreachable.code, 'proxy_unreachable');
  assert.match(unreachable.message, new RegExp(`via 127\\.0\\.0\\.1:${closedPort}$`));
  assert.deepEqual(leaks(`${unreachable.message}${inspect(unreachable, { depth: 6 })}`), []);

  const page = `${origin}/owned/page`;
  const run = { schema_version: '1.0.0', run_id: 'proxy-evidence', target: 'example.test', environment: 'local', goals: [], allowed_changes: [],
    scope: { allowed: scope.allowed, local_targets: [{ host: 'example.test', port: targetPort }] },
    protocol: { page_types: [{ id: 'main', urls: [{ original: page, normalized: page }] }], engines: ['naver'], families: [], locale: 'ko-KR', region: 'KR',
      browser: 'Chrome', device: 'desktop', question_panel: [], surfaces: [], models: [], search_enabled: null, render: { enabled: false, pages: [], max_render_requests: 300 } },
    evaluation_version: '0.3.0', protocol_version: '0.1.0', data_sources: [], cost_decision: {}, evidence_ref: 'test/context' };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optbrew-proxy-evidence-'));
  try {
    const result = await runAudit({ context: run, modules: ['naver-searchadvisor'], outputDir: dir, transport: chosen.transport,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    assert.equal(result.artifacts[0].status, 200);
    const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
    assert.ok(files.length > 3);
    for (const file of files) assert.deepEqual(leaks(await readFile(path.join(file.parentPath, file.name), 'utf8')), [], file.name);
    assert.deepEqual(leaks(JSON.stringify(result)), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('proxy mode still rejects an out-of-scope redirect', async () => {
  const proxy = await startProxy();
  const chosen = await selectTransport({ env: proxyEnv(proxy.port), resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' });
  const error = await fetchScoped(`${origin}/owned/out`, { context: context([]), ...viaProxy(chosen) }).catch(failure => failure);
  assert.equal(error.code, 'redirect_outside_scope');
  assert.equal(error.redirect_chain.length, 1);
  assert.deepEqual(proxy.connects.map(x => x.url), [`example.test:${targetPort}`], 'no tunnel is opened toward the blocked host');
  const outside = await fetchScoped(`${origin}/elsewhere`, { context: context([]), ...viaProxy(chosen) }).catch(failure => failure);
  assert.match(outside.message, /outside allowed/);
  assert.equal(proxy.connects.length, 1);
});

test('proxy mode counts every hop', async () => {
  const proxy = await startProxy();
  const chosen = await selectTransport({ env: proxyEnv(proxy.port), resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' });
  const result = await collect(context([`${origin}/owned/redir`]), viaProxy(chosen));
  assert.equal(result.request_count, 2);
  assert.equal(result.ledger[0].requests, 2);
  assert.equal(result.artifacts[0].redirect_chain.length, 1);
  assert.equal(result.artifacts[0].final_url, `${origin}/owned/page`);
  assert.equal(proxy.connects.length, 2);
  const budget = await collect({ ...context([`${origin}/owned/redir`]), scope: { ...scope, max_urls: 1 } }, viaProxy(chosen));
  assert.equal(budget.request_count, 1, 'the redirect hop is stopped by the shared request budget');
  assert.equal(budget.ledger[0].error, 'request_limit');
  assert.equal(proxy.connects.length, 3);
  assert.throws(() => assertInScope(`${origin}/owned/page`, scope, [], { addressVetting: 'direct' }), /resolved addresses required/);
  assert.equal(assertInScope(`${origin}/owned/page`, scope, [], { addressVetting: 'proxy' }).pathname, '/owned/page');
});

test('HTTPS over the tunnel sets SNI to the host name and skips it for an IP literal', async () => {
  const proxy = await startProxy();
  const calls = [];
  const connectTls = options => { calls.push(options); return options.socket; };
  const transport = proxyTransport(parseProxy(proxyEnv(proxy.port)), { connectTls });
  const send = href => transport({ url: new URL(href), timeoutMs: 5000, maxBytes: 1_000_000, signal: new AbortController().signal });
  assert.equal((await send(`https://example.test:${targetPort}/owned/page`)).status, 200);
  assert.equal(calls[0].servername, 'example.test');
  assert.equal(calls[0].host, 'example.test');
  assert.equal(calls[0].rejectUnauthorized, true);
  assert.equal(typeof calls[0].socket.write, 'function');
  assert.equal((await send(`https://127.0.0.1:${targetPort}/owned/page`)).status, 200);
  assert.equal('servername' in calls[1], false);
  assert.equal(calls[1].host, '127.0.0.1', 'the certificate is checked against the target IP, not the proxy host');
  assert.deepEqual(proxy.connects.map(x => x.url), [`example.test:${targetPort}`, `127.0.0.1:${targetPort}`]);
});

test('both transports enforce the byte limit through the shared parser', async () => {
  const proxy = await startProxy();
  const url = new URL(`${origin}/owned/big`);
  const args = { url, timeoutMs: 5000, maxBytes: 100, signal: new AbortController().signal };
  await assert.rejects(directTransport({ ...args, address: { address: '127.0.0.1', family: 4 } }), /byte limit/);
  await assert.rejects(proxyTransport(parseProxy(proxyEnv(proxy.port)))(args), /byte limit/);
  const chunked = { ...args, url: new URL(`${origin}/owned/chunked`) };
  await assert.rejects(directTransport({ ...chunked, address: { address: '127.0.0.1', family: 4 } }), /byte limit/);
  await assert.rejects(proxyTransport(parseProxy(proxyEnv(proxy.port)))(chunked), /byte limit/);
  const whole = await proxyTransport(parseProxy(proxyEnv(proxy.port)))({ ...chunked, maxBytes: 1000 });
  assert.equal(whole.body.length, 120);
});

const proxied = async (port, urlOrigins, localTargets = []) => {
  const chosen = await selectTransport({ env: proxyEnv(port), resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' });
  const scoped = { allowed: urlOrigins.map(value => ({ origin: value, path_prefix: '/owned/' })), local_targets: localTargets };
  return (href, extra = {}) => fetchScoped(href, { context: { scope: scoped }, ...viaProxy(chosen), ...extra });
};

test('proxy mode vets IP literals on the first hop and on every redirect hop', async () => {
  const proxy = await startProxy();
  const metadata = await proxied(proxy.port, ['http://169.254.169.254']);
  const first = await metadata('http://169.254.169.254/owned/page').catch(error => error);
  assert.equal(first.code, 'scope_rejected');
  assert.match(first.message, /private or reserved/);
  const mapped = await proxied(proxy.port, [origin, `http://[::ffff:127.0.0.1]:${targetPort}`]);
  const hop = await mapped(`${origin}/owned/to-mapped`).catch(error => error);
  assert.equal(hop.code, 'scope_rejected');
  assert.equal(hop.redirect_chain.length, 1);
  assert.deepEqual(proxy.connects.map(x => x.url), [`example.test:${targetPort}`], 'no tunnel is opened toward the blocked literal');
  const ok = await proxied(proxy.port, [origin]);
  assert.equal((await ok(`${origin}/owned/page`)).status, 200, 'names are not vetted locally in proxy mode');
});

test('proxy mode honors local_targets for literals and rejects localhost names otherwise', async () => {
  const proxy = await startProxy();
  const local = await proxied(proxy.port, [`http://127.0.0.1:${targetPort}`], [{ host: '127.0.0.1', port: targetPort }]);
  assert.equal((await local(`http://127.0.0.1:${targetPort}/owned/page`)).status, 200);
  for (const host of ['localhost', 'app.localhost', 'LOCALHOST', 'localhost.', 'app.localhost.']) {
    const before = proxy.connects.length;
    const fetchHost = await proxied(proxy.port, [`http://${host}:${targetPort}`]);
    const error = await fetchHost(`http://${host}:${targetPort}/owned/page`).catch(failure => failure);
    assert.equal(error.code, 'scope_rejected', host);
    assert.match(error.message, /localhost outside local target/);
    assert.equal(proxy.connects.length, before);
  }
  const allowed = await proxied(proxy.port, [`http://localhost:${targetPort}`], [{ host: 'localhost', port: targetPort }]);
  assert.equal((await allowed(`http://localhost:${targetPort}/owned/page`)).status, 200);
  const dotted = await proxied(proxy.port, [`http://localhost.:${targetPort}`], [{ host: 'localhost', port: targetPort }]);
  assert.equal((await dotted(`http://localhost.:${targetPort}/owned/page`)).status, 200, 'a local target for localhost also allows localhost.');
});

test('proxy address vetting requires the proxy transport', async () => {
  const resolve = async () => [{ address: '127.0.0.1', family: 4 }];
  const local = { scope: { allowed: scope.allowed, local_targets: [{ host: 'example.test', port: targetPort }] } };
  await assert.rejects(fetchScoped(`${origin}/owned/page`, { context: local, resolve, addressVetting: 'proxy' }), /requires the proxy transport/);
  await assert.rejects(fetchScoped(`${origin}/owned/page`, { context: local, resolve, transport: directTransport, addressVetting: 'proxy' }), /requires the proxy transport/);
  const collected = await collect(context([`${origin}/owned/page`]), { resolve, addressVetting: 'proxy' });
  assert.equal(collected.artifacts[0].error, 'fetch_failed', 'collect records the refusal as a failed fetch');
  assert.equal(collected.artifacts[0].status, null);
  assert.equal(proxyTransport({ host: '127.0.0.1', port: 1, authorization: null }).addressVetting, 'proxy');
});

test('a TLS setup failure closes the tunnel socket', async () => {
  const proxy = await startProxy();
  let tunnel;
  const connectTls = options => { tunnel = options.socket; throw new Error('tls setup failed'); };
  const transport = proxyTransport(parseProxy(proxyEnv(proxy.port)), { connectTls });
  await assert.rejects(transport({ url: new URL(`https://example.test:${targetPort}/owned/page`), timeoutMs: 5000, maxBytes: 1000, signal: new AbortController().signal }), /tls setup failed/);
  assert.equal(tunnel.destroyed, true);
});

test('a silent proxy fails within one deadline as a classified timeout', async () => {
  const silent = createServer();
  silent.on('connect', (req, client) => { sockets.add(client); });
  const port = await listen(silent);
  const transport = proxyTransport(parseProxy(proxyEnv(port)));
  const started = performance.now();
  const error = await transport({ url: new URL(`${origin}/owned/page`), timeoutMs: 300, maxBytes: 1000, signal: new AbortController().signal }).catch(failure => failure);
  assert.equal(error.code, 'proxy_timeout');
  assert.match(error.message, new RegExp(`via 127\\.0\\.0\\.1:${port}$`));
  assert.ok(performance.now() - started < 300 + 400, 'one deadline, not one per phase');
});

test('a POST with a body works on both transports', async () => {
  const payload = JSON.stringify({ name: '한글', origin });
  const post = { method: 'POST', body: payload, headers: { 'content-type': 'application/json' } };
  const local = { allowed: scope.allowed, local_targets: [{ host: 'example.test', port: targetPort }] };
  const direct = await fetchScoped(`${origin}/owned/echo`, { context: { scope: local }, transport: directTransport,
    resolve: async () => [{ address: '127.0.0.1', family: 4 }], ...post });
  const proxy = await startProxy();
  const chosen = await selectTransport({ env: proxyEnv(proxy.port), resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' });
  const tunnelled = await fetchScoped(`${origin}/owned/echo`, { context: { scope }, ...viaProxy(chosen), ...post });
  for (const result of [direct, tunnelled]) {
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body.toString('utf8')), { method: 'POST', length: String(Buffer.byteLength(payload)), type: 'application/json', body: payload });
  }
  assert.equal(proxy.connects.length, 1);
});

test('collectCwv over the proxy transport gets CrUX data through CONNECT', async () => {
  const proxy = await startProxy();
  const chosen = await selectTransport({ env: proxyEnv(proxy.port), resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' });
  const send = transportFetch(chosen, { timeoutMs: limits().cwv_timeout_ms, maxBytes: limits().cwv_max_bytes });
  // The proxy tunnels every name to the local target, so the Google endpoint is redirected to a route of that target.
  const fetchFn = (url, init) => send(url === endpoints().crux ? `${origin}/owned/crux` : url, init);
  const dir = await tempDir('optbrew-cwv-proxy-');
  const store = openStore(dir, { run_id: 'cwv-proxy' });
  const key = ['AI', 'za', 'Sy', 'Proxy', 'Key', '0123456789', 'abcdefghij', 'KLMN'].join('');
  await collectCwv({ origin: 'https://example.test', key, fetchFn, store });
  assert.deepEqual(proxy.connects.map(x => x.url), [`example.test:${targetPort}`]);
  const { cwv } = await store.index();
  assert.equal(cwv.length, 1);
  const record = JSON.parse(await store.read(cwv[0].evidence_ref, cwv[0].sha256));
  assert.equal(record.status, 200);
  assert.equal(record.body.record.metrics.largest_contentful_paint.percentiles.p75, 2100);
  assert.equal((await readFile(cwv[0].evidence_ref, 'utf8')).includes(key), false);
});

test('transportFetch refuses an out-of-scope literal address in proxy mode and never follows a redirect', async () => {
  const proxy = await startProxy();
  const chosen = await selectTransport({ env: proxyEnv(proxy.port), resolve: dnsDown('ENOTFOUND'), probeHost: 'example.test' });
  const send = transportFetch(chosen, { timeoutMs: 5000, maxBytes: 100000 });
  await assert.rejects(send('http://169.254.169.254/latest', { method: 'POST', body: '{}' }), /scope|address|private|link/i);
  await assert.rejects(send(`${origin}/owned/redir`), /redirect/i);
});

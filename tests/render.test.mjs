import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findChrome, launchChrome } from '../skills/optbrew/scripts/core/chrome.mjs';
import { openStore } from '../skills/optbrew/scripts/core/evidence-store.mjs';
import { renderChrome, renderPages, selectRenderPages } from '../skills/optbrew/scripts/core/render.mjs';
import { checkLedger } from '../skills/optbrew/scripts/core/report.mjs';
import { parseProxy } from '../skills/optbrew/scripts/core/transport.mjs';
import { killTreeByPid, processesWith, remaining } from './support/processes.mjs';

const found = findChrome();
const skip = found ? false : 'no Chrome found on this machine (set OPTBREW_CHROME)';

// Everything this run starts lives under `root`; the guard at the end finds any process whose command line names it.
const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-t6-'));
const runDir = path.join(root, 'profiles');
await mkdir(runDir);

const servers = [];
const listen = server => new Promise(resolve => { servers.push(server); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const html = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };

let storeCount = 0;
const newStore = async header => {
  const dir = path.join(root, `store-${storeCount++}`);
  await mkdir(dir);
  return { dir, store: openStore(dir, header ?? { run_id: 'render-test' }) };
};

const ref = url => ({ original: url, normalized: url });
const contextFor = (scope, pages, render = {}) => ({ scope,
  protocol: { render: { enabled: true, pages: pages.map(ref), max_render_requests: 100, ...render } } });
const direct = (resolve = async () => [{ address: '127.0.0.1', family: 4 }]) => ({ address_vetting: 'direct', resolve, proxy: null });

/** Launches under `runDir` and lists the command lines of this run's Chrome right after the start, for the pinning and proxy checks. */
function launcher({ extraRules = null } = {}) {
  const launched = { options: null, commandLines: [] };
  const launch = async options => {
    launched.options = options;
    const rules = [options.hostRules, extraRules].filter(Boolean).join(',') || null;
    const chrome = await launchChrome({ ...options, hostRules: rules, tmpRoot: runDir });
    launched.commandLines = (await processesWith(runDir)).map(entry => entry.commandLine);
    return chrome;
  };
  return { launch, launched };
}

/** Render `context` through a handle that is always closed, so no test can leave a Chrome behind. */
async function renderWith({ context, transport = direct(), store, launch = launcher().launch }) {
  const chrome = renderChrome({ context, transport, find: () => found, launch });
  try { return await renderPages({ context, chrome, store }); } finally { await chrome.close(); }
}

describe('render stage', async () => {
  after(async () => {
    const leftovers = await remaining(root);
    for (const entry of leftovers) await killTreeByPid(entry.pid);
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    assert.deepEqual(leftovers.map(entry => `${entry.pid} ${entry.commandLine.slice(0, 160)}`), [], 'no process from this test run is left');
    assert.ok(servers.every(server => !server.listening), 'every test server is closed');
  });

  test('selectRenderPages is deterministic and capped', () => {
    const types = [
      { id: 'home', urls: [ref('https://example.test/'), ref('https://example.test/second')] },
      { id: 'empty', urls: [] },
      { id: 'article', urls: [ref('https://example.test/a'), ref('https://example.test/b')] },
      { id: 'product', urls: [ref('https://example.test/p')] },
    ];
    const selected = selectRenderPages(types, 10);
    assert.deepEqual(selected.map(x => x.normalized), ['https://example.test/', 'https://example.test/a', 'https://example.test/p']);
    assert.deepEqual(selectRenderPages(structuredClone(types), 10), selected);
    assert.deepEqual(selectRenderPages(types, 2).map(x => x.normalized), ['https://example.test/', 'https://example.test/a']);
    assert.deepEqual(selectRenderPages(types, 0), []);
    assert.equal(selectRenderPages(Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, urls: [ref(`https://example.test/${i}`)] }))).length, 10);
  });

  test('nothing is rendered, and no Chrome is started, when rendering is off or no Chrome exists', async () => {
    const { store } = await newStore();
    const scope = { allowed: [{ origin: 'http://127.0.0.1:1' }] };
    let launches = 0;
    const launch = async () => { launches += 1; throw new Error('must not launch'); };
    for (const [render, find] of [[{ enabled: false }, () => found], [{ pages: [] }, () => found], [{}, () => null], [{}, () => ({ path: null, reason: 'optbrew_chrome_missing' })]]) {
      const context = contextFor(scope, ['http://127.0.0.1:1/'], render);
      const chrome = renderChrome({ context, transport: direct(), find, launch });
      assert.deepEqual(await renderPages({ context, chrome, store }), []);
      await chrome.close();
    }
    assert.equal(launches, 0);
    assert.deepEqual(await store.index().then(index => [index.renders, index.render_ledger]), [[], []]);
  });

  const targetSeen = [];
  const targetPort = await listen(createServer((req, res) => {
    targetSeen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': req.url.endsWith('.png') ? 'image/png' : 'text/plain' });
    res.end(req.url.endsWith('.png') ? Buffer.from('iVBORw0KGgo=', 'base64') : 'third party');
  }));
  const ownerSeen = [];
  const ownerPort = await listen(createServer((req, res) => {
    ownerSeen.push(`${req.method} ${req.url} host=${req.headers.host}`);
    if (req.url === '/page') {
      html(res, `<!doctype html><title>Rendered 한글</title><div id="app">empty</div>
<a href="/b">b</a><a href="/a#x">a</a><a href="/a#y">a again</a><a href="/b">b again</a>
<a href="http://127.0.0.1:${targetPort}/off">off</a><a href="mailto:x@example.test">mail</a>
<img src="http://cdn.example.test:${targetPort}/i.png">
<script>
document.getElementById('app').textContent = 'built by script';
console.error('render-boom');
fetch('http://cdn.example.test:${targetPort}/data.json').catch(() => {});
fetch('/beacon', { method: 'POST' }).catch(() => {});
</script>`);
    } else if (req.url === '/leaves') html(res, `<title>first</title><script>location.replace('http://127.0.0.1:${targetPort}/landing');</script>`);
    else if (req.url === '/many') html(res, `<title>many</title>${Array.from({ length: 20 }, (_, i) => `<img src="/img-${i}.png">`).join('')}`);
    else html(res, '<title>plain</title>');
  }));
  const ownerScope = { allowed: [{ origin: `http://127.0.0.1:${ownerPort}` }], local_targets: [{ host: '127.0.0.1', port: ownerPort }] };
  const owner = suffix => `http://127.0.0.1:${ownerPort}${suffix}`;
  const thirdPartyRules = { extraRules: 'MAP *.example.test 127.0.0.1' };

  test('renders an in-scope page and stores DOM evidence', { skip }, async () => {
    targetSeen.length = 0;
    const { store } = await newStore();
    const [record, ...others] = await renderWith({ context: contextFor(ownerScope, [owner('/page')]), store, launch: launcher(thirdPartyRules).launch });
    assert.deepEqual(others, []);
    assert.equal(record.url, owner('/page'));
    assert.equal(record.final_url, owner('/page'));
    assert.equal(record.status, 200);
    assert.equal(record.title, 'Rendered 한글');
    assert.equal(record.address_vetting, 'pinned');
    assert.deepEqual(record.links, [owner('/a'), owner('/b')], 'same-origin, fragment-free, each once, sorted');
    assert.ok(record.console_errors.some(text => text.includes('render-boom')));
    assert.equal(record.blocked_reason, null);

    const dom = (await store.read(record.dom_ref, record.dom_sha256)).toString('utf8');
    assert.match(dom, /<div id="app">built by script<\/div>/, 'the stored DOM is the rendered one, after the script ran');
    assert.ok(dom.includes('Rendered 한글'));

    const byUrl = new Map(record.requests.map(request => [new URL(request.url).pathname, request]));
    assert.equal(byUrl.get('/page').action, 'allowed');
    assert.equal(byUrl.get('/i.png').action, 'third_party_static');
    assert.deepEqual([byUrl.get('/data.json').action, byUrl.get('/data.json').blocked_reason], ['blocked', 'out_of_scope']);
    assert.deepEqual([byUrl.get('/beacon').action, byUrl.get('/beacon').blocked_reason], ['blocked', 'non_get_request']);
    assert.ok(!targetSeen.includes('GET /data.json'), 'the out-of-scope fetch never reached its server');

    const index = await store.index();
    assert.equal(index.renders.length, 1);
    assert.equal(index.renders[0].url, owner('/page'));
    const saved = JSON.parse((await store.read(index.renders[0].evidence_ref, index.renders[0].sha256)).toString('utf8'));
    assert.deepEqual(saved, record, 'the stored record is the returned record');
    assert.ok(index.render_ledger.length >= 4 && index.render_ledger.every(entry => entry.page === owner('/page')));
  });

  test('a page that leaves the scope is recorded as blocked and its target never sees a request', { skip }, async () => {
    targetSeen.length = 0;
    const { store } = await newStore();
    const [record] = await renderWith({ context: contextFor(ownerScope, [owner('/leaves')]), store });
    assert.equal(record.blocked_reason, 'out_of_scope');
    assert.equal(record.dom_ref, null);
    assert.equal(record.dom_sha256, null);
    assert.deepEqual(targetSeen, []);
    const index = await store.index();
    assert.ok(index.render_ledger.some(entry => entry.outcome === 'skipped' && entry.skipped_reason === 'outside_scope' && entry.requests === 0));
  });

  test('a render stops at its own request budget, not the crawl limit', { skip }, async () => {
    const { store } = await newStore();
    const [record] = await renderWith({ context: contextFor(ownerScope, [owner('/many')], { max_render_requests: 5 }), store });
    assert.equal(record.blocked_reason, 'render_budget');
    assert.ok(record.requests.length <= 6, 'five requests and the first refused one are listed');
    assert.equal(record.requests.filter(request => request.blocked_reason === 'render_budget').length, 1);
  });

  test('renders an IDN origin through its punycode host', { skip }, async () => {
    const seen = [];
    const port = await listen(createServer((req, res) => { seen.push(req.headers.host); html(res, '<meta charset="utf-8"><title>Bücher 한글</title><p>grüße</p>'); }));
    const origin = `http://bücher.test:${port}`;
    const scope = { allowed: [{ origin }], local_targets: [{ host: 'xn--bcher-kva.test', port }] };
    const page = { original: `${origin}/`, normalized: `http://xn--bcher-kva.test:${port}/` };
    const context = { scope, protocol: { render: { enabled: true, pages: [page], max_render_requests: 50 } } };
    const { store } = await newStore();
    const { launch, launched } = launcher();
    const [record] = await renderWith({ context, store, launch });
    assert.equal(record.final_url, page.normalized);
    assert.equal(record.title, 'Bücher 한글');
    assert.equal(record.status, 200);
    assert.ok(seen.every(host => host === `xn--bcher-kva.test:${port}`) && seen.length > 0, `the server saw the punycode host: ${seen}`);
    assert.equal(launched.options.hostRules, 'MAP xn--bcher-kva.test 127.0.0.1');
    assert.ok((await store.read(record.dom_ref, record.dom_sha256)).toString('utf8').includes('grüße'));
  });

  test('pins the vetted address in direct mode', { skip }, async () => {
    const seen = [];
    const port = await listen(createServer((req, res) => { seen.push(req.headers.host); html(res, '<title>pinned</title>'); }));
    const scope = { allowed: [{ origin: `http://pinned.test:${port}` }, { origin: 'http://private.test:81' }],
      local_targets: [{ host: 'pinned.test', port }] };
    const resolved = [];
    const resolve = async host => {
      resolved.push(host);
      return [{ address: host === 'pinned.test' ? '127.0.0.1' : '10.0.0.5', family: 4 }];
    };
    const context = contextFor(scope, [`http://pinned.test:${port}/`, 'http://private.test:81/']);
    const { store } = await newStore();
    const { launch, launched } = launcher();
    const [pinned, refused] = await renderWith({ context, transport: direct(resolve), store, launch });
    assert.deepEqual(resolved, ['pinned.test', 'private.test'], 'each allowed host is resolved and vetted once');
    assert.equal(launched.options.hostRules, 'MAP pinned.test 127.0.0.1,MAP private.test ^NOTFOUND');
    assert.ok(launched.commandLines.some(line => line.includes('--host-resolver-rules=MAP pinned.test 127.0.0.1,MAP private.test ^NOTFOUND')),
      'Chrome was started with the rules');
    assert.equal(pinned.title, 'pinned');
    assert.equal(pinned.address_vetting, 'pinned');
    assert.deepEqual([...new Set(seen)], [`pinned.test:${port}`]);
    assert.equal(refused.dom_ref, null, 'a host whose address fails vetting is not rendered');
    assert.match(refused.blocked_reason, /ERR_NAME_NOT_RESOLVED/);
  });

  test('renders through an authenticating proxy', { skip }, async () => {
    const user = 'proxy-user';
    const password = 'proxy-pass-6d41b8';
    const proxySeen = [];
    const proxyPort = await listen(createServer((req, res) => {
      proxySeen.push({ url: req.url, authorization: req.headers['proxy-authorization'] ?? null });
      const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
      if (req.headers['proxy-authorization'] !== expected) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="proxy"' }); res.end(); return; }
      html(res, '<title>through the proxy</title><a href="/next">next</a>');
    }));
    // Chrome sends loopback targets straight to the server, never to a proxy, so the page uses a name that is not loopback.
    const proxy = parseProxy({ HTTPS_PROXY: `http://${user}:${password}@127.0.0.1:${proxyPort}` });
    const transport = { address_vetting: 'proxy', resolve: async () => [], proxy };
    const scope = { allowed: [{ origin: 'http://via-proxy.test' }] };
    const context = contextFor(scope, ['http://via-proxy.test/']);
    const { dir, store } = await newStore();
    const { launch, launched } = launcher();
    const [record] = await renderWith({ context, transport, store, launch });
    assert.equal(record.status, 200);
    assert.equal(record.title, 'through the proxy');
    assert.equal(record.address_vetting, 'proxy');
    assert.deepEqual(record.links, ['http://via-proxy.test/next']);
    assert.equal(launched.options.hostRules, undefined, 'proxy mode pins nothing');
    assert.deepEqual([launched.options.proxy.host, launched.options.proxy.port], ['127.0.0.1', proxyPort]);
    assert.equal(proxySeen[0].authorization, null);
    assert.ok(proxySeen.some(seen => seen.authorization !== null), 'the retry carried the credentials');
    const secrets = [password, Buffer.from(`${user}:${password}`).toString('base64')];
    for (const name of await readdir(dir)) {
      const text = await readFile(path.join(dir, name), 'utf8');
      assert.ok(secrets.every(secret => !text.includes(secret)), `${name} holds no proxy credential`);
    }
    assert.ok(launched.commandLines.some(line => line.includes(`--proxy-server=127.0.0.1:${proxyPort}`)));
    assert.ok(launched.commandLines.every(line => secrets.every(secret => !line.includes(secret))), 'no credential on a command line');
  });

  test('render ledger entries replay with checkLedger', { skip }, async () => {
    const { store } = await newStore();
    const page = owner('/page');
    await renderWith({ context: contextFor(ownerScope, [page]), store, launch: launcher(thirdPartyRules).launch });
    const entries = (await store.index()).render_ledger.filter(entry => entry.page === page);
    assert.ok(entries.some(entry => entry.outcome === 'response') && entries.some(entry => entry.outcome === 'skipped'));
    assert.equal(new Set(entries.filter(entry => entry.skipped_reason !== 'outside_scope').map(entry => entry.url)).size,
      entries.filter(entry => entry.skipped_reason !== 'outside_scope').length, 'one entry per URL');

    /** The input checkLedger reads, built from what the render recorded; `claimed` is the ledger the replay is asked to accept. */
    const replay = (claimed, list = entries) => {
      const total = list.reduce((sum, entry) => sum + entry.requests, 0);
      const answered = list.filter(entry => entry.outcome === 'response');
      const artifacts = answered.map(entry => ({ normalized_url: entry.url, status: 200, capability: 'raw_response',
        redirect_chain: Array.from({ length: entry.requests - 1 }) }));
      return () => checkLedger(
        { run_context: { scope: { ...ownerScope, max_urls: total }, protocol: { page_types: [{ id: 'primary', urls: [ref(page)] }] } } },
        { ledger_ref: 'ledger', responses: artifacts, failures: [] },
        { skipped: list.filter(entry => entry.skipped_reason).map(entry => ({ url: entry.url, reason: entry.skipped_reason })),
          limit_reached: false, request_count: total, evaluated_count: answered.length },
        artifacts, () => ({ text: JSON.stringify({ entries: claimed, limit: total }) }));
    };
    replay(entries)();
    const padded = entries.map(entry => entry.url.endsWith('/beacon') ? { ...entry, requests: 1 } : entry);
    assert.throws(replay(padded, padded), /skipped entry carries requests/);
    const [first] = entries.filter(entry => entry.outcome === 'response');
    assert.throws(replay(entries.map(entry => entry === first ? { ...entry, requests: entry.requests + 1 } : entry)), /more requests than the limit/);
    assert.throws(replay(entries.filter(entry => entry !== first)), /differ from the ledger/);
  });
});

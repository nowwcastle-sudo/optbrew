import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { chromeHandle, findChrome, launchChrome } from '../skills/optbrew/scripts/core/chrome.mjs';
import { openStore } from '../skills/optbrew/scripts/core/evidence-store.mjs';
import { checkRenderLedger, renderChrome, renderPages, selectRenderPages } from '../skills/optbrew/scripts/core/render.mjs';
import { parseProxy } from '../skills/optbrew/scripts/core/transport.mjs';
import { killTreeByPid, processesWith, remaining } from './support/processes.mjs';
import { tempDir } from './support/temp-dir.mjs';

const found = findChrome();
const skip = found ? false : 'no Chrome found on this machine (set OPTBREW_CHROME)';

// Everything this run starts lives under `root`; the guard at the end finds any process whose command line names it.
const root = await tempDir('optbrew-t6-');
const runDir = path.join(root, 'profiles');
await mkdir(runDir);

const servers = [];
const listen = server => new Promise(resolve => { servers.push(server); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const html = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };

let storeCount = 0;
const newStore = async () => {
  const dir = path.join(root, `store-${storeCount++}`);
  await mkdir(dir);
  return { dir, store: openStore(dir, { run_id: 'render-test' }) };
};

const ref = url => ({ original: url, normalized: url });
const contextFor = (scope, pages, render = {}) => ({ scope,
  protocol: { render: { enabled: true, pages: pages.map(ref), max_render_requests: 100, ...render } } });

const publicAddress = '93.184.216.34';
const png = Buffer.from('iVBORw0KGgo=', 'base64');
/**
 * A direct-mode `selectTransport` result that stays local: `cdn.example.test` resolves to a public address (unless `resolve`
 * says otherwise) and the transport that would connect to it is a stub that records what it was asked and answers with fixed
 * bytes, so no test touches the network.
 */
function direct({ resolve, transport } = {}) {
  const calls = [];
  return { address_vetting: 'direct', proxy: null, calls,
    resolve: resolve ?? (async host => [{ address: host === 'cdn.example.test' ? publicAddress : '127.0.0.1', family: 4 }]),
    transport: transport ?? (async ({ url, address }) => {
      calls.push({ url: url.href, address: address.address });
      if (url.pathname.endsWith('.png')) return { status: 200, headers: { 'content-type': 'image/png' }, body: png };
      if (url.pathname.endsWith('.css')) return { status: 200, headers: { 'content-type': 'text/css' }, body: Buffer.from('#x { color: rgb(1, 2, 3); }') };
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('no') };
    }) };
}

/** Launches under `runDir` and lists the command lines of this run's Chrome right after the start, for the pinning and proxy checks. */
function launcher() {
  const launched = { options: null, commandLines: [] };
  const launch = async options => {
    launched.options = options;
    const chrome = await launchChrome({ ...options, tmpRoot: runDir });
    launched.commandLines = (await processesWith(runDir)).map(entry => entry.commandLine);
    return chrome;
  };
  return { launch, launched };
}

/** Render `context` through a handle that is always closed, so no test can leave a Chrome behind. */
async function renderAll({ context, transport = direct(), store, launch = launcher().launch }) {
  const chrome = renderChrome({ context, transport, find: () => found, launch });
  try { return await renderPages({ context, chrome, store }); } finally { await chrome.close(); }
}
const renderWith = async options => (await renderAll(options)).renders;

describe('render stage', async () => {
  after(async () => {
    const leftovers = await remaining(root);
    for (const entry of leftovers) await killTreeByPid(entry.pid);
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
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

  test('nothing is rendered, no Chrome is started, and the result says why', async () => {
    const { store } = await newStore();
    const scope = { allowed: [{ origin: 'http://127.0.0.1:1' }] };
    let launches = 0;
    const launch = async () => { launches += 1; throw new Error('must not launch'); };
    const asked = [[{ enabled: false }, () => found], [{ pages: [] }, () => found]];
    for (const [render, find] of asked) {
      const context = contextFor(scope, ['http://127.0.0.1:1/'], render);
      const chrome = renderChrome({ context, transport: direct(), find, launch });
      assert.deepEqual(await renderPages({ context, chrome, store }), { renders: [], chrome: { found: null, reason: 'render_not_requested' } });
      await chrome.close();
    }
    const missing = [[() => null, 'chrome_not_found'], [() => ({ path: null, kind: null, reason: 'optbrew_chrome_missing' }), 'optbrew_chrome_missing']];
    for (const [find, reason] of missing) {
      const context = contextFor(scope, ['http://127.0.0.1:1/']);
      const chrome = renderChrome({ context, transport: direct(), find, launch });
      assert.deepEqual(await renderPages({ context, chrome, store }), { renders: [], chrome: { found: false, reason } });
      await chrome.close();
    }
    assert.equal(launches, 0);
    assert.deepEqual(await store.index().then(index => [index.renders, index.render_ledger]), [[], []]);
    const plain = chromeHandle({ find: () => null, launch });
    await assert.rejects(renderPages({ context: contextFor(scope, ['http://127.0.0.1:1/']), chrome: plain, store }), /renderChrome/);
  });

  const targetSeen = [];
  const targetPort = await listen(createServer((req, res) => {
    targetSeen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': req.url.endsWith('.png') ? 'image/png' : 'text/plain' });
    res.end('private host content');
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
    } else if (req.url === '/outcomes') {
      html(res, `<!doctype html><title>outcomes</title><img src="/gone.png"><img src="/reset">
<script>
fetch('/beacon', { method: 'POST' }).catch(() => {});
fetch('/beacon').catch(() => {});
fetch('/hop').catch(() => {});
</script>`);
    } else if (req.url === '/styled') {
      html(res, `<!doctype html><title>unstyled</title><div id="x">hi</div>
<link rel="stylesheet" href="http://cdn.example.test:${targetPort}/s.css">
<script>window.addEventListener('load', () => { document.title = getComputedStyle(document.getElementById('x')).color; });</script>`);
    } else if (req.url === '/fonts') {
      html(res, `<!doctype html><title>fonts</title>
<style>@font-face { font-family: A; src: url(http://cdn.example.test:${targetPort}/with.ttf); }
@font-face { font-family: B; src: url(http://cdn.example.test:${targetPort}/without.ttf); }</style>
<script>
const load = family => document.fonts.load('16px ' + family).then(list => list.length, () => 'error');
Promise.all([load('A'), load('B')]).then(results => { document.title = 'fonts:' + results.join(','); });
</script>`);
    } else if (req.url === '/hop') { res.writeHead(302, { location: '/plain' }); res.end(); }
    else if (req.url === '/gone.png') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('gone'); }
    else if (req.url === '/reset') req.socket.destroy();
    else if (req.url === '/leaves') html(res, `<title>first</title><script>location.replace('http://127.0.0.1:${targetPort}/landing');</script>`);
    else if (req.url === '/many') html(res, `<title>many</title>${Array.from({ length: 20 }, (_, i) => `<img src="/img-${i}.png">`).join('')}`);
    else html(res, '<title>plain</title>');
  }));
  const ownerScope = { allowed: [{ origin: `http://127.0.0.1:${ownerPort}` }], local_targets: [{ host: '127.0.0.1', port: ownerPort }] };
  const owner = suffix => `http://127.0.0.1:${ownerPort}${suffix}`;
  const byPath = record => new Map(record.requests.map(request => [new URL(request.url).pathname + new URL(request.url).search, request]));

  test('renders an in-scope page and stores DOM evidence', { skip }, async () => {
    targetSeen.length = 0;
    const { store } = await newStore();
    const transport = direct();
    const { launch, launched } = launcher();
    const [record, ...others] = await renderWith({ context: contextFor(ownerScope, [owner('/page')]), transport, store, launch });
    assert.deepEqual(others, []);
    assert.equal(record.url, owner('/page'));
    assert.equal(record.final_url, owner('/page'));
    assert.equal(record.status, 200);
    assert.equal(record.title, 'Rendered 한글');
    assert.equal(record.address_vetting, 'pinned');
    assert.deepEqual(record.links, [owner('/a'), owner('/b')], 'same-origin, fragment-free, each once, sorted');
    assert.ok(record.console_errors.some(text => text.includes('render-boom')));
    assert.equal(record.blocked_reason, null);
    assert.equal(launched.options.hostRules, 'EXCLUDE 127.0.0.1,MAP * ^NOTFOUND', 'IP literals stay reachable, every other name is not resolved by Chrome');

    const dom = (await store.read(record.dom_ref, record.dom_sha256)).toString('utf8');
    assert.match(dom, /<div id="app">built by script<\/div>/, 'the stored DOM is the rendered one, after the script ran');
    assert.ok(dom.includes('Rendered 한글'));
    assert.ok(record.dom_ref.endsWith('.render-dom'), record.dom_ref);

    const requests = byPath(record);
    assert.deepEqual([requests.get('/page').action, requests.get('/page').status], ['allowed', 200]);
    assert.deepEqual([requests.get('/i.png').action, requests.get('/i.png').status], ['third_party_static', 200]);
    assert.deepEqual(transport.calls, [{ url: `http://cdn.example.test:${targetPort}/i.png`, address: publicAddress }], 'Node fetched it from the vetted address');
    assert.deepEqual([requests.get('/data.json').action, requests.get('/data.json').blocked_reason], ['blocked', 'out_of_scope']);
    const beacon = record.requests.find(request => request.method === 'POST');
    assert.deepEqual([beacon.action, beacon.blocked_reason], ['blocked', 'non_get_request']);
    assert.deepEqual(targetSeen, [], 'Chrome never contacted the third-party host');

    const index = await store.index();
    assert.equal(index.renders.length, 1);
    assert.equal(index.renders[0].url, owner('/page'));
    const saved = JSON.parse((await store.read(index.renders[0].evidence_ref, index.renders[0].sha256)).toString('utf8'));
    assert.deepEqual(saved, record, 'the stored record is the returned record');
    assert.equal(index.render_ledger.find(entry => entry.url.endsWith('/page')).error, null);
  });

  test('records the outcome of every request from the network events, never assumed', { skip }, async () => {
    const { store } = await newStore();
    const [record] = await renderWith({ context: contextFor(ownerScope, [owner('/outcomes')]), store });
    assert.equal(record.blocked_reason, null);
    const requests = byPath(record);
    assert.equal(requests.get('/gone.png').status, 404);
    assert.equal(requests.get('/gone.png').error, null);
    assert.equal(requests.get('/reset').status, null);
    assert.match(requests.get('/reset').error, /^net::ERR_/);
    assert.equal(requests.get('/hop').status, 302);
    assert.equal(requests.get('/plain').status, 200);
    assert.equal(requests.get('/plain').redirected, true);

    const entries = (await store.index()).render_ledger.filter(entry => entry.page === owner('/outcomes'));
    const entry = (suffix, outcome) => entries.find(item => item.url.endsWith(suffix) && item.outcome === outcome);
    assert.equal(entry('/gone.png', 'response').requests, 1);
    assert.match(entry('/reset', 'error').error, /^net::ERR_/);
    assert.equal(entry('/outcomes', 'response').error, null);
    assert.deepEqual([entry('/beacon', 'response').requests, entry('/beacon', 'skipped').skipped_reason], [1, 'non_get_request'], 'a URL repeats only with distinct reasons');
  });

  test('a third-party static host resolving to a private address is refused in direct mode', { skip }, async () => {
    targetSeen.length = 0;
    const { store } = await newStore();
    const transport = direct({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    const [record] = await renderWith({ context: contextFor(ownerScope, [owner('/page')]), transport, store });
    const image = byPath(record).get('/i.png');
    assert.deepEqual([image.action, image.blocked_reason, image.status], ['blocked', 'third_party_refused', null]);
    assert.deepEqual(transport.calls, [], 'the vetted fetch refused it before any connection');
    assert.deepEqual(targetSeen, [], 'the private host got no request, from Node or from Chrome');
    const entry = (await store.index()).render_ledger.find(item => item.url.endsWith('/i.png'));
    assert.deepEqual([entry.outcome, entry.skipped_reason, entry.requests], ['skipped', 'third_party_refused', 0]);
  });

  test('a public third-party stylesheet is served through the vetted fetch', { skip }, async () => {
    targetSeen.length = 0;
    const { store } = await newStore();
    const transport = direct();
    const [record] = await renderWith({ context: contextFor(ownerScope, [owner('/styled')]), transport, store });
    assert.equal(record.title, 'rgb(1, 2, 3)', 'Chrome applied the stylesheet Node fetched');
    const sheet = byPath(record).get('/s.css');
    assert.deepEqual([sheet.action, sheet.status], ['third_party_static', 200]);
    assert.deepEqual(transport.calls.map(call => call.address), [publicAddress]);
    assert.deepEqual(targetSeen, []);
  });

  test('a third-party redirect is not followed: it is recorded and fails the request', { skip }, async () => {
    targetSeen.length = 0;
    const { store } = await newStore();
    const calls = [];
    const transport = direct({ transport: async ({ url }) => {
      calls.push(url.href);
      return { status: 302, headers: { location: `http://cdn.example.test:${targetPort}/other.css` }, body: Buffer.alloc(0) };
    } });
    const [record] = await renderWith({ context: contextFor(ownerScope, [owner('/styled')]), transport, store });
    const sheet = byPath(record).get('/s.css');
    assert.deepEqual([sheet.action, sheet.blocked_reason, sheet.status], ['blocked', 'third_party_redirect', null]);
    assert.deepEqual(calls, [`http://cdn.example.test:${targetPort}/s.css`], 'one intercepted request is one fetch');
    assert.deepEqual(targetSeen, []);
    const entry = (await store.index()).render_ledger.find(item => item.url.endsWith('/s.css'));
    assert.deepEqual([entry.outcome, entry.skipped_reason, entry.requests], ['skipped', 'third_party_redirect', 0]);
  });

  const fontFile = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf']
    .find(candidate => existsSync(candidate));
  test('a cross-origin font loads through the vetted fetch only with the CORS headers the host sent', { skip: skip || (fontFile ? false : 'no system font file found') }, async () => {
    const font = await readFile(fontFile);
    const { store } = await newStore();
    const transport = direct({ transport: async ({ url }) => ({ status: 200, body: font, headers: { 'content-type': 'font/ttf',
      ...(url.pathname === '/with.ttf' ? { 'access-control-allow-origin': '*', 'set-cookie': 'tracker=1' } : {}) } }) });
    const [record] = await renderWith({ context: contextFor(ownerScope, [owner('/fonts')]), transport, store });
    assert.equal(record.title, 'fonts:1,error', 'the font with CORS headers loaded, the one without them was refused by Chrome');
    const served = byPath(record).get('/with.ttf');
    assert.deepEqual([served.action, served.status, served.error], ['third_party_static', 200, null]);
    const entry = (await store.index()).render_ledger.find(item => item.url.endsWith('/with.ttf'));
    assert.deepEqual([entry.outcome, entry.requests, entry.error], ['response', 1, null]);
  });

  test('a third-party fetch that fails is recorded and fails the request', { skip }, async () => {
    const { store } = await newStore();
    const transport = direct({ transport: async () => { throw new Error('connection refused'); } });
    const [record] = await renderWith({ context: contextFor(ownerScope, [owner('/styled')]), transport, store });
    assert.deepEqual([byPath(record).get('/s.css').action, byPath(record).get('/s.css').blocked_reason], ['blocked', 'third_party_failed']);
    assert.notEqual(record.title, 'rgb(1, 2, 3)', 'the stylesheet did not load');
    assert.notEqual(record.dom_ref, null);
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
    assert.equal(launched.options.hostRules, 'MAP xn--bcher-kva.test 127.0.0.1,MAP * ^NOTFOUND');
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
    const [pinned, refused] = await renderWith({ context, transport: direct({ resolve }), store, launch });
    assert.deepEqual(resolved, ['pinned.test', 'private.test'], 'each allowed host is resolved and vetted once');
    const rules = 'MAP pinned.test 127.0.0.1,MAP private.test ^NOTFOUND,MAP * ^NOTFOUND';
    assert.equal(launched.options.hostRules, rules);
    assert.ok(launched.commandLines.some(line => line.includes(`--host-resolver-rules=${rules}`)), 'Chrome was started with the rules');
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

  test('render ledger entries replay with checkRenderLedger from the stored evidence', { skip }, async () => {
    const { store } = await newStore();
    const page = owner('/outcomes');
    await renderWith({ context: contextFor(ownerScope, [page], { max_render_requests: 100 }), store });

    // Everything below is read back from the store, as report replay will do.
    const index = await store.index();
    const [stored] = index.renders;
    const record = JSON.parse((await store.read(stored.evidence_ref, stored.sha256)).toString('utf8'));
    const entries = index.render_ledger;
    assert.ok(entries.some(entry => entry.outcome === 'response') && entries.some(entry => entry.outcome === 'skipped') && entries.some(entry => entry.outcome === 'error'));
    assert.deepEqual(entries.filter(entry => entry.url.endsWith('/beacon')).map(entry => entry.outcome).sort(), ['response', 'skipped']);
    checkRenderLedger(entries, record, 100);

    const failsWith = (changed, pattern, limit = 100, changedRecord = record) => assert.throws(() => checkRenderLedger(changed, changedRecord, limit), pattern);
    const [first] = entries;
    failsWith(entries.map(entry => entry === first ? { ...entry, requests: entry.requests + 1 } : entry), /differ from the request records/);
    failsWith(entries.filter(entry => entry !== first), /differ from the request records/);
    failsWith(entries.map(entry => entry.outcome === 'error' ? { ...entry, outcome: 'response', error: null } : entry), /differ from the request records/);
    failsWith([...entries, first], /differ from the request records/);
    failsWith(entries, /more requests than the render limit/, 3);
    const padded = structuredClone(record);
    padded.requests.push({ ...padded.requests[0] });
    failsWith(entries, /differ from the request records/, 100, padded);
    const duplicate = structuredClone(entries);
    duplicate[1] = { ...duplicate[0] };
    failsWith(duplicate, /differ|repeats/);
  });
});

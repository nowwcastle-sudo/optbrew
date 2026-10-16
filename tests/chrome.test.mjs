import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCdpClient, pipeTransport } from '../skills/optbrew/scripts/core/cdp.mjs';
import { chromeHandle, findChrome, launchChrome, scopedPage } from '../skills/optbrew/scripts/core/chrome.mjs';
import { killTreeByPid, processesWith } from './support/processes.mjs';

const found = findChrome();
const skip = found ? false : 'no Chrome found on this machine (set OPTBREW_CHROME)';

// Everything this run starts lives under `root`; the guard at the end finds any process whose command line names it.
const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-t5-'));
const runDir = path.join(root, 'run');
const hangulDir = path.join(root, '프로필 (한글) 폴더');
await mkdir(runDir);
await mkdir(hangulDir);

const servers = [];
const listen = server => new Promise(resolve => { servers.push(server); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });


/** Launch, run `body`, and always close, so no test can leave a Chrome behind. */
async function withChrome(options, body) {
  const chrome = await launchChrome({ path: found.path, tmpRoot: runDir, ...options });
  try { return await body(chrome); } finally { await chrome.close(); }
}

const profiles = dir => readdir(dir).then(names => names.filter(name => name.startsWith('optbrew-chrome-')));

// One suite, so the cleanup hook runs after the last test and never beside a running one.
describe('chrome block', async () => {
  after(async () => {
    const leftovers = await processesWith(root);
    for (const entry of leftovers) await killTreeByPid(entry.pid);
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    assert.deepEqual(leftovers.map(entry => `${entry.pid} ${entry.commandLine.slice(0, 160)}`), [], 'no process from this test run is left');
    assert.ok(servers.every(server => !server.listening), 'every test server is closed');
  });

  test('prefers OPTBREW_CHROME', () => {
    const exists = () => true;
    assert.deepEqual(findChrome({ env: { OPTBREW_CHROME: '/x/my-chrome' }, platform: 'linux', exists }), { path: '/x/my-chrome', kind: 'chrome' });
    assert.deepEqual(findChrome({ env: { OPTBREW_CHROME: '/x/msedge' }, platform: 'linux', exists }), { path: '/x/msedge', kind: 'edge' });
  });

  test('falls back to edge on win32', () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LocalAppData: 'C:\\Users\\u\\AppData\\Local' };
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    assert.deepEqual(findChrome({ env, platform: 'win32', exists: file => file === edge }), { path: edge, kind: 'edge' });
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    assert.deepEqual(findChrome({ env, platform: 'win32', exists: file => file === chrome || file === edge }), { path: chrome, kind: 'chrome' });
  });

  test('returns null when nothing is found', () => {
    for (const platform of ['win32', 'darwin', 'linux']) assert.equal(findChrome({ env: {}, platform, exists: () => false }), null);
    // An unset variable makes a standard path unusable instead of probing a path with an empty prefix.
    const probed = [];
    findChrome({ env: {}, platform: 'win32', exists: file => { probed.push(file); return false; } });
    assert.deepEqual(probed, []);
  });

  test('searches PATH with the PATHEXT executable extensions on win32', () => {
    const env = { Path: 'C:\\bin;"D:\\tools"', PATHEXT: '.COM;.EXE;.BAT' };
    const probed = [];
    const result = findChrome({ env, platform: 'win32', exists: file => { probed.push(file); return file === 'D:\\tools\\chrome.exe'; } });
    assert.deepEqual(result, { path: 'D:\\tools\\chrome.exe', kind: 'chrome' });
    assert.ok(!probed.some(file => file.endsWith('.bat')));
  });

  test('finds the newest Playwright Chromium under PLAYWRIGHT_BROWSERS_PATH', () => {
    const list = () => ['chromium-1100', 'chromium-1200', 'chromium_headless_shell-1300', 'firefox-1400'];
    const wanted = '/pw/chromium-1200/chrome-linux64/chrome';
    assert.deepEqual(findChrome({ env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' }, platform: 'linux', list, exists: file => file === wanted }), { path: wanted, kind: 'chromium' });
    assert.equal(findChrome({ env: { PLAYWRIGHT_BROWSERS_PATH: '0' }, platform: 'linux', list, exists: () => false }), null);
  });

  test('the pipe transport frames NUL-terminated messages across chunks', async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const client = createCdpClient(pipeTransport(toChrome, fromChrome), { timeoutMs: 1000 });
    const written = [];
    toChrome.on('data', chunk => written.push(chunk.toString()));
    const events = [];
    const off = client.on('Demo.event', (params, sessionId) => events.push([params, sessionId]));
    const reply = client.send('Demo.method', { a: 1 }, 'S1');
    await sleep(10);
    assert.deepEqual(JSON.parse(written.join('').replace(/\0$/, '')), { id: 1, method: 'Demo.method', params: { a: 1 }, sessionId: 'S1' });
    const message = `${JSON.stringify({ method: 'Demo.event', params: { b: 2 }, sessionId: 'S1' })}\0${JSON.stringify({ id: 1, result: { ok: true } })}\0`;
    const bytes = Buffer.from(message);
    fromChrome.write(bytes.subarray(0, 7));
    fromChrome.write(bytes.subarray(7));
    assert.deepEqual(await reply, { ok: true });
    assert.deepEqual(events, [[{ b: 2 }, 'S1']]);
    off();
    fromChrome.write(`${JSON.stringify({ method: 'Demo.event', params: {} })}\0`);
    await sleep(10);
    assert.equal(events.length, 1);
  });

  test('a command fails when it times out or the connection closes', async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const client = createCdpClient(pipeTransport(toChrome, fromChrome), { timeoutMs: 50 });
    await assert.rejects(client.send('Demo.slow', { secret: 'never-in-errors' }), error => /Demo\.slow: devtools command timed out/.test(error.message) && !error.message.includes('never-in-errors'));
    const pending = client.send('Demo.pending');
    fromChrome.destroy();
    await assert.rejects(pending, /devtools connection closed/);
    await assert.rejects(client.send('Demo.after'), /devtools connection closed/);
  });

  test('handle launches at most once and closes on error', async () => {
    const launched = [];
    let closes = 0;
    const handle = chromeHandle({ find: () => ({ path: '/fake/chrome', kind: 'chrome' }), launch: async found => { launched.push(found); return { close: async () => { closes += 1; } }; } });
    const [first, second] = await Promise.all([handle.get(), handle.get()]);
    assert.equal(first, second);
    assert.equal(await handle.get(), first);
    assert.deepEqual(launched, [{ path: '/fake/chrome', kind: 'chrome' }]);
    await assert.rejects((async () => { try { throw new Error('stage failed'); } finally { await handle.close(); } })(), /stage failed/);
    await handle.close();
    assert.equal(closes, 1);
    await assert.rejects(handle.get(), /closed/);
    assert.equal(launched.length, 1);
  });

  test('handle without Chrome returns null, never launches, and tolerates a failed launch', async () => {
    let launches = 0;
    const none = chromeHandle({ find: () => null, launch: async () => { launches += 1; return { close: async () => {} }; } });
    assert.equal(await none.get(), null);
    await none.close();
    const unused = chromeHandle({ find: () => ({ path: 'x', kind: 'chrome' }), launch: async () => { launches += 1; return { close: async () => {} }; } });
    await unused.close();
    assert.equal(launches, 0);
    const broken = chromeHandle({ find: () => ({ path: 'x', kind: 'chrome' }), launch: async () => { launches += 1; throw new Error('launch failed'); } });
    await assert.rejects(broken.get(), /launch failed/);
    await assert.rejects(broken.get(), /launch failed/);
    assert.equal(launches, 1);
    await broken.close();
  });

  test('a failed launch removes its profile directory and leaves no process', { skip }, async () => {
    const missing = path.join(root, 'does-not-exist', 'chrome');
    await assert.rejects(launchChrome({ path: missing, tmpRoot: runDir }), /chrome could not be started/);
    assert.deepEqual(await profiles(runDir), []);
  });

  test('launches chrome from a path with spaces and Hangul', { skip }, async () => {
    // Chrome runs through a junction (a symlink off Windows) whose path holds spaces, parentheses and Hangul; the profile does too.
    const linked = path.join(hangulDir, '크롬 설치 (한글)');
    const sourceDir = path.dirname(found.path);
    let executable = found.path;
    if (process.platform !== 'darwin') {
      await symlink(sourceDir, linked, 'junction');
      executable = path.join(linked, path.basename(found.path));
    }
    const chrome = await launchChrome({ path: executable, tmpRoot: hangulDir });
    try {
      const { product } = await chrome.cdp.send('Browser.getVersion');
      assert.match(product, /Chrome|Edg/);
      const running = await processesWith(hangulDir);
      assert.ok(running.some(entry => entry.commandLine.includes('--user-data-dir=') && entry.commandLine.includes('프로필 (한글) 폴더')));
    } finally { await chrome.close(); }
    assert.deepEqual(await profiles(hangulDir), []);
    assert.deepEqual(await processesWith(hangulDir), []);
  });

  test('never reuses or closes a user\'s running chrome', { skip }, async () => {
    // A separate Chrome with its own profile stands in for the user's; it must survive a full launch and close.
    const userProfile = path.join(root, 'user-profile');
    const user = spawn(found.path, ['--headless=new', `--user-data-dir=${userProfile}`, '--remote-debugging-port=0', '--no-first-run'], { stdio: 'ignore', windowsHide: true });
    try {
      for (let waited = 0; waited < 200; waited++) {
        if (await stat(path.join(userProfile, 'DevToolsActivePort')).then(() => true, () => false)) break;
        await sleep(100);
      }
      assert.ok(await stat(path.join(userProfile, 'DevToolsActivePort')), 'the stand-in user chrome is up');
      await withChrome({}, async chrome => {
        const ours = (await processesWith(runDir)).map(entry => entry.commandLine);
        assert.ok(ours.length > 0 && ours.every(line => !line.includes(userProfile)), 'our chrome uses its own profile');
        await chrome.cdp.send('Browser.getVersion');
      });
      assert.equal(user.exitCode, null, 'the user\'s chrome is still running');
      assert.ok((await processesWith(userProfile)).length > 0);
      assert.deepEqual(await processesWith(runDir), []);
    } finally {
      await killTreeByPid(user.pid);
      await new Promise(resolve => (user.exitCode !== null ? resolve() : user.once('exit', resolve)));
    }
  });

  test('close leaves no chrome process from this run', { skip }, async () => {
    const chrome = await launchChrome({ path: found.path, tmpRoot: runDir });
    const page = await scopedPage({ chrome, context: { scope: { allowed: [{ origin: 'http://127.0.0.1:1' }] } }, budget: 5 });
    assert.ok((await processesWith(runDir)).length > 1, 'chrome and its helpers are running');
    await page.close();
    await chrome.close();
    await chrome.close();
    assert.deepEqual(await processesWith(runDir), []);
    assert.deepEqual(await profiles(runDir), []);
  });

  test('the port variant works when the pipe is not used', { skip }, async () => {
    await withChrome({ transports: ['port'] }, async chrome => {
      assert.match((await chrome.cdp.send('Browser.getVersion')).product, /Chrome|Edg/);
    });
    assert.deepEqual(await processesWith(runDir), []);
    assert.deepEqual(await profiles(runDir), []);
  });

  const targetSeen = [];
  const targetPort = await listen(createServer((req, res) => {
    targetSeen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.png') ? 'image/png' : 'text/html' });
    res.end(req.url.endsWith('.png') ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==', 'base64') : '<html><title>third party</title></html>');
  }));

  const ownerSeen = [];
  const ownerPort = await listen(createServer((req, res) => {
    ownerSeen.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null });
    if (req.url === '/redir-out') { res.writeHead(302, { location: `http://cdn.example.test:${targetPort}/landing` }); res.end(); }
    else if (req.url === '/redir-in') { res.writeHead(302, { location: '/page' }); res.end(); }
    else if (req.url === '/secret') { res.writeHead(401, { 'www-authenticate': 'Basic realm="owner"', 'content-type': 'text/html' }); res.end('<title>denied</title>'); }
    else if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Scoped</title>
  <link rel="stylesheet" href="http://cdn.example.test:${targetPort}/s.css">
  <img src="http://cdn.example.test:${targetPort}/i.png">
  <img src="http://127.0.0.1:${targetPort}/private.png">
  <iframe src="http://cdn.example.test:${targetPort}/frame.html"></iframe>
  <a href="/next">next</a>
  <script>
  fetch('http://cdn.example.test:${targetPort}/data.json').catch(() => console.error('cross-origin fetch failed'));
  fetch('/beacon', { method: 'POST' }).catch(() => {});
  </script>`);
    } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>plain</title>'); }
  }));

  const ownerScope = { allowed: [{ origin: `http://127.0.0.1:${ownerPort}` }], local_targets: [{ host: '127.0.0.1', port: ownerPort }] };
  const owner = suffix => `http://127.0.0.1:${ownerPort}${suffix}`;
  const hostRules = `MAP *.example.test 127.0.0.1`;

  test('scopedPage blocks an out-of-scope navigation and records third-party static', { skip }, async () => {
    targetSeen.length = 0;
    ownerSeen.length = 0;
    await withChrome({ hostRules }, async chrome => {
      const page = await scopedPage({ chrome, context: { scope: ownerScope }, budget: 100 });
      try {
        const result = await page.goto(owner('/page'));
        assert.equal(result.status, 200);
        assert.equal(result.title, 'Scoped');
        assert.match(result.dom, /<iframe/);
        assert.ok(result.links.includes(owner('/next')));
        assert.equal(result.blocked_reason, null);
        const actions = Object.fromEntries(page.requests.map(request => [new URL(request.url).pathname, `${request.action}:${request.resource_type}`]));
        assert.equal(actions['/page'], 'allowed:Document');
        assert.equal(actions['/s.css'], 'third_party_static:Stylesheet');
        assert.equal(actions['/i.png'], 'third_party_static:Image');
        assert.equal(actions['/private.png'], 'blocked:Image');
        assert.equal(actions['/frame.html'], 'blocked:Document');
        assert.match(actions['/data.json'], /^blocked:(XHR|Fetch)$/);
        assert.match(actions['/beacon'], /^blocked:(XHR|Fetch)$/);
        assert.ok(page.requests.filter(request => request.action === 'blocked').every(request => request.blocked_reason));
        assert.ok(result.console_errors.some(text => text.includes('cross-origin fetch failed')));
        assert.deepEqual(targetSeen.sort(), ['GET /i.png', 'GET /s.css']);
        assert.ok(!ownerSeen.some(seen => seen.url === '/beacon'));

        const outside = await page.goto(`http://cdn.example.test:${targetPort}/frame.html`);
        assert.equal(outside.blocked_reason, 'out_of_scope');
        assert.equal(outside.dom, null);
        assert.ok(!targetSeen.includes('GET /frame.html'));
      } finally { await page.close(); }
    });
  });

  test('scopedPage checks every redirect hop again', { skip }, async () => {
    targetSeen.length = 0;
    await withChrome({ hostRules }, async chrome => {
      const page = await scopedPage({ chrome, context: { scope: ownerScope }, budget: 100 });
      try {
        const inside = await page.goto(owner('/redir-in'));
        assert.equal(inside.status, 200);
        assert.equal(inside.title, 'Scoped');
        const outside = await page.goto(owner('/redir-out'));
        assert.equal(outside.blocked_reason, 'out_of_scope');
        assert.ok(page.requests.some(request => request.redirected && new URL(request.url).pathname === '/landing' && request.action === 'blocked'));
        assert.ok(!targetSeen.includes('GET /landing'));
      } finally { await page.close(); }
    });
  });

  test('scopedPage fails every request past its budget with render_budget', { skip }, async () => {
    await withChrome({ hostRules }, async chrome => {
      const page = await scopedPage({ chrome, context: { scope: ownerScope }, budget: 2 });
      try {
        const result = await page.goto(owner('/page'));
        assert.equal(result.blocked_reason, 'render_budget');
        assert.equal(page.requests.length, 3);
        // Which sub-request comes second depends on Chrome's scheduling; only the overflow is deterministic.
        assert.equal(page.requests[0].resource_type, 'Document');
        assert.equal(page.requests[2].blocked_reason, 'render_budget');
        assert.ok(page.requests.slice(0, 2).every(request => request.blocked_reason !== 'render_budget'));
      } finally { await page.close(); }
    });
  });

  test('a proxy challenge gets the proxy credentials from memory, a server challenge never does', { skip }, async () => {
    const user = 'proxy-user';
    const password = 'proxy-pass-7f3a91';
    const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    const proxySeen = [];
    const proxyPort = await listen(createServer((req, res) => {
      proxySeen.push({ url: req.url, authorization: req.headers['proxy-authorization'] ?? null });
      if (req.headers['proxy-authorization'] !== authorization) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="proxy"' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>through the proxy</title>');
    }));
    ownerSeen.length = 0;
    const scope = { allowed: [{ origin: 'http://via-proxy.test' }, ...ownerScope.allowed], local_targets: ownerScope.local_targets };
    await withChrome({ proxy: { host: '127.0.0.1', port: proxyPort, authorization } }, async chrome => {
      const page = await scopedPage({ chrome, context: { scope }, budget: 100 });
      try {
        const viaProxy = await page.goto('http://via-proxy.test/');
        assert.equal(viaProxy.status, 200);
        assert.equal(viaProxy.title, 'through the proxy');
        assert.equal(proxySeen[0].authorization, null, 'the first request had no credentials');
        assert.ok(proxySeen.some(seen => seen.authorization === authorization), 'the retry carried the credentials');
        assert.ok(proxySeen.every(seen => seen.authorization === null || seen.authorization === authorization));
        const denied = await page.goto(owner('/secret'));
        assert.equal(denied.status, 401);
        assert.ok(ownerSeen.some(seen => seen.url === '/secret'));
        assert.ok(ownerSeen.every(seen => seen.authorization === null), 'the origin server never saw credentials');
      } finally { await page.close(); }
      const lines = (await processesWith(runDir)).map(entry => entry.commandLine);
      assert.ok(lines.some(line => line.includes(`--proxy-server=127.0.0.1:${proxyPort}`)));
      assert.ok(lines.every(line => !line.includes(password) && !line.includes(Buffer.from(`${user}:${password}`).toString('base64'))), 'credentials are not on any command line');
    });
  });
});

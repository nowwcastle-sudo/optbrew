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
import { killTreeByPid, processesWith, remaining } from './support/processes.mjs';

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
    const leftovers = await remaining(root);
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

  test('an OPTBREW_CHROME that does not exist is reported, not replaced by another browser', () => {
    const exists = file => file !== '/gone/chrome';
    assert.deepEqual(findChrome({ env: { OPTBREW_CHROME: '/gone/chrome' }, platform: 'linux', exists }),
      { path: null, kind: null, reason: 'optbrew_chrome_missing' });
    const standard = findChrome({ env: {}, platform: 'linux', exists });
    assert.equal(standard.reason, undefined);
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
    const missing = chromeHandle({ find: () => ({ path: null, kind: null, reason: 'optbrew_chrome_missing' }), launch: async () => { launches += 1; return { close: async () => {} }; } });
    assert.equal(await missing.get(), null);
    await missing.close();
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

  test('a launch that times out cleans up and leaves nothing open', { skip }, async () => {
    for (const transports of [['pipe'], ['port']]) {
      await assert.rejects(launchChrome({ path: found.path, tmpRoot: runDir, transports, launchTimeoutMs: 1 }), /chrome launch timed out|did not publish|cancelled/);
      assert.deepEqual(await profiles(runDir), []);
      assert.deepEqual(await remaining(runDir), []);
    }
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
    assert.deepEqual(await remaining(hangulDir), []);
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
      assert.deepEqual(await remaining(runDir), []);
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
    assert.deepEqual(await remaining(runDir), []);
    assert.deepEqual(await profiles(runDir), []);
  });

  test('the port variant works when the pipe is not used', { skip }, async () => {
    await withChrome({ transports: ['port'] }, async chrome => {
      assert.match((await chrome.cdp.send('Browser.getVersion')).product, /Chrome|Edg/);
    });
    assert.deepEqual(await remaining(runDir), []);
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
    } else if (req.url === '/workers') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Workers</title><script>
  navigator.serviceWorker.register('/sw.js');
  new SharedWorker('/shared.js');
  new Worker('/dedicated.js');
  </script>`);
    } else if (req.url === '/statics') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>statics</title>${[1, 2, 3, 4].map(n => `<img src="http://cdn.example.test:${targetPort}/s${n}.png">`).join('')}`);
    } else if (/^\/(sw|shared|dedicated)\.js$/.test(req.url)) {
      const name = req.url.slice(1, -3);
      const start = name === 'sw' ? "self.addEventListener('activate', () => { run(); });" : 'run();';
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`function run() {
    fetch('/${name}-ran');
    fetch('http://cdn.example.test:${targetPort}/${name}-post', { method: 'POST', mode: 'no-cors' }).catch(() => {});
    fetch('http://cdn.example.test:${targetPort}/${name}-get', { mode: 'no-cors' }).catch(() => {});
  }
  ${start}`);
    } else if (req.url === '/script-redirect') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>first</title><script>location.replace("/redirect-target");</script>'); }
    else if (req.url === '/meta-refresh') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>first</title><meta http-equiv="refresh" content="0; url=/redirect-target">'); }
    else if (req.url === '/script-out') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>first</title><script>location.replace("http://cdn.example.test:${targetPort}/script-landing");</script>`); }
    else if (req.url === '/redirect-target') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>redirected</title>'); }
    else if (req.url === '/nested-page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end("<title>nested</title><script>new Worker('/outer.js');</script>"); }
    else if (req.url === '/outer.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end("new Worker('/inner.js');"); }
    else if (req.url === '/inner.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`fetch('/nested-ran'); fetch('http://cdn.example.test:${targetPort}/nested-post', { method: 'POST', mode: 'no-cors' }).catch(() => {});`);
    } else if (req.url === '/opener') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>opener</title>'); }
    else if (req.url === '/popup-inside') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>popup</title><script>fetch('http://cdn.example.test:${targetPort}/popup-post', { method: 'POST', mode: 'no-cors' }).catch(() => {});</script>`);
    } else if (req.url === '/oopif') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>oopif</title><iframe src="http://in2.example.test:${ownerPort}/inner"></iframe>`);
    } else if (req.url === '/inner') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>inner</title><script>fetch('http://cdn.example.test:${targetPort}/inner-post', { method: 'POST', mode: 'no-cors' }).catch(() => {});</script>`);
    } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>plain</title>'); }
  }));

  const ownerScope = { allowed: [{ origin: `http://127.0.0.1:${ownerPort}` }], local_targets: [{ host: '127.0.0.1', port: ownerPort }] };
  const owner = suffix => `http://127.0.0.1:${ownerPort}${suffix}`;
  const hostRules = `MAP *.example.test 127.0.0.1`;

  async function until(condition, what) {
    for (let waited = 0; waited < 100; waited++) {
      if (condition()) return;
      await sleep(100);
    }
    assert.fail(`timed out waiting for ${what}`);
  }
  const blockedPaths = page => page.requests.filter(request => request.action === 'blocked').map(request => new URL(request.url).pathname);

  /** Run `code` in the page behind `url` with a user gesture (so Chrome allows a popup), over a second session of ours. */
  async function evaluateWithGesture(chrome, url, code) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const target = targetInfos.find(info => info.type === 'page' && info.url === url);
    assert.ok(target, `a page target for ${url}`);
    const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await chrome.cdp.send('Runtime.evaluate', { expression: code, userGesture: true }, sessionId);
    await chrome.cdp.send('Target.detachFromTarget', { sessionId });
  }

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

  test('a service worker cannot reach an out-of-scope host', { skip }, async () => {
    targetSeen.length = 0;
    await withChrome({ hostRules }, async chrome => {
      const page = await scopedPage({ chrome, context: { scope: ownerScope }, budget: 100 });
      try {
        assert.equal((await page.goto(owner('/workers'))).title, 'Workers');
        await until(() => page.requests.some(request => request.target_type === 'service_worker' && request.url === owner('/sw-ran')), 'the service worker to run');
        await until(() => blockedPaths(page).includes('/sw-post'), 'the service worker POST to be recorded');
        const post = page.requests.find(request => request.url.endsWith('/sw-post'));
        assert.deepEqual([post.target_type, post.action, post.blocked_reason], ['service_worker', 'blocked', 'non_get_request']);
        assert.ok(!targetSeen.includes('POST /sw-post'), 'the out-of-scope host never received the service worker request');
      } finally { await page.close(); }
    });
  });

  test('shared and dedicated workers follow the same rule', { skip }, async () => {
    targetSeen.length = 0;
    await withChrome({ hostRules }, async chrome => {
      const page = await scopedPage({ chrome, context: { scope: ownerScope }, budget: 100 });
      try {
        await page.goto(owner('/workers'));
        for (const name of ['shared', 'dedicated']) {
          await until(() => blockedPaths(page).includes(`/${name}-post`), `the ${name} worker POST to be recorded`);
          // A fetch() GET is not a static resource, so it is blocked too.
          await until(() => blockedPaths(page).includes(`/${name}-get`), `the ${name} worker GET to be recorded`);
        }
        const typeOf = name => page.requests.find(request => request.url.endsWith(`/${name}-post`)).target_type;
        // A dedicated worker's requests are paused on its owner's session, so they are listed under the page.
        assert.deepEqual([typeOf('shared'), typeOf('dedicated')], ['shared_worker', 'page']);
        assert.ok(!targetSeen.some(seen => /-(post|get)$/.test(seen)), 'the out-of-scope host received nothing from the workers');
      } finally { await page.close(); }
    });
  });

  test('a worker nested under a dedicated worker runs and follows the same rule', { skip }, async () => {
    targetSeen.length = 0;
    ownerSeen.length = 0;
    await withChrome({ hostRules }, async chrome => {
      const page = await scopedPage({ chrome, context: { scope: ownerScope }, budget: 100 });
      try {
        await page.goto(owner('/nested-page'));
        await until(() => ownerSeen.some(seen => seen.url === '/nested-ran'), 'the nested worker to run (it must not stay paused)');
        await until(() => blockedPaths(page).includes('/nested-post'), 'the nested worker POST to be recorded');
        assert.ok(!targetSeen.includes('POST /nested-post'), 'the out-of-scope host received nothing from the nested worker');
      } finally { await page.close(); }
    });
  });

  test('goto follows a script redirect within scope', { skip }, async () => {
    await withChrome({ hostRules }, async chrome => {
      const page = await scopedPage({ chrome, context: { scope: ownerScope }, budget: 100 });
      try {
        const result = await page.goto(owner('/script-redirect'));
        assert.deepEqual([result.error, result.blocked_reason, result.title, result.final_url, result.status], [null, null, 'redirected', owner('/redirect-target'), 200]);
      } finally { await page.close(); }
    });
  });

  test('goto follows a meta refresh within scope', { skip }, async () => {
    await withChrome({ hostRules }, async chrome => {
      const page = await scopedPage({ chrome, context: { scope: ownerScope }, budget: 100 });
      try {
        const result = await page.goto(owner('/meta-refresh'));
        assert.deepEqual([result.error, result.blocked_reason, result.title, result.final_url, result.status], [null, null, 'redirected', owner('/redirect-target'), 200]);
      } finally { await page.close(); }
    });
  });

  test('goto ends when a script redirect goes out of scope', { skip }, async () => {
    targetSeen.length = 0;
    await withChrome({ hostRules }, async chrome => {
      const page = await scopedPage({ chrome, context: { scope: ownerScope }, budget: 100 });
      try {
        const started = Date.now();
        const result = await page.goto(owner('/script-out'));
        assert.deepEqual([result.error, result.blocked_reason, result.dom], [null, 'out_of_scope', null]);
        assert.ok(Date.now() - started < 10000, 'it ended on the block, not on the navigation timeout');
        assert.ok(!targetSeen.includes('GET /script-landing'));
        assert.ok(blockedPaths(page).includes('/script-landing'));
      } finally { await page.close(); }
    });
  });

  test('a popup or iframe target follows the same rule', { skip }, async () => {
    targetSeen.length = 0;
    const scope = { allowed: [...ownerScope.allowed, { origin: `http://in2.example.test:${ownerPort}` }], local_targets: ownerScope.local_targets };
    await withChrome({ hostRules }, async chrome => {
      const page = await scopedPage({ chrome, context: { scope }, budget: 100 });
      try {
        // An allowed iframe on another site runs in its own process; its own requests must still be checked.
        await page.goto(owner('/oopif'));
        await until(() => blockedPaths(page).includes('/inner-post'), 'the cross-site iframe POST to be recorded');
        assert.equal(page.requests.find(request => request.url.endsWith('/inner-post')).target_type, 'iframe');

        // A popup opened with a user gesture gets the same interception, for its document and for what it requests.
        await page.goto(owner('/opener'));
        // One gesture opens one popup, so each popup gets its own.
        await evaluateWithGesture(chrome, owner('/opener'), `window.open(${JSON.stringify(owner('/popup-inside'))}, '_blank'); 1`);
        await evaluateWithGesture(chrome, owner('/opener'), `window.open('http://cdn.example.test:${targetPort}/popup-out', '_blank'); 1`);
        await until(() => blockedPaths(page).includes('/popup-post') && blockedPaths(page).includes('/popup-out'), 'the popup requests to be recorded');
        assert.equal(page.requests.find(request => request.url.endsWith('/popup-post')).target_type, 'page');
        assert.ok(page.requests.some(request => request.url === owner('/popup-inside') && request.action === 'allowed'));
        assert.ok(!targetSeen.some(seen => /(popup|inner)-/.test(seen) || seen === 'GET /popup-out'), 'the out-of-scope host received nothing from the popup or the iframe');
      } finally { await page.close(); }
    });
  });

  test('third-party fetches run at most staticConcurrency at a time and the rest wait', { skip }, async () => {
    const run = async staticConcurrency => {
      let active = 0;
      let most = 0;
      const fetchStatic = async () => {
        active += 1;
        most = Math.max(most, active);
        await sleep(150);
        active -= 1;
        return { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('iVBORw0KGgo=', 'base64') };
      };
      return withChrome({}, async chrome => {
        const page = await scopedPage({ chrome, context: { scope: ownerScope }, budget: 100, fetchStatic, staticConcurrency });
        try { await page.goto(owner('/statics')); } finally { await page.close(); }
        return { most, served: page.requests.filter(request => request.action === 'third_party_static').length };
      });
    };
    assert.deepEqual(await run(1), { most: 1, served: 4 }, 'with a cap of 1 two fetches never overlap, and all four are still served');
    assert.ok((await run(4)).most > 1, 'without the cap they overlap, so the test can tell');
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

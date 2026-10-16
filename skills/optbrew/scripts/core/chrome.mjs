import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCdpClient, pipeTransport, webSocketTransport } from './cdp.mjs';
import { chromePaths, limits } from './config.mjs';
import { assertInScope } from './scope.mjs';

/** A timer that never keeps the process alive; it only bounds a race. */
const sleep = (ms, value) => delay(ms, value, { ref: false });

const envValue = (env, name) => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())];

/** Expand `%NAME%` against `env`; a variable that is not set makes the whole template unusable. */
function expand(template, env) {
  let missing = false;
  const text = template.replace(/%([^%]+)%/g, (_, name) => {
    const value = envValue(env, name);
    if (!value) missing = true;
    return value ?? '';
  });
  return missing ? null : text;
}

const guessKind = file => /edge/i.test(path.basename(file)) ? 'edge' : /chromium/i.test(path.basename(file)) ? 'chromium' : 'chrome';

/**
 * Where a Chromium browser lives, in the order OPTBREW_CHROME, the platform's standard install paths, names on PATH
 * (Windows: tried with the PATHEXT executable extensions), then Chromium under PLAYWRIGHT_BROWSERS_PATH.
 * Returns `{ path, kind }`, or `null` when nothing is found. An OPTBREW_CHROME that points at a missing file is the
 * owner's explicit choice, so it is not silently replaced: the result is `{ path: null, kind: null, reason: 'optbrew_chrome_missing' }`.
 */
export function findChrome({ env = process.env, platform = process.platform, exists = existsSync, list = readdirSync } = {}) {
  const config = chromePaths();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const override = envValue(env, 'OPTBREW_CHROME');
  if (override) return exists(override) ? { path: override, kind: guessKind(override) } : { path: null, kind: null, reason: 'optbrew_chrome_missing' };

  for (const entry of config[platform] ?? []) {
    const candidate = expand(entry.path, env);
    if (candidate && exists(candidate)) return { path: candidate, kind: entry.kind };
  }

  const extensions = platform === 'win32' ?
    (envValue(env, 'PATHEXT') ?? '.EXE').split(';').filter(extension => /^\.(exe|com)$/i.test(extension)).map(extension => extension.toLowerCase()) : [''];
  const directories = (envValue(env, 'PATH') ?? '').split(platform === 'win32' ? ';' : ':').map(directory => directory.replace(/^"|"$/g, '')).filter(Boolean);
  for (const { name, kind } of config.path_names) {
    for (const directory of directories) {
      for (const extension of extensions) {
        const candidate = p.join(directory, name + extension);
        if (exists(candidate)) return { path: candidate, kind };
      }
    }
  }

  const playwright = envValue(env, 'PLAYWRIGHT_BROWSERS_PATH');
  if (playwright && playwright !== '0') {
    let names = [];
    try { names = list(playwright); } catch { /* an unreadable directory means no browser there */ }
    const revisions = names.map(name => /^chromium-(\d+)$/.exec(name)).filter(Boolean)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const [directory] of revisions) {
      for (const relative of config.playwright_chromium[platform] ?? []) {
        const candidate = p.join(playwright, directory, relative);
        if (exists(candidate)) return { path: candidate, kind: 'chromium' };
      }
    }
  }
  return null;
}

const exited = child => child.exitCode !== null || child.signalCode !== null;

/** Kill a process tree by pid: Windows `taskkill /T /F`, elsewhere the process group, else the process alone. */
function killTree(pid) {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    killer.once('error', resolve);
    killer.once('exit', resolve);
  });
}

const LIST_WINDOWS = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:OPTBREW_MARKER) } | ForEach-Object { $_.ProcessId }';

/**
 * Pids whose command line names `marker`. The marker travels in the environment, so the query never finds itself.
 * A query that fails or runs past `timeoutMs` counts as an empty list, so a hung process listing cannot hang `close()`.
 */
function pidsWithCommandLine(marker, timeoutMs) {
  // `-ww` keeps `ps` from cutting long command lines, which would hide the profile path.
  const [command, args] = process.platform === 'win32' ?
    ['powershell', ['-NoProfile', '-NonInteractive', '-Command', LIST_WINDOWS]] : ['ps', ['-ww', '-eo', 'pid=,args=']];
  return new Promise(resolve => {
    execFile(command, args, { env: { ...process.env, OPTBREW_MARKER: marker }, maxBuffer: 1 << 24, windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
      if (error) { resolve([]); return; }
      resolve(stdout.split(/\r?\n/).map(line => /^\s*(\d+)(?:\s+(.*))?$/.exec(line))
        .filter(match => match && (process.platform === 'win32' || match[2]?.includes(marker)))
        .map(match => Number(match[1])).filter(pid => pid !== process.pid));
    });
  });
}

/**
 * Helpers such as the crash handler can outlive the browser for a moment, and no longer belong to its process tree. This run's
 * temporary profile path is unique and sits on their command lines, so it identifies them; nothing else is ever touched.
 */
async function killLeftovers(userDataDir, graceMs) {
  const deadline = Date.now() + graceMs;
  let pids = await pidsWithCommandLine(userDataDir, graceMs);
  while (pids.length) {
    // The first list is always acted on, however long it took; only the re-checks are bounded by the grace period.
    for (const pid of pids) await killTree(pid);
    // Ending a process takes a moment on Windows, so ask again until none is listed.
    if (Date.now() >= deadline) break;
    pids = await pidsWithCommandLine(userDataDir, graceMs);
  }
}

/** Answer authentication challenges from memory: only a proxy challenge gets the proxy credentials, once per request. */
function answerAuthChallenges(cdp, authorization) {
  const decoded = authorization ? Buffer.from(authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8') : null;
  const separator = decoded?.indexOf(':') ?? -1;
  const credentials = decoded === null ? null : { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  const answered = new Set();
  cdp.on('Fetch.authRequired', ({ requestId, authChallenge }, sessionId) => {
    const provide = credentials && authChallenge.source === 'Proxy' && !answered.has(requestId);
    answered.add(requestId);
    const authChallengeResponse = provide ? { response: 'ProvideCredentials', ...credentials } : { response: 'CancelAuth' };
    cdp.send('Fetch.continueWithAuth', { requestId, authChallengeResponse }, sessionId).catch(() => {});
  });
}

async function readActivePort(userDataDir, deadline) {
  while (Date.now() < deadline) {
    try {
      const [port, browserPath] = (await readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8')).split('\n');
      if (port && browserPath) return `ws://127.0.0.1:${port}${browserPath}`;
    } catch { /* not written yet */ }
    await sleep(50);
  }
  throw new Error('chrome did not publish a debugging port');
}

/** One launch attempt with one transport; on any failure it kills its own process tree and removes its profile directory. */
async function attempt({ executable, proxy, hostRules, tmpRoot, transport: kind, launchTimeout }) {
  const { chrome_close_grace_ms: closeGrace, cdp_command_timeout_ms: commandTimeout } = limits();
  const userDataDir = await mkdtemp(path.join(tmpRoot, 'optbrew-chrome-'));
  const args = ['--headless=new', `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions',
    kind === 'pipe' ? '--remote-debugging-pipe' : '--remote-debugging-port=0'];
  // Chrome refuses to start as root without its sandbox disabled (containers, CI).
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  if (proxy) args.push(`--proxy-server=${proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host}:${proxy.port}`);
  if (hostRules) args.push(`--host-resolver-rules=${hostRules}`);

  const child = spawn(executable, args, { stdio: kind === 'pipe' ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore',
    windowsHide: true, detached: process.platform !== 'win32' });
  const gone = new Promise(resolve => child.once('exit', resolve));
  const failed = new Promise((_, reject) => {
    child.once('error', () => reject(new Error('chrome could not be started')));
    gone.then(() => reject(new Error('chrome exited before it was ready')));
  });
  failed.catch(() => {});

  let transport = null;
  let cancelled = false;
  const cleanup = async () => {
    transport?.close();
    if (!exited(child) && child.pid !== undefined) { await killTree(child.pid); await Promise.race([gone, sleep(closeGrace)]); }
    await killLeftovers(userDataDir, closeGrace);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };

  let cdp;
  try {
    const deadline = Date.now() + launchTimeout;
    const connect = async () => {
      const opened = kind === 'pipe' ? pipeTransport(child.stdio[3], child.stdio[4]) : await webSocketTransport(await readActivePort(userDataDir, deadline));
      // A connection that completes after the launch was abandoned must not outlive the cleanup.
      if (cancelled) { opened.close(); throw new Error('chrome launch was cancelled'); }
      transport = opened;
      cdp = createCdpClient(transport, { timeoutMs: commandTimeout });
      await cdp.send('Browser.getVersion');
    };
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('chrome launch timed out')), launchTimeout); });
    try { await Promise.race([connect(), failed, timeout]); } finally { clearTimeout(timer); }
  } catch (error) {
    cancelled = true;
    await cleanup();
    throw error;
  }

  answerAuthChallenges(cdp, proxy?.authorization);
  let closing = null;
  const shutdown = async () => {
    if (!exited(child)) {
      await Promise.race([cdp.send('Browser.close').catch(() => {}), gone, sleep(closeGrace)]);
      await Promise.race([gone, sleep(closeGrace)]);
    }
    await cleanup();
  };
  return { cdp, close: () => closing ??= shutdown() };
}

/**
 * Start a headless Chrome with a fresh temporary profile and a DevTools connection. The pipe variant is tried first; the
 * port variant only when the pipe one cannot be started. `proxy` is `{ host, port, authorization }`, and `authorization`
 * stays in memory (never on the command line, in a log or in an error). `close()` always ends this run's process tree
 * and deletes the profile directory.
 */
export async function launchChrome({ path: executable, proxy = null, hostRules = null, tmpRoot = os.tmpdir(), transports = ['pipe', 'port'],
  launchTimeoutMs = limits().chrome_launch_timeout_ms }) {
  let failure;
  for (const transport of transports) {
    try { return await attempt({ executable, proxy, hostRules, tmpRoot, transport, launchTimeout: launchTimeoutMs }); }
    catch (error) { failure = error; }
  }
  throw failure;
}

/** Launch on the first `get()` only; every stage shares the result. The owner calls `close()` in a `finally`. */
export function chromeHandle({ find, launch }) {
  let pending = null;
  let closed = false;
  let closing = null;
  return {
    get() {
      if (closed) return Promise.reject(new Error('chrome handle is closed'));
      pending ??= (async () => {
        const found = await find();
        return found?.path ? launch(found) : null;
      })();
      return pending;
    },
    close() {
      closed = true;
      closing ??= (async () => {
        const chrome = pending ? await pending.catch(() => null) : null;
        await chrome?.close();
      })();
      return closing;
    },
  };
}

const STATIC_TYPES = new Set(['Script', 'Stylesheet', 'Font', 'Image']);
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:']);

/** Chrome resolves names itself (pinned by host rules or the proxy), so only the URL boundary and IP literals are vetted here. */
function inScope(url, scope) {
  try { assertInScope(url, scope, undefined, { addressVetting: 'proxy' }); return true; }
  catch { return false; }
}

/** What to do with one intercepted request. The only implementation of the render interception rules. */
function decide({ url, method }, resourceType, scope) {
  let parsed;
  try { parsed = new URL(url); } catch { return { action: 'blocked', blocked_reason: 'out_of_scope' }; }
  if (LOCAL_SCHEMES.has(parsed.protocol)) return { action: 'allowed', blocked_reason: null };
  if (method !== 'GET' && method !== 'HEAD') return { action: 'blocked', blocked_reason: 'non_get_request' };
  if (inScope(url, scope)) return { action: 'allowed', blocked_reason: null };
  // Out of scope: only static GET resources on a public host may load; the page cannot read them, and they are listed.
  if (STATIC_TYPES.has(resourceType) && inScope(url, { allowed: [{ origin: parsed.origin }] })) {
    return { action: 'third_party_static', blocked_reason: null };
  }
  return { action: 'blocked', blocked_reason: 'out_of_scope' };
}

const consoleText = args => args.map(arg => arg.value ?? arg.description ?? '').join(' ');

const READ_PAGE = `JSON.stringify({ final_url: location.href, title: document.title, dom: document.documentElement.outerHTML,
  links: Array.from(document.querySelectorAll('a[href]'), anchor => anchor.href) })`;

const INTERCEPT_ALL = { patterns: [{ urlPattern: '*' }], handleAuthRequests: true };
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
// Top-level targets that can run page code or make requests of their own. The last entry drops every other type.
const TOP_LEVEL = [{ type: 'page' }, { type: 'service_worker' }, { type: 'shared_worker' }, { exclude: true }];
// A dedicated worker has no Fetch domain of its own ("'Fetch.enable' wasn't found"): its requests are paused on the session
// of the frame that owns it, which already has the interception.
const OWNER_INTERCEPTS = new Set(['worker']);

/**
 * One browser-level auto-attach per Chrome: each new top-level target (a popup, a service worker, a shared worker) is
 * paused and handed to the scopedPage that owns its browser context; any other target is resumed untouched. A target that
 * shows up in a context whose page has already closed was ours and is closed, never resumed unintercepted.
 * Resolves to `{ claims, retired }`: the `browserContextId -> adopt` map and the set of contexts already closed.
 */
const routers = new WeakMap();
function routerFor(cdp) {
  if (!routers.has(cdp)) {
    routers.set(cdp, (async () => {
      const claims = new Map();
      const retired = new Set();
      cdp.on('Target.attachedToTarget', (params, parent) => {
        if (parent !== undefined) return;
        const context = params.targetInfo.browserContextId;
        if (claims.has(context)) claims.get(context)(params);
        else if (retired.has(context)) cdp.send('Target.closeTarget', { targetId: params.targetInfo.targetId }).catch(() => {});
        else if (params.waitingForDebugger) cdp.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
      });
      await cdp.send('Target.setAutoAttach', { ...AUTO_ATTACH, filter: TOP_LEVEL });
      return { claims, retired };
    })());
  }
  return routers.get(cdp);
}

/**
 * One isolated page whose every request passes the scope rules: in-scope requests continue; an out-of-scope document or
 * any request that is not GET/HEAD fails with BlockedByClient; an out-of-scope GET script, stylesheet, font or image
 * loads and is recorded as `third_party_static`. Redirect hops arrive as new requests and are checked again. Past
 * `budget` intercepted requests every request fails with `render_budget`.
 * With `fetchStatic(url)` (direct mode) Chrome never touches a third-party static host: the bytes come from that function,
 * which vets the address, and are handed to Chrome with Fetch.fulfillRequest; a refusal or failure fails the request and is
 * recorded (`third_party_refused`, `third_party_failed`). Without it (proxy mode) the proxy carries the request.
 * Every record gets the `status` of its response or the `error` text of its failure from the Network events.
 * The rules cover every target the page owns, not only its main frame: iframes and dedicated workers (auto-attached from the
 * page session), popups, service workers and shared workers (auto-attached from the browser). Each is paused, gets the same
 * Fetch interception, and only then runs; the records say which kind of target made the request (`target_type`).
 */
export async function scopedPage({ chrome, context, budget, fetchStatic = null }) {
  const { cdp } = chrome;
  const { claims, retired } = await routerFor(cdp);
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const offs = [];
  const requests = [];
  const consoleErrors = [];
  const sessions = new Map();
  // Records per Network request id in arrival order, so a response, a redirect or a failure lands on the right hop.
  const byNetwork = new Map();
  const targets = new Set();
  const idleLoaders = new Set();
  let targetId = null;
  let sessionId = null;
  let mainFrameId = null;
  let seen = 0;
  let mainBlocked = null;
  let budgetBlocked = false;
  let lastDocument = null;
  let mainLoader = null;
  let notifyMainBlocked = () => {};
  let announceMainTarget;
  const mainTarget = new Promise(resolve => { announceMainTarget = resolve; });

  const send = (method, params) => cdp.send(method, params, sessionId);
  const on = (event, fn) => {
    const off = cdp.on(event, (params, session) => { if (session === sessionId) fn(params); });
    offs.push(off);
    return off;
  };
  const once = (event, test) => {
    let off;
    const promise = new Promise(resolve => { off = on(event, params => { if (test(params)) { off(); resolve(params); } }); });
    return { promise, off };
  };

  const unresolved = networkId => byNetwork.get(networkId)?.find(record => record.status === null && record.error === null);

  async function onPaused(session, { requestId, networkId, request, resourceType, redirectedRequestId, frameId }) {
    seen += 1;
    let verdict = seen > budget ? { action: 'blocked', blocked_reason: 'render_budget' } : decide(request, resourceType, context.scope);
    if (verdict.blocked_reason === 'render_budget') budgetBlocked = true;
    const record = { url: request.url, method: request.method, resource_type: resourceType, target_type: sessions.get(session),
      redirected: Boolean(redirectedRequestId), ...verdict, status: null, error: null };
    // Past the budget only the first overflowing request is listed, so a request flood cannot grow the list.
    if (seen <= budget + 1) requests.push(record);
    if (verdict.action !== 'blocked' && networkId) byNetwork.set(networkId, [...(byNetwork.get(networkId) ?? []), record]);
    let served = null;
    if (verdict.action === 'third_party_static' && fetchStatic) {
      try { served = await fetchStatic(request.url); }
      catch (error) {
        verdict = { action: 'blocked', blocked_reason: error.code === 'scope_rejected' ? 'third_party_refused' : 'third_party_failed' };
        Object.assign(record, verdict);
      }
    }
    if (served) {
      record.status = served.status;
      const responseHeaders = Object.entries(served.headers).filter(([name]) => name === 'content-type').map(([name, value]) => ({ name, value }));
      await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: served.status, responseHeaders, body: served.body.toString('base64') }, session);
    } else if (verdict.action === 'blocked') {
      if (session === sessionId && resourceType === 'Document' && frameId === mainFrameId) {
        mainBlocked ??= verdict.blocked_reason;
        notifyMainBlocked();
      }
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, session);
    } else await cdp.send('Fetch.continueRequest', { requestId }, session);
  }

  /** Put a newly attached target under the same interception before it runs. The main page is driven over its own session. */
  async function adopt({ sessionId: child, targetInfo, waitingForDebugger }) {
    const resume = () => waitingForDebugger ? cdp.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {}) : undefined;
    // Our own page can be announced before createTarget has answered, so its identity is only known after that.
    const ownMainPage = targetInfo.type === 'page' && targetInfo.targetId === await mainTarget;
    if (ownMainPage || targets.has(targetInfo.targetId)) { await resume(); return; }
    targets.add(targetInfo.targetId);
    // Every adopted session is listed, so a target nested under a dedicated worker is adopted too instead of staying paused.
    sessions.set(child, targetInfo.type);
    // Outcomes of requests this target makes arrive on its own session; a target without a Network domain only loses them.
    cdp.send('Network.enable', {}, child).catch(() => {});
    if (!OWNER_INTERCEPTS.has(targetInfo.type)) {
      try { await cdp.send('Fetch.enable', INTERCEPT_ALL, child); }
      catch {
        // A target that cannot be intercepted must not run: close it instead of resuming it.
        await cdp.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
        return;
      }
    }
    // Targets nested under this one (iframes, workers) attach to this session in turn; not every target type supports it.
    await cdp.send('Target.setAutoAttach', AUTO_ATTACH, child).catch(() => {});
    await resume();
  }

  async function close() {
    // Interception and the claim stay in place until the context is gone, so a target starting now is still intercepted.
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    for (const off of offs.splice(0)) off();
    claims.delete(browserContextId);
    retired.add(browserContextId);
  }

  try {
    claims.set(browserContextId, params => { adopt(params).catch(() => {}); });
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId }));
    announceMainTarget(targetId);
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    sessions.set(sessionId, 'page');
    targets.add(targetId);
    offs.push(cdp.on('Fetch.requestPaused', (params, session) => { if (sessions.has(session)) onPaused(session, params).catch(() => {}); }));
    offs.push(cdp.on('Target.attachedToTarget', (params, parent) => { if (parent !== undefined && sessions.has(parent)) adopt(params).catch(() => {}); }));
    offs.push(cdp.on('Network.requestWillBeSent', ({ requestId, redirectResponse }, session) => {
      const record = redirectResponse && sessions.has(session) ? unresolved(requestId) : null;
      if (record) record.status = redirectResponse.status;
    }));
    offs.push(cdp.on('Network.responseReceived', ({ requestId, response }, session) => {
      const record = sessions.has(session) ? unresolved(requestId) : null;
      if (record) record.status = response.status;
    }));
    offs.push(cdp.on('Network.loadingFailed', ({ requestId, errorText }, session) => {
      const record = sessions.has(session) ? unresolved(requestId) : null;
      if (record) record.error = errorText;
    }));
    on('Network.responseReceived', ({ type, frameId, response }) => {
      if (type === 'Document' && frameId === mainFrameId) lastDocument = { status: response.status };
    });
    on('Page.lifecycleEvent', ({ name, loaderId }) => { if (name === 'networkIdle') idleLoaders.add(loaderId); });
    on('Page.frameNavigated', ({ frame }) => { if (frame.id === mainFrameId) mainLoader = frame.loaderId; });
    on('Runtime.consoleAPICalled', ({ type, args }) => { if (type === 'error') consoleErrors.push(consoleText(args)); });
    on('Runtime.exceptionThrown', ({ exceptionDetails }) => { consoleErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text); });
    await send('Page.enable');
    await send('Network.enable');
    await send('Runtime.enable');
    await send('Page.setLifecycleEventsEnabled', { enabled: true });
    mainFrameId = (await send('Page.getFrameTree')).frameTree.frame.id;
    await send('Fetch.enable', INTERCEPT_ALL);
    await send('Target.setAutoAttach', AUTO_ATTACH);
  } catch (error) {
    announceMainTarget(null);
    await close();
    throw error;
  }

  return {
    requests,
    close,
    async goto(url) {
      mainBlocked = null;
      lastDocument = null;
      mainLoader = null;
      const result = { final_url: null, status: null, title: null, dom: null, links: [], console_errors: consoleErrors, blocked_reason: null, error: null };
      const deadline = sleep(limits().timeout_ms, 'timeout');
      const blocked = new Promise(resolve => { notifyMainBlocked = () => resolve('blocked'); });
      const navigated = await Promise.race([send('Page.navigate', { url }), deadline]);
      if (navigated === 'timeout') result.error = 'timeout';
      else if (navigated.errorText) result.error = navigated.errorText;
      else {
        mainLoader ??= navigated.loaderId;
        // Follow the page if it navigates itself (script, meta refresh) before it goes idle: only the idle event of the
        // latest main-frame loader counts, and the blank page we started from reports its own idle half a second after it opened.
        for (let settled = false; !settled;) {
          const loader = mainLoader;
          if (idleLoaders.has(loader) || mainBlocked) break;
          const idle = once('Page.lifecycleEvent', ({ name, loaderId }) => name === 'networkIdle' && loaderId === loader);
          const moved = once('Page.frameNavigated', ({ frame }) => frame.id === mainFrameId && frame.loaderId !== loader);
          try {
            const winner = await Promise.race([idle.promise.then(() => 'idle'), moved.promise.then(() => 'moved'), blocked, deadline]);
            if (winner === 'timeout') result.error = 'timeout';
            settled = winner !== 'moved' && !(winner === 'idle' && mainLoader !== loader);
          } finally { idle.off(); moved.off(); }
        }
      }
      notifyMainBlocked = () => {};
      result.blocked_reason = mainBlocked ?? (budgetBlocked ? 'render_budget' : null);
      if (mainBlocked || (result.error && result.error !== 'timeout')) return result;
      const { result: evaluated } = await send('Runtime.evaluate', { expression: READ_PAGE, returnByValue: true });
      Object.assign(result, JSON.parse(evaluated.value), { status: lastDocument?.status ?? null });
      return result;
    },
  };
}

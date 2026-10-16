import { spawn } from 'node:child_process';
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
 */
export function findChrome({ env = process.env, platform = process.platform, exists = existsSync, list = readdirSync } = {}) {
  const config = chromePaths();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const override = envValue(env, 'OPTBREW_CHROME');
  if (override && exists(override)) return { path: override, kind: guessKind(override) };

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

/** Kill a process tree: Windows `taskkill /T /F`, elsewhere the process group the child leads. */
function killTree(child) {
  if (exited(child) || child.pid === undefined) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    killer.once('error', resolve);
    killer.once('exit', resolve);
  });
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
async function attempt({ executable, proxy, hostRules, tmpRoot, transport: kind }) {
  const { chrome_launch_timeout_ms: launchTimeout, chrome_close_grace_ms: closeGrace, cdp_command_timeout_ms: commandTimeout } = limits();
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
  const cleanup = async () => {
    transport?.close();
    if (!exited(child)) { await killTree(child); await Promise.race([gone, sleep(closeGrace)]); }
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };

  let cdp;
  try {
    const deadline = Date.now() + launchTimeout;
    const connect = async () => {
      transport = kind === 'pipe' ? pipeTransport(child.stdio[3], child.stdio[4]) : await webSocketTransport(await readActivePort(userDataDir, deadline));
      cdp = createCdpClient(transport, { timeoutMs: commandTimeout });
      await cdp.send('Browser.getVersion');
    };
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('chrome launch timed out')), launchTimeout); });
    try { await Promise.race([connect(), failed, timeout]); } finally { clearTimeout(timer); }
  } catch (error) {
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
export async function launchChrome({ path: executable, proxy = null, hostRules = null, tmpRoot = os.tmpdir(), transports = ['pipe', 'port'] }) {
  let failure;
  for (const transport of transports) {
    try { return await attempt({ executable, proxy, hostRules, tmpRoot, transport }); }
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
        return found ? launch(found) : null;
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

/**
 * One isolated page whose every request passes the scope rules: in-scope requests continue; an out-of-scope document or
 * any request that is not GET/HEAD fails with BlockedByClient; an out-of-scope GET script, stylesheet, font or image
 * loads and is recorded as `third_party_static`. Redirect hops arrive as new requests and are checked again. Past
 * `budget` intercepted requests every request fails with `render_budget`.
 */
export async function scopedPage({ chrome, context, budget }) {
  const { cdp } = chrome;
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const offs = [];
  const requests = [];
  const consoleErrors = [];
  let targetId = null;
  let sessionId = null;
  let mainFrameId = null;
  let seen = 0;
  let mainBlocked = null;
  let budgetBlocked = false;
  let lastDocument = null;

  const send = (method, params) => cdp.send(method, params, sessionId);
  const on = (event, fn) => {
    const off = cdp.on(event, (params, session) => { if (session === sessionId) fn(params); });
    offs.push(off);
    return off;
  };
  const once = (event, test) => new Promise(resolve => {
    const off = on(event, params => { if (test(params)) { off(); resolve(params); } });
  });

  async function onPaused({ requestId, request, resourceType, redirectedRequestId, frameId }) {
    seen += 1;
    const verdict = seen > budget ? { action: 'blocked', blocked_reason: 'render_budget' } : decide(request, resourceType, context.scope);
    if (verdict.blocked_reason === 'render_budget') budgetBlocked = true;
    // Past the budget only the first overflowing request is listed, so a request flood cannot grow the list.
    if (seen <= budget + 1) {
      requests.push({ url: request.url, method: request.method, resource_type: resourceType, redirected: Boolean(redirectedRequestId), ...verdict });
    }
    if (verdict.action === 'blocked') {
      if (resourceType === 'Document' && frameId === mainFrameId) mainBlocked ??= verdict.blocked_reason;
      await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    } else await send('Fetch.continueRequest', { requestId });
  }

  async function close() {
    for (const off of offs.splice(0)) off();
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }

  try {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    on('Fetch.requestPaused', params => { onPaused(params).catch(() => {}); });
    on('Network.responseReceived', ({ type, frameId, response }) => {
      if (type === 'Document' && frameId === mainFrameId) lastDocument = { status: response.status };
    });
    on('Runtime.consoleAPICalled', ({ type, args }) => { if (type === 'error') consoleErrors.push(consoleText(args)); });
    on('Runtime.exceptionThrown', ({ exceptionDetails }) => { consoleErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text); });
    await send('Page.enable');
    await send('Network.enable');
    await send('Runtime.enable');
    await send('Page.setLifecycleEventsEnabled', { enabled: true });
    mainFrameId = (await send('Page.getFrameTree')).frameTree.frame.id;
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }], handleAuthRequests: true });
  } catch (error) {
    await close();
    throw error;
  }

  return {
    requests,
    close,
    async goto(url) {
      mainBlocked = null;
      lastDocument = null;
      const result = { final_url: null, status: null, title: null, dom: null, links: [], console_errors: consoleErrors, blocked_reason: null, error: null };
      const idle = once('Page.lifecycleEvent', ({ frameId, name }) => frameId === mainFrameId && name === 'networkIdle');
      const deadline = sleep(limits().timeout_ms, 'timeout');
      const navigated = await Promise.race([send('Page.navigate', { url }), deadline]);
      if (navigated === 'timeout') result.error = 'timeout';
      else if (navigated.errorText) result.error = navigated.errorText;
      else if (await Promise.race([idle, deadline]) === 'timeout') result.error = 'timeout';
      result.blocked_reason = mainBlocked ?? (budgetBlocked ? 'render_budget' : null);
      if (mainBlocked || (result.error && result.error !== 'timeout')) return result;
      const { result: evaluated } = await send('Runtime.evaluate', { expression: READ_PAGE, returnByValue: true });
      Object.assign(result, JSON.parse(evaluated.value), { status: lastDocument?.status ?? null });
      return result;
    },
  };
}

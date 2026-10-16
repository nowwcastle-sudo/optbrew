import { isIP } from 'node:net';
import { chromeHandle, findChrome, launchChrome, scopedPage } from './chrome.mjs';
import { fetchScoped } from './collector.mjs';
import { limits } from './config.mjs';
import { ContractError } from './contracts.mjs';
import { assertInScope, unbracket } from './scope.mjs';

/** The first URL of every page type, in the order given, cut at `limit`. The same page types always give the same pages. */
export function selectRenderPages(pageTypes, limit = limits().render_pages) {
  return pageTypes.flatMap(type => type.urls.slice(0, 1)).slice(0, limit);
}

// A third-party fetch follows no redirect: zero hops.
const FOLLOW_NONE = 0;
// Response headers that decide whether the page may use a cross-origin resource (fonts need them); never Set-Cookie.
const CORS_HEADERS = ['access-control-allow-origin', 'access-control-allow-credentials', 'timing-allow-origin'];

const addressOf = value => typeof value === 'string' ? value : value?.address;

/**
 * `--host-resolver-rules` for direct mode: Chrome resolves nothing but the allowed hosts, each pinned to the address address
 * vetting accepted for it, so Chrome connects where the vetting looked. A host that cannot be vetted (no answer, or a private
 * address outside `local_targets`) is mapped to `^NOTFOUND`, and so is every other name (the catch-all comes last): a
 * third-party static host is fetched by `staticFetcher` instead. IP literals are excluded from the catch-all; the interception
 * vets them.
 */
async function hostRulesFor(scope, resolve) {
  const byHost = new Map();
  const literals = [];
  for (const rule of scope.allowed) {
    const { hostname } = new URL(rule.origin);
    const host = unbracket(hostname);
    if (isIP(host)) { literals.push(`EXCLUDE ${hostname}`); continue; }
    byHost.set(host, [...(byHost.get(host) ?? []), new URL(rule.path_prefix ?? '/', rule.origin).href]);
  }
  const rules = [];
  for (const [host, urls] of byHost) {
    let target = '^NOTFOUND';
    try {
      const resolved = await resolve(host);
      const addresses = Array.isArray(resolved) ? resolved : [resolved];
      for (const url of urls) assertInScope(url, scope, addresses);
      const [first] = addresses.map(addressOf);
      target = isIP(first) === 6 ? `[${first}]` : first;
    } catch { /* an unvetted host stays ^NOTFOUND */ }
    rules.push(`MAP ${host} ${target}`);
  }
  return [...new Set(literals), ...rules, 'MAP * ^NOTFOUND'].join(',');
}

/**
 * The bytes of a third-party static GET, fetched by Node with the collector's own vetted fetch: the address is resolved and
 * vetted (private, loopback, link-local and metadata addresses are refused, no local_targets), the connection is pinned to
 * it, the byte limit and deadline are the collection limits. No redirect is followed: one intercepted request is one fetch,
 * so the render budget bounds the Node requests too, and a redirect answer is reported as `third_party_redirect`.
 */
function staticFetcher(transport) {
  return async url => {
    let result;
    try {
      result = await fetchScoped(url, { context: { scope: { allowed: [{ origin: new URL(url).origin }] } },
        transport: transport.transport, resolve: transport.resolve, addressVetting: 'direct', maxRedirects: FOLLOW_NONE, extraHeaders: CORS_HEADERS });
    } catch (error) {
      // The answered hops are recorded on the error; with no redirect allowed, one hop means the host answered with a redirect.
      if (error.redirect_chain?.length) error.code = 'third_party_redirect';
      throw error;
    }
    // Only these go to Chrome with the bytes, so a cookie or any other header of the third party never reaches the browser.
    const forwarded = Object.fromEntries(Object.entries(result.headers).filter(([name]) => name === 'content-type' || CORS_HEADERS.includes(name)));
    return { status: result.status, headers: forwarded, body: result.body };
  };
}

/**
 * The chrome handle for one render. Direct mode pins the vetted addresses through host rules, fetches third-party static
 * resources itself, and the render records say `pinned`; proxy mode hands Chrome the proxy and the records say `proxy`.
 * `transport` is what `selectTransport` returned; the proxy credential only ever travels inside it, in memory.
 * The handle also remembers why no Chrome was found.
 */
export function renderChrome({ context, transport, find = findChrome, launch = launchChrome }) {
  const pinned = transport.address_vetting === 'direct';
  let lookup = null;
  const handle = chromeHandle({ find: async () => (lookup = await find()), launch: async found => launch({ path: found.path,
    ...(pinned ? { hostRules: await hostRulesFor(context.scope, transport.resolve) } : { proxy: transport.proxy }) }) });
  return Object.assign(handle, { address_vetting: pinned ? 'pinned' : 'proxy', fetchStatic: pinned ? staticFetcher(transport) : null,
    notFound: () => ({ found: false, reason: lookup?.reason ?? 'chrome_not_found' }) });
}

/** Absolute same-origin links of the final DOM without fragments, each once, sorted. */
function sameOriginLinks({ final_url: finalUrl, links }) {
  if (!finalUrl) return [];
  const { origin } = new URL(finalUrl);
  const found = new Set();
  for (const link of links) {
    let url;
    try { url = new URL(link); } catch { continue; }
    url.hash = '';
    if (url.origin === origin) found.add(url.href);
  }
  return [...found].sort();
}

/**
 * The request list of one page in the entry shape of `ledger.json`: one entry per URL and outcome, `requests` counting what
 * went out. A request the render refused never reached the network, so it is `skipped` with no requests. A request that went
 * out is a `response` when Chrome saw a status for it and an `error` (with Chrome's error text) when it failed or no outcome
 * was seen; nothing is assumed to have succeeded.
 */
function ledgerEntries(page, requests) {
  const entries = new Map();
  for (const request of requests) {
    const refused = request.action === 'blocked';
    const reason = refused ? (request.blocked_reason === 'out_of_scope' ? 'outside_scope' : request.blocked_reason) : null;
    const error = refused ? null : request.error ?? (request.status === null ? 'no_response_recorded' : null);
    const outcome = refused ? 'skipped' : error ? 'error' : 'response';
    const key = JSON.stringify([request.url, outcome, reason, error]);
    if (!entries.has(key)) entries.set(key, { page, url: request.url, requests: 0, outcome, skipped_reason: reason, error });
    if (!refused) entries.get(key).requests += 1;
  }
  return [...entries.values()];
}

/**
 * Replay check of one page's `render_ledger` entries against its stored RenderRecord: the entries are exactly what the
 * record's requests give, no URL repeats with the same outcome and reason (it may repeat with distinct ones), nothing
 * skipped carries requests, and the requests sent stay within `maxRenderRequests`, the render's own budget.
 */
export function checkRenderLedger(entries, record, maxRenderRequests) {
  const fail = message => { throw new ContractError(`render ledger: ${message}`); };
  const mine = entries.filter(entry => entry.page === record.url);
  if (JSON.stringify(mine) !== JSON.stringify(ledgerEntries(record.url, record.requests))) fail('entries differ from the request records of the page');
  const keys = mine.map(entry => JSON.stringify([entry.url, entry.outcome, entry.skipped_reason, entry.error]));
  if (new Set(keys).size !== keys.length) fail('a URL repeats with the same outcome and reason');
  if (mine.some(entry => entry.outcome === 'skipped' && entry.requests !== 0)) fail('a skipped entry carries requests');
  if (mine.reduce((sum, entry) => sum + entry.requests, 0) > maxRenderRequests) fail('more requests than the render limit');
  if (record.requests.length > maxRenderRequests + 1) fail('more request records than the render limit allows');
}

async function renderOne({ ref, chrome, browser, context, store }) {
  let result = null;
  let requests = [];
  try {
    const page = await scopedPage({ chrome: browser, context, budget: context.protocol.render.max_render_requests, fetchStatic: chrome.fetchStatic });
    try { result = await page.goto(ref.normalized); } finally { requests = page.requests; await page.close(); }
  } catch { /* one page that cannot be rendered is recorded below; the others still render */ }
  const written = result?.dom ? await store.write('render-dom', result.dom) : null;
  const record = { url: ref.normalized, final_url: result?.final_url ?? null, status: result?.status ?? null,
    dom_ref: written?.ref ?? null, dom_sha256: written?.sha256 ?? null, title: result?.title ?? null,
    links: result ? sameOriginLinks(result) : [], console_errors: [...(result?.console_errors ?? [])], requests,
    blocked_reason: result ? result.blocked_reason ?? result.error : 'render_failed', address_vetting: chrome.address_vetting };
  const { ref: evidenceRef, sha256 } = await store.write('render', `${JSON.stringify(record, null, 2)}\n`);
  await store.append('renders', { url: record.url, evidence_ref: evidenceRef, sha256 });
  for (const entry of ledgerEntries(record.url, requests)) await store.append('render_ledger', entry);
  return record;
}

/**
 * Render the pages the protocol fixed (`protocol.render.pages`, and only those) one after another through the scoped
 * interception session. The final DOM, the record and every request go into `store`, so a verdict can be replayed from
 * the evidence. `chrome` comes from `renderChrome`. Returns `{ renders, chrome: { found, reason } }`: without a Chrome
 * nothing is rendered and `found` is false with the reason; when nothing was asked for, no Chrome is looked up and `found`
 * is null.
 */
export async function renderPages({ context, chrome, store }) {
  const { render } = context.protocol;
  if (!render.enabled || !render.pages.length) return { renders: [], chrome: { found: null, reason: 'render_not_requested' } };
  if (!chrome.address_vetting) throw new Error('renderPages needs the chrome handle that renderChrome returns');
  const browser = await chrome.get();
  if (!browser) return { renders: [], chrome: chrome.notFound() };
  const renders = [];
  for (const ref of render.pages) renders.push(await renderOne({ ref, chrome, browser, context, store }));
  return { renders, chrome: { found: true, reason: null } };
}

import { isIP } from 'node:net';
import { chromeHandle, findChrome, launchChrome, scopedPage } from './chrome.mjs';
import { limits } from './config.mjs';
import { assertInScope, unbracket } from './scope.mjs';

/** The first URL of every page type, in the order given, cut at `limit`. The same page types always give the same pages. */
export function selectRenderPages(pageTypes, limit = limits().render_pages) {
  return pageTypes.flatMap(type => type.urls.slice(0, 1)).slice(0, limit);
}

const addressOf = value => typeof value === 'string' ? value : value?.address;

/**
 * `--host-resolver-rules` that pin every allowed host to the address address vetting accepted for it, so Chrome connects
 * where the vetting looked. A host that cannot be vetted (no answer, or a private address outside `local_targets`) is mapped
 * to `^NOTFOUND`: Chrome must not resolve it by itself. IP literals need no rule; the interception vets them.
 */
async function hostRulesFor(scope, resolve) {
  const byHost = new Map();
  for (const rule of scope.allowed) {
    const { hostname } = new URL(rule.origin);
    const host = unbracket(hostname);
    if (isIP(host)) continue;
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
  return rules.join(',') || null;
}

/**
 * The chrome handle for one render. Direct mode pins the vetted addresses through host rules and the render records say
 * `pinned`; proxy mode hands Chrome the proxy and the render records say `proxy`. `transport` is what `selectTransport`
 * returned; the proxy credential only ever travels inside it, in memory.
 */
export function renderChrome({ context, transport, find = findChrome, launch = launchChrome }) {
  const pinned = transport.address_vetting === 'direct';
  const handle = chromeHandle({ find, launch: async found => launch({ path: found.path,
    ...(pinned ? { hostRules: await hostRulesFor(context.scope, transport.resolve) } : { proxy: transport.proxy }) }) });
  return Object.assign(handle, { address_vetting: pinned ? 'pinned' : 'proxy' });
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
 * went out. A request the render refused never reached the network, so it is `skipped` with no requests.
 */
function ledgerEntries(page, requests) {
  const entries = new Map();
  for (const request of requests) {
    const refused = request.action === 'blocked';
    const reason = refused ? (request.blocked_reason === 'out_of_scope' ? 'outside_scope' : request.blocked_reason) : null;
    const key = JSON.stringify([request.url, reason]);
    if (!entries.has(key)) entries.set(key, { page, url: request.url, requests: 0, outcome: refused ? 'skipped' : 'response', skipped_reason: reason, error: null });
    if (!refused) entries.get(key).requests += 1;
  }
  return [...entries.values()];
}

async function renderOne({ ref, browser, context, store, addressVetting }) {
  let result = null;
  let requests = [];
  try {
    const page = await scopedPage({ chrome: browser, context, budget: context.protocol.render.max_render_requests });
    try { result = await page.goto(ref.normalized); } finally { requests = page.requests; await page.close(); }
  } catch { /* one page that cannot be rendered is recorded below; the others still render */ }
  const written = result?.dom ? await store.write('render-dom', result.dom) : null;
  const record = { url: ref.normalized, final_url: result?.final_url ?? null, status: result?.status ?? null,
    dom_ref: written?.ref ?? null, dom_sha256: written?.sha256 ?? null, title: result?.title ?? null,
    links: result ? sameOriginLinks(result) : [], console_errors: [...(result?.console_errors ?? [])], requests,
    blocked_reason: result ? result.blocked_reason ?? result.error : 'render_failed', address_vetting: addressVetting };
  const { ref: evidenceRef, sha256 } = await store.write('render', `${JSON.stringify(record, null, 2)}\n`);
  await store.append('renders', { url: record.url, evidence_ref: evidenceRef, sha256 });
  for (const entry of ledgerEntries(record.url, requests)) await store.append('render_ledger', entry);
  return record;
}

/**
 * Render the pages the protocol fixed (`protocol.render.pages`, and only those) one after another through the scoped
 * interception session. The final DOM, the record and every request go into `store`, so a verdict can be replayed from
 * the evidence. Without a Chrome (`chrome.get()` is null) nothing is rendered and the result is `[]`.
 */
export async function renderPages({ context, chrome, store }) {
  const { render } = context.protocol;
  if (!render.enabled || !render.pages.length) return [];
  const browser = await chrome.get();
  if (!browser) return [];
  const records = [];
  for (const ref of render.pages) records.push(await renderOne({ ref, browser, context, store, addressVetting: chrome.address_vetting }));
  return records;
}

import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { assertInScope, assertUrlInScope, urlTarget } from './scope.mjs';
import { anchorLinks, canonicalLink } from './html.mjs';
import { limits, requestLimit } from './config.mjs';
import { directTransport } from './transport.mjs';

const HEADER_NAMES = ['content-type', 'content-length', 'content-range', 'content-encoding', 'location', 'x-robots-tag', 'last-modified', 'etag'];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// An API call follows no redirect: zero hops.
const FOLLOW_NONE = 0;
const text = value => Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');

function auxiliaryDocument(url) {
  const pathname = decodeURIComponent(new URL(url).pathname).toLowerCase();
  return /\.(?:txt|xml)(?:\.gz)?$/.test(pathname) ||
    /(?:^|\/)(?:sitemap|(?:[^/]*[-_])?polic(?:y|ies))(?:[-_.\/]|$)/.test(pathname);
}

function undeclaredAuxiliary(url, allowed) {
  if (!auxiliaryDocument(url.href) || allowed.has(url.href)) return;
  const error = new Error('auxiliary document was not declared');
  error.code = 'auxiliary_undeclared';
  throw error;
}

function safeHeaders(headers, extra = []) {
  const source = headers instanceof Headers ? Object.fromEntries(headers) : headers ?? {};
  return Object.fromEntries(Object.entries(source).filter(([name]) => HEADER_NAMES.includes(name.toLowerCase()) || extra.includes(name.toLowerCase()))
    .map(([name, value]) => [name.toLowerCase(), String(value)]));
}

/** Response header lines in wire order; repeated lines (for example two X-Robots-Tag lines) stay separate. */
function headerLines(response) {
  const lines = [];
  if (Array.isArray(response.rawHeaders)) {
    for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
      const name = String(response.rawHeaders[i]).toLowerCase();
      if (HEADER_NAMES.includes(name)) lines.push({ name, value: String(response.rawHeaders[i + 1]) });
    }
    return lines;
  }
  const source = response.headers instanceof Headers ? Object.fromEntries(response.headers) : response.headers ?? {};
  for (const [name, value] of Object.entries(source))
    if (HEADER_NAMES.includes(name.toLowerCase())) for (const item of Array.isArray(value) ? value : [value])
      lines.push({ name: name.toLowerCase(), value: String(item) });
  return lines;
}

async function addressesFor(url, resolve) {
  const { host } = urlTarget(url);
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  const values = await resolve(host);
  return (Array.isArray(values) ? values : [values]).map(x => {
    const address = typeof x === 'string' ? x : x?.address;
    return { address, family: isIP(address) };
  });
}

/** Fetch one URL with fresh DNS validation at every redirect and a pinned connection. */
export async function fetchScoped(input, { context, transport = directTransport, resolve = host => lookup(host, { all: true, verbatim: true }), timeoutMs = limits().timeout_ms, maxBytes = limits().max_bytes, maxRedirects = limits().max_redirects, headers = {}, allowedAuxiliary = null, reserveRequest = null, addressVetting = 'direct', extraHeaders = [], method = 'GET', body: requestBody = null, ceiling = { timeoutMs: limits().timeout_ms, maxBytes: limits().max_bytes }, fieldData = false }) {
  // A caller may ask for a lower ceiling, never a higher one than the config fixes: the crawl's limits, or the field-data limits
  // for the one adapter that says it is a field-data call (`transportFetch`).
  const fixed = fieldData ? { timeoutMs: limits().cwv_timeout_ms, maxBytes: limits().cwv_max_bytes } : { timeoutMs: limits().timeout_ms, maxBytes: limits().max_bytes };
  if (![timeoutMs, maxBytes, maxRedirects].every(Number.isInteger) || timeoutMs < 1 || timeoutMs > Math.min(ceiling.timeoutMs, fixed.timeoutMs) ||
      maxBytes < 1 || maxBytes > Math.min(ceiling.maxBytes, fixed.maxBytes) || maxRedirects < 0 || maxRedirects > limits().max_redirects)
    throw new Error('fetch limits exceed context ceiling');
  // Proxy vetting skips DNS-name checks, which is only safe when the proxy transport (not a direct connection) carries the request.
  if (addressVetting === 'proxy' && transport.addressVetting !== 'proxy') throw new Error('proxy address vetting requires the proxy transport');
  let url = assertUrlInScope(input, context.scope);
  if (allowedAuxiliary) undeclaredAuxiliary(url, allowedAuxiliary);
  const requested_url = String(input);
  const redirect_chain = [];
  let made = 0; // requests actually sent; an answered hop is in redirect_chain, an unanswered attempt is made - chain length
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error('request timeout')); }, timeoutMs);
  const withinDeadline = promise => Promise.race([promise, timeout]);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const addresses = await withinDeadline(addressesFor(url, resolve));
      try { assertInScope(url.href, context.scope, addresses, { addressVetting }); }
      catch (error) { error.code = 'scope_rejected'; error.redirect_chain = redirect_chain; throw error; }
      // Pick only a vetted address. The transport must use this address, not resolve again.
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0 || controller.signal.aborted) throw new Error('request timeout');
      // Reserve the shared budget immediately before the real request; redirect hops are requests too.
      if (reserveRequest && !reserveRequest()) {
        const error = new Error('request budget exhausted');
        error.code = 'request_limit';
        error.redirect_chain = redirect_chain;
        throw error;
      }
      made++;
      const response = await withinDeadline(transport({ url, address: addresses[0], timeoutMs: remainingMs, maxBytes, headers, signal: controller.signal, method, body: requestBody }));
      if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) throw new Error('invalid transport status');
      const body = text(response.body);
      if (body.length > maxBytes) throw new Error('response byte limit exceeded');
      const savedHeaders = safeHeaders(response.headers, extraHeaders);
      if (REDIRECTS.has(response.status) && savedHeaders.location) {
        if (hop === maxRedirects) {
          redirect_chain.push({ url: url.href, status: response.status, location: '[limit]' });
          throw new Error('redirect limit exceeded');
        }
        let next;
        try { next = assertUrlInScope(new URL(savedHeaders.location, url).href, context.scope); }
        catch {
          const error = new Error('redirect outside scope');
          error.code = 'redirect_outside_scope';
          try { error.redirect_to = new URL(savedHeaders.location, url).href; } catch { /* an unparsable location names no site */ }
          error.redirect_chain = [...redirect_chain, { url: url.href, status: response.status, location: '[blocked]' }];
          throw error;
        }
        if (allowedAuxiliary) {
          try { undeclaredAuxiliary(next, allowedAuxiliary); }
          catch (error) { error.redirect_chain = [...redirect_chain, { url: url.href, status: response.status, location: '[blocked]' }]; throw error; }
        }
        redirect_chain.push({ url: url.href, status: response.status, location: next.href });
        url = next;
        continue;
      }
      return {
        requested_url, normalized_url: assertUrlInScope(requested_url, context.scope).href, final_url: url.href,
        status: response.status, headers: savedHeaders, header_lines: headerLines(response), redirect_chain, raw_html_ref: null,
        content_hash: createHash('sha256').update(body).digest('hex'),
        capability: savedHeaders['content-type']?.toLowerCase().includes('html') &&
          (!savedHeaders['content-encoding'] || savedHeaders['content-encoding'].toLowerCase() === 'identity') ? 'raw_html' : 'raw_response',
        source_ref: 'optbrew:collector', evidence_ref: null, error: null, body,
      };
    }
    throw new Error('redirect limit exceeded');
  } catch (error) {
    error.redirect_chain ??= [...redirect_chain];
    error.unanswered = Math.max(0, made - error.redirect_chain.length);
    throw error;
  }
  finally { clearTimeout(timer); }
}

/**
 * A fetch-like function over the transport `selectTransport` chose, for API calls the audit makes itself (field CWV): the
 * host is resolved and vetted exactly as `fetchScoped` does it (direct: pinned vetted address; proxy: the proxy resolves,
 * literals are vetted), a redirect is never followed, and the limits are the caller's, not the page collection's.
 * It answers `{ status, text() }` and throws what `fetchScoped` throws.
 */
export function transportFetch(selected, { timeoutMs, maxBytes }) {
  return async (url, { method = 'GET', headers = {}, body = null } = {}) => {
    const result = await fetchScoped(url, { context: { scope: { allowed: [{ origin: new URL(url).origin }] } }, transport: selected.transport,
      resolve: selected.resolve, addressVetting: selected.address_vetting, method, headers, body, maxRedirects: FOLLOW_NONE,
      timeoutMs, maxBytes, ceiling: { timeoutMs, maxBytes }, fieldData: true });
    return { status: result.status, text: async () => result.body.toString('utf8') };
  };
}

/** Index of the declared robots.txt artifact on the same origin as the page, as the audit and the report both select it. */
export function declaredRobotsIndex(artifacts, declaredRobots, pageFinalUrl) {
  return artifacts.findIndex(x => {
    try { const u = new URL(x.final_url); return declaredRobots.has(x.normalized_url) && u.origin === new URL(pageFinalUrl).origin && u.pathname === '/robots.txt'; }
    catch { return false; }
  });
}

/** Anchors plus the canonical target, which the report needs in order to judge canonical consistency. */
export function links(html, base) {
  const out = anchorLinks(html, base);
  const canonical = canonicalLink(html);
  if (canonical) { try { out.push(new URL(canonical, base).href); } catch { /* malformed canonical */ } }
  return out;
}

/** Bounded crawl of fixed protocol URLs and their in-scope links. */
export async function collect(context, { transport, resolve, addressVetting } = {}) {
  const scope = context?.scope;
  const limit = requestLimit(scope);
  const depthLimit = Math.min(scope?.max_depth ?? limits().max_depth, limits().max_depth);
  const concurrency = Math.min(scope?.concurrency ?? limits().concurrency, limits().concurrency);
  if (![limit, depthLimit, concurrency].every(Number.isInteger) || limit < 1 || depthLimit < 0 || concurrency < 1)
    throw new Error('invalid collection limits');
  const initial = context.protocol.page_types.flatMap(type => type.urls.map(ref => ref.normalized));
  const auxiliary = context.protocol.auxiliary_resources ?? [];
  const declaredAuxiliary = new Set(auxiliary.map(resource => resource.normalized));
  const allowedDocuments = new Set([...initial, ...declaredAuxiliary]);
  if (initial.some(url => /\/(?:robots\.txt|sitemap[^/]*\.xml)$/i.test(decodeURIComponent(new URL(url).pathname))))
    throw new Error('robots and sitemap must be auxiliary resources');
  if (auxiliary.length && initial.length + auxiliary.length > limit) throw new Error('selected pages and auxiliary resources exceed request scope');
  const queue = []; const seen = new Set(); const skipped = [];
  // Every queued or rejected URL leaves one ledger entry, so skipped URLs and the request count can be checked later.
  const ledger = [];
  const skip = (url, reason) => { skipped.push({ url, reason }); ledger.push({ url, requests: 0, outcome: 'skipped', skipped_reason: reason, error: null }); };
  const enqueue = (url, depth, auxiliaryResource = false) => {
    let normalized;
    try { normalized = assertUrlInScope(url, scope).href; }
    catch { skip(url, 'outside_scope'); return; }
    if (depth > 0 && auxiliaryDocument(normalized) && !allowedDocuments.has(normalized)) {
      skip(normalized, 'auxiliary_undeclared'); return;
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    if (depth > depthLimit) { skip(normalized, 'depth_limit'); return; }
    queue.push({ url: normalized, depth, auxiliaryResource });
  };
  initial.forEach(url => enqueue(url, 0));
  for (const resource of auxiliary) {
    if (seen.has(resource.normalized)) throw new Error('auxiliary resource duplicates selected URL');
    const normalized = assertUrlInScope(resource.normalized, scope).href;
    if (normalized !== resource.normalized || assertUrlInScope(resource.original, scope).href !== normalized)
      throw new Error('auxiliary resource URL mismatch');
    enqueue(normalized, 0, true);
  }
  const artifacts = []; let cursor = 0; let requestCount = 0;
  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      if (requestCount >= limit) { skip(item.url, 'url_limit'); continue; }
      let used = 0;
      // The budget is a hard ceiling: every request, redirect hops included, takes one slot immediately before it is sent.
      // A chain the budget stops is a request_limit unknown whose answered hops are recorded.
      const reserveRequest = () => {
        if (requestCount >= limit) return false;
        requestCount++; used++;
        return true;
      };
      let artifact;
      try { artifact = await fetchScoped(item.url, { context, transport, resolve, addressVetting, allowedAuxiliary: allowedDocuments, reserveRequest }); }
      catch (error) {
        const reason = ['scope_rejected', 'redirect_outside_scope', 'auxiliary_undeclared', 'request_limit'].includes(error.code) ? error.code : 'fetch_failed';
        if (reason === 'request_limit' && !used) { skip(item.url, 'url_limit'); continue; }
        if (reason !== 'fetch_failed') skipped.push({ url: item.url, reason });
        // The requests a failed fetch made are its answered hops (kept in the hashed failure record) plus at most one
        // attempt that got no response, so the ledger can prove them.
        const chain = error.redirect_chain ?? [];
        const unanswered = error.unanswered ?? 0;
        ledger.push({ url: item.url, requests: chain.length + unanswered, outcome: 'error', skipped_reason: reason !== 'fetch_failed' ? reason : null, error: reason });
        artifact = { requested_url: item.url, normalized_url: item.url, final_url: null, status: null,
          headers: {}, header_lines: [], redirect_chain: chain, unanswered, raw_html_ref: null, content_hash: null, capability: 'none',
          source_ref: 'optbrew:collector', evidence_ref: null, error: reason, body: Buffer.alloc(0) };
      }
      if (!artifact.error) ledger.push({ url: item.url, requests: used, outcome: 'response', skipped_reason: null, error: null });
      artifacts.push(artifact);
      if (!item.auxiliaryResource && artifact.status === 200 && artifact.capability === 'raw_html')
        for (const next of links(artifact.body.toString('utf8'), artifact.final_url)) enqueue(next, item.depth + 1);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  // Counts follow the ledger (failed fetches count once), the same rule the report replay applies.
  const evaluated = ledger.filter(x => x.requests > 0).length;
  const counted = ledger.reduce((sum, x) => sum + x.requests, 0);
  return { artifacts, ledger, discovered_count: seen.size, evaluated_count: evaluated, request_count: counted, skipped,
    limit_reached: skipped.some(x => x.reason === 'url_limit' || x.reason === 'request_limit') };
}

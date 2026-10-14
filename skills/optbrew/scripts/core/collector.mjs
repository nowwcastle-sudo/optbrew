import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { assertInScope, assertUrlInScope } from './scope.mjs';

const HEADER_NAMES = ['content-type', 'content-length', 'content-range', 'content-encoding', 'location', 'x-robots-tag', 'last-modified', 'etag'];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const text = value => Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');

function safeHeaders(headers) {
  const source = headers instanceof Headers ? Object.fromEntries(headers) : headers ?? {};
  return Object.fromEntries(Object.entries(source).filter(([name]) => HEADER_NAMES.includes(name.toLowerCase()))
    .map(([name, value]) => [name.toLowerCase(), String(value)]));
}

/** Node's lookup callback pins the already-vetted address while TLS still verifies the URL hostname. */
async function nodeTransport({ url, address, timeoutMs, maxBytes, headers = {}, signal }) {
  const client = url.protocol === 'https:' ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: 'GET', agent: false, signal, headers: { 'User-Agent': 'optbrew/0.1 (bounded public audit)', Accept: '*/*', 'Accept-Encoding': 'identity', ...headers },
      lookup: (_hostname, options, callback) => options.all ?
        callback(null, [{ address: address.address, family: address.family }]) : callback(null, address.address, address.family),
      ...(url.protocol === 'https:' ? { rejectUnauthorized: true,
        ...(!isIP(hostname) ? { servername: hostname } : {}) } : {}),
    }, res => {
      const chunks = []; let size = 0;
      if (Number(res.headers['content-length']) > maxBytes) {
        req.destroy(new Error('response byte limit exceeded')); return;
      }
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(new Error('response byte limit exceeded')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function addressesFor(url, resolve) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  const values = await resolve(host);
  return (Array.isArray(values) ? values : [values]).map(x => {
    const address = typeof x === 'string' ? x : x?.address;
    return { address, family: isIP(address) };
  });
}

/** Fetch one URL with fresh DNS validation at every redirect and a pinned connection. */
export async function fetchScoped(input, { context, transport = nodeTransport, resolve = host => lookup(host, { all: true, verbatim: true }), timeoutMs = 20000, maxBytes = 5242880, maxRedirects = 10, headers = {} }) {
  if (![timeoutMs, maxBytes, maxRedirects].every(Number.isInteger) || timeoutMs < 1 || timeoutMs > 20000 || maxBytes < 1 || maxBytes > 5242880 || maxRedirects < 0 || maxRedirects > 10)
    throw new Error('fetch limits exceed context ceiling');
  let url = assertUrlInScope(input, context.scope);
  const requested_url = String(input);
  const redirect_chain = [];
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error('request timeout')); }, timeoutMs);
  const withinDeadline = promise => Promise.race([promise, timeout]);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const addresses = await withinDeadline(addressesFor(url, resolve));
      try { assertInScope(url.href, context.scope, addresses); }
      catch (error) { error.code = 'scope_rejected'; error.redirect_chain = redirect_chain; throw error; }
      // Pick only a vetted address. The transport must use this address, not resolve again.
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0 || controller.signal.aborted) throw new Error('request timeout');
      const response = await withinDeadline(transport({ url, address: addresses[0], timeoutMs: remainingMs, maxBytes, headers, signal: controller.signal }));
      if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) throw new Error('invalid transport status');
      const body = text(response.body);
      if (body.length > maxBytes) throw new Error('response byte limit exceeded');
      const savedHeaders = safeHeaders(response.headers);
      if (REDIRECTS.has(response.status) && savedHeaders.location) {
        if (hop === maxRedirects) throw new Error('redirect limit exceeded');
        let next;
        try { next = assertUrlInScope(new URL(savedHeaders.location, url).href, context.scope); }
        catch {
          const error = new Error('redirect outside scope');
          error.code = 'redirect_outside_scope';
          error.redirect_chain = [...redirect_chain, { url: url.href, status: response.status, location: '[blocked]' }];
          throw error;
        }
        redirect_chain.push({ url: url.href, status: response.status, location: next.href });
        url = next;
        continue;
      }
      return {
        requested_url, normalized_url: assertUrlInScope(requested_url, context.scope).href, final_url: url.href,
        status: response.status, headers: savedHeaders, redirect_chain, raw_html_ref: null,
        content_hash: createHash('sha256').update(body).digest('hex'),
        capability: savedHeaders['content-type']?.toLowerCase().includes('html') &&
          (!savedHeaders['content-encoding'] || savedHeaders['content-encoding'].toLowerCase() === 'identity') ? 'raw_html' : 'raw_response',
        source_ref: 'optbrew:collector', evidence_ref: null, error: null, body,
      };
    }
    throw new Error('redirect limit exceeded');
  } finally { clearTimeout(timer); }
}

function links(html, base) {
  const out = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    try { out.push(new URL(match[1] ?? match[2], base).href); } catch { /* malformed link */ }
  }
  return out;
}

/** Bounded crawl of fixed protocol URLs and their in-scope links. */
export async function collect(context, { transport, resolve } = {}) {
  const scope = context?.scope;
  const limit = Math.min(scope?.max_urls ?? 50, 50);
  const depthLimit = Math.min(scope?.max_depth ?? 3, 3);
  const concurrency = Math.min(scope?.concurrency ?? 2, 2);
  if (![limit, depthLimit, concurrency].every(Number.isInteger) || limit < 1 || depthLimit < 0 || concurrency < 1)
    throw new Error('invalid collection limits');
  const initial = context.protocol.page_types.flatMap(type => type.urls.map(ref => ref.normalized));
  const queue = []; const seen = new Set(); const skipped = [];
  const enqueue = (url, depth) => {
    let normalized;
    try { normalized = assertUrlInScope(url, scope).href; }
    catch { skipped.push({ url, reason: 'outside_scope' }); return; }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    if (depth > depthLimit) { skipped.push({ url: normalized, reason: 'depth_limit' }); return; }
    queue.push({ url: normalized, depth });
  };
  initial.forEach(url => enqueue(url, 0));
  const artifacts = []; let cursor = 0; let scheduled = 0;
  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      if (scheduled >= limit) { skipped.push({ url: item.url, reason: 'url_limit' }); continue; }
      scheduled++;
      let artifact;
      try { artifact = await fetchScoped(item.url, { context, transport, resolve }); }
      catch (error) {
        const reason = ['scope_rejected', 'redirect_outside_scope'].includes(error.code) ? error.code : 'fetch_failed';
        if (reason !== 'fetch_failed') skipped.push({ url: item.url, reason });
        artifact = { requested_url: item.url, normalized_url: item.url, final_url: null, status: null,
          headers: {}, redirect_chain: error.redirect_chain ?? [], raw_html_ref: null, content_hash: null, capability: 'none',
          source_ref: 'optbrew:collector', evidence_ref: null, error: reason, body: Buffer.alloc(0) };
      }
      artifacts.push(artifact);
      if (artifact.status === 200 && artifact.capability === 'raw_html')
        for (const next of links(artifact.body.toString('utf8'), artifact.final_url)) enqueue(next, item.depth + 1);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { artifacts, discovered_count: seen.size, evaluated_count: scheduled, skipped, limit_reached: skipped.some(x => x.reason === 'url_limit') };
}

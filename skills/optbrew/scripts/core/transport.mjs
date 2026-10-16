import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';

const DNS_FAILURES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const unbracket = host => host.replace(/^\[|\]$/g, '');
const target = url => ({ hostname: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) });

/** Read one response into `{ status, headers, rawHeaders, body }`; both transports share this, byte limit included. */
function exchange({ send, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    // Reject first: once a response has started, destroying the request ends it quietly and would resolve a truncated body.
    const overLimit = () => { reject(new Error('response byte limit exceeded')); req.destroy(); };
    const req = send(res => {
      const chunks = []; let size = 0;
      if (Number(res.headers['content-length']) > maxBytes) { overLimit(); return; }
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { overLimit(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

const requestHeaders = headers => ({ 'User-Agent': 'optbrew/0.1 (bounded public audit)', Accept: '*/*', 'Accept-Encoding': 'identity', ...headers });

/** Node's lookup callback pins the already-vetted address while TLS still verifies the URL hostname. */
export function directTransport({ url, address, timeoutMs, maxBytes, headers = {}, signal }) {
  const client = url.protocol === 'https:' ? https : http;
  const hostname = unbracket(url.hostname);
  return exchange({ timeoutMs, maxBytes, send: onResponse => client.request(url, {
    method: 'GET', agent: false, signal, headers: requestHeaders(headers),
    lookup: (_hostname, options, callback) => options.all ?
      callback(null, [{ address: address.address, family: address.family }]) : callback(null, address.address, address.family),
    ...(url.protocol === 'https:' ? { rejectUnauthorized: true,
      ...(!isIP(hostname) ? { servername: hostname } : {}) } : {}),
  }, onResponse) });
}

/** Error that names the proxy by host and port only, so no credential can reach a message. */
function proxyError(proxy, what, code) {
  const error = new Error(`${what} via ${proxy.host}:${proxy.port}`);
  error.code = code;
  return error;
}

/** Open a CONNECT tunnel to the target; resolves with the raw tunnel socket. */
function openTunnel(proxy, url, { timeoutMs, signal }) {
  const { hostname, port } = target(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${hostname}:${port}`, agent: false, signal,
      headers: { Host: `${hostname}:${port}`, ...(proxy.authorization ? { 'Proxy-Authorization': proxy.authorization } : {}) } });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    req.on('connect', (res, socket, head) => {
      if (res.statusCode < 200 || res.statusCode > 299) {
        socket.destroy();
        reject(proxyError(proxy, `proxy CONNECT refused with status ${res.statusCode}`, 'proxy_connect_refused'));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.on('error', error => reject(proxyError(proxy, `proxy connection failed (${error.code ?? error.message})`, 'proxy_unreachable')));
    req.end();
  });
}

/**
 * Transport that sends every request, plain http included, through a CONNECT tunnel; the proxy resolves the target name.
 * HTTPS targets get TLS over the tunnel with SNI set (Node leaves SNI off when a socket is supplied).
 */
export function proxyTransport(proxy, { connectTls = tls.connect } = {}) {
  return async ({ url, timeoutMs, maxBytes, headers = {}, signal }) => {
    const tunnel = await openTunnel(proxy, url, { timeoutMs, signal });
    const { hostname, port } = target(url);
    const bare = unbracket(hostname);
    const stream = url.protocol === 'https:' ?
      connectTls({ socket: tunnel, rejectUnauthorized: true, ...(!isIP(bare) ? { servername: bare } : {}) }) : tunnel;
    try {
      // No `agent` option: `agent: false` makes Node build an Agent that ignores createConnection and dials the name itself.
      return await exchange({ timeoutMs, maxBytes, send: onResponse => http.request({
        host: bare, port, path: `${url.pathname}${url.search}`, method: 'GET', signal,
        createConnection: () => stream, headers: { Host: url.host, ...requestHeaders(headers) } }, onResponse) });
    } finally { stream.destroy(); tunnel.destroy(); }
  };
}

/** `HTTPS_PROXY` as `{ host, port, authorization }`. Only plain-HTTP proxies work (a missing scheme counts as plain HTTP); userinfo becomes a Basic header and is not kept. */
export function parseProxy(env) {
  const value = (env.HTTPS_PROXY || env.https_proxy || '').trim();
  const parts = /^(?:([a-z][a-z\d+.-]*):\/\/)?(.*)$/i.exec(value);
  const scheme = (parts[1] ?? 'http').toLowerCase();
  if (!value || scheme !== 'http') return null;
  let url;
  try { url = new URL(`${scheme}://${parts[2]}`); } catch { return null; }
  if (!url.hostname) return null;
  const decode = text => { try { return decodeURIComponent(text); } catch { return text; } };
  const authorization = url.username || url.password ?
    `Basic ${Buffer.from(`${decode(url.username)}:${decode(url.password)}`).toString('base64')}` : null;
  const proxy = { host: unbracket(url.hostname), port: Number(url.port || 80) };
  // Not enumerable: JSON.stringify, spread and inspect all leave the credential out; only a direct read sees it.
  return Object.defineProperty(proxy, 'authorization', { value: authorization, enumerable: false });
}

/** NO_PROXY entries: comma-separated, case-insensitive, `*` matches all, an entry matches the host or any subdomain; ports are ignored. */
function bypassesProxy(env, host) {
  const entries = (env.NO_PROXY || env.no_proxy || '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean);
  const name = unbracket(host.toLowerCase());
  return entries.some(entry => {
    if (entry === '*') return true;
    const bare = entry.startsWith('[') ? entry.slice(1, entry.indexOf(']')) :
      entry.split(':').length === 2 ? entry.split(':')[0] : entry;
    const domain = bare.replace(/^\*?\./, '');
    return name === domain || name.endsWith(`.${domain}`);
  });
}

function dnsError(host, code, reason) {
  const error = new Error(`DNS lookup for ${host} failed (${code}) and ${reason}`);
  error.code = 'dns_unresolvable';
  error.dns_code = code;
  return error;
}

/** Direct transport when DNS works; the HTTPS proxy when DNS fails and one is set (NO_PROXY respected); a classified error otherwise. */
export async function selectTransport({ env, resolve, probeHost }) {
  try {
    await resolve(probeHost);
    return { transport: directTransport, resolve, address_vetting: 'direct', proxy: null };
  } catch (error) {
    if (!DNS_FAILURES.has(error?.code)) throw error;
    const proxy = bypassesProxy(env, probeHost) ? null : parseProxy(env);
    if (!proxy) throw dnsError(probeHost, error.code, 'no usable HTTPS_PROXY is set');
    return { transport: proxyTransport(proxy), resolve: async () => [], address_vetting: 'proxy', proxy };
  }
}

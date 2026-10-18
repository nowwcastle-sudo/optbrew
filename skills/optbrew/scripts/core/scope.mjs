import { BlockList, isIP } from 'node:net';

const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [base, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked4.addSubnet(base, prefix, 'ipv4');
for (const [base, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['2001:db8::', 32]]) blocked6.addSubnet(base, prefix, 'ipv6');

function addressText(value) { return typeof value === 'string' ? value : value?.address; }
function privateAddress(value) {
  const address = addressText(value);
  const kind = isIP(address);
  if (!kind) throw new Error('unresolved or invalid IP address');
  if (kind === 4) return blocked4.check(address, 'ipv4');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? blocked4.check(mapped[1], 'ipv4') : blocked6.check(address, 'ipv6');
}

/** Check the URL boundary before DNS; every request additionally checks resolved IPs. */
export function assertUrlInScope(input, scope) {
  let url;
  try { url = new URL(input); } catch { throw new Error('invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL scheme or userinfo outside scope');
  if (/%(?:2f|5c|25)/i.test(url.pathname)) throw new Error('encoded path delimiter outside scope');
  if (!Array.isArray(scope?.allowed) || !scope.allowed.length) throw new Error('scope.allowed required');
  const path = decodeURIComponent(url.pathname);
  const matching = scope.allowed.some(rule => {
    let origin;
    try { origin = new URL(rule.origin); } catch { return false; }
    if (origin.origin !== url.origin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
    const prefix = rule.path_prefix ?? '/';
    if (typeof prefix !== 'string' || !prefix.startsWith('/')) return false;
    return prefix === '/' || path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  });
  if (!matching) throw new Error('URL outside allowed origin or path');
  url.hash = '';
  return url;
}

export const unbracket = host => host.replace(/^\[|\]$/g, '');

/** Host without IPv6 brackets and the port the URL connects to. */
export const urlTarget = url => ({ host: unbracket(url.hostname), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) });

/**
 * Check origin, path segment, and every resolved address before a request.
 * Through a proxy (`addressVetting: 'proxy'`) the proxy resolves names, so only DNS-name vetting is skipped:
 * IP literals and localhost names are still checked here.
 */
export function assertInScope(input, scope, resolvedAddresses, { addressVetting = 'direct' } = {}) {
  const url = assertUrlInScope(input, scope);
  const target = urlTarget(url);
  const { port } = target;
  // A trailing dot is the same name (`localhost.` resolves like `localhost`), so compare without it.
  const host = target.host.replace(/\.$/, '');
  const local = (scope.local_targets ?? []).some(x => x.host === host && Number(x.port) === port);
  if (addressVetting === 'proxy') {
    if (local) return url;
    if (isIP(host)) {
      if (privateAddress(host)) throw new Error('private or reserved address outside local target');
    } else if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('localhost outside local target');
    return url;
  }
  if (!Array.isArray(resolvedAddresses) || !resolvedAddresses.length) throw new Error('resolved addresses required');
  for (const address of resolvedAddresses) if (privateAddress(address) && !local) throw new Error('private or reserved address outside local target');
  return url;
}

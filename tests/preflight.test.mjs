import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight } from '../skills/optbrew/scripts/preflight.mjs';
import { limits } from '../skills/optbrew/scripts/core/config.mjs';
import { tempDir } from './support/temp-dir.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/optbrew');
const origin = 'https://example.test';
const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }];

const page = (title, links = []) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="About ${title}"></head>` +
  `<body><h1>${title} heading</h1><p>Phone: 02-555-0142</p><p>Address: 10 Main Street, Springfield</p>${links.map(href => `<a href="${href}">${href}</a>`).join(' ')}</body></html>`;
const html = body => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(body) });
const xml = body => ({ status: 200, headers: { 'content-type': 'application/xml' }, body: Buffer.from(body) });

/** A fake site: `routes` maps a path to a response; every request is counted. Anything else is a 404. */
function site(routes) {
  const requests = [];
  const transport = async ({ url }) => {
    requests.push(url.pathname);
    return routes[url.pathname] ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') };
  };
  const selectTransport = async () => ({ transport, resolve: async () => PUBLIC_ADDRESS, address_vetting: 'direct', proxy: null });
  return { requests, selectTransport };
}
const run = async (fake, over = {}) => {
  const out = await tempDir('optbrew-preflight-');
  const result = await preflight({ url: `${origin}/`, out, skillRoot, env: { CLAUDECODE: '1' }, selectTransport: fake.selectTransport,
    findChrome: () => ({ path: '/usr/bin/chrome', kind: 'chrome' }), readGoogleKey: () => 'key', home: '/no/such/home', ...over });
  return { out, ...result };
};

test('preflight never exceeds preflight_pages', async () => {
  const links = Array.from({ length: 40 }, (_, i) => `/p${i}`);
  const routes = { '/': html(page('Home', links)), '/sitemap.xml': xml('<urlset>' + links.map(l => `<url><loc>${origin}${l}</loc></url>`).join('') + '</urlset>') };
  for (const link of links) routes[link] = html(page(`Page ${link}`));
  const fake = site(routes);
  const { startJson } = await run(fake);
  assert.ok(fake.requests.length > 1);
  assert.ok(fake.requests.length <= limits().preflight_pages, `${fake.requests.length} requests`);
  assert.equal(startJson.sitemap_pages, 40);
  assert.equal(startJson.probe.sitemap_pages, 40);
});

test('redirect hops and the sitemap count against the same budget', async () => {
  const routes = { '/': { status: 301, headers: { location: '/home' }, body: Buffer.alloc(0) }, '/home': html(page('Home')), '/sitemap.xml': xml('<urlset></urlset>') };
  const fake = site(routes);
  const { startJson } = await run(fake);
  assert.deepEqual(fake.requests, ['/', '/home', '/sitemap.xml']);
  assert.equal(startJson.question_candidates_input[0].title, 'Home');
  assert.equal(startJson.sitemap_pages, 0);
});

test('a sitemap index is read child by child within the budget', async () => {
  const children = Array.from({ length: 30 }, (_, i) => `/sitemap-${i}.xml`);
  const routes = { '/': html(page('Home')), '/sitemap.xml': xml('<sitemapindex>' + children.map(c => `<sitemap><loc>${origin}${c}</loc></sitemap>`).join('') + '</sitemapindex>') };
  for (const child of children) routes[child] = xml('<urlset><url><loc>https://example.test/a</loc></url><url><loc>https://example.test/b</loc></url></urlset>');
  const fake = site(routes);
  const { startJson } = await run(fake);
  assert.equal(fake.requests.length, limits().preflight_pages);
  assert.equal(startJson.sitemap_pages, 2 * (limits().preflight_pages - 2));
});

test('a missing sitemap leaves sitemap_pages null', async () => {
  const { startJson } = await run(site({ '/': html(page('Home')) }));
  assert.equal(startJson.sitemap_pages, null);
});

test('preflight evidence is separate from the audit evidence index', async () => {
  const fake = site({ '/': html(page('Home', ['/about'])), '/about': html(page('About')), '/sitemap.xml': xml('<urlset><url><loc>https://example.test/</loc></url></urlset>') });
  const { out } = await run(fake);
  await assert.rejects(access(path.join(out, 'evidence', 'evidence-index.json')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(out, 'evidence-index.json')), { code: 'ENOENT' });
  const index = JSON.parse(await readFile(path.join(out, 'preflight', 'evidence', 'evidence-index.json'), 'utf8'));
  assert.deepEqual(index.raw.map(entry => entry.normalized_url).toSorted(), [`${origin}/`, `${origin}/about`, `${origin}/sitemap.xml`]);
  for (const entry of index.raw) assert.ok(entry.evidence_ref.includes(`${path.sep}preflight${path.sep}`), entry.evidence_ref);
  assert.deepEqual((await readdir(path.join(out, 'preflight'))).toSorted(), ['evidence', 'start.json']);
});

test('start.json carries start_runbooks from the probe', async () => {
  const fake = site({ '/': html(page('Home')) });
  const { out, startJson } = await run(fake, { findChrome: () => null, readGoogleKey: () => null });
  assert.deepEqual(startJson, JSON.parse(await readFile(path.join(out, 'preflight', 'start.json'), 'utf8')));
  assert.equal(startJson.probe.harness, 'claude-code');
  assert.equal(startJson.probe.chrome.found, false);
  assert.equal(startJson.probe.google_key, false);
  assert.deepEqual(startJson.start_runbooks.blocking, []);
  assert.deepEqual(startJson.start_runbooks.improving.map(item => item.id), ['google-api-key', 'chrome-install', 'gsc-export']);
  assert.ok(startJson.start_runbooks.improving.every(item => typeof item.line === 'string' && item.line));
});

test('a blocked network starts the one blocking runbook for the harness and fetches nothing', async () => {
  const fake = site({ '/': html(page('Home')) });
  const dnsDown = Object.assign(new Error('DNS lookup for example.test failed (ENOTFOUND) and no usable HTTPS_PROXY is set'), { code: 'dns_unresolvable' });
  const { startJson } = await run(fake, { env: { CODEX_SANDBOX_NETWORK_DISABLED: '1' }, selectTransport: async () => { throw dnsDown; } });
  assert.equal(startJson.probe.block_reason, 'codex_sandbox');
  assert.deepEqual(startJson.start_runbooks.blocking.map(item => item.id), ['network-codex-approval']);
  assert.match(startJson.start_runbooks.blocking[0].text, /Codex/);
  assert.deepEqual([startJson.sitemap_pages, startJson.question_candidates_input, startJson.fact_candidates], [null, [], []]);
  assert.deepEqual(fake.requests, []);
});

test('start runbooks follow the harness: cloud and unknown hosts get no local chrome line', async () => {
  const idsFor = async env => (await run(site({ '/': html(page('Home')) }), { env, findChrome: () => null, readGoogleKey: () => null }))
    .startJson.start_runbooks.improving.map(item => item.id);
  assert.deepEqual(await idsFor({ CLAUDECODE: '1' }), ['google-api-key', 'chrome-install', 'gsc-export']);
  assert.deepEqual(await idsFor({ CODEX_SANDBOX: 'seatbelt' }), ['google-api-key', 'chrome-install', 'gsc-export']);
  assert.deepEqual(await idsFor({ CLAUDE_CODE_REMOTE: 'true' }), ['google-api-key', 'gsc-export']);
  assert.deepEqual(await idsFor({}), ['google-api-key', 'gsc-export']);
});

test('question candidates and fact candidates come from the fetched pages', async () => {
  const fake = site({ '/': html(page('Brew Home', ['/about', '/menu.pdf'])), '/about': html(page('About Brew')), '/menu.pdf': { status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF') } });
  const { startJson } = await run(fake);
  assert.deepEqual(startJson.question_candidates_input.map(item => [item.url, item.title, item.description, item.h1]),
    [[`${origin}/`, 'Brew Home', 'About Brew Home', 'Brew Home heading'], [`${origin}/about`, 'About Brew', 'About About Brew', 'About Brew heading']]);
  const phones = startJson.fact_candidates.filter(fact => fact.key === 'phone');
  assert.deepEqual(phones, [{ key: 'phone', value: '02-555-0142', source_url: `${origin}/` }]);
  assert.ok(startJson.fact_candidates.some(fact => fact.key === 'address' && /Main Street/.test(fact.value)));
  assert.ok(startJson.fact_candidates.every(fact => fact.key && fact.value && fact.source_url));
});

test('start.json never holds the proxy authorization or the key', async () => {
  const proxy = Object.defineProperty({ host: 'proxy.local', port: 3128 }, 'authorization', { value: 'Basic c2VjcmV0', enumerable: false });
  const fake = site({ '/': html(page('Home')) });
  const selectTransport = async input => {
    const chosen = await fake.selectTransport(input);
    return { ...chosen, transport: Object.assign((...args) => chosen.transport(...args), { addressVetting: 'proxy' }), address_vetting: 'proxy', proxy };
  };
  const { out } = await run(fake, { selectTransport, readGoogleKey: () => 'AIza-secret-value' });
  const text = await readFile(path.join(out, 'preflight', 'start.json'), 'utf8');
  assert.doesNotMatch(text, /c2VjcmV0|AIza-secret-value|authorization/i);
  assert.match(text, /proxy\.local/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeEnvironment, runbookHarnesses } from '../skills/optbrew/scripts/core/probe.mjs';
import { validateEntity, ContractError } from '../skills/optbrew/scripts/core/contracts.mjs';
import { environmentProbe } from './support/probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const references = path.join(root, 'skills/optbrew/references');

const dnsDown = () => Object.assign(new Error('DNS lookup for example.test failed (ENOTFOUND) and no usable HTTPS_PROXY is set'),
  { code: 'dns_unresolvable', dns_code: 'ENOTFOUND' });
const direct = { transport: () => {}, resolve: async () => [], address_vetting: 'direct', proxy: null };
const deps = over => ({ env: {}, url: 'https://example.test/', selectTransport: async () => direct, findChrome: () => ({ path: '/usr/bin/chrome', kind: 'chrome' }),
  readGoogleKey: () => null, home: '/no/such/home', ...over });

test('classifies a blocked site behind a missing proxy', async () => {
  const blocked = { selectTransport: async () => { throw dnsDown(); } };
  const cases = [
    [{ CODEX_SANDBOX_NETWORK_DISABLED: '1' }, 'codex', 'codex_sandbox'],
    [{ CLAUDE_CODE_REMOTE: 'true', CLAUDECODE: '1' }, 'claude-code-cloud', 'cloud_network_level'],
    [{ CLAUDECODE: '1' }, 'claude-code', 'site_down'],
    [{}, 'other', 'site_down'],
    // Codex with network allowed sets no network-disabled variable, so a DNS failure there is the site, not the sandbox.
    [{ CODEX_SANDBOX: 'seatbelt' }, 'codex', 'site_down'],
  ];
  for (const [env, harness, reason] of cases) {
    const probe = await probeEnvironment(deps({ env, ...blocked }));
    assert.deepEqual([probe.harness, probe.block_reason, probe.transport, probe.address_vetting, probe.proxy], [harness, reason, null, null, null], JSON.stringify(env));
  }
});

test('a proxy that refuses the site is a network block; a direct failure is the site', async () => {
  const viaProxy = { ...direct, address_vetting: 'proxy', proxy: { host: 'proxy.local', port: 3128 } };
  const refused = Object.assign(new Error('proxy CONNECT refused with status 403 via proxy.local:3128'), { code: 'proxy_connect_refused' });
  const probe = await probeEnvironment(deps({ env: { CLAUDE_CODE_REMOTE: 'true' }, selectTransport: async () => viaProxy, reach: async () => { throw refused; } }));
  assert.deepEqual([probe.block_reason, probe.transport, probe.address_vetting, probe.proxy], ['cloud_network_level', 'proxy', 'proxy', { host: 'proxy.local', port: 3128 }]);
  const down = await probeEnvironment(deps({ env: { CLAUDE_CODE_REMOTE: 'true' }, reach: async () => { throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }); } }));
  assert.deepEqual([down.block_reason, down.transport], ['site_down', 'direct']);
  for (const code of ['scope_rejected', 'redirect_outside_scope']) {
    const rejected = await probeEnvironment(deps({ reach: async () => { throw Object.assign(new Error('refused'), { code }); } }));
    assert.deepEqual([rejected.block_reason, rejected.transport], [null, 'direct'], code);
  }
  const fine = await probeEnvironment(deps({ reach: async () => {} }));
  assert.equal(fine.block_reason, null);
});

test('unknown harness falls back to other', async () => {
  for (const env of [{}, { CLAUDECODE: '' }, { CODEX_HOME: '/x', ANTHROPIC_API_KEY: 'x' }]) assert.equal((await probeEnvironment(deps({ env }))).harness, 'other');
  assert.equal((await probeEnvironment(deps({ env: { CLAUDECODE: '1' } }))).harness, 'claude-code');
  assert.equal((await probeEnvironment(deps({ env: { CLAUDECODE: '1', CLAUDE_CODE_REMOTE: 'true' } }))).harness, 'claude-code-cloud');
  assert.equal((await probeEnvironment(deps({ env: { CODEX_SANDBOX: 'seatbelt' } }))).harness, 'codex');
});

test('the probe records chrome, key presence and source tools without secrets', async () => {
  const missing = await probeEnvironment(deps({ findChrome: () => null, readGoogleKey: () => 'AIza-secret-value', sourceTools: ['ripgrep', ' ripgrep ', 'graft', ''] }));
  assert.deepEqual(missing.chrome, { found: false, kind: null, reason: 'chrome_not_found' });
  assert.equal(missing.google_key, true);
  assert.deepEqual(missing.source_tools, ['ripgrep', 'graft']);
  assert.equal(missing.sitemap_pages, null);
  assert.doesNotMatch(JSON.stringify(missing), /AIza-secret-value/);
  const override = await probeEnvironment(deps({ findChrome: () => ({ path: null, kind: null, reason: 'optbrew_chrome_missing' }) }));
  assert.deepEqual(override.chrome, { found: false, kind: null, reason: 'optbrew_chrome_missing' });
  const found = await probeEnvironment(deps({ findChrome: () => ({ path: '/p', kind: 'chromium' }) }));
  assert.deepEqual(found.chrome, { found: true, kind: 'chromium', reason: null });
  assert.equal(found.google_key, false);
});

test('the probe keeps the proxy host and port but never its authorization', async () => {
  const proxy = Object.defineProperty({ host: 'proxy.local', port: 3128 }, 'authorization', { value: 'Basic c2VjcmV0', enumerable: false });
  const probe = await probeEnvironment(deps({ selectTransport: async () => ({ ...direct, address_vetting: 'proxy', proxy }) }));
  assert.deepEqual(probe.proxy, { host: 'proxy.local', port: 3128 });
  assert.equal(Object.hasOwn(probe.proxy, 'authorization'), false);
  assert.doesNotMatch(JSON.stringify(probe), /c2VjcmV0|authorization/i);
});

test('the probe passes the page host to transport selection and the env to chrome and key lookups', async () => {
  const seen = {};
  await probeEnvironment(deps({ env: { MARK: 'm' }, url: 'https://EXAMPLE.test:8443/x', home: '/h',
    selectTransport: async input => { seen.select = input; return direct; },
    findChrome: input => { seen.chrome = input; return null; }, readGoogleKey: input => { seen.key = input; return null; } }));
  assert.deepEqual(seen.select, { env: { MARK: 'm' }, probeHost: 'example.test' });
  assert.deepEqual(seen.chrome, { env: { MARK: 'm' } });
  assert.deepEqual(seen.key, { env: { MARK: 'm' }, home: '/h' });
});

test('runbook harness mapping covers every probe harness and every runbook value', async () => {
  const signals = JSON.parse(await readFile(path.join(references, 'harness-signals.json'), 'utf8'));
  const probeHarnesses = [...Object.keys(signals), 'other'];
  assert.deepEqual(probeHarnesses.toSorted(), ['claude-code', 'claude-code-cloud', 'codex', 'other']);
  assert.deepEqual(runbookHarnesses('other'), ['any', 'local']);
  for (const harness of probeHarnesses) assert.ok(runbookHarnesses(harness).includes('any'), harness);
  assert.deepEqual(runbookHarnesses('claude-code'), ['local', 'any']);
  assert.deepEqual(runbookHarnesses('codex'), ['local', 'codex', 'any']);
  assert.deepEqual(runbookHarnesses('claude-code-cloud'), ['claude-code-cloud', 'any']);
  assert.throws(() => runbookHarnesses('vim'), /unknown harness/);
  const reachable = new Set(probeHarnesses.flatMap(runbookHarnesses));
  const dir = path.join(references, 'runbooks');
  for (const name of (await readdir(dir)).filter(file => file.endsWith('.md'))) {
    const value = /^harness:\s*(\S+)/m.exec(await readFile(path.join(dir, name), 'utf8'))?.[1];
    assert.ok(reachable.has(value), `${name}: harness ${value} is reachable from a probe harness`);
  }
});

test('harness-signals names only environment variables', async () => {
  const signals = JSON.parse(await readFile(path.join(references, 'harness-signals.json'), 'utf8'));
  for (const [harness, entry] of Object.entries(signals)) {
    assert.ok(entry.env_any.length > 0, harness);
    for (const name of [...entry.env_any, ...(entry.network_blocked_env_any ?? [])]) assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${harness}: ${name}`);
  }
});

test('RunContext without environment_probe is rejected', async () => {
  const { run_context: context } = JSON.parse(await readFile(path.join(root, 'tests/fixtures/scoring/before.json'), 'utf8'));
  assert.equal(validateEntity('RunContext', context).run_id, 'synthetic-partial');
  const { environment_probe: _probe, ...without } = context;
  assert.throws(() => validateEntity('RunContext', without), error => error instanceof ContractError && /environment_probe/.test(error.message));
  for (const broken of [{ harness: 'vim' }, { block_reason: 'weather' }, { chrome: { found: 'yes', kind: null, reason: null } }, { google_key: 'true' }, { source_tools: 'a' }, { sitemap_pages: 1.5 }])
    assert.throws(() => validateEntity('RunContext', { ...context, environment_probe: environmentProbe(broken) }), ContractError, JSON.stringify(broken));
  assert.throws(() => validateEntity('RunContext', { ...context, environment_probe: environmentProbe({ proxy: { host: 'p', port: 1, authorization: 'Basic x' } }) }), /authorization/);
});

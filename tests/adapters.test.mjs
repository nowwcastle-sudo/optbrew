import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requestAnthropic } from '../skills/optbrew/scripts/adapters/anthropic.mjs';
import { runAudit } from '../skills/optbrew/scripts/audit.mjs';

async function ledger() {
  const dir = await mkdtemp(path.join(tmpdir(), 'optbrew-adapter-'));
  const file = path.join(dir, 'ledger.json');
  await writeFile(file, JSON.stringify({ schema_version: '1.0.0', run_id: 'test', budgets: [{ provider: 'anthropic', unit: 'tokens', amount: 20 }], reservations: [], settlements: [], approval_ref: 'approved/test', source_ref: 'test' }));
  return { dir, file };
}
const request = { model: 'user-selected-model', max_tokens: 4, messages: [{ role: 'user', content: 'test' }] };
const context = { run_id: 'test', cost_decision: { approval_ref: 'approved/test', providers: { anthropic: { upper_bounds: [{ unit: 'tokens', amount: 6 }] } } } };

test('no price decision or API key means zero provider calls', async () => {
  const { file } = await ledger(); let calls = 0;
  const transport = async () => { calls++; throw new Error('called'); };
  for (const [ctx, env] of [[{ run_id: 'test', cost_decision: {} }, { ANTHROPIC_API_KEY: 'test-secret' }], [context, {}]]) {
    const result = await requestAnthropic({ context: ctx, request, env, transport, ledgerPath: file });
    assert.equal(result.valid, false);
  }
  assert.equal(calls, 0);
});

test('provider cannot charge a ledger from another run', async () => {
  const { file } = await ledger(); let calls = 0;
  const result = await requestAnthropic({ context: { ...context, run_id: 'different' }, request,
    env: { ANTHROPIC_API_KEY: 'test-secret' }, ledgerPath: file, transport: async () => { calls++; return { status: 200, body: '{}' }; } });
  assert.equal(calls, 0);
  assert.equal(result.error, 'cost_reservation_failed');
});

test('timeout reserves unknown cost, and transport error never exposes key', async () => {
  const { file } = await ledger();
  const key = 'test-secret-value';
  const result = await requestAnthropic({ context, request, env: { ANTHROPIC_API_KEY: key }, ledgerPath: file, transport: async () => { throw new Error(key); } });
  assert.equal(result.valid, false);
  assert.equal(result.error.includes(key), false);
  const saved = await readFile(file, 'utf8');
  assert.equal(saved.includes(key), false);
  assert.ok(JSON.parse(saved).reservations.some(x => x.status === 'unknown'));
});

test('403 stops once; 429 retry reserves both attempts; malformed JSON remains unknown', async () => {
  const key = 'secret-is-never-an-error';
  const denied = await ledger(); let calls = 0;
  const forbidden = await requestAnthropic({ context, request, env: { ANTHROPIC_API_KEY: key }, ledgerPath: denied.file,
    transport: async () => { calls++; return { status: 403, body: JSON.stringify({ error: { message: key } }) }; } });
  assert.equal(calls, 1);
  assert.equal(forbidden.error.includes(key), false);
  const limited = await ledger(); calls = 0;
  const rate = await requestAnthropic({ context, request, env: { ANTHROPIC_API_KEY: key }, ledgerPath: limited.file,
    transport: async () => { calls++; return { status: 429, body: '{}' }; } });
  assert.equal(calls, 2);
  assert.equal(rate.valid, false);
  assert.equal(JSON.parse(await readFile(limited.file, 'utf8')).reservations.length, 2);
  const broken = await ledger();
  const malformed = await requestAnthropic({ context, request, env: { ANTHROPIC_API_KEY: key }, ledgerPath: broken.file,
    transport: async () => ({ status: 200, body: '{bad' }) });
  assert.equal(malformed.valid, false);
  assert.equal(JSON.parse(await readFile(broken.file, 'utf8')).reservations[0].status, 'unknown');
});

test('successful selected model stores a redacted provider response and settles usage', async () => {
  const { file } = await ledger();
  const key = 'never-save-this-key';
  const result = await requestAnthropic({ context, request, env: { ANTHROPIC_API_KEY: key }, ledgerPath: file,
    transport: async ({ body, headers }) => {
      assert.equal(JSON.parse(body).model, 'user-selected-model');
      assert.equal(headers['x-api-key'], key);
      return { status: 200, body: JSON.stringify({ type: 'message', id: 'msg_test', content: [{ type: 'text', text: key }], usage: { input_tokens: 1, output_tokens: 2 } }) };
    } });
  assert.equal(result.valid, true);
  assert.equal(result.usage.input_tokens, 1);
  assert.equal((await readFile(result.response_ref, 'utf8')).includes(key), false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).reservations[0].status, 'settled');
});

test('offline audit retains raw JSON-LD evidence without claiming missing structured data', async () => {
  const { dir } = await ledger();
  const url = 'https://example.test/owned/a';
  const full = { schema_version: '1.0.0', run_id: 'audit', target: 'example.test', environment: 'local', goals: [], allowed_changes: [], scope: { allowed: [{ origin: 'https://example.test', path_prefix: '/owned/' }] }, protocol: { page_types: [{ id: 'main', urls: [{ original: url, normalized: url }] }], engines: ['naver'], families: [], locale: 'ko-KR', region: 'KR', browser: 'Chrome', device: 'desktop', question_panel: [], surfaces: [], models: [], search_enabled: null }, evaluation_version: '0.1.0', protocol_version: '0.1.0', data_sources: [], cost_decision: {}, evidence_ref: 'test/context' };
  const html = '<html><head><title>Test</title><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script></head><body>Acme</body></html>';
  const result = await runAudit({ context: full, modules: ['naver-searchadvisor', 'magnus-seo'], outputDir: dir, transport: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) }), resolve: async () => ['93.184.215.14'] });
  assert.equal(result.artifacts[0].status, 200);
  assert.ok(result.module_outputs['magnus-seo'][0].jsonld_types.includes('Organization'));
  assert.equal(result.observations.some(x => x.family_id === 'structured-data-truth' && x.state === 'fail'), false);
  assert.ok(await readFile(path.join(dir, 'evidence', 'collection.json'), 'utf8'));
});

test('selected unit observations bind to stored response evidence and engine URL keys', async () => {
  const { dir } = await ledger();
  const origin = 'https://example.test';
  const urls = [`${origin}/robots.txt`, `${origin}/page`];
  const full = { schema_version: '1.0.0', run_id: 'bound-units', target: 'example.test', environment: 'local', goals: [], allowed_changes: [],
    scope: { allowed: [{ origin, path_prefix: '/' }] }, protocol: { page_types: [{ id: 'main', urls: urls.map(url => ({ original: url, normalized: url })) }],
      engines: ['naver'], families: ['fetch-response', 'document-title', 'index-policy', 'search-crawl-policy'].map(family_id => ({ family_id, applicable: true })),
      locale: 'ko-KR', region: 'KR', browser: 'Chrome', device: 'desktop', question_panel: [], surfaces: [], models: [], search_enabled: null },
    evaluation_version: '0.1.0', protocol_version: '0.1.0', data_sources: [], cost_decision: {}, evidence_ref: 'test/context' };
  const result = await runAudit({ context: full, modules: ['naver-searchadvisor'], outputDir: dir, resolve: async () => ['93.184.215.14'],
    transport: async ({ url }) => url.pathname === '/robots.txt' ?
      { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: Yeti\nDisallow: /page\n') } :
      { status: 200, headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' }, body: Buffer.from('<html><head></head><body>Page</body></html>') } });
  const key = `search-crawl-policy|naver|${urls[1]}`;
  assert.equal(result.observations.find(x => x.unit_key === key)?.state, 'fail');
  assert.equal(result.observations.find(x => x.unit_key === `index-policy|${urls[1]}`)?.state, 'fail');
  assert.equal(result.observations.find(x => x.unit_key === `document-title|${urls[1]}`)?.state, 'fail');
  const index = JSON.parse(await readFile(result.evidence_ref, 'utf8'));
  assert.equal(index.run_id, 'bound-units');
  assert.equal(index.raw.length, 2);
  assert.ok(result.observations.every(x => x.evidence_ref && index.raw.some(y => y.evidence_ref === x.evidence_ref)));
});

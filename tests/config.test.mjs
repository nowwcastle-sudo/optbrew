import test from 'node:test';
import assert from 'node:assert/strict';
import { endpoints, limits, versions } from '../skills/optbrew/scripts/core/config.mjs';

test('limits hold the collection bounds', () => {
  assert.deepEqual(limits(), { max_urls_default: 50, max_urls_cap: 200, max_depth: 3, concurrency: 2,
    timeout_ms: 20000, max_bytes: 5242880, max_redirects: 10 });
});

test('versions hold today\'s release, evaluation, protocol and schema versions', () => {
  assert.deepEqual(versions(), { release: '0.1.4', evaluation: '0.3.0', protocol: '0.1.0', contract_schema: '1.0.0',
    install_record_schema: '1.0.0', bundle_manifest_schema: '1.0.0', evidence_record: '1' });
});

test('endpoints hold every URL the product code uses', () => {
  assert.deepEqual(endpoints(), { anthropic_messages: 'https://api.anthropic.com/v1/messages',
    npm_registry: 'https://registry.npmjs.org/', naver_guide: 'https://searchadvisor.naver.com/guide/',
    plugin_schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', relative_url_base: 'http://path.invalid' });
});

test('blocks are frozen and cached', () => {
  for (const block of [limits, versions, endpoints]) {
    assert.equal(block(), block());
    assert.ok(Object.isFrozen(block()));
    assert.throws(() => { block().extra = 1; }, TypeError);
  }
});

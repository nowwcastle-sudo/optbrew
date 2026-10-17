import test from 'node:test';
import assert from 'node:assert/strict';
import { chromePaths, endpoints, limits, versions } from '../skills/optbrew/scripts/core/config.mjs';

test('limits hold the collection bounds', () => {
  assert.deepEqual(limits(), { max_urls_default: 50, max_urls_cap: 200, max_depth: 3, concurrency: 2,
    timeout_ms: 20000, max_bytes: 5242880, max_redirects: 10, judge_spans_per_unit: 30, judge_span_min_bytes: 40, chrome_launch_timeout_ms: 30000, chrome_close_grace_ms: 5000,
    cdp_command_timeout_ms: 30000, render_pages: 10, render_static_concurrency: 4, max_render_requests: 300, psi_attempts: 1, cwv_timeout_ms: 60000, cwv_max_bytes: 10485760, preflight_pages: 10 });
});

test('versions hold today\'s release, evaluation, protocol and schema versions', () => {
  assert.deepEqual(versions(), { release: '0.2.0', evaluation: '0.4.0', protocol: '0.2.0', contract_schema: '2.0.0',
    install_record_schema: '1.0.0', bundle_manifest_schema: '1.0.0', evidence_record: '1' });
});

test('endpoints hold every URL the product code uses', () => {
  assert.deepEqual(endpoints(), { anthropic_messages: 'https://api.anthropic.com/v1/messages', anthropic_version: '2023-06-01',
    npm_registry: 'https://registry.npmjs.org/', naver_guide: 'https://searchadvisor.naver.com/guide/',
    plugin_schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', crux: 'https://chromeuxreport.googleapis.com/v1/records:queryRecord',
    psi: 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&category=performance', relative_url_base: 'http://path.invalid' });
});

test('chrome paths list the platforms, PATH names and the Playwright layout', () => {
  const paths = chromePaths();
  assert.deepEqual(Object.keys(paths), ['win32', 'darwin', 'linux', 'path_names', 'playwright_chromium']);
  assert.ok(paths.win32.every(entry => entry.path.startsWith('%') && ['chrome', 'edge'].includes(entry.kind)));
  assert.ok(paths.path_names.some(entry => entry.name === 'msedge' && entry.kind === 'edge'));
});

test('blocks are frozen and cached', () => {
  for (const block of [limits, versions, endpoints, chromePaths]) {
    assert.equal(block(), block());
    assert.ok(Object.isFrozen(block()));
    assert.throws(() => { block().extra = 1; }, TypeError);
  }
});

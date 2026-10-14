import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCapabilities } from '../skills/optbrew/scripts/core/capabilities.mjs';

test('raw HTML wins over Markdown for JSON-LD and unsafe bulk crawl is unavailable', () => {
  const plan = selectCapabilities([
    { capability: 'raw_html', provider: 'collector', tool_ref: 'local', bounded: true, cost_enforcement: 'code' },
    { capability: 'markdown', provider: 'firecrawl', tool_ref: 'mcp', bounded: true, cost_enforcement: 'host_policy' },
    { capability: 'bulk_crawl', provider: 'firecrawl', tool_ref: 'mcp', bounded: false, cost_enforcement: 'host_policy' }
  ], ['structured_data', 'bulk_crawl']);
  assert.equal(plan.selected[0].capability, 'raw_html');
  assert.deepEqual(plan.missing, ['bulk_crawl']);
  assert.ok(plan.limitations.some(x => x.includes('host_policy')));
});

test('Markdown alone cannot establish structured-data truth', () => {
  const plan = selectCapabilities([{ capability: 'markdown', provider: 'firecrawl', tool_ref: 'mcp', bounded: true, cost_enforcement: 'host_policy' }], ['structured_data']);
  assert.deepEqual(plan.missing, ['structured_data']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeFindings, selectRemediations } from '../skills/optbrew/scripts/core/findings.mjs';

const finding = (source_ref, evidence_ref) => ({ schema_version: '2.0.0', finding_id: source_ref,
  check_id: 'index-policy', unit_key: 'index-policy|https://example.com/', priority: 'P0', blocker: true,
  message: 'Unexpected noindex', source_ref, evidence_ref, remediation_ids: [], status: 'confirmed' });

test('duplicate module findings retain two provenance records and blocker priority', () => {
  const merged = mergeFindings([finding('module:a', 'e/a'), finding('module:b', 'e/b')]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].priority, 'P0');
  assert.deepEqual(merged[0].sources.map(x => x.source_ref), ['module:a', 'module:b']);
});

test('remediation requires an applicable mechanism, authority and evidence-ranked source', () => {
  const options = selectRemediations(finding('module:a', 'e/a'), { context: { environment: 'remote' },
    capabilities: { selected: [], missing: [], limitations: [] }, catalog: [
      { remediation_id: 'copy', check_id: 'index-policy', applies_when: { states: ['fail'] },
        evidence_tier: 'hypothesis', source_url: 'https://example.com/', checked_date: '2026-10-14',
        module_ref: 'module:a', mechanism: 'Change hero copy', validation: 'Read copy', effort: 'small', cost: 'unknown', required_authority: 'edit' },
      { remediation_id: 'robots', check_id: 'index-policy', applies_when: { states: ['fail'] },
        evidence_tier: 'official', source_url: 'https://developers.google.com/search/docs/crawling-indexing/block-indexing',
        checked_date: '2026-10-14', module_ref: 'module:a', mechanism: 'Remove unintended noindex',
        validation: 'Fetch response and inspect robots directives', effort: 'small', cost: 'unknown', required_authority: 'owner_edit' },
    ] });
  assert.deepEqual(options.filter(x => x.selected).map(x => x.remediation_id), ['robots']);
});

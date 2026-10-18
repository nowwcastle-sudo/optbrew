import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { score } from '../../../skills/optbrew/scripts/core/score.mjs';
import { compare } from '../../../skills/optbrew/scripts/core/compare.mjs';
import { freezeProtocol } from '../../../skills/optbrew/scripts/core/protocol.mjs';

const input = JSON.parse(readFileSync(new URL('../scoring/before.json', import.meta.url)));
input.run_context.run_id = 'synthetic-report';
input.run_context.evidence_ref = 'context.json';
for (const family of input.run_context.protocol.families)
  if (family.applicability_decision) family.applicability_decision.evidence_ref = 'intake.json';
input.observations[0].evidence_ref = 'raw.html';
input.observations.push({ schema_version: '2.0.0', observation_id: 'noindex', check_id: 'index-policy',
  family_id: 'index-policy', unit_key: 'index-policy|https://example.com/', state: 'fail', q: 0,
  partial_basis: null, reason: 'Unexpected | noindex <tag>\nfrom raw HTML', evaluator_type: 'code',
  source_ref: 'synthetic', evidence_ref: 'raw.html' });
const finding = (id, ref) => ({ schema_version: '2.0.0', finding_id: id, check_id: 'index-policy',
  unit_key: 'index-policy|https://example.com/', priority: 'P0', blocker: true,
  message: 'Unexpected | noindex <tag>\nfrom raw HTML', source_ref: id, evidence_ref: ref,
  remediation_ids: ['remove-unintended-noindex'], status: 'confirmed' });
const files = {
  'context.json': `${JSON.stringify(input.run_context, null, 2)}\n`,
  'intake.json': `${JSON.stringify({ run_id: 'synthetic-report', target: input.run_context.target,
    protocol_hash: freezeProtocol(input.run_context).protocol_hash, approved_by: 'synthetic-fixture',
    decisions: input.run_context.protocol.families.filter(x => x.applicability_decision).map(x => ({ scope: 'family',
      family_id: x.family_id, condition: x.applicability_decision.condition, reason: x.applicability_decision.reason })) }, null, 2)}\n`,
  'raw.html': '<!doctype html><html><head><meta name="robots" content="noindex"><title>Example</title></head><body>Synthetic</body></html>\n',
  'module-a.html': '<!doctype html><html><head><meta name="robots" content="noindex"></head></html>\n',
  'module-b.html': '<!doctype html><html><head><meta name="robots" content="noindex"></head></html>\n',
};
const costs = { schema_version: '2.0.0', run_id: 'synthetic-report', budgets: [], reservations: [], settlements: [],
  approval_ref: null, source_ref: 'synthetic', evidence_ref: 'cost-ledger.json' };
files['cost-ledger.json'] = `${JSON.stringify(costs, null, 2)}\n`;
for (const [name, content] of Object.entries(files)) writeFileSync(new URL(name, import.meta.url), content);
const evidence_index = Object.entries(files).map(([ref, text]) => ({ ref,
  sha256: createHash('sha256').update(text).digest('hex'), kind: ref === 'context.json' ? 'context' :
    ref === 'intake.json' ? 'intake' : 'raw_html', run_id: 'synthetic-report',
  ...(ref.endsWith('.html') ? { source_ref: ref === 'raw.html' ? 'synthetic' : ref === 'module-a.html' ? 'module:a' : 'module:b' } : {}) }));
const packet = { schema_version: '2.0.0', run_context: input.run_context,
  baseline: { input, scores: score(input) }, after: null, comparison: compare(input, null), metrics: [],
  findings: [finding('module:a', 'module-a.html'), finding('module:b', 'module-b.html')], changes: [],
  costs,
  capabilities: { selected: [{ capability: 'search', provider: 'host', tool_ref: 'synthetic', cost_enforcement: 'host_policy' }],
    missing: ['provider_api'], limitations: ['not_connected'] },
  remaining: [{ problem: 'No deployed change', reason: 'remote_only', required_input_or_authority: 'site owner edit',
    next_action: 'Remove unintended noindex in template or response header', reobserve_when: 'after owner deployment and raw response fetch' }],
  evidence_root: '.', evidence_index, source_ref: 'synthetic', data_class: 'synthetic' };
writeFileSync(new URL('remote-only.json', import.meta.url), `${JSON.stringify(packet, null, 2)}\n`);

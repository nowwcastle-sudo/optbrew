import { ContractError, validateEntity } from './contracts.mjs';

const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
const evidenceRank = { official: 0, reproduced: 1, research: 2, case: 3, hypothesis: 4 };

/** The text two findings must share, ignoring case and spacing, to be the same issue. */
export const messageKey = message => message.trim().replace(/\s+/g, ' ').toLowerCase();

/** A finding's text with its own unit's page address replaced, so the same problem on two pages reads the same. */
export const pageNeutral = (text, unitKey) => {
  const page = unitKey.split('|').at(-1);
  // Only a page address is replaced: the unit of a site-level check ends in a word such as "site", which is just text.
  return /^https?:\/\//.test(page) ? text.split(page).join('{page}') : text;
};

/**
 * The distinct problems one failed verdict states. A check that finds several fixed-sentence problems on one page joins them in
 * its reason and lists them in `measurement.problems`; each is its own fix. Any other verdict states one problem, its reason.
 */
export const problemsOf = observation => observation.measurement?.problems ?? [observation.reason];

/** Merge the same check, unit and issue while preserving every module source. */
export function mergeFindings(findings) {
  if (!Array.isArray(findings)) throw new ContractError('findings must be an array');
  const byIssue = new Map();
  for (const item of [...findings].sort((a, b) => String(a.finding_id).localeCompare(String(b.finding_id)))) {
    validateEntity('Finding', item);
    if (item.check_id !== item.unit_key.split('|')[0] || !Object.hasOwn(rank, item.priority))
      throw new ContractError('finding check or priority invalid');
    const key = `${item.check_id}\0${item.unit_key}\0${messageKey(item.message)}`;
    const source = { source_ref: item.source_ref, evidence_ref: item.evidence_ref };
    if (!byIssue.has(key)) byIssue.set(key, { ...item, priority: item.blocker ? 'P0' : item.priority,
      finding_ids: [item.finding_id], sources: [source] });
    else {
      const existing = byIssue.get(key);
      if (!existing.sources.some(x => x.source_ref === source.source_ref && x.evidence_ref === source.evidence_ref))
        existing.sources.push(source);
      if (rank[item.priority] < rank[existing.priority]) existing.priority = item.priority;
      existing.blocker ||= item.blocker;
      if (existing.blocker) existing.priority = 'P0';
      existing.finding_ids = [...new Set([...existing.finding_ids, item.finding_id])];
      // A finding that names several pages keeps all of them when two sources of the same issue are merged.
      if (existing.unit_keys || item.unit_keys) existing.unit_keys = [...new Set([...(existing.unit_keys ?? [existing.unit_key]), ...(item.unit_keys ?? [item.unit_key])])];
      existing.remediation_ids = [...new Set([...existing.remediation_ids, ...item.remediation_ids])];
    }
  }
  return [...byIssue.values()].map(item => ({ ...item, sources: item.sources.sort((a, b) =>
    a.source_ref.localeCompare(b.source_ref) || a.evidence_ref.localeCompare(b.evidence_ref)) }))
    .sort((a, b) => rank[a.priority] - rank[b.priority] || a.unit_key.localeCompare(b.unit_key));
}

/** Select only a directly applicable mechanism, ordered by evidence class. */
export function selectRemediations(finding, { context, capabilities, catalog }) {
  validateEntity('Finding', finding);
  if (!context || !capabilities || !Array.isArray(catalog)) throw new ContractError('remediation context, capabilities and catalog required');
  const options = catalog.filter(item => item.check_id === finding.check_id).map(item => {
    if (!item.remediation_id || !item.source_url || !item.checked_date || !item.module_ref || !item.mechanism ||
        !item.validation || !item.effort || !item.cost || !item.required_authority || !Object.hasOwn(evidenceRank, item.evidence_tier))
      throw new ContractError('remediation catalog entry incomplete');
    const applicable = (item.applies_when?.states ?? ['fail']).includes(finding.status === 'unknown' ? 'unknown' : 'fail') &&
      (!item.applies_when?.environments || item.applies_when.environments.includes(context.environment)) &&
      (!item.applies_when?.capability || capabilities.selected.some(x => x.capability === item.applies_when.capability));
    return { remediation_id: item.remediation_id, check_id: finding.check_id, selected: applicable,
      reason: applicable ? `${item.evidence_tier}: ${item.mechanism}` : 'condition or capability not met',
      source_ref: item.source_url, source_url: item.source_url, checked_date: item.checked_date,
      evidence_tier: item.evidence_tier, module_ref: item.module_ref, mechanism: item.mechanism,
      validation: item.validation, effort: item.effort, cost: item.cost, required_authority: item.required_authority,
      location_hint: item.location_hint ?? null };
  }).sort((a, b) => evidenceRank[a.evidence_tier] - evidenceRank[b.evidence_tier]);
  const best = options.find(x => x.selected);
  return options.map(x => ({ ...x, selected: x === best, reason: x === best ? x.reason : 'less direct or inapplicable' }));
}

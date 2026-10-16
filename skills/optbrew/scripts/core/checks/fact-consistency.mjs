import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'fact-consistency';

/** Contact facts compared across pages. Agreement is consistency, not accuracy, and a branch page is never compared. */
export const factConsistency = {
  family_id: FAMILY,
  derive({ facts, comparison }) {
    const out = [];
    for (const page of facts) {
      if (comparison.separate.has(page.url)) continue;
      const found = comparison.deviations.get(page.url) ?? [];
      const comparable = Object.keys(comparison.references).some(type => page.facts.visible[type].size || page.facts.linked[type].size || (type === 'phone' && page.facts.tel.phone.size));
      const observe = (state, reason) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, page.url), state, reason,
        evidence_ref: page.row.artifact.evidence_ref }));
      if (found.length) observe('fail', `Cross-page fact comparison (no approved fact list): ${found.join('; ')}`);
      else if (comparable) observe('pass', 'Facts on this page match the cross-page reference values (no approved fact list; consistency is not accuracy)');
    }
    return out;
  },
};

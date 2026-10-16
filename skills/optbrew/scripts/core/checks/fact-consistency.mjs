import { FACT_MESSAGE_KEYS } from '../facts.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'fact-consistency';
const PREFIX = 'Cross-page fact comparison (no approved fact list): ';

/** Contact facts compared across pages. Agreement is consistency, not accuracy, and a branch page is never compared. */
export const factConsistency = {
  family_id: FAMILY,
  message_keys: Object.values(FACT_MESSAGE_KEYS),
  derive({ facts, comparison }) {
    const out = [];
    for (const page of facts) {
      if (comparison.separate.has(page.url)) continue;
      const found = comparison.deviations.get(page.url) ?? [];
      const stated = comparison.deviation_messages.get(page.url) ?? [];
      const comparable = Object.keys(comparison.references).some(type => page.facts.visible[type].size || page.facts.linked[type].size || (type === 'phone' && page.facts.tel.phone.size));
      const observe = (state, judged) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, page.url), state, evidence_ref: page.row.artifact.evidence_ref, ...judged }));
      // Each conflict is its own problem: the values are the problem itself (R63), so a page with two conflicts has two fixes.
      if (found.length) observe('fail', { problems: found.map((text, index) => problem(`${PREFIX}${text}`, stated[index].message_key, stated[index].message_values)) });
      else if (comparable) observe('pass', { reason: 'Facts on this page match the cross-page reference values (no approved fact list; consistency is not accuracy)' });
    }
    return out;
  },
};

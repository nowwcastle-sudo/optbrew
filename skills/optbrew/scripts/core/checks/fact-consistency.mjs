import { FACT_MESSAGE_KEYS } from '../facts.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'fact-consistency';
const PREFIX = 'Cross-page fact comparison (no approved fact list): ';
const NO_FACTS = 'The page has no labelled, marked-up or tel: contact fact (name, phone number, address, founding year) that this check can compare';

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
      // A page that states no contact fact has nothing to compare. A page that states one but has no reference to meet stays unknown:
      // a missing reference is a missing fact list, not an inapplicable page.
      const stating = Object.keys(page.facts.visible).some(type => page.facts.visible[type].size || page.facts.linked[type].size) || page.facts.tel.phone.size > 0;
      const observe = (state, judged) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, page.url), state, evidence_ref: page.row.artifact.evidence_ref, ...judged }));
      // Each conflict is its own problem: the values are the problem itself (R63), so a page with two conflicts has two fixes.
      if (found.length) observe('fail', { problems: found.map((text, index) => problem(`${PREFIX}${text}`, stated[index].message_key, stated[index].message_values)) });
      else if (comparable) observe('pass', { reason: 'Facts on this page match the cross-page reference values (no approved fact list; consistency is not accuracy)' });
      else if (!stating) observe('not_applicable', { reason: NO_FACTS, extra: { measurement: { facts_found: 0 },
        applicability_decision: { condition: 'no_evaluable_facts', reason: NO_FACTS, evidence_ref: page.row.artifact.evidence_ref } } });
    }
    return out;
  },
};

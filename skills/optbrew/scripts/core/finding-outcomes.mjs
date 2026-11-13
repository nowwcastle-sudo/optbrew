import { findingGroups } from './findings.mjs';
import { runUnits } from './unit-transitions.mjs';

/** Failed verdicts that a later run still shows as not passing. A `partial` is better than a fail, and it is still open. */
const OPEN_STATES = new Set(['fail', 'partial']);

/** The reasons that only say the units differ. Any other reason means the runs were made under other conditions, so a pass proves nothing. */
const UNIT_REASONS = new Set(['page_types_changed', 'applicable_units_changed']);

/** Whether a later run's verdicts may answer for the earlier run's fixes: the same conditions, or only a change in which units apply. */
export const outcomesAllowed = result => result.status === 'comparable' ||
  (result.status === 'not_comparable' && result.reasons.length > 0 && result.reasons.every(reason => UNIT_REASONS.has(reason)));

/**
 * What the later run says about each fix the earlier run listed (`fixIds`, the finding ids of its fixes.md). A fix is `resolved` when
 * every unit it named passes in the later run, `remaining` when one of them still fails or is partial, and `unknown` otherwise:
 * a unit the later run does not score (its page left the audit, its verdict is now not applicable), a unit with no verdict, or an id the
 * earlier run has no failed verdict for.
 */
export function findingOutcomes(before, after, fixIds) {
  const later = runUnits(after);
  const groups = new Map(findingGroups(before.observations).map(group => [group.finding_id, group]));
  return fixIds.map(finding_id => {
    const units = (groups.get(finding_id)?.unit_keys ?? []).map(unit_key => ({ unit_key, after: later.get(unit_key)?.state ?? null }));
    const open = units.some(unit => OPEN_STATES.has(unit.after));
    const outcome = open ? 'remaining' : units.length && units.every(unit => unit.after === 'pass') ? 'resolved' : 'unknown';
    return { finding_id, outcome, units };
  });
}

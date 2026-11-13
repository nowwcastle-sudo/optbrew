import { compileUnits, scoreWeighted } from './weights.mjs';

const byKey = (a, b) => a.unit_key < b.unit_key ? -1 : a.unit_key > b.unit_key ? 1 : 0;

/** The first observation of each unit names who judged it; a unit nobody observed has no evaluator. */
const evaluatorByUnit = input => {
  const result = new Map();
  for (const obs of input.observations) if (!result.has(obs.unit_key)) result.set(obs.unit_key, obs.evaluator_type);
  return result;
};

/** The units one run scores (the not-applicable ones are not among them) with their state and evaluator, by unit key. */
export function runUnits(input) {
  const evaluator = evaluatorByUnit(input);
  return new Map(compileUnits(input, 'SEO').map(unit => [unit.key,
    { unit_key: unit.key, family_id: unit.family_id, evaluator_type: evaluator.get(unit.key) ?? null, state: unit.state }]));
}

/**
 * How the units moved between two runs, whether or not the runs can be scored against each other. A unit in both runs that kept its
 * state is only counted; one that changed state is listed with both states, so a fix that turned a fail into a pass shows even when
 * the fix also changed which units apply. A unit in one run only (a page that became a public index target, a verdict that was not
 * applicable and is now a verdict or unknown) is listed with its state and who judged it. Nothing here is a score.
 */
export function unitTransitions(before, after) {
  const left = runUnits(before), right = runUnits(after);
  const changed = [], only_before = [], only_after = [];
  let unchanged = 0;
  for (const [key, unit] of left) {
    const next = right.get(key);
    if (!next) only_before.push({ unit_key: key, family_id: unit.family_id, evaluator_type: unit.evaluator_type, state: unit.state });
    else if (next.state === unit.state) unchanged += 1;
    else changed.push({ unit_key: key, family_id: unit.family_id, evaluator_type: next.evaluator_type ?? unit.evaluator_type,
      before: unit.state, after: next.state });
  }
  for (const [key, unit] of right) if (!left.has(key))
    only_after.push({ unit_key: key, family_id: unit.family_id, evaluator_type: unit.evaluator_type, state: unit.state });
  return { changed: changed.sort(byKey), unchanged, only_before: only_before.sort(byKey), only_after: only_after.sort(byKey) };
}

/** The measured and passing weight (`M`, `N`) of one profile's units, by who judged them; a unit nobody observed is not attributed. */
export function weightByEvaluator(input, profile) {
  const evaluator = evaluatorByUnit(input);
  const groups = new Map();
  for (const unit of compileUnits(input, profile)) {
    const type = evaluator.get(unit.key);
    if (type) groups.set(type, [...(groups.get(type) ?? []), unit]);
  }
  return new Map([...groups].map(([type, units]) => [type, scoreWeighted(units)]));
}

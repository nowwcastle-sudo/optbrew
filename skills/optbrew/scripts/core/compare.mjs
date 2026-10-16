import { validateEntity } from './contracts.mjs';
import { freezeProtocol } from './protocol.mjs';
import { compileUnits } from './weights.mjs';
import { score } from './score.mjs';

const close = (a, b) => Math.abs(a - b) <= 1e-9;
const rawScore = result => result.M === 0 ? null : 100 * result.N / result.M;
const rawCoverage = result => result.A === 0 ? null : 100 * result.M / result.A;
const difference = (before, after) => before === null || after === null ? null : after - before;
const relative = (before, after) => before === null || after === null || close(before, 0) ? null : (after - before) / before;

/**
 * An input made before the render stage has no `protocol.render`. It was a valid input then, so it is reported as not
 * comparable in plain words instead of failing the schema. Checked before validation, by the shape the older protocol lacked.
 */
const olderProtocol = (input, label) => {
  const protocol = input?.run_context?.protocol;
  if (protocol === null || typeof protocol !== 'object' || Object.hasOwn(protocol, 'render')) return null;
  return `the ${label} was made with audit protocol ${input.run_context.protocol_version ?? 'unknown'}, which is older than the current one; run a new audit to compare`;
};

/** Compare two ScoreInputs only when their frozen conditions and applicable units match. */
export function compare(before, after) {
  const oldBaseline = olderProtocol(before, 'baseline');
  if (oldBaseline) return { status: 'not_comparable', score_deltas: [], reasons: [oldBaseline] };
  validateEntity('ScoreInput', before);
  const baseline = freezeProtocol(before.run_context);
  if (after === null || after === undefined) return { status: 'no_after', score_deltas: [], reasons: ['after_missing'] };
  const oldFollowup = olderProtocol(after, 'follow-up');
  if (oldFollowup) return { status: 'not_comparable', score_deltas: [], reasons: [oldFollowup] };
  validateEntity('ScoreInput', after);
  const followup = freezeProtocol(after.run_context);
  const reasons = [];
  if (baseline.protocol_hash !== followup.protocol_hash) {
    for (const field of ['target', 'environment', 'evaluation_version', 'protocol_version'])
      if (JSON.stringify(baseline.protocol[field]) !== JSON.stringify(followup.protocol[field])) reasons.push(`${field}_changed`);
    for (const field of ['page_types', 'engines', 'families', 'locale', 'region', 'browser', 'device',
      'question_panel', 'surfaces', 'models', 'search_enabled', 'target_identity'])
      if (JSON.stringify(baseline.protocol[field]) !== JSON.stringify(followup.protocol[field])) reasons.push(`${field}_changed`);
    if (!reasons.length) reasons.push('protocol_changed');
  }
  if (reasons.length) return { status: 'not_comparable', score_deltas: [], reasons: [...new Set(reasons)] };
  // The protocol fixes planned units. Evidence-backed N/A can still change the actual denominator.
  const unitSignature = input => compileUnits(input, 'SEO').map(unit => [unit.key, unit.weight]).sort((a, b) => a[0].localeCompare(b[0]));
  const leftUnits = unitSignature(before), rightUnits = unitSignature(after);
  if (leftUnits.length !== rightUnits.length || leftUnits.some(([key, weight], i) =>
    key !== rightUnits[i][0] || !close(weight, rightUnits[i][1]))) reasons.push('applicable_units_changed');
  if (reasons.length) return { status: 'not_comparable', score_deltas: [], reasons: [...new Set(reasons)] };
  const left = score(before), right = score(after);
  const score_deltas = left.map((item, i) => {
    const next = right[i];
    const oldScore = rawScore(item), newScore = rawScore(next);
    return { profile: item.profile, before: oldScore, after: newScore,
      raw_difference: difference(oldScore, newScore),
      percentage_point_delta: difference(oldScore, newScore),
      relative_change: relative(oldScore, newScore),
      coverage_percentage_point_delta: difference(rawCoverage(item), rawCoverage(next)),
      A_delta: next.A - item.A, M_delta: next.M - item.M, N_delta: next.N - item.N };
  });
  return { status: 'comparable', score_deltas, reasons: [] };
}

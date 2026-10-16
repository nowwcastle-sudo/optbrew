import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'canonical-consistency';
const REDIRECT_CHAIN = problem('Redirect chain of two or more hops', 'canonical-consistency.redirect-chain');
const TARGET_STATUS = problem('canonical target does not return a successful status', 'canonical-consistency.target-status');
const INVALID_URL = problem('canonical is not a valid URL', 'canonical-consistency.invalid-url');

/** Redirect depth, and whether the declared canonical points at this page or at a reachable one. */
export const canonicalConsistency = {
  family_id: FAMILY,
  message_keys: [REDIRECT_CHAIN, TARGET_STATUS, INVALID_URL].map(item => item.message_key),
  derive({ pageRows, artifacts }) {
    const out = [];
    for (const { url, artifact, info } of pageRows) {
      const hops = artifact.redirect_chain?.length ?? 0;
      let canonicalState = null, canonicalProblem = null;
      const measurement = { redirect_hops: hops, canonical_target: null, canonical_status: null };
      if (info.canonical) {
        try {
          const target = new URL(info.canonical, artifact.final_url); target.hash = '';
          measurement.canonical_target = target.href;
          const other = artifacts.find(x => x.normalized_url === target.href || x.final_url === target.href);
          if (target.href === artifact.final_url || target.href === artifact.normalized_url) canonicalState = 'pass';
          else if (other && other.status >= 200 && other.status < 300) canonicalState = 'pass';
          else if (other && Number.isInteger(other.status)) { canonicalState = 'fail'; canonicalProblem = TARGET_STATUS; measurement.canonical_status = other.status; }
        } catch { canonicalState = 'fail'; canonicalProblem = INVALID_URL; }
      }
      // Fixed sentences; the hop count, the target and its status are page-specific and travel in the measurement.
      const observe = (state, stated) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), state, evidence_ref: artifact.evidence_ref, ...stated }));
      const problems = [...(hops >= 2 ? [REDIRECT_CHAIN] : []), ...(canonicalProblem ? [canonicalProblem] : [])];
      if (problems.length) observe('fail', { problems, extra: { measurement: { ...measurement, problems: problems.map(item => item.text) } } });
      else if (canonicalState === 'pass') observe('pass', { reason: 'Canonical target is this page or a reachable page and redirects stay within one hop', extra: { measurement } });
    }
    return out;
  },
};

import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'canonical-consistency';

/** Redirect depth, and whether the declared canonical points at this page or at a reachable one. */
export const canonicalConsistency = {
  family_id: FAMILY,
  derive({ pageRows, artifacts }) {
    const out = [];
    for (const { url, artifact, info } of pageRows) {
      const hops = artifact.redirect_chain?.length ?? 0;
      let canonicalState = null, canonicalNote = '';
      const measurement = { redirect_hops: hops, canonical_target: null, canonical_status: null };
      if (info.canonical) {
        try {
          const target = new URL(info.canonical, artifact.final_url); target.hash = '';
          measurement.canonical_target = target.href;
          const other = artifacts.find(x => x.normalized_url === target.href || x.final_url === target.href);
          if (target.href === artifact.final_url || target.href === artifact.normalized_url) canonicalState = 'pass';
          else if (other && other.status >= 200 && other.status < 300) canonicalState = 'pass';
          else if (other && Number.isInteger(other.status)) { canonicalState = 'fail'; canonicalNote = 'canonical target does not return a successful status'; measurement.canonical_status = other.status; }
        } catch { canonicalState = 'fail'; canonicalNote = 'canonical is not a valid URL'; }
      }
      // Fixed sentences; the hop count, the target and its status are page-specific and travel in the measurement.
      const observe = (state, reason) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), state, reason,
        evidence_ref: artifact.evidence_ref, extra: { measurement } }));
      if (hops >= 2) observe('fail', `Redirect chain of two or more hops${canonicalNote ? `; ${canonicalNote}` : ''}`);
      else if (canonicalState === 'fail') observe('fail', canonicalNote);
      else if (canonicalState === 'pass') observe('pass', 'Canonical target is this page or a reachable page and redirects stay within one hop');
    }
    return out;
  },
};

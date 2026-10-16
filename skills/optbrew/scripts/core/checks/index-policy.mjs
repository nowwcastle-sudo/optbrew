import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'index-policy';

/** Whether the raw response blocks indexing, for pages meant to be indexed. */
export const indexPolicy = {
  family_id: FAMILY,
  derive({ pageRows }) {
    return pageRows.filter(row => row.publicIndexing).map(({ url, artifact, info }) => makeObservation({
      family_id: FAMILY, unit_key: unitKey(FAMILY, url), state: info.index_blocked ? 'fail' : 'pass',
      reason: info.index_blocked ? 'Raw response blocks indexing for the target engine' : 'Raw response has no applicable noindex directive',
      evidence_ref: artifact.evidence_ref }));
  },
};

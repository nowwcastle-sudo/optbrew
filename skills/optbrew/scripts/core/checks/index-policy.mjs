import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'index-policy';
const NOINDEX = 'index-policy.noindex';

/** Whether the raw response blocks indexing, for pages meant to be indexed. */
export const indexPolicy = {
  family_id: FAMILY,
  message_keys: [NOINDEX],
  derive({ pageRows }) {
    return pageRows.filter(row => row.publicIndexing).map(({ url, artifact, info }) => makeObservation({
      family_id: FAMILY, unit_key: unitKey(FAMILY, url), state: info.index_blocked ? 'fail' : 'pass', evidence_ref: artifact.evidence_ref,
      ...(info.index_blocked ? { problems: [problem('Raw response blocks indexing for the target engine', NOINDEX)] }
        : { reason: 'Raw response has no applicable noindex directive' }) }));
  },
};

import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'structured-data-truth';

/** JSON-LD that does not parse fails. Parsing cleanly proves nothing about truth, so this block has no pass row. */
export const structuredDataTruth = {
  family_id: FAMILY,
  derive({ pageRows }) {
    return pageRows.filter(row => row.info.jsonld_parse_errors > 0).map(({ url, artifact, info }) => makeObservation({
      family_id: FAMILY, unit_key: unitKey(FAMILY, url), state: 'fail', reason: `${info.jsonld_parse_errors} JSON-LD block(s) fail to parse`,
      evidence_ref: artifact.evidence_ref }));
  },
};

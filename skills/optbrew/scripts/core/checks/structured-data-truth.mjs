import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'structured-data-truth';
const PARSE_ERROR = 'structured-data-truth.parse-error';

/** JSON-LD that does not parse fails. Parsing cleanly proves nothing about truth, so this block has no pass row. */
export const structuredDataTruth = {
  family_id: FAMILY,
  message_keys: [PARSE_ERROR],
  derive({ pageRows }) {
    return pageRows.filter(row => row.info.jsonld_parse_errors > 0).map(({ url, artifact, info }) => makeObservation({
      family_id: FAMILY, unit_key: unitKey(FAMILY, url), state: 'fail', problems: [problem('JSON-LD block(s) fail to parse', PARSE_ERROR)],
      evidence_ref: artifact.evidence_ref, extra: { measurement: { parse_errors: info.jsonld_parse_errors } } }));
  },
};

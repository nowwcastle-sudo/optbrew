import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'fetch-response';

/** Every selected page, collected or not: a finished 2xx passes, a 4xx or 5xx fails, anything else is unknown. */
export const fetchResponse = {
  family_id: FAMILY,
  derive({ artifacts, selected }) {
    return artifacts.filter(artifact => selected.has(artifact.normalized_url)).map(artifact => makeObservation({
      family_id: FAMILY, unit_key: unitKey(FAMILY, artifact.normalized_url),
      state: artifact.error || artifact.status < 200 || artifact.status >= 300 && artifact.status < 400 ? 'unknown' : artifact.status >= 400 ? 'fail' : 'pass',
      reason: artifact.error ? 'Request did not finish' : `HTTP ${artifact.status}`, evidence_ref: artifact.evidence_ref }));
  },
};

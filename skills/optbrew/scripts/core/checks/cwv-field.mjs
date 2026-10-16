import { cwvVerdict } from '../contracts.mjs';
import { thresholds } from '../config.mjs';
import { HTTP_OK } from '../cwv.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const UNAVAILABLE = 'field_data_unavailable';
const P75 = 75;
// PageSpeed Insights gives the CLS percentile as an integer, 100 times the score (0.1 reads 10).
const PSI_CLS_PERCENTILE_SCALE = 100;
const SCALE_TOLERANCE = 1e-9;

/**
 * Where each family's 75th percentile sits in a stored answer. CrUX gives the value itself (a string for CLS); PageSpeed
 * Insights gives an integer, and for CLS one scaled by PSI_CLS_PERCENTILE_SCALE. Google does not document that scale, so it is
 * trusted only while the first distribution bucket ends at the good bound times the scale (10 for 0.1); otherwise there is no value.
 */
const FIELDS = {
  'lcp-field': { crux: 'largest_contentful_paint', psi: 'LARGEST_CONTENTFUL_PAINT_MS', scaled: false },
  'inp-field': { crux: 'interaction_to_next_paint', psi: 'INTERACTION_TO_NEXT_PAINT', scaled: false },
  'cls-field': { crux: 'cumulative_layout_shift', psi: 'CUMULATIVE_LAYOUT_SHIFT_SCORE', scaled: true },
};

/** The families that need visitor field data; a run without a Google key leaves them unknown. */
export const CWV_FAMILIES = Object.keys(FIELDS);

const finite = value => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;

/** The p75 a stored answer holds for a family, or null when it holds none. */
function p75Of(record, familyId) {
  const names = FIELDS[familyId];
  if (record.status !== HTTP_OK || !record.body || typeof record.body !== 'object') return null;
  if (record.source === 'crux') return finite(record.body.record?.metrics?.[names.crux]?.percentiles?.p75);
  const metric = record.body.originLoadingExperience?.metrics?.[names.psi];
  const value = finite(metric?.percentile);
  if (value === null || !names.scaled) return value;
  const bound = finite(metric.distributions?.[0]?.max);
  return Math.abs(bound - thresholds(familyId).good * PSI_CLS_PERCENTILE_SCALE) < SCALE_TOLERANCE ? value / PSI_CLS_PERCENTILE_SCALE : null;
}

/** With no CWV answer to point at, an unknown points at a collected response of the origin: collector evidence, as every collector verdict needs. */
const anchorOf = (artifacts, origin) => artifacts.find(artifact => artifact.normalized_url && new URL(artifact.normalized_url).origin === origin)?.evidence_ref;

/**
 * One family's verdict at the 75th percentile of real users, one per origin, from the stored CWV answers (`prepared.cwv`)
 * alone. An origin with no usable p75 is `unknown`: absent field data is not a failure. The first stored answer of an
 * origin that holds a value decides, so replay picks the same one the audit did.
 */
const fieldBlock = familyId => ({
  family_id: familyId,
  message_keys: [`${familyId}.slow`],
  derive({ context, artifacts, selected, cwv }) {
    const { unit } = thresholds(familyId);
    return [...new Set([...selected.keys()].map(url => new URL(url).origin))].map(origin => {
      const mine = cwv.filter(record => record.origin === origin);
      const source = mine.find(record => p75Of(record, familyId) !== null);
      const observation = { family_id: familyId, unit_key: unitKey(familyId, origin) };
      if (!source) return makeObservation({ ...observation, state: 'unknown', reason: UNAVAILABLE,
        evidence_ref: mine[0]?.evidence_ref ?? anchorOf(artifacts, origin) ?? context.evidence_ref });
      const value = p75Of(source, familyId);
      const measurement = { value, percentile: P75, source_type: 'field', unit };
      const { state, q, partial_basis } = cwvVerdict(familyId, value, measurement);
      const reason = `p75 ${value} ${unit} from ${source.source}`;
      return makeObservation({ ...observation, state, q, partial_basis, evidence_ref: source.evidence_ref, extra: { measurement },
        ...(state === 'fail' ? { problems: [problem(reason, `${familyId}.slow`, { value, source: source.source })] } : { reason }) });
    });
  },
});

export const lcpField = fieldBlock('lcp-field');
export const inpField = fieldBlock('inp-field');
export const clsField = fieldBlock('cls-field');

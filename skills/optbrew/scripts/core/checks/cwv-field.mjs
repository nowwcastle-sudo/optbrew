import { cwvVerdict } from '../contracts.mjs';
import { thresholds } from '../config.mjs';
import { HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_OK, isTryLater } from '../cwv.mjs';
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

const isoDate = date => Number.isInteger(date?.year) && Number.isInteger(date.month) && Number.isInteger(date.day)
  ? `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}` : null;

/**
 * The days the CrUX 28-day window covers, `{ first_date, last_date }` as YYYY-MM-DD from `record.collectionPeriod`; null for a
 * PageSpeed Insights answer (it names no window) or a CrUX answer that does not carry both dates. A comparison of two audits needs it.
 */
function collectionPeriodOf(record) {
  if (record.source !== 'crux') return null;
  const first = isoDate(record.body.record?.collectionPeriod?.firstDate), last = isoDate(record.body.record?.collectionPeriod?.lastDate);
  return first && last ? { first_date: first, last_date: last } : null;
}

/**
 * Why an origin has no p75, from its stored answers; each reason is one an owner can act on. CrUX is the source of record, so
 * what it said comes first: a 404 means the origin has no data (PageSpeed Insights then adds nothing); a 403 means the key may
 * not call it; a 429 or 5xx that came back after the retry means Google could not answer. Without any CrUX answer, a PageSpeed
 * Insights 200 that holds no real-user block is the announced end of that data. Everything else stays `field_data_unavailable`.
 */
function whyBlank(mine) {
  const status = source => mine.filter(record => record.source === source).map(record => record.status);
  const crux = status('crux');
  if (crux.includes(HTTP_NOT_FOUND)) return UNAVAILABLE;
  if (crux.includes(HTTP_FORBIDDEN)) return 'crux_permission_denied';
  if (crux.some(isTryLater)) return 'crux_unavailable';
  const noFieldBlock = record => record.source === 'psi' && record.status === HTTP_OK && record.body && typeof record.body === 'object'
    && Object.keys(record.body.originLoadingExperience?.metrics ?? {}).length === 0;
  return !crux.length && mine.some(noFieldBlock) ? 'psi_field_discontinued' : UNAVAILABLE;
}

/**
 * With no CWV answer to point at, an unknown points at a collected response of the origin: collector evidence, as every collector verdict needs.
 * A page of the origin comes before its robots or sitemap, so the anchor does not depend on the order the collector fetched them in.
 */
function anchorOf(artifacts, origin) {
  const ofOrigin = artifacts.filter(artifact => artifact.normalized_url && new URL(artifact.normalized_url).origin === origin);
  return (ofOrigin.find(artifact => artifact.capability === 'raw_html') ?? ofOrigin[0])?.evidence_ref;
}

/**
 * One family's verdict at the 75th percentile of real users, one per origin, from the stored CWV answers (`prepared.cwv`)
 * alone. An origin with no usable p75 is `unknown`: absent field data is not a failure. The first stored answer of an
 * origin that holds a value decides, so replay picks the same one the audit did.
 */
const fieldBlock = familyId => ({
  family_id: familyId,
  message_keys: [`${familyId}.slow`],
  derive({ context, artifacts, selected, cwv }) {
    const { unit, good, poor } = thresholds(familyId);
    return [...new Set([...selected.keys()].map(url => new URL(url).origin))].map(origin => {
      const mine = cwv.filter(record => record.origin === origin);
      const source = mine.find(record => p75Of(record, familyId) !== null);
      const observation = { family_id: familyId, unit_key: unitKey(familyId, origin) };
      if (!source) return makeObservation({ ...observation, state: 'unknown', reason: whyBlank(mine),
        evidence_ref: mine[0]?.evidence_ref ?? anchorOf(artifacts, origin) ?? context.evidence_ref });
      const value = p75Of(source, familyId);
      const measurement = { value, percentile: P75, source_type: 'field', unit, collection_period: collectionPeriodOf(source) };
      const { state, q, partial_basis } = cwvVerdict(familyId, value, measurement);
      const reason = `p75 ${value} ${unit} from ${source.source}`;
      return makeObservation({ ...observation, state, q, partial_basis, evidence_ref: source.evidence_ref, extra: { measurement },
        ...(state === 'fail' ? { problems: [problem(reason, `${familyId}.slow`, { value, source: source.source, good, poor })] } : { reason }) });
    });
  },
});

export const lcpField = fieldBlock('lcp-field');
export const inpField = fieldBlock('inp-field');
export const clsField = fieldBlock('cls-field');

import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'naver-markup';
const OG_PREFIX = 'no-og-';
/** The Korean message each markup finding code of the Naver module has; the five Open Graph codes share one. */
const CODES = ['no-og', 'no-description', 'no-canonical', 'canonical-relative', 'title-keyword-repeat', 'no-viewport', 'resource-blocked'];
const keyOf = code => `naver-markup.${code.startsWith(OG_PREFIX) ? 'no-og' : code}`;

/** Open Graph, description, canonical, viewport and title markup that Naver reads, judged only when Naver is a target engine. */
export const naverMarkup = {
  family_id: FAMILY,
  message_keys: CODES.map(code => keyOf(code)),
  derive({ context, pageRows }) {
    if (!context.protocol.engines.includes('naver')) return [];
    // Each distinct problem is its own finding, as in the other checks that state several: the joined reason is only the verdict's summary.
    return pageRows.map(({ url, artifact, info }) => makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url, 'naver'),
      state: info.markup_findings.length ? 'fail' : 'pass', evidence_ref: artifact.evidence_ref,
      ...(info.markup_findings.length ? { problems: info.markup_findings.map(x => problem(x.message, keyOf(x.code), x.values)) }
        : { reason: 'Open Graph, description, canonical, viewport and title checks pass' }) }));
  },
};

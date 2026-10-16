import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'naver-markup';

/** Open Graph, description, canonical, viewport and title markup that Naver reads, judged only when Naver is a target engine. */
export const naverMarkup = {
  family_id: FAMILY,
  derive({ context, pageRows }) {
    if (!context.protocol.engines.includes('naver')) return [];
    return pageRows.map(({ url, artifact, info }) => makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url, 'naver'),
      state: info.markup_findings.length ? 'fail' : 'pass',
      reason: info.markup_findings.length ? info.markup_findings.map(x => x.message).join('; ') : 'Open Graph, description, canonical, viewport and title checks pass',
      evidence_ref: artifact.evidence_ref }));
  },
};

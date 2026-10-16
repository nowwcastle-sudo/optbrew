import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'document-title';

/** A missing or duplicated title fails; a present, unique title is only unknown because quality is not code-judged. */
export const documentTitle = {
  family_id: FAMILY,
  derive({ pageRows, titleCounts }) {
    return pageRows.map(row => {
      const { url, artifact, info } = row;
      const duplicates = info.title ? titleCounts.get(row.titleKey).filter(other => other !== row && other.artifact.final_url !== artifact.final_url) : [];
      return makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), state: !info.title || duplicates.length ? 'fail' : 'unknown',
        reason: !info.title ? 'Raw HTML has no title' : duplicates.length ? `Title duplicates ${duplicates.map(x => x.url).join(', ')}` :
          'Raw HTML has a title; uniqueness and descriptiveness are not established', evidence_ref: artifact.evidence_ref });
    });
  },
};

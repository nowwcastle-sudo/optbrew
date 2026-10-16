import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'document-title';
const MISSING = 'document-title.missing';
const DUPLICATE = 'document-title.duplicate';

/** A missing or duplicated title fails; a present, unique title is only unknown because quality is not code-judged. */
export const documentTitle = {
  family_id: FAMILY,
  message_keys: [MISSING, DUPLICATE],
  derive({ pageRows, titleCounts }) {
    return pageRows.map(row => {
      const { url, artifact, info } = row;
      const duplicates = info.title ? titleCounts.get(row.titleKey).filter(other => other !== row && other.artifact.final_url !== artifact.final_url) : [];
      const observed = { family_id: FAMILY, unit_key: unitKey(FAMILY, url), evidence_ref: artifact.evidence_ref };
      if (!info.title) return makeObservation({ ...observed, state: 'fail', problems: [problem('Raw HTML has no title', MISSING)] });
      // The other pages are page-specific, so they travel in the measurement and the reason stays the same for every page with the problem.
      if (duplicates.length) return makeObservation({ ...observed, state: 'fail', problems: [problem('Title duplicates the title of other pages', DUPLICATE)],
        extra: { measurement: { duplicate_pages: duplicates.map(x => x.url) } } });
      return makeObservation({ ...observed, state: 'unknown', reason: 'Raw HTML has a title; uniqueness and descriptiveness are not established' });
    });
  },
};

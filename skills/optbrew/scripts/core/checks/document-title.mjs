import { thresholds } from '../config.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'document-title';
const MISSING = 'document-title.missing';
const DUPLICATE = 'document-title.duplicate';

/** A title or host name as letters and digits only, so case, spacing and punctuation never tell two spellings apart. */
const plain = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** The forms of the site's own name a title can consist of alone: its host, and the host's first label. */
function siteNames(finalUrl) {
  const host = new URL(finalUrl).hostname.replace(/^www\./, '');
  return [plain(host), plain(host.split('.')[0])];
}

/**
 * A missing or duplicated title fails. A title that is present, differs from every other audited page's title and is not only the
 * site's name or a generic word passes, on those three facts alone; a title that is only a name or a generic word stays unknown,
 * because whether it describes the page is not established by code.
 */
export const documentTitle = {
  family_id: FAMILY,
  message_keys: [MISSING, DUPLICATE],
  derive({ pageRows, titleCounts }) {
    const generic = new Set(thresholds(FAMILY).generic_titles.map(plain));
    return pageRows.map(row => {
      const { url, artifact, info } = row;
      const duplicates = info.title ? titleCounts.get(row.titleKey).filter(other => other !== row && other.artifact.final_url !== artifact.final_url) : [];
      const observed = { family_id: FAMILY, unit_key: unitKey(FAMILY, url), evidence_ref: artifact.evidence_ref };
      if (!info.title) return makeObservation({ ...observed, state: 'fail', problems: [problem('Raw HTML has no title', MISSING)] });
      // The other pages are page-specific, so they travel in the measurement and the reason stays the same for every page with the problem.
      if (duplicates.length) return makeObservation({ ...observed, state: 'fail', problems: [problem('Title duplicates the title of other pages', DUPLICATE)],
        extra: { measurement: { duplicate_pages: duplicates.map(x => x.url) } } });
      const key = plain(info.title);
      const measurement = { title: info.title, audited_pages: pageRows.length, site_name_only: siteNames(artifact.final_url).includes(key), generic_word_only: key === '' || generic.has(key) };
      if (measurement.site_name_only || measurement.generic_word_only) return makeObservation({ ...observed, state: 'unknown', extra: { measurement },
        reason: 'Raw HTML has a title; uniqueness and descriptiveness are not established' });
      return makeObservation({ ...observed, state: 'pass', extra: { measurement },
        reason: 'The title is present, differs from the title of every other audited page, and is not only the site name or a generic word' });
    });
  },
};

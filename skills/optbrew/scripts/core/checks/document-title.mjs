import { thresholds } from '../config.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'document-title';
const MISSING = 'document-title.missing';
const DUPLICATE = 'document-title.duplicate';

/** A title or host name as letters and digits only, so case, spacing and punctuation never tell two spellings apart. */
const plain = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const OG_SITE_NAME = [/<meta\b[^>]*\bproperty\s*=\s*["']og:site_name["'][^>]*\bcontent\s*=\s*["']([^"']*)["']/i, /<meta\b[^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*\bproperty\s*=\s*["']og:site_name["']/i];
/**
 * The forms of the site's own name a title can consist of alone: the host and its first label, the `og:site_name` of any audited
 * page, and the name of the organization any audited page's JSON-LD speaks for.
 */
function siteNames(pageRows, facts) {
  const names = pageRows.flatMap(({ artifact, html }) => {
    const host = new URL(artifact.final_url).hostname.replace(/^www\./, '');
    return [host, host.split('.')[0], ...OG_SITE_NAME.map(pattern => pattern.exec(html)?.[1])];
  });
  for (const { facts: page } of facts) names.push(...page.linked.name.values());
  return new Set(names.filter(Boolean).map(plain).filter(Boolean));
}

/**
 * A missing or duplicated title fails. A title that is present, shared with no other audited page (and there are at least two audited
 * pages) and not only the site's name or a generic word passes, on those facts alone. With a single audited page, or a title that is
 * only a name or a generic word, it stays unknown, because whether it describes the page is not established by code.
 */
export const documentTitle = {
  family_id: FAMILY,
  message_keys: [MISSING, DUPLICATE],
  derive({ pageRows, titleCounts, facts }) {
    const generic = new Set(thresholds(FAMILY).generic_titles.map(plain));
    const names = siteNames(pageRows, facts);
    return pageRows.map(row => {
      const { url, artifact, info } = row;
      const duplicates = info.title ? titleCounts.get(row.titleKey)
        .filter(other => other !== row && other.artifact.final_url !== artifact.final_url && !(row.documentKey && other.documentKey === row.documentKey)) : [];
      const observed = { family_id: FAMILY, unit_key: unitKey(FAMILY, url), evidence_ref: artifact.evidence_ref };
      if (!info.title) return makeObservation({ ...observed, state: 'fail', problems: [problem('Raw HTML has no title', MISSING)] });
      // The other pages are page-specific, so they travel in the measurement and the reason stays the same for every page with the problem.
      if (duplicates.length) return makeObservation({ ...observed, state: 'fail', problems: [problem('Title duplicates the title of other pages', DUPLICATE)],
        extra: { measurement: { duplicate_pages: duplicates.map(x => x.url) } } });
      const key = plain(info.title);
      const measurement = { title: info.title, audited_pages: pageRows.length, site_name_only: names.has(key), generic_word_only: key === '' || generic.has(key) };
      // With one audited page, "no other page has this title" is true of any title and proves nothing.
      if (pageRows.length < 2 || measurement.site_name_only || measurement.generic_word_only) return makeObservation({ ...observed, state: 'unknown', extra: { measurement },
        reason: 'Raw HTML has a title; uniqueness and descriptiveness are not established' });
      return makeObservation({ ...observed, state: 'pass', extra: { measurement },
        reason: 'The title is present, differs from the title of every other audited page, and is not only the site name or a generic word' });
    });
  },
};

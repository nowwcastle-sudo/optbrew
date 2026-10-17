import { createHash } from 'node:crypto';
import { visibleText } from '../html.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'canonical-consistency';
const REDIRECT_CHAIN = problem('Redirect chain of two or more hops', 'canonical-consistency.redirect-chain');
const TARGET_STATUS = problem('canonical target does not return a successful status', 'canonical-consistency.target-status');
const INVALID_URL = problem('canonical is not a valid URL', 'canonical-consistency.invalid-url');
const NO_POLICY = 'The page declares no canonical URL and does not redirect';
const REPEATED = 'Another audited page has the same title or body text, so whether this page needs a representative URL is not established';

/** Redirect depth, and whether the declared canonical points at this page or at a reachable one. */
export const canonicalConsistency = {
  family_id: FAMILY,
  message_keys: [REDIRECT_CHAIN, TARGET_STATUS, INVALID_URL].map(item => item.message_key),
  derive({ pageRows, artifacts }) {
    const out = [];
    // Pages that share their body text with another audited page, or their title, by url.
    const bodyText = html => visibleText(/<body\b[^>]*>([\s\S]*)/i.exec(String(html ?? ''))?.[1] ?? html);
    const bodyOf = new Map(pageRows.map(row => [row, createHash('sha256').update(bodyText(row.html)).digest('hex')]));
    const repeated = new Map();
    for (const row of pageRows) {
      const others = pageRows.filter(other => other !== row && other.artifact.final_url !== row.artifact.final_url);
      const urls = others.filter(other => bodyOf.get(other) === bodyOf.get(row) || row.titleKey !== null && other.titleKey === row.titleKey).map(other => other.url);
      if (urls.length) repeated.set(row.url, urls);
    }
    for (const { url, artifact, info } of pageRows) {
      const hops = artifact.redirect_chain?.length ?? 0;
      let canonicalState = null, canonicalProblem = null;
      const measurement = { redirect_hops: hops, canonical_target: null, canonical_status: null };
      if (info.canonical) {
        try {
          const target = new URL(info.canonical, artifact.final_url); target.hash = '';
          measurement.canonical_target = target.href;
          const other = artifacts.find(x => x.normalized_url === target.href || x.final_url === target.href);
          if (target.href === artifact.final_url || target.href === artifact.normalized_url) canonicalState = 'pass';
          else if (other && other.status >= 200 && other.status < 300) canonicalState = 'pass';
          else if (other && Number.isInteger(other.status)) { canonicalState = 'fail'; canonicalProblem = TARGET_STATUS; measurement.canonical_status = other.status; }
        } catch { canonicalState = 'fail'; canonicalProblem = INVALID_URL; }
      }
      // Fixed sentences; the hop count, the target and its status are page-specific and travel in the measurement.
      const observe = (state, stated) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), state, evidence_ref: artifact.evidence_ref, ...stated }));
      const problems = [...(hops >= 2 ? [REDIRECT_CHAIN] : []), ...(canonicalProblem ? [canonicalProblem] : [])];
      if (problems.length) observe('fail', { problems, extra: { measurement: { ...measurement, problems: problems.map(item => item.text) } } });
      else if (canonicalState === 'pass') observe('pass', { reason: 'Canonical target is this page or a reachable page and redirects stay within one hop', extra: { measurement } });
      // With no canonical tag the page declares no representative URL: after one redirect hop the redirect is that policy and nothing
      // disagrees with it; with no redirect either, there is no policy to be consistent with. That holds only for a page no other
      // audited page repeats: a page with the same title or body as another is one that needs a representative URL.
      else if (!info.canonical && hops < 2 && repeated.has(url)) observe('unknown', { reason: REPEATED, extra: { measurement: { ...measurement, repeated_with: repeated.get(url) } } });
      else if (!info.canonical && hops === 1) observe('pass', { reason: 'No canonical is declared; the one redirect hop is the page\'s URL policy and stays within the limit', extra: { measurement } });
      else if (!info.canonical && hops === 0) observe('not_applicable', { reason: NO_POLICY, extra: { measurement,
        applicability_decision: { condition: 'no_representative_url_policy', reason: NO_POLICY, evidence_ref: artifact.evidence_ref } } });
    }
    return out;
  },
};

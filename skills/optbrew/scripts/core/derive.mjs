import { createHash } from 'node:crypto';
import { validateEntity } from './contracts.mjs';
import { versions } from './config.mjs';
import { auditCollected } from '../../modules/naver-searchadvisor/scripts/audit.mjs';
import { parseRobots, robotsVerdict } from '../../modules/naver-searchadvisor/scripts/robots.mjs';
import { anchorLinks, decodeEntities } from './html.mjs';
import { agentFor } from './crawlers.mjs';
import { declaredRobotsIndex } from './collector.mjs';
import { compareFacts, pageFacts } from './facts.mjs';

/**
 * Every collector verdict, derived from collected responses alone. The audit writes these observations and the
 * report replays this same function over hashed raw evidence, so a producer and a verifier cannot disagree.
 * `artifacts` carry the collection record fields plus evidence_ref; `textOf(artifact)` returns the raw body text.
 */
/** Link and sitemap target comparison key: no fragment, and a directory index file equals its directory. */
function canonicalUrl(value) {
  try {
    const url = new URL(value); url.hash = '';
    url.pathname = url.pathname.replace(/\/index\.(?:html?|php)$/i, '/');
    return url.href;
  } catch { return null; }
}

export function deriveObservations({ context, artifacts, collection = {}, textOf }) {
  const protocol = context.protocol;
  const planned = new Set(protocol.families.filter(x => x.applicable).map(x => x.family_id));
  const selected = new Map(protocol.page_types.flatMap(type => type.urls).map(url => [url.normalized, url]));
  const declared = kind => new Set((protocol.auxiliary_resources ?? []).filter(x => x.kind === kind).map(x => x.normalized));
  const declaredRobots = declared('robots'), declaredSitemaps = declared('sitemap');
  const out = [];
  const add = (family, engine, url, state, reason, evidence_ref) => {
    const unit_key = `${family}|${engine ? `${engine}|` : ''}${url}`;
    out.push(validateEntity('CheckObservation', { schema_version: versions().contract_schema,
      observation_id: createHash('sha256').update(unit_key).digest('hex'), check_id: family, family_id: family, unit_key,
      state, q: state === 'pass' ? 1 : state === 'fail' ? 0 : null, partial_basis: null, reason, evaluator_type: 'code',
      source_ref: 'optbrew:collector', evidence_ref }));
  };
  const pageRows = [];
  for (const artifact of artifacts) {
    const url = artifact.normalized_url;
    if (!selected.has(url)) continue;
    if (planned.has('fetch-response')) add('fetch-response', null, url,
      artifact.error || artifact.status < 200 || artifact.status >= 300 && artifact.status < 400 ? 'unknown' : artifact.status >= 400 ? 'fail' : 'pass',
      artifact.error ? 'Request did not finish' : `HTTP ${artifact.status}`, artifact.evidence_ref);
    if (artifact.capability !== 'raw_html' || artifact.status !== 200) continue;
    const html = textOf(artifact);
    const robotsIndex = declaredRobotsIndex(artifacts, declaredRobots, artifact.final_url);
    const robots = robotsIndex < 0 ? null : artifacts[robotsIndex];
    const info = auditCollected({ artifact, html, engines: protocol.engines,
      robotsArtifact: robots?.status === 200 ? { ...robots, body: textOf(robots) } : null });
    pageRows.push({ url, artifact, html, info, robots, publicIndexing: selected.get(url).public_indexing !== false });
  }
  const normalizeTitle = title => title.toLowerCase().replace(/\s+/g, ' ').trim();
  const titleCounts = new Map();
  for (const row of pageRows) if (row.info.title) {
    const key = normalizeTitle(row.info.title);
    titleCounts.set(key, new Set([...(titleCounts.get(key) ?? []), row.artifact.final_url]));
  }
  const facts = pageRows.map(row => ({ url: row.url, row, facts: pageFacts(row.html) }));
  const comparison = compareFacts(facts);
  for (const row of pageRows) {
    const { url, artifact, info } = row, ref = artifact.evidence_ref;
    if (planned.has('document-title')) {
      const dup = info.title ? pageRows.filter(x => x !== row && x.info.title && normalizeTitle(x.info.title) === normalizeTitle(info.title) &&
        x.artifact.final_url !== artifact.final_url) : [];
      add('document-title', null, url, !info.title || dup.length ? 'fail' : 'unknown',
        !info.title ? 'Raw HTML has no title' : dup.length ? `Title duplicates ${dup.map(x => x.url).join(', ')}` :
          'Raw HTML has a title; uniqueness and descriptiveness are not established', ref);
    }
    if (planned.has('index-policy') && row.publicIndexing)
      add('index-policy', null, url, info.index_blocked ? 'fail' : 'pass',
        info.index_blocked ? 'Raw response blocks indexing for the target engine' : 'Raw response has no applicable noindex directive', ref);
    if (planned.has('search-crawl-policy') && row.publicIndexing && row.robots?.status === 200) {
      const parsed = parseRobots(textOf(row.robots));
      const target = new URL(artifact.final_url);
      for (const engine of protocol.engines) {
        const agent = agentFor(engine);
        if (!agent) continue;
        const verdict = robotsVerdict(parsed, agent, target.pathname + target.search);
        add('search-crawl-policy', engine, url, verdict.allowed ? 'pass' : 'fail',
          verdict.allowed ? `Collected robots.txt allows ${agent} path` : `Collected robots.txt disallows ${agent} path`, row.robots.evidence_ref);
      }
    }
    if (planned.has('naver-markup') && protocol.engines.includes('naver'))
      add('naver-markup', 'naver', url, info.markup_findings.length ? 'fail' : 'pass',
        info.markup_findings.length ? info.markup_findings.map(x => x.message).join('; ') : 'Open Graph, description, canonical, viewport and title checks pass', ref);
    if (planned.has('structured-data-truth') && info.jsonld_parse_errors > 0)
      add('structured-data-truth', null, url, 'fail', `${info.jsonld_parse_errors} JSON-LD block(s) fail to parse`, ref);
    if (planned.has('canonical-consistency')) {
      const hops = artifact.redirect_chain?.length ?? 0;
      let canonicalState = null, canonicalNote = '';
      if (info.canonical) {
        try {
          const target = new URL(info.canonical, artifact.final_url); target.hash = '';
          const other = artifacts.find(x => x.normalized_url === target.href || x.final_url === target.href);
          if (target.href === artifact.final_url || target.href === artifact.normalized_url) canonicalState = 'pass';
          else if (other && other.status >= 200 && other.status < 300) canonicalState = 'pass';
          else if (other && Number.isInteger(other.status)) { canonicalState = 'fail'; canonicalNote = `canonical target ${target.href} returns HTTP ${other.status}`; }
        } catch { canonicalState = 'fail'; canonicalNote = 'canonical is not a valid URL'; }
      }
      if (hops >= 2) add('canonical-consistency', null, url, 'fail', `Redirect chain of ${hops} hops${canonicalNote ? `; ${canonicalNote}` : ''}`, ref);
      else if (canonicalState === 'fail') add('canonical-consistency', null, url, 'fail', canonicalNote, ref);
      else if (canonicalState === 'pass') add('canonical-consistency', null, url, 'pass', 'Canonical target is this page or a reachable page and redirects stay within one hop', ref);
    }
  }
  /** True when any other collected page's raw bytes name this page's path (whole path segment, not a longer path). */
  const pathMentioned = ({ url, artifact }, bodies) => {
    const own = canonicalUrl(url);
    for (const target of new Set([url, artifact.final_url])) {
      let path;
      try { path = decodeURIComponent(new URL(target).pathname); } catch { continue; }
      if (path === '/') continue;
      const pattern = new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_-])');
      for (const [page, body] of bodies) if (page !== own && pattern.test(body)) return true;
    }
    return false;
  };
  if (planned.has('discovery')) {
    const sitemapUrls = new Set();
    const brokenSitemaps = [];
    let sitemapIndex = false;
    for (const artifact of artifacts) {
      if (!declaredSitemaps.has(artifact.normalized_url)) continue;
      if (artifact.status >= 200 && artifact.status < 300) {
        const body = String(textOf(artifact) ?? '');
        // Child sitemaps of an index are not fetched, so pages missing from the index prove nothing.
        if (/<sitemapindex\b/i.test(body)) sitemapIndex = true;
        for (const match of body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) sitemapUrls.add(canonicalUrl(decodeEntities(match[1])));
      } else brokenSitemaps.push(`${artifact.normalized_url} (${artifact.status ?? artifact.error ?? 'no response'})`);
    }
    const htmlPages = artifacts.filter(x => x.capability === 'raw_html' && x.status === 200);
    const linked = new Map();
    // A page with scripts and no anchors may build its navigation in the browser. That only hides an orphan when the
    // script can be read: an inline script is searched for the path below, and a same-origin script file that was not
    // collected cannot be read at all.
    const collected = new Set(artifacts.flatMap(x => [x.normalized_url, x.final_url].filter(Boolean).map(canonicalUrl)));
    let uncollectedScript = false;
    const bodies = new Map();
    for (const page of htmlPages) {
      const body = textOf(page);
      bodies.set(canonicalUrl(page.normalized_url), body);
      const hrefs = anchorLinks(body, page.final_url);
      if (!hrefs.length && /<script\b/i.test(body)) {
        for (const match of body.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
          try {
            const source = new URL(decodeEntities(match[1] ?? match[2]), page.final_url);
            if (source.origin === new URL(page.final_url).origin && !collected.has(canonicalUrl(source.href))) uncollectedScript = true;
          } catch { /* malformed script URL */ }
        }
      }
      for (const href of hrefs) {
        const target = canonicalUrl(href);
        if (target && target !== canonicalUrl(page.final_url) && target !== canonicalUrl(page.normalized_url)) linked.set(target, (linked.get(target) ?? 0) + 1);
      }
    }
    const complete = !collection.limit_reached && !(collection.skipped ?? []).some(x => ['depth_limit', 'url_limit', 'request_limit'].includes(x.reason));
    for (const row of pageRows) {
      if (!row.publicIndexing) continue;
      const { url, artifact } = row;
      const keys = [canonicalUrl(url), canonicalUrl(artifact.final_url)];
      const inSitemap = keys.some(key => sitemapUrls.has(key));
      if (inSitemap || keys.some(key => linked.has(key)))
        add('discovery', null, url, 'pass', inSitemap ? 'Listed in a declared sitemap' : 'Linked from another collected page', artifact.evidence_ref);
      // An unlinked page is unknown when a collected page's own bytes (inline scripts included) name its path, or when a
      // script file that could build the link was not collected, unless a fetched sitemap that lists other pages leaves
      // it out. Anything else is an orphan.
      else if (htmlPages.length >= 2 && complete && !sitemapIndex && (sitemapUrls.size || !(uncollectedScript || pathMentioned(row, bodies))))
        add('discovery', null, url, 'fail', `Not linked from any collected page and not in a sitemap${brokenSitemaps.length ? `; declared sitemap unusable: ${brokenSitemaps.join(', ')}` : ''}`, artifact.evidence_ref);
    }
  }
  if (planned.has('fact-consistency')) {
    for (const page of facts) {
      if (comparison.separate.has(page.url)) continue;
      const found = comparison.deviations.get(page.url) ?? [];
      const comparable = Object.keys(comparison.references).some(type => page.facts.visible[type].size || page.facts.linked[type].size || (type === 'phone' && page.facts.tel.phone.size));
      if (found.length) add('fact-consistency', null, page.url, 'fail', `Cross-page fact comparison (no approved fact list): ${found.join('; ')}`, page.row.artifact.evidence_ref);
      else if (comparable) add('fact-consistency', null, page.url, 'pass', 'Facts on this page match the cross-page reference values (no approved fact list; consistency is not accuracy)', page.row.artifact.evidence_ref);
    }
  }
  if (planned.has('entity-identity') && facts.length) {
    const reasons = [];
    const home = facts.find(x => new URL(x.row.artifact.final_url).pathname === '/') ?? facts[0];
    const orgPages = facts.filter(x => x.facts.orgs.length && !comparison.separate.has(x.url));
    const nameReference = comparison.references.name;
    const nameDeviants = facts.filter(x => (comparison.deviations.get(x.url) ?? []).some(text => text.startsWith('name ')));
    if (nameDeviants.length) reasons.push(`name differs from "${nameReference.label}" on ${nameDeviants.map(x => x.url).join(', ')}`);
    for (const page of orgPages) if (page.facts.orgs.some(org => !org.sameAs)) reasons.push(`Organization JSON-LD without sameAs on ${page.url}`);
    if (orgPages.length && !home.facts.orgs.length) reasons.push(`no Organization or LocalBusiness JSON-LD on ${home.url}`);
    if (reasons.length) add('entity-identity', null, 'site', 'fail', `Entity identity: ${reasons.join('; ')}`, (nameDeviants[0] ?? home).row.artifact.evidence_ref);
    else if (orgPages.length) add('entity-identity', null, 'site', 'pass', 'Organization JSON-LD with name and sameAs is present on the home page and names agree', home.row.artifact.evidence_ref);
  }
  return out;
}

import { anchorLinks, decodeEntities } from './html.mjs';

/** Link and sitemap target comparison key: no fragment, and a directory index file equals its directory. */
export function canonicalUrl(value) {
  try {
    const url = new URL(value); url.hash = '';
    url.pathname = url.pathname.replace(/\/index\.(?:html?|php)$/i, '/');
    return url.href;
  } catch { return null; }
}

/** The distinct links of `hrefs` that stay on the origin of `base`, absolute and without fragments, sorted. */
export function sameOriginLinks(hrefs, base) {
  const { origin } = new URL(base);
  const found = new Set();
  for (const href of hrefs) {
    let url;
    try { url = new URL(href, base); } catch { continue; }
    url.hash = '';
    if (url.origin === origin) found.add(url.href);
  }
  return [...found].sort();
}

/**
 * The anchor links between collected HTML pages. `rows` are `{ url, artifact, html }` for every collected page with a 200
 * raw HTML body, selected or not. `edges` lists `{ from, to }` canonical urls (a page's link to itself is not an edge).
 * `depthOf(url)` is the click distance from the home page, `inbound(url)` the number of links into a page.
 * `scriptGap` is true when a page that has scripts and no anchors loads a same-origin script file that was not collected:
 * its navigation cannot be read, so a missing link proves nothing.
 */
export function linkGraph(rows, artifacts) {
  const collected = new Set(artifacts.flatMap(x => [x.normalized_url, x.final_url].filter(Boolean).map(canonicalUrl)));
  const edges = [];
  let scriptGap = false;
  for (const { artifact, html } of rows) {
    const hrefs = anchorLinks(html, artifact.final_url);
    if (!hrefs.length && /<script\b/i.test(html)) {
      for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        try {
          const source = new URL(decodeEntities(match[1] ?? match[2]), artifact.final_url);
          if (source.origin === new URL(artifact.final_url).origin && !collected.has(canonicalUrl(source.href))) scriptGap = true;
        } catch { /* malformed script URL */ }
      }
    }
    const from = canonicalUrl(artifact.normalized_url);
    for (const href of hrefs) {
      const to = canonicalUrl(href);
      if (to && to !== canonicalUrl(artifact.final_url) && to !== from) edges.push({ from, to });
    }
  }
  const next = new Map();
  for (const { from, to } of edges) next.set(from, [...next.get(from) ?? [], to]);
  const home = rows.find(row => new URL(row.artifact.final_url).pathname === '/') ?? rows[0];
  const depth = new Map(home ? [[canonicalUrl(home.url), 0]] : []);
  for (const page of depth.keys()) for (const to of next.get(page) ?? []) if (!depth.has(to)) depth.set(to, depth.get(page) + 1);
  return {
    edges, scriptGap,
    depthOf: url => depth.get(canonicalUrl(url)) ?? null,
    inbound: url => edges.filter(edge => edge.to === canonicalUrl(url)).length,
  };
}

/** True when any other collected page's raw bytes name this page's path (whole path segment, not a longer path). */
function pathMentioned({ url, artifact }, rows) {
  const own = canonicalUrl(url);
  for (const target of new Set([url, artifact.final_url])) {
    let path;
    try { path = decodeURIComponent(new URL(target).pathname); } catch { continue; }
    if (path === '/') continue;
    const pattern = new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_-])');
    for (const page of rows) if (canonicalUrl(page.url) !== own && pattern.test(page.html)) return true;
  }
  return false;
}

/**
 * Selected pages that nothing links to and no declared sitemap lists, when the evidence is complete enough to say so.
 * An unlinked page stays undecided when another page's own bytes (inline scripts included) name its path, or when a
 * script file that could build the link was not collected, unless a fetched sitemap that lists other pages leaves it out.
 * No page is an orphan when the crawl was cut short, fewer than two pages were collected, or the sitemap is an index
 * whose child sitemaps were not fetched, or a declared sitemap was never fetched.
 */
export function findOrphans({ pageRows, rows, graph, sitemaps, complete }) {
  const orphans = new Set();
  if (rows.length < 2 || !complete || sitemaps.index || sitemaps.unread.length) return orphans;
  for (const row of pageRows) {
    const keys = [canonicalUrl(row.url), canonicalUrl(row.artifact.final_url)];
    if (keys.some(key => sitemaps.urls.has(key) || graph.inbound(key))) continue;
    if (sitemaps.urls.size || !(graph.scriptGap || pathMentioned(row, rows))) orphans.add(row.url);
  }
  return orphans;
}

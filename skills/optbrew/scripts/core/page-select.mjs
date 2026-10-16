import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { links } from './collector.mjs';
import { decodeEntities } from './html.mjs';
import { assertUrlInScope } from './scope.mjs';

const START_FILE = path.join('preflight', 'start.json');
const EVIDENCE_INDEX = path.join('preflight', 'evidence', 'evidence-index.json');
/** Robots and sitemap files are auxiliary resources of the protocol, never audited pages. */
const AUXILIARY_PATH = /\/(?:robots\.txt|sitemap[^/]*\.xml)$/i;
const URLSET = /<urlset\b/i;
// Files a sitemap or a link may name that are not pages to audit.
const NOT_A_PAGE = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|zip|xml|txt|css|js|json|mp4|mp3)$/i;
const KOREAN_PAGE = /<html\b[^>]*\blang\s*=\s*["']?ko/i;
const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const HOME_TYPE = 'home';
const TOP_LEVEL_TYPE = 'pages';
const TYPE_NAME_LENGTH = 40;

const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };

/** The same site under the other spelling of its name: with or without `www.`, over http or https. */
export const sameSite = (a, b) => a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '') && a.port === b.port;

/**
 * What the unscored read before the start questions (`preflight/` in `out`) left behind, if anything: the address the first
 * request landed on (or the other site it was sent to), whether the start page declares Korean, the page addresses of every
 * sitemap file it fetched and the links of the start page. A sitemap is any fetched body that is a `<urlset>`, whatever its file
 * name (Yoast and WordPress name their children `page-sitemap.xml`, `wp-sitemap-posts-page-1.xml`). Bodies are used only when
 * they still match the hash the preflight index lists. `status` says what was there: `missing` (no preflight in this folder),
 * `read`, or `unreadable` (a preflight exists but none of its evidence could be used). A preflight made for another address is
 * not this run's and counts as missing.
 */
export async function readPreflight(out, startHref) {
  const start = await readJson(path.join(out, START_FILE));
  const index = await readJson(path.join(out, EVIDENCE_INDEX));
  const found = { status: 'missing', finalUrl: null, redirectedTo: null, korean: false, sitemapLocs: [], pageLinks: [] };
  if (!start && !index) return found;
  if (start?.requested_url && !sameSite(new URL(start.requested_url), new URL(startHref))) return found;
  found.status = 'unreadable';
  found.finalUrl = start?.final_url ?? null;
  found.redirectedTo = start?.redirected_to ?? null;
  for (const entry of index?.raw ?? []) {
    let text;
    try {
      const bytes = await readFile(entry.evidence_ref);
      if (createHash('sha256').update(bytes).digest('hex') !== entry.content_hash) continue;
      text = bytes.toString('utf8');
    } catch { continue; }
    found.status = 'read';
    if (URLSET.test(text)) for (const match of text.matchAll(LOC)) found.sitemapLocs.push(decodeEntities(match[1]));
    else if (entry.normalized_url === startHref || entry.normalized_url === found.finalUrl) {
      found.korean = KOREAN_PAGE.test(text);
      found.pageLinks = links(text, found.finalUrl ?? startHref);
    }
  }
  return found;
}

/**
 * The pages one audit covers, fixed before the first request: the start page, the pages the owner confirmed facts on, then the
 * sitemap's pages in the order it lists them, then the start page's own links. Every address must be inside `scope`; a file that
 * is not a page, a duplicate, or anything past `budget` is left out. A fact page that is left out is reported back in `dropped`.
 */
export function selectPages({ home, factUrls, preflight, scope, budget }) {
  const chosen = [];
  const seen = new Set();
  const dropped = [];
  const add = (href, owner) => {
    let normalized;
    try { normalized = assertUrlInScope(href, scope).href; }
    catch { if (owner) dropped.push({ url: href, reason: 'outside_scope' }); return; }
    const { pathname } = new URL(normalized);
    if (seen.has(normalized) || AUXILIARY_PATH.test(pathname) || NOT_A_PAGE.test(pathname)) return;
    if (chosen.length >= budget) { if (owner) dropped.push({ url: href, reason: 'over_limit' }); return; }
    seen.add(normalized);
    chosen.push(normalized);
  };
  add(home, true);
  for (const href of factUrls) add(href, true);
  const before = chosen.length;
  for (const href of preflight.sitemapLocs) add(href, false);
  const fromSitemap = chosen.length - before;
  for (const href of preflight.pageLinks) add(href, false);
  return { pages: chosen, dropped, sources: { preflight: preflight.status, sitemap_pages: fromSitemap, linked_pages: chosen.length - before - fromSitemap } };
}

/** The type of a page: `home` for the start page, the first path segment for a page inside a section, `pages` for the other top-level pages. */
function typeOf(href, home) {
  if (href === home) return HOME_TYPE;
  const segments = new URL(href).pathname.split('/').filter(Boolean);
  if (segments.length < 2) return TOP_LEVEL_TYPE;
  let name = segments[0];
  try { name = decodeURIComponent(name); } catch { /* an undecodable segment names its type as written */ }
  return name.slice(0, TYPE_NAME_LENGTH);
}

/** Page types in the order their first page appears; the same pages always give the same types. */
export function groupPages(pages, home) {
  const types = new Map();
  for (const href of pages) {
    const id = typeOf(href, home);
    types.set(id, [...(types.get(id) ?? []), href]);
  }
  return [...types].map(([id, urls]) => ({ id, urls }));
}

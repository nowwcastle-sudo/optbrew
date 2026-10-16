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
const SITEMAP_FILE = /\/sitemap[^/]*\.xml$/i;
// Files a sitemap or a link may name that are not pages to audit.
const NOT_A_PAGE = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|zip|xml|txt|css|js|json|mp4|mp3)$/i;
const KOREAN_PAGE = /<html\b[^>]*\blang\s*=\s*["']?ko/i;
const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const HOME_TYPE = 'home';
const TOP_LEVEL_TYPE = 'pages';
const TYPE_NAME_LENGTH = 40;

const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };

/**
 * What the unscored read before the start questions (`preflight/` in `out`) left behind, if anything: the address the first
 * request landed on, whether the start page declares Korean, the page addresses its sitemap lists and the links of the start
 * page. Bodies are used only when they still match the hash the preflight index lists. A run without a preflight gets nothing.
 */
export async function readPreflight(out, startHref) {
  const start = await readJson(path.join(out, START_FILE));
  const index = await readJson(path.join(out, EVIDENCE_INDEX));
  const found = { finalUrl: start?.final_url ?? null, korean: false, sitemapLocs: [], pageLinks: [] };
  for (const entry of index?.raw ?? []) {
    let text;
    try {
      const bytes = await readFile(entry.evidence_ref);
      if (createHash('sha256').update(bytes).digest('hex') !== entry.content_hash) continue;
      text = bytes.toString('utf8');
    } catch { continue; }
    if (SITEMAP_FILE.test(new URL(entry.normalized_url).pathname)) {
      if (!/<sitemapindex\b/i.test(text)) for (const match of text.matchAll(LOC)) found.sitemapLocs.push(decodeEntities(match[1]));
    } else if (entry.normalized_url === startHref || entry.normalized_url === found.finalUrl) {
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
  for (const href of [...preflight.sitemapLocs, ...preflight.pageLinks]) add(href, false);
  return { pages: chosen, dropped };
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

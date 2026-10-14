/** Small HTML helpers shared by the collector and the verdict derivation. Pure functions of raw bytes. */

/** Drop comments and raw text elements whose content is not markup. */
export function stripInert(html) {
  return String(html ?? '').replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
}

/** Markup without HTML comments. */
export const stripComments = html => String(html ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');

const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Decode the character references that appear in attribute values. */
export const decodeEntities = value => String(value).replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi,
  (match, dec, hex, name) => dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : named[name.toLowerCase()]);

/** Absolute hrefs of anchors, resolved against the response URL. */
export function anchorLinks(html, base) {
  const out = [];
  for (const match of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    try { out.push(new URL(decodeEntities(match[1] ?? match[2]), base).href); } catch { /* malformed link */ }
  }
  return out;
}

/** The raw href of the first rel=canonical link in live markup, or null. */
export function canonicalLink(html) {
  for (const match of stripInert(html).matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of match[1].matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    if (/(^|\s)canonical(\s|$)/i.test(attrs.rel ?? '') && attrs.href) return attrs.href;
  }
  return null;
}

/** JSON-LD blocks with their parse result. */
export function jsonLdBlocks(html) {
  // Blocks inside HTML comments are not live markup, and an empty placeholder block is not an error.
  return [...stripComments(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter(match => match[1].trim()).map(match => {
      try { return { ok: true, value: JSON.parse(match[1]) }; } catch { return { ok: false, value: null }; }
    });
}

const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Visible text with block boundaries kept as line breaks. */
export function visibleText(html) {
  return stripInert(html)
    .replace(/<\/?(?:h[1-6]|p|div|li|ul|ol|br|tr|section|article|header|footer|main|nav|title)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, token => entities[token])
    .replace(/[ \t\f\v\r]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

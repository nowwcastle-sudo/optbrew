import { thresholds } from '../config.mjs';
import { anchorLinks, visibleText } from '../html.mjs';
import { canonicalUrl, sameOriginLinks } from '../link-graph.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'render-content';
const NO_BODY_TEXT = 'render-content.no-body-text';
const CHROME_MISSING = 'chrome_missing';
const RENDER_BLOCKED = 'render_blocked';
const RENDER_FAILED = 'render_failed';
/** How the reason of a page that passes only after rendering begins; the report keys its JavaScript note on it. */
export const CONTENT_AFTER_RENDER = 'Content shows after rendering';

const squash = value => String(value ?? '').replace(/\s+/g, ' ').trim();
/** Visible characters of the body, whitespace not counted. */
const bodyLength = html => visibleText(/<body\b[^>]*>([\s\S]*)/i.exec(String(html ?? ''))?.[1] ?? html).replace(/\s/g, '').length;

const assetOf = (value, base) => { try { const url = new URL(value, base); return url.origin + url.pathname; } catch { return String(value); } };
/**
 * What a page's template loads: the external scripts and the head assets (stylesheets, preloads), each without query or fragment.
 * Two pages made by one template load the same set; null when the page loads nothing external, which is no signal at all.
 */
function templateAssets(html, base) {
  const live = String(html ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const scripts = [...live.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(match => assetOf(match[1], base));
  const head = [...live.matchAll(/<link\b[^>]*>/gi)].map(match => match[0]).filter(tag => /\brel\s*=\s*["'][^"']*\b(?:stylesheet|preload|modulepreload)\b/i.test(tag))
    .map(tag => /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]).filter(Boolean).map(href => assetOf(href, base));
  const sorted = list => [...new Set(list)].sort();
  return scripts.length || head.length ? { scripts: sorted(scripts), head: sorted(head) } : null;
}
const sameTemplate = (a, b) => a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);

/**
 * The raw HTML against the stored render of the same page. A page whose raw body, title and link count already match the render
 * does not depend on rendering. One that depends on it passes when the render shows content and fails when neither the raw HTML
 * nor the render has any. A challenge page (a challenge status, or a marker in the title or in a short body) and a render that did
 * not finish are unknown, and so is a page of the render sample with no render when the run did not record a Chrome.
 *
 * A page outside the render sample inherits the verdict of the rendered page of its own page type when every rendered page of the
 * type gives the same pass or not-applicable, and that page loads the same external scripts and head assets as this one (a page type
 * is only the first path segment, so it can hold leftovers and list pages beside detail pages). The page must have body text in its
 * own raw HTML, and the reason names the rendered page; the evidence is that page's render record. Otherwise the page gets no
 * verdict here.
 */
export const renderContent = {
  family_id: FAMILY,
  message_keys: [NO_BODY_TEXT],
  derive({ context, pageRows, renders, renderTextOf, chrome, renderSample }) {
    const { min_body_ratio, challenge_status, challenge_markers, challenge_max_body_chars } = thresholds(FAMILY);
    const judgeOwn = ({ url, artifact, html, info }) => {
      const own = [canonicalUrl(url), canonicalUrl(artifact.final_url)];
      const stored = renders.find(render => [render.url, render.final_url].some(value => value && own.includes(canonicalUrl(value))));
      if (!stored) return chrome?.found !== true && renderSample.has(canonicalUrl(url)) ? { state: 'unknown', reason: CHROME_MISSING } : null;
      if (challenge_status.includes(stored.status)) return { state: 'unknown', reason: RENDER_BLOCKED, stored };
      if (!stored.dom_ref || stored.blocked_reason) return { state: 'unknown', reason: RENDER_FAILED, stored };
      const dom = renderTextOf(stored);
      const rawLength = bodyLength(html), renderedLength = bodyLength(dom);
      // A challenge page is short; a long page that happens to quote a marker is judged on its content.
      const markerText = `${stored.title ?? ''} ${renderedLength <= challenge_max_body_chars ? visibleText(dom) : ''}`.toLowerCase();
      if (challenge_markers.some(marker => markerText.includes(marker))) return { state: 'unknown', reason: RENDER_BLOCKED, stored };
      // The counts belong to the page, so they travel in the measurement and the reason stays the same for every page.
      const measurement = { raw_body_characters: rawLength, rendered_body_characters: renderedLength };
      const ratio = renderedLength === 0 ? (rawLength > 0 ? Infinity : 0) : rawLength / renderedLength;
      if (ratio >= min_body_ratio && squash(info.title) === squash(stored.title)
          && sameOriginLinks(anchorLinks(html, artifact.final_url), artifact.final_url).length === stored.links.length) {
        const reason = 'Raw HTML holds the rendered body text, with the same title and link count';
        return { state: 'not_applicable', reason, stored, extra: { measurement, applicability_decision: { condition: 'not_render_dependent', reason, evidence_ref: artifact.evidence_ref } } };
      }
      if (renderedLength > 0) return { state: 'pass', reason: CONTENT_AFTER_RENDER, stored, extra: { measurement } };
      if (rawLength > 0) return { state: 'pass', reason: 'The raw HTML holds body text and the render is empty', stored, extra: { measurement } };
      return { state: 'fail', stored, problems: [problem('Neither the raw HTML nor the rendered page has any body text', NO_BODY_TEXT)] };
    };

    const judged = new Map(pageRows.map(row => [row.url, judgeOwn(row)]));
    // Every page of the audit with the verdict its own render gave, by canonical url, and the pages by canonical url.
    const rendered = new Map(pageRows.filter(row => judged.get(row.url)?.stored).map(row => [canonicalUrl(row.url), { row, ...judged.get(row.url) }]));
    const templates = new Map(pageRows.map(row => [row.url, templateAssets(row.html, row.artifact.final_url)]));
    const typeOf = new Map(context.protocol.page_types.flatMap(type => type.urls.map(item => [canonicalUrl(item.normalized), type])));
    const inherit = ({ url, artifact, html }) => {
      const type = typeOf.get(canonicalUrl(url));
      // Only when every rendered page of the type gives one usable verdict, and from the rendered page that loads the same scripts and
      // stylesheets as this page (the first path segment groups leftovers and list and detail pages as well as templates).
      const peers = (type?.urls ?? []).map(item => rendered.get(canonicalUrl(item.normalized))).filter(Boolean);
      const usable = peers.length > 0 && ['pass', 'not_applicable'].includes(peers[0].state) && peers.every(peer => peer.state === peers[0].state);
      const from = usable ? peers.find(peer => sameTemplate(templates.get(peer.row.url), templates.get(url))) : null;
      const rawLength = bodyLength(html);
      if (!from || !from.stored.evidence_ref || renderSample.has(canonicalUrl(url)) || rawLength === 0) return null;
      const evidence_ref = from.stored.evidence_ref;
      const measurement = { raw_body_characters: rawLength, template: { scripts: templates.get(url).scripts.length, head_assets: templates.get(url).head.length },
        inherited_from: { url: from.row.url, state: from.state, page_type: type.id, render_ref: evidence_ref } };
      const basis = `inferred from ${from.row.url}, the rendered page of the same type that loads the same scripts and stylesheets; this page's raw HTML holds body text too`;
      if (from.state === 'pass') return { state: 'pass', evidence_ref, reason: `${from.reason} (${basis})`, extra: { measurement } };
      const reason = `Inferred from ${from.row.url}, the rendered page of the same type that loads the same scripts and stylesheets, which does not depend on rendering; this page's raw HTML holds body text too`;
      return { state: 'not_applicable', evidence_ref, reason, extra: { measurement, applicability_decision: { condition: 'not_render_dependent', reason, evidence_ref } } };
    };

    return pageRows.flatMap(row => {
      const { url, artifact } = row;
      const own = judged.get(url);
      const verdict = own ? (({ stored, ...rest }) => rest)(own) : inherit(row);
      return verdict ? [makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), evidence_ref: artifact.evidence_ref, ...verdict })] : [];
    });
  },
};

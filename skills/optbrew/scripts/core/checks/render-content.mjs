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

/**
 * The raw HTML against the stored render of the same page. A page whose raw body, title and link count already match the render
 * does not depend on rendering. One that depends on it passes when the render shows content and fails when neither the raw HTML
 * nor the render has any. A challenge page (a challenge status, or a marker in the title or in a short body) and a render that did
 * not finish are unknown, and so is a page of the render sample with no render when the run did not record a Chrome.
 *
 * A page outside the render sample inherits the verdict of the sampled page of its own page type when that verdict is a pass or a
 * not-applicable: the pages of one type share a template, and the reason names the sampled page. A not-applicable is inherited only
 * by a page whose own raw HTML has body text. With no usable sampled page of its type, such a page gets no verdict here.
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
      if (challenge_status.includes(stored.status)) return { state: 'unknown', reason: RENDER_BLOCKED };
      if (!stored.dom_ref || stored.blocked_reason) return { state: 'unknown', reason: RENDER_FAILED };
      const dom = renderTextOf(stored);
      const rawLength = bodyLength(html), renderedLength = bodyLength(dom);
      // A challenge page is short; a long page that happens to quote a marker is judged on its content.
      const markerText = `${stored.title ?? ''} ${renderedLength <= challenge_max_body_chars ? visibleText(dom) : ''}`.toLowerCase();
      if (challenge_markers.some(marker => markerText.includes(marker))) return { state: 'unknown', reason: RENDER_BLOCKED };
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
    // The sampled pages whose own render gave a verdict a page of the same type can take over, by canonical url.
    const sampled = new Map([...judged].filter(([, verdict]) => ['pass', 'not_applicable'].includes(verdict?.state))
      .map(([url, verdict]) => [canonicalUrl(url), { url, ...verdict }]));
    const typeOf = new Map(context.protocol.page_types.flatMap(type => type.urls.map(item => [canonicalUrl(item.normalized), type])));
    const inherit = ({ url, artifact, html }) => {
      const type = typeOf.get(canonicalUrl(url));
      const from = type?.urls.map(item => sampled.get(canonicalUrl(item.normalized))).find(Boolean);
      const rawLength = bodyLength(html);
      if (!from || renderSample.has(canonicalUrl(url)) || from.state === 'not_applicable' && rawLength === 0) return null;
      const evidence_ref = from.stored.evidence_ref ?? artifact.evidence_ref;
      const measurement = { raw_body_characters: rawLength, inherited_from: { url: from.url, state: from.state, page_type: type.id, render_ref: from.stored.evidence_ref ?? null } };
      if (from.state === 'pass') return { state: 'pass', evidence_ref, reason: `${from.reason} (inferred from ${from.url}, the rendered page of the same type)`, extra: { measurement } };
      const reason = `Inferred from ${from.url}, the rendered page of the same type, which does not depend on rendering; this page's raw HTML holds body text too`;
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

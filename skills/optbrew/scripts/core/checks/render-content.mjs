import { thresholds } from '../config.mjs';
import { anchorLinks, visibleText } from '../html.mjs';
import { canonicalUrl, sameOriginLinks } from '../link-graph.mjs';
import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'render-content';
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
 * not finish are unknown, and so is a page of the render sample with no render when the run did not record a Chrome. A page
 * outside the render sample gets no verdict here.
 */
export const renderContent = {
  family_id: FAMILY,
  derive({ pageRows, renders, renderTextOf, chrome, renderSample }) {
    const { min_body_ratio, challenge_status, challenge_markers, challenge_max_body_chars } = thresholds(FAMILY);
    const out = [];
    for (const { url, artifact, html, info } of pageRows) {
      const observe = (state, reason, extra = {}) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), state, reason,
        evidence_ref: artifact.evidence_ref, extra }));
      const own = [canonicalUrl(url), canonicalUrl(artifact.final_url)];
      const stored = renders.find(render => [render.url, render.final_url].some(value => value && own.includes(canonicalUrl(value))));
      if (!stored) {
        if (chrome?.found !== true && renderSample.has(canonicalUrl(url))) observe('unknown', CHROME_MISSING);
        continue;
      }
      if (challenge_status.includes(stored.status)) { observe('unknown', RENDER_BLOCKED); continue; }
      if (!stored.dom_ref || stored.blocked_reason) { observe('unknown', RENDER_FAILED); continue; }
      const dom = renderTextOf(stored);
      const rawLength = bodyLength(html), renderedLength = bodyLength(dom);
      // A challenge page is short; a long page that happens to quote a marker is judged on its content.
      const markerText = `${stored.title ?? ''} ${renderedLength <= challenge_max_body_chars ? visibleText(dom) : ''}`.toLowerCase();
      if (challenge_markers.some(marker => markerText.includes(marker))) { observe('unknown', RENDER_BLOCKED); continue; }
      const ratio = renderedLength === 0 ? (rawLength > 0 ? Infinity : 0) : rawLength / renderedLength;
      if (ratio >= min_body_ratio && squash(info.title) === squash(stored.title)
          && sameOriginLinks(anchorLinks(html, artifact.final_url), artifact.final_url).length === stored.links.length) {
        const reason = `Raw HTML holds ${rawLength} of ${renderedLength} rendered body characters, with the same title and link count`;
        observe('not_applicable', reason, { applicability_decision: { condition: 'not_render_dependent', reason, evidence_ref: artifact.evidence_ref } });
      } else if (renderedLength > 0) observe('pass', `${CONTENT_AFTER_RENDER}: ${renderedLength} body characters rendered, ${rawLength} in the raw HTML`);
      else if (rawLength > 0) observe('pass', `The raw HTML holds ${rawLength} body characters and the render is empty`);
      else observe('fail', 'Neither the raw HTML nor the rendered page has any body text');
    }
    return out;
  },
};

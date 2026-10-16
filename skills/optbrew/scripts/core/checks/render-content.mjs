import { thresholds } from '../config.mjs';
import { anchorLinks, visibleText } from '../html.mjs';
import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'render-content';
const CHROME_MISSING = 'chrome_missing';
const RENDER_BLOCKED = 'render_blocked';
const RENDER_FAILED = 'render_failed';

const squash = value => String(value ?? '').replace(/\s+/g, ' ').trim();
/** Visible characters of the body, whitespace not counted. */
const bodyLength = html => visibleText(/<body\b[^>]*>([\s\S]*)/i.exec(String(html ?? ''))?.[1] ?? html).replace(/\s/g, '').length;
/** Distinct same-origin links without fragments, as the render records them. */
function sameOriginLinks(html, base) {
  const { origin } = new URL(base);
  const found = new Set();
  for (const href of anchorLinks(html, base)) {
    const target = new URL(href); target.hash = '';
    if (target.origin === origin) found.add(target.href);
  }
  return found.size;
}

/**
 * The raw HTML against the stored render of the same page. A page whose raw body, title and link count already match the render
 * does not depend on rendering. One that depends on it passes when the render shows content and fails when neither the raw HTML
 * nor the render has any. A challenge page (a challenge status or marker) and a render that did not finish are unknown, and so is
 * a page with no render when the run did not record a Chrome. A page outside the render sample gets no verdict here.
 */
export const renderContent = {
  family_id: FAMILY,
  derive({ pageRows, renders, renderTextOf, chrome }) {
    const { min_body_ratio, challenge_status, challenge_markers } = thresholds(FAMILY);
    const out = [];
    for (const { url, artifact, html, info } of pageRows) {
      const observe = (state, reason, extra = {}) => out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, url), state, reason,
        evidence_ref: artifact.evidence_ref, extra }));
      const stored = renders.find(render => render.url === url);
      if (!stored) {
        if (chrome?.found !== true) observe('unknown', CHROME_MISSING);
        continue;
      }
      if (challenge_status.includes(stored.status)) { observe('unknown', RENDER_BLOCKED); continue; }
      if (!stored.dom_ref || stored.blocked_reason) { observe('unknown', RENDER_FAILED); continue; }
      const dom = renderTextOf(stored);
      const rendered = visibleText(dom).toLowerCase();
      if (challenge_markers.some(marker => `${stored.title ?? ''} ${rendered}`.toLowerCase().includes(marker))) { observe('unknown', RENDER_BLOCKED); continue; }
      const rawLength = bodyLength(html), renderedLength = bodyLength(dom);
      const ratio = renderedLength === 0 ? (rawLength > 0 ? Infinity : 0) : rawLength / renderedLength;
      if (ratio >= min_body_ratio && squash(info.title) === squash(stored.title) && sameOriginLinks(html, artifact.final_url) === stored.links.length) {
        const reason = `Raw HTML holds ${rawLength} of ${renderedLength} rendered body characters, with the same title and link count`;
        observe('not_applicable', reason, { applicability_decision: { condition: 'not_render_dependent', reason, evidence_ref: artifact.evidence_ref } });
      } else if (renderedLength > 0) observe('pass', `Content shows after rendering: ${renderedLength} body characters rendered, ${rawLength} in the raw HTML`);
      else if (rawLength > 0) observe('pass', `The raw HTML holds ${rawLength} body characters and the render is empty`);
      else observe('fail', 'Neither the raw HTML nor the rendered page has any body text');
    }
    return out;
  },
};

import { contactRoutes } from '../contact-routes.mjs';
import { CONTENT_AFTER_RENDER, renderContent } from './render-content.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'conversion-path';
const UNIT = unitKey(FAMILY, 'site');
const NO_ROUTE = problem('No audited page offers a contact route: no tel:, sms: or mailto: link, no shown phone number, no KakaoTalk channel, ' +
  'open chat, Naver TalkTalk or Naver booking link, and no link to an inquiry, consultation or booking page', 'conversion-path.no-contact-route');
const CHROME_MISSING = 'chrome_missing';
const NEEDS_RENDER = 'No contact route in the pages read, and the site shows content only after rendering, so a route may still be there';
/** A render-content verdict that leaves the raw HTML short of what a visitor sees: content after rendering, or no render to tell. */
const leansOnRender = verdict => verdict.state === 'unknown' || (verdict.state === 'pass' && verdict.reason.startsWith(CONTENT_AFTER_RENDER));

/**
 * One site verdict: pass when any audited page, in its raw HTML or in its stored render, offers a way to get in touch (`contactRoutes`),
 * with the first route of each kind in the measurement. With none found the site fails, unless it may show its content only after
 * rendering, as the render-content check decides: then it is unknown, by `chrome_missing` when the run had no Chrome to render with.
 * No unit is judged without a collected page. Phone numbers are not compared with the confirmed facts here; fact-consistency does that.
 */
export const conversionPath = {
  family_id: FAMILY,
  message_keys: [NO_ROUTE.message_key],
  derive(prepared) {
    const { pageRows, renders, renderTextOf } = prepared;
    if (!pageRows.length) return [];
    const read = [...pageRows.map(row => ({ url: row.url, from: 'raw', evidence_ref: row.artifact.evidence_ref, routes: contactRoutes(row.html, row.artifact.final_url) })),
      ...renders.filter(record => record.dom_ref && !record.blocked_reason).map(record => ({ url: record.url, from: 'render', evidence_ref: record.evidence_ref,
        routes: contactRoutes(renderTextOf(record), record.final_url ?? record.url) }))];
    const found = read.filter(page => page.routes.length);
    if (found.length) {
      const routes = [];
      for (const page of found) for (const { kind, value } of page.routes)
        if (!routes.some(route => route.kind === kind)) routes.push({ kind, value, url: page.url, from: page.from });
      return [makeObservation({ family_id: FAMILY, unit_key: UNIT, state: 'pass', evidence_ref: found[0].evidence_ref,
        reason: 'An audited page offers a contact route', extra: { measurement: { routes } } })];
    }
    const measurement = { pages_read: pageRows.length, renders_read: read.length - pageRows.length };
    const home = pageRows.find(row => new URL(row.artifact.final_url).pathname === '/') ?? pageRows[0];
    const renderVerdicts = prepared.planned.has(renderContent.family_id) ? renderContent.derive(prepared) : [];
    if (prepared.planned.has(renderContent.family_id) && (!renderVerdicts.length || renderVerdicts.some(leansOnRender))) {
      const reason = renderVerdicts.some(verdict => verdict.reason === CHROME_MISSING) ? CHROME_MISSING : NEEDS_RENDER;
      return [makeObservation({ family_id: FAMILY, unit_key: UNIT, state: 'unknown', evidence_ref: home.artifact.evidence_ref, reason, extra: { measurement } })];
    }
    return [makeObservation({ family_id: FAMILY, unit_key: UNIT, state: 'fail', evidence_ref: home.artifact.evidence_ref, problems: [NO_ROUTE], extra: { measurement } })];
  },
};

import { jsonLdBlocks, stripComments } from '../html.mjs';
import { jsonLdTruth } from '../facts.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const FAMILY = 'structured-data-truth';
const PARSE_ERROR = 'structured-data-truth.parse-error';
const FACT_DIFFERS = 'structured-data-truth.fact-differs';
// Microdata and RDFa mark a page up without a JSON-LD block; this check does not read them.
const OTHER_MARKUP = /<[a-z][^>]*\s(?:itemscope|vocab\s*=|typeof\s*=)/i;
const NO_MARKUP = 'The page has no JSON-LD, microdata or RDFa markup';

/**
 * JSON-LD that does not parse fails. A page with no markup at all is not applicable. A page whose JSON-LD states a name, phone number
 * or street address passes when the page shows one it can be compared on and contradicts none, and fails when the page labels a
 * different value. What the JSON-LD says about itself is otherwise not checked for truth, so a page with nothing to compare stays unknown.
 */
export const structuredDataTruth = {
  family_id: FAMILY,
  message_keys: [PARSE_ERROR, FACT_DIFFERS],
  derive({ pageRows, facts }) {
    const factsOf = new Map(facts.map(item => [item.url, item.facts]));
    return pageRows.map(({ url, artifact, html, info }) => {
      const observed = { family_id: FAMILY, unit_key: unitKey(FAMILY, url), evidence_ref: artifact.evidence_ref };
      if (info.jsonld_parse_errors > 0) return makeObservation({ ...observed, state: 'fail', problems: [problem('JSON-LD block(s) fail to parse', PARSE_ERROR)],
        extra: { measurement: { parse_errors: info.jsonld_parse_errors } } });
      const blocks = jsonLdBlocks(html).length;
      if (!blocks) {
        if (OTHER_MARKUP.test(stripComments(html))) return makeObservation({ ...observed, state: 'unknown', reason: 'The page uses microdata or RDFa, which this check does not read' });
        return makeObservation({ ...observed, state: 'not_applicable', reason: NO_MARKUP, extra: { measurement: { jsonld_blocks: 0 },
          applicability_decision: { condition: 'markup_not_used_or_selected', reason: NO_MARKUP, evidence_ref: artifact.evidence_ref } } });
      }
      const { matched, mismatched } = jsonLdTruth(html, factsOf.get(url));
      const measurement = { jsonld_blocks: blocks, matched: matched.map(({ type, jsonld }) => ({ type, jsonld })), mismatched };
      if (mismatched.length) return makeObservation({ ...observed, state: 'fail', extra: { measurement },
        problems: mismatched.map(({ type, jsonld, visible }) => problem(`JSON-LD ${type} "${jsonld}" differs from visible "${visible}"`, FACT_DIFFERS, { type, linked: jsonld, visible })) });
      if (matched.length) return makeObservation({ ...observed, state: 'pass', extra: { measurement },
        reason: 'The name, phone number or address the JSON-LD states is shown on the page, and none is contradicted' });
      return makeObservation({ ...observed, state: 'unknown', extra: { measurement },
        reason: 'The JSON-LD parses, but it states no name, phone number or address that the page text could confirm' });
    });
  },
};

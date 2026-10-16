import { parseRobots, robotsVerdict } from '../../../modules/naver-searchadvisor/scripts/robots.mjs';
import { agentFor } from '../crawlers.mjs';
import { makeObservation, unitKey } from './observation.mjs';

const FAMILY = 'search-crawl-policy';

/** The collected robots.txt against each target engine's crawler, for pages meant to be indexed. */
export const searchCrawlPolicy = {
  family_id: FAMILY,
  derive({ context, pageRows, textOf }) {
    const out = [];
    for (const row of pageRows) {
      if (!row.publicIndexing || row.robots?.status !== 200) continue;
      const parsed = parseRobots(textOf(row.robots));
      const target = new URL(row.artifact.final_url);
      for (const engine of context.protocol.engines) {
        const agent = agentFor(engine);
        if (!agent) continue;
        const verdict = robotsVerdict(parsed, agent, target.pathname + target.search);
        out.push(makeObservation({ family_id: FAMILY, unit_key: unitKey(FAMILY, row.url, engine), state: verdict.allowed ? 'pass' : 'fail',
          reason: verdict.allowed ? `Collected robots.txt allows ${agent} path` : `Collected robots.txt disallows ${agent} path`,
          evidence_ref: row.robots.evidence_ref }));
      }
    }
    return out;
  },
};

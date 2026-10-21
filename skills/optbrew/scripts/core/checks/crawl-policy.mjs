import { parseRobots, robotsVerdict } from '../../../modules/naver-searchadvisor/scripts/robots.mjs';
import { checkRegistry } from '../config.mjs';
import { agentFor } from '../crawlers.mjs';
import { makeObservation, problem, unitKey } from './observation.mjs';

const TOO_MANY_REQUESTS = 429;
/**
 * RFC 9309 2.3.1.3: a robots.txt answered with a 4xx status is unavailable, and the crawler may fetch every path. Google reads 429
 * as a server error, so it stays undecided with 5xx and an unanswered request.
 */
const allowsEverything = status => status >= 400 && status < 500 && status !== TOO_MANY_REQUESTS;

/** The collected robots.txt against the crawler of each target engine the family covers, for pages meant to be indexed. */
function crawlPolicy(family_id) {
  const disallowed = `${family_id}.disallowed`;
  const covered = checkRegistry().families.find(family => family.family_id === family_id).engines;
  return {
    family_id,
    message_keys: [disallowed],
    derive({ context, pageRows, textOf }) {
      const engines = context.protocol.engines.filter(engine => covered.includes(engine));
      const out = [];
      for (const row of pageRows) {
        const status = row.robots?.status;
        if (!row.publicIndexing || (status !== 200 && !allowsEverything(status))) continue;
        const parsed = status === 200 ? parseRobots(textOf(row.robots)) : null;
        const target = new URL(row.artifact.final_url);
        for (const engine of engines) {
          const agent = agentFor(engine);
          if (!agent) continue;
          const allowed = !parsed || robotsVerdict(parsed, agent, target.pathname + target.search).allowed;
          const reason = parsed ? `Collected robots.txt allows ${agent} path` : `Collected robots.txt answered HTTP ${status}, which allows every path`;
          out.push(makeObservation({ family_id, unit_key: unitKey(family_id, row.url, engine), state: allowed ? 'pass' : 'fail',
            evidence_ref: row.robots.evidence_ref, ...(allowed ? { reason }
              : { problems: [problem(`Collected robots.txt disallows ${agent} path`, disallowed, { agent })] }) }));
        }
      }
      return out;
    },
  };
}

export const searchCrawlPolicy = crawlPolicy('search-crawl-policy');
export const aiCrawlerPolicy = crawlPolicy('ai-crawler-policy');

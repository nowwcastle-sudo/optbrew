import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { aiCrawlerPolicy, searchCrawlPolicy } from '../skills/optbrew/scripts/core/checks/crawl-policy.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { buildScenario, page, startSite } from './support/review-scenario.mjs';

const PAGE = 'https://cafe.example.kr/menu';
const ENGINES = ['google', 'naver', 'chatgpt', 'claude', 'perplexity'];
const rowWith = robots => ({ url: PAGE, publicIndexing: true, artifact: { final_url: PAGE }, robots: { evidence_ref: 'evidence/robots', ...robots } });
const derive = (block, robots, body = '') => block.derive({ context: { protocol: { engines: ENGINES } }, pageRows: [rowWith(robots)], textOf: () => body });
const verdicts = observations => Object.fromEntries(observations.map(x => [x.unit_key.split('|')[1], x.state]));

test('each crawler check judges only its own engines among the targets', () => {
  const body = 'User-agent: *\nAllow: /\n';
  assert.deepEqual(verdicts(derive(searchCrawlPolicy, { status: 200 }, body)), { google: 'pass', naver: 'pass' });
  assert.deepEqual(verdicts(derive(aiCrawlerPolicy, { status: 200 }, body)), { chatgpt: 'pass', claude: 'pass', perplexity: 'pass' });
});

test('a robots.txt answered with 4xx allows every path for both crawler checks (RFC 9309)', () => {
  for (const status of [401, 403, 404, 410]) {
    const observations = [...derive(searchCrawlPolicy, { status }), ...derive(aiCrawlerPolicy, { status })];
    assert.equal(observations.length, ENGINES.length, String(status));
    assert.ok(observations.every(x => x.state === 'pass' && x.evidence_ref === 'evidence/robots'), String(status));
    assert.match(observations[0].reason, new RegExp(`HTTP ${status}, which allows every path`));
  }
});

test('a robots.txt answered 429 or 5xx, or not at all, stays undecided', () => {
  for (const status of [429, 500, 503]) {
    assert.deepEqual(derive(searchCrawlPolicy, { status }), [], String(status));
    assert.deepEqual(derive(aiCrawlerPolicy, { status }), [], String(status));
  }
  assert.deepEqual(searchCrawlPolicy.derive({ context: { protocol: { engines: ENGINES } }, pageRows: [{ ...rowWith({}), robots: null }], textOf: () => '' }), []);
});

test('a disallowed PerplexityBot fails the AI crawler check only', () => {
  const body = 'User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n';
  assert.deepEqual(verdicts(derive(aiCrawlerPolicy, { status: 200 }, body)), { chatgpt: 'pass', claude: 'pass', perplexity: 'fail' });
  assert.deepEqual(verdicts(derive(searchCrawlPolicy, { status: 200 }, body)), { google: 'pass', naver: 'pass' });
  const [failed] = derive(aiCrawlerPolicy, { status: 200 }, body).filter(x => x.state === 'fail');
  assert.deepEqual(failed.problem_messages, [{ message_key: 'ai-crawler-policy.disallowed', message_values: { agent: 'PerplexityBot' } }]);
});

const sites = [];
after(() => Promise.all(sites.map(site => site.close())));
const scenarioOf = async (t, routes, name) => {
  const site = await startSite(routes);
  sites.push(site);
  const scenario = await buildScenario(site, ['/'], { engines: ENGINES, robots: true, name });
  t.after(() => rm(scenario.dir, { recursive: true, force: true }));
  return scenario;
};
const statesOf = (scenario, family) => scenario.packet.baseline.input.observations.filter(x => x.family_id === family).map(x => x.state);

test('a small Korean site with no robots.txt passes both crawler checks, and the report replays it', async t => {
  const scenario = await scenarioOf(t, { '/': { body: page('', '<p>카카오톡 채널로 문의하세요</p>', '동네 카페') } }, 'no-robots');
  assert.deepEqual(statesOf(scenario, 'search-crawl-policy'), ['pass', 'pass']);
  assert.deepEqual(statesOf(scenario, 'ai-crawler-policy'), ['pass', 'pass', 'pass']);
  assert.doesNotThrow(() => buildReport(scenario.packet));
});

test('a blocked PerplexityBot lowers readiness without blocking it, and SEO stays unblocked', async t => {
  const robots = { headers: { 'content-type': 'text/plain' }, body: 'User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n' };
  const scenario = await scenarioOf(t, { '/': { body: page('', '<p>예약은 전화로</p>', '동네 카페') }, '/robots.txt': robots }, 'perplexity-blocked');
  assert.deepEqual(statesOf(scenario, 'ai-crawler-policy').sort(), ['fail', 'pass', 'pass']);
  const scores = buildReport(scenario.packet).json.baseline.scores;
  for (const result of scores) {
    assert.equal(result.blockers.length, 0, result.profile);
    assert.notEqual(result.readiness_status, 'blocked', result.profile);
  }
  assert.ok(scores.find(x => x.profile === 'GEO').N < scores.find(x => x.profile === 'GEO').M, 'the failed unit costs score');
});

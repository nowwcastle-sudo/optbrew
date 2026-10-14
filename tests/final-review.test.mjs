import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import * as naverAudit from '../skills/optbrew/modules/naver-searchadvisor/scripts/audit.mjs';
import { buildScenario, page, startSite } from './support/review-scenario.mjs';

const robotsMeta = content => `<meta name="robots" content="${content}">`;
const site = await startSite({
  '/final': { body: page('', 'Final page body') },
  '/redirect': { status: 301, headers: { location: '/final' } },
  '/meta': { body: page(robotsMeta('noindex')) },
  '/header': { headers: { 'x-robots-tag': 'noindex' }, body: page() },
  '/google-header': { headers: { 'x-robots-tag': 'googlebot: noindex' }, body: page() },
  '/bing-header': { headers: { 'x-robots-tag': 'bingbot: noindex' }, body: page() },
  '/comment': { body: page('<!-- <meta name="robots" content="noindex"> -->') },
  '/script': { body: page('<script>const tag = \'<meta name="robots" content="noindex">\';</script>') },
  '/googlebot': { body: page('<meta name="googlebot" content="noindex">') },
  '/yeti': { body: page('<meta name="yeti" content="noindex">') },
  '/mixed': { body: page(`${robotsMeta('index,follow')}<meta name="googlebot" content="noindex">`) },
  '/notitle': { body: page('', 'No title page', '') },
  '/service': { body: page() },
  '/about': { body: page() },
  '/crawl': { body: page() },
  '/ok': { body: page() },
  '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: Yeti\nDisallow: /crawl\n' },
});
after(() => site.close());

let counter = 0;
async function run(t, paths, options = {}) {
  const scenario = await buildScenario(site, paths, { ...options, name: `s${++counter}` });
  t.after(() => rm(scenario.dir, { recursive: true, force: true }));
  return scenario;
}
const blockers = report => report.json.baseline.scores[0].blockers.length;
const stateOf = (scenario, check, urlPath) => scenario.observation(check, urlPath)?.state;

test('I5: robots meta extraction ignores inert text and selects directives for the target engine', () => {
  const blocked = (html, engines, xRobotsTag = null) => naverAudit.indexingDirectives({ html, engines, xRobotsTag }).blocked;
  assert.equal(blocked(page('<!-- <meta name="robots" content="noindex"> -->'), ['google']), false);
  assert.equal(blocked(page('<script>x = \'<meta name="robots" content="noindex">\'</script><style>/* <meta name="robots" content="noindex"> */</style>'), ['google']), false);
  assert.equal(blocked('<head><textarea><meta name="robots" content="noindex"></textarea></head>', ['google']), false);
  assert.equal(blocked(page(robotsMeta('noindex')), ['google']), true);
  assert.equal(blocked(page(robotsMeta('noindex')), ['naver']), true);
  assert.equal(blocked(page(robotsMeta('NoIndex , nofollow')), []), true);
  assert.equal(blocked(page(robotsMeta('index, max-image-preview:none')), ['google']), false);
  assert.equal(blocked(page('<meta name="googlebot" content="noindex">'), ['google']), true);
  assert.equal(blocked(page('<meta name="googlebot" content="noindex">'), ['naver']), false);
  assert.equal(blocked(page('<meta name="yeti" content="noindex">'), ['naver']), true);
  assert.equal(blocked(page('<meta name="yeti" content="noindex">'), ['google']), false);
  assert.equal(blocked(page(`${robotsMeta('index,follow')}<meta name="googlebot" content="noindex">`), ['google']), true);
  assert.equal(blocked(page(`${robotsMeta('noindex')}<meta name="googlebot" content="index">`), ['google']), true);
  assert.equal(blocked(page('<meta name="googlebot" content="noindex">'), ['google', 'naver']), true);
  assert.equal(blocked('', ['google'], 'noindex'), true);
  assert.equal(blocked('', ['google'], 'googlebot: noindex'), true);
  assert.equal(blocked('', ['naver'], 'googlebot: noindex'), false);
  assert.equal(blocked('', ['google'], 'bingbot: noindex'), false);
  assert.equal(blocked('', ['google'], 'googlebot: nofollow, noindex'), true);
  assert.equal(blocked('', ['google'], 'otherbot: noindex, googlebot: index'), false);
  assert.equal(blocked('', ['google'], 'max-image-preview: none'), false);
  assert.equal(blocked('', ['google'], 'unavailable_after: 25 Jun 2030 15:00:00 PST'), false);
  assert.equal(blocked('', ['google'], 'none'), true);
  const combined = naverAudit.indexingDirectives({ html: page(`${robotsMeta('index')}<meta name="googlebot" content="nosnippet">`), engines: ['google'] });
  assert.equal(combined.robots_meta, 'index, nosnippet');
});

test('I5: audit and report agree on commented, script, googlebot, yeti and header directives', async t => {
  for (const [urlPath, engines, expected] of [
    ['/comment', ['google'], 'pass'], ['/script', ['google'], 'pass'], ['/googlebot', ['google'], 'fail'],
    ['/googlebot', ['naver'], 'pass'], ['/yeti', ['naver'], 'fail'], ['/yeti', ['google'], 'pass'],
    ['/mixed', ['google'], 'fail'], ['/google-header', ['google'], 'fail'], ['/google-header', ['naver'], 'pass'],
    ['/bing-header', ['google'], 'pass'], ['/meta', ['google'], 'fail'], ['/header', ['naver'], 'fail'],
  ]) {
    const scenario = await run(t, [urlPath], { engines });
    assert.equal(stateOf(scenario, 'index-policy', urlPath), expected, `${urlPath} ${engines}`);
    const report = buildReport(scenario.packet);
    assert.equal(blockers(report), expected === 'fail' ? 1 : 0, `${urlPath} ${engines} blockers`);
  }
  const forged = await run(t, ['/googlebot'], { engines: ['google'] });
  await forged.forgeObservations(list => {
    const observation = list.find(x => x.check_id === 'index-policy');
    Object.assign(observation, { state: 'pass', q: 1, reason: 'Forged positive' });
  });
  assert.throws(() => buildReport(forged.packet), /title\/index verdict differs from raw response and headers/);
  const commented = await run(t, ['/comment'], { engines: ['google'] });
  await commented.forgeObservations(list => {
    const observation = list.find(x => x.check_id === 'index-policy');
    Object.assign(observation, { state: 'fail', q: 0, reason: 'Forged failure' });
  });
  assert.throws(() => buildReport(commented.packet), /index-policy noindex verdict is absent|verdict differs/);
});

test('I3: a permitted redirect keeps both URLs and the chain, and a foreign module is still refused', async t => {
  const direct = await run(t, ['/final']);
  assert.doesNotThrow(() => buildReport(direct.packet));
  const redirected = await run(t, ['/redirect']);
  assert.doesNotThrow(() => buildReport(redirected.packet));
  const [artifact] = redirected.audit.artifacts;
  assert.equal(artifact.normalized_url, `${site.origin}/redirect`);
  assert.equal(artifact.final_url, `${site.origin}/final`);
  assert.equal(artifact.redirect_chain.length, 1);
  const [module] = redirected.audit.module_outputs['naver-searchadvisor'];
  assert.equal(module.requested_url, artifact.normalized_url);
  assert.equal(module.url, artifact.final_url);
  assert.equal(module.redirect_chain.length, 1);
  const modules = redirected.evidence('modules.json');
  await redirected.rewrite(modules, value => { value['naver-searchadvisor'][0].url = `${site.origin}/other`; });
  assert.throws(() => buildReport(redirected.packet), /title\/index verdict lacks bound raw response/);
  await redirected.rewrite(modules, value => {
    value['naver-searchadvisor'][0].url = artifact.final_url;
    value['naver-searchadvisor'][0].requested_url = `${site.origin}/final`;
  });
  assert.throws(() => buildReport(redirected.packet), /title\/index verdict lacks bound raw response/);
});

test('I4: a header-only noindex finding is validated by the same replay verdict as the observation', async t => {
  const header = await run(t, ['/header']);
  const observation = header.observation('index-policy', '/header');
  assert.equal(observation.state, 'fail');
  header.packet.findings = [header.finding(observation)];
  assert.equal(buildReport(header.packet).json.findings[0].check_id, 'index-policy');

  const meta = await run(t, ['/meta']);
  meta.packet.findings = [meta.finding(meta.observation('index-policy', '/meta'))];
  assert.equal(buildReport(meta.packet).json.findings.length, 1);

  const pair = await run(t, ['/header', '/final']);
  const failing = pair.observation('index-policy', '/header');
  const clean = pair.observation('index-policy', '/final');
  pair.packet.findings = [pair.finding(failing, { evidence_ref: clean.evidence_ref })];
  assert.throws(() => buildReport(pair.packet), /noindex evidence/);
  pair.packet.findings = [pair.finding(clean)];
  assert.throws(() => buildReport(pair.packet), /no matching check observation|noindex evidence/);
});

test('I1: report replay re-derives crawl-policy pass and fail from the bound raw robots bytes', async t => {
  const crawl = await run(t, ['/crawl'], { engines: ['naver'], robots: true });
  assert.equal(stateOf(crawl, 'search-crawl-policy', '/crawl'), 'fail');
  assert.equal(blockers(buildReport(crawl.packet)), 1);

  await crawl.forgeObservations(list => Object.assign(list.find(x => x.check_id === 'search-crawl-policy'),
    { state: 'pass', q: 1, reason: 'Forged allow while raw Disallow remains unchanged' }));
  await crawl.rewrite(crawl.evidence('modules.json'), value => { value['naver-searchadvisor'][0].robots.yeti_allowed = true; });
  assert.throws(() => buildReport(crawl.packet), /crawl verdict differs from bound robots evidence/);

  const allowed = await run(t, ['/ok'], { engines: ['naver'], robots: true });
  assert.equal(stateOf(allowed, 'search-crawl-policy', '/ok'), 'pass');
  assert.doesNotThrow(() => buildReport(allowed.packet));
  await allowed.forgeObservations(list => Object.assign(list.find(x => x.check_id === 'search-crawl-policy'),
    { state: 'fail', q: 0, reason: 'Forged disallow while raw robots allows' }));
  await allowed.rewrite(allowed.evidence('modules.json'), value => { value['naver-searchadvisor'][0].robots.yeti_allowed = false; });
  assert.throws(() => buildReport(allowed.packet), /crawl verdict differs from bound robots evidence/);

  const wrongEvidence = await run(t, ['/crawl'], { engines: ['naver'], robots: true });
  const pageRef = wrongEvidence.audit.artifacts.find(x => x.normalized_url.endsWith('/crawl')).evidence_ref;
  await wrongEvidence.forgeObservations(list => { list.find(x => x.check_id === 'search-crawl-policy').evidence_ref = pageRef; });
  assert.throws(() => buildReport(wrongEvidence.packet), /crawl verdict differs from bound robots evidence|collector observation is not bound/);
});

test('I9: missing title is a confirmed failure and a present title stays unknown without uniqueness evidence', async t => {
  const scenario = await run(t, ['/notitle', '/service', '/ok']);
  assert.equal(stateOf(scenario, 'document-title', '/notitle'), 'fail');
  for (const urlPath of ['/service', '/ok']) {
    const observation = scenario.observation('document-title', urlPath);
    assert.equal(observation.state, 'fail', `${urlPath} shares its title with the other page`);
  }
  const unique = await run(t, ['/ok', '/final']);
  const titled = await run(t, ['/ok']);
  assert.equal(stateOf(titled, 'document-title', '/ok'), 'unknown');
  assert.equal(titled.observation('document-title', '/ok').q, null);
  assert.doesNotThrow(() => buildReport(unique.packet));
  assert.doesNotThrow(() => buildReport(scenario.packet));
  await titled.forgeObservations(list => Object.assign(list.find(x => x.check_id === 'document-title'),
    { state: 'pass', q: 1, reason: 'Forged existence pass' }));
  assert.throws(() => buildReport(titled.packet), /title\/index verdict differs from raw response and headers/);
});

test('I6 (round 5): a redirect that has started finishes after the request budget, with separate counts', async t => {
  const before = site.requests.length;
  const limited = await run(t, ['/redirect'], { maxUrls: 1 });
  assert.equal(site.requests.length - before, 2, 'the fetch starts within the budget and its redirect finishes');
  assert.equal(limited.audit.evaluated_count, 1);
  assert.equal(limited.audit.discovered_count, 1);
  assert.equal(limited.audit.request_count, 2);
  assert.equal(limited.audit.limit_reached, false);
  assert.equal(limited.audit.artifacts[0].error ?? null, null);
  assert.equal(limited.audit.artifacts[0].redirect_chain.length, 1);
  assert.equal(JSON.parse(await readFile(limited.evidence('collection.json'), 'utf8')).request_count, 2);
  assert.doesNotThrow(() => buildReport(limited.packet));
});

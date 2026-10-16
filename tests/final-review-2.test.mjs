import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import * as naverAudit from '../skills/optbrew/modules/naver-searchadvisor/scripts/audit.mjs';
import { buildScenario, page, startSite } from './support/review-scenario.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const site = await startSite({
  '/dup-header': { headerList: [['content-type', 'text/html'], ['x-robots-tag', 'bingbot: noarchive'], ['x-robots-tag', 'noindex']], body: page('', 'dup') },
  '/one-line': { headers: { 'x-robots-tag': 'googlebot: noindex' }, body: page('', 'one line') },
  '/semicolon': { body: page('<meta name="robots" content="noindex;nofollow">', 'semicolon') },
  '/plain-header': { headers: { 'x-robots-tag': 'noindex' }, body: page('', 'plain header') },
  '/meta': { body: page('<meta name="robots" content="noindex">', 'meta') },
  '/ok': { body: page('', 'ok page') },
  '/crawl': { body: page('', 'crawl page') },
  '/redirect': { status: 301, headers: { location: '/landed' } },
  '/landed': { body: page('', 'landed page') },
  '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: Yeti\nDisallow: /crawl\n' },
});
after(() => site.close());

let counter = 0;
async function run(t, paths, options = {}) {
  const scenario = await buildScenario(site, paths, { ...options, name: `r2-${++counter}` });
  t.after(() => rm(scenario.dir, { recursive: true, force: true }));
  return scenario;
}
const blockers = report => report.json.baseline.scores[0].blockers.length;
const stateOf = (scenario, check, urlPath) => scenario.observation(check, urlPath)?.state;
const artifactFor = (scenario, urlPath) => scenario.audit.artifacts.find(x => x.normalized_url === site.origin + urlPath);

/** Rewrite a response record and keep the audit index hash in step, as a fully self-consistent forger would. */
async function forgeRecord(scenario, urlPath, mutate) {
  const artifact = artifactFor(scenario, urlPath);
  const record = await scenario.rewrite(artifact.response_ref, value => { mutate(value); });
  await scenario.rewrite(scenario.evidence('evidence-index.json'), value => {
    const entry = value.responses.find(x => x.normalized_url === artifact.normalized_url);
    entry.content_hash = sha(`${JSON.stringify(record, null, 2)}\n`);
  });
}

test('N1: X-Robots-Tag lines stay separate and a crawler prefix scopes only its own line', async t => {
  assert.equal(naverAudit.indexingDirectives({ xRobotsTag: ['bingbot: noarchive', 'noindex'], engines: ['google'] }).blocked, true);
  assert.equal(naverAudit.indexingDirectives({ xRobotsTag: ['googlebot: noarchive', 'noindex'], engines: ['naver'] }).blocked, true);
  assert.equal(naverAudit.indexingDirectives({ xRobotsTag: ['googlebot: noindex'], engines: ['naver'] }).blocked, false);
  assert.equal(naverAudit.indexingDirectives({ xRobotsTag: ['googlebot: nofollow, noindex'], engines: ['google'] }).blocked, true);
  assert.equal(naverAudit.indexingDirectives({ xRobotsTag: ['bingbot: noindex', 'googlebot: noarchive'], engines: ['google'] }).blocked, false);
  for (const [urlPath, engines, expected] of [['/dup-header', ['google'], 'fail'], ['/dup-header', ['naver'], 'fail'],
    ['/one-line', ['google'], 'fail'], ['/one-line', ['naver'], 'pass']]) {
    const scenario = await run(t, [urlPath], { engines });
    assert.equal(stateOf(scenario, 'index-policy', urlPath), expected, `${urlPath} ${engines}`);
    assert.equal(blockers(buildReport(scenario.packet)), expected === 'fail' ? 1 : 0, `${urlPath} ${engines} blockers`);
  }
});

test('N7: a semicolon separates robots meta directives like a comma', async t => {
  assert.equal(naverAudit.indexingDirectives({ html: page('<meta name="robots" content="noindex;nofollow">'), engines: ['google'] }).blocked, true);
  assert.equal(naverAudit.indexingDirectives({ html: page('<meta name="robots" content="index;max-image-preview:none">'), engines: ['google'] }).blocked, false);
  const scenario = await run(t, ['/semicolon'], { engines: ['google'] });
  assert.equal(stateOf(scenario, 'index-policy', '/semicolon'), 'fail');
});

test('N3: final URL and header lines are bound to a hashed response record', async t => {
  const crawl = await run(t, ['/crawl'], { engines: ['naver'], robots: true });
  assert.equal(blockers(buildReport(crawl.packet)), 1);
  const ok = `${site.origin}/ok`;
  const forge = async scenario => {
    await scenario.rewrite(scenario.evidence('collection.json'), value => {
      value.artifacts.find(x => x.normalized_url.endsWith('/crawl')).final_url = ok;
    });
    await scenario.rewrite(scenario.evidence('modules.json'), value => {
      const module = value['naver-searchadvisor'][0];
      module.url = ok; module.robots.yeti_allowed = true; module.robots.reason = '일치하는 규칙 없음';
    });
    await scenario.forgeObservations(list => Object.assign(list.find(x => x.check_id === 'search-crawl-policy'),
      { state: 'pass', q: 1, reason: 'forged final URL' }));
  };
  await forge(crawl);
  assert.throws(() => buildReport(crawl.packet), /response record|final URL/);

  const consistent = await run(t, ['/crawl'], { engines: ['naver'], robots: true });
  await forge(consistent);
  await forgeRecord(consistent, '/crawl', record => { record.final_url = ok; });
  assert.throws(() => buildReport(consistent.packet), /final URL differs from the redirect chain/);

  const redirected = await run(t, ['/redirect']);
  assert.doesNotThrow(() => buildReport(redirected.packet));
  const landed = `${site.origin}/elsewhere`;
  await redirected.rewrite(redirected.evidence('collection.json'), value => { value.artifacts[0].final_url = landed; });
  await redirected.rewrite(redirected.evidence('modules.json'), value => { value['naver-searchadvisor'][0].url = landed; });
  await forgeRecord(redirected, '/redirect', record => { record.final_url = landed; });
  assert.throws(() => buildReport(redirected.packet), /final URL differs from the redirect chain/);

  const header = await run(t, ['/plain-header'], { engines: ['google'] });
  assert.equal(stateOf(header, 'index-policy', '/plain-header'), 'fail');
  await header.rewrite(header.evidence('collection.json'), value => {
    const artifact = value.artifacts[0];
    delete artifact.headers['x-robots-tag'];
    if (artifact.header_lines) artifact.header_lines = artifact.header_lines.filter(x => x.name !== 'x-robots-tag');
  });
  await header.rewrite(header.evidence('modules.json'), value => { value['naver-searchadvisor'][0].x_robots_tag = null; });
  await header.forgeObservations(list => Object.assign(list.find(x => x.check_id === 'index-policy'),
    { state: 'pass', q: 1, reason: 'forged header strip' }));
  assert.throws(() => buildReport(header.packet), /response record|module differs|verdict differs/);
});

test('N4: a planned collector observation cannot be deleted from packet and saved observations', async t => {
  const meta = await run(t, ['/meta'], { engines: ['google'] });
  assert.equal(blockers(buildReport(meta.packet)), 1);
  await meta.forgeObservations(list => list.splice(list.findIndex(x => x.check_id === 'index-policy'), 1));
  assert.throws(() => buildReport(meta.packet), /planned collector observation missing/);

  const title = await run(t, ['/ok'], { engines: ['google'] });
  await title.forgeObservations(list => list.splice(list.findIndex(x => x.check_id === 'document-title'), 1));
  assert.throws(() => buildReport(title.packet), /planned collector observation missing/);

  const everything = await run(t, ['/meta'], { engines: ['google'] });
  await everything.forgeObservations(list => { list.length = 0; });
  assert.throws(() => buildReport(everything.packet), /planned collector observation missing/);

  const crawl = await run(t, ['/crawl'], { engines: ['naver'], robots: true });
  await crawl.forgeObservations(list => list.splice(list.findIndex(x => x.check_id === 'search-crawl-policy'), 1));
  assert.throws(() => buildReport(crawl.packet), /planned collector observation missing/);

  const allowed = await run(t, ['/ok'], { engines: ['naver'], robots: true });
  assert.doesNotThrow(() => buildReport(allowed.packet));
});

test('R1: a selected page missing from artifacts and skipped, or a dropped audit snapshot, is rejected', async t => {
  const crawl = await run(t, ['/crawl'], { engines: ['naver'], robots: true });
  assert.doesNotThrow(() => buildReport(crawl.packet));
  const pageUrl = `${site.origin}/crawl`;
  await crawl.rewrite(crawl.evidence('collection.json'), value => {
    value.artifacts = value.artifacts.filter(x => x.normalized_url !== pageUrl);
  });
  await crawl.rewrite(crawl.evidence('evidence-index.json'), value => {
    value.raw = value.raw.filter(x => x.normalized_url !== pageUrl);
    value.responses = value.responses.filter(x => x.normalized_url !== pageUrl);
  });
  await crawl.forgeObservations(list => {
    for (let i = list.length - 1; i >= 0; i--) if (list[i].unit_key.endsWith(pageUrl)) list.splice(i, 1);
  });
  assert.throws(() => buildReport(crawl.packet), /selected page missing from the collection and its skipped list|request ledger/);

  const dropped = await run(t, ['/meta'], { engines: ['google'] });
  assert.equal(blockers(buildReport(dropped.packet)), 1);
  delete dropped.packet.audit_ref;
  await dropped.forgeObservations(list => { list.length = 0; });
  assert.throws(() => buildReport(dropped.packet), /baseline audit snapshot differs from the audit recorded in its run context/);

  const limited = await run(t, ['/redirect'], { maxUrls: 1 });
  assert.doesNotThrow(() => buildReport(limited.packet), 'an artifact cut by the request budget stays a reportable unknown');
});

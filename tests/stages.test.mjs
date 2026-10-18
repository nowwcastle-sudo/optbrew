// @optbrew-chrome
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collect } from '../skills/optbrew/scripts/core/collector.mjs';
import { limits, requestLimit, versions } from '../skills/optbrew/scripts/core/config.mjs';
import { ContractError, validateEntity } from '../skills/optbrew/scripts/core/contracts.mjs';
import { selectRenderPages } from '../skills/optbrew/scripts/core/render.mjs';
import { runStages, stages } from '../skills/optbrew/scripts/core/stages.mjs';
import { proxyTransport } from '../skills/optbrew/scripts/core/transport.mjs';
import { pageBudget } from '../skills/optbrew/scripts/core/page-select.mjs';
import { answersFor, bigSite, brewPage, brewPages, memorySite, preflightOf, questions, quietEnv, SITE, workspace } from './support/run-scenario.mjs';

// Assembled from fragments: the repository never contains a literal key.
const KEY = ['AI', 'za', 'Sy', 'Fake', 'Stage', 'Key', '0123456789', 'abcdefghij', 'KLMN'].join('');
const upTo = (...names) => stages().filter(stage => names.includes(stage.name));

/** A render chrome that finds no browser, in the shape `renderChrome` returns. */
const noChrome = () => ({ open: () => ({ address_vetting: 'pinned', fetchStatic: null, get: async () => null, notFound: () => ({ found: false, reason: 'chrome_not_found' }) }), close: async () => {} });

async function begin(names, over = {}, depsOver = {}) {
  const site = memorySite();
  const answers = answersFor(`${SITE}/`, over);
  const ws = await workspace(answers);
  const deps = { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport, chrome: noChrome(), ...depsOver };
  const { state } = await runStages(upTo(...names), { answers, out: ws.out }, deps);
  return { site, ws, deps, state };
}

test('the stages run in the designed order', () => {
  assert.deepEqual(stages().map(stage => stage.name), ['context', 'collect', 'render', 'cwv', 'derive', 'judge', 'score', 'report']);
  assert.notEqual(stages(), stages(), 'every call gives a list a caller can change');
});

test('runStages stops at a halt, can start at a named stage, and refuses an unknown one', async () => {
  const log = [];
  const step = (name, halt) => ({ name, run: async state => { log.push(name); return { state: { ...state, [name]: true }, ...(halt ? { halt } : {}) }; } });
  const list = [step('a'), step('b', 'stop_here'), step('c')];
  const halted = await runStages(list, {}, {});
  assert.deepEqual(log, ['a', 'b']);
  assert.deepEqual(halted, { state: { a: true, b: true }, halt: 'stop_here' });
  log.length = 0;
  const resumed = await runStages(list, { seed: 1 }, {}, { from: 'c' });
  assert.deepEqual(log, ['c']);
  assert.deepEqual(resumed, { state: { seed: 1, c: true }, halt: null });
  await assert.rejects(runStages(list, {}, {}, { from: 'missing' }), /no stage named missing/);
});

test('context stage fixes the render pages with selectRenderPages', async () => {
  const { state } = await begin(['context'], { facts: [{ key: 'phone', value: '02-555-0142', source_url: `${SITE}/about` }, { key: 'email', value: 'a@brew.test', source_url: `${SITE}/about` }] });
  const { protocol } = state.context;
  assert.deepEqual(protocol.page_types.map(type => type.id), ['home', 'pages']);
  assert.deepEqual(protocol.render.pages, selectRenderPages(protocol.page_types));
  assert.deepEqual(protocol.render.pages.map(page => page.normalized), [`${SITE}/`, `${SITE}/about`]);
  assert.equal(protocol.render.enabled, true);
  assert.equal(state.context.audited, true);
  assert.deepEqual(state.context.environment_probe, state.answers.probe, 'the probe is copied from the answers, not taken again');
  assert.deepEqual(JSON.parse(await readFile(path.join(state.out, 'context.json'), 'utf8')), state.context);
});

test('a fact page the audit cannot cover is recorded in the intake record, not dropped silently', async () => {
  const facts = [{ key: 'phone', value: '1', source_url: 'https://elsewhere.test/contact' }, { key: 'phone', value: '1', source_url: `${SITE}/about` }];
  const { state } = await begin(['context'], { facts });
  const intake = JSON.parse(await readFile(path.join(state.out, 'intake.json'), 'utf8'));
  assert.deepEqual(intake.selection.dropped_fact_pages, [{ url: 'https://elsewhere.test/contact', reason: 'outside_scope' }]);
  assert.equal(intake.selection.pages, 2, 'the home page and the fact page inside the scope');
  assert.deepEqual(intake.selection.start_redirect, null);
});

test('context stage plans question-coverage with its panel, or records why it cannot', async () => {
  const asked = (await begin(['context'])).state.context;
  const plan = (context, id) => context.protocol.families.find(family => family.family_id === id);
  assert.deepEqual(asked.protocol.question_panel, questions);
  assert.equal(plan(asked, 'question-coverage').applicable, true);
  assert.equal(plan(asked, 'answer-clarity').applicable, true);
  const none = (await begin(['context'], { questions: [] })).state.context;
  assert.equal(plan(none, 'question-coverage').applicable, false);
  assert.equal(plan(none, 'question-coverage').applicability_decision.condition, 'no_fixed_questions');
  assert.equal(plan(none, 'answer-clarity').applicability_decision.condition, 'no_matching_questions');
  assert.equal(plan(none, 'naver-markup').applicability_decision.condition, 'naver_not_target');
  const naver = (await begin(['context'], { goals: ['Naver 검색 노출'] })).state.context;
  assert.deepEqual(naver.protocol.engines, ['google', 'naver']);
  assert.equal(plan(naver, 'naver-markup').applicable, true);
});

test('an AI citation goal targets the AI answer engines, and the AI crawler check follows them', async () => {
  const contextOf = async goals => (await begin(['context'], { goals })).state.context;
  const plan = (context, id) => context.protocol.families.find(family => family.family_id === id);
  const ai = await contextOf(['검색 유입', 'AI 답변 인용']);
  assert.deepEqual(ai.protocol.engines, ['google', 'chatgpt', 'claude', 'perplexity']);
  assert.equal(plan(ai, 'ai-crawler-policy').applicable, true);
  const search = await contextOf(['검색 유입']);
  assert.deepEqual(search.protocol.engines, ['google']);
  assert.equal(plan(search, 'ai-crawler-policy').applicability_decision.condition, 'ai_not_target');
  assert.equal(plan(search, 'search-crawl-policy').applicable, true);
});

test('Naver is a target when a goal names it, an owner export is Naver, the start page is Korean or the host is .kr; Google always', async () => {
  const engines = async over => (await begin(['context'], over)).state.context.protocol.engines;
  assert.deepEqual(await engines({ goals: ['검색 유입'] }), ['google']);
  assert.deepEqual(await engines({ goals: ['검색 유입'], owner_exports: [{ kind: 'naver', path: 'naver.txt' }] }), ['google', 'naver']);
  assert.deepEqual(await engines({ owner_exports: [{ kind: 'gsc', path: 'gsc.zip' }] }), ['google']);
  assert.deepEqual(await engines({ url: 'https://brew.example.kr/' }), ['google', 'naver']);
  // A start page that declares lang="ko" in the preflight evidence.
  const pages = brewPages();
  pages['/'] = { body: pages['/'].body.replace('lang="en"', 'lang="ko"') };
  const site = memorySite(pages);
  const ws = await workspace(answersFor(`${SITE}/`));
  await preflightOf(site, `${SITE}/`, ws.out);
  const { state } = await runStages(upTo('context'), { answers: answersFor(`${SITE}/`), out: ws.out }, { env: quietEnv(), selectTransport: site.selectTransport });
  assert.deepEqual(state.context.protocol.engines, ['google', 'naver']);
});

test('max_urls: up to the cap in the answers and the context, never above it', async () => {
  const cap = limits().max_urls_cap;
  const raise = max_urls => answersFor(`${SITE}/`, { max_urls, sample_mode: 'raise' });
  assert.doesNotThrow(() => validateEntity('IntakeAnswers', raise(cap)));
  for (const max_urls of [cap + 1, 0, 1.5]) assert.throws(() => validateEntity('IntakeAnswers', raise(max_urls)), ContractError);
  // The answer "sample" or "raise" and the number must agree.
  const over = limits().max_urls_default + 1;
  assert.throws(() => validateEntity('IntakeAnswers', answersFor(`${SITE}/`, { max_urls: over })), /a sample uses the default limit/);
  assert.throws(() => validateEntity('IntakeAnswers', raise(limits().max_urls_default)), /raised limit must be above/);
  assert.doesNotThrow(() => validateEntity('IntakeAnswers', answersFor(`${SITE}/`, { sample_mode: null, max_urls: limits().max_urls_default })));
  const { state } = await begin(['context'], { max_urls: cap, sample_mode: 'raise' });
  assert.equal(requestLimit(state.context.scope), cap);
  assert.throws(() => validateEntity('RunContext', { ...state.context, scope: { ...state.context.scope, max_urls: cap + 1 } }), /max_urls/);
  assert.equal(requestLimit({}), limits().max_urls_default);
  // A raised limit really lets the crawl go past the default.
  const wide = structuredClone(state.context);
  const count = limits().max_urls_default + 20;
  wide.protocol.page_types = [{ id: 'primary', urls: Array.from({ length: count }, (_, i) => ({ original: `${SITE}/p${i}`, normalized: `${SITE}/p${i}` })) }];
  wide.protocol.auxiliary_resources = [];
  const site = memorySite();
  const result = await collect(wide, site.selected);
  assert.equal(result.request_count, count);
});

test('a goal is a free non-empty string; the answers must carry the installed contract version', () => {
  assert.doesNotThrow(() => validateEntity('IntakeAnswers', answersFor(`${SITE}/`, { goals: ['네이버 검색 노출을 늘리고 싶다', 'AI 답변에 인용되기'] })));
  assert.throws(() => validateEntity('IntakeAnswers', answersFor(`${SITE}/`, { goals: [''] })), ContractError);
  assert.throws(() => validateEntity('IntakeAnswers', answersFor(`${SITE}/`, { goals: [{ id: 'seo' }] })), ContractError);
  assert.throws(() => validateEntity('IntakeAnswers', answersFor(`${SITE}/`, { schema_version: '9.9.9' })), /schema_version/);
  assert.doesNotThrow(() => validateEntity('IntakeAnswers', answersFor(`${SITE}/`, { schema_version: versions().contract_schema })));
  assert.throws(() => validateEntity('IntakeAnswers', answersFor(`${SITE}/`, { owner_exports: [{ kind: 'bing', path: 'x' }] })), ContractError);
});

test('collect hands the transport choice, address vetting included, to the collector', async () => {
  const proxy = { host: 'proxy.test', port: 3128 };
  const seen = [];
  const transport = Object.assign(async ({ url }) => {
    seen.push(url.href);
    return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><head><title>T</title></head><body>hello</body></html>') };
  }, { addressVetting: 'proxy' });
  const { state } = await begin(['context', 'collect'], {}, { selectTransport: async () => ({ transport, resolve: async () => [], address_vetting: 'proxy', proxy }) });
  assert.ok(seen.includes(`${SITE}/`), 'the page was fetched through the proxy-vetted transport');
  assert.ok(state.audit.artifacts.every(artifact => artifact.status === 200));
  // The same transport with direct vetting would have refused the unresolved name.
  const direct = await begin(['context', 'collect'], {}, { selectTransport: async () => ({ transport: proxyTransport(proxy), resolve: async () => [], address_vetting: 'direct', proxy }) });
  assert.ok(direct.state.audit.artifacts.every(artifact => artifact.status === null), 'pass-through is the only thing that lets it fetch');
});

test('the render stage records the Chrome result in the audit index', async () => {
  const { state } = await begin(['context', 'collect', 'render']);
  assert.deepEqual(state.chrome_result, { found: false, reason: 'chrome_not_found' });
  assert.deepEqual((await state.store.index()).chrome, { found: false, reason: 'chrome_not_found' });
});

test('the field-data stage reads the key through keyHome and sends it in the header only', async () => {
  const site = memorySite();
  const answers = answersFor(`${SITE}/`);
  const ws = await workspace(answers);
  const home = path.join(ws.dir, 'userhome');
  await mkdir(path.join(home, '.optbrew'), { recursive: true });
  await writeFile(path.join(home, '.optbrew', 'credentials.json'), JSON.stringify({ google: KEY }));
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return { status: 404, text: async () => JSON.stringify({ error: { message: 'something else' } }) }; };
  const env = { ...quietEnv(), USERPROFILE: home, HOME: home };
  const deps = { env, selectTransport: site.selectTransport, chrome: noChrome(), fetchFn };
  const { state } = await runStages(upTo('context', 'collect', 'render', 'cwv'), { answers, out: ws.out }, deps);
  assert.equal(calls[0].init.headers['x-goog-api-key'], KEY);
  assert.ok(calls.every(call => !call.url.includes(KEY)));
  const { cwv } = await state.store.index();
  assert.ok(cwv.length > 0);
  for (const entry of cwv) assert.ok(!(await readFile(entry.evidence_ref, 'utf8')).includes(KEY));
  assert.equal(state.lab_cwv, null, 'no Chrome, so no lab measure');
});

test('page selection leaves a redirect margin: with 301s among the selected pages every page and every declared resource is fetched (R80 E)', async () => {
  const pages = bigSite(60);
  const redirecting = [3, 9, 20];
  for (const n of redirecting) {
    pages[`/section/page-${n}`] = { redirect: `/section/page-${n}-moved` };
    pages[`/section/page-${n}-moved`] = brewPage(`Moved ${n}`, ['/']);
  }
  const site = memorySite(pages);
  const answers = answersFor(`${SITE}/`);
  const ws = await workspace(answers);
  await preflightOf(site, `${SITE}/`, ws.out);
  const deps = { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport, chrome: noChrome() };
  const { state } = await runStages(upTo('context', 'collect'), { answers, out: ws.out }, deps);
  const { protocol } = state.context;
  const selected = protocol.page_types.flatMap(type => type.urls.map(url => url.normalized));
  const declared = protocol.auxiliary_resources.map(resource => resource.normalized);
  const limit = requestLimit(state.context.scope);
  assert.equal(selected.length, pageBudget(limit, declared.length), 'the selection takes the budget, not the whole limit');
  assert.ok(selected.length + declared.length < limit, 'a margin stays for redirect hops');
  assert.ok(redirecting.every(n => selected.includes(`${SITE}/section/page-${n}`)), 'the redirecting pages are among the selected');
  const fetched = new Map(state.audit.artifacts.map(artifact => [artifact.normalized_url, artifact]));
  for (const url of [...selected, ...declared]) assert.equal(fetched.get(url)?.status, 200, `${url} was fetched and answered 200 after any redirect`);
  assert.deepEqual(state.audit.skipped, [], 'nothing was left out');
  assert.equal(state.audit.limit_reached, false);
  assert.equal(state.audit.request_count, selected.length + declared.length + redirecting.length, 'each redirect cost one extra request');
});

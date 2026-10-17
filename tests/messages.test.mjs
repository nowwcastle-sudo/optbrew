import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { blocks } from '../skills/optbrew/scripts/core/checks/index.mjs';
import { koText } from '../skills/optbrew/scripts/core/messages.mjs';
import { mergeFindings, messageKey, problemsOf } from '../skills/optbrew/scripts/core/findings.mjs';
import { canonicalUrl } from '../skills/optbrew/scripts/core/link-graph.mjs';
import { compareFacts, pageFacts } from '../skills/optbrew/scripts/core/facts.mjs';
import { composeReport, pagesLabel, renderReport } from '../skills/optbrew/scripts/core/report-compose.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { renderHtmlReport } from '../skills/optbrew/scripts/core/report-html.mjs';
import { auditCollected } from '../skills/optbrew/modules/naver-searchadvisor/scripts/audit.mjs';
import { selectCapabilities } from '../skills/optbrew/scripts/core/capabilities.mjs';
import { fixturePacket, verifiedOf } from './support/compose.mjs';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const catalog = JSON.parse(read('../skills/optbrew/references/messages.ko.json'));
const remediations = JSON.parse(read('../skills/optbrew/references/remediations.json')).items;
const golden = JSON.parse(read('./fixtures/golden/observations-0.1.4.json'));
const block = familyId => blocks.find(item => item.family_id === familyId);

const PLACEHOLDER = /\{(\w+)(?::([\w-]+))?\}/g;
const placeholders = template => [...template.matchAll(PLACEHOLDER)].map(match => ({ name: match[1], table: match[2] ?? null }));
const namesOf = template => [...new Set(placeholders(template).map(item => item.name))].sort();

// Inputs that make each check fail in every way it can; the golden file covers the rest of what real audits emit.
const PAGE = 'https://s.test/';
const OTHER = 'https://s.test/en';
const THIRD = 'https://s.test/fr';
const artifact = url => ({ evidence_ref: 'evidence/e.html', final_url: url, normalized_url: url, redirect_chain: [], status: 200, headers: {} });
const row = (url, over = {}) => ({ url, artifact: artifact(url), html: '', info: { title: '' }, publicIndexing: true, ...over });
const markup = (html, robots = null) => auditCollected({ artifact: artifact(PAGE), html, engines: ['naver'], robotsArtifact: robots });
const naverRow = info => ({ url: PAGE, artifact: artifact(PAGE), info });
const factList = pages => Object.entries(pages).map(([url, html]) => ({ url, row: row(url), facts: pageFacts(html) }));
const factPage = (body, telephone) => `<html><head><title>x</title>${telephone ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'LocalBusiness', name: 'Brew', telephone })}</script>` : ''}</head><body>${body}</body></html>`;
const conflicting = factList({ '/': factPage('<p>Phone: 02-555-0142</p>'), '/a': factPage('<p>Phone: 02-555-0142</p>'), '/b': factPage('<p>Phone: 02-555-0199</p>') });
const jsonLdOff = factList({ '/': factPage('<p>Phone: 02-555-0142</p>', '02-555-0199') });
const jsonLdMismatch = factPage('<p>Phone: 02-555-0142</p>', '02-555-0199');
const cwvRecord = { source: 'crux', origin: 'https://s.test', status: 200, evidence_ref: 'evidence/c.json', body: { record: { metrics: {
  largest_contentful_paint: { percentiles: { p75: 9000 } }, interaction_to_next_paint: { percentiles: { p75: 900 } }, cumulative_layout_shift: { percentiles: { p75: '0.9' } } } } } };
const fieldInput = { context: { evidence_ref: 'context.json' }, artifacts: [], selected: new Map([[PAGE, {}]]), cwv: [cwvRecord] };
const orgFact = (url, orgs) => ({ url, row: row(url), facts: { orgs } });

/** Two pages: one with a relative canonical, a repeated title word, a blocked stylesheet and no Open Graph, one with no canonical at all. */
const naverRuns = () => block('naver-markup').derive({ context: { protocol: { engines: ['naver'] } }, pageRows: [
  naverRow(markup('<html><head><title>brew brew brew shop</title><link rel="canonical" href="/x"><link rel="stylesheet" href="/blocked.css"></head><body></body></html>',
    { status: 200, body: 'User-agent: Yeti\nDisallow: /blocked.css\n' })),
  naverRow(markup('<html><head><title>Brew</title></head><body></body></html>'))] });

const runs = [
  () => block('structured-data-truth').derive({ pageRows: [row(PAGE, { html: jsonLdMismatch, info: { title: '', jsonld_parse_errors: 0 } }), row(OTHER, { html: '<html></html>', info: { title: '', jsonld_parse_errors: 2 } })],
    facts: factList({ [PAGE]: jsonLdMismatch, [OTHER]: '<html></html>' }) }),
  () => block('render-content').derive({ context: { protocol: { page_types: [] } }, pageRows: [row(PAGE)], renders: [{ url: PAGE, final_url: PAGE, status: 200, dom_ref: 'd', title: '', links: [] }],
    renderTextOf: () => '', chrome: { found: true }, renderSample: new Set([canonicalUrl(PAGE)]) }),
  () => block('discovery').derive({ pageRows: [row(PAGE)], linkGraph: { inbound: () => false }, orphans: new Set([PAGE]),
    sitemaps: { urls: new Set(), broken: ['https://s.test/sitemap.xml (404)'] } }),
  () => block('canonical-consistency').derive({ pageRows: [row(PAGE, { artifact: { ...artifact(PAGE), redirect_chain: ['a', 'b'] }, info: { canonical: 'http://[' } })], artifacts: [] }),
  () => block('internal-navigation').derive({ pageRows: [row(PAGE, { html: '<a href="/a">more</a><a href="/b">more</a>' })], linkGraph: { depthOf: () => 9, scriptGap: false } }),
  () => {
    const self = { urls: [canonicalUrl(PAGE)], alternates: [{ hreflang: 'en', href: OTHER }, { hreflang: 'ko', href: PAGE }] };
    const answer = { urls: [canonicalUrl(OTHER)], alternates: [] };
    const listing = { urls: [canonicalUrl(THIRD)], alternates: [{ hreflang: 'fr', href: PAGE }] };
    return block('locale-links').derive({ pageRows: [row(PAGE)], alternates: new Map([[canonicalUrl(PAGE), self], [canonicalUrl(OTHER), answer], [canonicalUrl(THIRD), listing]]) });
  },
  naverRuns,
  () => block('entity-identity').derive({ facts: [orgFact(PAGE, []), orgFact(OTHER, [{ sameAs: false }])],
    comparison: { separate: new Set(), references: { name: { label: 'Brew' } }, deviations: new Map([[OTHER, ['name "Other" differs from "Brew" on 2 pages']]]) } }),
  () => block('fact-consistency').derive({ facts: conflicting, comparison: compareFacts(conflicting) }),
  () => block('fact-consistency').derive({ facts: jsonLdOff, comparison: compareFacts(jsonLdOff) }),
  ...['lcp-field', 'inp-field', 'cls-field'].map(familyId => () => block(familyId).derive(fieldInput)),
];

/** Every { key, values } the checks state: the stored golden verdicts and the crafted runs above. */
const emitted = [...golden, ...runs.flatMap(run => run())].flatMap(observation => (observation.problem_messages ?? []).map(item => ({ ...item, observation })));

test('every check declares its message keys, and every key a check can emit has a Korean entry', () => {
  for (const item of blocks) assert.ok(Array.isArray(item.message_keys) && item.message_keys.length, `${item.family_id} declares message_keys`);
  const declared = blocks.flatMap(item => item.message_keys);
  assert.equal(new Set(declared).size, declared.length, 'a key belongs to one check');
  for (const key of declared) assert.equal(typeof catalog[key], 'string', `no Korean entry for ${key}`);
});

test('the keys the checks emit are exactly the keys they declare', () => {
  const declared = blocks.flatMap(item => item.message_keys).sort();
  assert.deepEqual([...new Set(emitted.map(item => item.message_key))].sort(), declared);
});

test('placeholders in Korean entries match the values the check emits', () => {
  assert.ok(emitted.length > 40);
  for (const { message_key: key, message_values: values } of emitted) {
    assert.deepEqual(namesOf(catalog[key]), Object.keys(values).sort(), key);
    for (const { name, table } of placeholders(catalog[key])) {
      assert.ok(values[name] !== undefined && values[name] !== null && values[name] !== '', `${key} has a value for ${name}`);
      if (table) assert.equal(typeof catalog[`${table}.${values[name]}`], 'string', `${table} has a word for ${values[name]}`);
    }
  }
});

test('each message lines up with the problem it translates', () => {
  for (const { observation } of emitted) assert.equal(observation.problem_messages.length, problemsOf(observation).length, observation.unit_key);
  const multiple = emitted.filter(({ observation }) => observation.problem_messages.length > 1).map(({ observation }) => observation);
  assert.ok(multiple.length >= 4, 'several checks state more than one problem');
  for (const observation of multiple) assert.equal(observation.measurement.problems.join('; '), observation.reason, observation.check_id);
});

test('naver markup states each problem on its own, not as one joined sentence', () => {
  const [first, second] = naverRuns();
  const problems = problemsOf(first);
  assert.ok(problems.length >= 8 && problems.every(text => !text.includes('; ')), problems.join('|'));
  for (const text of ['canonical is relative: /x', 'title repeats: brew', 'Yeti cannot fetch /blocked.css']) assert.ok(problems.includes(text), text);
  assert.ok(problemsOf(second).includes('canonical link is missing'));
});

test('every remediation field has a Korean entry', () => {
  assert.ok(remediations.length >= 5);
  for (const item of remediations) {
    for (const field of ['mechanism', 'validation', 'effort', 'cost', 'location_hint']) assert.equal(typeof catalog[`remediation.${item.remediation_id}.${field}`], 'string', `${item.remediation_id} ${field}`);
    assert.equal(typeof catalog[`authority.${item.required_authority}`], 'string', item.required_authority);
  }
});

test('the follow-up rows, export problems and cost notes have Korean entries', () => {
  // The path is written in parts: this file runs no stage, so it stays out of the serial Chrome group.
  const stages = read(`../skills/optbrew/scripts/core/${'stages'}.mjs`);
  const codes = [...stages.slice(stages.indexOf('const EXPORT_PROBLEMS'), stages.indexOf('};', stages.indexOf('const EXPORT_PROBLEMS'))).matchAll(/(export_[a-z_]+):/g)].map(match => match[1]);
  assert.ok(codes.length >= 10, codes.join());
  for (const code of codes) assert.equal(typeof catalog[`export-problem.${code}`], 'string', code);
  for (const key of ['follow-up.preflight-unreadable', 'follow-up.export-unusable', 'follow-up.production-pending'])
    for (const line of ['problem', 'reason', 'input', 'next', 'when']) assert.equal(typeof catalog[`${key}.${line}`], 'string', `${key}.${line}`);
  for (const line of ['input', 'next', 'when']) assert.equal(typeof catalog[`follow-up.finding.${line}`], 'string');
  for (const key of ['cost.reservation', 'cost.host-policy', 'cost.bulk-crawl-unverified', 'cost.anthropic', 'cost-status.unknown', 'cost-status.overrun', 'word.unknown'])
    assert.equal(typeof catalog[key], 'string', key);
  // The limitations the capability planner words in English carry the key of their Korean sentence.
  const plan = selectCapabilities([{ capability: 'bulk_crawl', provider: 'p', bounded: true, cost_enforcement: 'host_policy', tool_ref: 't' }], ['bulk_crawl']);
  assert.deepEqual(plan.limitation_messages.map(item => item.message_key), ['cost.bulk-crawl-unverified']);
  const hosted = selectCapabilities([{ capability: 'raw_html', provider: 'p', bounded: true, cost_enforcement: 'host_policy', tool_ref: 't' }], ['raw_html']);
  assert.deepEqual(hosted.limitation_messages, [{ message_key: 'cost.host-policy', message_values: { provider: 'p' } }]);
  assert.equal(plan.limitations.length, plan.limitation_messages.length);
});

test('koText fills values, looks words up, reads a missing value as unknown, and falls back for an unknown key', () => {
  assert.equal(koText('fetch-response.http-error', { status: 404 }, 'HTTP 404'), '이 페이지가 404 오류를 돌려줍니다. 방문자와 크롤러가 열 수 있게 고치세요.');
  assert.match(koText('fact-consistency.differs', { type: 'phone', found: 'a', label: 'b', count: 3 }), /^전화번호 값이/);
  assert.match(koText('fact-consistency.differs', { type: 'fax', found: 'a', label: 'b', count: 3 }), /^fax 값이/);
  assert.match(koText('cost.reservation', { provider: 'p', status: 'unknown', reserved: null, actual: '' }), /예약 알 수 없음, 실제 알 수 없음/);
  assert.equal(koText('no.such.key', {}, 'English'), 'English');
  assert.equal(koText(null, {}, 'English'), 'English');
  assert.equal(koText('no.such.key'), null);
});

test('grouping still uses the English message (R62)', () => {
  const finding = (id, over) => ({ schema_version: '2.0.0', finding_id: id, check_id: 'fetch-response', unit_key: 'fetch-response|https://s.test/a', priority: 'P2', blocker: false,
    message: 'HTTP 404', source_ref: 'optbrew:collector', evidence_ref: 'e', remediation_ids: [], status: 'confirmed', message_key: 'fetch-response.http-error', message_values: { status: 404 }, ...over });
  assert.equal(messageKey('  HTTP   404 '), 'http 404');
  assert.equal(mergeFindings([finding('a'), finding('b', { message: 'http 404', source_ref: 'module:x' })]).length, 1, 'the same English message is one finding');
  assert.equal(mergeFindings([finding('a'), finding('b', { message: 'HTTP 500', message_values: { status: 500 } })]).length, 2, 'another English message is another finding');
  assert.equal(mergeFindings([finding('a'), finding('b', { message_key: 'fetch-response.other' })]).length, 1, 'the Korean key does not group');
});

// What the owner reads: a finding for every message a check can emit, every remediation the catalog has, and one row of each follow-up kind.
const SENTENCE = /(?:^|[^A-Za-z0-9_\-.:/@])(?:[A-Za-z][A-Za-z']*[,.]?\s+){2,}[A-Za-z][A-Za-z']*/;
const PRODUCT_NAMES = /Chrome UX Report|PageSpeed Insights|Core Web Vitals/g;
const withoutIds = text => text.replace(PRODUCT_NAMES, ' ').replace(/https?:\/\/[^\s)<]+/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&lt;|&gt;|&amp;|&quot;|&#39;/g, ' ');
const sectionOf = (page, id) => page.slice(page.indexOf(`<section id="${id}"`), page.indexOf('</section>', page.indexOf(`<section id="${id}"`)));
const everyFailing = () => {
  const english = key => `This English message of ${key} stays in the data only`;
  const findings = emitted.map(({ message_key, message_values, observation }, index) => ({ schema_version: '2.0.0', finding_id: `f${index}`, check_id: observation.check_id,
    unit_key: observation.unit_key, priority: 'P1', blocker: false, message: english(message_key), message_key, message_values, source_ref: 'optbrew:collector', evidence_ref: 'e',
    remediation_ids: [], status: 'confirmed', finding_ids: [`f${index}`], sources: [], remediation: null, resolution: null }));
  const withRemediation = remediations.map((item, index) => ({ ...findings[0], finding_id: `r${index}`, finding_ids: [`r${index}`], unit_key: `fetch-response|https://s.test/r${index}`, remediation: item }));
  const follow = [
    { problem: 'English problem', reason: 'preflight_unreadable', required_input_or_authority: 'English', next_action: 'English', reobserve_when: 'English', message_key: 'follow-up.preflight-unreadable', message_values: {} },
    { problem: 'English problem', reason: 'export_file_missing', required_input_or_authority: 'English', next_action: 'English', reobserve_when: 'English', message_key: 'follow-up.export-unusable', message_values: { kind: 'gsc', reason: 'export_zip_damaged' } },
    { problem: 'English problem', reason: 'production_deployment_pending', required_input_or_authority: 'English', next_action: 'English', reobserve_when: 'English', finding_id: 'f0', message_key: 'follow-up.production-pending', message_values: { pages: 'https://s.test/a' } },
    { finding_id: 'r0', problem: 'English problem', reason: 'confirmed', required_input_or_authority: 'site_owner_edit', next_action: 'English', reobserve_when: 'English', message_key: 'follow-up.finding', message_values: {} },
    { finding_id: 'f0', problem: 'English problem', reason: 'confirmed', required_input_or_authority: 'English', next_action: 'English', reobserve_when: 'English', message_key: 'follow-up.finding', message_values: {} }];
  const verified = verifiedOf({ findings: [...findings, ...withRemediation], follow_ups: follow,
    cost_issues: ['anthropic: unknown (reserved unknown; actual unknown)', 'p: host_policy', 'bulk_crawl: boundary or cost enforcement is host_policy/unverified', 'Anthropic direct v0: text-only'],
    cost_issue_messages: [{ message_key: 'cost.reservation', message_values: { provider: 'anthropic', status: 'unknown', reserved: null, actual: null } },
      { message_key: 'cost.host-policy', message_values: { provider: 'p' } }, { message_key: 'cost.bulk-crawl-unverified', message_values: {} },
      { message_key: 'cost.anthropic', message_values: { version: '0.2.0' } }],
    metric_origin_limitations: ['owner export origin and provider completeness are not independently authenticated', 'provider response origin and semantic evaluations are attributed to indexed receipts, not independently authenticated'],
    metric_origin_limitation_messages: [{ message_key: 'metric-origin.owner-export', message_values: {} }, { message_key: 'metric-origin.panel', message_values: {} }] });
  const composed = { ...composeReport(verified), remaining: [] };
  return { composed, verified, page: renderHtmlReport(composed, { runbooks: [], level: 'beginner', target: PAGE }) };
};

test('report.html section 1 and the follow-ups have no English sentence for a fixture with every check failing', () => {
  const { page } = everyFailing();
  const fixes = withoutIds(sectionOf(page, 'fixes')), later = withoutIds(sectionOf(page, 'remaining'));
  assert.ok(fixes.includes('noindex') && fixes.includes('전화번호 값이'), 'the Korean texts are there');
  assert.doesNotMatch(fixes, /English message/);
  assert.doesNotMatch(fixes, SENTENCE);
  assert.doesNotMatch(later, /English|site_owner_edit|preflight_unreadable/);
  assert.doesNotMatch(later, SENTENCE);
  assert.match(later, /사이트 소유자의 수정 권한/);
  assert.match(later, /이 고침은 내 컴퓨터에서만 확인했습니다: (?!알 수 없음)\S+/, 'the production row names its fix');
  // The run conditions (cost notes, metric limits) are Korean too.
  const conditions = withoutIds(sectionOf(page, 'conditions'));
  assert.match(conditions, /에이전트 프로그램의 설정/);
  assert.match(conditions, /검색 서비스가 돌려준 답의 출처/);
  assert.doesNotMatch(conditions, SENTENCE);
  assert.equal(SENTENCE.test('Raw response blocks indexing for the target engine'), true, 'the detector sees an English sentence');
  assert.equal(SENTENCE.test('robots.txt가 Googlebot의 접근을 막고 있습니다. X-Robots-Tag 헤더, JSON-LD'), false, 'identifiers are not sentences');
});

test('report.md says the same in Korean, and the data keeps the English message and key', () => {
  const { composed, verified } = everyFailing();
  const { markdown, tables } = renderReport(composed, verified);
  assert.doesNotMatch(markdown, /English message/);
  assert.doesNotMatch(withoutIds(tables.remediation.flat().join('\n')), SENTENCE);
  const fix = composed.fixes.find(item => item.message_key === 'index-policy.noindex');
  assert.equal(fix.message, 'This English message of index-policy.noindex stays in the data only');
  assert.match(fix.text_ko.message, /^이 페이지가 noindex로/);
  assert.ok(composed.fixes.every(item => typeof item.text_ko.message === 'string'));
});

test('a finding with no catalog entry (a model\'s) keeps its own words', () => {
  const finding = { schema_version: '2.0.0', finding_id: 'm', check_id: 'index-policy', unit_key: 'index-policy|https://s.test/m', priority: 'P2', blocker: false,
    message: '모델이 쓴 문장', source_ref: 'host_model', evidence_ref: 'e', remediation_ids: [], status: 'confirmed', finding_ids: ['m'], sources: [], remediation: null, resolution: null };
  const [fix] = composeReport(verifiedOf({ findings: [finding, { ...finding, finding_id: 'n', unit_key: 'index-policy|https://s.test/n', message_key: 'not.in.catalog', message: 'English words' }] })).fixes;
  assert.equal(fix.text_ko.message, '모델이 쓴 문장');
});

test('the majority value is never called the reference, and the missing fact list is said (I2)', () => {
  const text = catalog['fact-consistency.differs'];
  assert.doesNotMatch(text, /기준/);
  assert.match(text, /사실 확인용 목록이 없어 페이지끼리만 비교한/);
  assert.match(text, /어느 쪽이 맞는지 확인한 뒤/);
});

test('replay binds the key and values of a finding to the verdict that states its problem (I1)', () => {
  const keyed = (key, values) => {
    const packet = fixturePacket();
    const observation = packet.baseline.input.observations.find(x => x.check_id === 'index-policy' && x.state === 'fail');
    observation.reason = packet.findings[0].message;
    observation.problem_messages = [{ message_key: 'index-policy.noindex', message_values: {} }];
    for (const finding of packet.findings) Object.assign(finding, { message_key: key, message_values: values });
    return packet;
  };
  assert.doesNotThrow(() => buildReport(keyed('index-policy.noindex', {})), 'the recorded key passes');
  assert.throws(() => buildReport(keyed('fetch-response.http-error', { status: 503 })), /finding message key differs from its verdict/);
  assert.throws(() => buildReport(keyed('index-policy.noindex', { status: 503 })), /finding message key differs from its verdict/);
  const unkeyed = fixturePacket();
  assert.doesNotThrow(() => buildReport(unkeyed), 'a finding with no key is still accepted');
});

test('a fix names its address, with the engine in parentheses and no internal prefix (M9)', () => {
  assert.equal(pagesLabel({ unit_key: 'search-crawl-policy|naver|https://s.test/a' }), 'https://s.test/a (네이버)');
  assert.equal(pagesLabel({ unit_key: 'search-crawl-policy|google|https://s.test/a' }), 'https://s.test/a (구글)');
  assert.equal(pagesLabel({ unit_key: 'entity-identity|site' }), '사이트 전체');
  assert.equal(pagesLabel({ unit_key: 'document-title|https://s.test/a|b' }), 'https://s.test/a|b');
});

test('codes in the actual-result, model-judgment and readiness cells read as Korean words; the data keeps the codes (R70)', () => {
  const row = ['provider:x', 'm', 'w', 1, 'unknown', 'unknown', 'unknown → 0.5', 'not_comparable_or_missing_window; measured → zero_or_missing; '];
  const judgment = { phase: 'baseline', family_id: 'document-title', unit_key: 'document-title|https://s.test/', state: 'fail', evidence_ref: 'e', evidence_span: [{ start: 0, end: 1 }], label: 'l' };
  const verified = verifiedOf({ outcome_rows: [row], model_judgments: [judgment] });
  const { tables } = renderReport(composeReport(verified), verified);
  assert.deepEqual(tables.actual_outcomes[0], ['provider:x', 'm', 'w', 1, '알 수 없음', '알 수 없음', '알 수 없음 → 0.5', '비교할 수 없거나 기간이 빠짐; 측정됨 → 0이거나 빠짐; ']);
  assert.equal(tables.model_judgments[0][2], '실패');
  assert.match(tables.score[0][6], /^(막힘|확인 전|임시|측정됨|해당 없음) → /);
  assert.equal(verified.outcome_rows[0][4], 'unknown');
  assert.equal(verified.model_judgments[0].state, 'fail');
});

test('a follow-up row about a fix is told from that fix', () => {
  const fix = { schema_version: '2.0.0', finding_id: 'r', check_id: 'index-policy', unit_key: 'index-policy|https://s.test/r', priority: 'P1', blocker: false,
    message: 'English', message_key: 'index-policy.noindex', message_values: {}, source_ref: 'optbrew:collector', evidence_ref: 'e', remediation_ids: [], status: 'confirmed',
    finding_ids: ['r'], sources: [], remediation: null, resolution: null };
  const row = { finding_id: 'r', problem: 'English', reason: 'confirmed', required_input_or_authority: 'English', next_action: 'English', reobserve_when: 'English', message_key: 'follow-up.finding', message_values: {} };
  const [composed] = composeReport(verifiedOf({ findings: [fix], follow_ups: [row] })).follow_ups;
  assert.match(composed.text_ko.problem, /^이 페이지가 noindex로 색인을 막고 있습니다/);
  assert.equal(composed.text_ko.reason, '확인됨');
  assert.equal(composed.text_ko.next_action, catalog['follow-up.finding.next']);
});

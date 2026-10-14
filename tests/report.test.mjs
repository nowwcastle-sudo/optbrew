import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, copyFileSync, cpSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { normalizeImport } from '../skills/optbrew/scripts/adapters/imports.mjs';
import { measurePanel } from '../skills/optbrew/scripts/core/metrics.mjs';
import { freezeProtocol } from '../skills/optbrew/scripts/core/protocol.mjs';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/reports/remote-only.json', import.meta.url)));
const sha = text => createHash('sha256').update(text).digest('hex');
function copyRun() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'optbrew evidence '));
  const packet = fixture(); packet.evidence_root = dir;
  for (const item of packet.evidence_index)
    copyFileSync(path.resolve('tests/fixtures/reports', item.ref), path.join(dir, item.ref));
  return { dir, packet, rewrite(ref, text) {
    writeFileSync(path.join(dir, ref), text);
    const entry = packet.evidence_index.find(x => x.ref === ref);
    if (entry) entry.sha256 = sha(text);
  } };
}
function addEvidence(run, ref, value, kind = 'record', source_ref) {
  const text = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
  run.rewrite(ref, text);
  run.packet.evidence_index.push({ ref, sha256: sha(text), kind, run_id: 'synthetic-report',
    ...(source_ref ? { source_ref } : {}) });
  return text;
}
function addChange(run, id, { environment = 'local', status = 'passed', deployed = false, receiptHash = sha(`${id} after\n`) } = {}) {
  const before = `${id} before\n`, after = `${id} after\n`;
  addEvidence(run, `${id}-before.txt`, before, 'backup');
  addEvidence(run, `${id}-after.txt`, after, 'change');
  const deployment = deployed ? { target: 'example.com', path: 'site/page.html',
    after_hash: sha(after), evidence_ref: `${id}-deployment.json` } : null;
  if (deployment) addEvidence(run, deployment.evidence_ref, { run_id: 'synthetic-report', environment: 'production',
    target: 'example.com', path: 'site/page.html', after_hash: sha(after), confirmed_by: 'synthetic-fixture' }, 'deployment');
  addEvidence(run, `${id}-verify.json`, { run_id: 'synthetic-report', change_id: id, status, deployed,
    path: 'site/page.html', after_hash: receiptHash, environment, target: 'example.com',
    checks: [{ id: 'raw-response', status: 'passed', observed: 'file hash checked',
      evidence_ref: `${id}-after.txt`, after_hash: sha(after) }], ...(deployment ? { deployment } : {}) }, 'verification');
  run.packet.changes.push({ schema_version: '1.0.0', change_id: id, finding_ids: ['module:a'],
    environment, path: 'site/page.html', before_hash: sha(before), after_hash: sha(after),
    backup_ref: `${id}-before.txt`, evidence_ref: `${id}-after.txt`,
    verification: { status, deployed, evidence_ref: `${id}-verify.json` } });
}
function productionRun() {
  const run = copyRun();
  addChange(run, 'c1', { environment: 'production', deployed: true });
  const afterInput = structuredClone(run.packet.baseline.input);
  const resolved = afterInput.observations.find(x => x.check_id === 'index-policy');
  Object.assign(resolved, { state: 'pass', q: 1, reason: 'raw response allows indexing', evidence_ref: 'after-response.html' });
  addEvidence(run, 'after-response.html', '<html><head><meta name="robots" content="index"></head></html>\n', 'raw_html', 'synthetic');
  run.packet.after = { input: afterInput, scores: score(afterInput) };
  run.packet.comparison = compare(run.packet.baseline.input, afterInput);
  run.packet.changes[0].verification.observation_id = resolved.observation_id;
  run.packet.changes[0].verification.observation_evidence_ref = resolved.evidence_ref;
  const receipt = JSON.parse(readFileSync(path.join(run.dir, 'c1-verify.json'), 'utf8'));
  receipt.observation_id = resolved.observation_id; receipt.observation_evidence_ref = resolved.evidence_ref;
  run.rewrite('c1-verify.json', `${JSON.stringify(receipt)}\n`);
  const evidence = run.packet.evidence_index.find(x => x.ref === resolved.evidence_ref);
  Object.assign(evidence, { phase: 'after', target: 'example.com', environment: 'production', source_url: 'https://example.com/' });
  retargetAfter(run, { environment: 'production' });
  return run;
}
function retargetAfter(run, { target, browser, environment }) {
  const afterInput = run.packet.after.input;
  if (target) afterInput.run_context.target = target;
  if (browser) afterInput.run_context.protocol.browser = browser;
  if (environment) afterInput.run_context.environment = environment;
  afterInput.run_context.evidence_ref = 'after-context.json';
  for (const family of afterInput.run_context.protocol.families)
    if (family.applicability_decision) family.applicability_decision.evidence_ref = 'after-intake.json';
  const save = (ref, value, kind) => run.packet.evidence_index.some(x => x.ref === ref) ?
    run.rewrite(ref, `${JSON.stringify(value)}\n`) : addEvidence(run, ref, value, kind);
  save('after-context.json', afterInput.run_context, 'context');
  const decisions = afterInput.run_context.protocol.families.filter(x => x.applicability_decision).map(x => ({
    scope: 'family', family_id: x.family_id, condition: x.applicability_decision.condition,
    reason: x.applicability_decision.reason }));
  save('after-intake.json', { run_id: 'synthetic-report', target: afterInput.run_context.target,
    protocol_hash: freezeProtocol(afterInput.run_context).protocol_hash,
    approved_by: 'synthetic-fixture', decisions }, 'applicability');
  run.packet.after.scores = score(afterInput);
  run.packet.comparison = compare(run.packet.baseline.input, afterInput);
}
function addNative(run, ref, { start, end, value, property = 'example.com', definition = 'GSC clicks',
    sample_selection = { kind: 'all' }, collected_at = '2026-10-14T10:00:00+09:00', last_complete_date = '2026-10-13' }) {
  const source = { kind: 'native_export', run_id: 'synthetic-report', provider: 'gsc',
    rows: [{ metric_id: 'clicks', value, definition, provider_definition: 'GSC clicks' }],
    metadata: { timezone: 'Asia/Seoul', collected_at, last_complete_date,
      source_ref: 'owner:gsc', evidence_ref: ref, window: { start, end, timezone: 'Asia/Seoul' },
      sample_selection, property, aggregation: 'property' } };
  run.packet.metrics.push(...normalizeImport(source.provider, source.rows, source.metadata));
  addEvidence(run, ref, source, 'native_export', 'owner:gsc');
}
function refreshContext(run) {
  const context = run.packet.run_context;
  run.packet.baseline.input.run_context = structuredClone(context);
  run.packet.baseline.scores = score(run.packet.baseline.input);
  run.rewrite('context.json', `${JSON.stringify(context, null, 2)}\n`);
  const decisions = context.protocol.families.filter(x => x.applicability_decision).map(x => ({ scope: 'family',
    family_id: x.family_id, condition: x.applicability_decision.condition, reason: x.applicability_decision.reason }));
  run.rewrite('intake.json', `${JSON.stringify({ run_id: 'synthetic-report', target: context.target,
    protocol_hash: freezeProtocol(context).protocol_hash, approved_by: 'synthetic-fixture', decisions }, null, 2)}\n`);
}
function setNativeIdentity(run, property = 'example.com', provider = 'gsc') {
  const mapping = { provider, property, target: 'example.com', evidence_ref: 'target-map.json' };
  run.packet.run_context.protocol.target_identity = { target: 'example.com', native_properties: [mapping] };
  addEvidence(run, 'target-map.json', { run_id: 'synthetic-report', target: 'example.com',
    provider, property, approved_by: 'synthetic-fixture' }, 'target_mapping');
  refreshContext(run);
}
function setPanelContext(run, { entity = 'Example', domains = ['example.com'], competitors = [], binding = true } = {}) {
  const context = run.packet.run_context;
  context.protocol.question_panel = [{ id: 'q1', question: 'What?', category: 'brand' }];
  context.protocol.engines = ['claude']; context.protocol.surfaces = ['claude_api'];
  context.protocol.models = ['synthetic']; context.protocol.search_enabled = false;
  if (binding) {
    const panel = { target_entity: entity, target_domains: domains, competitor_entities: competitors,
      evidence_ref: 'panel-target.json' };
    context.protocol.target_identity = { target: 'example.com', native_properties: [], panel };
    addEvidence(run, 'panel-target.json', { run_id: 'synthetic-report', target: 'example.com',
      panel, approved_by: 'synthetic-fixture' }, 'target_mapping');
  }
  const family = context.protocol.families.find(x => x.family_id === 'question-coverage');
  family.applicable = true; delete family.applicability_decision;
  refreshContext(run);
}
function addPanel(run, { entity = 'Example', domains = ['example.com'], competitors = [], fact_list_ref = null,
    responses = null, evaluations = [], withEvidence = true } = {}) {
  const panel = { questions: [{ id: 'q1', question: 'What?', category: 'brand' }], repeats: 1,
    panel_hash: freezeProtocol(run.packet.run_context).protocol_hash, search_enabled: false,
    target_entity: entity, target_domains: domains, competitor_entities: competitors,
    engine: 'claude', surface: 'claude_api', model: 'synthetic', locale: 'ko-KR', region: 'KR',
    window: { start: '2026-09-01', end: '2026-09-28', timezone: 'Asia/Seoul' },
    source_ref: 'synthetic-panel', evidence_ref: 'panel.json', ...(fact_list_ref ? { fact_list_ref } : {}) };
  let allResponses = responses ?? [{ question_id: 'q1', repeat: 0, response_id: 'r1', valid: true,
    cited_urls: ['https://example.com/'], target_mentioned: true, brand_mentions: [entity] }];
  if (withEvidence) {
    allResponses = allResponses.map(response => {
      const rawRef = `provider-${response.response_id}.json`, extractionRef = `extract-${response.response_id}.json`;
      addEvidence(run, rawRef, { run_id: 'synthetic-report', response_id: response.response_id,
        text: `Synthetic answer: ${response.cited_urls?.join(' ') ?? ''}` }, 'provider_response');
      addEvidence(run, extractionRef, { run_id: 'synthetic-report', response_id: response.response_id,
        raw_ref: rawRef, raw_sha256: run.packet.evidence_index.find(x => x.ref === rawRef).sha256,
        normalized_response: response }, 'extraction');
      return { ...response, response_ref: rawRef, extraction_ref: extractionRef };
    });
    evaluations = evaluations.map(evaluation => {
      const ref = `evaluation-${evaluation.response_id}.json`;
      addEvidence(run, ref, { run_id: 'synthetic-report', response_id: evaluation.response_id,
        approved_by: 'synthetic-fixture', evaluation }, 'evaluation');
      return { ...evaluation, evidence_ref: ref };
    });
  }
  const source = { kind: 'panel', run_id: 'synthetic-report', provider_origin: 'synthetic', panel,
    responses: allResponses, evaluations };
  run.packet.metrics = measurePanel(panel, allResponses, evaluations);
  addEvidence(run, 'panel.json', source, 'panel', 'synthetic-panel');
}
function completePanelRun() {
  const run = copyRun(); setPanelContext(run);
  addEvidence(run, 'facts.json', { run_id: 'synthetic-report', target_entity: 'Example',
    approved_by: 'synthetic-fixture', facts: [{ fact_id: 'f1', value: 'synthetic fact' }] }, 'fact_list');
  addEvidence(run, 'citation.html', '<html>Synthetic cited page</html>\n', 'raw_html');
  run.packet.evidence_index.find(x => x.ref === 'citation.html').source_url = 'https://example.com/';
  addEvidence(run, 'claim.html', '<html>Synthetic claim</html>\n', 'raw_html');
  addPanel(run, { fact_list_ref: 'facts.json', evaluations: [{ response_id: 'r1',
    citations: [{ citation_url: 'https://example.com/', evaluable: true, source_accessible: true,
      supported: true, source_evidence_ref: 'citation.html' }],
    claims: [{ fact_id: 'f1', evaluable: true, matches: true, source_evidence_ref: 'claim.html' }] }] });
  return run;
}

test('report recomputes raw scores and keeps remote-only, synthetic and missing outcomes visible', () => {
  const packet = fixture();
  packet.evidence_root = path.resolve('tests/fixtures/reports');
  const { json, markdown } = buildReport(packet);
  assert.deepEqual(json.baseline.scores, score(packet.baseline.input));
  const seo = json.baseline.scores.find(x => x.profile === 'SEO');
  assert.equal(seo.A, 100);
  assert.equal(seo.M, 5.769230769230769);
  assert.equal(seo.N, 2.8846153846153846);
  assert.equal(100 * seo.N / seo.M, 50);
  assert.equal(Math.round(1000 * seo.M / seo.A) / 10, 5.8);
  assert.deepEqual(seo.missing_bounds, [2.9, 97.1]);
  assert.equal(json.comparison.status, 'no_after');
  assert.match(markdown, /Synthetic example/);
  assert.match(markdown, /proposed_only/);
  assert.match(markdown, /not_connected/);
  for (const header of ['Score', 'Remediation', 'Actual outcomes', 'Remaining work']) assert.match(markdown, new RegExp(header));
  assert.match(markdown, /Unexpected \\\| noindex/);
});

test('report rejects stale score, escaped evidence and missing chain', () => {
  const packet = fixture(); packet.evidence_root = path.resolve('tests/fixtures/reports');
  const stale = structuredClone(packet); stale.baseline.scores[0].score = 100;
  assert.throws(() => buildReport(stale), /score/i);
  const escaped = structuredClone(packet); escaped.findings[0].evidence_ref = '../outside';
  assert.throws(() => buildReport(escaped), /evidence|contain/i);
  const noChange = structuredClone(packet); noChange.findings[0].remediation_ids = ['missing'];
  assert.throws(() => buildReport(noChange), /remediation/i);
});

test('raw noindex evidence and hash are both checked; Markdown cannot confirm the directive', () => {
  const run = copyRun();
  try {
    run.rewrite('raw.html', '<html><head><title>Example</title></head></html>');
    assert.throws(() => buildReport(run.packet), /noindex verdict/);
    run.rewrite('raw.html', '<meta name="robots" content="noindex">');
    run.packet.evidence_index.find(x => x.ref === 'raw.html').kind = 'markdown';
    assert.throws(() => buildReport(run.packet), /raw HTML/);
    run.packet.evidence_index.find(x => x.ref === 'raw.html').kind = 'raw_html';
    writeFileSync(path.join(run.dir, 'raw.html'), 'tampered');
    assert.throws(() => buildReport(run.packet), /hash mismatch/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('evidence cannot escape the run directory or carry private identifiers', () => {
  const run = copyRun();
  const outside = mkdtempSync(path.join(os.tmpdir(), 'optbrew outside '));
  try {
    const text = 'outside\n', ref = path.join(outside, 'outside.txt');
    writeFileSync(ref, text);
    run.packet.evidence_index.push({ ref, sha256: sha(text), kind: 'raw', run_id: 'synthetic-report' });
    assert.throws(() => buildReport(run.packet), /outside run directory/);
    run.packet.evidence_index.pop();
    run.rewrite('intake.json', '{"rrn":"900101-1234567"}');
    assert.throws(() => buildReport(run.packet), /private identifier/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('unknown billing and observed overrun remain visible alongside host policy', () => {
  const run = copyRun();
  try {
    run.packet.costs.reservations = [
      { reservation_id: 'r1', provider: 'anthropic', status: 'unknown', upperBounds: [{ unit: 'tokens', amount: 1000128 }], approval_ref: 'synthetic' },
      { reservation_id: 'r2', provider: 'anthropic', status: 'overrun', upperBounds: [{ unit: 'tokens', amount: 1000128 }], approval_ref: 'synthetic' },
    ];
    run.packet.costs.settlements = [
      { reservation_id: 'r1', status: 'unknown', actual: null },
      { reservation_id: 'r2', status: 'overrun', actual: [{ unit: 'tokens', amount: 1000200 }] },
    ];
    run.rewrite('cost-ledger.json', `${JSON.stringify(run.packet.costs, null, 2)}\n`);
    const { json, markdown } = buildReport(run.packet);
    assert.deepEqual(json.costs.settlements[1].actual, [{ unit: 'tokens', amount: 1000200 }]);
    assert.match(markdown, /anthropic: unknown/);
    assert.match(markdown, /anthropic: overrun/);
    assert.match(markdown, /host_policy/);
    assert.match(markdown, /text-only/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('native export is replayed, with ambiguous zero preserved as missing', () => {
  const run = copyRun();
  try {
    setNativeIdentity(run, 'example.com', 'google_ai');
    const source = { kind: 'native_export', run_id: 'synthetic-report', provider: 'google_ai',
      rows: [{ metric_id: 'aoi_clicks', value: 0, provider_definition: 'native clicks' }],
      metadata: { timezone: 'Asia/Seoul', collected_at: '2026-10-14T10:00:00+09:00', source_ref: 'synthetic-export',
        evidence_ref: 'export.json', window: { start: '2026-09-01', end: '2026-09-28', timezone: 'Asia/Seoul' },
        sample_selection: { kind: 'all' }, property: 'example.com', aggregation: 'property' } };
    run.packet.metrics = normalizeImport(source.provider, source.rows, source.metadata);
    const bytes = `${JSON.stringify(source)}\n`;
    run.rewrite('export.json', bytes);
    run.packet.evidence_index.push({ ref: 'export.json', sha256: sha(bytes), kind: 'native_export',
      source_ref: 'synthetic-export', run_id: 'synthetic-report' });
    const { json } = buildReport(run.packet);
    assert.equal(json.metrics[0].value_state, 'zero_or_missing');
    assert.match(json.tables.actual_outcomes[0].at(-1), /zero_or_missing/);
    run.packet.metrics[0].filters.property = 'other.example';
    assert.throws(() => buildReport(run.packet), /metric differs/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('two complete matched native windows report raw before, after and difference', () => {
  const run = copyRun();
  try {
    setNativeIdentity(run);
    const sources = [
      ['before-export.json', '2026-08-06', '2026-09-02', 2],
      ['after-export.json', '2026-09-03', '2026-09-30', 5],
    ];
    for (const [ref, start, end, value] of sources) {
      const source = { kind: 'native_export', run_id: 'synthetic-report', provider: 'gsc',
        rows: [{ metric_id: 'clicks', value, provider_definition: 'GSC clicks' }],
        metadata: { timezone: 'Asia/Seoul', collected_at: '2026-10-14T10:00:00+09:00', last_complete_date: '2026-10-13',
          source_ref: 'owner:gsc', evidence_ref: ref, window: { start, end, timezone: 'Asia/Seoul' },
          sample_selection: { kind: 'all' }, property: 'example.com', aggregation: 'property' } };
      run.packet.metrics.push(...normalizeImport(source.provider, source.rows, source.metadata));
      const text = `${JSON.stringify(source)}\n`; run.rewrite(ref, text);
      run.packet.evidence_index.push({ ref, sha256: sha(text), kind: 'native_export',
        source_ref: 'owner:gsc', run_id: 'synthetic-report' });
    }
    const row = buildReport(run.packet).json.tables.actual_outcomes[0];
    assert.deepEqual(row.slice(3, 6), [2, 5, 3]);
    assert.match(row.at(-1), /comparable_windows/);
    run.packet.metrics[1].filters.country = 'US';
    assert.throws(() => buildReport(run.packet), /metric differs/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('AI panel result is tied to the frozen run protocol and response citations', () => {
  const run = copyRun();
  try {
    setPanelContext(run);
    addPanel(run);
    assert.equal(buildReport(run.packet).json.metrics[2].sample_selection.unknown_citations, 1);
    run.packet.metrics[0].panel_hash = 'wrong';
    assert.throws(() => buildReport(run.packet), /panel hash/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('collector observations bind to the owning audit index and raw content hash', () => {
  const run = copyRun();
  try {
    for (const obs of run.packet.baseline.input.observations) obs.source_ref = 'optbrew:collector';
    run.packet.evidence_index.find(x => x.ref === 'raw.html').source_ref = 'optbrew:collector';
    run.packet.baseline.scores = score(run.packet.baseline.input);
    const observations = `${JSON.stringify(run.packet.baseline.input.observations)}\n`;
    const collection = `${JSON.stringify({ artifacts: [{ normalized_url: 'https://example.com/', final_url: 'https://example.com/',
      evidence_ref: 'raw.html', raw_html_ref: 'raw.html', content_hash: sha(readFileSync(path.join(run.dir, 'raw.html'))),
      capability: 'raw_html', status: 200, headers: {} }] })}\n`;
    const modules = `${JSON.stringify({ 'naver-searchadvisor': [{ url: 'https://example.com/', title: 'Example',
      robots_meta: 'noindex', x_robots_tag: null }] })}\n`;
    const audit = { run_id: 'synthetic-report', context_ref: 'context.json',
      collection_ref: 'collection.json', module_output_ref: 'modules.json', observations_ref: 'observations.json',
      raw: [{ normalized_url: 'https://example.com/', evidence_ref: 'raw.html',
        content_hash: run.packet.evidence_index.find(x => x.ref === 'raw.html').sha256 }] };
    for (const [ref, text] of Object.entries({ 'collection.json': collection, 'modules.json': modules,
      'observations.json': observations, 'audit.json': `${JSON.stringify(audit)}\n` })) {
      run.rewrite(ref, text);
      run.packet.evidence_index.push({ ref, sha256: sha(text), kind: 'audit', run_id: 'synthetic-report' });
    }
    run.packet.audit_ref = 'audit.json';
    assert.equal(buildReport(run.packet).json.baseline.scores[0].readiness_status, 'blocked');
    run.rewrite('modules.json', `${JSON.stringify({ 'naver-searchadvisor': [{ url: 'https://example.com/', title: 'Example',
      robots_meta: null, x_robots_tag: null }] })}\n`);
    assert.throws(() => buildReport(run.packet), /module differs from raw response/);
    run.rewrite('modules.json', modules);
    audit.raw[0].content_hash = '0'.repeat(64);
    run.rewrite('audit.json', `${JSON.stringify(audit)}\n`);
    assert.throws(() => buildReport(run.packet), /audit raw content hash mismatch/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

function localRun({ evidenceHtml = '<html><head><meta name="robots" content="index"></head></html>\n', state = 'pass' } = {}) {
  const run = copyRun();
  addChange(run, 'c1');
  const afterInput = structuredClone(run.packet.baseline.input);
  const observation = afterInput.observations.find(x => x.check_id === 'index-policy');
  Object.assign(observation, { state, q: state === 'pass' ? 1 : 0, reason: 'local rescan', evidence_ref: 'after-response.html' });
  addEvidence(run, 'after-response.html', evidenceHtml, 'raw_html', 'synthetic');
  Object.assign(run.packet.evidence_index.find(x => x.ref === 'after-response.html'),
    { phase: 'after', target: 'example.com', environment: 'local' });
  run.packet.after = { input: afterInput, scores: score(afterInput) };
  retargetAfter(run, { environment: 'local' });
  return run;
}

test('final review I2: a byte-hash receipt alone cannot mark a finding verified_local', () => {
  const hashOnly = copyRun();
  try {
    addChange(hashOnly, 'c1');
    const report = buildReport(hashOnly.packet).json;
    assert.equal(report.findings[0].status, 'modified_unverified');
    assert.equal(report.remaining.filter(x => x.reason === 'production_deployment_pending').length, 0);
    assert.ok(report.remaining.some(x => x.reason === 'modified_unverified'));
  } finally { rmSync(hashOnly.dir, { recursive: true, force: true }); }
  const resolved = localRun();
  try {
    const report = buildReport(resolved.packet).json;
    assert.equal(report.findings[0].status, 'verified_local');
    assert.ok(report.remaining.some(x => x.reason === 'production_deployment_pending'));
  } finally { rmSync(resolved.dir, { recursive: true, force: true }); }
  const unresolved = localRun({ evidenceHtml: '<html><head><meta name="robots" content="noindex"></head></html>\n', state: 'fail' });
  try { assert.equal(buildReport(unresolved.packet).json.findings[0].status, 'modified_unverified'); }
  finally { rmSync(unresolved.dir, { recursive: true, force: true }); }
  const otherTarget = localRun();
  try {
    retargetAfter(otherTarget, { target: 'other.example' });
    assert.equal(buildReport(otherTarget.packet).json.findings[0].status, 'modified_unverified');
  } finally { rmSync(otherTarget.dir, { recursive: true, force: true }); }
  const baselineSource = localRun();
  try {
    baselineSource.packet.evidence_index.find(x => x.ref === 'after-response.html').phase = 'baseline';
    assert.equal(buildReport(baselineSource.packet).json.findings[0].status, 'modified_unverified');
  } finally { rmSync(baselineSource.dir, { recursive: true, force: true }); }
});

test('a local passing receipt stays local and a deployment claim needs its own receipt', () => {
  const run = localRun();
  try {
    assert.equal(buildReport(run.packet).json.findings[0].status, 'verified_local');
    run.packet.changes[0].environment = 'production';
    run.packet.changes[0].verification.deployed = true;
    assert.throws(() => buildReport(run.packet), /verification receipt/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('CLI writes both formats with readback', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'optbrew report '));
  try {
    const input = path.resolve('tests/fixtures/reports/remote-only.json');
    const cli = path.resolve('skills/optbrew/scripts/cli.mjs');
    const out = path.join(dir, 'out');
    const run = spawnSync(process.execPath, [cli, 'report', '--input', input, '--output-dir', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'report.json'))).baseline.scores, score(fixture().baseline.input));
    assert.match(readFileSync(path.join(out, 'report.md'), 'utf8'), /Synthetic example/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('review P1-1: stale production receipt cannot verify different bytes or path', () => {
  const run = copyRun();
  try {
    addChange(run, 'c1', { environment: 'production', deployed: true, receiptHash: '0'.repeat(64) });
    assert.throws(() => buildReport(run.packet), /verification receipt|after_hash/i);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('review P1-1: production status requires same changed bytes, target and after observation', () => {
  const run = productionRun();
  try {
    const receipt = JSON.parse(readFileSync(path.join(run.dir, 'c1-verify.json'), 'utf8'));
    assert.equal(buildReport(run.packet).json.findings[0].status, 'verified_production');
    receipt.observation_evidence_ref = 'raw.html';
    run.rewrite('c1-verify.json', `${JSON.stringify(receipt)}\n`);
    assert.throws(() => buildReport(run.packet), /after observation evidence/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('review fix2: after target must match deployed target while same-target protocol changes remain eligible', () => {
  const sameTarget = productionRun();
  try {
    retargetAfter(sameTarget, { browser: 'Firefox' });
    const report = buildReport(sameTarget.packet).json;
    assert.equal(report.comparison.status, 'not_comparable');
    assert.equal(report.findings[0].status, 'verified_production');
  } finally { rmSync(sameTarget.dir, { recursive: true, force: true }); }
  const otherTarget = productionRun();
  try {
    retargetAfter(otherTarget, { target: 'other.example' });
    const report = buildReport(otherTarget.packet).json;
    assert.equal(report.comparison.status, 'not_comparable');
    assert.equal(report.findings[0].status, 'modified_unverified');
  } finally { rmSync(otherTarget.dir, { recursive: true, force: true }); }
});

test('review fix2: local after context cannot verify production', () => {
  const localAfter = productionRun();
  try {
    retargetAfter(localAfter, { environment: 'local' });
    assert.equal(buildReport(localAfter.packet).json.findings[0].status, 'modified_unverified');
  } finally { rmSync(localAfter.dir, { recursive: true, force: true }); }
});
test('review fix2: differently attributed after source cannot verify production', () => {
  const wrongSource = productionRun();
  try {
    const source = wrongSource.packet.evidence_index.find(x => x.ref === 'after-response.html');
    source.target = 'other.example';
    assert.equal(buildReport(wrongSource.packet).json.findings[0].status, 'modified_unverified');
    source.target = 'example.com'; source.phase = 'baseline';
    assert.equal(buildReport(wrongSource.packet).json.findings[0].status, 'modified_unverified');
  } finally { rmSync(wrongSource.dir, { recursive: true, force: true }); }
});

test('review P1-2: local pass plus a separate production pending change is not verified', () => {
  const run = copyRun();
  try {
    addChange(run, 'local', { environment: 'local', status: 'passed' });
    addChange(run, 'production', { environment: 'production', status: 'pending', deployed: true });
    assert.notEqual(buildReport(run.packet).json.findings[0].status, 'verified_production');
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('review P1-3: other native property and other panel entity/domain cannot become target outcomes', () => {
  const native = copyRun();
  try {
    setNativeIdentity(native);
    addNative(native, 'before-export.json', { start: '2026-08-06', end: '2026-09-02', value: 2, property: 'other.example' });
    addNative(native, 'after-export.json', { start: '2026-09-03', end: '2026-09-30', value: 5, property: 'other.example' });
    assert.throws(() => buildReport(native.packet), /target mapping|property.*target/i);
  } finally { rmSync(native.dir, { recursive: true, force: true }); }
  const panel = copyRun();
  try {
    setPanelContext(panel);
    addPanel(panel, { entity: 'Other', domains: ['other.example'], competitors: ['Example'] });
    assert.throws(() => buildReport(panel.packet), /panel target|target identity/i);
  } finally { rmSync(panel.dir, { recursive: true, force: true }); }
});

test('review P1-3: target mapping is comparison identity and constrains row URL scope and competitor set', () => {
  const native = copyRun();
  try {
    setNativeIdentity(native);
    addNative(native, 'scoped.json', { start: '2026-09-01', end: '2026-09-28', value: 2 });
    const source = JSON.parse(readFileSync(path.join(native.dir, 'scoped.json'), 'utf8'));
    source.rows[0].filters = { hostname: 'other.example', path: '/other/' };
    native.packet.metrics = normalizeImport(source.provider, source.rows, source.metadata);
    native.rewrite('scoped.json', `${JSON.stringify(source)}\n`);
    assert.throws(() => buildReport(native.packet), /hostname or URL scope/);
    const changed = structuredClone(native.packet.baseline.input);
    changed.run_context.protocol.target_identity.native_properties[0].property = 'other.example';
    assert.notEqual(freezeProtocol(native.packet.run_context).protocol_hash, freezeProtocol(changed.run_context).protocol_hash);
    assert.equal(compare(native.packet.baseline.input, changed).status, 'not_comparable');
    changed.run_context.protocol.target_identity.native_properties[0].property = 'example.com';
    changed.run_context.protocol.target_identity.native_properties[0].evidence_ref = 'another-location.json';
    assert.equal(freezeProtocol(native.packet.run_context).protocol_hash, freezeProtocol(changed.run_context).protocol_hash);
  } finally { rmSync(native.dir, { recursive: true, force: true }); }
  const panel = copyRun();
  try {
    setPanelContext(panel, { competitors: ['Rival A'] });
    addPanel(panel, { competitors: ['Rival B'] });
    assert.throws(() => buildReport(panel.packet), /panel target identity/);
  } finally { rmSync(panel.dir, { recursive: true, force: true }); }
});

test('review P1-4: unsupported fact claim without fact list, response and evaluation evidence stays unmeasured', () => {
  const run = copyRun();
  try {
    setPanelContext(run);
    addPanel(run, { fact_list_ref: 'ABSENT.json', evaluations: [{ response_id: 'r1',
      claims: [{ evaluable: true, matches: true }] }] });
    assert.throws(() => buildReport(run.packet), /fact list|response evidence|evaluation evidence|evidence\/source link/i);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('review P1-4: evaluated facts and citations require all four indexed source links', () => {
  const healthy = completePanelRun();
  try {
    assert.equal(buildReport(healthy.packet).json.metrics[3].value, 1);
    assert.match(buildReport(healthy.packet).markdown, /provider response origin/);
  } finally { rmSync(healthy.dir, { recursive: true, force: true }); }
  for (const [missing, pattern] of [
    ['facts.json', /evidence\/source link|fact list/],
    ['provider-r1.json', /evidence\/source link|provider response/],
    ['citation.html', /evidence\/source link|citation source/],
    ['evaluation-r1.json', /evidence\/source link|evaluation evidence/],
  ]) {
    const run = completePanelRun();
    try {
      run.packet.evidence_index = run.packet.evidence_index.filter(x => x.ref !== missing);
      assert.throws(() => buildReport(run.packet), pattern, missing);
    } finally { rmSync(run.dir, { recursive: true, force: true }); }
  }
});

test('review P1-5: unrelated intake record cannot justify an applicability exclusion', () => {
  const run = copyRun();
  try {
    run.rewrite('intake.json', JSON.stringify({ run_id: 'another-run', decisions: [] }));
    assert.throws(() => buildReport(run.packet), /applicability|decision record/i);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('review P1-5: URL and unit exclusions require matching approved decision records', () => {
  const urlRun = copyRun();
  try {
    const selected = urlRun.packet.run_context.protocol.page_types[0].urls[0];
    selected.public_indexing = false;
    selected.indexing_decision = { condition: 'not_public_index_target',
      reason: 'synthetic owner excludes this URL', evidence_ref: 'url-decision.json' };
    urlRun.packet.baseline.input.observations = [urlRun.packet.baseline.input.observations[0]];
    urlRun.packet.findings = [];
    refreshContext(urlRun);
    const record = { run_id: 'synthetic-report', target: 'example.com',
      protocol_hash: freezeProtocol(urlRun.packet.run_context).protocol_hash, approved_by: 'synthetic-fixture',
      decisions: [{ scope: 'url', normalized_url: selected.normalized,
        condition: selected.indexing_decision.condition, reason: selected.indexing_decision.reason }] };
    addEvidence(urlRun, 'url-decision.json', record, 'applicability');
    assert.doesNotThrow(() => buildReport(urlRun.packet));
    record.decisions[0].condition = 'different_condition';
    urlRun.rewrite('url-decision.json', `${JSON.stringify(record)}\n`);
    assert.throws(() => buildReport(urlRun.packet), /applicability decision record/);
  } finally { rmSync(urlRun.dir, { recursive: true, force: true }); }
  const unitRun = copyRun();
  try {
    const unit_key = 'document-title|https://example.com/about';
    const decision = { condition: 'not_html', reason: 'synthetic non-HTML response', evidence_ref: 'unit-decision.json' };
    unitRun.packet.baseline.input.observations.push({ schema_version: '1.0.0', observation_id: 'unit-na',
      check_id: 'document-title', family_id: 'document-title', unit_key, state: 'not_applicable', q: null,
      partial_basis: null, reason: 'not HTML', evaluator_type: 'human', source_ref: 'synthetic',
      evidence_ref: 'unit-decision.json', applicability_decision: decision });
    unitRun.packet.baseline.scores = score(unitRun.packet.baseline.input);
    const record = { run_id: 'synthetic-report', target: 'example.com',
      protocol_hash: freezeProtocol(unitRun.packet.run_context).protocol_hash, approved_by: 'synthetic-fixture',
      decisions: [{ scope: 'unit', unit_key, condition: decision.condition, reason: decision.reason }] };
    addEvidence(unitRun, 'unit-decision.json', record, 'applicability', 'synthetic');
    assert.doesNotThrow(() => buildReport(unitRun.packet));
    record.target = 'other.example'; unitRun.rewrite('unit-decision.json', `${JSON.stringify(record)}\n`);
    assert.throws(() => buildReport(unitRun.packet), /applicability decision record/);
  } finally { rmSync(unitRun.dir, { recursive: true, force: true }); }
});

test('review P1-6: definition, cohort and future incomplete windows produce no outcome delta', () => {
  for (const variant of ['definition', 'cohort', 'future', 'lag']) {
    const run = copyRun();
    try {
      setNativeIdentity(run);
      const first = variant === 'future' ? ['2030-08-06', '2030-09-02'] : ['2026-08-06', '2026-09-02'];
      const second = variant === 'future' ? ['2030-09-03', '2030-09-30'] : ['2026-09-03', '2026-09-30'];
      addNative(run, 'before-export.json', { start: first[0], end: first[1], value: 2, definition: 'A',
        sample_selection: { kind: 'all', cohort: 'A' } });
      addNative(run, 'after-export.json', { start: second[0], end: second[1], value: 5,
        definition: variant === 'definition' ? 'B' : 'A',
        sample_selection: { kind: 'all', cohort: variant === 'cohort' ? 'B' : 'A' },
        last_complete_date: variant === 'lag' ? '2026-09-20' : '2026-10-13' });
      assert.ok(buildReport(run.packet).json.tables.actual_outcomes.every(row => row[5] === 'unknown'), variant);
    } finally { rmSync(run.dir, { recursive: true, force: true }); }
  }
});

test('review P2-7: bodyless timeout remains a reportable unknown', () => {
  const run = copyRun();
  try {
    const fetch = run.packet.baseline.input.observations[0];
    Object.assign(fetch, { state: 'unknown', q: null, reason: 'timeout', source_ref: 'optbrew:collector', evidence_ref: 'collection.json' });
    run.packet.baseline.scores = score(run.packet.baseline.input);
    const collection = { artifacts: [{ normalized_url: 'https://example.com/', final_url: 'https://example.com/',
      status: null, error: 'timeout', content_hash: null, evidence_ref: 'collection.json' }] };
    addEvidence(run, 'collection.json', collection, 'collection', 'optbrew:collector');
    addEvidence(run, 'modules.json', {}, 'modules');
    addEvidence(run, 'observations.json', [fetch], 'observations');
    addEvidence(run, 'audit.json', { run_id: 'synthetic-report', context_ref: 'context.json',
      collection_ref: 'collection.json', module_output_ref: 'modules.json', observations_ref: 'observations.json',
      raw: [{ normalized_url: 'https://example.com/', evidence_ref: 'collection.json', content_hash: null }] }, 'audit');
    run.packet.audit_ref = 'audit.json';
    assert.doesNotThrow(() => buildReport(run.packet));
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('review P2-8: before and after collector snapshots use their own evidence refs for the same URL', () => {
  const run = copyRun();
  try {
    const before = run.packet.baseline.input.observations[0];
    for (const obs of run.packet.baseline.input.observations) obs.source_ref = 'optbrew:collector';
    run.packet.evidence_index.find(x => x.ref === 'raw.html').source_ref = 'optbrew:collector';
    run.packet.baseline.scores = score(run.packet.baseline.input);
    const afterInput = structuredClone(run.packet.baseline.input);
    afterInput.observations[0].evidence_ref = 'after.html';
    afterInput.observations[1].evidence_ref = 'after.html';
    addEvidence(run, 'after.html', '<html><head><meta name="robots" content="noindex"><title>After</title></head></html>\n', 'raw_html', 'optbrew:collector');
    run.packet.after = { input: afterInput, scores: score(afterInput) };
    run.packet.comparison = compare(run.packet.baseline.input, afterInput);
    for (const [phase, ref] of [['baseline', 'raw.html'], ['after', 'after.html']]) {
      const prefix = phase === 'baseline' ? 'b' : 'a';
      addEvidence(run, `${prefix}-collection.json`, { artifacts: [{ normalized_url: 'https://example.com/',
        final_url: 'https://example.com/', evidence_ref: ref, raw_html_ref: ref,
        content_hash: run.packet.evidence_index.find(x => x.ref === ref).sha256,
        capability: 'raw_html', status: 200, headers: {} }] }, 'collection');
      addEvidence(run, `${prefix}-modules.json`, { 'naver-searchadvisor': [{ url: 'https://example.com/',
        title: phase === 'baseline' ? 'Example' : 'After', robots_meta: 'noindex', x_robots_tag: null }] }, 'modules');
      addEvidence(run, `${prefix}-observations.json`, phase === 'baseline' ? run.packet.baseline.input.observations : afterInput.observations, 'observations');
      addEvidence(run, `${prefix}-audit.json`, { run_id: 'synthetic-report', context_ref: 'context.json',
        collection_ref: `${prefix}-collection.json`, module_output_ref: `${prefix}-modules.json`,
        observations_ref: `${prefix}-observations.json`, raw: [{ normalized_url: 'https://example.com/',
          evidence_ref: ref, content_hash: run.packet.evidence_index.find(x => x.ref === ref).sha256 }] }, 'audit');
    }
    run.packet.audit_ref = 'b-audit.json';
    run.packet.audit_snapshots = [{ phase: 'baseline', audit_ref: 'b-audit.json', context_ref: 'context.json' },
      { phase: 'after', audit_ref: 'a-audit.json', context_ref: 'context.json' }];
    assert.doesNotThrow(() => buildReport(run.packet));
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('final review I7: native path mapping matches whole path segments only', () => {
  const build = (filterPath, prefix = '/owned') => {
    const run = copyRun();
    const mapping = { provider: 'gsc', property: 'example.com', target: 'example.com', hostname: 'example.com',
      path_prefix: prefix, evidence_ref: 'target-map.json' };
    run.packet.run_context.protocol.target_identity = { target: 'example.com', native_properties: [mapping] };
    addEvidence(run, 'target-map.json', { run_id: 'synthetic-report', target: 'example.com', provider: 'gsc',
      property: 'example.com', hostname: 'example.com', path_prefix: prefix, approved_by: 'synthetic-fixture' }, 'target_mapping');
    refreshContext(run);
    const source = { kind: 'native_export', run_id: 'synthetic-report', provider: 'gsc',
      rows: [{ metric_id: 'clicks', value: 7, filters: { hostname: 'example.com', path: filterPath }, provider_definition: 'GSC clicks' }],
      metadata: { timezone: 'Asia/Seoul', collected_at: '2026-10-14T10:00:00+09:00', last_complete_date: '2026-10-13',
        source_ref: 'owner:gsc', evidence_ref: 'scoped-export.json', window: { start: '2026-09-01', end: '2026-09-28', timezone: 'Asia/Seoul' },
        sample_selection: { kind: 'all' }, property: 'example.com', aggregation: 'page' } };
    run.packet.metrics = normalizeImport(source.provider, source.rows, source.metadata);
    addEvidence(run, 'scoped-export.json', source, 'native_export', 'owner:gsc');
    return run;
  };
  for (const [filterPath, prefix, accepted] of [
    ['/owned/page', '/owned', true], ['/owned', '/owned', true], ['/owned/', '/owned', true],
    ['/owned/page?x=1', '/owned', true], ['/owned-other/page', '/owned', false], ['/ownedness', '/owned', false],
    ['/owned/../other/page', '/owned', false], ['/owned/page', '/owned/', true], ['/owned', '/owned/', false],
    ['/anything', '/', true]]) {
    const run = build(filterPath, prefix);
    try {
      if (accepted) assert.doesNotThrow(() => buildReport(run.packet), `${filterPath} within ${prefix}`);
      else assert.throws(() => buildReport(run.packet), /hostname or URL scope/, `${filterPath} within ${prefix}`);
    } finally { rmSync(run.dir, { recursive: true, force: true }); }
  }
});

test('final review M1: a single measured window keeps its raw value and state with the difference unknown', () => {
  const run = copyRun();
  try {
    setNativeIdentity(run);
    addNative(run, 'only-export.json', { start: '2026-09-01', end: '2026-09-28', value: 7 });
    const row = buildReport(run.packet).json.tables.actual_outcomes[0];
    assert.deepEqual(row.slice(3, 6), [7, 'unknown', 'unknown']);
    assert.match(row.at(-1), /not_comparable_or_missing_window; measured/);
    const markdown = buildReport(run.packet).markdown;
    assert.match(markdown, /\| 7 \| unknown \| unknown \|/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('final review I9: a verified duplicate-title verdict over a present title is not rejected by a presence check', () => {
  const run = copyRun();
  try {
    const unit_key = 'document-title|https://example.com/about';
    run.packet.baseline.input.observations.push({ schema_version: '1.0.0', observation_id: 'duplicate-title',
      check_id: 'document-title', family_id: 'document-title', unit_key, state: 'fail', q: 0, partial_basis: null,
      reason: 'Title duplicates https://example.com/ (reviewed uniqueness evidence)', evaluator_type: 'human',
      source_ref: 'synthetic', evidence_ref: 'raw.html' });
    run.packet.baseline.scores = score(run.packet.baseline.input);
    run.packet.comparison = compare(run.packet.baseline.input, null);
    assert.match(readFileSync(path.join(run.dir, 'raw.html'), 'utf8'), /<title>Example<\/title>/);
    assert.doesNotThrow(() => buildReport(run.packet));
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('final review M2: the CLI refuses an invalid packet before creating any output', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'optbrew report invalid '));
  try {
    cpSync(path.resolve('tests/fixtures/reports'), path.join(dir, 'run'), { recursive: true });
    const input = path.join(dir, 'run', 'remote-only.json');
    const packet = JSON.parse(readFileSync(input, 'utf8'));
    packet.baseline.scores[0].score = 100;
    writeFileSync(input, JSON.stringify(packet));
    const out = path.join(dir, 'out');
    const run = spawnSync(process.execPath, [path.resolve('skills/optbrew/scripts/cli.mjs'), 'report', '--input', input, '--output-dir', out], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /baseline score differs from raw observations/);
    assert.equal(existsSync(path.join(out, 'report.json')), false);
    assert.equal(existsSync(path.join(out, 'report.md')), false);
    assert.deepEqual(existsSync(out) ? readdirSync(out) : [], []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

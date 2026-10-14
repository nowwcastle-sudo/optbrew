import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { normalizeImport } from '../skills/optbrew/scripts/adapters/imports.mjs';
import { measurePanel } from '../skills/optbrew/scripts/core/metrics.mjs';
import { freezeProtocol } from '../skills/optbrew/scripts/core/protocol.mjs';

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
    const sources = [
      ['before-export.json', '2026-08-06', '2026-09-02', 2],
      ['after-export.json', '2026-09-03', '2026-09-30', 5],
    ];
    for (const [ref, start, end, value] of sources) {
      const source = { kind: 'native_export', run_id: 'synthetic-report', provider: 'gsc',
        rows: [{ metric_id: 'clicks', value, provider_definition: 'GSC clicks' }],
        metadata: { timezone: 'Asia/Seoul', collected_at: '2026-10-14T10:00:00+09:00',
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
    const context = run.packet.run_context;
    context.protocol.question_panel = [{ id: 'q1', question: 'What?', category: 'brand' }];
    context.protocol.engines = ['claude']; context.protocol.surfaces = ['claude_api'];
    context.protocol.models = ['synthetic']; context.protocol.search_enabled = false;
    const questionFamily = context.protocol.families.find(x => x.family_id === 'question-coverage');
    questionFamily.applicable = true; delete questionFamily.applicability_decision;
    run.packet.baseline.input.run_context = structuredClone(context);
    run.packet.baseline.scores = score(run.packet.baseline.input);
    run.packet.comparison = { status: 'no_after', score_deltas: [], reasons: ['after_missing'] };
    run.rewrite('context.json', `${JSON.stringify(context, null, 2)}\n`);
    const panel = { questions: [{ id: 'q1', question: 'What?', category: 'brand' }], repeats: 1,
      panel_hash: freezeProtocol(run.packet.run_context).protocol_hash, search_enabled: false,
      target_entity: 'Example', target_domains: ['example.com'], engine: 'claude', surface: 'claude_api',
      model: 'synthetic', locale: 'ko-KR', region: 'KR', window: { start: '2026-09-01', end: '2026-09-28', timezone: 'Asia/Seoul' },
      source_ref: 'synthetic-panel', evidence_ref: 'panel.json' };
    const source = { kind: 'panel', run_id: 'synthetic-report', panel,
      responses: [{ question_id: 'q1', repeat: 0, response_id: 'r1', valid: true,
        cited_urls: ['https://example.com/'], target_mentioned: true, brand_mentions: ['Example'] }], evaluations: [] };
    run.packet.metrics = measurePanel(panel, source.responses, source.evaluations);
    const bytes = `${JSON.stringify(source)}\n`;
    run.rewrite('panel.json', bytes);
    run.packet.evidence_index.push({ ref: 'panel.json', sha256: sha(bytes), kind: 'panel',
      source_ref: 'synthetic-panel', run_id: 'synthetic-report' });
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
    const collection = `${JSON.stringify({ artifacts: [{ normalized_url: 'https://example.com/', evidence_ref: 'raw.html',
      status: 200, headers: {} }] })}\n`;
    const modules = `${JSON.stringify({ 'naver-searchadvisor': [{ url: 'https://example.com/', robots_meta: 'noindex' }] })}\n`;
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
    run.rewrite('modules.json', `${JSON.stringify({ 'naver-searchadvisor': [{ url: 'https://example.com/', robots_meta: null }] })}\n`);
    assert.throws(() => buildReport(run.packet), /index-policy verdict differs/);
    run.rewrite('modules.json', modules);
    audit.raw[0].content_hash = '0'.repeat(64);
    run.rewrite('audit.json', `${JSON.stringify(audit)}\n`);
    assert.throws(() => buildReport(run.packet), /audit raw content hash mismatch/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('a local passing receipt stays local and a deployment claim needs its own receipt', () => {
  const run = copyRun();
  try {
    const add = (ref, text, kind) => {
      run.rewrite(ref, text);
      run.packet.evidence_index.push({ ref, sha256: sha(text), kind, run_id: 'synthetic-report' });
    };
    add('before.txt', 'before\n', 'backup');
    add('change.txt', 'after\n', 'change');
    add('verify.json', JSON.stringify({ run_id: 'synthetic-report', change_id: 'c1', status: 'passed', deployed: false }), 'verification');
    run.packet.changes.push({ schema_version: '1.0.0', change_id: 'c1', finding_ids: ['module:a'],
      environment: 'local', path: 'site/page.html', before_hash: sha('before\n'), after_hash: sha('after\n'),
      backup_ref: 'before.txt', evidence_ref: 'change.txt', verification: { status: 'passed', deployed: false, evidence_ref: 'verify.json' } });
    assert.equal(buildReport(run.packet).json.findings[0].status, 'verified_local');
    run.packet.changes[0].environment = 'production';
    run.packet.changes[0].verification.deployed = true;
    assert.throws(() => buildReport(run.packet), /verification receipt/);
  } finally { rmSync(run.dir, { recursive: true, force: true }); }
});

test('CLI writes both formats with readback and no partial output on invalid packet', () => {
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

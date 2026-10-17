import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile, access, cp, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { install } from '../lib/install.mjs';
import { runAudit } from '../skills/optbrew/scripts/audit.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { compileUnits } from '../skills/optbrew/scripts/core/weights.mjs';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { freezeProtocol } from '../skills/optbrew/scripts/core/protocol.mjs';
import { buildReport, writeReport } from '../skills/optbrew/scripts/core/report.mjs';

const siteRoot = new URL('./fixtures/sites/', import.meta.url);
const template = new URL('./fixtures/scoring/before.json', import.meta.url);

function runNode(args, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, shell: false, windowsHide: true });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('close', code => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

test('installed junction and physical entrypoints both audit and score; imports remain inert', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-junction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = await readFile(new URL('index.before.html', siteRoot));
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  const context = JSON.parse(await readFile(template, 'utf8')).run_context;
  context.target = url;
  context.scope = { allowed: [{ origin: `http://127.0.0.1:${port}`, path_prefix: '/' }],
    local_targets: [{ host: '127.0.0.1', port }] };
  context.protocol.page_types = [{ id: 'primary', urls: [{ original: url, normalized: url }] }];
  const contextPath = path.join(root, 'context.json');
  await writeFile(contextPath, JSON.stringify(context));
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot);
  const installed = await install({ agents: ['codex'], scope: 'project', projectRoot,
    bundleRoot: fileURLToPath(new URL('../skills/optbrew/', import.meta.url)) });
  assert.equal(installed.verification.status, 'valid');
  const roots = [path.join(projectRoot, '.agents/skills/optbrew'), path.join(projectRoot, '.optbrew/install/bundle')];
  for (const [index, skillRoot] of roots.entries()) {
    for (const entry of ['audit.mjs', 'cli.mjs']) {
      const imported = await runNode(['--input-type=module', '-e',
        `await import(${JSON.stringify(pathToFileURL(path.join(skillRoot, 'scripts', entry)).href)})`], projectRoot);
      assert.deepEqual(imported, { code: 0, stdout: '', stderr: '' });
    }
    const outputDir = path.join(root, `audit-${index}`);
    const audited = await runNode([path.join(skillRoot, 'scripts/audit.mjs'), '--context', contextPath,
      '--modules', 'naver-searchadvisor', '--output-dir', outputDir], projectRoot);
    assert.equal(audited.code, 0, audited.stderr);
    assert.match(audited.stdout, /"observations":/);
    const observations = JSON.parse(await readFile(path.join(outputDir, 'evidence/observations.json'), 'utf8'));
    assert.ok(observations.some(x => x.check_id === 'index-policy' && x.state === 'fail'));
    const input = path.join(root, `input-${index}.json`), result = path.join(root, `score-${index}.json`);
    await writeFile(input, JSON.stringify({ schema_version: '2.0.0', run_context: context, observations }));
    const scored = await runNode([path.join(skillRoot, 'scripts/cli.mjs'), 'score', '--input', input, '--output', result], projectRoot);
    assert.equal(scored.code, 0, scored.stderr);
    const scores = JSON.parse(await readFile(result, 'utf8'));
    assert.equal(scores.find(x => x.profile === 'SEO').readiness_status, 'blocked');
  }
});

test('root third-party notice links resolve inside the distributed skill', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const notice = await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const links = [...notice.matchAll(/\]\(([^)]+\.txt)\)/g)].map(x => x[1]);
  assert.equal(links.length, 6);
  for (const link of links) await access(path.join(root, link));
});

test('runtime score refuses modified evaluator bytes under an unchanged caller version', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = path.join(root, 'optbrew');
  await cp(fileURLToPath(new URL('../skills/optbrew/', import.meta.url)), skill, { recursive: true });
  const weights = path.join(skill, 'scripts/core/weights.mjs');
  await writeFile(weights, `${await readFile(weights, 'utf8')}\n// modified evaluator bytes\n`);
  const result = spawnSync(process.execPath, [path.join(skill, 'scripts/cli.mjs'), 'score', '--input',
    fileURLToPath(template), '--output', path.join(root, 'score.json')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /evaluation_sources identity differs/);
});

test('engine and origin units split fixed family weight independently of page count', async () => {
  const input = JSON.parse(await readFile(template, 'utf8'));
  const oneEngine = compileUnits(input, 'SEO');
  const crawlWeight = oneEngine.filter(x => x.family_id === 'search-crawl-policy')
    .reduce((sum, unit) => sum + unit.weight, 0);
  input.run_context.protocol.engines = ['google', 'naver'];
  const naver = input.run_context.protocol.families.find(x => x.family_id === 'naver-markup');
  naver.applicable = true;
  delete naver.applicability_decision;
  input.run_context.protocol.page_types[1].urls[0] = {
    original: 'https://second.example/help', normalized: 'https://second.example/help' };
  const units = compileUnits(input, 'SEO');
  const crawl = units.filter(x => x.family_id === 'search-crawl-policy');
  assert.equal(crawl.length, 6);
  const byEngine = engine => crawl.filter(x => x.engine === engine).reduce((sum, unit) => sum + unit.weight, 0);
  assert.ok(Math.abs(byEngine('google') - byEngine('naver')) < 1e-9);
  assert.ok(Math.abs(crawl.reduce((sum, unit) => sum + unit.weight, 0) - crawlWeight) < 1e-9);
  const lcp = units.filter(x => x.family_id === 'lcp-field');
  assert.equal(lcp.length, 2);
  assert.ok(Math.abs(lcp[0].weight - lcp[1].weight) < 1e-9);
});

test('real local HTTP baseline, authorized edit and same-condition rescan clear confirmed blockers', async t => {
  const before = await readFile(new URL('index.before.html', siteRoot));
  const after = await readFile(new URL('index.after.html', siteRoot));
  const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteFile = path.join(root, 'site.html');
  const backupFile = path.join(root, '_백업_원본_site.html');
  await writeFile(siteFile, before);
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await readFile(siteFile));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  const context = JSON.parse(await readFile(template, 'utf8')).run_context;
  context.run_id = 'local-http-workflow';
  context.target = url;
  context.environment = 'local';
  context.scope = { allowed: [{ origin: `http://127.0.0.1:${port}`, path_prefix: '/' }],
    local_targets: [{ host: '127.0.0.1', port }] };
  context.evidence_ref = 'context.json';
  context.audited = true;
  context.protocol.page_types = [{ id: 'primary', urls: [{ original: url, normalized: url }] }];
  context.protocol.engines = ['google'];
  for (const family of context.protocol.families)
    if (family.applicability_decision) family.applicability_decision.evidence_ref = 'intake.json';
  const scan = async (phase) => runAudit({ context, modules: ['naver-searchadvisor'], outputDir: path.join(root, phase) });
  const baseline = await scan('baseline');
  await cp(siteFile, backupFile);
  await writeFile(siteFile, after);
  assert.deepEqual(await readFile(backupFile), before);
  const followup = await scan('after');
  const input = result => ({ schema_version: '2.0.0', run_context: context, observations: result.observations });
  const beforeInput = input(baseline), afterInput = input(followup);
  const mislabeled = structuredClone(beforeInput);
  mislabeled.run_context.evaluation_version = '9.9.9';
  assert.throws(() => score(mislabeled), /evaluation version|identity/i);
  assert.deepEqual(baseline.observations.filter(x => x.state === 'fail').map(x => x.family_id).sort(), ['document-title', 'index-policy']);
  assert.deepEqual(followup.observations.filter(x => x.state === 'pass').map(x => x.family_id).sort(), ['fetch-response', 'index-policy']);
  assert.equal(followup.observations.find(x => x.family_id === 'document-title').state, 'unknown',
    'a present title of the only audited page proves existence only; uniqueness and descriptiveness stay unknown');
  assert.equal(score(beforeInput).find(x => x.profile === 'SEO').readiness_status, 'blocked');
  assert.equal(score(afterInput).find(x => x.profile === 'SEO').blockers.length, 0);
  const delta = compare(beforeInput, afterInput);
  assert.equal(delta.status, 'comparable');
  assert.ok(delta.score_deltas.find(x => x.profile === 'SEO').raw_difference > 0);
  assert.equal(compare(beforeInput, { ...afterInput, run_context: { ...context, environment: 'production' } }).status, 'not_comparable');
  assert.notEqual(baseline.artifacts[0].content_hash, followup.artifacts[0].content_hash);

  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const evidence_index = [];
  async function evidence(ref, kind, source_ref, extra = {}) {
    evidence_index.push({ ref, sha256: sha(await readFile(path.resolve(root, ref))), kind,
      run_id: context.run_id, ...(source_ref ? { source_ref } : {}), ...extra });
  }
  async function record(ref, value, kind) {
    await writeFile(path.join(root, ref), `${JSON.stringify(value, null, 2)}\n`);
    await evidence(ref, kind);
  }
  await record('context.json', context, 'context');
  await record('intake.json', { run_id: context.run_id, target: context.target,
    protocol_hash: freezeProtocol(context).protocol_hash, approved_by: 'local fixture operator',
    decisions: context.protocol.families.filter(x => x.applicability_decision).map(x => ({ scope: 'family',
      family_id: x.family_id, condition: x.applicability_decision.condition,
      reason: x.applicability_decision.reason })) }, 'intake');
  for (const [phase, run] of [['baseline', baseline], ['after', followup]]) {
    for (const name of ['collection.json', 'modules.json', 'observations.json', 'evidence-index.json'])
      await evidence(path.join(path.dirname(run.evidence_ref), name), 'record');
    await evidence(path.join(path.dirname(run.evidence_ref), 'ledger.json'), 'record', 'optbrew:collector');
    for (const artifact of run.artifacts) {
      await evidence(artifact.evidence_ref, 'raw_html', 'optbrew:collector', { phase, environment: 'local', target: context.target });
      if (artifact.response_ref) await evidence(artifact.response_ref, 'response_record', 'optbrew:collector');
      if (artifact.failure_ref) await evidence(artifact.failure_ref, 'failure_record', 'optbrew:collector');
    }
  }
  const beforeRaw = baseline.artifacts[0].evidence_ref, afterRaw = followup.artifacts[0].evidence_ref;
  const costs = { schema_version: '2.0.0', run_id: context.run_id, budgets: [], reservations: [], settlements: [],
    approval_ref: null, source_ref: 'local-fixture', evidence_ref: 'costs.json' };
  await record('costs.json', costs, 'record');
  const resolved = afterInput.observations.find(x => x.check_id === 'index-policy');
  const verification = { run_id: context.run_id, change_id: 'local-html-edit', status: 'passed', deployed: false,
    path: 'site.html', environment: 'local', target: context.target, after_hash: followup.artifacts[0].content_hash,
    observation_id: resolved.observation_id, observation_evidence_ref: resolved.evidence_ref,
    checks: [{ id: 'raw-response', status: 'passed', observed: 'Same URL served changed local HTML',
      evidence_ref: afterRaw, after_hash: followup.artifacts[0].content_hash }] };
  await record('verification.json', verification, 'verification');
  const packet = { schema_version: '2.0.0', run_context: context,
    baseline: { input: beforeInput, scores: score(beforeInput) },
    after: { input: afterInput, scores: score(afterInput) }, comparison: delta, metrics: [],
    findings: ['index-policy', 'document-title'].map(family => ({ schema_version: '2.0.0', finding_id: family,
      check_id: family, unit_key: `${family}|${url}`, priority: family === 'index-policy' ? 'P0' : 'P1',
      blocker: family === 'index-policy', message: family === 'index-policy' ? 'Unexpected noindex' : 'Missing title',
      source_ref: 'optbrew:collector', evidence_ref: beforeRaw, remediation_ids: [], status: 'confirmed' })),
    changes: [{ schema_version: '2.0.0', change_id: 'local-html-edit', finding_ids: ['index-policy', 'document-title'], analysis: { tools: [], queries: [], self_analysis: true },
      environment: 'local', path: 'site.html', before_hash: baseline.artifacts[0].content_hash,
      after_hash: followup.artifacts[0].content_hash, backup_ref: beforeRaw,
      evidence_ref: afterRaw, verification: { status: 'passed', deployed: false, evidence_ref: 'verification.json',
        observation_id: resolved.observation_id, observation_evidence_ref: resolved.evidence_ref } }],
    costs, remaining: [{ problem: 'Search and AI results unmeasured', reason: 'local fixture only',
      required_input_or_authority: 'owner property export or observed provider responses',
      next_action: 'Measure after authorized deployment', reobserve_when: 'after production collection' }],
    evidence_root: root, evidence_index, audit_snapshots: [
      { phase: 'baseline', audit_ref: baseline.evidence_ref, context_ref: context.evidence_ref },
      { phase: 'after', audit_ref: followup.evidence_ref, context_ref: context.evidence_ref }],
    source_ref: 'local-fixture', data_class: 'synthetic' };
  const paths = await writeReport(packet, path.join(root, 'report'));
  const report = JSON.parse(await readFile(paths.jsonPath, 'utf8'));
  const markdown = await readFile(paths.markdownPath, 'utf8');
  assert.equal(report.comparison.status, 'comparable');
  assert.equal(report.findings.find(x => x.check_id === 'index-policy').status, 'verified_local');
  const indexStatus = mutate => {
    const copy = structuredClone(packet);
    mutate(copy);
    return buildReport(copy).json.findings.find(x => x.check_id === 'index-policy').status;
  };
  const afterEntry = copy => copy.evidence_index.find(x => x.ref === afterRaw);
  assert.equal(indexStatus(copy => { delete copy.changes[0].verification.observation_id; }), 'modified_unverified', 'no observation_id binding');
  assert.equal(indexStatus(copy => { delete afterEntry(copy).environment; }), 'modified_unverified', 'environment label missing');
  assert.equal(indexStatus(copy => { afterEntry(copy).environment = 'production'; }), 'modified_unverified', 'wrong environment label');
  assert.equal(indexStatus(copy => { delete afterEntry(copy).phase; }), 'modified_unverified', 'phase label missing');
  assert.equal(indexStatus(copy => { afterEntry(copy).phase = 'baseline'; }), 'modified_unverified', 'baseline phase label');
  assert.equal(indexStatus(copy => { afterEntry(copy).target = 'http://other.example/'; }), 'modified_unverified', 'other target');
  assert.equal(report.after.scores.find(x => x.profile === 'SEO').blockers.length, 0);
  assert.equal(report.metrics.length, 0);
  assert.equal(report.follow_ups.filter(x => x.reason === 'verified_local').length, 0);
  assert.equal(report.findings.find(x => x.check_id === 'document-title').status, 'modified_unverified');
  assert.equal(report.follow_ups.filter(x => x.reason === 'production_deployment_pending').length, 1);
  assert.equal(report.follow_ups.filter(x => x.reason === 'modified_unverified').length, 1);
  assert.match(markdown, /이전 막는 문제: 1건 [\s\S]*이후 막는 문제: 0건/);
  assert.match(markdown, /실제 결과: 연결 안 됨 \/ 알 수 없음/);
  assert.match(markdown, /내 컴퓨터에서 해결 확인됨/);
  await t.test('stripping the after snapshot cannot upgrade a result', () => {
    const stripped = structuredClone(packet);
    stripped.audit_snapshots = stripped.audit_snapshots.filter(x => x.phase !== 'after');
    assert.throws(() => buildReport(stripped), /after audit snapshot differs from the audit recorded in its run context/);
    // Also claiming the phase was not audited contradicts the hashed context evidence.
    stripped.after.input.run_context.audited = false;
    assert.throws(() => buildReport(stripped), /context evidence differs/);
    const unaudited = structuredClone(packet);
    unaudited.audit_snapshots = unaudited.audit_snapshots.filter(x => x.phase !== 'baseline');
    assert.throws(() => buildReport(unaudited), /baseline audit snapshot differs from the audit recorded in its run context/);
  });
  const moduleRef = path.join(path.dirname(followup.evidence_ref), 'modules.json');
  const modules = JSON.parse(await readFile(moduleRef, 'utf8'));
  modules['naver-searchadvisor'][0].title = null;
  await writeFile(moduleRef, `${JSON.stringify(modules)}\n`);
  evidence_index.find(x => x.ref === moduleRef).sha256 = sha(await readFile(moduleRef));
  assert.throws(() => buildReport(packet), /module differs from raw response/);

  modules['naver-searchadvisor'][0].title = 'Example service';
  await writeFile(moduleRef, `${JSON.stringify(modules)}\n`);
  evidence_index.find(x => x.ref === moduleRef).sha256 = sha(await readFile(moduleRef));
  const baselineModuleRef = path.join(path.dirname(baseline.evidence_ref), 'modules.json');
  const baselineObsRef = path.join(path.dirname(baseline.evidence_ref), 'observations.json');
  const forgedModules = JSON.parse(await readFile(baselineModuleRef, 'utf8'));
  const originalBaselineModules = structuredClone(forgedModules);
  const originalBaselineObservations = structuredClone(beforeInput.observations);
  forgedModules['naver-searchadvisor'][0].title = 'Invented title';
  forgedModules['naver-searchadvisor'][0].robots_meta = 'index,follow';
  forgedModules['naver-searchadvisor'][0].x_robots_tag = '';
  for (const obs of beforeInput.observations.filter(x => ['document-title', 'index-policy'].includes(x.check_id))) {
    obs.state = 'pass'; obs.q = 1; obs.reason = 'Forged positive';
  }
  await writeFile(baselineModuleRef, `${JSON.stringify(forgedModules)}\n`);
  await writeFile(baselineObsRef, `${JSON.stringify(beforeInput.observations)}\n`);
  for (const ref of [baselineModuleRef, baselineObsRef])
    evidence_index.find(x => x.ref === ref).sha256 = sha(await readFile(ref));
  packet.baseline.scores = score(beforeInput);
  packet.comparison = compare(beforeInput, afterInput);
  packet.findings = [];
  packet.changes = [];
  assert.throws(() => buildReport(packet), /raw|module.*differs|title.*differs/i);

  await writeFile(baselineModuleRef, `${JSON.stringify(originalBaselineModules)}\n`);
  beforeInput.observations = originalBaselineObservations;
  await writeFile(baselineObsRef, `${JSON.stringify(beforeInput.observations)}\n`);
  for (const ref of [baselineModuleRef, baselineObsRef])
    evidence_index.find(x => x.ref === ref).sha256 = sha(await readFile(ref));
  packet.baseline.scores = score(beforeInput);

  const afterCollectionRef = path.join(path.dirname(followup.evidence_ref), 'collection.json');
  const afterObsRef = path.join(path.dirname(followup.evidence_ref), 'observations.json');
  const afterCollection = JSON.parse(await readFile(afterCollectionRef, 'utf8'));
  // A header injected into collection.json alone is not backed by the hashed response record.
  afterCollection.artifacts[0].headers['x-robots-tag'] = 'noindex';
  afterCollection.artifacts[0].header_lines.push({ name: 'x-robots-tag', value: 'noindex' });
  modules['naver-searchadvisor'][0].x_robots_tag = 'noindex';
  const indexObservation = afterInput.observations.find(x => x.check_id === 'index-policy');
  indexObservation.state = 'fail'; indexObservation.q = 0; indexObservation.reason = 'Header blocks indexing';
  const saveAfter = async () => {
    await writeFile(afterCollectionRef, `${JSON.stringify(afterCollection)}\n`);
    await writeFile(moduleRef, `${JSON.stringify(modules)}\n`);
    await writeFile(afterObsRef, `${JSON.stringify(afterInput.observations)}\n`);
    for (const ref of [afterCollectionRef, moduleRef, afterObsRef])
      evidence_index.find(x => x.ref === ref).sha256 = sha(await readFile(ref));
    packet.after.scores = score(afterInput);
    packet.comparison = compare(beforeInput, afterInput);
  };
  await saveAfter();
  assert.throws(() => buildReport(packet), /response record differs from collection record/);
  delete afterCollection.artifacts[0].headers['x-robots-tag'];
  afterCollection.artifacts[0].header_lines.pop();
  await saveAfter();
  assert.throws(() => buildReport(packet), /noindex verdict is absent from raw response evidence|module differs from raw response and headers/);
  modules['naver-searchadvisor'][0].x_robots_tag = null;
  indexObservation.state = 'pass'; indexObservation.q = 1; indexObservation.reason = 'Header blocks indexing';
  const titleObservation = afterInput.observations.find(x => x.check_id === 'document-title');
  modules['naver-searchadvisor'][0].title = null;
  titleObservation.state = 'fail'; titleObservation.q = 0; titleObservation.reason = 'Forged missing title';
  await saveAfter();
  assert.throws(() => buildReport(packet), /module differs from raw response and headers/);
});

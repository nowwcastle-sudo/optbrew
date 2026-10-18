import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runAudit } from '../skills/optbrew/scripts/audit.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { score } from '../skills/optbrew/scripts/core/score.mjs';
import { compare } from '../skills/optbrew/scripts/core/compare.mjs';
import { freezeProtocol } from '../skills/optbrew/scripts/core/protocol.mjs';
import { buildScenario, page, startSite } from './support/review-scenario.mjs';

const MODULES = ['naver-searchadvisor'];
const FIXED = '<meta name="robots" content="index,follow">';
const sha = text => createHash('sha256').update(text).digest('hex');

/**
 * The four labels the report reads on the after phase's raw evidence (report.mjs, statusFor): which phase, which target, which
 * environment, which page. No product code writes them yet (run.mjs builds the baseline only), so the fixture does, through this one helper.
 */
const labelAfterEvidence = (entry, { target, url }) => Object.assign(entry, { phase: 'after', target, environment: 'production', source_url: url });

/**
 * An audited run of a site that blocks indexing, a deployed fix, and a second audit of the fixed site, all built with the audit
 * itself and the scenario helpers: both phases are replayed by the report, nothing is written into a golden file.
 * `deployed: false` is a fix the owner has not confirmed on the live site; `labelled: false` leaves the after evidence unlabelled.
 */
async function auditedFix(t, { deployed = true, labelled = true } = {}) {
  let fixed = false;
  const site = await startSite({ '/': () => ({ body: page(fixed ? FIXED : '<meta name="robots" content="noindex">') }) });
  t.after(() => site.close());
  const run = await buildScenario(site, ['/'], { name: 'verified-production' });
  t.after(() => rm(run.dir, { recursive: true, force: true }));
  const { context, packet } = run;
  // The site under audit is the live one: the scenario's local label becomes production, in the context and in its hashed records.
  context.environment = 'production';
  const intakeOf = ctx => ({ run_id: ctx.run_id, target: ctx.target, protocol_hash: freezeProtocol(ctx).protocol_hash,
    approved_by: 'verified-production fixture', decisions: ctx.protocol.families.filter(f => f.applicability_decision).map(f => ({
      scope: 'family', family_id: f.family_id, condition: f.applicability_decision.condition, reason: f.applicability_decision.reason })) });
  for (const [ref, value] of [['context.json', context], ['intake.json', intakeOf(context)]]) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path.join(run.dir, ref), text);
    packet.evidence_index.find(x => x.ref === ref).sha256 = sha(text);
  }
  const baselineFail = run.observation('index-policy', '/');
  assert.equal(baselineFail.state, 'fail', 'the baseline audit found the noindex');

  // The after phase: the same protocol, the site as deployed, audited into its own folder under the run's evidence root.
  fixed = true;
  const afterContext = structuredClone(context);
  afterContext.evidence_ref = 'after-context.json';
  for (const family of afterContext.protocol.families) if (family.applicability_decision) family.applicability_decision.evidence_ref = 'after-intake.json';
  const afterDir = path.join(run.dir, 'after');
  await mkdir(afterDir);
  const afterAudit = await runAudit({ context: afterContext, modules: MODULES, outputDir: afterDir });
  await run.record('after-context.json', afterContext, 'context');
  await run.record('after-intake.json', intakeOf(afterContext), 'applicability');
  for (const file of ['collection.json', 'modules.json', 'observations.json', 'evidence-index.json', 'ledger.json'])
    await run.add(path.join(afterDir, 'evidence', file), 'record', file === 'collection.json' ? 'optbrew:collector' : undefined);
  for (const artifact of afterAudit.artifacts) {
    await run.add(artifact.evidence_ref, artifact.capability === 'raw_html' ? 'raw_html' : 'raw_response', 'optbrew:collector');
    if (artifact.response_ref) await run.add(artifact.response_ref, 'response_record', 'optbrew:collector');
    if (artifact.failure_ref) await run.add(artifact.failure_ref, 'failure_record', 'optbrew:collector');
  }
  const afterInput = { schema_version: '2.0.0', run_context: afterContext, observations: afterAudit.observations };
  const resolved = afterInput.observations.find(x => x.check_id === 'index-policy' && x.unit_key === baselineFail.unit_key);
  assert.equal(resolved.state, 'pass', 'the after audit sees the fix');
  assert.equal(resolved.source_ref, 'optbrew:collector');

  // The change record: the page bytes, the deployment the owner confirmed, and the receipt that names the after observation.
  const change = { id: 'c1', path: 'site/index.html', before: 'noindex page\n', after: 'indexable page\n' };
  const runId = context.run_id;
  for (const [ref, text, kind] of [['c1-before.txt', change.before, 'backup'], ['c1-after.txt', change.after, 'change']]) {
    await writeFile(path.join(run.dir, ref), text);
    await run.add(ref, kind);
  }
  await run.record('c1-deployment.json', { run_id: runId, environment: 'production', target: context.target, path: change.path,
    after_hash: sha(change.after), confirmed_by: 'verified-production fixture' }, 'deployment');
  await run.record('c1-verify.json', { run_id: runId, change_id: change.id, status: 'passed', deployed, path: change.path,
    after_hash: sha(change.after), environment: 'production', target: context.target,
    checks: [{ id: 'raw-response', status: 'passed', observed: 'file hash checked', evidence_ref: 'c1-after.txt', after_hash: sha(change.after) }],
    deployment: { target: context.target, path: change.path, after_hash: sha(change.after), evidence_ref: 'c1-deployment.json' },
    observation_id: resolved.observation_id, observation_evidence_ref: resolved.evidence_ref }, 'verification');
  const finding = run.finding(baselineFail);
  const record = { schema_version: '2.0.0', change_id: change.id, finding_ids: [finding.finding_id], analysis: { tools: [], queries: [], self_analysis: true },
    environment: 'production', path: change.path, before_hash: sha(change.before), after_hash: sha(change.after),
    backup_ref: 'c1-before.txt', evidence_ref: 'c1-after.txt',
    verification: { status: 'passed', deployed, evidence_ref: 'c1-verify.json', observation_id: resolved.observation_id, observation_evidence_ref: resolved.evidence_ref } };
  const raw = packet.evidence_index.find(x => x.ref === resolved.evidence_ref);
  if (labelled) labelAfterEvidence(raw, { target: context.target, url: baselineFail.unit_key.split('|').at(-1) });

  Object.assign(packet, { findings: [finding], changes: [record], after: { input: afterInput, scores: score(afterInput) },
    comparison: compare(packet.baseline.input, afterInput),
    audit_snapshots: [{ phase: 'baseline', audit_ref: packet.audit_ref, context_ref: context.evidence_ref },
      { phase: 'after', audit_ref: afterAudit.evidence_ref, context_ref: afterContext.evidence_ref }] });
  return { run, resolved };
}

test('an audited fix deployed to production and re-audited is verified_production, attributed to the collector', async t => {
  const { run, resolved } = await auditedFix(t);
  const report = buildReport(run.packet).json;
  assert.equal(report.comparison.status, 'comparable');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].status, 'verified_production');
  assert.deepEqual(report.findings[0].resolution, { observation_id: resolved.observation_id, evaluator_type: 'code', source_ref: 'optbrew:collector' });
});

test('the same audited fix is not verified_production while the owner has not confirmed the deployment', async t => {
  const { run } = await auditedFix(t, { deployed: false });
  const report = buildReport(run.packet).json;
  assert.equal(report.findings[0].status, 'modified_unverified');
  assert.equal(report.findings[0].resolution, null);
});

test('the same audited fix is not verified_production when its after evidence is not labelled as the live after phase', async t => {
  const { run } = await auditedFix(t, { labelled: false });
  assert.equal(buildReport(run.packet).json.findings[0].status, 'modified_unverified', 'no labels');
  const { run: baselineLabel, resolved } = await auditedFix(t);
  baselineLabel.packet.evidence_index.find(x => x.ref === resolved.evidence_ref).phase = 'baseline';
  assert.equal(buildReport(baselineLabel.packet).json.findings[0].status, 'modified_unverified', 'labelled as the baseline phase');
  const { run: local, resolved: localResolved } = await auditedFix(t);
  local.packet.evidence_index.find(x => x.ref === localResolved.evidence_ref).environment = 'local';
  assert.equal(buildReport(local.packet).json.findings[0].status, 'modified_unverified', 'labelled as a local environment');
});

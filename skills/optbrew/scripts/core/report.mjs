import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ContractError, validateEntity } from './contracts.mjs';
import { score } from './score.mjs';
import { compare } from './compare.mjs';
import { freezeProtocol } from './protocol.mjs';
import { measurePanel } from './metrics.mjs';
import { normalizeImport } from '../adapters/imports.mjs';
import { mergeFindings, selectRemediations } from './findings.mjs';
import { auditCollected } from '../../modules/naver-searchadvisor/scripts/audit.mjs';

const catalog = JSON.parse(readFileSync(new URL('../../references/remediations.json', import.meta.url))).items;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const named = value => typeof value === 'string' && value.trim().length > 0;
const sensitive = /(?:sk-ant-api03-[A-Za-z0-9_-]{32,}|sk-proj-[A-Za-z0-9_-]{32,}|ghp_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16}|\b\d{6}-[1-8]\d{6}\b)/;
const html = value => String(value ?? 'unknown').replace(/\\/g, '\\\\').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const table = (columns, rows) => `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.map(html).join(' | ')} |`).join('\n') || `| ${columns.map(() => '—').join(' | ')} |`}`;
const days = window => (Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) / 86400000 + 1;
const dayBefore = date => new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
function completeWindow(metric) {
  const collectedAt = metric.filters.collected_at, completeDate = metric.filters.last_complete_date;
  if (!collectedAt || !/^\d{4}-\d{2}-\d{2}$/.test(completeDate ?? '') ||
      !/[zZ]|[+-]\d\d:\d\d$/.test(collectedAt) || !Number.isFinite(Date.parse(collectedAt)) ||
      !Number.isFinite(Date.parse(`${completeDate}T00:00:00Z`)) ||
      new Date(`${completeDate}T00:00:00Z`).toISOString().slice(0, 10) !== completeDate) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: metric.window.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(collectedAt)).map(x => [x.type, x.value]));
  const localCollectionDate = `${parts.year}-${parts.month}-${parts.day}`;
  return completeDate <= dayBefore(localCollectionDate) && metric.window.end <= completeDate;
}

function metricRows(metrics) {
  const groups = new Map();
  for (const metric of metrics) {
    const filters = { ...metric.filters }; delete filters.collected_at; delete filters.last_complete_date; delete filters.phase;
    const key = JSON.stringify([metric.metric_id, metric.definition, filters, metric.panel_hash,
      metric.provider_definition, metric.sample_selection]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(metric);
  }
  return [...groups.values()].map(group => {
    group.sort((a, b) => a.window.start.localeCompare(b.window.start));
    const [before, after] = group;
    const paired = group.length === 2 && completeWindow(before) && completeWindow(after) &&
      days(before.window) === 28 && days(after.window) === 28 &&
      before.window.timezone === after.window.timezone &&
      Date.parse(`${after.window.start}T00:00:00Z`) - Date.parse(`${before.window.end}T00:00:00Z`) === 86400000;
    const measured = paired && before.value_state === 'measured' && after.value_state === 'measured';
    const completion = group.map(m => m.metric_id.endsWith('observation_completion_rate') && m.value_state === 'measured' ? m.value :
      m.sample_selection.valid_responses != null && m.sample_selection.planned_responses > 0 ?
        m.sample_selection.valid_responses / m.sample_selection.planned_responses : null);
    return [Object.entries(before.filters).filter(([k]) => ['provider', 'engine', 'property', 'surface'].includes(k)).map(([k, v]) => `${k}:${v}`).join('; ') || 'unknown',
      before.metric_id, group.map(m => `${m.window.start}–${m.window.end} (${m.sample_selection.kind})`).join(' → '),
      paired ? before.value ?? 'unknown' : 'unknown', paired ? after.value ?? 'unknown' : 'unknown',
      measured ? after.value - before.value : 'unknown', completion.map(x => x ?? 'unknown').join(' → '),
      `${paired ? 'comparable_windows' : 'not_comparable_or_missing_window'}; ${group.map(m => m.value_state).join(' → ')}; ` +
        group.map(m => m.sample_selection.missing_reason ?? m.sample_selection.inference ?? '').filter(Boolean).join('; ')];
  });
}

function indexedEvidence(packet) {
  if (!packet.evidence_root || !Array.isArray(packet.evidence_index)) throw new ContractError('evidence_root and evidence_index required');
  const root = realpathSync(packet.evidence_root);
  const index = new Map();
  for (const entry of packet.evidence_index) {
    if (!entry || typeof entry.ref !== 'string' || !entry.ref || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        typeof entry.kind !== 'string' || !entry.kind || entry.run_id !== packet.run_context.run_id || index.has(entry.ref))
      throw new ContractError('invalid or duplicate run evidence entry');
    const file = path.resolve(root, entry.ref);
    const actual = realpathSync(file);
    if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) throw new ContractError(`evidence path outside run directory: ${entry.ref}`);
    const bytes = readFileSync(actual);
    if (sensitive.test(bytes.toString('utf8'))) throw new ContractError('private identifier or secret in report evidence');
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
      throw new ContractError(`evidence hash mismatch: ${entry.ref}`);
    index.set(entry.ref, { ...entry, text: bytes.toString('utf8') });
  }
  const requireRef = (ref, sourceRef) => {
    const entry = index.get(ref);
    if (!entry || sourceRef && entry.source_ref !== sourceRef) throw new ContractError(`evidence/source link missing: ${ref}`);
    return entry;
  };
  const context = requireRef(packet.run_context.evidence_ref);
  if (context.kind !== 'context' || !same(JSON.parse(context.text), packet.run_context))
    throw new ContractError('run context evidence differs from report context');
  return { requireRef, index };
}

function checkDecisions(input, requireRef, auditRef) {
  const protocolHash = freezeProtocol(input.run_context).protocol_hash;
  const decisionRecord = (decision, scope, identity) => {
    const record = JSON.parse(requireRef(decision.evidence_ref).text);
    if (record.run_id !== input.run_context.run_id || !same(record.target, input.run_context.target) ||
        record.protocol_hash !== protocolHash || !named(record.approved_by) || !Array.isArray(record.decisions) ||
        !record.decisions.some(item => item.scope === scope && item[identity.key] === identity.value &&
          item.condition === decision.condition && item.reason === decision.reason))
      throw new ContractError(`applicability decision record does not match ${scope} ${identity.value}`);
  };
  for (const type of input.run_context.protocol.page_types) for (const url of type.urls)
    if (url.indexing_decision) decisionRecord(url.indexing_decision, 'url', { key: 'normalized_url', value: url.normalized });
  for (const family of input.run_context.protocol.families)
    if (family.applicability_decision) decisionRecord(family.applicability_decision, 'family', { key: 'family_id', value: family.family_id });
  for (const observation of input.observations) {
    const evidence = requireRef(observation.evidence_ref, observation.source_ref);
    if (observation.applicability_decision) decisionRecord(observation.applicability_decision, 'unit', { key: 'unit_key', value: observation.unit_key });
    if (observation.check_id === 'index-policy' && observation.state === 'fail') {
      if (evidence.kind !== 'raw_html' && evidence.kind !== 'http_response')
        throw new ContractError('index-policy failure requires raw HTML or response-header evidence');
      const rawDirective = /(?:name=["']robots["'][^>]*\b(?:noindex|none)\b|\b(?:noindex|none)\b[^>]*name=["']robots["']|x-robots-tag[^\r\n]*\b(?:noindex|none)\b)/i.test(evidence.text);
      let headerDirective = false;
      if (!rawDirective && auditRef) {
        const audit = JSON.parse(requireRef(auditRef).text);
        const collection = JSON.parse(requireRef(audit.collection_ref).text);
        headerDirective = collection.artifacts.some(x => x.evidence_ref === observation.evidence_ref &&
          /\b(?:noindex|none)\b/i.test(String(x.headers?.['x-robots-tag'] ?? x.headers?.['X-Robots-Tag'] ?? '')));
      }
      if (!rawDirective && !headerDirective) throw new ContractError('index-policy noindex verdict is absent from raw response evidence');
    }
    if (observation.check_id === 'document-title' && observation.state === 'fail' && evidence.kind === 'raw_html' &&
        /<title\b[^>]*>\s*\S/i.test(evidence.text))
      throw new ContractError('document-title failure conflicts with raw HTML evidence');
    if (observation.check_id === 'structured-data-truth' && observation.state !== 'unknown' && evidence.kind === 'markdown')
      throw new ContractError('Markdown cannot establish raw HTML structured-data truth');
  }
}

function checkMetricEvidence(metric, packet, requireRef) {
  validateEntity('MetricObservation', metric);
  const evidence = requireRef(metric.evidence_ref, metric.source_ref);
  let source;
  try { source = JSON.parse(evidence.text); }
  catch { throw new ContractError('metric evidence must be replayable JSON'); }
  if (source.run_id !== packet.run_context.run_id) throw new ContractError('metric evidence run mismatch');
  const identity = packet.run_context.protocol.target_identity;
  if (!identity || !same(identity.target, packet.run_context.target))
    throw new ContractError('target identity mapping missing from frozen run protocol');
  let observed;
  if (source.kind === 'native_export') {
    const property = source.metadata.property;
    const mapping = identity.native_properties?.find(x => x.provider === source.provider && x.property === property);
    if (!mapping || !same(mapping.target, packet.run_context.target) || !mapping.evidence_ref || !property || property === 'unknown')
      throw new ContractError('native property target mapping missing');
    if (metric.filters.hostname !== 'unknown' && metric.filters.hostname !== mapping.hostname ||
        metric.filters.path !== 'unknown' && (!mapping.path_prefix || !metric.filters.path.startsWith(mapping.path_prefix)))
      throw new ContractError('native hostname or URL scope differs from approved target mapping');
    const decision = JSON.parse(requireRef(mapping.evidence_ref).text);
    if (decision.run_id !== packet.run_context.run_id || !same(decision.target, packet.run_context.target) ||
        decision.provider !== source.provider || decision.property !== property ||
        (mapping.hostname && decision.hostname !== mapping.hostname) ||
        (mapping.path_prefix && decision.path_prefix !== mapping.path_prefix) || !named(decision.approved_by))
      throw new ContractError('native property target mapping record differs from run');
    observed = normalizeImport(source.provider, source.rows, source.metadata);
  }
  else if (source.kind === 'panel') {
    const expectedHash = freezeProtocol(packet.run_context).protocol_hash;
    if (source.panel.panel_hash !== expectedHash || metric.panel_hash !== expectedHash)
      throw new ContractError('panel hash differs from run protocol');
    const protocol = packet.run_context.protocol;
    if (!same(source.panel.questions, protocol.question_panel) || !protocol.engines.includes(source.panel.engine) ||
        !protocol.surfaces.includes(source.panel.surface) || !protocol.models.includes(source.panel.model) ||
        source.panel.search_enabled !== protocol.search_enabled || source.panel.locale !== protocol.locale ||
        source.panel.region !== protocol.region)
      throw new ContractError('panel inputs differ from run protocol');
    const target = identity.panel;
    if (!target || !same([source.panel.target_entity, source.panel.target_domains, source.panel.competitor_entities ?? []],
        [target.target_entity, target.target_domains, target.competitor_entities ?? []]) || !target.evidence_ref)
      throw new ContractError('panel target identity differs from frozen run');
    const decision = JSON.parse(requireRef(target.evidence_ref).text);
    if (decision.run_id !== packet.run_context.run_id || !same(decision.target, packet.run_context.target) ||
        !same(decision.panel, target) || !named(decision.approved_by))
      throw new ContractError('panel target identity approval record differs from run');
    const evaluableClaims = source.evaluations.flatMap(x => x.claims ?? []).filter(x => x.evaluable === true);
    const evaluableCitations = source.evaluations.flatMap(x => x.citations ?? []).filter(x => x.evaluable === true);
    let facts = null;
    if (source.panel.fact_list_ref) {
      facts = JSON.parse(requireRef(source.panel.fact_list_ref).text);
      if (facts.run_id !== packet.run_context.run_id || facts.target_entity !== target.target_entity ||
          !named(facts.approved_by) || !Array.isArray(facts.facts)) throw new ContractError('approved fact list differs from panel target');
    }
    if (evaluableClaims.length && !facts) throw new ContractError('evaluable facts require approved fact list');
    for (const response of source.responses) {
      if (!response.response_ref || !response.extraction_ref) throw new ContractError('provider response evidence missing');
      const raw = requireRef(response.response_ref);
      const receipt = JSON.parse(requireRef(response.extraction_ref).text);
      const normalized = { ...response }; delete normalized.response_ref; delete normalized.extraction_ref;
      if (receipt.run_id !== packet.run_context.run_id || receipt.response_id !== response.response_id ||
          receipt.raw_ref !== response.response_ref || receipt.raw_sha256 !== raw.sha256 ||
          !same(receipt.normalized_response, normalized))
        throw new ContractError('provider response extraction receipt differs from raw evidence');
    }
    for (const evaluation of source.evaluations) {
      if (!evaluation.evidence_ref) throw new ContractError('evaluation evidence receipt missing');
      const receipt = JSON.parse(requireRef(evaluation.evidence_ref).text);
      const normalized = { ...evaluation }; delete normalized.evidence_ref;
      if (receipt.run_id !== packet.run_context.run_id || receipt.response_id !== evaluation.response_id ||
          !named(receipt.approved_by) || !same(receipt.evaluation, normalized))
        throw new ContractError('evaluation evidence receipt differs from panel verdict');
      for (const citation of (evaluation.citations ?? []).filter(x => x.evaluable === true)) {
        if (!citation.source_evidence_ref || requireRef(citation.source_evidence_ref).source_url !== citation.citation_url)
          throw new ContractError('citation source evidence does not match evaluated URL');
      }
      for (const claim of (evaluation.claims ?? []).filter(x => x.evaluable === true)) {
        if (!claim.fact_id || !facts.facts.some(x => x.fact_id === claim.fact_id) || !claim.source_evidence_ref)
          throw new ContractError('evaluated claim lacks fact ID or source evidence');
        requireRef(claim.source_evidence_ref);
      }
    }
    observed = measurePanel(source.panel, source.responses, source.evaluations);
  } else throw new ContractError('unsupported metric evidence kind');
  if (!observed.some(item => same(item, metric))) throw new ContractError('metric differs from bound export or panel evidence');
  return source.kind === 'native_export' ? 'owner export origin and provider completeness are not independently authenticated' :
    'provider response origin and semantic evaluations are attributed to indexed receipts, not independently authenticated';
}

function statusFor(finding, changes, afterInput, target, requireRef) {
  const linked = changes.filter(change => change.finding_ids.some(id => finding.finding_ids.includes(id)));
  if (!linked.length) return finding.remediation_ids.length ? 'proposed_only' :
    finding.status === 'unknown' ? 'unknown' : 'confirmed';
  if (linked.some(change => change.verification.status === 'failed')) return 'verification_failed';
  if (linked.some(change => change.verification.status !== 'passed')) return 'modified_unverified';
  const afterResolved = same(afterInput?.run_context.target, target) &&
    afterInput?.run_context.environment === 'production' && linked.every(change => afterInput.observations.some(obs => {
      if (obs.check_id !== finding.check_id || obs.unit_key !== finding.unit_key ||
          !['pass', 'partial'].includes(obs.state) || obs.observation_id !== change.verification.observation_id ||
          obs.evidence_ref !== change.verification.observation_evidence_ref) return false;
      const source = requireRef(obs.evidence_ref, obs.source_ref);
      return source.phase === 'after' && source.environment === 'production' && same(source.target, target);
    }));
  if (linked.every(change => change.environment === 'production' && change.verification.deployed === true))
    return afterResolved ? 'verified_production' : 'modified_unverified';
  return linked.every(change => change.environment === 'local') ? 'verified_local' : 'modified_unverified';
}

function checkAuditPhase(input, phase, snapshot, requireRef) {
  const observations = input?.observations.filter(x => x.source_ref === 'optbrew:collector') ?? [];
  if (!observations.length) return;
  if (!snapshot || snapshot.phase !== phase || snapshot.context_ref !== input.run_context.evidence_ref)
    throw new ContractError(`${phase} collector observations require their own audit snapshot`);
  const audit = JSON.parse(requireRef(snapshot.audit_ref).text);
  if (audit.run_id !== input.run_context.run_id || audit.context_ref !== snapshot.context_ref)
    throw new ContractError('audit index run/context mismatch');
  const collection = JSON.parse(requireRef(audit.collection_ref).text);
  const moduleOutputs = JSON.parse(requireRef(audit.module_output_ref).text);
  const savedObservations = JSON.parse(requireRef(audit.observations_ref).text);
  if (!Array.isArray(collection.artifacts) || !Array.isArray(audit.raw) || !Array.isArray(savedObservations))
    throw new ContractError('audit snapshot files incomplete');
  const rawRefs = new Set();
  for (const raw of audit.raw) {
    if (raw.content_hash === null) {
      if (raw.evidence_ref !== audit.collection_ref || !collection.artifacts.some(x =>
          x.normalized_url === raw.normalized_url && x.evidence_ref === raw.evidence_ref &&
          x.content_hash === null && x.error))
        throw new ContractError('bodyless audit failure lacks matching collection record');
      requireRef(raw.evidence_ref);
    } else if (requireRef(raw.evidence_ref).sha256 !== raw.content_hash)
      throw new ContractError('audit raw content hash mismatch');
    rawRefs.add(raw.evidence_ref);
  }
  for (const obs of observations) {
    if (!savedObservations.some(x => same(x, obs)) || !rawRefs.has(obs.evidence_ref))
      throw new ContractError('collector observation is not bound to audit index and raw evidence');
    const url = obs.unit_key.split('|').at(-1);
    const artifact = collection.artifacts.find(x => x.normalized_url === url && x.evidence_ref === obs.evidence_ref);
    const modules = (moduleOutputs['naver-searchadvisor'] ?? []).filter(x => x.url === url);
    const module = modules.length === 1 ? modules[0] : null;
    if (obs.check_id === 'fetch-response' && (!artifact ||
        (obs.state === 'pass' && !(artifact.status >= 200 && artifact.status < 300)) ||
        (obs.state === 'fail' && artifact.status < 400) ||
        (artifact.content_hash === null && obs.state !== 'unknown')))
      throw new ContractError('fetch response verdict differs from collected artifact');
    if (['index-policy', 'document-title'].includes(obs.check_id) && ['pass', 'fail'].includes(obs.state)) {
      const raw = artifact && requireRef(obs.evidence_ref);
      if (!module || !artifact || artifact.status !== 200 || artifact.capability !== 'raw_html' ||
          artifact.raw_html_ref !== obs.evidence_ref || artifact.content_hash !== raw.sha256 || raw.kind !== 'raw_html')
        throw new ContractError('title/index verdict lacks bound raw response');
      const replay = auditCollected({ artifact, html: raw.text });
      if (!same([module.title, module.robots_meta, module.x_robots_tag],
        [replay.title, replay.robots_meta, replay.x_robots_tag]))
        throw new ContractError('title/index module differs from raw response and headers');
      const blocked = /\b(?:noindex|none)\b/i.test(`${replay.robots_meta ?? ''},${replay.x_robots_tag ?? ''}`);
      if (obs.state !== (obs.check_id === 'document-title' ? replay.title ? 'pass' : 'fail' : blocked ? 'fail' : 'pass'))
        throw new ContractError('title/index verdict differs from raw response and headers');
    }
    if (obs.check_id === 'search-crawl-policy' && obs.state === 'fail' &&
        (!module || module.robots_evidence_ref !== obs.evidence_ref || module.robots?.yeti_allowed !== false))
      throw new ContractError('crawl verdict differs from bound robots evidence and module output');
  }
}

/** Recompute scores and metrics from contained run evidence; render four design tables. */
export function buildReport(packet) {
  validateEntity('ReportPacket', packet);
  if (sensitive.test(JSON.stringify(packet))) throw new ContractError('private identifier or secret in report packet');
  if (packet.baseline.input.run_context.run_id !== packet.run_context.run_id ||
      !same(packet.baseline.input.run_context, packet.run_context) || packet.costs.run_id !== packet.run_context.run_id)
    throw new ContractError('report run context or cost ledger mismatch');
  const { requireRef } = indexedEvidence(packet);
  const snapshots = packet.audit_snapshots ?? (packet.audit_ref ? [{ phase: 'baseline',
    audit_ref: packet.audit_ref, context_ref: packet.run_context.evidence_ref }] : []);
  if (new Set(snapshots.map(x => x.phase)).size !== snapshots.length ||
      snapshots.some(x => !['baseline', 'after'].includes(x.phase) || !x.audit_ref || !x.context_ref))
    throw new ContractError('audit snapshot phase or reference invalid');
  const snapshotFor = phase => snapshots.find(x => x.phase === phase);
  const baselineScores = score(packet.baseline.input);
  if (!same(packet.baseline.scores, baselineScores)) throw new ContractError('baseline score differs from raw observations');
  checkDecisions(packet.baseline.input, requireRef, snapshotFor('baseline')?.audit_ref);
  let afterScores = null;
  if (packet.after) {
    if (packet.after.input.run_context.run_id !== packet.run_context.run_id) throw new ContractError('after run ID mismatch');
    if (!same(JSON.parse(requireRef(packet.after.input.run_context.evidence_ref).text), packet.after.input.run_context))
      throw new ContractError('after context evidence differs from input');
    afterScores = score(packet.after.input);
    if (!same(packet.after.scores, afterScores)) throw new ContractError('after score differs from raw observations');
    checkDecisions(packet.after.input, requireRef, snapshotFor('after')?.audit_ref);
  }
  const comparison = compare(packet.baseline.input, packet.after?.input ?? null);
  if (!same(packet.comparison, comparison)) throw new ContractError('comparison differs from raw inputs');
  const metricOriginLimitations = [...new Set(packet.metrics.map(metric => checkMetricEvidence(metric, packet, requireRef)))];
  if (!packet.costs.evidence_ref || !same(JSON.parse(requireRef(packet.costs.evidence_ref).text), packet.costs))
    throw new ContractError('cost ledger snapshot evidence differs from report');
  checkAuditPhase(packet.baseline.input, 'baseline', snapshotFor('baseline'), requireRef);
  checkAuditPhase(packet.after?.input, 'after', snapshotFor('after'), requireRef);
  const merged = mergeFindings(packet.findings);
  const observations = [...packet.baseline.input.observations, ...(packet.after?.input.observations ?? [])];
  const findings = merged.map(finding => {
    if (!observations.some(obs => obs.check_id === finding.check_id && obs.unit_key === finding.unit_key &&
        (obs.state === 'fail' || obs.state === 'unknown')))
      throw new ContractError(`finding has no matching check observation: ${finding.finding_id}`);
    if (finding.blocker && !observations.some(obs => obs.check_id === finding.check_id &&
        obs.unit_key === finding.unit_key && obs.state === 'fail'))
      throw new ContractError('blocker requires confirmed failed check observation');
    for (const source of finding.sources) {
      const evidence = requireRef(source.evidence_ref, source.source_ref);
      if (finding.check_id === 'index-policy' && finding.blocker &&
          !/\b(?:noindex|none)\b/i.test(evidence.text)) throw new ContractError('finding noindex evidence does not contain directive');
    }
    const options = selectRemediations(finding, { context: packet.run_context,
      capabilities: packet.capabilities ?? { selected: [], missing: [], limitations: [] }, catalog });
    const selected = options.find(option => option.selected);
    if (finding.remediation_ids.length && !finding.remediation_ids.every(id => id === selected?.remediation_id))
      throw new ContractError(`finding remediation link invalid: ${finding.finding_id}`);
    const status = statusFor(finding, packet.changes, packet.after?.input, packet.run_context.target, requireRef);
    return { ...finding, remediation: selected ?? null, status };
  });
  for (const change of packet.changes) {
    validateEntity('ChangeRecord', change);
    if (!change.finding_ids.length || change.finding_ids.some(id => !findings.some(f => f.finding_ids.includes(id))))
      throw new ContractError('change has no linked finding');
    if (requireRef(change.evidence_ref).sha256 !== change.after_hash)
      throw new ContractError('change after_hash differs from evidence');
    if (change.backup_ref && requireRef(change.backup_ref).sha256 !== change.before_hash)
      throw new ContractError('change before_hash differs from backup evidence');
    if (change.verification?.status === 'passed' && !change.verification.evidence_ref)
      throw new ContractError('passed verification requires evidence');
    if (change.verification?.evidence_ref) {
      const receipt = JSON.parse(requireRef(change.verification.evidence_ref).text);
      if (receipt.run_id !== packet.run_context.run_id || receipt.change_id !== change.change_id ||
          receipt.status !== change.verification.status || receipt.path !== change.path ||
          receipt.after_hash !== change.after_hash || receipt.environment !== change.environment ||
          !same(receipt.target, packet.run_context.target) ||
          (change.verification.deployed === true && receipt.deployed !== true))
        throw new ContractError('verification receipt differs from change record');
      if (receipt.status === 'passed' && (!Array.isArray(receipt.checks) || !receipt.checks.length ||
          receipt.checks.some(check => check.status !== 'passed' || !check.id || !check.observed ||
            !check.evidence_ref || !check.after_hash || check.after_hash !== change.after_hash ||
            requireRef(check.evidence_ref).sha256 !== change.after_hash)))
        throw new ContractError('verification check lacks actual changed bytes and passing observation');
      if (change.environment === 'production' && change.verification.deployed === true) {
        const deployment = receipt.deployment;
        const evidence = deployment?.evidence_ref ? JSON.parse(requireRef(deployment.evidence_ref).text) : null;
        if (!deployment || !same(deployment.target, packet.run_context.target) ||
            deployment.path !== change.path || deployment.after_hash !== change.after_hash ||
            !evidence || evidence.run_id !== packet.run_context.run_id || evidence.environment !== 'production' ||
            !same(evidence.target, packet.run_context.target) || evidence.path !== change.path ||
            evidence.after_hash !== change.after_hash || !named(evidence.confirmed_by))
          throw new ContractError('deployment receipt does not bind target path and bytes');
        if (receipt.status === 'passed' && (receipt.observation_id !== change.verification.observation_id ||
            receipt.observation_evidence_ref !== change.verification.observation_evidence_ref ||
            !receipt.observation_id || !receipt.observation_evidence_ref ||
            !packet.after?.input.observations.some(obs => obs.observation_id === receipt.observation_id &&
              obs.evidence_ref === receipt.observation_evidence_ref && ['pass', 'partial'].includes(obs.state))))
          throw new ContractError('production verification is not bound to after observation evidence');
      }
    }
  }
  for (const item of packet.remaining) if (!item.problem || !item.reason || !item.required_input_or_authority ||
      !item.next_action || !item.reobserve_when) throw new ContractError('remaining work row incomplete');
  const remaining = [...packet.remaining];
  for (const finding of findings.filter(x => x.status !== 'verified_production' &&
      !packet.remaining.some(row => row.finding_id && finding.finding_ids.includes(row.finding_id)))) {
    if (finding.status === 'verified_local') {
      remaining.push({ finding_id: finding.finding_id,
        problem: `Production application and observation pending for ${finding.unit_key}`,
        reason: 'production_deployment_pending', required_input_or_authority: 'site owner deployment authority and production target',
        next_action: 'Deploy the locally verified change, then fetch the production response',
        reobserve_when: 'after authorized production deployment and a new raw response' });
    } else remaining.push({ finding_id: finding.finding_id, problem: `${finding.message} ${finding.unit_key}`,
      reason: finding.status, required_input_or_authority: finding.remediation?.required_authority ?? 'source evidence and owner review',
      next_action: finding.remediation?.mechanism ?? 'Confirm the issue from raw evidence',
      reobserve_when: finding.remediation?.validation ?? 'after new evidence is collected' });
  }
  const costIssues = [
    ...packet.costs.reservations.filter(x => ['unknown', 'overrun'].includes(x.status)).map(x => {
      const settlement = packet.costs.settlements.find(item => item.reservation_id === x.reservation_id);
      const format = amounts => amounts?.map(item => `${item.amount} ${item.currency ?? item.unit}`).join(', ') ?? 'unknown';
      return `${x.provider}: ${x.status} (reserved ${format(x.upperBounds)}; actual ${format(settlement?.actual)})`;
    }),
    ...(packet.capabilities?.selected ?? []).filter(x => x.cost_enforcement === 'host_policy').map(x => `${x.provider}: host_policy`),
    ...(packet.capabilities?.limitations ?? []),
  ];
  if (packet.costs.reservations.some(x => x.provider === 'anthropic') ||
      (packet.capabilities?.selected ?? []).some(x => x.provider === 'anthropic'))
    costIssues.push('Anthropic direct v0.1.0: text-only; claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5; max output 128000; one token reserve >=1000000+max_tokens per attempt; tools/search and currency-only or mixed bounds unsupported; reservation is capacity, not actual billing');
  const result = { schema_version: '1.0.0', run_context: packet.run_context,
    data_class: packet.data_class ?? 'unknown', baseline: { input: packet.baseline.input, scores: baselineScores },
    after: packet.after ? { input: packet.after.input, scores: afterScores } : null, comparison,
    metrics: packet.metrics, findings, changes: packet.changes, costs: packet.costs,
    capabilities: packet.capabilities ?? null, cost_issues: costIssues, metric_origin_limitations: metricOriginLimitations, remaining,
    evidence_root: packet.evidence_root, evidence_index: packet.evidence_index,
    audit_ref: packet.audit_ref ?? null, audit_snapshots: snapshots, source_ref: packet.source_ref };
  const byProfile = new Map(afterScores?.map(x => [x.profile, x]) ?? []);
  const scoreRows = baselineScores.map(before => {
    const after = byProfile.get(before.profile);
    const delta = comparison.score_deltas.find(x => x.profile === before.profile);
    return [before.profile, before.score, after?.score ?? 'unknown', delta?.percentage_point_delta ?? 'unknown',
      `${before.coverage ?? 'unknown'} → ${after?.coverage ?? 'unknown'}`,
      `${before.missing_bounds?.join('–') ?? 'unknown'} → ${after?.missing_bounds?.join('–') ?? 'unknown'}`,
      `${before.readiness_status} → ${after?.readiness_status ?? 'unknown'}`];
  });
  const remediationRows = findings.map(f => [f.priority, `${f.message} ${f.unit_key}`, f.sources.map(x => `${x.source_ref} ${x.evidence_ref}`).join('; '),
    f.remediation ? `${f.remediation.mechanism} (${f.remediation.source_url}, checked ${f.remediation.checked_date})` : 'unknown',
    packet.changes.filter(x => x.finding_ids.some(id => f.finding_ids.includes(id))).map(x => x.path).join('; ') || f.remediation?.location_hint || 'owner implementation location required',
    f.remediation ? `${f.remediation.cost}; ${f.remediation.effort}` : 'unknown', f.remediation?.validation ?? 'unknown', f.status]);
  const outcomeRows = metricRows(packet.metrics);
  const remainingRows = remaining.map(x => [x.problem, x.reason, x.required_input_or_authority, x.next_action, x.reobserve_when]);
  const markdown = `# optbrew report\n\n${packet.data_class === 'synthetic' ? '**Synthetic example — no real site or provider outcome.**\n\n' : ''}` +
    `Target: ${html(packet.run_context.target)}  \nEnvironment: ${html(packet.run_context.environment)}  \nGoals: ${html(packet.run_context.goals.join(', '))}  \n` +
    `Comparison: ${html(comparison.status)} (${html(comparison.reasons.join(', ') || 'none')})  \n` +
    `Baseline blockers: ${html(baselineScores[0]?.blockers.length ?? 0)} (${html(baselineScores[0]?.blockers.map(x => `${x.family_id} ${x.unit_key}`).join('; ') || 'none')}) → ` +
    `After blockers: ${afterScores ? html(afterScores[0]?.blockers.length ?? 0) : 'unknown'} (${afterScores ? html(afterScores[0]?.blockers.map(x => `${x.family_id} ${x.unit_key}`).join('; ') || 'none') : 'after not observed'}); ` +
    `after core unknown: ${afterScores ? html(afterScores[0]?.unknown_core.length ?? 0) : 'unknown'}; actual outcomes: ${packet.metrics.length ? 'see measured and missing states below' : 'not_connected / unknown'}  \n` +
    `Cost and capability limitations: ${html(costIssues.join('; ') || 'none recorded')}  \n` +
    `Metric source limitations: ${html(metricOriginLimitations.join('; ') || 'no measured provider input')}\n\n` +
    `## Score\n\n${table(['Area', 'Before', 'After', 'Difference', 'Coverage before → after', 'Missing bounds', 'Status'], scoreRows)}\n\n` +
    `## Remediation\n\n${table(['Priority', 'Problem / URL', 'Evidence', 'Selected remedy', 'Change path or owner location', 'Cost / effort', 'Verification', 'Status'], remediationRows)}\n\n` +
    `## Actual outcomes\n\n${table(['Engine / property', 'Metric', 'Window / sample', 'Before raw', 'After raw', 'Difference', 'Completion', 'Limitations'], outcomeRows)}\n\n` +
    `## Remaining work\n\n${table(['Problem', 'Reason', 'Needed input / authority', 'Next action', 'Reobserve when'], remainingRows)}\n\n` +
    `Evidence root: ${html(packet.evidence_root)}; run ID: ${html(packet.run_context.run_id)}. Read report.json to replay raw score inputs.\n`;
  result.tables = { score: scoreRows, remediation: remediationRows, actual_outcomes: outcomeRows, remaining_work: remainingRows };
  return { json: result, markdown };
}

/** Write both outputs after all validation; temporary files stay in the destination. */
export async function writeReport(packet, outputDir) {
  const built = buildReport(packet);
  await mkdir(outputDir, { recursive: true });
  const jsonPath = path.resolve(outputDir, 'report.json'), markdownPath = path.resolve(outputDir, 'report.md');
  for (const file of [jsonPath, markdownPath]) {
    try { await access(file); throw new ContractError(`report output already exists: ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const temporary = [`${jsonPath}.${process.pid}.tmp`, `${markdownPath}.${process.pid}.tmp`];
  let jsonWritten = false;
  try {
    await writeFile(temporary[0], `${JSON.stringify(built.json, null, 2)}\n`, { flag: 'wx' });
    await writeFile(temporary[1], built.markdown, { flag: 'wx' });
    await rename(temporary[0], jsonPath); jsonWritten = true;
    await rename(temporary[1], markdownPath);
  } catch (error) {
    if (jsonWritten) await rm(jsonPath, { force: true });
    throw error;
  } finally { await Promise.all(temporary.map(file => rm(file, { force: true }))); }
  return { jsonPath, markdownPath };
}

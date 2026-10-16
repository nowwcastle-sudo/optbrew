import { readFileSync, realpathSync } from 'node:fs';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ContractError, validateEntity } from './contracts.mjs';
import { endpoints, requestLimit, versions } from './config.mjs';
import { score } from './score.mjs';
import { compare } from './compare.mjs';
import { freezeProtocol } from './protocol.mjs';
import { measurePanel } from './metrics.mjs';
import { normalizeImport } from '../adapters/imports.mjs';
import { mergeFindings, selectRemediations } from './findings.mjs';
import { auditCollected, indexingDirectives } from '../../modules/naver-searchadvisor/scripts/audit.mjs';
import { deriveObservations } from './derive.mjs';
import { readVerified } from './evidence-store.mjs';
import { links } from './collector.mjs';
import { checkRenderLedger } from './render.mjs';
import { assertUrlInScope } from './scope.mjs';
import { composeReport, renderReport } from './report-compose.mjs';
import { runbookEntry } from './runbooks.mjs';
import { sensitive } from './secrets.mjs';
import { OBSERVATION_SOURCES, QUEUE_KIND, candidateSpans, checkSpan, isCodeJudged, isModelJudged, queuedSpan } from './judgments.mjs';
import { parseRobots, robotsVerdict } from '../../modules/naver-searchadvisor/scripts/robots.mjs';

const catalog = JSON.parse(readFileSync(new URL('../../references/remediations.json', import.meta.url))).items;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const named = value => typeof value === 'string' && value.trim().length > 0;
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
    // One measured window keeps its raw value and state; the difference stays unknown without a matched pair.
    const single = !paired && group.length === 1 && before.value_state === 'measured' ? before.value ?? 'unknown' : 'unknown';
    return [Object.entries(before.filters).filter(([k]) => ['provider', 'engine', 'property', 'surface'].includes(k)).map(([k, v]) => `${k}:${v}`).join('; ') || 'unknown',
      before.metric_id, group.map(m => `${m.window.start}–${m.window.end} (${m.sample_selection.kind})`).join(' → '),
      paired ? before.value ?? 'unknown' : single, paired ? after.value ?? 'unknown' : 'unknown',
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
    let bytes;
    try { bytes = readVerified(root, entry.ref, entry.sha256); }
    catch (error) { throw new ContractError(error.message); }
    if (sensitive.test(bytes.toString('utf8'))) throw new ContractError('private identifier or secret in report evidence');
    index.set(entry.ref, { ...entry, text: bytes.toString('utf8'), bytes });
  }
  /** `source` is the `source_ref` the entry must carry, or `{ anySource: true }` for evidence cited from another source. */
  const requireRef = (ref, source) => {
    const entry = index.get(ref);
    if (!entry || source && !source.anySource && entry.source_ref !== source) throw new ContractError(`evidence/source link missing: ${ref}`);
    return entry;
  };
  const context = requireRef(packet.run_context.evidence_ref);
  if (context.kind !== 'context' || !same(JSON.parse(context.text), packet.run_context))
    throw new ContractError('run context evidence differs from report context');
  return { requireRef, index };
}

/** Collected responses by raw evidence reference across the packet's audit snapshots (lazy, memoized). */
function collectedResponses(snapshots, requireRef) {
  let byRef = null;
  return ref => {
    if (!byRef) {
      byRef = new Map();
      for (const snapshot of snapshots) {
        try {
          const audit = JSON.parse(requireRef(snapshot.audit_ref).text);
          const collection = JSON.parse(requireRef(audit.collection_ref).text);
          for (const entry of collection.artifacts ?? []) {
            let artifact = entry;
            try { artifact = boundArtifact(entry, audit, requireRef); } catch { /* strict binding runs for collector observations */ }
            byRef.set(artifact.evidence_ref, [...(byRef.get(artifact.evidence_ref) ?? []), artifact]);
          }
        } catch { /* an unreadable snapshot supplies no response headers; collector observations are replayed separately */ }
      }
    }
    return byRef.get(ref) ?? [];
  };
}
const unitUrl = unitKey => String(unitKey).split('|').at(-1);

/**
 * Replay the index-policy verdict from preserved raw evidence. HTML meta and the collected X-Robots-Tag header
 * go through the same extractor as the audit; a collected response must belong to the named unit URL.
 */
function evidenceBlocksIndexing(evidence, engines, collectedFor, unit) {
  const responses = collectedFor(evidence.ref);
  const scoped = unit ? responses.filter(x => x.normalized_url === unit || x.final_url === unit) : responses;
  if (responses.length && !scoped.length) return false;
  if (evidence.kind === 'raw_html') {
    const headers = scoped.length ? scoped.map(xRobotsLines) : [[]];
    return headers.some(xRobotsTag => indexingDirectives({ html: evidence.text, xRobotsTag, engines }).blocked);
  }
  if (evidence.kind === 'http_response')
    return [...evidence.text.matchAll(/^x-robots-tag:[ \t]*(.*)$/gim)].some(match =>
      indexingDirectives({ html: '', xRobotsTag: match[1], engines }).blocked);
  return false;
}
/** Normalized pathname of an export path; absolute URLs count only on the mapping host, "//" forms never. */
function exportPath(value, host) {
  const text = String(value);
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    try {
      const url = new URL(text);
      return ['http:', 'https:'].includes(url.protocol) && host && url.hostname.toLowerCase() === String(host).toLowerCase() ? url.pathname : null;
    } catch { return null; }
  }
  if (!text.startsWith('/') || /^\/[/\\]/.test(text)) return null;
  try {
    const base = new URL(endpoints().relative_url_base);
    const url = new URL(text, base);
    return url.host === base.host ? url.pathname : null;
  } catch { return null; }
}
const pathWithin = (value, prefix, host) => {
  const actual = exportPath(value, host), wanted = exportPath(prefix, host);
  if (actual === null || wanted === null) return false;
  return wanted === '/' || actual === wanted || actual.startsWith(wanted.endsWith('/') ? wanted : `${wanted}/`);
};

/**
 * A failed fetch has no response, but its answered redirect hops are real requests. They are replayed from the hashed
 * failure record, which also says whether one more attempt got no response.
 */
function boundFailure(artifact, audit, requireRef) {
  const entry = (audit.failures ?? []).find(x => x.normalized_url === artifact.normalized_url);
  if (!artifact.failure_ref || !entry || entry.evidence_ref !== artifact.failure_ref) throw new ContractError('failure record missing for failed fetch');
  const raw = requireRef(artifact.failure_ref, 'optbrew:collector');
  if (raw.sha256 !== entry.content_hash) throw new ContractError('failure record hash differs from the audit index');
  const record = JSON.parse(raw.text);
  // At most ten redirects are followed, and the eleventh answer (a refused redirect) is the last hop that can be recorded.
  if (record.kind !== 'failure' || ![0, 1].includes(record.unanswered) || !Array.isArray(record.redirect_chain) || record.redirect_chain.length > 11 ||
      record.redirect_chain.some((hop, index) => typeof hop?.url !== 'string' || !(hop.status >= 300 && hop.status <= 399) ||
        hop.url !== (index ? record.redirect_chain[index - 1].location : record.normalized_url)))
    throw new ContractError('failure record is malformed');
  for (const key of ['requested_url', 'normalized_url', 'redirect_chain', 'unanswered', 'error'])
    if (!same(record[key], artifact[key])) throw new ContractError(`failure record differs from collection record: ${key}`);
  return { ...artifact, ...record };
}

/**
 * Replay a collected response from its hashed record: final URL, redirect chain and header lines come from the
 * record, and the collection entry must agree with it. Bodyless failures have no response to bind.
 */
function boundArtifact(artifact, audit, requireRef) {
  if (!Number.isInteger(artifact.status)) return boundFailure(artifact, audit, requireRef);
  const entry = (audit.responses ?? []).find(x => x.normalized_url === artifact.normalized_url);
  if (!artifact.response_ref || !entry || entry.evidence_ref !== artifact.response_ref)
    throw new ContractError('response record missing for collected artifact');
  const raw = requireRef(artifact.response_ref, 'optbrew:collector');
  if (raw.sha256 !== entry.content_hash) throw new ContractError('response record hash differs from the audit index');
  const record = JSON.parse(raw.text);
  const chain = Array.isArray(record.redirect_chain) ? record.redirect_chain : [];
  if (record.final_url !== (chain.length ? chain.at(-1).location : record.normalized_url) ||
      (chain.length && chain[0].url !== record.normalized_url) ||
      chain.some((hop, index) => index + 1 < chain.length && hop.location !== chain[index + 1].url))
    throw new ContractError('final URL differs from the redirect chain');
  for (const key of ['requested_url', 'normalized_url', 'final_url', 'status', 'redirect_chain', 'header_lines', 'content_hash', 'capability'])
    if (!same(record[key], artifact[key])) throw new ContractError(`response record differs from collection record: ${key}`);
  return { ...artifact, ...record };
}
const xRobotsLines = response => Array.isArray(response.header_lines) ?
  response.header_lines.filter(line => line.name === 'x-robots-tag').map(line => line.value) :
  [response.headers?.['x-robots-tag'] ?? response.headers?.['X-Robots-Tag']].filter(value => value != null);

function checkDecisions(input, requireRef, collectedFor) {
  const protocolHash = freezeProtocol(input.run_context).protocol_hash;
  const engines = input.run_context.protocol.engines;
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
    // A model's verdict cites evidence the collector stored; modelJudgmentRows binds it to that page's raw evidence.
    const evidence = requireRef(observation.evidence_ref, observation.evaluator_type === 'host_model' ? { anySource: true } : observation.source_ref);
    // A collector verdict's own N/A decision cites the page evidence it was derived from, and replay re-derives it (the audit
    // phase compares the decision too); only an outside decision needs an approved decision record.
    if (observation.applicability_decision) {
      if (observation.evaluator_type === 'code' && observation.source_ref === OBSERVATION_SOURCES.code) {
        if (observation.applicability_decision.evidence_ref !== observation.evidence_ref)
          throw new ContractError(`collector N/A decision does not cite the verdict's evidence: ${observation.unit_key}`);
      } else decisionRecord(observation.applicability_decision, 'unit', { key: 'unit_key', value: observation.unit_key });
    }
    if (observation.check_id === 'index-policy' && observation.state === 'fail') {
      if (evidence.kind !== 'raw_html' && evidence.kind !== 'http_response')
        throw new ContractError('index-policy failure requires raw HTML or response-header evidence');
      if (!evidenceBlocksIndexing(evidence, engines, collectedFor, unitUrl(observation.unit_key)))
        throw new ContractError('index-policy noindex verdict is absent from raw response evidence');
    }
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
        metric.filters.path !== 'unknown' && (!mapping.path_prefix || !pathWithin(metric.filters.path, mapping.path_prefix, mapping.hostname)))
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

/**
 * A verdict that replay re-derived against its phase's audit snapshot: the collector's own pair, in a phase whose context
 * records an audit (the report refuses a packet whose snapshots differ from that record). Only such a verdict can verify a change.
 */
const replayed = (obs, input) => input.run_context.audited === true && obs.evaluator_type === 'code' && obs.source_ref === OBSERVATION_SOURCES.code;

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
          obs.evidence_ref !== change.verification.observation_evidence_ref || !replayed(obs, afterInput)) return false;
      const source = requireRef(obs.evidence_ref, obs.source_ref);
      return source.phase === 'after' && source.environment === 'production' && same(source.target, target);
    }));
  if (linked.every(change => change.environment === 'production' && change.verification.deployed === true))
    return afterResolved ? 'verified_production' : 'modified_unverified';
  // A byte-hash receipt proves which file changed, not that the finding is resolved. Local verification uses the
  // production binding: the receipt names an after observation of this check and unit that the collector produced
  // (so the audit replay covers it), and its raw evidence is labelled after, local and for this target.
  const localResolved = same(afterInput?.run_context.target, target) && afterInput?.run_context.environment === 'local' &&
    linked.every(change => change.environment === 'local' && change.verification.observation_id &&
      change.verification.observation_evidence_ref && afterInput.observations.some(obs => {
        if (obs.check_id !== finding.check_id || obs.unit_key !== finding.unit_key || !['pass', 'partial'].includes(obs.state) ||
            !replayed(obs, afterInput) || obs.observation_id !== change.verification.observation_id ||
            obs.evidence_ref !== change.verification.observation_evidence_ref) return false;
        const source = requireRef(obs.evidence_ref, obs.source_ref);
        return source.phase === 'after' && source.environment === 'local' && same(source.target, target);
      }));
  return linked.every(change => change.environment === 'local') && localResolved ? 'verified_local' : 'modified_unverified';
}

/**
 * The request ledger accounts for every queued or rejected URL. Collection counts and the skipped list must equal what
 * the ledger and the hashed response records show, so a fetched page cannot be moved to skipped and a request limit
 * cannot be claimed without the requests that exhaust it.
 */
function checkLedger(input, audit, collection, artifacts, requireRef) {
  const ledger = JSON.parse(requireRef(audit.ledger_ref).text);
  const entries = ledger.entries;
  const fail = message => { throw new ContractError(`request ledger: ${message}`); };
  if (!Array.isArray(entries)) fail('entries missing');
  const limit = requestLimit(input.run_context.scope);
  if (ledger.limit !== limit) fail('request limit differs from the run scope');
  const total = entries.reduce((sum, entry) => sum + entry.requests, 0);
  // The limit is a hard ceiling: every request, redirect hops included, takes one slot before it is sent.
  if (total > limit) fail('more requests than the limit');
  // One URL, one entry. Skips for out-of-scope and undeclared auxiliary links are recorded per link and may repeat.
  const identities = entries.filter(x => !(x.outcome === 'skipped' && ['outside_scope', 'auxiliary_undeclared'].includes(x.skipped_reason))).map(x => x.url);
  if (new Set(identities).size !== identities.length) fail('duplicate ledger url: a URL appears in more than one entry');
  const responded = artifacts.filter(x => Number.isInteger(x.status));
  const failed = artifacts.filter(x => !Number.isInteger(x.status));
  const byUrl = outcome => new Map(entries.filter(x => x.outcome === outcome).map(x => [x.url, x]));
  const responses = byUrl('response'), errors = byUrl('error');
  if (responses.size !== responded.length || audit.responses.length !== responded.length || errors.size !== failed.length || audit.failures.length !== failed.length)
    fail('collected artifacts differ from the ledger or the response records');
  for (const artifact of responded) {
    const entry = responses.get(artifact.normalized_url);
    if (!entry || entry.requests !== artifact.redirect_chain.length + 1) fail(`response for ${artifact.normalized_url} is not recorded`);
  }
  // A skipped entry never reached the network. Requests booked on it would only pad the total toward a claimed limit.
  if (entries.some(x => x.outcome === 'skipped' && x.requests !== 0)) fail('a skipped entry carries requests');
  for (const artifact of failed) {
    const entry = errors.get(artifact.normalized_url);
    if (!entry) fail(`failed fetch of ${artifact.normalized_url} is not recorded`);
    // The requests of a failed fetch are the answered hops of its hashed failure record plus at most one attempt that got
    // no response; nothing in collection.json can raise them.
    if (entry.requests !== artifact.redirect_chain.length + artifact.unanswered) fail(`failed fetch of ${artifact.normalized_url} does not match its hashed failure record`);
  }
  const key = x => `${x.url}|${x.reason ?? x.skipped_reason}`;
  const ledgerSkips = entries.filter(x => x.skipped_reason).map(key).sort();
  if (JSON.stringify((collection.skipped ?? []).map(key).sort()) !== JSON.stringify(ledgerSkips)) fail('skipped list differs from the ledger');
  const limited = entries.some(x => ['url_limit', 'request_limit'].includes(x.skipped_reason));
  if (collection.limit_reached !== limited) fail('limit_reached differs from the ledger');
  if (limited && total !== limit) fail('a request limit is claimed but the recorded requests do not use the whole limit');
  if (collection.request_count !== total || collection.evaluated_count !== entries.filter(x => x.requests > 0).length) fail('request or evaluated count differs from the ledger');
  const selected = new Set(input.run_context.protocol.page_types.flatMap(type => type.urls.map(x => x.normalized)));
  if (entries.some(x => selected.has(x.url) && x.skipped_reason && x.skipped_reason !== 'url_limit' && x.outcome === 'skipped')) fail('a selected page is skipped for a reason other than the request limit');
  // The protocol caps selected pages plus auxiliary resources at the limit, and the collector queues them before any
  // discovered page. A selected page can only hit the request limit after redirects used the budget, so no page that was
  // merely discovered may have been fetched in the same run.
  const auxiliary = new Set((input.run_context.protocol.auxiliary_resources ?? []).map(x => x.normalized));
  const planned = new Set([...selected, ...auxiliary]);
  // Provenance: a failed fetch or a request-limit skip belongs to a URL the run was given (selected or auxiliary) or one
  // that a hashed page of this collection links to (anchors and canonical, as the collector follows them). A URL nothing
  // links to cannot be a failed fetch or a skipped one, so fabricated entries cannot pad the total or claim a limit.
  const known = new Set(planned);
  for (const artifact of responded) {
    if (artifact.status !== 200 || artifact.capability !== 'raw_html' || auxiliary.has(artifact.normalized_url)) continue;
    for (const link of links(requireRef(artifact.evidence_ref).text, artifact.final_url)) {
      try { known.add(assertUrlInScope(link, input.run_context.scope).href); } catch { /* out of scope: the collector skipped it */ }
    }
  }
  for (const entry of entries) {
    if ((entry.outcome === 'error' || (entry.outcome === 'skipped' && entry.skipped_reason === 'url_limit')) && !known.has(entry.url))
      fail(`${entry.url} has no provenance: it is neither a selected or auxiliary URL nor linked from a collected page`);
  }
  if (entries.some(x => selected.has(x.url) && x.outcome === 'skipped' && x.skipped_reason === 'url_limit') &&
      entries.some(x => x.requests > 0 && !planned.has(x.url))) fail('a selected page is skipped for the request limit although a discovered page was fetched');
}

/**
 * The render records of an audit index, read through the run's evidence (hash and secret checked): every record against the
 * hash the index lists, its DOM against the hash the record holds, and the render ledger against each record's own requests.
 * An index from before rendering has none of these sections. `renderTextOf` returns the stored DOM of a record.
 */
function storedRenders(audit, renderBudget, requireRef) {
  const fail = message => { throw new ContractError(message); };
  const dom = new Map();
  const records = (audit.renders ?? []).map(entry => {
    const stored = requireRef(entry.evidence_ref);
    if (stored.sha256 !== entry.sha256) fail('render record hash differs from the audit index');
    let record;
    try { record = JSON.parse(stored.text); } catch { fail('render record is not JSON'); }
    if (typeof record.url !== 'string' || !Array.isArray(record.requests)) fail('render record is malformed');
    if (record.dom_ref) {
      const rendered = requireRef(record.dom_ref);
      if (rendered.sha256 !== record.dom_sha256) fail('render DOM hash differs from its record');
      dom.set(record, rendered.text);
    }
    return record;
  });
  const ledger = audit.render_ledger ?? [];
  for (const record of records) checkRenderLedger(ledger, record, renderBudget);
  if (ledger.some(entry => !records.some(record => record.url === entry.page))) fail('render ledger: an entry names a page that was not rendered');
  return { records, renderTextOf: record => dom.get(record) ?? '' };
}

/**
 * The field CWV answers of an audit index, read through the run's evidence (hash and secret checked), each one with the ref
 * it was read from. An index from before field data has no `cwv` section.
 */
function storedCwv(audit, requireRef) {
  return (audit.cwv ?? []).map(entry => {
    const stored = requireRef(entry.evidence_ref);
    if (stored.sha256 !== entry.sha256) throw new ContractError('CWV record hash differs from the audit index');
    let record;
    try { record = JSON.parse(stored.text); } catch { throw new ContractError('CWV record is not JSON'); }
    if (record.source !== entry.source || typeof record.origin !== 'string') throw new ContractError('CWV record is malformed');
    return { ...record, evidence_ref: entry.evidence_ref };
  });
}

function checkAuditPhase(input, phase, snapshot, requireRef) {
  if (!input) return;
  const observations = input.observations.filter(x => x.source_ref === 'optbrew:collector');
  if (!snapshot && !observations.length) return;
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
  if (!Array.isArray(audit.modules) || !audit.ledger_ref || !Array.isArray(audit.responses) || !Array.isArray(audit.failures))
    throw new ContractError('audit evidence was produced by an older optbrew release (it lacks the request ledger, module list or failure records); re-run the audit with optbrew 0.1.3 and build a new packet');
  for (const name of audit.modules) if (!Array.isArray(moduleOutputs[name])) throw new ContractError(`planned module output missing: ${name}`);
  const naverPlanned = audit.modules.includes('naver-searchadvisor');
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
  // Field CWV answers are collected evidence too; their hashes are checked where the verdicts are re-derived below.
  for (const entry of audit.cwv ?? []) rawRefs.add(entry.evidence_ref);
  // Final URL, redirect chain and header lines come from the hashed response records, not from collection.json alone.
  const artifacts = collection.artifacts.map(x => boundArtifact(x, audit, requireRef));
  checkLedger(input, audit, collection, artifacts, requireRef);
  for (const obs of observations) {
    if (!savedObservations.some(x => same(x, obs)) || !rawRefs.has(obs.evidence_ref))
      throw new ContractError('collector observation is not bound to audit index and raw evidence');
    const url = unitUrl(obs.unit_key);
    const artifact = artifacts.find(x => x.normalized_url === url && x.evidence_ref === obs.evidence_ref);
    // Bind the requested unit to its collected artifact first; the module must describe that artifact's final URL.
    const pageArtifact = artifact ?? artifacts.find(x => x.normalized_url === url && x.status === 200 && x.capability === 'raw_html');
    const modules = pageArtifact?.final_url ? (moduleOutputs['naver-searchadvisor'] ?? []).filter(x =>
      x.url === pageArtifact.final_url && (x.requested_url ?? url) === url) : [];
    const module = modules.length === 1 ? modules[0] : null;
    const engines = input.run_context.protocol.engines;
    if (obs.check_id === 'fetch-response' && (!artifact ||
        (obs.state === 'pass' && !(artifact.status >= 200 && artifact.status < 300)) ||
        (obs.state === 'fail' && artifact.status < 400) ||
        (artifact.content_hash === null && obs.state !== 'unknown')))
      throw new ContractError('fetch response verdict differs from collected artifact');
    if (['index-policy', 'document-title'].includes(obs.check_id) &&
        (['pass', 'fail'].includes(obs.state) || obs.check_id === 'document-title' && obs.state === 'unknown')) {
      const raw = artifact && requireRef(obs.evidence_ref);
      if ((naverPlanned && !module) || !artifact || artifact.status !== 200 || artifact.capability !== 'raw_html' ||
          artifact.raw_html_ref !== obs.evidence_ref || artifact.content_hash !== raw.sha256 || raw.kind !== 'raw_html')
        throw new ContractError('title/index verdict lacks bound raw response');
      const replay = auditCollected({ artifact, html: raw.text, engines });
      if (naverPlanned && (!same([module.title, module.robots_meta, module.x_robots_tag],
        [replay.title, replay.robots_meta, replay.x_robots_tag]) ||
        (module.requested_url !== undefined && module.requested_url !== artifact.normalized_url) ||
        (module.redirect_chain !== undefined && !same(module.redirect_chain, artifact.redirect_chain ?? []))))
        throw new ContractError('title/index module differs from raw response and headers');
      // Title states (missing, duplicated, unknown) are replayed by the derivation below.
      if (obs.check_id === 'index-policy' && obs.state !== (replay.index_blocked ? 'fail' : 'pass'))
        throw new ContractError('title/index verdict differs from raw response and headers');
    }
    if (obs.check_id === 'search-crawl-policy' && ['pass', 'fail'].includes(obs.state) && obs.unit_key.split('|')[1] === 'naver') {
      const [, engine] = obs.unit_key.split('|');
      const robotsArtifact = artifacts.find(x => x.evidence_ref === obs.evidence_ref && x.status === 200);
      const declared = robotsArtifact && (input.run_context.protocol.auxiliary_resources ?? []).some(resource =>
        resource.kind === 'robots' && resource.normalized === robotsArtifact.normalized_url);
      const robotsRaw = robotsArtifact && requireRef(obs.evidence_ref);
      let sameOriginRobots = false;
      try {
        const robotsUrl = new URL(robotsArtifact.final_url), pageUrl = new URL(pageArtifact.final_url);
        sameOriginRobots = robotsUrl.origin === pageUrl.origin && robotsUrl.pathname === '/robots.txt';
      } catch { /* missing or invalid URLs leave the binding false */ }
      if (engine !== 'naver' || !engines.includes(engine) || !declared || !sameOriginRobots || !module ||
          robotsRaw.sha256 !== robotsArtifact.content_hash || module.robots_evidence_ref !== obs.evidence_ref || !module.robots)
        throw new ContractError('crawl verdict differs from bound robots evidence and module output');
      const target = new URL(pageArtifact.final_url);
      const verdict = robotsVerdict(parseRobots(robotsRaw.text), 'yeti', target.pathname + target.search);
      if (module.robots.yeti_allowed !== verdict.allowed || module.robots.reason !== verdict.reason ||
          obs.state !== (verdict.allowed ? 'pass' : 'fail'))
        throw new ContractError('crawl verdict differs from bound robots evidence and module output');
    }
  }
  // Every selected page is either collected or recorded as skipped; vanishing from both hides its observations.
  for (const { normalized: url } of input.run_context.protocol.page_types.flatMap(type => type.urls))
    if (!artifacts.some(x => x.normalized_url === url) && !(collection.skipped ?? []).some(x => x.url === url))
      throw new ContractError(`selected page missing from the collection and its skipped list: ${url}`);
  // Re-derive every collector verdict from the hashed raw evidence. Each derived observation must be present in the
  // packet and in the saved observation file, and no collector observation may lack a derivation.
  const { records, renderTextOf } = storedRenders(audit, input.run_context.protocol.render?.max_render_requests, requireRef);
  const derived = deriveObservations({ context: input.run_context, artifacts, collection,
    textOf: artifact => artifact.content_hash ? requireRef(artifact.evidence_ref).text : null,
    renders: records, renderTextOf, chrome: audit.chrome ?? null, cwv: storedCwv(audit, requireRef) });
  const shape = x => [x.state, x.q, x.partial_basis, x.evidence_ref, x.reason, x.evaluator_type, x.source_ref, x.applicability_decision ?? null];
  for (const expected of derived) {
    if (!observations.some(x => x.unit_key === expected.unit_key) || !savedObservations.some(x => x.unit_key === expected.unit_key))
      throw new ContractError(`planned collector observation missing: ${expected.unit_key}`);
    const have = observations.find(x => x.unit_key === expected.unit_key);
    if (!same(shape(have), shape(expected)))
      throw new ContractError(expected.family_id === 'search-crawl-policy' ? 'crawl verdict differs from bound robots evidence and module output' :
        ['index-policy', 'document-title'].includes(expected.family_id) ? 'title/index verdict differs from raw response and headers' :
          `collector verdict differs from raw evidence: ${expected.unit_key}`);
  }
  for (const have of observations) if (!derived.some(x => x.unit_key === have.unit_key))
    throw new ContractError(`collector observation is not derivable from raw evidence: ${have.unit_key}`);
}

const MODEL_JUDGMENT_LABEL = '근거 확인됨, 판정은 모델';

/**
 * The model judgments of one score input, each replayed against the run's audit evidence. A `host_model` observation is
 * refused for a code-judged family and unless it carries the model source. Its evidence must be the audit raw entry of
 * the page its unit names. A verdict other than unknown cites ranges that are candidates of the queue stored in the audit
 * index, each with that raw entry's hash and a byte range inside it on character boundaries. The label says the evidence was
 * checked and the verdict is the model's.
 */
function modelJudgmentRows(phase, input, snapshot, requireRef) {
  const fail = (obs, message) => { throw new ContractError(`verdict ${obs.unit_key}: ${message}`); };
  for (const obs of input?.observations ?? []) {
    const type = obs.evaluator_type;
    // Next to an audit, a code-judged family is the collector's alone and is re-derived; without one, only a model is refused (an outside source stays unverified).
    if (isCodeJudged(obs.family_id) && (type === 'host_model' || snapshot && (type !== 'code' || obs.source_ref !== OBSERVATION_SOURCES.code)))
      fail(obs, `${obs.family_id} is judged by code; a ${type} observation with source_ref ${obs.source_ref} cannot stand for it`);
    // A content family has exactly one allowed pair: the model's, bound to the judge queue.
    if (isModelJudged(obs.family_id) && (type !== 'host_model' || obs.source_ref !== OBSERVATION_SOURCES.host_model))
      fail(obs, `${obs.family_id} is judged by a model through the judge queue; evaluator_type ${type} with source_ref ${obs.source_ref} is not allowed`);
    if (type === 'host_model' && obs.source_ref !== OBSERVATION_SOURCES.host_model) fail(obs, `source_ref must be ${OBSERVATION_SOURCES.host_model}`);
    // The collector's and the model's source stand for replayed work; without the phase's audit there is nothing to replay against.
    if (!snapshot && Object.values(OBSERVATION_SOURCES).includes(obs.source_ref))
      fail(obs, `source_ref ${obs.source_ref} needs the ${phase} audit snapshot; without an audit only outside inputs are accepted, and they stay unverified`);
  }
  const judgments = (input?.observations ?? []).filter(obs => obs.evaluator_type === 'host_model');
  if (!judgments.length) return [];
  if (!snapshot) throw new ContractError(`${phase} model judgments require their audit snapshot`);
  const audit = JSON.parse(requireRef(snapshot.audit_ref).text);
  const queues = (audit.judge_queue ?? []).map(entry => {
    const stored = requireRef(entry.evidence_ref);
    if (stored.sha256 !== entry.sha256) throw new ContractError('judge queue hash differs from the audit index');
    if (stored.kind !== QUEUE_KIND) throw new ContractError(`judge queue evidence has kind ${stored.kind}, not ${QUEUE_KIND}`);
    return JSON.parse(stored.text);
  });
  return judgments.filter(obs => obs.state !== 'unknown').map(obs => {
    const raw = (audit.raw ?? []).find(x => x.evidence_ref === obs.evidence_ref && x.normalized_url === unitUrl(obs.unit_key));
    if (!raw) fail(obs, 'its evidence is not the audit raw entry of the unit page');
    // Candidates are recomputed from the raw bytes, so a consistently forged queue cannot widen what a model may cite.
    const candidates = candidateSpans(requireRef(obs.evidence_ref).bytes, raw.content_hash);
    for (const span of obs.evidence_span ?? []) {
      if (span.evidence_sha256 !== raw.content_hash) fail(obs, 'a span names evidence other than the unit page');
      try { checkSpan(requireRef(obs.evidence_ref).bytes, span); } catch (error) { fail(obs, error.message); }
      if (!candidates.some(x => x.start === span.start && x.end === span.end)) fail(obs, `span ${span.start}-${span.end} is not a text run of the page`);
      if (!queues.some(queue => queuedSpan(queue, obs, span))) fail(obs, `span ${span.start}-${span.end} is not a candidate of the stored judge queue`);
    }
    return { phase, family_id: obs.family_id, unit_key: obs.unit_key, state: obs.state, evidence_ref: obs.evidence_ref, evidence_span: obs.evidence_span, label: MODEL_JUDGMENT_LABEL };
  });
}

/** Recompute scores and metrics from contained run evidence; render four design tables. */
export function buildReport(packet) {
  validateEntity('ReportPacket', packet);
  if (sensitive.test(JSON.stringify(packet))) throw new ContractError('private identifier or secret in report packet');
  for (const id of packet.answered_runbooks ?? []) if (!runbookEntry(id)) throw new ContractError(`answered_runbooks names an unknown runbook: ${id}`);
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
  // Each phase's run context, hashed as run evidence, records whether the phase was audited. A packet cannot add or drop a
  // snapshot to change how its phase is judged: the snapshot must exist exactly when the context says the phase was audited.
  for (const [phase, input] of [['baseline', packet.baseline.input], ['after', packet.after?.input]]) {
    if (input && (input.run_context.audited === true) !== Boolean(snapshotFor(phase)))
      throw new ContractError(`${phase} audit snapshot differs from the audit recorded in its run context`);
  }
  const baselineScores = score(packet.baseline.input);
  if (!same(packet.baseline.scores, baselineScores)) throw new ContractError('baseline score differs from raw observations');
  const collectedIn = phase => collectedResponses(snapshotFor(phase) ? [snapshotFor(phase)] : [], requireRef);
  checkDecisions(packet.baseline.input, requireRef, collectedIn('baseline'));
  let afterScores = null;
  if (packet.after) {
    if (packet.after.input.run_context.run_id !== packet.run_context.run_id) throw new ContractError('after run ID mismatch');
    const afterContext = requireRef(packet.after.input.run_context.evidence_ref);
    if (afterContext.kind !== 'context' || !same(JSON.parse(afterContext.text), packet.after.input.run_context))
      throw new ContractError('after context evidence differs from input');
    afterScores = score(packet.after.input);
    if (!same(packet.after.scores, afterScores)) throw new ContractError('after score differs from raw observations');
    checkDecisions(packet.after.input, requireRef, collectedIn('after'));
  }
  const comparison = compare(packet.baseline.input, packet.after?.input ?? null);
  if (!same(packet.comparison, comparison)) throw new ContractError('comparison differs from raw inputs');
  const metricOriginLimitations = [...new Set(packet.metrics.map(metric => checkMetricEvidence(metric, packet, requireRef)))];
  if (!packet.costs.evidence_ref || !same(JSON.parse(requireRef(packet.costs.evidence_ref).text), packet.costs))
    throw new ContractError('cost ledger snapshot evidence differs from report');
  // Model verdicts are replayed first, so a host_model observation never reaches the collector replay under a collector source.
  const modelRows = [['baseline', packet.baseline.input], ['after', packet.after?.input]].flatMap(([phase, input]) => modelJudgmentRows(phase, input, snapshotFor(phase), requireRef));
  checkAuditPhase(packet.baseline.input, 'baseline', snapshotFor('baseline'), requireRef);
  checkAuditPhase(packet.after?.input, 'after', snapshotFor('after'), requireRef);
  const merged = mergeFindings(packet.findings);
  const observations = [...packet.baseline.input.observations, ...(packet.after?.input.observations ?? [])];
  const collectedAny = collectedResponses(snapshots, requireRef);
  const findings = merged.map(finding => {
    if (!observations.some(obs => obs.check_id === finding.check_id && obs.unit_key === finding.unit_key &&
        (obs.state === 'fail' || obs.state === 'unknown')))
      throw new ContractError(`finding has no matching check observation: ${finding.finding_id}`);
    if (finding.blocker && !observations.some(obs => obs.check_id === finding.check_id &&
        obs.unit_key === finding.unit_key && obs.state === 'fail'))
      throw new ContractError('blocker requires confirmed failed check observation');
    // A finding that groups several pages names each of them, and each must itself be a failed or unknown verdict.
    for (const unit of finding.unit_keys ?? []) if (!observations.some(obs => obs.check_id === finding.check_id && obs.unit_key === unit && (obs.state === 'fail' || obs.state === 'unknown')))
      throw new ContractError(`finding names a page without a matching check observation: ${unit}`);
    // A finding that carries the model's source must rest on a model verdict of its unit; its evidence is the page the collector stored.
    const modelFinding = finding.source_ref === OBSERVATION_SOURCES.host_model;
    if (modelFinding && !observations.some(obs => obs.check_id === finding.check_id && obs.unit_key === finding.unit_key &&
        obs.evaluator_type === 'host_model' && obs.state === 'fail'))
      throw new ContractError(`model finding has no model verdict: ${finding.finding_id}`);
    for (const source of finding.sources) {
      const evidence = requireRef(source.evidence_ref, source.source_ref === OBSERVATION_SOURCES.host_model ? { anySource: true } : source.source_ref);
      // The same HTML plus response-header replay as the observation, bound to the finding's own unit.
      if (finding.check_id === 'index-policy' && finding.blocker &&
          !evidenceBlocksIndexing(evidence, packet.run_context.protocol.engines, collectedAny, unitUrl(finding.unit_key)))
        throw new ContractError('finding noindex evidence does not contain directive');
    }
    const options = selectRemediations(finding, { context: packet.run_context,
      capabilities: packet.capabilities ?? { selected: [], missing: [], limitations: [] }, catalog });
    const selected = options.find(option => option.selected);
    if (finding.remediation_ids.length && !finding.remediation_ids.every(id => id === selected?.remediation_id))
      throw new ContractError(`finding remediation link invalid: ${finding.finding_id}`);
    const status = statusFor(finding, packet.changes, packet.after?.input, packet.run_context.target, requireRef);
    // Show who attested a production resolution, so model-written fixes stay distinct from collector-verified ones.
    const resolving = status === 'verified_production' ? packet.changes
      .filter(change => change.finding_ids.some(id => finding.finding_ids.includes(id)))
      .map(change => packet.after.input.observations.find(obs => obs.observation_id === change.verification.observation_id &&
        obs.evidence_ref === change.verification.observation_evidence_ref)).filter(Boolean) : [];
    const resolution = resolving.length ? { observation_id: resolving[0].observation_id,
      evaluator_type: [...new Set(resolving.map(obs => obs.evaluator_type))].join(', '),
      source_ref: [...new Set(resolving.map(obs => obs.source_ref))].join(', ') } : null;
    return { ...finding, remediation: selected ?? null, status, resolution, ...(modelFinding ? { label: MODEL_JUDGMENT_LABEL } : {}) };
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
      if (change.environment === 'local' && change.verification.observation_id &&
          (receipt.observation_id !== change.verification.observation_id ||
           receipt.observation_evidence_ref !== change.verification.observation_evidence_ref))
        throw new ContractError('local verification receipt is not bound to its after observation');
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
  const verified = { schema_version: versions().contract_schema, run_context: packet.run_context,
    data_class: packet.data_class ?? 'unknown', baseline: { input: packet.baseline.input, scores: baselineScores },
    after: packet.after ? { input: packet.after.input, scores: afterScores } : null, comparison,
    metrics: packet.metrics, findings, changes: packet.changes, costs: packet.costs,
    capabilities: packet.capabilities ?? null, cost_issues: costIssues, metric_origin_limitations: metricOriginLimitations, follow_ups: remaining,
    evidence_root: packet.evidence_root, evidence_index: packet.evidence_index,
    audit_ref: packet.audit_ref ?? null, audit_snapshots: snapshots, model_judgments: modelRows, source_ref: packet.source_ref,
    outcome_rows: metricRows(packet.metrics), lab_cwv: packet.lab_cwv ?? null, answered_runbooks: packet.answered_runbooks ?? [] };
  const composed = composeReport(verified);
  const { markdown, tables } = renderReport(composed, verified);
  // The composed report leads; the checked data it was built from follows. `findings` is the sorted fixes again, for readers of earlier reports.
  const checked = { ...verified };
  for (const key of ['schema_version', 'data_class', 'outcome_rows', 'lab_cwv', 'answered_runbooks']) delete checked[key];
  return { json: { schema_version: verified.schema_version, data_class: verified.data_class, composed, ...checked,
    findings: composed.fixes, tables }, markdown };
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

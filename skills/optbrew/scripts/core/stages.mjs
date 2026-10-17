import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCollected } from '../../modules/naver-searchadvisor/scripts/audit.mjs';
import { normalizeImport, readOwnerExport } from '../adapters/imports.mjs';
import { scopedPage } from './chrome.mjs';
import { collect, declaredRobotsIndex, transportFetch } from './collector.mjs';
import { checkRegistry, limits, requestLimit, versions } from './config.mjs';
import { compare } from './compare.mjs';
import { validateEntity } from './contracts.mjs';
import { HTTP_OK, collectCwv, labCwv } from './cwv.mjs';
import { deriveObservations } from './derive.mjs';
import { lcpField, inpField, clsField } from './checks/cwv-field.mjs';
import { openStore } from './evidence-store.mjs';
import { OBSERVATION_SOURCES, buildJudgeQueue, mergeJudgments } from './judgments.mjs';
import { keyHome, readGoogleKey } from './keys.mjs';
import { MigrationRequired, assertCurrentEvidence } from './migration.mjs';
import { groupPages, readPreflight, sameSite, selectPages } from './page-select.mjs';
import { pageNeutral, problemsOf } from './findings.mjs';
import { freezeProtocol } from './protocol.mjs';
import { renderPages, selectRenderPages } from './render.mjs';
import { renderHtmlReport } from './report-html.mjs';
import { writeReport } from './report.mjs';
import { loadRunbook } from './runbooks.mjs';
import { score } from './score.mjs';
import { assertUrlInScope, urlTarget } from './scope.mjs';

/** Fixed file names of the run documents the evidence index points at. */
const DOCUMENTS = { collection: 'collection.json', ledger: 'ledger.json', modules: 'modules.json', observations: 'observations.json' };
/** The skill folder; the runbooks name it where they run a script of the skill. */
const SKILL_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const magnusScript = fileURLToPath(new URL('../../modules/magnus-seo/scripts/aeo_audit.py', import.meta.url));
const NAVER_MODULE = 'naver-searchadvisor';
const MAGNUS_MODULE = 'magnus-seo';
/** The modules a full run uses: the Naver module is plain Node and its output is what replay checks the crawl verdicts against. */
const RUN_MODULES = [NAVER_MODULE];
const PHASE = 'baseline';
const HALT_JUDGMENTS = 'awaiting_judgments';
const JUDGE_STAGE = 'judge';
const QUEUE_FILE = 'judge-queue.json';
const CONTEXT_FILE = 'context.json';
const INTAKE_FILE = 'intake.json';
const COSTS_FILE = 'costs.json';
const RUN_SOURCE = 'optbrew:run';
const OWNER_SOURCE = 'optbrew:owner-export';
const SCORE_INPUT_FILE = 'score-input.json';
// Said whenever the stored evidence cannot be trusted on the second call; the same words every time.
const INDEX_CHANGED = 'index changed: the evidence in this folder no longer matches what the first call stored, so nothing was collected again; run again with a new --out folder.';
const APPROVED_BY = 'start answers (intake-answers.json)';
const NAVER_ENGINE = 'naver';
const KOREAN_DOMAIN = '.kr';
const NAVER_GOAL = /naver|네이버/i;
// Families the start answers can switch off; every other family of the registry is planned for every run.
const NAVER_FAMILY = 'naver-markup';
const QUESTION_FAMILIES = ['question-coverage', 'answer-clarity'];
const NOT_APPLICABLE = {
  [NAVER_FAMILY]: { condition: 'naver_not_target', reason: 'Naver is not among the target engines of this run' },
  'question-coverage': { condition: 'no_fixed_questions', reason: 'The start answers fixed no question list' },
  'answer-clarity': { condition: 'no_matching_questions', reason: 'The start answers fixed no question list to match answers against' },
};

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async file => access(file).then(() => true, () => false);

/**
 * One stage of the audit: `run(state, deps)` answers `{ state, halt? }`. A stage reads what earlier stages left in `state`
 * and writes its own result back; it names no other stage, so a stage can be added or taken out without touching the rest.
 * `deps` = `{ selectTransport, chrome, fetchFn, env, home, store }`, all but `selectTransport` and `env` optional: `chrome.open({ context, route })`
 * answers the run's render chrome (one per run, launched on first use) and the owner closes it; `fetchFn` replaces the field-data
 * fetch; `store` replaces the evidence store a run would open itself.
 */

/** Run the stages in order from `from` (a stage name) or the first; stops at the first stage that halts. */
export async function runStages(list, state, deps, { from = null } = {}) {
  const start = from === null ? 0 : list.findIndex(stage => stage.name === from);
  if (start < 0) throw new Error(`no stage named ${from}`);
  let current = state;
  for (const stage of list.slice(start)) {
    const result = await stage.run(current, deps);
    current = result.state ?? current;
    if (result.halt) return { state: current, halt: result.halt };
  }
  return { state: current, halt: null };
}

const isLocalTarget = (scope, url) => { const target = urlTarget(new URL(url)); return (scope.local_targets ?? []).some(x => x.host === target.host && Number(x.port) === target.port); };

/**
 * The address the audit starts from. Preflight (`<out>/preflight/start.json`) says where the first request landed; when that is
 * the same site under another spelling, the run adopts it (and says so), because scope is the exact origin. Anywhere else is a
 * different site: the run stops with one plain sentence.
 */
function startFrom(asked, preflight) {
  // What the owner typed at the start read: when the answers already hold the address it landed on, the redirect is still worth saying.
  const typed = preflight.requestedUrl ? new URL(preflight.requestedUrl) : asked;
  const away = text => `The address ${asked.href} leads to another site (${text}), which this audit does not cover. If you own that site, start again with its address.`;
  if (preflight.redirectedTo && !sameSite(asked, new URL(preflight.redirectedTo))) throw new Error(away(new URL(preflight.redirectedTo).origin));
  if (!preflight.finalUrl) return { start: asked, adopted: null };
  const landed = new URL(preflight.finalUrl);
  if (landed.origin === asked.origin) return { start: asked, adopted: typed.origin === asked.origin ? null : { from: typed.href, to: asked.href } };
  if (!sameSite(asked, landed)) throw new Error(away(landed.origin));
  return { start: landed, adopted: { from: asked.href, to: landed.href } };
}

/** The answers as kept in the run folder: an export's file name and kind, never the folder it came from. */
const keptAnswers = answers => ({ ...answers, ...(answers.owner_exports ? { owner_exports: answers.owner_exports.map(x => ({ kind: x.kind, name: path.basename(x.path) })) } : {}) });

/**
 * The RunContext and the intake decision record that the start answers fix, with the pages the audit covers (chosen here, from
 * the preflight evidence, before any request of the audit). Nothing is fetched; only the preflight folder is read.
 */
async function contextFrom(answers, { out, localTargets = [] }) {
  const asked = new URL(answers.url);
  if (!['http:', 'https:'].includes(asked.protocol)) throw new Error('url must be http or https');
  const preflight = await readPreflight(out, asked.href);
  const { start, adopted } = startFrom(asked, preflight);
  const target = urlTarget(start);
  const local = localTargets.filter(x => x.host === target.host && Number(x.port) === target.port);
  const scope = { allowed: [{ origin: start.origin, path_prefix: '/' }], max_urls: answers.max_urls, ...(local.length ? { local_targets: local } : {}) };
  const ref = href => ({ original: href, normalized: assertUrlInScope(href, scope).href });
  const auxiliary = [['robots', '/robots.txt'], ['sitemap', '/sitemap.xml']].map(([kind, pathname]) => ({ kind, ...ref(new URL(pathname, start.origin).href) }));
  const home = ref(start.href);
  // The sitemap files the preflight read (an index, its children, the place /sitemap.xml redirected to) are declared too, so the run
  // fetches them and a page they list counts as listed; a redirect from /sitemap.xml to its index is then followed, not refused.
  const known = new Set(auxiliary.map(x => x.normalized));
  for (const href of [...new Set(preflight.sitemapFiles)].slice(0, limits().preflight_pages)) {
    let extra;
    try { extra = ref(href); } catch { continue; }
    if (!known.has(extra.normalized)) { known.add(extra.normalized); auxiliary.push({ kind: 'sitemap', ...extra }); }
  }
  // Facts the owner confirmed on the address the run started from before its redirect now live on the adopted origin.
  const factUrls = [...new Set(answers.facts.map(fact => adopted && new URL(fact.source_url).origin === asked.origin ?
    fact.source_url.replace(asked.origin, start.origin) : fact.source_url))];
  const { pages, dropped, sources } = selectPages({ home: home.normalized, factUrls, preflight, scope, budget: requestLimit(scope) - auxiliary.length,
    auxiliary: known });
  const pageTypes = groupPages(pages, home.normalized).map(type => ({ id: type.id, urls: type.urls.map(ref) }));
  const wantsNaver = NAVER_GOAL.test(answers.goals.join(' ')) || (answers.owner_exports ?? []).some(x => x.kind === NAVER_ENGINE) ||
    preflight.korean || target.host.endsWith(KOREAN_DOMAIN);
  const engines = ['google', ...(wantsNaver ? [NAVER_ENGINE] : [])];
  const planned = id => id === NAVER_FAMILY ? engines.includes(NAVER_ENGINE) : QUESTION_FAMILIES.includes(id) ? answers.questions.length > 0 : true;
  const families = checkRegistry().families.map(({ family_id }) => planned(family_id) ? { family_id, applicable: true } :
    { family_id, applicable: false, applicability_decision: { ...NOT_APPLICABLE[family_id], evidence_ref: INTAKE_FILE } });
  // Handing over an export of this site is the owner's approval of the property it describes: the site's own host, whole site.
  const providers = [...new Set((answers.owner_exports ?? []).map(x => x.kind))];
  const mapping = provider => ({ provider, property: target.host, hostname: target.host, path_prefix: '/' });
  const targetIdentity = providers.length ? { target_identity: { target: home.normalized,
    native_properties: providers.map(provider => ({ ...mapping(provider), target: home.normalized, evidence_ref: `owner-mapping-${provider}.json` })) } } : {};
  const context = {
    schema_version: versions().contract_schema, run_id: `optbrew-${randomUUID()}`, target: home.normalized,
    environment: scope.local_targets ? 'local' : 'production', goals: answers.goals, allowed_changes: [], scope,
    protocol: { page_types: pageTypes, engines, families, auxiliary_resources: auxiliary, locale: 'und', region: 'ZZ', browser: 'Chrome', device: 'mobile',
      question_panel: answers.questions, surfaces: [], models: [], search_enabled: null,
      render: { enabled: true, pages: selectRenderPages(pageTypes), max_render_requests: limits().max_render_requests }, ...targetIdentity },
    evaluation_version: versions().evaluation, protocol_version: versions().protocol, data_sources: [], cost_decision: {},
    evidence_ref: CONTEXT_FILE, environment_probe: answers.probe, audited: true,
  };
  const { protocol_hash } = freezeProtocol(context);
  const intake = { run_id: context.run_id, target: context.target, protocol_hash, approved_by: APPROVED_BY,
    decisions: families.filter(family => family.applicability_decision).map(family => ({ scope: 'family', family_id: family.family_id,
      condition: family.applicability_decision.condition, reason: family.applicability_decision.reason })),
    selection: { pages: pages.length, limit: requestLimit(scope), dropped_fact_pages: dropped, start_redirect: adopted, sources }, answers: keptAnswers(answers) };
  const mappings = providers.map(provider => ({ file: `owner-mapping-${provider}.json`,
    record: { run_id: context.run_id, target: context.target, ...mapping(provider), approved_by: APPROVED_BY } }));
  return { context, intake, mappings, adopted };
}

const contextStage = {
  name: 'context',
  async run(state, deps) {
    validateEntity('IntakeAnswers', state.answers);
    const { context, intake, mappings, adopted } = await contextFrom(state.answers, { out: state.out, localTargets: deps.localTargets });
    await mkdir(state.out, { recursive: true });
    await writeFile(path.join(state.out, CONTEXT_FILE), json(context), { flag: 'wx' });
    await writeFile(path.join(state.out, INTAKE_FILE), json(intake), { flag: 'wx' });
    for (const { file, record } of mappings) await writeFile(path.join(state.out, file), json(record), { flag: 'wx' });
    return { state: { ...state, context, modules: RUN_MODULES, start_redirect: adopted } };
  },
};

/** The run's evidence store; a run opens it once, and refuses to reuse a directory that already holds a run. */
async function ensureStore(state, deps) {
  if (state.store) return state.store;
  const evidenceDir = path.join(state.out, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  const documentRef = name => path.join(evidenceDir, DOCUMENTS[name]);
  const { context } = state;
  const store = deps.store ?? openStore(evidenceDir, { run_id: context.run_id, context_ref: context.evidence_ref,
    collection_ref: documentRef('collection'), module_output_ref: documentRef('modules'),
    observations_ref: documentRef('observations'), ledger_ref: documentRef('ledger'), modules: state.modules });
  for (const existing of [documentRef('collection'), store.indexRef]) if (await exists(existing)) throw new Error('run evidence index already exists');
  state.store = store;
  state.evidenceDir = evidenceDir;
  return store;
}

/** The transport the run reaches the site with, chosen once for the collect, field-data and render stages. */
async function routeOf(state, deps) {
  state.route ??= await deps.selectTransport({ env: deps.env, probeHost: urlTarget(new URL(state.context.target)).host });
  return state.route;
}

async function magnus(artifact) {
  return new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'python' : 'python3', [magnusScript, '--stdin', '--source-url', artifact.final_url, '--json'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > limits().max_bytes) child.kill(); else chunks.push(chunk); });
    child.on('error', () => resolve({ status: 'unavailable', reason: 'python_unavailable' }));
    child.on('close', code => {
      if (code !== 0) return resolve({ status: 'unavailable', reason: 'python_audit_failed' });
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve({ status: 'unavailable', reason: 'python_output_invalid' }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(artifact.body);
  });
}

/**
 * The owner's export files from the start answers, read through the import adapter. A file that is missing or cannot be read is
 * recorded with its reason (`owner_exports` in the audit index) and never stops the run; the report lists it as remaining work.
 * A readable file is kept as evidence (the bytes, and the rows read from them) so the numbers can be replayed.
 */
async function ingestOwnerExports(state, env) {
  const { context, store } = state;
  const entries = [];
  for (const { kind, path: file } of state.answers?.owner_exports ?? []) {
    try {
      // A path is read as the owner wrote it: `~` is the home folder, and a relative path starts at the answers file's folder.
      const where = path.resolve(state.answersDir ?? '.', file.replace(/^~(?=$|[\\/])/, keyHome(env)));
      if ((await stat(where)).size > limits().max_bytes) throw Object.assign(new Error('too large'), { reason: 'export_file_too_large' });
      const bytes = await readFile(where);
      const parsed = readOwnerExport(kind, bytes);
      const raw = await store.write('owner-export', bytes);
      const { host } = urlTarget(new URL(context.target));
      const ref = `owner-export-${kind}.json`;
      const metadata = { timezone: parsed.window.timezone, collected_at: (await stat(where)).mtime.toISOString(), source_ref: OWNER_SOURCE,
        evidence_ref: ref, window: parsed.window, sample_selection: parsed.sample_selection, property: host, hostname: host, path: '/' };
      normalizeImport(parsed.provider, parsed.rows, metadata);
      await writeFile(path.join(state.out, ref), json({ kind: 'native_export', run_id: context.run_id, provider: parsed.provider,
        raw_ref: raw.ref, raw_sha256: raw.sha256, metadata, rows: parsed.rows }), { flag: 'wx' });
      entries.push({ kind, status: 'read', ref });
    } catch (error) {
      const reason = error.reason ?? (error.code === 'ENOENT' ? 'export_file_missing' : error.name === 'ContractError' ? 'export_not_accepted' : 'export_file_unreadable');
      entries.push({ kind, status: 'unusable', reason });
    }
  }
  if (entries.length) await store.set('owner_exports', entries);
}

/** Collect the pages, persist the collector bytes and records, and run the offline modules over them. */
const collectStage = {
  name: 'collect',
  async run(state, deps) {
    const { context, modules } = state;
    const store = await ensureStore(state, deps);
    const route = await routeOf(state, deps);
    const documentRef = name => path.join(state.evidenceDir, DOCUMENTS[name]);
    const collection = await collect(context, { transport: route.transport, resolve: route.resolve, addressVetting: route.address_vetting });
    const artifacts = [];
    for (const artifact of collection.artifacts) {
      const { body, ...saved } = artifact;
      if (artifact.content_hash) {
        const { ref } = await store.write(artifact.capability === 'raw_html' ? 'html' : 'bin', body);
        saved.raw_html_ref = artifact.capability === 'raw_html' ? ref : null;
        saved.evidence_ref = ref;
      } else saved.evidence_ref = documentRef('collection');
      await store.append('raw', { normalized_url: saved.normalized_url, evidence_ref: saved.evidence_ref, content_hash: saved.content_hash });
      if (Number.isInteger(artifact.status)) {
        // Hash the final URL, redirect chain and response header lines next to the raw body so the report replays from them.
        const { ref, sha256 } = await store.write('response', json({ record_version: '1', requested_url: artifact.requested_url,
          normalized_url: artifact.normalized_url, final_url: artifact.final_url, status: artifact.status,
          redirect_chain: artifact.redirect_chain, header_lines: artifact.header_lines,
          content_hash: artifact.content_hash, capability: artifact.capability }));
        saved.response_ref = ref;
        await store.append('responses', { normalized_url: artifact.normalized_url, evidence_ref: ref, content_hash: sha256 });
      } else {
        // A failed fetch has no response, but its answered redirect hops were real requests: hash them in a failure record
        // so the ledger can prove the count (answered hops plus at most one unanswered attempt).
        const { ref, sha256 } = await store.write('failure', json({ record_version: '1', kind: 'failure', requested_url: artifact.requested_url,
          normalized_url: artifact.normalized_url, redirect_chain: artifact.redirect_chain, unanswered: artifact.unanswered ?? 0,
          error: artifact.error }));
        saved.failure_ref = ref;
        await store.append('failures', { normalized_url: artifact.normalized_url, evidence_ref: ref, content_hash: sha256 });
      }
      artifacts.push(saved);
    }
    const module_outputs = Object.fromEntries(modules.map(x => [x, []]));
    const declaredRobots = new Set((context.protocol.auxiliary_resources ?? [])
      .filter(resource => resource.kind === 'robots').map(resource => resource.normalized));
    const selectedUrls = new Set(context.protocol.page_types.flatMap(type => type.urls.map(x => x.normalized)));
    for (const artifact of collection.artifacts) {
      if (!selectedUrls.has(artifact.normalized_url) || artifact.capability !== 'raw_html' || artifact.status !== 200) continue;
      const html = artifact.body.toString('utf8');
      if (modules.includes(NAVER_MODULE)) {
        const robotsIndex = declaredRobotsIndex(collection.artifacts, declaredRobots, artifact.final_url);
        const robots = robotsIndex < 0 ? null : collection.artifacts[robotsIndex];
        const robotsEvidenceRef = robots?.status === 200 ? artifacts[robotsIndex].evidence_ref : null;
        const output = auditCollected({ artifact, html, engines: context.protocol.engines,
          robotsArtifact: robots ? { ...robots, body: robots.body.toString('utf8') } : null });
        output.robots_evidence_ref = robotsEvidenceRef;
        module_outputs[NAVER_MODULE].push(output);
      }
      if (modules.includes(MAGNUS_MODULE)) module_outputs[MAGNUS_MODULE].push(await magnus(artifact));
    }
    const document = (name, value) => store.write(name, json(value), { name: DOCUMENTS[name] });
    await document('collection', { artifacts, discovered_count: collection.discovered_count,
      evaluated_count: collection.evaluated_count, request_count: collection.request_count, skipped: collection.skipped, limit_reached: collection.limit_reached });
    await document('ledger', { entries: collection.ledger, limit: requestLimit(context.scope) });
    await document('modules', module_outputs);
    await ingestOwnerExports(state, deps.env);
    state.audit = { artifacts, module_outputs, discovered_count: collection.discovered_count, evaluated_count: collection.evaluated_count,
      request_count: collection.request_count, skipped: collection.skipped, limit_reached: collection.limit_reached };
    return { state };
  },
};

/** Render the fixed sample pages; the result of the Chrome lookup goes into the audit index (`chrome`) for replay. */
const renderStage = {
  name: 'render',
  async run(state, deps) {
    const { context, store } = state;
    // Nothing to render or measure when not one selected page answered: say so plainly instead of reporting an empty audit.
    const selected = new Set(context.protocol.page_types.flatMap(type => type.urls.map(url => url.normalized)));
    if (!state.audit.artifacts.some(artifact => selected.has(artifact.normalized_url) && Number.isInteger(artifact.status)))
      throw new Error('None of the selected pages could be fetched, so there is nothing to audit. Check that the address is right and that the site can be reached from this computer, then start again.');
    const handle = deps.chrome.open({ context, route: await routeOf(state, deps) });
    const { chrome } = await renderPages({ context, chrome: handle, store });
    await store.set('chrome', chrome);
    return { state: { ...state, chrome_handle: handle, chrome_result: chrome } };
  },
};

/** Lab LCP and CLS of the first sample page: a reference for the report, never a verdict. */
async function measureLab(state) {
  const [page] = state.context.protocol.render.pages;
  const browser = page && await state.chrome_handle.get();
  if (!browser) return null;
  let session = null;
  try {
    session = await scopedPage({ chrome: browser, context: state.context, budget: state.context.protocol.render.max_render_requests, fetchStatic: state.chrome_handle.fetchStatic });
    const loaded = await session.goto(page.normalized);
    // The lab number of an error or blocked page says nothing about the site, and a failed measure is not worth stopping the audit for.
    return loaded.status === HTTP_OK && !loaded.blocked_reason && !loaded.error ? await labCwv({ page: session }) : null;
  } catch { return null; }
  finally { await session?.close().catch(() => {}); }
}

/**
 * Field CWV of each public origin, from the user's own Google key when there is one. A local origin has no public field data
 * and is not sent to Google. Without any usable field answer, and with a Chrome, the lab measure is taken and kept in
 * `state.lab_cwv` only (D16).
 */
const cwvStage = {
  name: 'cwv',
  async run(state, deps) {
    const { context, store } = state;
    const origins = [...new Set(context.protocol.page_types.flatMap(type => type.urls.map(url => url.normalized))
      .filter(url => !isLocalTarget(context.scope, url)).map(url => new URL(url).origin))];
    if (origins.length) {
      const route = await routeOf(state, deps);
      const key = readGoogleKey({ env: deps.env, home: deps.home ?? keyHome(deps.env) });
      const fetchFn = deps.fetchFn ?? transportFetch(route, { timeoutMs: limits().cwv_timeout_ms, maxBytes: limits().cwv_max_bytes });
      for (const origin of origins) await collectCwv({ origin, key, fetchFn, store });
    }
    const stored = await readStored(state);
    const selected = new Map(context.protocol.page_types.flatMap(type => type.urls).map(url => [url.normalized, url]));
    const hasField = [lcpField, inpField, clsField].some(block =>
      block.derive({ context, artifacts: state.audit.artifacts, selected, cwv: stored.cwv }).some(observation => observation.state !== 'unknown'));
    const lab_cwv = !hasField && state.chrome_result?.found === true ? await measureLab(state) : null;
    // Kept in the index (not as a verdict) so a resumed run still shows it; replay never reads it.
    if (lab_cwv) await store.set('lab_cwv', lab_cwv);
    return { state: { ...state, lab_cwv } };
  },
};

/**
 * Everything the verdicts are re-derived from, read back through the store so each hash is checked: the collected pages, the
 * render records and their DOMs, the field-data answers and the Chrome result. The derive stage and the resume both use it,
 * so what the first call derived is what the second call re-derives.
 */
async function readStored(state) {
  const { store } = state;
  const index = await store.index();
  const text = async (ref, sha) => (await store.read(ref, sha)).toString('utf8');
  const collection = JSON.parse(await readFile(index.collection_ref, 'utf8'));
  const bodies = new Map();
  for (const artifact of collection.artifacts) if (artifact.content_hash) bodies.set(artifact.evidence_ref, await text(artifact.evidence_ref, artifact.content_hash));
  for (const entry of [...index.raw.filter(x => x.content_hash), ...index.responses, ...index.failures]) await store.read(entry.evidence_ref, entry.content_hash);
  const renders = [];
  const doms = new Map();
  for (const entry of index.renders) {
    // The record carries the evidence ref it was read from, so a verdict inherited from a rendered page can cite it.
    const record = { ...JSON.parse(await text(entry.evidence_ref, entry.sha256)), evidence_ref: entry.evidence_ref };
    if (record.dom_ref) doms.set(record, await text(record.dom_ref, record.dom_sha256));
    renders.push(record);
  }
  const cwv = [];
  for (const entry of index.cwv) cwv.push({ ...JSON.parse(await text(entry.evidence_ref, entry.sha256)), evidence_ref: entry.evidence_ref });
  return { index, collection, cwv, renders, input: { context: state.context, artifacts: collection.artifacts, collection,
    textOf: artifact => artifact.content_hash ? bodies.get(artifact.evidence_ref) : null, renders, renderTextOf: record => doms.get(record) ?? '',
    chrome: index.chrome ?? null, cwv } };
}

/** The hash of every run document the index does not hash itself, so a resume can tell an edited one. Names are relative to `out`. */
async function documentHashes(state) {
  const names = [CONTEXT_FILE, INTAKE_FILE, ...(await readdir(state.out)).filter(name => OWNER_EXPORT_FILE.test(name) || OWNER_MAPPING_FILE.test(name)),
    ...Object.values(DOCUMENTS).map(name => path.join('evidence', name))].filter(name => !(state.ownerless && [CONTEXT_FILE, INTAKE_FILE].includes(name)));
  const hashes = {};
  for (const name of names) hashes[name.split(path.sep).join('/')] = sha256Of(await readFile(path.join(state.out, name)));
  return hashes;
}

const deriveStage = {
  name: 'derive',
  async run(state) {
    const { store } = state;
    const observations = deriveObservations((await readStored(state)).input);
    await store.write('observations', json(observations), { name: DOCUMENTS.observations });
    await store.index();
    // `audit.mjs` runs without a context or intake file of its own; only a full run records those too.
    await store.set('documents', await documentHashes({ ...state, ownerless: !state.answers }));
    return { state: { ...state, observations } };
  },
};

/**
 * The queue as the model reads it: one entry per page, with the page's candidate spans once and the units to judge on it. The
 * stored queue keeps one item per unit (each repeating the page's spans); this file is only the shorter view of it.
 */
function queueByPage(queue) {
  const pages = new Map();
  for (const item of queue.items) {
    // By address, not by evidence: two pages whose bytes are identical share an evidence file and are still two pages.
    if (!pages.has(item.url)) pages.set(item.url, { url: item.url, evidence_ref: item.evidence_ref, evidence_sha256: item.evidence_sha256, spans: item.spans, families: [] });
    pages.get(item.url).families.push({ family_id: item.family_id, unit_key: item.unit_key });
  }
  return { pages: [...pages.values()] };
}

/** Judge: build the queue the model works from; with the model's judgments, merge them in and go on. */
const judgeStage = {
  name: JUDGE_STAGE,
  async run(state) {
    const { store, out } = state;
    const queue = await buildJudgeQueue({ observations: state.observations, store });
    await writeFile(path.join(out, QUEUE_FILE), json(queueByPage(queue)));
    if (state.judgments) return { state: { ...state, queue, observations: await mergeJudgments({ observations: state.observations, judgments: state.judgments, store }) } };
    if (queue.items.length) return { state: { ...state, queue }, halt: HALT_JUDGMENTS };
    return { state: { ...state, queue } };
  },
};

const scoreStage = {
  name: 'score',
  async run(state) {
    const input = { schema_version: versions().contract_schema, run_context: state.context, observations: state.observations };
    const scores = score(input);
    // The file `cli.mjs compare` takes as a ScoreInput, so a later audit can be compared with this one.
    await writeFile(path.join(state.out, SCORE_INPUT_FILE), json(input));
    return { state: { ...state, input, scores } };
  },
};

/** Where each file of the evidence folder belongs in the report packet's evidence list: its kind, and whether the collector wrote it. */
const EVIDENCE_KINDS = [[/\.html$/, 'raw_html', true], [/\.bin$/, 'raw_response', true], [/\.response\.json$/, 'response_record', true],
  [/\.failure\.json$/, 'failure_record', true], [/\.render-dom$/, 'render_dom', false], [/\.render\.json$/, 'render', true],
  [/\.cwv\.json$/, 'cwv', true], [/\.judge-queue\.json$/, 'judge-queue', false], [/\.owner-export$/, 'owner_export', false], [/^(?:collection|ledger)\.json$/, 'record', true]];

const RUN_FILE = /^(?:[0-9a-f]{64}\..+|(?:collection|ledger|modules|observations)\.json|.*\.tmp)$/;
const OWNER_EXPORT_FILE = /^owner-export-[a-z]+\.json$/;
const OWNER_MAPPING_FILE = /^owner-mapping-[a-z]+\.json$/;

async function evidenceList(state) {
  const { context, evidenceDir } = state;
  const entry = async (ref, kind, source_ref) => ({ ref, sha256: sha256Of(await readFile(path.resolve(state.out, ref))), kind, run_id: context.run_id,
    ...(source_ref ? { source_ref } : {}) });
  const list = [await entry(CONTEXT_FILE, 'context'), await entry(INTAKE_FILE, 'intake'), await entry(COSTS_FILE, 'record')];
  // The owner's export rows (a metric cites them) and the approval of the property each export describes.
  for (const name of (await readdir(state.out)).sort()) {
    if (OWNER_EXPORT_FILE.test(name)) list.push(await entry(name, 'native_export', OWNER_SOURCE));
    else if (OWNER_MAPPING_FILE.test(name)) list.push(await entry(name, 'applicability'));
  }
  for (const name of (await readdir(evidenceDir)).sort()) {
    const [, kind = 'record', collector = false] = EVIDENCE_KINDS.find(([pattern]) => pattern.test(name)) ?? [];
    list.push(await entry(path.join(evidenceDir, name), kind, collector ? OBSERVATION_SOURCES.code : null));
  }
  return list;
}

/**
 * The fix list: one finding for each distinct problem, not for each page it appears on. Failed verdicts with the same check and
 * the same message (the page's own address left out of it) are one finding that lists every page it affects in `unit_keys`; its
 * own unit is the first of them. A verdict that states several problems (`problemsOf`) joins one group per problem; a finding
 * that is not its first unit's first problem gets that problem's position in its id. A finding keeps the catalog key and values
 * of its problem beside the English message, so the report can say it in Korean. A model's finding is marked with the model
 * source and cites the page evidence the collector stored.
 */
function findingsOf(observations, evidence) {
  const blocking = new Set(checkRegistry().families.filter(family => family.blocker_on_fail).map(family => family.family_id));
  const core = new Set(checkRegistry().families.filter(family => family.core_policy).map(family => family.family_id));
  const groups = new Map();
  for (const observation of [...observations].filter(x => x.state === 'fail').sort((a, b) => a.unit_key < b.unit_key ? -1 : a.unit_key > b.unit_key ? 1 : 0)) {
    const model = observation.evaluator_type === 'host_model';
    const blocker = observation.blocker === true || blocking.has(observation.family_id);
    for (const [position, problem] of problemsOf(observation).entries()) {
      const key = JSON.stringify([observation.check_id, pageNeutral(problem, observation.unit_key), model, blocker]);
      if (!groups.has(key)) groups.set(key, { observation, problem, position, model, blocker, stated: observation.problem_messages?.[position], unit_keys: [] });
      groups.get(key).unit_keys.push(observation.unit_key);
    }
  }
  return [...groups.values()].map(({ observation, problem, position, model, blocker, stated, unit_keys }) => ({ schema_version: versions().contract_schema,
    finding_id: `finding-${observation.observation_id}${position ? `-${position}` : ''}`, check_id: observation.check_id, unit_key: observation.unit_key, unit_keys,
    priority: blocker ? 'P0' : core.has(observation.family_id) ? 'P1' : 'P2', blocker, message: problem,
    ...(stated ? { message_key: stated.message_key, message_values: stated.message_values } : {}),
    source_ref: model ? OBSERVATION_SOURCES.host_model : evidence.find(x => x.ref === observation.evidence_ref)?.source_ref ?? observation.source_ref,
    evidence_ref: observation.evidence_ref, remediation_ids: [], status: 'confirmed' }));
}

// What the report says next to an export that could not be used.
const EXPORT_PROBLEMS = {
  export_file_missing: 'No file was found at the path given',
  export_file_unreadable: 'The file could not be opened',
  export_file_too_large: 'The file is larger than this audit reads',
  export_not_a_zip: 'The file is not the zip archive Search Console gives',
  export_zip_damaged: 'The zip archive is damaged',
  export_zip_method_unsupported: 'The zip archive uses a compression this audit does not read',
  export_table_not_found: 'The file holds no table with clicks and impressions',
  export_numbers_unreadable: 'The numbers in the table could not be read',
  export_period_missing: 'The pasted text does not show the period it covers',
  export_not_accepted: 'The numbers did not pass the import checks',
};

/** The metrics the owner's exports give (re-read from the stored rows, so a resumed run has them too) and a remaining-work row for each export that could not be used. */
async function ownerExportResults(state) {
  const metrics = [];
  const remaining = [];
  // A preflight that was there but could not be used leaves the sample at the start page and the fact pages; the report says so.
  const selection = JSON.parse(await readFile(path.join(state.out, INTAKE_FILE), 'utf8')).selection;
  if (selection?.sources?.preflight === 'unreadable') remaining.push({ problem: 'The read of the site made before the start questions could not be used, so only the start page and the pages with confirmed facts were audited',
    reason: 'preflight_unreadable', required_input_or_authority: 'A new read of the site', next_action: 'Run the start read again, then start the audit again in a new --out folder',
    reobserve_when: 'on the next run that starts from a readable start read', message_key: 'follow-up.preflight-unreadable', message_values: {} });
  for (const entry of (await state.store.index()).owner_exports ?? []) {
    if (entry.status === 'read') {
      const stored = JSON.parse(await readFile(path.join(state.out, entry.ref), 'utf8'));
      metrics.push(...normalizeImport(stored.provider, stored.rows, stored.metadata));
    } else remaining.push({ problem: `The ${entry.kind} export file could not be used: ${EXPORT_PROBLEMS[entry.reason] ?? entry.reason}`, reason: entry.reason,
      required_input_or_authority: 'A new export file from the site owner', next_action: 'Export the report again as the runbook describes and give its path in the start answers',
      reobserve_when: 'on the next run that includes the new file', message_key: 'follow-up.export-unusable', message_values: { kind: entry.kind, reason: entry.reason } });
  }
  return { metrics, remaining };
}

/** Each runbook the report's blank items point to, loaded once at the guidance level the start answers chose. */
const runbooksOf = (composed, level) => [...new Set(composed.remaining.flatMap(row => row.runbook_ids))].map(id => loadRunbook(id, level, { skillRoot: SKILL_ROOT }));

/** Wrap the run's evidence in a replayable packet and write `report.json`, `report.md` and `report.html`; the report replays every verdict from it. */
const reportStage = {
  name: 'report',
  async run(state) {
    const { context, input, out, store } = state;
    const costs = { schema_version: versions().contract_schema, run_id: context.run_id, budgets: [], reservations: [], settlements: [],
      approval_ref: null, source_ref: RUN_SOURCE, evidence_ref: COSTS_FILE };
    // Overwritten, not created: a report stage that stopped after this write must be able to run again.
    await writeFile(path.join(out, COSTS_FILE), json(costs));
    const evidence_index = await evidenceList(state);
    const { metrics, remaining } = await ownerExportResults(state);
    const packet = { schema_version: versions().contract_schema, run_context: context, baseline: { input, scores: state.scores }, after: null,
      comparison: compare(input, null), metrics, findings: findingsOf(state.observations, evidence_index), changes: [], costs, remaining,
      evidence_root: out, evidence_index, audit_snapshots: [{ phase: PHASE, audit_ref: store.indexRef, context_ref: context.evidence_ref }],
      source_ref: RUN_SOURCE, data_class: 'real', lab_cwv: state.lab_cwv ?? null, start_redirect: state.start_redirect ?? null };
    const level = state.answers.guidance_level;
    const renderHtml = composed => renderHtmlReport(composed, { runbooks: runbooksOf(composed, level), level, target: context.target, synthetic: packet.data_class === 'synthetic' });
    const { jsonPath, markdownPath, htmlPath } = await writeReport(packet, out, { renderHtml });
    return { state: { ...state, packet, reports: { json: jsonPath, md: markdownPath, html: htmlPath } } };
  },
};

/** The stages of one audit in order. A fresh list each call, so a caller may insert or drop a stage in its own copy. */
export function stages() {
  return [contextStage, collectStage, renderStage, cwvStage, deriveStage, judgeStage, scoreStage, reportStage];
}

// The files a first call writes in the run folder (besides the evidence folder); none of them is the owner's.
const FIRST_CALL_FILES = [CONTEXT_FILE, INTAKE_FILE, COSTS_FILE, QUEUE_FILE, SCORE_INPUT_FILE];

/**
 * What to do with the run folder. A folder whose first call stored a judge queue is resumed. A folder with a finished report is
 * refused in plain words. Anything else is a first call that stopped early (closed terminal, timeout): its own files are cleared
 * and the run starts over; `preflight/` and the answers file are never touched.
 */
export async function prepareOutput(out) {
  const indexFile = path.join(out, 'evidence', 'evidence-index.json');
  let queued = false, savedObservation = null;
  if (await exists(indexFile)) {
    try {
      const index = JSON.parse(await readFile(indexFile, 'utf8'));
      queued = index.judge_queue?.length > 0;
      // An older release's audit writes the same index keys, so only the verdicts it saved carry its version labels.
      const saved = await readFile(path.join(out, 'evidence', path.basename(String(index.observations_ref ?? ''))), 'utf8').then(JSON.parse, () => null);
      savedObservation = Array.isArray(saved) ? saved[0] ?? null : null;
    } catch { return 'resume'; }
  }
  if (await exists(path.join(out, 'report.json'))) throw new Error('This folder already holds a finished audit. Use a new --out folder for a new one.');
  // A folder an older optbrew started is neither resumed nor cleared: its evidence is not this release's to judge or delete.
  const earlier = await readFile(path.join(out, CONTEXT_FILE), 'utf8').then(JSON.parse, () => null);
  assertCurrentEvidence(earlier, 'run folder');
  assertCurrentEvidence(savedObservation, 'run folder');
  if (queued) return 'resume';
  const names = await readdir(out).catch(() => []);
  const owned = [...FIRST_CALL_FILES, 'evidence', ...names.filter(name => OWNER_EXPORT_FILE.test(name) || OWNER_MAPPING_FILE.test(name))];
  // Only a folder this tool wrote is cleared: the files to clear must be provably the run's own, or nothing is touched.
  if (owned.some(name => names.includes(name)) && !(await wroteByRun(out, names)))
    throw new Error('This folder holds files this audit did not make (for example an evidence or context.json of your own). Use a new --out folder.');
  await Promise.all(owned.map(name => rm(path.join(out, name), { recursive: true, force: true })));
  return 'fresh';
}

/** Proof that the first-call files in a folder are the run's own: its evidence index and context.json name the same run, or (before the index exists) context.json and intake.json do. */
async function wroteByRun(out, names) {
  const read = async file => { try { return JSON.parse(await readFile(path.join(out, file), 'utf8')); } catch { return null; } };
  const context = await read(CONTEXT_FILE);
  if (!context?.run_id) return false;
  const sameRun = (await read(INTAKE_FILE))?.run_id === context.run_id;
  if (!names.includes('evidence')) return sameRun;
  const index = await read(path.join('evidence', 'evidence-index.json'));
  if (index) return index.run_id === context.run_id;
  // A run that stopped before its first index save leaves only content-addressed blobs, its fixed documents and temp files.
  return sameRun && (await readdir(path.join(out, 'evidence'))).every(name => RUN_FILE.test(name));
}

/**
 * The state a first call left in `<out>`, rebuilt from the evidence index and the fixed context it points to; nothing else
 * is saved between calls. Every hash is checked (the evidence the index lists, and the run documents it records), and the
 * verdicts are derived again from the stored evidence: they must equal the recorded ones. Anything that fails stops the run with
 * one error; nothing is collected again.
 */
export async function restoreState({ out, answers }) {
  const evidenceDir = path.join(out, 'evidence');
  const store = openStore(evidenceDir);
  // Whatever fails while the stored evidence is read back or re-derived is one condition with one message.
  // A folder an older optbrew made is the exception: it is one plain migration sentence, not a change.
  const changed = async job => { try { return await job(); } catch (error) { throw error instanceof MigrationRequired ? error : new Error(INDEX_CHANGED); } };
  const recorded = await changed(async () => JSON.parse(await readFile(store.indexRef, 'utf8')));
  const { context, intake } = await changed(async () => {
    const value = JSON.parse(await readFile(path.resolve(out, recorded.context_ref), 'utf8'));
    assertCurrentEvidence(value, 'run folder');
    validateEntity('RunContext', value);
    if (recorded.run_id !== value.run_id) throw new Error('another run');
    for (const [name, sha] of Object.entries(recorded.documents)) if (sha256Of(await readFile(path.join(out, name))) !== sha) throw new Error('edited document');
    return { context: value, intake: JSON.parse(await readFile(path.join(out, INTAKE_FILE), 'utf8')) };
  });
  if (intake.answers?.url !== answers.url) throw new Error('The answers are not the ones this run was made from; use the same answers file, or a new --out folder.');
  const state = { answers, out, evidenceDir, store, context, modules: recorded.modules, start_redirect: intake.selection?.start_redirect ?? null };
  return changed(async () => {
    const stored = await readStored(state);
    const saved = JSON.parse(await readFile(recorded.observations_ref, 'utf8'));
    const observations = deriveObservations(stored.input);
    if (JSON.stringify(observations) !== JSON.stringify(saved)) throw new Error('verdicts differ');
    if (!stored.index.judge_queue?.length) throw new Error('no queue');
    return { ...state, observations, chrome_result: stored.index.chrome ?? null, lab_cwv: stored.index.lab_cwv ?? null };
  });
}

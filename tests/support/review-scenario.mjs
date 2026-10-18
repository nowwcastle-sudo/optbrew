import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from './temp-dir.mjs';
import { runAudit } from '../../skills/optbrew/scripts/audit.mjs';
import { score } from '../../skills/optbrew/scripts/core/score.mjs';
import { compare } from '../../skills/optbrew/scripts/core/compare.mjs';
import { freezeProtocol } from '../../skills/optbrew/scripts/core/protocol.mjs';
import { checkRegistry } from '../../skills/optbrew/scripts/core/config.mjs';

const template = new URL('../fixtures/scoring/before.json', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export const page = (head = '', body = 'Service page', title = 'Example service') =>
  `<html><head>${title ? `<title>${title}</title>` : ''}${head}</head><body>${body}</body></html>`;

/** Local HTTP site; each route returns { status, headers, body } and every request path is recorded. */
export async function startSite(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const route = routes[req.url] ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: 'missing' };
    const { status = 200, headers = {}, headerList = null, body = '' } = typeof route === 'function' ? route(req) : route;
    // headerList sends repeated header lines (for example two X-Robots-Tag lines) exactly as given.
    res.writeHead(status, headerList ?? { 'content-type': 'text/html', ...headers });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { port, origin: `http://127.0.0.1:${port}`, requests,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}

/** Audit local pages and wrap the preserved run evidence in a replayable report packet. */
export async function buildScenario(site, paths, { engines = ['google'], robots = false, sitemap = false, enable = [], modules = ['naver-searchadvisor'], maxUrls = 50, name = 'scenario', render = [], questions = [] } = {}) {
  const dir = await tempDir(`optbrew-final-review-${name}-`);
  const { origin, port } = site;
  const context = structuredClone(JSON.parse(await readFile(template, 'utf8')).run_context);
  context.run_id = `final-review-${name}`;
  context.target = origin + paths[0];
  context.environment = 'local';
  context.evidence_ref = 'context.json';
  context.audited = true;
  context.scope = { allowed: [{ origin, path_prefix: '/' }], local_targets: [{ host: '127.0.0.1', port }], max_urls: maxUrls };
  context.protocol.page_types = [{ id: 'primary', urls: paths.map(p => ({ original: origin + p, normalized: origin + p })) }];
  context.protocol.engines = engines;
  if (questions.length) context.protocol.question_panel = questions;
  for (const family of context.protocol.families) if (family.applicability_decision) family.applicability_decision.evidence_ref = 'intake.json';
  const bound = checkRegistry().families.filter(family => family.engines?.some(engine => engines.includes(engine))).map(family => family.family_id);
  for (const id of [...bound, ...enable]) {
    const family = context.protocol.families.find(x => x.family_id === id);
    family.applicable = true; delete family.applicability_decision;
  }
  if (render.length) context.protocol.render = { ...context.protocol.render, enabled: true, pages: render.map(p => ({ original: origin + p, normalized: origin + p })) };
  const auxiliary = [];
  if (robots) auxiliary.push({ kind: 'robots', original: `${origin}/robots.txt`, normalized: `${origin}/robots.txt` });
  if (sitemap) auxiliary.push({ kind: 'sitemap', original: `${origin}/sitemap.xml`, normalized: `${origin}/sitemap.xml` });
  if (auxiliary.length) context.protocol.auxiliary_resources = auxiliary;
  const audit = await runAudit({ context, modules, outputDir: dir });
  const index = [];
  async function add(ref, kind, source_ref) {
    if (index.some(x => x.ref === ref)) return;
    index.push({ ref, sha256: sha(await readFile(path.resolve(dir, ref))), kind, run_id: context.run_id, ...(source_ref ? { source_ref } : {}) });
  }
  async function record(ref, value, kind = 'record', source_ref) {
    await writeFile(path.resolve(dir, ref), `${JSON.stringify(value, null, 2)}\n`);
    await add(ref, kind, source_ref);
  }
  await record('context.json', context, 'context');
  await record('intake.json', { run_id: context.run_id, target: context.target, protocol_hash: freezeProtocol(context).protocol_hash,
    approved_by: 'final review fixture', decisions: context.protocol.families.filter(f => f.applicability_decision).map(f => ({
      scope: 'family', family_id: f.family_id, condition: f.applicability_decision.condition, reason: f.applicability_decision.reason })) }, 'intake');
  const costs = { schema_version: '2.0.0', run_id: context.run_id, budgets: [], reservations: [], settlements: [],
    approval_ref: null, source_ref: 'review-fixture', evidence_ref: 'costs.json' };
  await record('costs.json', costs);
  for (const file of ['collection.json', 'modules.json', 'observations.json', 'evidence-index.json'])
    await add(path.join(dir, 'evidence', file), 'record', file === 'collection.json' ? 'optbrew:collector' : undefined);
  if (existsSync(path.join(dir, 'evidence', 'ledger.json'))) await add(path.join(dir, 'evidence', 'ledger.json'), 'record', 'optbrew:collector');
  for (const artifact of audit.artifacts) {
    await add(artifact.evidence_ref, artifact.capability === 'raw_html' ? 'raw_html' : 'raw_response', 'optbrew:collector');
    if (artifact.response_ref) await add(artifact.response_ref, 'response_record', 'optbrew:collector');
    if (artifact.failure_ref) await add(artifact.failure_ref, 'failure_record', 'optbrew:collector');
  }
  const input = { schema_version: '2.0.0', run_context: context, observations: audit.observations };
  const packet = { schema_version: '2.0.0', run_context: context, baseline: { input, scores: score(input) }, after: null,
    comparison: compare(input, null), metrics: [], findings: [], changes: [], costs, remaining: [],
    evidence_root: dir, evidence_index: index, audit_ref: audit.evidence_ref, source_ref: 'review-fixture', data_class: 'synthetic' };
  const evidence = name => path.join(dir, 'evidence', name);
  const scenario = { dir, context, audit, packet, evidence, record, add,
    /** Rewrite an indexed JSON evidence file and refresh its hash, as a self-consistent forger would. */
    async rewrite(ref, mutate) {
      const value = JSON.parse(await readFile(ref, 'utf8'));
      const next = mutate(value) ?? value;
      const bytes = `${JSON.stringify(next, null, 2)}\n`;
      await writeFile(ref, bytes);
      packet.evidence_index.find(x => x.ref === ref).sha256 = sha(bytes);
      return next;
    },
    /** Replace baseline observations in the packet and in the saved audit observation file. */
    async forgeObservations(mutate) {
      mutate(packet.baseline.input.observations);
      await scenario.rewrite(evidence('observations.json'), () => packet.baseline.input.observations);
      packet.baseline.scores = score(packet.baseline.input);
      packet.comparison = compare(packet.baseline.input, null);
    },
    observation: (check, urlPath) => packet.baseline.input.observations.find(x => x.check_id === check && x.unit_key.endsWith(origin + urlPath)),
    finding(observation, overrides = {}) {
      return { schema_version: '2.0.0', finding_id: `finding-${observation.check_id}`, check_id: observation.check_id,
        unit_key: observation.unit_key, priority: 'P0', blocker: true, message: 'Unexpected noindex',
        source_ref: observation.source_ref, evidence_ref: observation.evidence_ref, remediation_ids: [], status: 'confirmed', ...overrides };
    } };
  return scenario;
}

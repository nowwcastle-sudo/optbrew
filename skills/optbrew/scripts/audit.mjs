#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEntity } from './core/contracts.mjs';
import { limits } from './core/config.mjs';
import { collect, declaredRobotsIndex } from './core/collector.mjs';
import { auditCollected } from '../modules/naver-searchadvisor/scripts/audit.mjs';
import { deriveObservations } from './core/derive.mjs';
import { openStore } from './core/evidence-store.mjs';

/** Fixed file names of the run documents the evidence index points at. */
const DOCUMENTS = { collection: 'collection.json', ledger: 'ledger.json', modules: 'modules.json', observations: 'observations.json' };
const magnusScript = fileURLToPath(new URL('../modules/magnus-seo/scripts/aeo_audit.py', import.meta.url));
const supported = new Set(['naver-searchadvisor', 'magnus-seo']);

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

/** Persist collector bytes and offline module output in the same run evidence directory. */
export async function runAudit({ context, modules, outputDir, transport, resolve }) {
  validateEntity('RunContext', context);
  if (!Array.isArray(modules) || modules.some(x => !supported.has(x)) || !outputDir) throw new Error('unsupported modules or output directory');
  const evidenceDir = path.join(outputDir, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  const documentRef = name => path.join(evidenceDir, DOCUMENTS[name]);
  const store = openStore(evidenceDir, { run_id: context.run_id, context_ref: context.evidence_ref,
    collection_ref: documentRef('collection'), module_output_ref: documentRef('modules'),
    observations_ref: documentRef('observations'), ledger_ref: documentRef('ledger'), modules });
  for (const existing of [documentRef('collection'), store.indexRef]) {
    try { await access(existing); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('run evidence index already exists');
  }
  const collection = await collect(context, { transport, resolve });
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
      const { ref, sha256 } = await store.write('response', `${JSON.stringify({ record_version: '1', requested_url: artifact.requested_url,
        normalized_url: artifact.normalized_url, final_url: artifact.final_url, status: artifact.status,
        redirect_chain: artifact.redirect_chain, header_lines: artifact.header_lines,
        content_hash: artifact.content_hash, capability: artifact.capability }, null, 2)}\n`);
      saved.response_ref = ref;
      await store.append('responses', { normalized_url: artifact.normalized_url, evidence_ref: ref, content_hash: sha256 });
    }
    else {
      // A failed fetch has no response, but its answered redirect hops were real requests: hash them in a failure record
      // so the ledger can prove the count (answered hops plus at most one unanswered attempt).
      const { ref, sha256 } = await store.write('failure', `${JSON.stringify({ record_version: '1', kind: 'failure', requested_url: artifact.requested_url,
        normalized_url: artifact.normalized_url, redirect_chain: artifact.redirect_chain, unanswered: artifact.unanswered ?? 0,
        error: artifact.error }, null, 2)}\n`);
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
    if (modules.includes('naver-searchadvisor')) {
      const robotsIndex = declaredRobotsIndex(collection.artifacts, declaredRobots, artifact.final_url);
      const robots = robotsIndex < 0 ? null : collection.artifacts[robotsIndex];
      const robotsEvidenceRef = robots?.status === 200 ? artifacts[robotsIndex].evidence_ref : null;
      const output = auditCollected({ artifact, html, engines: context.protocol.engines,
        robotsArtifact: robots ? { ...robots, body: robots.body.toString('utf8') } : null });
      output.robots_evidence_ref = robotsEvidenceRef;
      module_outputs['naver-searchadvisor'].push(output);
    }
    if (modules.includes('magnus-seo')) module_outputs['magnus-seo'].push(await magnus(artifact));
  }
  // Verdicts come from one derivation shared with the report replay.
  const bodies = new Map(collection.artifacts.map(x => [x.normalized_url, x.body]));
  const observations = deriveObservations({ context, artifacts, collection,
    textOf: x => bodies.get(x.normalized_url)?.toString('utf8') ?? null });
  const result = { context_ref: context.evidence_ref, artifacts, observations, module_outputs,
    evidence_ref: store.indexRef, discovered_count: collection.discovered_count,
    evaluated_count: collection.evaluated_count, request_count: collection.request_count, skipped: collection.skipped, limit_reached: collection.limit_reached };
  const document = (name, value) => store.write(name, `${JSON.stringify(value, null, 2)}\n`, { name: DOCUMENTS[name] });
  await document('collection', { artifacts, discovered_count: collection.discovered_count,
    evaluated_count: collection.evaluated_count, request_count: collection.request_count, skipped: collection.skipped, limit_reached: collection.limit_reached });
  await document('ledger', { entries: collection.ledger, limit: Math.min(context.scope?.max_urls ?? limits().max_urls_default, limits().max_urls_default) });
  await document('modules', module_outputs);
  await document('observations', observations);
  await store.index();
  return result;
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
    const contextPath = option('--context');
    const moduleText = option('--modules');
    const outputDir = option('--output-dir');
    if (!contextPath || !moduleText || !outputDir || args.length !== 6) throw new Error('usage: node skills/optbrew/scripts/audit.mjs --context <run-context.json> --modules naver-searchadvisor,magnus-seo --output-dir <run-dir>');
    const context = JSON.parse(await readFile(contextPath, 'utf8'));
    const result = await runAudit({ context, modules: moduleText.split(','), outputDir });
    process.stdout.write(`${JSON.stringify({ evidence_ref: result.evidence_ref, evaluated_count: result.evaluated_count, request_count: result.request_count,
      observations: result.observations.length })}\n`);
  } catch (error) { process.stderr.write(`audit failed: ${error.message}\n`); process.exitCode = 2; }
}

#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEntity } from './core/contracts.mjs';
import { runStages, stages } from './core/stages.mjs';

const supported = new Set(['naver-searchadvisor', 'magnus-seo']);
// The collection and the derivation of the collector verdicts: the stages `run.mjs` also runs, without rendering, field data or scoring.
const AUDIT_STAGES = ['collect', 'derive'];

/** Persist collector bytes and offline module output in the same run evidence directory. */
export async function runAudit({ context, modules, outputDir, transport, resolve }) {
  validateEntity('RunContext', context);
  if (!Array.isArray(modules) || modules.some(x => !supported.has(x)) || !outputDir) throw new Error('unsupported modules or output directory');
  const parts = stages().filter(stage => AUDIT_STAGES.includes(stage.name));
  const { state } = await runStages(parts, { context, modules, out: outputDir, route: { transport, resolve } }, {});
  const { audit } = state;
  return { context_ref: context.evidence_ref, artifacts: audit.artifacts, observations: state.observations, module_outputs: audit.module_outputs,
    evidence_ref: state.store.indexRef, discovered_count: audit.discovered_count, evaluated_count: audit.evaluated_count,
    request_count: audit.request_count, skipped: audit.skipped, limit_reached: audit.limit_reached };
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

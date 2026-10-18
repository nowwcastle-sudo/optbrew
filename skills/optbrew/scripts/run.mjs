#!/usr/bin/env node
import { lookup } from 'node:dns/promises';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './core/chrome.mjs';
import { validateEntity } from './core/contracts.mjs';
import { renderChrome } from './core/render.mjs';
import { readJudgments } from './core/judgment-files.mjs';
import { QUEUE_PAGES_DIR, prepareOutput, restoreState, runStages, stages } from './core/stages.mjs';
import { selectTransport } from './core/transport.mjs';

const USAGE = 'usage: node skills/optbrew/scripts/run.mjs --answers <intake-answers.json> --out <dir> [--judgments <judgments folder or file>]';
const RESUME_FROM = 'judge';
const STATUS_DONE = 'done';

/** One render chrome per run, made when the render stage asks for it. Its owner calls `close()` in a `finally`. */
function chromeHolder(env) {
  let handle = null;
  return {
    open: ({ context, route }) => (handle ??= renderChrome({ context, transport: route, find: () => findChrome({ env }) })),
    close: () => handle?.close(),
  };
}

/** A JSON file as a value; a file that is missing or not JSON is a plain sentence, not a stack trace. */
async function readJson(file, what) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error(`The ${what} file cannot be read as JSON: ${file}`); }
}

/**
 * One audit: the first call runs context, collect, render, cwv, derive and judge, and stops at the judge queue; the second call
 * (same `out`, now with `judgmentsPath`) rebuilds its state from the evidence in `out` and runs judge, score and report.
 * `overrides` is for tests: `env`, `home`, `chrome` (holder), `fetchFn`, `selectTransport`, `stages` (the stage list), `localTargets`
 * (loopback `{ host, port }` pairs a test may audit; the shipped command refuses a local address, as preflight does).
 * Everything is written under `out`, and the render chrome is closed whatever happens.
 */
export async function run({ answersPath, out, judgmentsPath = null }, overrides = {}) {
  const outDir = path.resolve(out);
  const env = overrides.env ?? process.env;
  const chrome = overrides.chrome ?? chromeHolder(env);
  try {
    const answers = await readJson(answersPath, 'answers');
    try { validateEntity('IntakeAnswers', answers); }
    catch (error) { throw new Error(`The start answers are not valid (${error.message}).`); }
    const judgments = judgmentsPath ? await readJudgments(path.resolve(judgmentsPath), { queueDir: path.join(outDir, QUEUE_PAGES_DIR) }) : null;
    const deps = { env, home: overrides.home, chrome, fetchFn: overrides.fetchFn, localTargets: overrides.localTargets,
      selectTransport: overrides.selectTransport ?? (input => selectTransport({ ...input, resolve: host => lookup(host, { all: true, verbatim: true }) })) };
    const resuming = await prepareOutput(outDir) === 'resume';
    const state = resuming ? await restoreState({ out: outDir, answers }) : { answers, out: outDir, answersDir: path.dirname(path.resolve(answersPath)) };
    const { state: end, halt } = await runStages(overrides.stages ?? stages(), { ...state, judgments }, deps, { from: resuming ? RESUME_FROM : null });
    return halt ? { status: halt, judge_queue: path.join(outDir, 'judge-queue.json'), judge_pages: path.join(outDir, QUEUE_PAGES_DIR),
      pages: new Set(end.queue.items.map(item => item.url)).size, queue_items: end.queue.items.length } :
      { status: STATUS_DONE, reports: end.reports, score_input: path.join(outDir, 'score-input.json'), ...(end.lab_cwv ? { lab_cwv: end.lab_cwv } : {}) };
  } finally { await chrome.close(); }
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const chrome = chromeHolder(process.env);
  // Ctrl-C or a terminate signal still closes the render chrome (and its profile folder) before the process leaves.
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { chrome.close().finally(() => process.exit(1)); });
  try {
    const args = process.argv.slice(2);
    const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
    const answersPath = option('--answers');
    const out = option('--out');
    if (!answersPath || !out || args.length % 2 || args.some((arg, i) => i % 2 === 0 && !['--answers', '--out', '--judgments'].includes(arg))) throw new Error(USAGE);
    const result = await run({ answersPath, out, judgmentsPath: option('--judgments') }, { chrome });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // The last line of stderr is one plain sentence saying why the run stopped.
    process.stderr.write(`${String(error.message).replace(/\s*\n\s*/g, ' ')}\n`);
    process.exitCode = 2;
  }
}

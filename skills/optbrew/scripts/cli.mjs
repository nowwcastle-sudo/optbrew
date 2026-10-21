import { readFile, realpath, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { score } from './core/score.mjs';
import { compare } from './core/compare.mjs';
import { writeReport } from './core/report.mjs';
import { htmlReportWriter } from './core/report-page.mjs';
import { MigrationRequired } from './core/migration.mjs';
import { runbookText } from './core/runbooks.mjs';
import { finishChange, startChange } from './core/changes.mjs';

const SKILL_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const USAGE = 'usage: cli.mjs score --input <file> --output <file> | compare --before <file> --after <file> --output <file> | report --input <packet.json> --output-dir <directory> | runbook --ids <id,id> --level beginner|brief | change start --out <directory> --root <source directory> --path <file> --finding <id> [--finding <id> ...] | change finish --out <directory> --path <file> [--tool <name> ...] [--query <text> ...] [--self-analysis]';

const text = { type: 'string' };
const texts = { type: 'string', multiple: true };

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

async function writeJson(file, result) {
  const destination = path.resolve(file);
  await mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, destination);
  } finally { await rm(temp, { force: true }); }
  return result;
}

async function replayReport({ input: file, 'output-dir': outputDir }) {
  const input = path.resolve(file);
  const packet = JSON.parse(await readFile(input, 'utf8'));
  packet.evidence_root = path.resolve(path.dirname(input), packet.evidence_root ?? '.');
  const relative = path.relative(await realpath(path.dirname(input)), await realpath(packet.evidence_root));
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('evidence root must stay under packet run directory');
  // The page is written beside the other two, as a run writes it. A packet does not record the guidance level, so the full steps are used.
  return writeReport(packet, path.resolve(outputDir), { renderHtml: htmlReportWriter({ level: 'beginner', target: packet.run_context?.target, synthetic: packet.data_class === 'synthetic' }) });
}

/** The runbook text goes to stdout for the agent to paste into its reply as it is: the user does not see a file the agent only read. */
function printRunbook({ ids, level }) {
  const runbooks = runbookText(ids.split(',').filter(Boolean), level, { skillRoot: SKILL_ROOT });
  process.stdout.write(`${runbooks}\n`);
  return runbooks;
}

/** A change command prints what it did as one JSON line: the agent reads the change id and the paths from it. */
const printed = async work => {
  const result = await work;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
};

/**
 * Every subcommand: the options it takes (each must be given, once unless it repeats) and what it runs. A command is the first word
 * of the arguments, or the first two for `change`.
 */
const COMMANDS = {
  score: { options: { input: text, output: text }, required: ['input', 'output'],
    run: async v => writeJson(v.output, score(await readJson(v.input))) },
  compare: { options: { before: text, after: text, output: text }, required: ['before', 'after', 'output'],
    run: async v => writeJson(v.output, compare(await readJson(v.before), await readJson(v.after))) },
  report: { options: { input: text, 'output-dir': text }, required: ['input', 'output-dir'], run: replayReport },
  runbook: { options: { ids: text, level: text }, required: ['ids', 'level'], run: printRunbook },
  'change start': { options: { out: text, root: text, path: text, finding: texts }, required: ['out', 'root', 'path', 'finding'],
    run: v => printed(startChange({ out: v.out, root: v.root, file: v.path, findings: v.finding })) },
  'change finish': { options: { out: text, path: text, tool: texts, query: texts, 'self-analysis': { type: 'boolean' } }, required: ['out', 'path'],
    run: v => printed(finishChange({ out: v.out, file: v.path, tools: v.tool, queries: v.query, selfAnalysis: v['self-analysis'] })) },
};

/** The option values of a command, or the usage line: an unknown option, a stray word, a missing or empty value and a repeated single option are all refused. */
function parseOptions(args, { options, required }) {
  let parsed;
  try { parsed = parseArgs({ args, options, allowPositionals: false, strict: true, tokens: true }); }
  catch { throw new Error(USAGE); }
  const given = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (!options[token.name].multiple && given.has(token.name)) throw new Error(USAGE);
    if (options[token.name].type === 'string' && !token.value) throw new Error(USAGE);
    given.add(token.name);
  }
  if (required.some(name => !given.has(name))) throw new Error(USAGE);
  return parsed.values;
}

/** Local calculation CLI. */
export async function runCli(argv = process.argv.slice(2)) {
  const name = argv[0] === 'change' ? `change ${argv[1]}` : argv[0];
  if (!Object.hasOwn(COMMANDS, name)) throw new Error(USAGE);
  return COMMANDS[name].run(parseOptions(argv.slice(name.split(' ').length), COMMANDS[name]));
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  runCli().catch(error => { process.stderr.write(`${error instanceof MigrationRequired ? '' : `${error.name}: `}${error.message}\n`); process.exitCode = 1; });
}

import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { score } from './core/score.mjs';
import { compare } from './core/compare.mjs';

/** Local calculation CLI. */
export async function runCli(argv = process.argv.slice(2)) {
  const usage = 'usage: cli.mjs score --input <file> --output <file> | compare --before <file> --after <file> --output <file>';
  let result, destination;
  if (argv.length === 5 && argv[0] === 'score' && argv[1] === '--input' && argv[3] === '--output' && argv[2] && argv[4]) {
    result = score(JSON.parse(await readFile(argv[2], 'utf8')));
    destination = path.resolve(argv[4]);
  } else if (argv.length === 7 && argv[0] === 'compare' && argv[1] === '--before' && argv[3] === '--after' &&
      argv[5] === '--output' && argv[2] && argv[4] && argv[6]) {
    const before = JSON.parse(await readFile(argv[2], 'utf8'));
    const after = JSON.parse(await readFile(argv[4], 'utf8'));
    result = compare(before, after);
    destination = path.resolve(argv[6]);
  } else throw new Error(usage);
  await mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, destination);
  } finally { await rm(temp, { force: true }); }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(error => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; });
}

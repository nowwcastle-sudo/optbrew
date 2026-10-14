import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { score } from './core/score.mjs';

/** Local calculation CLI. Future subcommands dispatch from this entry point. */
export async function runCli(argv = process.argv.slice(2)) {
  if (argv.length !== 5 || argv[0] !== 'score' || argv[1] !== '--input' || argv[3] !== '--output' || !argv[2] || !argv[4])
    throw new Error('usage: node skills/optbrew/scripts/cli.mjs score --input <file> --output <file>');
  const input = JSON.parse(await readFile(argv[2], 'utf8'));
  const result = score(input);
  const destination = path.resolve(argv[4]);
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

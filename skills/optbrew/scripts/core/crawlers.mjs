import { readFileSync } from 'node:fs';

const table = JSON.parse(readFileSync(new URL('../../references/ai-crawlers.json', import.meta.url), 'utf8'));
const byEngine = new Map();
for (const [engine, row] of Object.entries(table.engines)) {
  byEngine.set(engine, row.agent);
  for (const alias of row.aliases ?? []) byEngine.set(alias, row.agent);
}

/** robots.txt token that governs a protocol engine, or null when the engine has no known search token. */
export const agentFor = engine => byEngine.get(String(engine).toLowerCase()) ?? null;

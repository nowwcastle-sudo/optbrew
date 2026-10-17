import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { CODE_FAMILIES, goldenObservations, withoutVersions } from './support/golden.mjs';

const golden = new URL('./fixtures/golden/observations-0.1.4.json', import.meta.url);
const sortById = list => [...list].sort((a, b) =>
  `${a.site}|${a.check_id}|${a.unit_key}`.localeCompare(`${b.site}|${b.check_id}|${b.unit_key}`));

test('derive output matches the golden file', async () => {
  const actual = sortById(withoutVersions(await goldenObservations()));
  if (process.env.UPDATE_GOLDEN === '1') await writeFile(golden, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(await readFile(golden, 'utf8')));
});

test('golden covers every code-judged family', async () => {
  const frozen = JSON.parse(await readFile(golden, 'utf8'));
  assert.deepEqual([...new Set(frozen.map(o => o.family_id))].sort(), [...CODE_FAMILIES].sort());
});

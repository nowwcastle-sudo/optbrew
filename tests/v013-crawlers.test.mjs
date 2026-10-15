import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL(`../skills/optbrew/references/${name}`, import.meta.url), 'utf8');

test('L7: the Naver crawler token Yeti carries its official source, the check date and the hash of the page it was read from', async () => {
  const table = JSON.parse(await read('ai-crawlers.json'));
  const naver = table.engines.naver;
  assert.equal(naver.agent, 'Yeti');
  assert.equal(naver.source, 'https://searchadvisor.naver.com/guide/seo-basic-robots');
  assert.equal(naver.verified, '2026-10-15');
  assert.match(naver.evidence, /User-agent: Yeti/);
  assert.match(naver.evidence, /sha256 ff8ddc85c5dd42e0d1133abae6928fb9b42f67f35d1b2c89b40378009571ed49/);
  const guide = await read('ai-crawlers.md');
  const row = guide.split('\n').find(line => line.startsWith('| `naver`'));
  assert.match(row, /User-agent: Yeti/);
  assert.match(row, /2026-10-15/);
  assert.match(row, /ff8ddc85c5dd42e0d1133abae6928fb9b42f67f35d1b2c89b40378009571ed49/);
  assert.doesNotMatch(guide, /not (?:re-?read|confirmed|verified)|unconfirmed|미확인/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runbookText } from '../skills/optbrew/scripts/core/runbooks.mjs';
import { tempDir } from './support/temp-dir.mjs';

const judgeNext = out => spawnSync(process.execPath, ['skills/optbrew/scripts/cli.mjs', 'judge', 'next', '--out', out], { encoding: 'utf8' });

test('judge next hands over one page at a time and only after the page before it is written (re-audit 2026-10-25)', async () => {
  const out = await tempDir('optbrew-v034-');
  const queue = path.join(out, 'judge-queue'), judged = path.join(out, 'judgments');
  await mkdir(queue);
  await writeFile(path.join(queue, 'site.json'), '{}');
  for (const n of [1, 2]) await writeFile(path.join(queue, `p00${n}.json`), JSON.stringify({ url: `https://x.test/${n}` }));
  const first = JSON.parse(judgeNext(out).stdout);
  assert.deepEqual([first.status, first.file, first.position, first.total, first.page.url, first.write_to], ['next', 'p001.json', 1, 2, 'https://x.test/1', path.join(judged, 'p001.json')]);
  assert.equal(JSON.parse(judgeNext(out).stdout).file, 'p001.json', 'the next page waits until this one is written');
  await mkdir(judged);
  await writeFile(path.join(judged, 'p001.json'), JSON.stringify([{ family_id: 'original-value', unit_key: 'original-value|https://x.test/1', state: 'unknown', reason: '나머지 동일' }]));
  const refused = judgeNext(out);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Judgment 1 in p001\.json looks like a placeholder/, 'a stand-in stops the hand-over at once, not at the end');
  await writeFile(path.join(judged, 'p001.json'), '[]');
  assert.equal(JSON.parse(judgeNext(out).stdout).file, 'p002.json');
  await writeFile(path.join(judged, 'p002.json'), '[]');
  assert.deepEqual(JSON.parse(judgeNext(out).stdout), { status: 'all_judged', total: 2 });
  assert.match(judgeNext(path.join(out, 'none')).stderr, /no judge queue/);
});

test('the procedure says what the re-audit found missing: cloud keys in a new session, a same-named skill, judge next', async () => {
  const cloud = runbookText(['key-set-claude-cloud'], 'beginner', { skillRoot: '/skill' }) + runbookText(['key-set-claude-cloud'], 'brief', { skillRoot: '/skill' });
  assert.ok(cloud.includes('지금 이 세션에는 적용되지 않습니다'), 'the cloud runbook says the running session does not see the key');
  const [skill, judging, sources, prepare] = await Promise.all(['SKILL.md', 'references/judging.md', 'references/source-analysis.md', 'references/prepare.md']
    .map(name => readFile(path.join('skills/optbrew', name), 'utf8')));
  assert.ok(prepare.includes('claude-code-cloud') && prepare.includes('키 없이 계속합니다'), 'prepare.md says how the audit goes on without the key in a cloud session');
  assert.ok(sources.includes('형태는 조건이 아니다'), 'a same-named skill counts as the tool');
  for (const text of [skill, judging]) assert.ok(text.includes('cli.mjs" judge next --out "<OUT>"'), 'judging goes through judge next');
});

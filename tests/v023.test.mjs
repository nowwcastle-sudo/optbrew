import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readJudgments } from '../skills/optbrew/scripts/core/judgment-files.mjs';
import { runbookText } from '../skills/optbrew/scripts/core/runbooks.mjs';
import { renderHtmlReport } from '../skills/optbrew/scripts/core/report-html.mjs';
import { composeReport } from '../skills/optbrew/scripts/core/report-compose.mjs';
import { verifiedOf } from './support/compose.mjs';
import { tempDir } from './support/temp-dir.mjs';

test('the export answer prints both services in full, ready to paste, with no screen tags', () => {
  const text = runbookText(['gsc-export'], 'beginner', { skillRoot: '/skill' });
  assert.deepEqual(text.match(/^### .+$/gm), ['### Search Console 실적 데이터 내보내기', '### 네이버 서치어드바이저 리포트 내려받기']);
  assert.ok(!/\{화면:/.test(text) && !text.includes('{{skill_root}}'));
  assert.ok(text.includes('1. 브라우저에서 search.google.com/search-console을 엽니다.'), 'the steps themselves, not a summary');
  assert.equal(runbookText(['gsc-export', 'naver-searchadvisor-export'], 'brief').match(/^### /gm).length, 2, 'each runbook once');
  assert.throws(() => runbookText(['nope'], 'brief'), /unknown runbook: nope/);
});

test('the runbook command writes the text to stdout', () => {
  const ran = spawnSync(process.execPath, ['skills/optbrew/scripts/cli.mjs', 'runbook', '--ids', 'chrome-install', '--level', 'brief'], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^### /);
});

test('page judgment files: read in name order, a stand-in entry or a missing page is refused by name', async () => {
  const dir = await tempDir('optbrew-v023-');
  const queueDir = path.join(dir, 'queue'), judged = path.join(dir, 'judgments');
  await mkdir(queueDir); await mkdir(judged);
  for (const name of ['site.json', 'p001.json', 'p002.json']) await writeFile(path.join(queueDir, name), '{}');
  const real = n => ({ family_id: 'original-value', unit_key: `original-value|https://x.test/${n}`, state: 'unknown', reason: '조각에 판단할 글이 없다.' });
  await writeFile(path.join(judged, 'p002.json'), JSON.stringify([real(2)]));
  await assert.rejects(readJudgments(judged, { queueDir }), /missing for page p001\.json/);
  await writeFile(path.join(judged, 'p001.json'), JSON.stringify([real(1)]));
  assert.deepEqual(await readJudgments(judged, { queueDir }), [real(1), real(2)]);
  for (const [entry, why] of [['…', /not a judgment object/], [{ ...real(1), reason: '나머지 동일' }, /reason is "나머지 동일"/],
    [{ ...real(1), state: '...' }, /state is "..."/], [{ ...real(1), reason: '' }, /reason is missing or empty/]]) {
    await writeFile(path.join(judged, 'p002.json'), JSON.stringify([real(2), entry]));
    await assert.rejects(readJudgments(judged, { queueDir }), new RegExp(`Judgment 2 in p002\\.json looks like a placeholder \\(.*${why.source}`));
  }
  await writeFile(path.join(judged, 'p002.json'), JSON.stringify([{ ...real(2), reason: '「가든파티 …」 날짜가 지났다.' }]));
  assert.equal((await readJudgments(judged, { queueDir })).length, 2, 'an ellipsis inside a real reason is fine');
  const single = path.join(dir, 'one.json');
  await writeFile(single, JSON.stringify([real(1)]));
  assert.deepEqual(await readJudgments(single, { queueDir }), [real(1)], 'a single file still works');
});

test('the same problem on several pages is one card, with each page under it; the first three are featured', () => {
  const composed = composeReport(verifiedOf());
  const [fix] = composed.fixes;
  assert.ok(fix, 'the fixture has a fix');
  const pages = ['a', 'b', 'c'].map(name => ({ ...fix, where: `https://example.com/${name}` }));
  const others = [1, 2, 3].map(n => ({ ...fix, text_ko: { ...fix.text_ko, message: `다른 문제 ${n}` } }));
  const page = renderHtmlReport({ ...composed, fixes: [...pages, ...others], remaining: [] }, { runbooks: [], level: 'beginner', target: 'https://example.com/' });
  assert.equal(page.split('<li class="fix ').length - 1, 4, 'one card for the shared sentence, one for each other');
  assert.ok(page.includes('3개 페이지') && page.includes('고칠 것 6건을 같은 문제끼리 묶어 4가지로 보여 줍니다.'));
  for (const name of ['a', 'b', 'c']) assert.ok(page.includes(`https://example.com/${name}`));
  assert.equal(page.split('class="fix top').length - 1, 3);
  assert.equal(page.split('class="fix row').length - 1, 1);
  assert.ok(page.includes('<strong>이렇게 고치세요</strong>'));
});

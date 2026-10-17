import test from 'node:test';
import assert from 'node:assert/strict';
import { readOwnerExport } from '../skills/optbrew/scripts/adapters/imports.mjs';
import { limits } from '../skills/optbrew/scripts/core/config.mjs';
import { zipOf } from './support/run-scenario.mjs';

const reason = job => { try { job(); } catch (error) { return error.reason; } return null; };
const total = (read, id) => read.rows.find(row => row.metric_id === id);

test('a Search Console zip is read from its daily table, in English or Korean column names', () => {
  const english = readOwnerExport('gsc', zipOf({ 'Pages.csv': 'Top pages,Clicks\n/,5\n', 'Dates.csv': 'Date,Clicks,Impressions,CTR,Position\n2026-09-02,20,300,6%,3\n2026-09-01,10,200,5%,3\n' }));
  assert.deepEqual(english.window, { start: '2026-09-01', end: '2026-09-02', timezone: 'America/Los_Angeles' });
  assert.deepEqual([total(english, 'clicks').value, total(english, 'impressions').value, total(english, 'ctr').denominator], [30, 500, 500]);
  const korean = readOwnerExport('gsc', zipOf({ '날짜.csv': '﻿날짜,클릭수,노출수,CTR,게재순위\n2026-09-01,"1,200",9000,13%,2\n' }));
  assert.equal(total(korean, 'clicks').value, 1200);
  assert.equal(korean.sample_selection.kind, 'all');
});

test('a Naver table needs its period and its click and impression columns', () => {
  const read = readOwnerExport('naver', Buffer.from('기간: 2026-09-01 ~ 2026-09-28\n키워드  클릭수  노출수\n브루  30  400\n'));
  assert.deepEqual(read.window, { start: '2026-09-01', end: '2026-09-28', timezone: 'Asia/Seoul' });
  assert.equal(total(read, 'impressions').value, 400);
  assert.equal(reason(() => readOwnerExport('naver', Buffer.from('키워드  클릭수  노출수\n브루  30  400\n'))), 'export_period_missing');
  assert.equal(reason(() => readOwnerExport('naver', Buffer.from('2026.09.01 ~ 2026.09.28\n그냥 글'))), 'export_table_not_found');
});

test('files that cannot be read say why and never expand without a limit', () => {
  assert.equal(reason(() => readOwnerExport('gsc', Buffer.from('plain text'))), 'export_not_a_zip');
  assert.equal(reason(() => readOwnerExport('gsc', zipOf({ 'Queries.csv': 'Query,Clicks\nbrew,1\n' }))), 'export_table_not_found');
  assert.equal(reason(() => readOwnerExport('gsc', zipOf({ 'Dates.csv': 'Date,Clicks,Impressions\n2026-09-01,x,y\n' }))), 'export_numbers_unreadable');
  assert.equal(reason(() => readOwnerExport('gsc', zipOf({ 'Dates.csv': `Date,Clicks,Impressions\n${'2026-09-01,1,1\n'.repeat(Math.ceil(limits().max_bytes / 14) + 1)}` }))), 'export_file_too_large');
  assert.equal(reason(() => readOwnerExport('bing', Buffer.alloc(0))), 'export_kind_unknown');
  assert.equal(reason(() => readOwnerExport('gsc', zipOf({ 'Dates.csv': 'x' }).subarray(0, 40))), 'export_not_a_zip');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeReport } from '../skills/optbrew/scripts/core/report.mjs';
import { SECTION_TITLES, composeReport, fixMethod, markdownText, pageAddresses } from '../skills/optbrew/scripts/core/report-compose.mjs';
import { FIXES_FILE, fixesMarkdown } from '../skills/optbrew/scripts/core/report-fixes.mjs';
import { fixturePacket, verifiedOf } from './support/compose.mjs';
import { tempDir } from './support/temp-dir.mjs';

const remediations = JSON.parse(readFileSync(new URL('../skills/optbrew/references/remediations.json', import.meta.url), 'utf8')).items;
const SITE = 'https://example.com';
const finding = (id, over = {}) => ({ schema_version: '2.0.0', finding_id: id, check_id: 'document-title', unit_key: `document-title|${SITE}/${id}`, priority: 'P1', blocker: false,
  message: `problem ${id}`, message_key: 'document-title.missing', message_values: {}, source_ref: 'optbrew:collector', evidence_ref: 'e', remediation_ids: [],
  status: 'confirmed', finding_ids: [id], sources: [], remediation: null, resolution: null, ...over });
const composedOf = findings => composeReport(verifiedOf({ findings }));
const sections = markdown => markdown.split(/^## /m).slice(1);

test('fixes.md lists the open fixes in the order of the report, each with its finding, pages, problem, method, check and place', () => {
  const composed = composedOf([finding('a', { priority: 'P2' }), finding('b', { priority: 'P0' })]);
  const markdown = fixesMarkdown(composed);
  assert.match(markdown, /^# 고칠 것 목록\n\n열려 있는 고칠 것은 2건입니다\. 점수와 확인 범위는 report\.md에서 봅니다\.\n/);
  const parts = sections(markdown);
  assert.deepEqual(parts.map(part => part.split('\n')[0]), composed.fixes.map(fix => fix.finding_id), 'the order is the order of the report');
  assert.deepEqual(parts.map(part => part.split('\n')[0]), ['b', 'a']);
  const [fix] = composed.fixes;
  // The words go through the escape report.md uses, so a tag the text names (the `<title>` to add) reads the same in both files.
  assert.equal(parts[0].trimEnd(), ['b', '',
    `- 문제: ${markdownText(fix.text_ko.message)}`,
    `- 페이지: ${SITE}/b`,
    `- 고치는 방법: ${markdownText(fix.text_ko.remediation.mechanism)}`,
    `- 확인하는 방법: ${markdownText(fix.text_ko.remediation.validation)}`,
    `- 고칠 위치: ${markdownText(fix.text_ko.remediation.location_hint)}`].join('\n'));
  assert.ok(fix.text_ko.remediation.mechanism.includes('<title>') && parts[0].includes('&lt;title&gt;'));
});

test('every word comes from the composed report, with no fresh catalog lookup', () => {
  const title = remediations.find(item => item.remediation_id === 'repair-document-title');
  const composed = composedOf([finding('a', { remediation: title })]);
  const [fix] = composed.fixes;
  // The method keeps the official source the report table shows beside it.
  assert.ok(fixMethod(fix).includes(title.source_url));
  assert.ok(fixesMarkdown(composed).includes(`- 고치는 방법: ${markdownText(fixMethod(fix))}`));
  // A composed report whose words differ from the catalog's is written as it stands.
  const edited = { ...composed, fixes: [{ ...fix, text_ko: { ...fix.text_ko, message: '다른 문제', remediation: { ...fix.text_ko.remediation, mechanism: '다른 방법', validation: '다른 확인' } }, where: '다른 위치' }] };
  const markdown = fixesMarkdown(edited);
  for (const line of ['- 문제: 다른 문제', '- 확인하는 방법: 다른 확인', '- 고칠 위치: 다른 위치']) assert.ok(markdown.includes(line), line);
  assert.ok(markdown.includes('- 고치는 방법: 다른 방법 ('), 'the changed method is followed by the source it already carried');
});

test('a fix on several pages lists every page, not only the first few the report names', () => {
  const units = Array.from({ length: 7 }, (_, index) => `document-title|${SITE}/p${index}`);
  const composed = composedOf([finding('many', { unit_key: units[0], unit_keys: units })]);
  const part = sections(fixesMarkdown(composed))[0];
  assert.match(part, /- 페이지:\n(  - https:\/\/example\.com\/p\d\n){6}  - https:\/\/example\.com\/p6\n/);
  assert.equal(pageAddresses(composed.fixes[0]).length, 7);
});

test('text from the site is escaped and kept on one line', () => {
  const bad = `${SITE}/<script>x</script>|a`;
  const composed = composedOf([finding('x', { unit_key: `document-title|${bad}`, message_key: undefined, message: 'first line\nsecond <b>line</b> | pipe' })]);
  const markdown = fixesMarkdown(composed);
  assert.doesNotMatch(markdown, /<script|<b>/);
  assert.ok(markdown.includes('- 문제: first line<br>second &lt;b&gt;line&lt;/b&gt; \\| pipe'));
  assert.ok(markdown.includes('&lt;script&gt;'));
});

test('a fix confirmed in production is counted and left out, and a list with none open says where unchecked parts show', () => {
  const resolved = finding('r', { status: 'verified_production', resolution: { source_ref: 'optbrew:collector', evaluator_type: 'code', evidence_ref: 'e' } });
  const mixed = fixesMarkdown(composedOf([finding('o'), resolved]));
  assert.deepEqual(sections(mixed).map(part => part.split('\n')[0]), ['o']);
  assert.ok(mixed.includes('해결이 확인된 1건은 이 목록에 넣지 않았습니다.'));
  const none = fixesMarkdown(composedOf([resolved]));
  assert.equal(sections(none).length, 0);
  assert.ok(none.includes(`지금 열려 있는 고칠 것이 없습니다. 확인하지 못한 곳이 남았는지는 report.md의 「${SECTION_TITLES.completeness}」와 「${SECTION_TITLES.blank}」에서 봅니다.`));
  assert.ok(fixesMarkdown(composedOf([])).includes('지금 열려 있는 고칠 것이 없습니다.'));
});

test('an example report says so, and a real one has no long dash in the text the list adds', () => {
  const composed = composedOf([finding('a')]);
  const example = fixesMarkdown(composed, { synthetic: true });
  assert.match(example, /^# 고칠 것 목록\n\n\*\*예시 보고서/);
  const real = fixesMarkdown(composed);
  assert.doesNotMatch(real, /예시 보고서/);
  assert.doesNotMatch(real, /[—–]/);
});

test('writeReport writes fixes.md beside report.md from the composed report, and a replay writes the same list', async () => {
  const dir = await tempDir('optbrew report fixes ');
  const written = await writeReport(fixturePacket(), path.join(dir, 'run'));
  assert.deepEqual(Object.keys(written), ['jsonPath', 'markdownPath', 'fixesPath']);
  assert.equal(written.fixesPath, path.join(dir, 'run', FIXES_FILE));
  assert.equal(FIXES_FILE, 'fixes.md');
  const report = JSON.parse(readFileSync(written.jsonPath, 'utf8'));
  const markdown = readFileSync(written.fixesPath, 'utf8');
  assert.equal(markdown, fixesMarkdown(report.composed, { synthetic: report.data_class === 'synthetic' }), 'built from composed.fixes of report.json');
  assert.match(markdown, /예시 보고서/, 'the fixture is an example and its list says so');
  assert.ok(sections(markdown).length > 0, 'the fixture has open fixes');
  // Opening the report anew from the same packet gives the same list.
  const again = await writeReport(fixturePacket(), path.join(dir, 'again'));
  assert.equal(readFileSync(again.fixesPath, 'utf8'), markdown);
});

test('fixes.md is part of the all-or-none write: a file already there stops the report and leaves nothing new behind', async () => {
  const dir = await tempDir('optbrew report fixes exists ');
  const out = path.join(dir, 'run');
  mkdirSync(out);
  writeFileSync(path.join(out, FIXES_FILE), 'old\n');
  await assert.rejects(writeReport(fixturePacket(), out), /report output already exists/);
  assert.deepEqual(readdirSync(out), [FIXES_FILE]);
  assert.equal(readFileSync(path.join(out, FIXES_FILE), 'utf8'), 'old\n');
});

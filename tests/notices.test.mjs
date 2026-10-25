import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A core.autocrlf checkout reads CRLF; the committed bytes are LF.
const read = async name => (await readFile(path.join(root, name), 'utf8')).replaceAll('\r\n', '\n');
const NOTICE_FILES = ['THIRD_PARTY_NOTICES.md', 'skills/optbrew/THIRD_PARTY_NOTICES.md'];

test('both notice files carry the caveman NOTICE and the eli5 MIT notice', async () => {
  const borrowed = (await read('scripts/borrowed-notices.md')).trimEnd();
  for (const name of NOTICE_FILES) {
    const notice = await read(name);
    assert.ok(notice.includes(borrowed), `${name} lacks scripts/borrowed-notices.md`);
    assert.match(notice, /Caveman\nCopyright 2026 Julius Brussee\n/, name);
    assert.match(notice, /Apache License, Version 2\.0/, name);
    assert.match(notice, /MIT License\n\nCopyright \(c\) Thariq Shihipar\n\nPermission is hereby granted, free of charge/, name);
  }
});

test('the root notice mirrors the bundled notice with only the license links rewritten', async () => {
  const bundled = (await read('skills/optbrew/THIRD_PARTY_NOTICES.md')).replace(/\]\(licenses\//g, '](skills/optbrew/licenses/');
  assert.equal(await read('THIRD_PARTY_NOTICES.md'), bundled);
});

test('the vendor script generates the committed notice, borrowed notices included', async () => {
  const { thirdPartyNotice } = await import('../scripts/vendor.mjs');
  const lock = JSON.parse(await read('skills/optbrew/source-lock.json'));
  assert.equal(thirdPartyNotice(lock.modules, await read('scripts/borrowed-notices.md')), await read('skills/optbrew/THIRD_PARTY_NOTICES.md'));
});

test('the caveman paragraph sits in one SKILL.md section, under its source, license and change line', async () => {
  const skill = await read('skills/optbrew/SKILL.md');
  const sections = skill.split(/^## /m).slice(1);
  const borrowing = sections.filter(section => /caveman/i.test(section));
  assert.equal(borrowing.length, 1);
  // The borrowed rules themselves, not only the word "caveman", appear once and inside that section.
  const rule = '결과를 먼저 말한다.';
  assert.equal(skill.split(rule).length - 1, 1);
  assert.ok(borrowing[0].includes(rule));
  const [title, lead] = borrowing[0].split('\n\n');
  assert.equal(title, '진행 보고');
  for (const part of ['Julius Brussee', 'Apache-2.0', '변경함']) assert.ok(lead.includes(part), `${part} is missing above the borrowed paragraph`);
});

test('the agent-read docs keep every line under 2,000 characters, except the evaluation sources', async () => {
  const { evaluationSourcePaths } = await import('../skills/optbrew/scripts/core/bundle.mjs');
  const { readdir } = await import('node:fs/promises');
  const names = ['SKILL.md', ...(await readdir(path.join(root, 'skills/optbrew/references'))).filter(name => name.endsWith('.md')).map(name => `references/${name}`)];
  for (const name of names.filter(name => !evaluationSourcePaths.includes(name))) {
    const long = (await read(`skills/optbrew/${name}`)).split('\n').findIndex(line => line.length > 2000);
    assert.equal(long, -1, `${name}:${long + 1} is longer than 2,000 characters; some read tools cut it there`);
  }
});

test('SKILL.md states the progress-language rule once, under 진행 보고, and names no release number', async () => {
  const skill = await read('skills/optbrew/SKILL.md');
  const rule = '영어 문장을 쓰지 않는다';
  assert.equal(skill.split(rule).length - 1, 1, 'the language rule stands in one place');
  assert.ok(skill.split(/^## /m).find(section => section.startsWith('진행 보고')).includes(rule));
  // A release number in the steps goes stale on the next release (0.3.1 still said 0.2.0).
  assert.doesNotMatch(skill, /\b\d+\.\d+\.\d+\b/);
});

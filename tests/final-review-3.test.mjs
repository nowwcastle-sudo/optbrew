import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBundleManifest, evaluationSourcePaths, protocolSourcePaths, verifyBundle } from '../skills/optbrew/scripts/core/bundle.mjs';
import { chromeEnv, sweepStaleProfiles } from '../skills/optbrew/scripts/core/chrome-temp.mjs';
import { limits } from '../skills/optbrew/scripts/core/config.mjs';
import { homeOf } from '../skills/optbrew/scripts/core/judgments.mjs';
import { composeReport, renderReport } from '../skills/optbrew/scripts/core/report-compose.mjs';
import { renderHtmlReport } from '../skills/optbrew/scripts/core/report-html.mjs';
import { tempDir } from './support/temp-dir.mjs';
import { verifiedOf } from './support/compose.mjs';

// Task 22 final-review fixes: the report line for pages left out of the index (I-1), the fix row and run-condition line (M-1, M-2),
// SKILL.md (M-4, M-5), Chrome's own temp folder (M-7) and the bundle identity (S1).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = path.join(root, 'skills/optbrew');
const lf = text => text.replace(/\r\n/g, '\n');

/** The fixture report with the second page of its first page type marked as deliberately not indexed. */
const withNotIndexed = (count = 1) => {
  const verified = structuredClone(verifiedOf());
  const pages = (verified.after ?? verified.baseline).input.run_context.protocol.page_types.flatMap(type => type.urls);
  for (const page of pages.slice(1, 1 + count)) Object.assign(page, { public_indexing: false,
    indexing_decision: { condition: 'not_public_index_target', reason: 'noindex and not listed in the sitemap', evidence_ref: 'e/raw' } });
  return { verified, pages: pages.slice(1, 1 + count).map(page => page.normalized) };
};
const heroOf = page => page.slice(page.indexOf('class="hero"'), page.indexOf('id="fixes"'));

test('pages left out of the index are said next to the headline in report.md and report.html, not in the folded run conditions (I-1)', () => {
  const { verified, pages } = withNotIndexed(2);
  const composed = composeReport(verified);
  const note = composed.headline.not_indexed;
  assert.deepEqual([note.count, note.pages, note.message_key, note.message_values], [2, pages, 'headline.not-indexed', { count: 2, pages: pages.join(', ') }]);
  for (const part of ['사이트맵에도 없는 페이지 2개는', ...pages, '검색에 나와야 하는 페이지가 있으면 그 페이지의 noindex를 지우세요']) assert.ok(note.text.includes(part), part);
  assert.equal(note.text.includes('쪽'), false, 'says 페이지');
  assert.equal(composed.conditions.not_indexed, undefined, 'moved out of the run conditions');
  assert.equal(composed.conditions.lines.some(line => line.label === '색인하지 않는 페이지'), false);
  const { markdown } = renderReport(composed, verified);
  const at = text => markdown.indexOf(text);
  assert.ok(at('결론: ') < at('색인 제외: ') && at('색인 제외: ') < at('## 먼저 고칠 것'), 'md: under the result line, above the fixes');
  assert.ok(markdown.includes(`색인 제외: ${note.text.replace(/\|/g, '\\|')}`));
  const html = renderHtmlReport({ ...composed, remaining: [] }, { runbooks: [], level: 'beginner', target: verified.run_context.target });
  assert.ok(heroOf(html).includes('class="skipped"') && heroOf(html).includes('noindex를 지우세요'), 'html: in the top box');
  assert.ok(html.indexOf('class="skipped"') < html.indexOf('<details><summary>실행 조건'), 'and not only in the folded section');
  assert.equal(html.split('사이트맵에도 없는 페이지').length - 1, 1, 'said once');
});

test('with no page left out of the index there is no such line in any format (I-1)', () => {
  const verified = verifiedOf();
  const composed = composeReport(verified);
  assert.equal(composed.headline.not_indexed, null);
  assert.equal(renderReport(composed, verified).markdown.includes('색인 제외'), false);
  assert.equal(renderHtmlReport({ ...composed, remaining: [] }, { runbooks: [], level: 'beginner', target: 'https://example.com/' }).includes('class="skipped"'), false);
});

test('a freshness fail told as absence counts as absence in the run conditions, and a shown one as shown (M-1)', () => {
  const row = (state, basis, sentence_basis) => ({ phase: 'baseline', family_id: 'freshness-truth', unit_key: `freshness-truth|https://example.com/${basis}${sentence_basis}`, state, evidence_ref: 'e',
    evidence_span: [{ start: 0, end: 1 }], label: 'l', basis, ...(sentence_basis ? { sentence_basis } : {}) });
  const line = rows => composeReport(verifiedOf({ model_judgments: rows })).conditions.lines.find(item => item.label === '날짜·운영 주체 판정(fail)의 근거')?.value;
  assert.equal(line([row('fail', 'shown', 'absence')]), '페이지에 없다는 근거 1건, 인용한 글에서 직접 확인 0건', 'the fix sentence is the absence one');
  assert.equal(line([row('fail', 'shown', 'shown'), row('fail', 'absence', 'absence')]), '페이지에 없다는 근거 1건, 인용한 글에서 직접 확인 1건');
  assert.equal(line([row('fail', 'shown')]), '페이지에 없다는 근거 0건, 인용한 글에서 직접 확인 1건', 'a row from an older report has no sentence_basis: its own basis counts');
});

test('the identity fix of the site names the home page address as the place to fix (M-2)', () => {
  const finding = (id, unit_key, message_key) => ({ schema_version: '2.0.0', finding_id: id, check_id: unit_key.split('|')[0], unit_key, priority: 'P2', blocker: false, message: 'English',
    message_key, message_values: {}, source_ref: 'optbrew:model-judgment', evidence_ref: 'e', remediation_ids: [], status: 'confirmed', finding_ids: [id], sources: [], remediation: null, resolution: null });
  const verified = verifiedOf({ findings: [finding('e1', 'entity-identity|site', 'model-fix.entity-identity'), finding('q1', 'question-coverage|site', 'question-coverage.none-answered')] });
  const latest = (verified.after ?? verified.baseline).input;
  const home = homeOf(latest.observations.filter(obs => obs.family_id === 'fetch-response' && obs.state === 'pass').map(obs => obs.unit_key.split('|').at(-1)));
  assert.equal(home, 'https://example.com/');
  const composed = composeReport(verified);
  const entity = composed.fixes.find(fix => fix.finding_id === 'e1'), coverage = composed.fixes.find(fix => fix.finding_id === 'q1');
  assert.equal(entity.where, `${home}의 본문`);
  const { tables } = renderReport(composed, verified);
  assert.ok(tables.remediation.some(cells => cells[1].includes(home) && !cells[1].includes('사이트 전체')), 'the problem cell names the page');
  assert.ok(entity.text_ko.remediation.mechanism.includes('홈 페이지'), 'the method says the home page, as the place does');
  assert.ok(tables.remediation.some(cells => cells[1].includes('사이트 전체')), 'another site-level fix still reads as the whole site');
  assert.equal(coverage.site_address, undefined);
  const html = renderHtmlReport({ ...composed, remaining: [] }, { runbooks: [], level: 'beginner', target: home });
  assert.ok(html.includes(`<p class="where"><strong>고칠 곳</strong> ${home}의 본문</p>`));
});

test('SKILL.md checks the key file with status only, states the 200 cap, and tells the summary to name pages left out of the index (M-4, M-5, I-1)', async () => {
  const skill = lf(await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'));
  const check = skill.slice(skill.indexOf('4. 키 파일 점검'), skill.indexOf('5. 런북을 펼친 뒤에는'));
  assert.ok(check.includes('key.mjs" status') && check.includes('google.corrupt') && check.includes('.optbrew/credentials.json'));
  assert.equal(/key\.mjs"? ?remove/.test(skill), false, 'no command that changes the key file is used as a check');
  assert.equal(/\bremove\b/.test(check), false);
  const rule = skill.slice(skill.indexOf('- `sample_mode`는'), skill.indexOf('- `owner_exports`는'));
  assert.ok(rule.includes('계산한 수가 200을 넘으면 200으로 줄인다') && rule.includes('max_urls') && rule.includes(String(limits().max_urls_cap)));
  // The formula cannot give a limit above the cap the run applies (requestLimit clamps to it).
  for (const pages of [150, 181, 190, 200, 201]) {
    const base = pages + 2 + 1, calculated = base + Math.max(2, Math.ceil(base * 0.1));
    assert.ok(Math.min(calculated, limits().max_urls_cap) <= limits().max_urls_cap, `${pages} pages`);
  }
  const summary = skill.slice(skill.indexOf('## 9단계'), skill.indexOf('## 10단계'));
  assert.ok(summary.includes('색인 제외:') && summary.includes('composed.headline.not_indexed') && summary.includes('noindex를 지우라는 말') && summary.includes('줄이 없으면 이 말을 하지 않는다'));
});

test('Chrome runs with a temp folder of its own, and a profile folder nobody uses is swept at the next start (M-7)', async () => {
  const env = chromeEnv({ Path: 'p', Temp: 'C:/Users/me/Temp', tmp: 'C:/Users/me/Tmp', TMPDIR: '/x', KEEP: '1' }, 'D:/run/tmp');
  assert.deepEqual(env, { Path: 'p', KEEP: '1', TEMP: 'D:/run/tmp', TMP: 'D:/run/tmp', TMPDIR: 'D:/run/tmp' }, 'one value each, whatever the letter case of the old ones');
  const tmpRoot = await tempDir('optbrew-sweep-');
  const make = async (name, ageMs, withTemp = true) => {
    const dir = path.join(tmpRoot, name);
    await mkdir(path.join(dir, 'tmp', 'scoped_dir1'), { recursive: withTemp });
    const when = new Date(Date.now() - ageMs);
    await utimes(dir, when, when);
    return dir;
  };
  await make('optbrew-chrome-orphan', 13 * 60 * 60_000);
  await make('optbrew-chrome-running', 13 * 60 * 60_000);
  await make('optbrew-chrome-young', 1000);
  await mkdir(path.join(tmpRoot, 'other-folder'));
  const names = () => readdir(tmpRoot).then(list => list.sort());
  // The process list could not be read: nothing is removed.
  assert.deepEqual(await sweepStaleProfiles(tmpRoot, { listLines: async () => null }), []);
  assert.equal((await names()).length, 4);
  // A process names the "running" profile, the "young" one may still be starting: only the orphan goes.
  const lines = [`chrome.exe --user-data-dir=${path.join(tmpRoot, 'optbrew-chrome-running')} --headless`];
  assert.deepEqual(await sweepStaleProfiles(tmpRoot, { listLines: async marker => { assert.equal(marker, 'optbrew-chrome-'); return lines; } }), ['optbrew-chrome-orphan']);
  assert.deepEqual(await names(), ['optbrew-chrome-running', 'optbrew-chrome-young', 'other-folder']);
  // With nothing old there is nothing to look up at all.
  assert.deepEqual(await sweepStaleProfiles(tmpRoot, { now: Date.now() - 2 * 60 * 60_000, listLines: async () => { throw new Error('must not list'); } }), []);
  assert.deepEqual(await sweepStaleProfiles(path.join(tmpRoot, 'missing')), []);
});

test('the evaluation identity covers the code that makes a verdict and the Korean catalog; an older manifest still verifies (S1)', async () => {
  const listed = new Set(evaluationSourcePaths);
  for (const name of ['scripts/core/derive.mjs', 'scripts/core/index-targets.mjs', 'scripts/core/judgments.mjs', 'scripts/core/facts.mjs', 'scripts/core/link-graph.mjs', 'scripts/core/page-select.mjs',
    'modules/naver-searchadvisor/scripts/audit.mjs', 'references/messages.ko.json']) assert.ok(listed.has(name), name);
  const checks = (await readdir(path.join(skillRoot, 'scripts/core/checks'))).filter(name => name.endsWith('.mjs'));
  assert.ok(checks.length >= 17);
  for (const name of checks) assert.ok(listed.has(`scripts/core/checks/${name}`), `checks/${name} is part of the evaluation identity`);
  assert.equal(listed.size, evaluationSourcePaths.length, 'no file twice');
  for (const name of evaluationSourcePaths) assert.ok((await stat(path.join(skillRoot, name))).isFile(), name);
  assert.equal(protocolSourcePaths.includes('references/limits.json'), true, 'limits.json is not split in this release');

  const bundle = await tempDir('optbrew-identity-');
  for (const name of new Set([...evaluationSourcePaths, ...protocolSourcePaths])) {
    await mkdir(path.dirname(path.join(bundle, name)), { recursive: true });
    await copyFile(path.join(skillRoot, name), path.join(bundle, name));
  }
  const older = ['references/check-registry.json', 'references/profiles.json', 'references/scoring.md', 'references/measurement.md', 'scripts/core/score.mjs', 'scripts/core/weights.mjs',
    'scripts/core/contracts.mjs', 'scripts/core/compare.mjs', 'scripts/core/metrics.mjs', 'scripts/core/bootstrap.mjs'];
  const oldManifest = await createBundleManifest({ bundleRoot: bundle, releaseVersion: '0.2.0', sources: { evaluation: older, protocol: protocolSourcePaths } });
  assert.equal(oldManifest.evaluation_sources.length, older.length);
  assert.equal((await verifyBundle({ bundleRoot: bundle, manifest: oldManifest })).status, 'valid', 'a manifest that recorded the shorter list verifies over that list');
  const manifest = await createBundleManifest({ bundleRoot: bundle, releaseVersion: '0.2.0' });
  assert.notEqual(manifest.evaluation_hash, oldManifest.evaluation_hash);
  assert.equal((await verifyBundle({ bundleRoot: bundle, manifest })).status, 'valid');
  // A change to verdict code now changes the identity; before this release it did not.
  await writeFile(path.join(bundle, 'scripts/core/derive.mjs'), 'tampered');
  const codes = (await verifyBundle({ bundleRoot: bundle, manifest })).errors.map(error => error.code);
  assert.ok(codes.includes('hash_mismatch') && codes.includes('evaluation_sources_mismatch'), codes.join());
  const recomputed = await createBundleManifest({ bundleRoot: bundle, releaseVersion: '0.2.0' });
  assert.notEqual(recomputed.evaluation_hash, manifest.evaluation_hash, 'the evaluation hash moved with the verdict code');
  assert.equal((await verifyBundle({ bundleRoot: bundle, manifest: oldManifest })).status, 'invalid', 'the file hashes of an older manifest still catch the change');
});

// @optbrew-chrome
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../skills/optbrew/scripts/run.mjs';
import { limits } from '../skills/optbrew/scripts/core/config.mjs';
import { validateEntity } from '../skills/optbrew/scripts/core/contracts.mjs';
import { answersFor, bigSite, brewPage, memorySite, passJudgments, preflightOf, quietEnv, readQueue, SITE, workspace } from './support/run-scenario.mjs';

/** Two page types (`/news/` and `/shop/`, six pages each) under the home page, all linked from it and listed in the sitemap. */
function twoSectionSite() {
  const paths = [...Array.from({ length: 6 }, (_, i) => `/news/n${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `/shop/s${i + 1}`)];
  const pages = { '/': brewPage('Brew Home', paths), '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
    '/sitemap.xml': { type: 'application/xml', body: `<urlset>${paths.map(p => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>` } };
  for (const p of paths) pages[p] = brewPage(`Brew ${p}`, ['/']);
  return pages;
}

async function firstCall(pages, over = {}) {
  const site = memorySite(pages);
  const ws = await workspace(answersFor(`${SITE}/`, over));
  await preflightOf(site, `${SITE}/`, ws.out);
  const overrides = { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport };
  const first = await run({ answersPath: ws.answersPath, out: ws.out }, overrides);
  return { ws, overrides, first, queue: await readQueue(first) };
}

test('a site under the page cap is judged in full and says nothing about a cap', async () => {
  const { first, queue } = await firstCall(twoSectionSite());
  assert.equal(first.pages, 13);
  assert.equal(queue.pages.length, 13);
  assert.equal('judge_partial' in first, false);
});

test('at the cap the pages are spread over the page types, the rest are named, and the report says so', async () => {
  const call = await firstCall(twoSectionSite(), { max_judge_pages: 5 });
  const { first, queue } = call;
  const urls = queue.pages.map(page => new URL(page.url).pathname);
  assert.equal(urls.length, 5);
  assert.equal(urls[0], '/', 'the home page is kept first');
  assert.deepEqual(urls.slice(1).map(url => url.split('/')[1]).sort(), ['news', 'news', 'shop', 'shop'], 'each type gets the same share');
  assert.equal(first.judge_partial.judged_pages, 5);
  assert.equal(first.judge_partial.total_pages, 13);
  assert.equal(first.judge_partial.skipped.length, 8);
  assert.ok(first.judge_partial.skipped.every(url => !urls.includes(new URL(url).pathname)));
  const judgmentsPath = path.join(call.ws.dir, 'judgments.json');
  await writeFile(judgmentsPath, JSON.stringify(passJudgments(queue)));
  const done = await run({ answersPath: call.ws.answersPath, out: call.ws.out, judgmentsPath }, call.overrides);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.judge_partial, first.judge_partial);
  const report = JSON.parse(await readFile(done.reports.json, 'utf8'));
  assert.deepEqual(report.judge_partial, first.judge_partial);
  const row = report.composed.conditions.lines.find(line => line.label === '일부만 판정');
  assert.ok(row.value.startsWith('5/13쪽') && first.judge_partial.skipped.every(url => row.value.includes(url)));
  assert.ok((await readFile(done.reports.md, 'utf8')).includes('일부만 판정'));
});

test('the cap is a setting: a higher answer judges more pages, and without one the default applies', async () => {
  const more = await firstCall(twoSectionSite(), { max_judge_pages: 9 });
  assert.equal(more.queue.pages.length, 9);
  assert.equal(more.first.judge_partial.total_pages, 13);
  const { judge_pages_default: fallback } = limits();
  const big = await firstCall(bigSite(fallback + 10), { sample_mode: 'raise', max_urls: fallback + 20 });
  assert.equal(big.queue.pages.length, fallback, 'no answer: the default cap');
  assert.equal(big.first.judge_partial.judged_pages, fallback);
  assert.throws(() => validateEntity('IntakeAnswers', answersFor(`${SITE}/`, { max_judge_pages: 0 })), /max_judge_pages/);
  assert.throws(() => validateEntity('IntakeAnswers', answersFor(`${SITE}/`, { max_judge_pages: limits().max_urls_cap + 1 })), /max_judge_pages/);
});

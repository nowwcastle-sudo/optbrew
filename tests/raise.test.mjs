// @optbrew-chrome
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../skills/optbrew/scripts/run.mjs';
import { limits } from '../skills/optbrew/scripts/core/config.mjs';
import { answersFor, bigSite, brewPage, memorySite, preflightOf, quietEnv, SITE, workspace } from './support/run-scenario.mjs';

/**
 * Preflight, then the run's first call with `max_urls` set the way step 6 sets it (`max_urls_raise`, or the default when it is
 * null). Returns the raise and how many of the sitemap's section pages the run collected.
 */
async function raiseAndCollect(pages) {
  const site = memorySite(pages);
  const ws = await workspace(answersFor(`${SITE}/`));
  await preflightOf(site, `${SITE}/`, ws.out);
  const start = JSON.parse(await readFile(path.join(ws.out, 'preflight', 'start.json'), 'utf8'));
  const raise = start.max_urls_raise;
  const answers = answersFor(`${SITE}/`, raise === null ? {} : { sample_mode: 'raise', max_urls: raise });
  const audit = await workspace(answers);
  const before = site.requests.length;
  await run({ answersPath: audit.answersPath, out: ws.out }, { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport });
  const collected = new Set(site.requests.slice(before).filter(href => new URL(href).pathname.startsWith('/section/'))).size;
  return { raise, collected };
}

test('max_urls_raise is null only when the default limit already collects every sitemap page, and otherwise the smallest limit that does', async () => {
  const { max_urls_default: base } = limits();
  for (const count of [40, 43, 48, 51, 60]) {
    const { raise, collected } = await raiseAndCollect(bigSite(count));
    assert.equal(collected, count, `${count} sitemap pages are all collected (raise ${raise})`);
    if (raise !== null) {
      assert.ok(raise > base, `${count}: a raise is above the default`);
      // One less would drop a page: the same preflight, run at raise - 1, collects fewer.
      const site = memorySite(bigSite(count));
      const ws = await workspace(answersFor(`${SITE}/`, raise - 1 > base ? { sample_mode: 'raise', max_urls: raise - 1 } : {}));
      await preflightOf(site, `${SITE}/`, ws.out);
      const before = site.requests.length;
      await run({ answersPath: ws.answersPath, out: ws.out }, { env: quietEnv(), home: ws.home, selectTransport: site.selectTransport });
      assert.ok(new Set(site.requests.slice(before).filter(href => new URL(href).pathname.startsWith('/section/'))).size < count, `${count}: ${raise - 1} drops a page`);
    }
  }
});

test('a sitemap file the home page links to, outside the index, is counted the way the run counts it', async () => {
  const pages = bigSite(55);
  pages['/'] = brewPage('Brew Home', ['/section/page-1', '/news-sitemap.xml']);
  pages['/news-sitemap.xml'] = { type: 'application/xml', body: `<urlset><url><loc>${SITE}/section/page-1</loc></url></urlset>` };
  const { raise, collected } = await raiseAndCollect(pages);
  assert.ok(raise !== null);
  assert.equal(collected, 55);
});

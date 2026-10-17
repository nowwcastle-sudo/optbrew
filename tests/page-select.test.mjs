import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPages } from '../skills/optbrew/scripts/core/page-select.mjs';

const ORIGIN = 'https://example.test';
const scope = { allowed: [{ origin: ORIGIN, path_prefix: '/' }], local_targets: [], max_urls: 50 };
const preflight = (sitemapLocs = [], pageLinks = []) => ({ status: 'read', sitemapLocs, pageLinks });
const select = ({ factUrls = [], sitemapLocs = [], pageLinks = [], auxiliary = [], budget = 10 } = {}) =>
  selectPages({ home: `${ORIGIN}/`, factUrls, preflight: preflight(sitemapLocs, pageLinks), scope, budget, auxiliary: new Set(auxiliary) });

test('a fact page that is also a declared sitemap file is left out and reported', () => {
  const sitemap = `${ORIGIN}/pages-sitemap.xml`;
  const result = select({ factUrls: [sitemap, `${ORIGIN}/about`], auxiliary: [sitemap] });
  assert.deepEqual(result.pages, [`${ORIGIN}/`, `${ORIGIN}/about`]);
  assert.deepEqual(result.dropped, [{ url: sitemap, reason: 'auxiliary_resource' }]);
});

test('a fact page named like a robots or sitemap file is reported even when it was not declared', () => {
  const result = select({ factUrls: [`${ORIGIN}/robots.txt`, `${ORIGIN}/sitemap_index.xml`] });
  assert.deepEqual(result.pages, [`${ORIGIN}/`]);
  assert.deepEqual(result.dropped.map(entry => entry.reason), ['auxiliary_resource', 'auxiliary_resource']);
});

test('a fact page that is a file, not a page, is reported', () => {
  const result = select({ factUrls: [`${ORIGIN}/menu.pdf`] });
  assert.deepEqual(result.pages, [`${ORIGIN}/`]);
  assert.deepEqual(result.dropped, [{ url: `${ORIGIN}/menu.pdf`, reason: 'not_a_page' }]);
});

test('only a fact page is reported: a sitemap or link that is an auxiliary resource or a file is left out silently', () => {
  const sitemap = `${ORIGIN}/pages-sitemap.xml`;
  const result = select({ sitemapLocs: [sitemap, `${ORIGIN}/guide.pdf`, `${ORIGIN}/a`], pageLinks: [`${ORIGIN}/robots.txt`, `${ORIGIN}/b`], auxiliary: [sitemap] });
  assert.deepEqual(result.pages, [`${ORIGIN}/`, `${ORIGIN}/a`, `${ORIGIN}/b`]);
  assert.deepEqual(result.dropped, []);
});

test('a fact page listed twice is reported once, whatever the reason', () => {
  const sitemap = `${ORIGIN}/pages-sitemap.xml`;
  const result = select({ factUrls: [sitemap, sitemap, `${ORIGIN}/menu.pdf`, `${ORIGIN}/menu.pdf`, 'https://elsewhere.test/a', 'https://elsewhere.test/a'], auxiliary: [sitemap] });
  assert.deepEqual(result.dropped.map(entry => entry.reason), ['auxiliary_resource', 'not_a_page', 'outside_scope']);
  const over = select({ factUrls: [`${ORIGIN}/a`, `${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/b`], budget: 2 });
  assert.deepEqual(over.dropped, [{ url: `${ORIGIN}/b`, reason: 'over_limit' }]);
});

test('a fact page that repeats the home page or another fact page adds no entry, and the other reasons still apply', () => {
  const result = select({ factUrls: [`${ORIGIN}/`, `${ORIGIN}/about`, `${ORIGIN}/about`, 'https://elsewhere.test/contact'], budget: 2 });
  assert.deepEqual(result.pages, [`${ORIGIN}/`, `${ORIGIN}/about`]);
  assert.deepEqual(result.dropped, [{ url: 'https://elsewhere.test/contact', reason: 'outside_scope' }]);
  const full = select({ factUrls: [`${ORIGIN}/about`], budget: 1 });
  assert.deepEqual(full.dropped, [{ url: `${ORIGIN}/about`, reason: 'over_limit' }]);
});

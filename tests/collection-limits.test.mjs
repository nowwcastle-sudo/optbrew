// The collection limits must say which limit stopped the crawl (Dot B code-quality report 2026-11-13): running out of the
// request budget, seeing too many URLs (`max_discovered_urls`) and cutting a page's links (`max_page_links`) are three
// different limits. Each one makes the run incomplete, and only the request budget implies that every request was used.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { collect } from '../skills/optbrew/scripts/core/collector.mjs';
import { limits } from '../skills/optbrew/scripts/core/config.mjs';
import { buildReport } from '../skills/optbrew/scripts/core/report.mjs';
import { buildScenario, startSite } from './support/review-scenario.mjs';

const SITE = 'https://example.test';
const scope = { allowed: [{ origin: SITE, path_prefix: '/' }], max_urls: 50 };
const context = urls => ({ scope, protocol: { page_types: [{ id: 'main', urls: urls.map(url => ({ original: url, normalized: url })) }] } });
const resolve = async () => [{ address: '93.184.215.14', family: 4 }];
const html = body => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<html><head><title>T</title></head><body>${body}</body></html>`) });

/** A directory-like page: mostly links to other sites, plus a few of its own pages. */
const linkHeavy = (tag, own) => Array.from({ length: 1990 }, (_, i) => `<a href="https://other.test/${tag}${i}">x</a>`).join('') +
  own.map(p => `<a href="${p}">p</a>`).join('');

test('seeing too many URLs is a discovery limit, not a spent request budget', async () => {
  const pages = { '/': linkHeavy('r', ['/r1', '/r2']), '/a': linkHeavy('a', ['/a1', '/a2']), '/b': linkHeavy('b', ['/b1', '/b2']) };
  const result = await collect(context([`${SITE}/`, `${SITE}/a`, `${SITE}/b`]), { transport: async ({ url }) => html(pages[url.pathname] ?? ''), resolve });
  assert.ok(result.request_count < 50, `requests ${result.request_count}`);
  assert.equal(result.limit_reached, true, 'the run says it is incomplete');
  assert.deepEqual([...new Set(result.skipped.map(x => x.reason))].sort(), ['discovery_limit', 'outside_scope']);
});

test('links cut from a long page make the run incomplete and name one cut link', async () => {
  const filler = Array.from({ length: limits().max_page_links }, () => '<a href="/a">a</a>').join('');
  const pages = { '/': `${filler}<a href="/hidden">h</a>`, '/a': '', '/hidden': '' };
  const result = await collect(context([`${SITE}/`]), { transport: async ({ url }) => html(pages[url.pathname] ?? ''), resolve });
  assert.equal(result.limit_reached, true);
  assert.deepEqual(result.skipped.filter(x => x.reason === 'link_limit').map(x => new URL(x.url).pathname), ['/hidden']);
});

test('an ordinary crawl is complete and fetches what it found', async () => {
  const pages = { '/': '<a href="/a">a</a><a href="https://other.test/">o</a>', '/a': '' };
  const result = await collect(context([`${SITE}/`]), { transport: async ({ url }) => html(pages[url.pathname] ?? ''), resolve });
  assert.equal(result.limit_reached, false);
  assert.deepEqual(result.skipped.map(x => x.reason), ['outside_scope']);
});

const sites = [];
after(() => Promise.all(sites.map(x => x.close())));
const doc = (p, body) => ({ body: `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Page ${p}</title></head><body>${body}</body></html>` });

async function report(t, routes, paths, name) {
  const site = await startSite(routes); sites.push(site);
  const s = await buildScenario(site, paths, { enable: ['discovery'], name });
  t.after(() => rm(s.dir, { recursive: true, force: true }));
  return s;
}

test('the report replays a run stopped by the discovery limit', async t => {
  const routes = Object.fromEntries(['/', '/a', '/b'].map((p, i) => [p, () => doc(p, linkHeavy(`s${i}`, [`${p === '/' ? '' : p}/x`]))]));
  const s = await report(t, routes, ['/', '/a', '/b'], 'limits-discovery');
  assert.doesNotThrow(() => buildReport(s.packet));
});

test('the report replays a run whose page links were cut', async t => {
  const filler = Array.from({ length: limits().max_page_links }, () => '<a href="/a">a</a>').join('');
  const routes = { '/': () => doc('/', `${filler}<a href="/hidden">h</a>`), '/a': () => doc('/a', ''), '/hidden': () => doc('/hidden', '') };
  const s = await report(t, routes, ['/'], 'limits-links');
  assert.doesNotThrow(() => buildReport(s.packet));
});

// What a hostile site or a handed-over export can make the audit do must stay bounded: the links a page lists
// (daybreak csf_9b099e94a9109c6bebd137cd), the work a small ZIP asks for (csf_f055c95f8ea4039291f9f9a7) and the title
// analysis of the Naver module (csf_84b515d62d085c422ec8a13c). Each case also checks that an ordinary input is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { collect, links } from '../skills/optbrew/scripts/core/collector.mjs';
import { readOwnerExport } from '../skills/optbrew/scripts/adapters/imports.mjs';
import { limits } from '../skills/optbrew/scripts/core/config.mjs';
import { auditCollected } from '../skills/optbrew/modules/naver-searchadvisor/scripts/audit.mjs';
import { zipOf } from './support/run-scenario.mjs';

const SITE = 'https://example.test';
const scope = { allowed: [{ origin: SITE, path_prefix: '/owned/' }] };
const context = urls => ({ scope, protocol: { page_types: [{ id: 'main', urls: urls.map(url => ({ original: url, normalized: url })) }] } });
const resolve = async () => [{ address: '93.184.215.14', family: 4 }];
const html = body => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<html><head><title>T</title></head><body>${body}</body></html>`) });

test('a page with endless links keeps the crawl ledger bounded and says the run is incomplete', async () => {
  const many = Array.from({ length: 30000 }, (_, i) => `<a href="/owned/p${i}">p</a><a href="https://other.test/x">x</a>`).join('');
  const result = await collect(context([`${SITE}/owned/`]), { transport: async () => html(many), resolve });
  assert.ok(result.ledger.length <= limits().max_discovered_urls + 1, `ledger ${result.ledger.length}`);
  assert.ok(result.discovered_count <= limits().max_discovered_urls);
  assert.equal(result.limit_reached, true, 'cut links make the run incomplete');
  assert.equal(result.skipped.filter(entry => entry.reason === 'url_limit' && !entry.url.startsWith(`${SITE}/owned/p`)).length, 0,
    'the limit is recorded on an in-scope link, which the report replay can trace to the page');
  assert.ok(links(many, `${SITE}/owned/`).length <= limits().max_page_links + 1);
});

test('an ordinary page is crawled as before', async () => {
  const pages = { '/owned/': '<a href="/owned/a">a</a><a href="/owned/b">b</a><a href="https://other.test/">o</a>', '/owned/a': '', '/owned/b': '' };
  const result = await collect(context([`${SITE}/owned/`]), { transport: async ({ url }) => html(pages[url.pathname] ?? ''), resolve });
  assert.equal(result.limit_reached, false);
  assert.deepEqual(result.artifacts.map(artifact => new URL(artifact.final_url).pathname).sort(), ['/owned/', '/owned/a', '/owned/b']);
  assert.deepEqual(result.skipped.map(entry => entry.reason), ['outside_scope']);
});

const DAILY = 'Date,Clicks,Impressions\n2026-09-02,20,300\n2026-09-01,10,200\n';
const reason = fn => { try { fn(); return null; } catch (error) { return error.reason; } };

test('a ZIP with more entries than an export has is refused before anything is inflated', () => {
  const files = Object.fromEntries(Array.from({ length: limits().max_export_entries + 1 }, (_, i) => [`f${i}.csv`, 'a\n']));
  assert.equal(reason(() => readOwnerExport('gsc', zipOf(files))), 'export_file_too_large');
});

/** One deflated CSV listed `copies` times in the central directory, every listing pointing at the same bytes. */
function overlappingZip(text, copies) {
  const name = Buffer.from('Dates.csv'), data = deflateRawSync(Buffer.from(text));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(text), 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(Buffer.byteLength(text), 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const directory = Buffer.concat(Array.from({ length: copies }, () => [central, name]).flat());
  const end = Buffer.alloc(22);
  const offset = 30 + name.length + data.length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(copies, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, name, data, directory, end]);
}

test('ZIP entries that share their compressed bytes are refused', () => {
  assert.equal(reason(() => readOwnerExport('gsc', overlappingZip('Query,Clicks\nx,1\n', 40))), 'export_zip_damaged');
  // The same bytes listed once are an ordinary export.
  assert.equal(readOwnerExport('gsc', overlappingZip(DAILY, 1)).rows.find(row => row.metric_id === 'clicks').value, 30);
});

test('the inflated total of a ZIP is bounded across its entries', () => {
  // Every entry is under the per-file limit, but together they inflate past the archive budget.
  const per = limits().max_bytes - 1024;
  const count = Math.floor(limits().max_export_bytes / per) + 1;
  const files = Object.fromEntries(Array.from({ length: count }, (_, i) => [`Other${i}.csv`, `Query,Clicks\n${'x'.repeat(per - 20)}\n`]));
  assert.equal(reason(() => readOwnerExport('gsc', zipOf(files))), 'export_file_too_large');
  // A normal export with several tables is still read.
  const normal = readOwnerExport('gsc', zipOf({ 'Queries.csv': 'Top queries,Clicks\nbrew,1\n', 'Pages.csv': 'Top pages,Clicks\n/,5\n', 'Dates.csv': DAILY }));
  assert.equal(normal.window.start, '2026-09-01');
});

test('a title of many repeated words is analysed in linear time with the same result', () => {
  const artifact = { final_url: `${SITE}/owned/`, status: 200, headers: {} };
  const title = Array.from({ length: 400000 }, (_, i) => `w${i % 50}`).join(' ');
  const started = performance.now();
  const result = auditCollected({ artifact, html: `<html><head><title>${title}</title></head></html>`, engines: ['naver'] });
  assert.ok(performance.now() - started < 5000, 'finished within seconds');
  const repeat = result.markup_findings.find(finding => finding.code === 'title-keyword-repeat');
  assert.equal(repeat.values.words.split(', ').length, 50);
  // An ordinary "Page | Site" title: a word twice is not a markup finding, three times is, in first-seen order.
  const plain = auditCollected({ artifact, html: '<html><head><title>Care Home | Care Home Seoul</title></head></html>', engines: ['naver'] });
  assert.equal(plain.markup_findings.some(finding => finding.code === 'title-keyword-repeat'), false);
  const thrice = auditCollected({ artifact, html: '<html><head><title>bb aa bb aa bb aa cc</title></head></html>', engines: ['naver'] });
  assert.equal(thrice.markup_findings.find(finding => finding.code === 'title-keyword-repeat').values.words, 'bb, aa');
});

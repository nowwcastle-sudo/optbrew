import { readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { preflight } from '../../skills/optbrew/scripts/preflight.mjs';
import { versions } from '../../skills/optbrew/scripts/core/config.mjs';
import { environmentProbe } from './probe.mjs';
import { tempDir } from './temp-dir.mjs';

export const SITE = 'https://brew.test';
/** A public address (not in any blocked range), so address vetting passes for the in-memory site. */
const PUBLIC_ADDRESS = '93.184.216.34';
const SENTENCE = 'Brew Cafe serves fresh coffee and pastries every morning in the heart of Springfield town centre.';

/** One page of the in-memory site; `links` are paths. */
export const brewPage = (title, links = []) => ({ body: `<!doctype html><html lang="en"><head><title>${title}</title>` +
  '<meta name="description" content="Fresh coffee and pastries"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
  `<body><h1>${title}</h1><p>${SENTENCE}</p><p>Phone: 02-555-0142</p>${links.map(link => `<a href="${link}">${link}</a>`).join(' ')}</body></html>` });

export const brewPages = () => ({
  '/': brewPage('Brew Home', ['/about', '/contact']),
  '/about': brewPage('About Brew', ['/']),
  '/contact': brewPage('Contact Brew', ['/']),
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
  '/sitemap.xml': { type: 'application/xml', body: `<urlset><url><loc>${SITE}/</loc></url></urlset>` },
});

/** A site that lives in memory: a transport that answers from `pages` and counts every request, and the `selectTransport` that hands it out. */
export function memorySite(pages = brewPages()) {
  const requests = [];
  const calls = [];
  // A page is found by full address, then host and path, then path; `{ redirect }` answers with a redirect.
  const transport = async ({ url, headers = {} }) => {
    requests.push(url.href);
    calls.push({ href: url.href, headers });
    const hit = pages[url.href] ?? pages[`${url.host}${url.pathname}`] ?? pages[url.pathname];
    if (hit?.redirect) return { status: 301, headers: { location: hit.redirect }, body: Buffer.alloc(0) };
    if (!hit) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') };
    return { status: 200, headers: { 'content-type': hit.type ?? 'text/html; charset=utf-8' }, body: Buffer.from(hit.body) };
  };
  const selected = { transport, resolve: async () => [{ address: PUBLIC_ADDRESS, family: 4 }], address_vetting: 'direct', proxy: null };
  return { requests, calls, selected, selectTransport: async () => selected };
}

/** The unscored read before the start questions, run on an in-memory site into `out/preflight`; the run selects its pages from it. */
export function preflightOf(site, url, out) {
  return preflight({ url, out, env: {}, selectTransport: site.selectTransport, findChrome: async () => ({ path: null, reason: 'chrome_not_found' }),
    readGoogleKey: () => null, home: out });
}

/** A site of `count` pages under /section/, the home page linking to the first five, plus a sitemap that lists them all. */
export function bigSite(count) {
  const numbered = Array.from({ length: count }, (_, i) => `/section/page-${i + 1}`);
  const pages = { '/': brewPage('Brew Home', numbered.slice(0, 5)), '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
    '/sitemap.xml': { type: 'application/xml', body: `<urlset>${numbered.map(p => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>` } };
  for (const [i, p] of numbered.entries()) pages[p] = brewPage(`Brew Page ${i + 1}`, ['/']);
  return pages;
}

export const questions = [{ id: 'q1', question: 'What does Brew Cafe sell?', category: 'brand' }];

/** Valid start answers for `url`; `over` replaces top-level fields. */
export const answersFor = (url, over = {}) => ({ schema_version: versions().contract_schema, guidance_level: 'brief', url, goals: ['SEO'], questions,
  facts: [], sample_mode: 'sample', max_urls: 50, source_tools: [],
  probe: environmentProbe({ chrome: { found: false, kind: null, reason: 'chrome_not_found' } }), ...over });

/** An environment with no Chrome and no Google key, so a run cannot launch a browser or read the user's own key. */
export const quietEnv = () => ({ ...process.env, OPTBREW_CHROME: path.join(os.tmpdir(), 'optbrew-no-such-chrome'), OPTBREW_GOOGLE_API_KEY: '' });

/** A temp folder with the answers written into it; returns the folder, the answers path and a fresh `out` path. */
export async function workspace(answers, name = 'optbrew-run-') {
  const dir = await tempDir(name);
  const answersPath = path.join(dir, 'answers.json');
  await writeFile(answersPath, JSON.stringify(answers));
  return { dir, answersPath, out: path.join(dir, 'out'), home: path.join(dir, 'home') };
}

/** A ZIP archive holding `files` ({ name: text }), deflated, with a central directory; checksums are left zero because the reader does not use them. */
export function zipOf(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name), data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(text), 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(Buffer.byteLength(text), 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const PAGE_FILE = /^p\d{3,}\.json$/;

/** The queue as the model reads it: the `judge_pages` folder a first call names, `site.json` joined with its page files in order as `{ questions, site_chrome?, pages }`. */
export async function readQueue({ judge_pages: dir }) {
  const read = async name => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
  const names = (await readdir(dir)).filter(name => PAGE_FILE.test(name)).sort();
  return { ...(await read('site.json')), pages: await Promise.all(names.map(read)) };
}

/** The bytes the model has to read for a queue: every file of the `judge_pages` folder. */
export async function queueBytes({ judge_pages: dir }) {
  const sizes = await Promise.all((await readdir(dir)).map(async name => (await readFile(path.join(dir, name))).length));
  return sizes.reduce((sum, size) => sum + size, 0);
}

/** The units a grouped queue asks for. */
export const queuedUnits = queue => queue.pages.flatMap(page => page.families.map(family => ({ ...family, page })));

/**
 * One pass judgment for every unit of a queue file, citing the first candidate span of the unit's page. An answer-clarity pass
 * names the first question of the file's list.
 */
export const passJudgments = queue => queuedUnits(queue).map(({ family_id, unit_key, page }) => ({ family_id, unit_key, state: 'pass',
  span_ids: [page.spans[0].span_id], reason: 'The cited text supports the check',
  ...(family_id === 'answer-clarity' ? { question_id: queue.questions[0].id } : {}) }));

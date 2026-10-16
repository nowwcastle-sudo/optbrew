import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
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
  const transport = async ({ url }) => {
    requests.push(url.href);
    const hit = pages[url.pathname];
    if (!hit) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') };
    return { status: 200, headers: { 'content-type': hit.type ?? 'text/html; charset=utf-8' }, body: Buffer.from(hit.body) };
  };
  const selected = { transport, resolve: async () => [{ address: PUBLIC_ADDRESS, family: 4 }], address_vetting: 'direct', proxy: null };
  return { requests, selected, selectTransport: async () => selected };
}

export const questions = [{ id: 'q1', question: 'What does Brew Cafe sell?', category: 'brand' }];

/** Valid start answers for `url`; `over` replaces top-level fields. */
export const answersFor = (url, over = {}) => ({ schema_version: '1.0.0', guidance_level: 'brief', url, goals: ['SEO'], questions,
  facts: [], sample_mode: 'sample', max_urls: 20, source_tools: [],
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

/** The units a grouped queue file asks for. */
export const queuedUnits = queue => queue.pages.flatMap(page => page.families.map(family => ({ ...family, page })));

/** One pass judgment for every unit of a queue file, citing the first candidate span of the unit's page. */
export const passJudgments = queue => queuedUnits(queue).map(({ family_id, unit_key, page }) => ({ family_id, unit_key, state: 'pass',
  span_ids: [page.spans[0].span_id], reason: 'The cited text supports the check' }));

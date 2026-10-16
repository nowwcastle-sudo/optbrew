import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAudit } from '../../skills/optbrew/scripts/audit.mjs';

const siteRoot = new URL('../fixtures/sites/', import.meta.url);
const template = new URL('../fixtures/scoring/before.json', import.meta.url);
const VERSION_FIELDS = ['schema_version', 'evaluation_version', 'protocol_version'];

/** The thirteen families whose verdicts come from stored evidence alone; each has its own check block. */
export const CODE_FAMILIES = ['fetch-response', 'search-crawl-policy', 'index-policy', 'render-content', 'discovery', 'document-title',
  'canonical-consistency', 'internal-navigation', 'structured-data-truth', 'locale-links', 'naver-markup', 'entity-identity', 'fact-consistency'];

/** Copy of the observations without version fields, so a version bump never breaks the golden comparison. */
export function withoutVersions(observations) {
  return observations.map(o => Object.fromEntries(Object.entries(o).filter(([k]) => !VERSION_FIELDS.includes(k))));
}

const ld = (extra = {}) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org',
  '@type': 'Organization', name: 'Brew Cafe', sameAs: ['https://social.example/brew'], ...extra })}</script>`;
/** A page with every Open Graph, description, canonical and viewport tag the naver-markup check reads. */
const page = (origin, route, { title, body = '', head = '', canonical = route, phone = '02-555-0142', markup = true } = {}) =>
  `<!doctype html><html><head><title>${title}</title>${markup ? `<meta name="description" content="Fresh coffee and pastries">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="${origin}${canonical}">
<meta property="og:title" content="${title}"><meta property="og:description" content="Fresh coffee">
<meta property="og:image" content="${origin}/og.png"><meta property="og:url" content="${origin}${route}"><meta property="og:type" content="website">` : ''}${head}</head>
<body><p>Phone: ${phone}</p><p>Address: 10 Main Street, Springfield</p>${body}</body></html>`;
const sitemap = (origin, paths) => ({ type: 'application/xml',
  body: `<urlset>${paths.map(p => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>` });

/** Routes served by a scenario; every scenario is judged with every code family applicable. */
const scenarios = {
  // The seeded-defect and fixed single pages the workflow test audits.
  before: { files: { '/': 'index.before.html' }, urls: ['/'], aux: [] },
  after: { files: { '/': 'index.after.html' }, urls: ['/'], aux: [] },
  // Every family can pass: linked pages, one sitemap, open robots, agreeing facts, a complete Organization.
  clean: {
    urls: ['/', '/about', '/contact'], aux: ['robots', 'sitemap'],
    pages: origin => ({
      '/': page(origin, '/', { title: 'Brew Home', head: ld(), body: '<a href="/about">About</a> <a href="/contact">Contact</a>' }),
      '/about': page(origin, '/about', { title: 'About Brew', body: '<a href="/">Home</a>' }),
      '/contact': page(origin, '/contact', { title: 'Contact Brew', body: '<a href="/">Home</a>' }),
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
      '/sitemap.xml': sitemap(origin, ['/', '/about', '/contact']),
    }),
  },
  // One seeded defect per family: noindex, blocked path, 404, orphan, duplicate title, bad canonical, bad JSON-LD, wrong phone.
  defect: {
    urls: ['/', '/about', '/contact', '/noindex', '/private', '/gone', '/orphan', '/dup', '/badcanon', '/badld', '/bare'],
    aux: ['robots', 'sitemap'],
    pages: origin => ({
      '/': page(origin, '/', { title: 'Brew Home', head: ld({ sameAs: undefined }),
        body: ['/about', '/contact', '/noindex', '/private', '/gone', '/dup', '/badcanon', '/badld', '/bare'].map(p => `<a href="${p}">${p}</a>`).join(' ') }),
      '/about': page(origin, '/about', { title: 'About Brew' }),
      '/contact': page(origin, '/contact', { title: 'Contact Brew', phone: '02-555-0199' }),
      '/noindex': page(origin, '/noindex', { title: 'Hidden Brew', head: '<meta name="robots" content="noindex">' }),
      '/private': page(origin, '/private', { title: 'Private Brew' }),
      '/orphan': page(origin, '/orphan', { title: 'Orphan Brew' }),
      '/dup': page(origin, '/dup', { title: 'Brew Home' }),
      '/badcanon': page(origin, '/badcanon', { title: 'Wrong Canonical Brew', canonical: '/gone' }),
      '/badld': page(origin, '/badld', { title: 'Broken Data Brew', head: '<script type="application/ld+json">{ not json</script>' }),
      '/bare': page(origin, '/bare', { title: 'Bare Brew', markup: false }),
      '/robots.txt': { type: 'text/plain', body: 'User-agent: Googlebot\nDisallow: /private\n\nUser-agent: Yeti\nDisallow: /private\n' },
      '/sitemap.xml': sitemap(origin, ['/', '/about', '/contact']),
    }),
  },
};

/** Hash of an evidence file with the random port masked, so the same page body keeps one name across runs. */
async function stableRef(ref, port) {
  try {
    const text = (await readFile(ref, 'utf8')).replaceAll(`127.0.0.1:${port}`, '127.0.0.1:PORT');
    return `evidence/${createHash('sha256').update(text).digest('hex')}${path.extname(ref)}`;
  } catch { return 'evidence/missing'; }
}

/** Strips what varies per run: the random port, the temp directory, the evidence file names, and the observation_id hashed from the port. */
async function stable(o, port, root) {
  const { observation_id: _hash, ...rest } = o;
  const clean = v => typeof v === 'string'
    ? v.replaceAll(`127.0.0.1:${port}`, '127.0.0.1:PORT').replaceAll(root, '<out>').replaceAll(path.sep, '/') : v;
  const row = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, clean(v)]));
  row.evidence_ref = `<out>/${await stableRef(o.evidence_ref, port)}`;
  if (o.applicability_decision) row.applicability_decision = { ...o.applicability_decision, reason: clean(o.applicability_decision.reason),
    evidence_ref: `<out>/${await stableRef(o.applicability_decision.evidence_ref, port)}` };
  return row;
}

async function routesOf(scenario, origin) {
  if (scenario.files) return Object.fromEntries(await Promise.all(Object.entries(scenario.files)
    .map(async ([route, file]) => [route, await readFile(new URL(file, siteRoot))])));
  return scenario.pages(origin);
}

/** Audits each scenario over a local HTTP server and returns the observations, tagged by scenario. */
export async function goldenObservations() {
  const out = [];
  for (const [name, scenario] of Object.entries(scenarios)) {
    let routes = {};
    const server = createServer((req, res) => {
      const hit = routes[req.url];
      if (hit === undefined) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      const body = typeof hit === 'string' || Buffer.isBuffer(hit) ? hit : hit.body;
      res.writeHead(200, { 'Content-Type': hit.type ?? 'text/html; charset=utf-8' });
      res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-golden-'));
    try {
      const port = server.address().port;
      const origin = `http://127.0.0.1:${port}`;
      routes = await routesOf(scenario, origin);
      const context = JSON.parse(await readFile(template, 'utf8')).run_context;
      context.run_id = `golden-${name}`;
      context.target = `${origin}/`;
      context.environment = 'local';
      context.scope = { allowed: [{ origin, path_prefix: '/' }], local_targets: [{ host: '127.0.0.1', port }] };
      context.evidence_ref = 'context.json';
      const urls = scenario.urls.map(p => ({ original: `${origin}${p}`, normalized: `${origin}${p}` }));
      context.protocol.page_types = [{ id: 'primary', urls }];
      context.protocol.auxiliary_resources = scenario.aux.map(kind => {
        const url = `${origin}/${kind === 'robots' ? 'robots.txt' : 'sitemap.xml'}`;
        return { kind, original: url, normalized: url };
      });
      context.protocol.engines = ['google', 'naver'];
      for (const family of context.protocol.families) {
        if (CODE_FAMILIES.includes(family.family_id)) { family.applicable = true; delete family.applicability_decision; }
        else if (family.applicability_decision) family.applicability_decision.evidence_ref = 'intake.json';
      }
      const result = await runAudit({ context, modules: ['naver-searchadvisor'], outputDir: root });
      for (const o of result.observations) out.push(await stable({ ...o, site: name }, port, root));
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  }
  return out;
}

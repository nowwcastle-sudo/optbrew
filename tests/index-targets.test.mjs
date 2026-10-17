import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDerivedIndexDecision, notIndexTargets, withIndexTargets } from '../skills/optbrew/scripts/core/index-targets.mjs';

const SITE = 'https://shop.test';
const SITEMAP = `${SITE}/sitemap.xml`;
const NOINDEX = '<html><head><meta name="robots" content="noindex"><title>t</title></head><body>form</body></html>';
const OPEN = '<html><head><title>t</title></head><body>page</body></html>';
const sitemapOf = paths => `<?xml version="1.0"?><urlset>${paths.map(path => `<url><loc>${SITE}${path}</loc></url>`).join('')}</urlset>`;

/** A run over `pages` ({ path: html | { html, headers } }) and `sitemap` (a body, null when /sitemap.xml was not found). */
function scenario(pages, sitemap, { declared = [SITEMAP], extra = [] } = {}) {
  const bodies = new Map();
  const artifacts = Object.entries(pages).map(([path, page]) => {
    const evidence_ref = `evidence/${path.replace(/\W/g, '_')}.html`;
    bodies.set(evidence_ref, typeof page === 'string' ? page : page.html);
    const header_lines = Object.entries(typeof page === 'string' ? {} : page.headers ?? {}).map(([name, value]) => ({ name, value }));
    return { normalized_url: `${SITE}${path}`, final_url: `${SITE}${path}`, status: 200, capability: 'raw_html', evidence_ref, header_lines };
  });
  for (const [url, body] of [[SITEMAP, sitemap], ...extra]) {
    bodies.set(`evidence/${url}`, body ?? '');
    artifacts.push({ normalized_url: url, final_url: url, status: body === null ? 404 : 200, capability: 'raw_html', evidence_ref: `evidence/${url}`, header_lines: [] });
  }
  const urls = Object.keys(pages).map(path => ({ original: `${SITE}${path}`, normalized: `${SITE}${path}` }));
  const context = { target: `${SITE}/`, protocol: { engines: ['google'], auxiliary_resources: declared.map(normalized => ({ kind: 'sitemap', original: normalized, normalized })),
    page_types: [{ id: 'pages', urls }], render: { enabled: true, pages: urls.slice(0, 1) } } };
  const textOf = artifact => bodies.get(artifact.evidence_ref);
  return { context, artifacts, textOf, urls: () => notIndexTargets({ context, artifacts, textOf }).map(target => target.url.replace(SITE, '')) };
}

const LISTED = sitemapOf(['/', '/products', '/about']);

test('a noindex page the sitemap does not list is a deliberate non-index target (R89)', () => {
  const run = scenario({ '/': OPEN, '/products': OPEN, '/inquiry': NOINDEX }, LISTED);
  assert.deepEqual(run.urls(), ['/inquiry']);
  const [target] = notIndexTargets(run);
  assert.equal(target.evidence_ref, 'evidence/_inquiry.html', 'the decision cites the page\'s own raw evidence');
});

test('the X-Robots-Tag header counts as noindex in the raw response (R89)', () => {
  const run = scenario({ '/': OPEN, '/thanks': { html: OPEN, headers: { 'x-robots-tag': 'noindex' } } }, LISTED);
  assert.deepEqual(run.urls(), ['/thanks']);
});

test('the home page with noindex stays a failure (R89)', () => {
  assert.deepEqual(scenario({ '/': NOINDEX, '/products': OPEN }, sitemapOf(['/products'])).urls(), []);
});

test('a noindex page the sitemap lists stays a failure (R89)', () => {
  assert.deepEqual(scenario({ '/': OPEN, '/products': NOINDEX }, LISTED).urls(), []);
  assert.deepEqual(scenario({ '/': OPEN, '/products': NOINDEX }, sitemapOf(['/', '/products?utm=1', '/other'])).urls(), ['/products'], 'another address is another page');
});

test('without a sitemap that lists pages a noindex stays a failure (R89)', () => {
  assert.deepEqual(scenario({ '/': OPEN, '/inquiry': NOINDEX }, null).urls(), [], 'no sitemap was read');
  assert.deepEqual(scenario({ '/': OPEN, '/inquiry': NOINDEX }, sitemapOf([])).urls(), [], 'the sitemap lists nothing');
  const index = `<sitemapindex><sitemap><loc>${SITE}/page-sitemap.xml</loc></sitemap></sitemapindex>`;
  assert.deepEqual(scenario({ '/': OPEN, '/inquiry': NOINDEX }, index).urls(), [], 'an index that lists only sitemap files lists no page');
});

test('a declared sitemap that was never read could list the page, so a noindex stays a failure (R89)', () => {
  const run = scenario({ '/': OPEN, '/inquiry': NOINDEX }, LISTED, { declared: [SITEMAP, `${SITE}/other-sitemap.xml`] });
  assert.deepEqual(run.urls(), []);
  const read = scenario({ '/': OPEN, '/inquiry': NOINDEX }, LISTED, { declared: [SITEMAP, `${SITE}/other-sitemap.xml`], extra: [[`${SITE}/other-sitemap.xml`, sitemapOf(['/faq'])]] });
  assert.deepEqual(read.urls(), ['/inquiry'], 'once every declared sitemap was read the page is absent from all of them');
  const missing = scenario({ '/': OPEN, '/inquiry': NOINDEX }, LISTED, { declared: [SITEMAP, `${SITE}/gone.xml`], extra: [[`${SITE}/gone.xml`, null]] });
  assert.deepEqual(missing.urls(), ['/inquiry'], 'a sitemap that answered 404 was read and lists nothing');
});

test('an indexable page, or a noindex that is not for the target engine, is never a target (R89)', () => {
  const other = '<html><head><meta name="bingbot" content="noindex"></head><body>x</body></html>';
  assert.deepEqual(scenario({ '/': OPEN, '/a': OPEN, '/b': other }, LISTED).urls(), []);
});

test('withIndexTargets marks the page types and the render pages, and tells the derived decision from an approved one (R89)', () => {
  const run = scenario({ '/': OPEN, '/inquiry': NOINDEX }, LISTED);
  run.context.protocol.render.pages = run.context.protocol.page_types[0].urls;
  const targets = notIndexTargets(run);
  const marked = withIndexTargets(run.context, targets);
  const decision = { condition: 'not_public_index_target', reason: 'noindex and not listed in the sitemap', evidence_ref: 'evidence/_inquiry.html' };
  assert.deepEqual(marked.protocol.page_types[0].urls.map(url => url.public_indexing), [undefined, false]);
  assert.deepEqual(marked.protocol.page_types[0].urls[1].indexing_decision, decision);
  assert.deepEqual(marked.protocol.render.pages[1].indexing_decision, decision);
  assert.equal(run.context.protocol.page_types[0].urls[1].public_indexing, undefined, 'the given context is not changed');
  assert.equal(withIndexTargets(run.context, []), run.context);
  assert.equal(isDerivedIndexDecision(decision), true);
  assert.equal(isDerivedIndexDecision({ ...decision, reason: 'support route deliberately excluded' }), false);
  assert.equal(isDerivedIndexDecision(undefined), false);
});

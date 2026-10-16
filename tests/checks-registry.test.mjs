import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blocks } from '../skills/optbrew/scripts/core/checks/index.mjs';
import { prepare } from '../skills/optbrew/scripts/core/checks/prepare.mjs';
import { makeObservation, unitKey } from '../skills/optbrew/scripts/core/checks/observation.mjs';
import { linkGraph } from '../skills/optbrew/scripts/core/link-graph.mjs';

const registry = JSON.parse(readFileSync(new URL('../skills/optbrew/references/check-registry.json', import.meta.url), 'utf8')).families;

test('every block names a family in check-registry.json', () => {
  const known = new Set(registry.map(family => family.family_id));
  for (const block of blocks) {
    assert.ok(known.has(block.family_id), `${block.family_id} is not in check-registry.json`);
    assert.equal(typeof block.derive, 'function', block.family_id);
  }
});

test('no family is registered twice', () => {
  const names = blocks.map(block => block.family_id);
  assert.deepEqual(names, [...new Set(names)]);
});

test('code-judged families equal the ten code-judged ids, in registry order', () => {
  assert.deepEqual(blocks.map(block => block.family_id), ['fetch-response', 'search-crawl-policy', 'index-policy', 'discovery',
    'document-title', 'canonical-consistency', 'structured-data-truth', 'naver-markup', 'entity-identity', 'fact-consistency']);
  const order = registry.map(family => family.family_id);
  const positions = blocks.map(block => order.indexOf(block.family_id));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('makeObservation keeps the 0.1.4 observation_id and fields', () => {
  const page = makeObservation({ family_id: 'fetch-response', unit_key: unitKey('fetch-response', 'https://example.test/'),
    state: 'pass', reason: 'HTTP 200', evidence_ref: 'sha256:abc' });
  assert.equal(page.observation_id, 'ec710e6cd2d1f579e9fc7e03adbecc93917c559f818a4a27183e90547b660cae');
  assert.equal(page.unit_key, 'fetch-response|https://example.test/');
  assert.deepEqual([page.check_id, page.family_id, page.q, page.partial_basis, page.evaluator_type, page.source_ref],
    ['fetch-response', 'fetch-response', 1, null, 'code', 'optbrew:collector']);
  const engine = makeObservation({ family_id: 'search-crawl-policy', unit_key: unitKey('search-crawl-policy', 'https://example.test/a', 'naver'),
    state: 'fail', reason: 'disallowed', evidence_ref: 'sha256:abc' });
  assert.equal(engine.observation_id, '8783505834a142a2108d9746a4b2928a75ea5aa48e7491fd98daeb9a19c9f4d1');
  assert.equal(engine.q, 0);
});

test('makeObservation leaves q null for an undecided state and lets a block set its own', () => {
  const unknown = makeObservation({ family_id: 'document-title', unit_key: 'document-title|https://example.test/', state: 'unknown',
    reason: 'not established', evidence_ref: 'sha256:abc' });
  assert.equal(unknown.q, null);
  assert.throws(() => makeObservation({ family_id: 'document-title', unit_key: 'document-title|https://example.test/', state: 'pass', q: 0.5,
    reason: 'x', evidence_ref: 'sha256:abc' }));
});

test('prepare defaults the render and field inputs so a caller without them still works', () => {
  const prepared = prepare({ context: { protocol: { families: [], page_types: [], engines: [] } }, artifacts: [], textOf: () => '' });
  assert.deepEqual([prepared.renders, prepared.cwv, prepared.pageRows, prepared.facts], [[], [], [], []]);
  assert.equal(prepared.renderTextOf({}), '');
});

test('linkGraph counts inbound links, measures click depth and ignores self links', () => {
  const page = (path, links) => {
    const url = `https://example.test${path}`;
    return { url, artifact: { normalized_url: url, final_url: url },
      html: `<body>${links.map(href => `<a href="${href}">x</a>`).join('')}</body>` };
  };
  const rows = [page('/', ['/a', '/']), page('/a', ['/b#top']), page('/b', []), page('/lost', ['/b'])];
  const graph = linkGraph(rows, rows.map(row => row.artifact));
  assert.equal(graph.edges.length, 3);
  assert.deepEqual(['/', '/a', '/b', '/lost'].map(path => graph.depthOf(`https://example.test${path}`)), [0, 1, 2, null]);
  assert.deepEqual(['/', '/a', '/b'].map(path => graph.inbound(`https://example.test${path}`)), [0, 1, 2]);
  assert.equal(graph.scriptGap, false);
});

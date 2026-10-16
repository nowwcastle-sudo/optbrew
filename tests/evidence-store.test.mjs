import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore, readVerified } from '../skills/optbrew/scripts/core/evidence-store.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const header = { run_id: 'run-1', context_ref: 'context.json' };

async function withDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optbrew-store-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('write is content-addressed and idempotent', async () => {
  await withDir(async dir => {
    const store = openStore(dir, header);
    const first = await store.write('response', '{"a":1}\n');
    assert.equal(first.sha256, sha('{"a":1}\n'));
    assert.equal(first.ref, path.join(dir, `${first.sha256}.response.json`));
    assert.deepEqual(await store.write('response', Buffer.from('{"a":1}\n')), first);
    const raw = await store.write('html', Buffer.from('<p>x</p>'));
    assert.equal(raw.ref, path.join(dir, `${raw.sha256}.html`));
    assert.equal((await store.write('bin', Buffer.from([0, 1, 2]))).ref, path.join(dir, `${sha(Buffer.from([0, 1, 2]))}.bin`));
    assert.deepEqual((await readdir(dir)).sort(), [`${first.sha256}.response.json`, `${raw.sha256}.html`, `${sha(Buffer.from([0, 1, 2]))}.bin`].sort());
    await assert.rejects(store.write('../x', 'a'), /kind/);
  });
});

test('a named document keeps its file name and refuses different content', async () => {
  await withDir(async dir => {
    const store = openStore(dir, header);
    const saved = await store.write('collection', '{"artifacts":[]}\n', { name: 'collection.json' });
    assert.equal(saved.ref, path.join(dir, 'collection.json'));
    assert.deepEqual(await store.write('collection', '{"artifacts":[]}\n', { name: 'collection.json' }), saved);
    await assert.rejects(store.write('collection', '{"artifacts":[1]}\n', { name: 'collection.json' }), { message: 'evidence collection.json already exists with different content' });
    await assert.rejects(store.write('collection', 'a', { name: '../escape.json' }), /name/);
  });
});

test('append keeps earlier sections', async () => {
  await withDir(async dir => {
    const store = openStore(dir, header);
    await store.append('raw', { normalized_url: 'https://a.example/', evidence_ref: 'a', content_hash: 'h1' });
    await store.append('responses', { normalized_url: 'https://a.example/', evidence_ref: 'r', content_hash: 'h2' });
    await store.append('raw', { normalized_url: 'https://b.example/', evidence_ref: 'b', content_hash: 'h3' });
    await store.append('renders', { url: 'https://a.example/', evidence_ref: 'd', sha256: 'h4' });
    const index = await store.index();
    assert.equal(index.run_id, 'run-1');
    assert.equal(index.context_ref, 'context.json');
    assert.deepEqual(index.raw.map(x => x.content_hash), ['h1', 'h3']);
    assert.deepEqual(index.responses.map(x => x.content_hash), ['h2']);
    assert.deepEqual(index.failures, []);
    assert.deepEqual(index.renders.map(x => x.sha256), ['h4']);
    assert.deepEqual([index.render_ledger, index.cwv], [[], []]);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(store.indexRef, 'utf8'))),
      ['run_id', 'context_ref', 'raw', 'responses', 'failures', 'renders']);
    await assert.rejects(store.append('run_id', { x: 1 }), /section/);
  });
});

test('concurrent appends all land in the index', async () => {
  await withDir(async dir => {
    const store = openStore(dir, header);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append('raw', { n: i })));
    assert.deepEqual((await store.index()).raw.map(x => x.n), Array.from({ length: 20 }, (_, i) => i));
  });
});

test('two stores on one dir keep every append', async () => {
  await withDir(async dir => {
    const first = openStore(dir, header), second = openStore(dir, header);
    await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? first : second).append('raw', { n: i })));
    assert.deepEqual((await first.index()).raw.map(x => x.n).sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i));
    assert.deepEqual(await readdir(dir), ['evidence-index.json']);
  });
});

test('a relative ref reads the same through the store and readVerified', async () => {
  await withDir(async dir => {
    const store = openStore(dir, header);
    const { ref, sha256 } = await store.write('html', '<p>x</p>');
    const name = path.basename(ref);
    assert.deepEqual(await store.read(name, sha256), readVerified(dir, name, sha256));
    assert.deepEqual(await store.read(ref, sha256), readVerified(dir, ref, sha256));
    const relativeDir = path.relative(process.cwd(), dir);
    if (!path.isAbsolute(relativeDir)) {
      const local = openStore(relativeDir, header);
      const saved = await local.write('html', '<p>y</p>');
      assert.equal((await local.read(saved.ref, saved.sha256)).toString('utf8'), '<p>y</p>');
    }
  });
});

test('read returns verified bytes and rejects a tampered file', async () => {
  await withDir(async dir => {
    const store = openStore(dir, header);
    const { ref, sha256 } = await store.write('html', '<p>original</p>');
    assert.equal((await store.read(ref, sha256)).toString('utf8'), '<p>original</p>');
    await writeFile(ref, '<p>tampered</p>');
    await assert.rejects(store.read(ref, sha256), error => error.message.includes(ref) && !error.message.includes('tampered'));
    await assert.rejects(store.read(path.join(dir, '..', 'elsewhere.html'), sha256), /outside/);
  });
});

test('readVerified resolves a root-relative ref and refuses to leave the root', async () => {
  await withDir(async dir => {
    const store = openStore(dir, header);
    const { sha256 } = await store.write('html', '<p>x</p>');
    assert.equal(readVerified(dir, `${sha256}.html`, sha256).toString('utf8'), '<p>x</p>');
    assert.throws(() => readVerified(dir, `${sha256}.html`, '0'.repeat(64)), /hash mismatch: .*\.html/);
    assert.throws(() => readVerified(path.join(dir, 'sub'), `../${sha256}.html`, sha256), /outside run directory/);
  });
});

test('a crash between write and append leaves a readable index', async () => {
  await withDir(async dir => {
    const store = openStore(dir, header);
    await store.append('raw', { normalized_url: 'https://a.example/', evidence_ref: 'a', content_hash: 'h1' });
    const before = await store.index();
    await store.write('response', '{"orphan":true}\n');
    await writeFile(`${store.indexRef}.1234.tmp`, '{"run_id": "half-written');
    const reopened = openStore(dir, header);
    assert.deepEqual(await reopened.index(), before);
    await reopened.append('raw', { normalized_url: 'https://b.example/', evidence_ref: 'b', content_hash: 'h2' });
    assert.deepEqual((await reopened.index()).raw.map(x => x.content_hash), ['h1', 'h2']);
  });
});

test('index() creates the index from the header when the run has none yet', async () => {
  await withDir(async dir => {
    const store = openStore(dir, header);
    await store.index();
    assert.deepEqual(JSON.parse(await readFile(store.indexRef, 'utf8')), { ...header, raw: [], responses: [], failures: [] });
    const replay = openStore(path.join(dir, 'other'));
    assert.deepEqual(await replay.index(), { raw: [], responses: [], failures: [], renders: [], render_ledger: [], cwv: [] });
  });
});

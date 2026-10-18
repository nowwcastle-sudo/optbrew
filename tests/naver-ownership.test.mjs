import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openStore } from '../skills/optbrew/scripts/core/evidence-store.mjs';
import { naverOwnershipFollowUps } from '../skills/optbrew/scripts/core/naver-ownership.mjs';
import { tempDir } from './support/temp-dir.mjs';

const HOME = 'https://flower.test/';
const page = head => `<html lang="ko"><head><title>동네 꽃집</title>${head}</head><body><h1>동네 꽃집</h1></body></html>`;

/** The rows for a run whose stored start page is `html` (none stored when null), with `engines` and the owner exports of the evidence index. */
async function rowsFor(html, { engines = ['google', 'naver'], owner_exports = [], status = 200 } = {}) {
  const dir = await tempDir('optbrew-naver-ownership-');
  const store = openStore(dir);
  const artifacts = [];
  if (html !== null) {
    const { ref, sha256 } = await store.write('html', html);
    artifacts.push({ normalized_url: HOME, final_url: HOME, capability: 'raw_html', status, evidence_ref: ref, content_hash: sha256 });
  }
  const collection_ref = path.join(dir, 'collection.json');
  await writeFile(collection_ref, JSON.stringify({ artifacts }));
  return naverOwnershipFollowUps({ context: { target: HOME, protocol: { engines } }, index: { collection_ref, owner_exports }, store });
}

test('a Naver run whose start page has no verification tag and no Naver export read gets one remaining-work row', async () => {
  const rows = await rowsFor(page(''));
  assert.deepEqual(rows.map(row => [row.reason, row.message_key]), [['naver_ownership_unconfirmed', 'follow-up.naver-ownership']]);
  for (const field of ['problem', 'reason', 'required_input_or_authority', 'next_action', 'reobserve_when']) assert.equal(typeof rows[0][field], 'string', field);
  assert.match(rows[0].next_action, /naver-searchadvisor-export/, 'the row names the Search Advisor runbook');
  assert.equal((await rowsFor(page('<!-- <meta name="naver-site-verification" content="abc"> -->'))).length, 1, 'a commented-out tag is no tag');
  assert.equal((await rowsFor(page(''), { owner_exports: [{ kind: 'naver', status: 'unusable', reason: 'export_table_not_found' }] })).length, 1,
    'an unusable Naver export proves nothing');
});

test('no row when the tag is there, a Naver export was read, Naver is not a target, or the start page was not read', async () => {
  assert.deepEqual(await rowsFor(page('<meta name="naver-site-verification" content="0123abcd">')), []);
  assert.deepEqual(await rowsFor(page('<meta content="0123abcd" NAME=naver-site-verification>')), [], 'any attribute order and quoting');
  assert.deepEqual(await rowsFor(page(''), { owner_exports: [{ kind: 'naver', status: 'read', ref: 'evidence/naver.json' }] }), []);
  assert.equal((await rowsFor(page(''), { owner_exports: [{ kind: 'gsc', status: 'read', ref: 'evidence/gsc.json' }] })).length, 1,
    'a Search Console export says nothing about Naver');
  assert.deepEqual(await rowsFor(page(''), { engines: ['google'] }), []);
  assert.deepEqual(await rowsFor(null), []);
  assert.deepEqual(await rowsFor(page(''), { status: 503 }), []);
});

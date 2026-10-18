import { readFile } from 'node:fs/promises';
import { stripInert } from './html.mjs';

const NAVER = 'naver';
// The tag of Search Advisor's meta-tag ownership method. A site verified by an uploaded HTML file carries none, so its absence proves nothing.
const VERIFICATION_META = /<meta\b[^>]*\bname\s*=\s*["']?naver-site-verification\b/i;
const ROW = { problem: 'The start page has no naver-site-verification meta tag and no Naver Search Advisor export was read, so this run cannot tell whether the site is registered in Search Advisor',
  reason: 'naver_ownership_unconfirmed', required_input_or_authority: 'The Naver account that registered the site in Search Advisor',
  next_action: 'Check the site list in Search Advisor (steps 1 to 4 of the naver-searchadvisor-export runbook); a site verified by an uploaded HTML file needs nothing more',
  reobserve_when: 'on the next run that reads a Naver export or finds the meta tag', message_key: 'follow-up.naver-ownership', message_values: {} };

/**
 * The remaining-work row that asks the owner to confirm the site in Naver Search Advisor: Naver is a target engine, no Naver export was
 * read, and the collected start page has no live verification meta tag. Ownership is never scored, so the row changes no verdict.
 * A run whose start page was not read gets no row. `index` is the evidence index and `store` the evidence store that hashes each read.
 */
export async function naverOwnershipFollowUps({ context, index, store }) {
  if (!context.protocol.engines.includes(NAVER) || (index.owner_exports ?? []).some(entry => entry.kind === NAVER && entry.status === 'read')) return [];
  const { artifacts } = JSON.parse(await readFile(index.collection_ref, 'utf8'));
  const home = artifacts.find(artifact => artifact.normalized_url === context.target && artifact.capability === 'raw_html' && artifact.status === 200 && artifact.content_hash);
  if (!home) return [];
  const html = (await store.read(home.evidence_ref, home.content_hash)).toString('utf8');
  return VERIFICATION_META.test(stripInert(html)) ? [] : [ROW];
}

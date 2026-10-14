import { jsonLdBlocks, visibleText } from './html.mjs';

/** Cross-page entity fact extraction and comparison. Pure functions of the raw HTML of the selected pages. */
const FACT_TYPES = ['name', 'phone', 'year', 'address', 'shipping'];
const ORG_TYPES = /^(?:Organization|Corporation|LocalBusiness|Store|Restaurant|CafeOrCoffeeShop|OnlineStore|NGO|[A-Za-z]*Business)$/;
const squash = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function nodesOf(value, out = []) {
  if (Array.isArray(value)) value.forEach(item => nodesOf(item, out));
  else if (value && typeof value === 'object') {
    out.push(value);
    if (value['@graph']) nodesOf(value['@graph'], out);
  }
  return out;
}
const typesOf = node => [].concat(node['@type'] ?? []).map(String);
const addressText = address => typeof address === 'string' ? address : address && typeof address === 'object' ?
  [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode, address.addressCountry]
    .filter(x => typeof x === 'string').join(', ') : '';

function phoneKey(text) {
  const digits = text.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return /^\+?82/.test(text.trim()) && digits.startsWith('82') ? `0${digits.slice(2)}` : digits;
}

/** Facts on one page: visible text values and JSON-LD values, keyed by fact type. */
export function pageFacts(html) {
  const visible = Object.fromEntries(FACT_TYPES.map(type => [type, new Map()]));
  const linked = Object.fromEntries(FACT_TYPES.map(type => [type, new Map()]));
  const put = (bucket, type, raw, key) => { if (key) bucket[type].set(key, String(raw).trim()); };
  const text = visibleText(html);
  for (const match of text.matchAll(/(?:\+\d{1,3}[\s.-]?)?\(?\d{1,4}\)?(?:[\s.-]\d{2,4}){2,3}/g)) {
    if (/[\s.()+-]/.test(match[0])) put(visible, 'phone', match[0], phoneKey(match[0]));
  }
  for (const match of text.matchAll(/\b(?:founded|established|since|opened)\s+(?:in\s+)?((?:19|20)\d{2})\b/gi)) put(visible, 'year', match[1], match[1]);
  for (const match of text.matchAll(/((?:19|20)\d{2})\s*년\s*(?:에\s*)?(?:설립|창립|창업)/g)) put(visible, 'year', match[1], match[1]);
  for (const match of text.matchAll(/\bAddress\s*[:：]\s*([^\n]*?)(?=\.\s|\s*$|\n)/gim)) put(visible, 'address', match[1], squash(match[1]));
  for (const match of text.matchAll(/주소\s*[:：]\s*([^\n.]+)/g)) put(visible, 'address', match[1], squash(match[1]));
  for (const match of text.matchAll(/(?:free\s+shipping|shipping\s+is\s+free|ships?\s+free)[^.\n]*?\b(?:over|above|from|more\s+than|exceeding)\s+([\d,]+)\s*(KRW|won|원|USD)?/gi)) {
    put(visible, 'shipping', `${match[1]} ${match[2] ?? ''}`.trim(), `${match[1].replace(/,/g, '')}${(match[2] ?? '').toLowerCase()}`);
  }
  for (const match of text.matchAll(/(?:^|\n|[.!?] +)([A-Z][\w&'.-]*(?: +[A-Z][\w&'.-]*)+) +(?:is|are|was) +(?:a|an|the)\b/g)) put(visible, 'name', match[1], squash(match[1]));
  const orgs = [];
  for (const block of jsonLdBlocks(html)) {
    if (!block.ok) continue;
    for (const node of nodesOf(block.value)) {
      if (!typesOf(node).some(type => ORG_TYPES.test(type))) continue;
      const name = typeof node.name === 'string' ? node.name : '';
      const org = { name, sameAs: [].concat(node.sameAs ?? []).some(x => typeof x === 'string' && x.trim()) };
      if (name) put(linked, 'name', name, squash(name));
      if (typeof node.telephone === 'string') put(linked, 'phone', node.telephone, phoneKey(node.telephone));
      const address = addressText(node.address);
      if (address) put(linked, 'address', address, squash(address));
      const year = /\b((?:19|20)\d{2})\b/.exec(String(node.foundingDate ?? ''))?.[1];
      if (year) put(linked, 'year', year, year);
      orgs.push(org);
    }
  }
  return { visible, linked, orgs };
}

/**
 * Compare facts across the selected pages. A reference value needs at least two pages and a strict majority
 * of pages carrying that fact type; otherwise the type is insufficient and stays unknown.
 */
export function compareFacts(pages) {
  const references = {};
  const deviations = new Map(pages.map(page => [page.url, []]));
  for (const type of FACT_TYPES) {
    const counts = new Map();
    const carrying = pages.filter(page => page.facts.visible[type].size || page.facts.linked[type].size);
    for (const page of carrying) {
      const keys = new Set([...page.facts.visible[type].keys(), ...page.facts.linked[type].keys()]);
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (ranked.length && ranked[0][1] >= 2 && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) {
      const [modal, count] = ranked[0];
      const label = pages.flatMap(page => [...page.facts.visible[type].entries(), ...page.facts.linked[type].entries()]).find(([key]) => key === modal)[1];
      references[type] = { key: modal, label, pages: count };
      for (const page of carrying) {
        const keys = new Set([...page.facts.visible[type].keys(), ...page.facts.linked[type].keys()]);
        if (!keys.has(modal)) {
          const found = [...page.facts.visible[type].values(), ...page.facts.linked[type].values()].join(' / ');
          deviations.get(page.url).push(`${type} "${found}" differs from "${label}" on ${count} pages`);
        }
      }
    }
    for (const page of pages) {
      const v = [...page.facts.visible[type].keys()], l = [...page.facts.linked[type].keys()];
      if (v.length && l.length && !v.some(key => l.includes(key)) && !deviations.get(page.url).some(x => x.startsWith(`${type} `)))
        deviations.get(page.url).push(`${type} in JSON-LD "${[...page.facts.linked[type].values()].join(' / ')}" differs from visible "${[...page.facts.visible[type].values()].join(' / ')}"`);
    }
  }
  return { references, deviations };
}

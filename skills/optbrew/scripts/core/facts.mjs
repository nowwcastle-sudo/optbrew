import { jsonLdBlocks, stripComments, visibleText } from './html.mjs';

/**
 * Cross-page entity fact extraction and comparison, pure functions of the raw HTML of the selected pages.
 * Facts come only from Organization or LocalBusiness JSON-LD, tel: links and explicitly labelled contact fields.
 * Free prose, dates and numbers elsewhere on a page are never read as facts; when a comparison is not clear the
 * result is unknown, not a failure.
 */
const FACT_TYPES = ['name', 'phone', 'year', 'address'];
const ORG_TYPES = /^(?:Organization|Corporation|LocalBusiness|Store|Restaurant|CafeOrCoffeeShop|OnlineStore|NGO|[A-Za-z]*Business)$/;
const squash = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const BRANCH = /\b(?:branch)\b|지점|지사/i;

const ABBREVIATIONS = [[/\bstreet\b/g, 'st'], [/\broad\b/g, 'rd'], [/\bavenue\b/g, 'ave'], [/\bboulevard\b/g, 'blvd'],
  [/\bdrive\b/g, 'dr'], [/\blane\b/g, 'ln'], [/\bsuite\b/g, 'ste'], [/\bfloor\b/g, 'fl'], [/\bbuilding\b/g, 'bldg']];
/** Address key: lower case, abbreviations unified, postal codes and trailing country dropped, Korean 시/도 forms unified. */
export function addressKey(value) {
  let text = String(value).toLowerCase().replace(/[,;]+/g, ' ');
  text = text.replace(/\b(?:south korea|republic of korea|korea|kr|usa|us|united states|대한민국|한국)\b\s*$/u, '');
  text = text.replace(/\b\d{5}(?:-\d{4})?\b|\b\d{3}-\d{3}\b|\b\d{6}\b/g, ' ');
  for (const [pattern, replacement] of ABBREVIATIONS) text = text.replace(pattern, replacement);
  text = text.replace(/(특별자치시|특별자치도|특별시|광역시)/g, '').replace(/^\s*(\p{Script=Hangul}+?)(시|도)(?=\s|$)/u, '$1');
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}
/** Two address keys agree when one contains the other (a street address with or without city detail). */
const sameAddress = (a, b) => a === b || (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a)));

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
  const clean = String(text).replace(/\(0\)/g, '');
  const digits = clean.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return /^\s*\+?\s*82/.test(clean) && clean.trim().startsWith('+') && digits.startsWith('82') ? `0${digits.slice(2)}` : digits;
}
const PHONE = String.raw`\+?\d[\d\s().-]{6,18}\d`;

/** Facts on one page: visible labelled values and JSON-LD / tel: values, keyed by fact type. */
export function pageFacts(html) {
  const live = stripComments(html);
  const visible = Object.fromEntries(FACT_TYPES.map(type => [type, new Map()]));
  const linked = Object.fromEntries(FACT_TYPES.map(type => [type, new Map()]));
  const put = (bucket, type, raw, key) => { if (key) bucket[type].set(key, String(raw).trim()); };
  const text = visibleText(live);
  for (const match of text.matchAll(new RegExp(String.raw`\b(?:Phone|Tel(?:ephone)?|Mobile)\b\s*[:：]?\s*(${PHONE})|(?:전화(?:번호)?|연락처|대표번호)\s*[:：]?\s*(${PHONE})`, 'gi')))
    put(visible, 'phone', match[1] ?? match[2], phoneKey(match[1] ?? match[2]));
  for (const match of live.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    const value = decodeURIComponent(match[1]);
    put(linked, 'phone', value, phoneKey(value));
  }
  for (const match of text.matchAll(/\b(?:Founded|Established)\b\s*[:：]\s*((?:19|20)\d{2})\b|(?:설립(?:연도)?|창립(?:연도)?)\s*[:：]?\s*((?:19|20)\d{2})/gi))
    put(visible, 'year', match[1] ?? match[2], match[1] ?? match[2]);
  for (const match of text.matchAll(/\bAddress\b\s*[:：]\s*([^\n]+?)(?=\.\s|\.?\s*$|\n)/gim)) put(visible, 'address', match[1], addressKey(match[1]));
  for (const match of text.matchAll(/주소\s*[:：]\s*([^\n.]+)/g)) put(visible, 'address', match[1], addressKey(match[1]));
  const orgs = [];
  for (const block of jsonLdBlocks(live)) {
    if (!block.ok) continue;
    for (const node of nodesOf(block.value)) {
      if (!typesOf(node).some(type => ORG_TYPES.test(type))) continue;
      const name = typeof node.name === 'string' ? node.name : '';
      const org = { name, id: typeof node['@id'] === 'string' ? node['@id'] : null,
        sameAs: [].concat(node.sameAs ?? []).some(x => typeof x === 'string' && x.trim()),
        branch: Boolean(node.branchOf || node.parentOrganization || BRANCH.test(name)) };
      if (name) put(linked, 'name', name, squash(name));
      if (typeof node.telephone === 'string') put(linked, 'phone', node.telephone, phoneKey(node.telephone));
      const address = addressText(node.address);
      if (address) put(linked, 'address', address, addressKey(address));
      const year = /\b((?:19|20)\d{2})\b/.exec(String(node.foundingDate ?? ''))?.[1];
      if (year) put(linked, 'year', year, year);
      orgs.push(org);
    }
  }
  // A page that presents itself as a branch has its own address and phone; it is a different entity, so it is not compared.
  const heading = /<(?:title|h1)\b[^>]*>([\s\S]*?)<\/(?:title|h1)>/gi;
  const headings = [...live.matchAll(heading)].map(match => match[1]).join(' ');
  return { visible, linked, orgs, branch: BRANCH.test(headings) || orgs.some(org => org.branch) };
}

const keysOf = (page, type) => new Set([...page.facts.visible[type].keys(), ...page.facts.linked[type].keys()]);

/**
 * Compare facts across the selected pages. A reference value needs at least two pages and a unique top count;
 * otherwise the type is insufficient and stays unknown. Branch pages and entities with a different JSON-LD @id are skipped.
 */
export function compareFacts(allPages) {
  const ids = new Map();
  for (const page of allPages) for (const id of new Set(page.facts.orgs.map(org => org.id).filter(Boolean))) ids.set(id, (ids.get(id) ?? 0) + 1);
  const ranked = [...ids.entries()].sort((a, b) => b[1] - a[1]);
  const mainId = ranked.length && ranked[0][1] >= 2 && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
  const separate = page => page.facts.branch || (mainId && page.facts.orgs.some(org => org.id) && !page.facts.orgs.some(org => org.id === mainId));
  const pages = allPages.filter(page => !separate(page));
  const references = {};
  const deviations = new Map(allPages.map(page => [page.url, []]));
  for (const type of FACT_TYPES) {
    const counts = new Map();
    const carrying = pages.filter(page => keysOf(page, type).size);
    for (const page of carrying) for (const key of keysOf(page, type)) counts.set(key, (counts.get(key) ?? 0) + 1);
    if (type === 'address') {
      // Merge keys that agree under address matching so abbreviations and city detail do not split the count.
      const keys = [...counts.keys()];
      for (const key of keys) for (const other of keys) if (key !== other && counts.has(key) && counts.has(other) && sameAddress(key, other) && key.length >= other.length) {
        counts.set(other, counts.get(other) + counts.get(key)); counts.delete(key);
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (top.length && top[0][1] >= 2 && (top.length === 1 || top[0][1] > top[1][1])) {
      const [modal, count] = top[0];
      const agrees = key => type === 'address' ? sameAddress(key, modal) || [...counts.keys()].some(k => sameAddress(k, modal) && sameAddress(k, key)) : key === modal;
      const label = pages.flatMap(page => [...page.facts.visible[type].entries(), ...page.facts.linked[type].entries()]).find(([key]) => agrees(key))?.[1] ?? modal;
      references[type] = { key: modal, label, pages: count };
      for (const page of carrying) {
        if (![...keysOf(page, type)].some(agrees)) {
          const found = [...page.facts.visible[type].values(), ...page.facts.linked[type].values()].join(' / ');
          deviations.get(page.url).push(`${type} "${found}" differs from "${label}" on ${count} pages`);
        }
      }
    }
    for (const page of pages) {
      const v = [...page.facts.visible[type].keys()], l = [...page.facts.linked[type].keys()];
      const same = type === 'address' ? v.some(a => l.some(b => sameAddress(a, b))) : v.some(key => l.includes(key));
      if (v.length && l.length && !same && !deviations.get(page.url).some(x => x.startsWith(`${type} `)))
        deviations.get(page.url).push(`${type} in JSON-LD "${[...page.facts.linked[type].values()].join(' / ')}" differs from visible "${[...page.facts.visible[type].values()].join(' / ')}"`);
    }
  }
  return { references, deviations, separate: new Set(allPages.filter(separate).map(page => page.url)) };
}

import { decodeEntities, jsonLdBlocks, stripComments, stripInert, visibleText } from './html.mjs';
import { endpoints } from './config.mjs';
import { messageOf } from './messages.mjs';

/**
 * Cross-page entity fact extraction and comparison, pure functions of the raw HTML of the selected pages.
 * Facts come only from Organization or LocalBusiness JSON-LD, tel: links and explicitly labelled contact fields.
 * Free prose, dates and numbers elsewhere on a page are never read as facts; when a comparison is not clear the
 * result is unknown, not a failure.
 */
const FACT_TYPES = ['name', 'phone', 'year', 'address'];
/** The catalog keys of the two ways a page's fact can conflict; the check that states them lists them as its own. */
export const FACT_MESSAGE_KEYS = { differs: 'fact-consistency.differs', jsonld: 'fact-consistency.jsonld-differs' };
const ORG_TYPES = /^(?:Organization|Corporation|LocalBusiness|Store|Restaurant|CafeOrCoffeeShop|OnlineStore|NGO|[A-Za-z]*Business)$/;
const squash = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const BRANCH = /\b(?:branch)\b|지점|지사/i;
// URL path segments that list branches: /branch/, /branches/, /locations/, /stores/, /지점/.
const BRANCH_PATH = /^(?:branch|branches|locations|stores|지점)$/i;
/** A node that states a sub-organization: a branch or department of another entity, by its own link or by a branch word in its name. */
const isBranchNode = node => Boolean(node.branchOf || node.parentOrganization || BRANCH.test(typeof node.name === 'string' ? node.name : ''));
const branchPath = url => {
  try { return new URL(url, endpoints().relative_url_base).pathname.split('/').some(part => BRANCH_PATH.test(decodeURIComponent(part))); }
  catch { return false; }
};

const ABBREVIATIONS = [[/\bstreet\b/g, 'st'], [/\broad\b/g, 'rd'], [/\bavenue\b/g, 'ave'], [/\bboulevard\b/g, 'blvd'],
  [/\bdrive\b/g, 'dr'], [/\blane\b/g, 'ln'], [/\bsuite\b/g, 'ste'], [/\bfloor\b/g, 'fl'], [/\bbuilding\b/g, 'bldg']];
/**
 * Address key: normalized tokens joined by one space. Lower case, abbreviations unified, trailing country dropped, Korean
 * 시/도 forms unified. A postal code is dropped only in its own position (in parentheses or brackets, after a label, or as
 * the last token after the city); a five-digit street number such as "12345 Ocean Avenue" stays part of the address.
 */
export function addressKey(value) {
  let text = String(value).toLowerCase().replace(/[,;]+/g, ' ');
  text = text.replace(/\b(?:south korea|republic of korea|korea|kr|usa|us|united states|대한민국|한국)\b\s*$/u, '');
  text = text.replace(/[(\[]\s*\d{3}-?\d{2,3}(?:-\d{4})?\s*[)\]]/g, ' ');
  text = text.replace(/(?:우편번호|postal code|post code|zip code|zip)\s*[:：]?\s*\d[\d-]*/giu, ' ');
  text = text.replace(/(?<=\p{L}\s+(?:[a-z]{2}\s+)?)(?:\d{5}(?:-\d{4})?|\d{3}-\d{3}|\d{6})\s*$/u, ' ');
  for (const [pattern, replacement] of ABBREVIATIONS) text = text.replace(pattern, replacement);
  text = text.replace(/(특별자치시|특별자치도|특별시|광역시)/g, '').replace(/^\s*(\p{Script=Hangul}+?)(시|도)(?=\s|$)/u, '$1');
  return (text.match(/\p{L}+|\p{N}+/gu) ?? []).join(' ');
}
/**
 * Two address keys agree when they are equal or one is a run of whole tokens of the other (a street address with or
 * without city detail). Tokens are compared exactly, so "10 main st" never matches "110 main st".
 */
function sameAddress(a, b) {
  if (a === b) return true;
  // The same words in another order (an English and a Korean address order) are not a difference.
  if (a.split(' ').sort().join(' ') === b.split(' ').sort().join(' ')) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const shortTokens = short.split(' '), longTokens = long.split(' ');
  if (shortTokens.length < 2 || !shortTokens.some(token => /^\p{L}/u.test(token))) return false;
  for (let i = 0; i + shortTokens.length <= longTokens.length; i++)
    if (shortTokens.every((token, k) => token === longTokens[i + k])) return true;
  return false;
}

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
  [address.streetAddress, address.addressLocality, address.addressRegion]
    .filter(x => typeof x === 'string').join(', ') : '';

function phoneKey(text) {
  const clean = String(text).replace(/\(0\)/g, '');
  const digits = clean.replace(/\D/g, '');
  // Korean nationwide representative numbers (15xx, 16xx, 18xx plus four digits) have eight digits.
  if (/^1[568]\d{6}$/.test(digits)) return digits;
  if (digits.length < 9 || digits.length > 15) return null;
  return /^\s*\+?\s*82/.test(clean) && clean.trim().startsWith('+') && digits.startsWith('82') ? `0${digits.slice(2)}` : digits;
}

/**
 * Text for phone extraction: every tag, inline or not, ends the text before it, so a figure in the next element
 * (a table cell, a span, a list item) is never read as the rest of a number.
 */
const hardText = html => decodeEntities(stripInert(html).replace(/<[^>]+>/g, '\n')).replace(/[ \t\f\v\r ]+/g, ' ');
// An international or parenthesised number may use spaces between its groups; a plain national number only dashes and dots.
const LOOSE_PHONE = /^[+(]\s?[\d()]{1,6}(?:[-. ]?\(?\d{1,6}\)?){1,5}/;
const STRICT_PHONE = /^\+?\d{1,4}(?:[-.]\d{1,6}){1,4}/;
// In a label, a national number may use spaces only (02 555 0142, 010 1234 5678), and a nationwide representative number
// is 15xx, 16xx or 18xx plus four digits. Neither is read in prose.
const SPACED_NATIONAL_PHONE = /^0\d{1,2}(?: \d{3,4}){2}(?!\d)/;
const REPRESENTATIVE_PHONE = /^1[568]\d{2}[- ]\d{4}(?!\d)/;
/**
 * The number at the start of `rest`, ending at its own last digit group. A spaced number that is followed by more
 * digits or a bracketed digit is ambiguous, so only its dashed or dotted part is read, and a number longer than twelve
 * digits is not read at all.
 */
function readPhone(rest) {
  const usable = text => text && (phoneKey(text)?.length ?? 99) <= 13 ? text.trim() : null;
  const loose = LOOSE_PHONE.exec(rest)?.[0].trimEnd();
  if (loose && !/^[ \t]*[(\[]?\d/.test(rest.slice(loose.length)) && usable(loose)) return loose.trim();
  const strict = usable(STRICT_PHONE.exec(rest)?.[0]);
  if (strict) return strict;
  // Digits straight after a spaced number are ambiguous (02 555 0142 42 seats); a bracket after it is not (hours).
  for (const pattern of [SPACED_NATIONAL_PHONE, REPRESENTATIVE_PHONE]) {
    const match = pattern.exec(rest)?.[0];
    if (match && !/^[ \t]*\d/.test(rest.slice(match.length)) && usable(match)) return match.trim();
  }
  return null;
}

/** Facts on one page: visible labelled values and JSON-LD / tel: values, keyed by fact type. */
export function pageFacts(html) {
  const live = stripComments(html);
  const visible = Object.fromEntries(FACT_TYPES.map(type => [type, new Map()]));
  const linked = Object.fromEntries(FACT_TYPES.map(type => [type, new Map()]));
  // tel: links are their own evidence class: supporting evidence that never contradicts a page's labelled or JSON-LD phone.
  const tel = { phone: new Map() };
  const put = (bucket, type, raw, key) => { if (key) bucket[type].set(key, String(raw).trim()); };
  const text = visibleText(live);
  // The text after a label is read in a lookahead, so a label alone (a heading that says "phone") never consumes the next line.
  for (const match of hardText(live).matchAll(/\b(?:Phone|Tel(?:ephone)?|Mobile)\b(?=\s*[:：]?\s*([^\n]*))|(?:전화(?:번호)?|연락처|대표번호)(?=\s*[:：]?\s*([^\n]*))/gi)) {
    const number = readPhone(match[1] ?? match[2]);
    if (number) put(visible, 'phone', number, phoneKey(number));
  }
  for (const match of live.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    const value = decodeURIComponent(match[1]);
    put(tel, 'phone', value, phoneKey(value));
  }
  for (const match of text.matchAll(/\b(?:Founded|Established)\b\s*[:：]\s*((?:19|20)\d{2})\b|(?:설립(?:연도)?|창립(?:연도)?)\s*[:：]?\s*((?:19|20)\d{2})/gi))
    put(visible, 'year', match[1] ?? match[2], match[1] ?? match[2]);
  for (const match of text.matchAll(/\bAddress\b\s*[:：]\s*([^\n]+?)(?=\.\s|\.?\s*$|\n)/gim)) put(visible, 'address', match[1], addressKey(match[1]));
  for (const match of text.matchAll(/주소\s*[:：]\s*([^\n.]+)/g)) put(visible, 'address', match[1], addressKey(match[1]));
  const described = [];
  for (const block of jsonLdBlocks(live)) {
    if (!block.ok) continue;
    for (const node of nodesOf(block.value)) {
      if (!typesOf(node).some(type => ORG_TYPES.test(type))) continue;
      const name = typeof node.name === 'string' ? node.name : '';
      described.push({ node, org: { name, id: typeof node['@id'] === 'string' ? node['@id'] : null,
        sameAs: [].concat(node.sameAs ?? []).some(x => typeof x === 'string' && x.trim()),
        branch: isBranchNode(node) } });
    }
  }
  // A sub-organization (a branch, a department) states facts of its own, not the page's. When the page also carries a node that is
  // not a sub-organization, that node is the page's entity and only it speaks for the page; a page whose every node is a
  // sub-organization is a separate branch page.
  const speaking = described.some(item => !item.org.branch) ? described.filter(item => !item.org.branch) : described;
  const orgs = [];
  for (const { node, org } of speaking) {
    if (org.name) put(linked, 'name', org.name, squash(org.name));
    if (typeof node.telephone === 'string') put(linked, 'phone', node.telephone, phoneKey(node.telephone));
    const address = addressText(node.address);
    if (address) put(linked, 'address', address, addressKey(address));
    const year = /\b((?:19|20)\d{2})\b/.exec(String(node.foundingDate ?? ''))?.[1];
    if (year) put(linked, 'year', year, year);
    orgs.push(org);
  }
  // A branch word in the title or first heading is only a hint (titleBranch). A page is a separate entity when its
  // JSON-LD says so (branch), when its URL is a branch list, or when the hint comes with an address of its own.
  const heading = /<(?:title|h1)\b[^>]*>([\s\S]*?)<\/(?:title|h1)>/gi;
  const headings = [...live.matchAll(heading)].map(match => match[1]).join(' ');
  return { visible, linked, tel, orgs, branch: orgs.length > 0 && orgs.every(org => org.branch), titleBranch: BRANCH.test(headings) };
}

/**
 * Values compared across pages for one fact type: the labelled and JSON-LD values. A tel: link joins only when the page has
 * no labelled or JSON-LD phone, so a mobile inquiry link beside the page's landline never counts against it.
 */
function evidenceOf(page, type) {
  const found = new Map([...page.facts.visible[type], ...page.facts.linked[type]]);
  if (type === 'phone' && !found.size) for (const [key, raw] of page.facts.tel.phone) found.set(key, raw);
  return found;
}
const keysOf = (page, type) => new Set(evidenceOf(page, type).keys());

/**
 * Compare facts across the selected pages. A reference value needs at least two pages and a unique top count;
 * otherwise the type is insufficient and stays unknown. Branch pages and entities with a different JSON-LD @id are skipped.
 */
export function compareFacts(allPages) {
  const ids = new Map();
  for (const page of allPages) for (const id of new Set(page.facts.orgs.map(org => org.id).filter(Boolean))) ids.set(id, (ids.get(id) ?? 0) + 1);
  const ranked = [...ids.entries()].sort((a, b) => b[1] - a[1]);
  const mainId = ranked.length && ranked[0][1] >= 2 && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
  const structural = page => page.facts.branch || branchPath(page.url) ||
    (mainId && page.facts.orgs.some(org => org.id) && !page.facts.orgs.some(org => org.id === mainId));
  // The main entity's addresses come from the pages with neither structure nor a branch word in the title.
  const mainAddresses = [...new Set(allPages.filter(page => !structural(page) && !page.facts.titleBranch).flatMap(page => [...keysOf(page, 'address')]))];
  // A branch word in the title counts only with a labelled address that is not the main entity's.
  const ownAddress = page => { const own = keysOf(page, 'address'); return own.size > 0 && mainAddresses.length > 0 && ![...own].some(key => mainAddresses.some(main => sameAddress(key, main))); };
  const separate = page => structural(page) || (page.facts.titleBranch && ownAddress(page));
  const pages = allPages.filter(page => !separate(page));
  const references = {};
  const deviations = new Map(allPages.map(page => [page.url, []]));
  // What `deviations` says, in the form the report's Korean text fills: one entry for each text, in the same order.
  const deviation_messages = new Map(allPages.map(page => [page.url, []]));
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
      const label = pages.flatMap(page => [...evidenceOf(page, type).entries()]).find(([key]) => agrees(key))?.[1] ?? modal;
      references[type] = { key: modal, label, pages: count };
      for (const page of carrying) {
        if (![...keysOf(page, type)].some(agrees)) {
          const found = [...evidenceOf(page, type).values()].join(' / ');
          deviations.get(page.url).push(`${type} "${found}" differs from "${label}" on ${count} pages`);
          deviation_messages.get(page.url).push(messageOf(FACT_MESSAGE_KEYS.differs, { type, found, label, count }));
        }
      }
    }
    for (const page of pages) {
      const v = [...page.facts.visible[type].keys()], l = [...page.facts.linked[type].keys()];
      const same = type === 'address' ? v.some(a => l.some(b => sameAddress(a, b))) : v.some(key => l.includes(key));
      if (v.length && l.length && !same && !deviations.get(page.url).some(x => x.startsWith(`${type} `))) {
        const linked = [...page.facts.linked[type].values()].join(' / '), visible = [...page.facts.visible[type].values()].join(' / ');
        deviations.get(page.url).push(`${type} in JSON-LD "${linked}" differs from visible "${visible}"`);
        deviation_messages.get(page.url).push(messageOf(FACT_MESSAGE_KEYS.jsonld, { type, linked, visible }));
      }
    }
  }
  return { references, deviations, deviation_messages, separate: new Set(allPages.filter(separate).map(page => page.url)) };
}

/** Every object of a JSON-LD value at any depth: a publisher or organizer inside an Article is a node too. */
function deepNodes(value, out = []) {
  if (Array.isArray(value)) value.forEach(item => deepNodes(item, out));
  else if (value && typeof value === 'object') { out.push(value); Object.values(value).forEach(item => deepNodes(item, out)); }
  return out;
}

// A phone number with its separators is never longer than this, so a number is read from this many characters after its first digit.
const PHONE_SPAN = 32;
/** The phone keys of every number `text` shows, read with the same rules as a labelled number. */
function numbersIn(text) {
  const keys = new Set();
  for (const match of text.matchAll(/(?<!\d)[+(]?\d/g)) {
    const number = readPhone(text.slice(match.index, match.index + PHONE_SPAN));
    const key = number && phoneKey(number);
    if (key) keys.add(key);
  }
  return keys;
}
/** True when `tokens` (at least two, one of them a word) stand next to each other, in that order, among `words`. */
const hasRun = (words, tokens) => tokens.length > 1 && tokens.some(token => /^\p{L}/u.test(token)) &&
  words.some((_, i) => tokens.every((token, k) => words[i + k] === token));

/**
 * How the entity facts a page's JSON-LD states stand against the page's visible text. They come from the Organization and
 * LocalBusiness nodes at any depth, leaving out sub-organizations when the page also names another entity. A name, a phone number
 * or a street address is `matched` when the page shows it. It is `mismatched` only when the page labels a value of that type
 * (Phone:, Address:, 전화, 주소) and none of the labelled values agrees. A fact the page neither shows nor contradicts is in
 * neither list, because nothing about it could be evaluated; the name has no labelled field, so a name can only match.
 */
export function jsonLdTruth(html, facts = pageFacts(html)) {
  const live = stripComments(html);
  const nodes = [];
  for (const block of jsonLdBlocks(live)) if (block.ok) for (const node of deepNodes(block.value))
    if (typesOf(node).some(type => ORG_TYPES.test(type)) && (node.name || node.telephone || node.address)) nodes.push(node);
  const speaking = nodes.some(node => !isBranchNode(node)) ? nodes.filter(node => !isBranchNode(node)) : nodes;
  const text = visibleText(live);
  const squashed = squash(text);
  const numbers = new Set([...numbersIn(hardText(live)), ...facts.visible.phone.keys(), ...facts.tel.phone.keys()]);
  const words = addressKey(text).split(' ');
  const labelled = [...facts.visible.address.keys()];
  const found = new Map();
  const note = (list, type, jsonld, visible) => found.has(`${list}|${type}|${jsonld}`) || found.set(`${list}|${type}|${jsonld}`, { list, type, jsonld, ...(visible ? { visible } : {}) });
  for (const node of speaking) {
    if (typeof node.name === 'string' && squash(node.name).length > 1 && squashed.includes(squash(node.name))) note('matched', 'name', node.name);
    const key = typeof node.telephone === 'string' ? phoneKey(node.telephone) : null;
    if (key && numbers.has(key)) note('matched', 'phone', node.telephone);
    else if (key && facts.visible.phone.size) note('mismatched', 'phone', node.telephone, [...facts.visible.phone.values()].join(' / '));
    const street = typeof node.address === 'string' ? node.address : node.address?.streetAddress;
    const streetKey = typeof street === 'string' ? addressKey(street) : '';
    if (streetKey && (hasRun(words, streetKey.split(' ')) || labelled.some(other => sameAddress(other, streetKey)))) note('matched', 'address', street);
    else if (streetKey && labelled.length) note('mismatched', 'address', street, [...facts.visible.address.values()].join(' / '));
  }
  const listed = list => [...found.values()].filter(item => item.list === list).map(({ list: _, ...fact }) => fact);
  return { matched: listed('matched'), mismatched: listed('mismatched') };
}

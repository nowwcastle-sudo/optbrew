import { readFileSync } from 'node:fs';

const cache = new Map();

/** The one place that reads a config block: first call parses it, every call returns the same frozen object. */
const block = name => () => {
  if (!cache.has(name)) {
    const file = new URL(`../../references/${name}.json`, import.meta.url);
    cache.set(name, Object.freeze(JSON.parse(readFileSync(file, 'utf8'))));
  }
  return cache.get(name);
};

export const limits = block('limits');
export const versions = block('versions');
export const endpoints = block('endpoints');
export const chromePaths = block('chrome-paths');
export const harnessSignals = block('harness-signals');
export const messagesKo = block('messages.ko');

/** The request ceiling of one run: the start question's `max_urls` (default 50), never above the cap (200). */
export const requestLimit = scope => Math.min(scope?.max_urls ?? limits().max_urls_default, limits().max_urls_cap);

export const checkRegistry = block('check-registry');
/**
 * Whether a family matters only for pages meant to be indexed (`public_only` in `check-registry.json`, the one list): a page with
 * `public_indexing:false` has no unit of it, no verdict and no fix. Protocol, unit compilation and the derivation all read this.
 */
export const publicOnlyFamily = familyId => checkRegistry().families.find(family => family.family_id === familyId)?.public_only === true;
/** The judgment thresholds one family's check block reads from `check-registry.json`. */
export const thresholds = familyId => checkRegistry().families.find(family => family.family_id === familyId).thresholds;

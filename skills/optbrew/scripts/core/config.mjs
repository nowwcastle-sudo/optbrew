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

/** The request ceiling of one run: the start question's `max_urls` (default 50), never above the cap (200). */
export const requestLimit = scope => Math.min(scope?.max_urls ?? limits().max_urls_default, limits().max_urls_cap);

export const checkRegistry = block('check-registry');
/** The judgment thresholds one family's check block reads from `check-registry.json`. */
export const thresholds = familyId => checkRegistry().families.find(family => family.family_id === familyId).thresholds;

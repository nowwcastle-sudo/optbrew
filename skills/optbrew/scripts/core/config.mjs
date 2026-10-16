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

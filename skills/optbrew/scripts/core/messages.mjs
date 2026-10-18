import { messagesKo } from './config.mjs';

/** `{name}` takes the value as it is; `{name:table}` looks the value up as `table.<value>` in the catalog (a word the value stands for). */
const PLACEHOLDER = /\{(\w+)(?::([\w-]+))?\}/g;
const UNKNOWN_WORD = 'word.unknown';

/** `{ message_key, message_values }`: what a check records beside its English message so the report can say it in Korean. */
export const messageOf = (message_key, message_values = {}) => ({ message_key, message_values });

/**
 * The Korean sentence for a message key with its page-specific values filled in; `fallback` (the English text) when the key is
 * absent or has no entry. Values stay as they are: the renderer escapes them for its format. A missing value reads as the unknown word.
 */
export function koText(key, values = {}, fallback = null) {
  const catalog = messagesKo();
  const template = key ? catalog[key] : undefined;
  if (typeof template !== 'string') return fallback;
  return template.replace(PLACEHOLDER, (_, name, table) => {
    const value = values?.[name];
    if (value === undefined || value === null || value === '') return catalog[UNKNOWN_WORD];
    return table ? catalog[`${table}.${value}`] ?? String(value) : String(value);
  });
}

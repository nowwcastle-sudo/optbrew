// SessionStart hook of the Claude plugin. Claude Code keeps the plugin's `google_api_key` setting (userConfig, sensitive) in the
// system credential store and gives it only to hook processes, as CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY. The audit scripts run as
// shell commands and cannot see it, so this hook stores the value in the owner-only `~/.optbrew/plugin-key.json`, where only
// optbrew's own key reader looks. It never writes the value to CLAUDE_ENV_FILE: that file sets the environment of every later
// shell command of the session, so the key would reach any program run there, a site project's scripts included (daybreak
// csf_6c7324c30de94e12802a539b). With no setting it leaves the file alone: a Claude desktop app session does not receive the
// setting (measured 2026-10-18) and must not erase what a terminal session stored. `optbrew key remove google` removes it.
// It never prints the value. Its messages go to stderr and it exits 0: Claude Code adds a SessionStart hook's stdout to the
// session context but sends the stderr of a hook that exits 0 only to its debug log, so a line there never blocks the session.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyHome, writePluginKey } from '../optbrew/scripts/core/keys.mjs';

const NAME = 'CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY';
// A Google API key is letters, digits, `_` and `-`. Anything else is not stored.
const KEY_CHARS = /^[A-Za-z0-9_-]+$/;

/** The key to store, `null` when there is no setting, or `false` when the setting is not key-shaped. */
export function pluginKey(env = process.env) {
  const key = env[NAME]?.trim();
  if (!key) return null;
  return KEY_CHARS.test(key) ? key : false;
}

export async function main(env = process.env, stderr = process.stderr) {
  const key = pluginKey(env);
  if (key === false)
    stderr.write('optbrew: the google_api_key plugin setting has characters a Google API key does not have; it was not used\n');
  else if (key === null)
    stderr.write('optbrew: no google_api_key plugin setting reached this hook; the key file or OPTBREW_GOOGLE_API_KEY is used if set\n');
  else await writePluginKey({ home: keyHome(env), key });
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  // A failure to write is reported by its code only and never blocks the session.
  await main().catch(error => process.stderr.write(`optbrew: could not store the plugin key setting (${error.code ?? 'error'})\n`));
}

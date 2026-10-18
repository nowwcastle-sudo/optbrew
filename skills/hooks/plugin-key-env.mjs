// SessionStart hook of the Claude plugin. Claude Code keeps the plugin's `google_api_key` setting (userConfig, sensitive) in the
// system credential store and gives it only to hook processes, as CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY. The audit scripts run as
// shell commands, so this hook appends the value to CLAUDE_ENV_FILE, which Claude Code applies to every later shell command of the
// session. It writes nothing else and never prints the value.
import { appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY';
// A Google API key is letters, digits, `_` and `-`. Anything else is not written, so the line stays a plain assignment that
// Bash and PowerShell both read as written and no character of it can run as shell code.
const KEY_CHARS = /^[A-Za-z0-9_-]+$/;

/** The line to append, or null when there is no usable setting or no env file. */
export function envLine(env = process.env) {
  const key = env[NAME]?.trim();
  if (!key || !env.CLAUDE_ENV_FILE || !KEY_CHARS.test(key)) return null;
  return `export ${NAME}='${key}'\n`;
}

export function main(env = process.env, stderr = process.stderr) {
  const line = envLine(env);
  if (line) appendFileSync(env.CLAUDE_ENV_FILE, line);
  else if (env[NAME]?.trim() && env.CLAUDE_ENV_FILE)
    stderr.write('optbrew: the google_api_key plugin setting has characters a Google API key does not have; it was not used\n');
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) main();

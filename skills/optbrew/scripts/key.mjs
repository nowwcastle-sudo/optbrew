import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { googleKeyStatus, keyHome, removeGoogleKey, saveGoogleKey } from './core/keys.mjs';

const USAGE = 'usage: key.mjs <set google | status | remove google>';
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const DELETE = '\u007f';
const BACKSPACE = '\b';

/**
 * Read a secret from a terminal without echoing it: raw mode, characters are collected and never written back.
 * Enter submits; Ctrl-C, Ctrl-D on empty input, end of input and stream errors end the read without a value.
 */
function readHidden(stdin, stdout) {
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = settle => {
      stdin.off('data', onData); stdin.off('end', cancel); stdin.off('error', fail);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      settle();
    };
    const cancel = () => finish(() => reject(new Error('cancelled')));
    const fail = error => finish(() => reject(error));
    const onData = chunk => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') return finish(() => resolve(value));
        if (char === CTRL_C || (char === CTRL_D && !value)) return cancel();
        if (char === DELETE || char === BACKSPACE) value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdout.write('Google API key (input is hidden): ');
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', cancel);
    stdin.on('error', fail);
    stdin.resume();
  });
}

/** Read one line from a pipe or file. */
function readLine(stdin) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const finish = () => {
      stdin.off('data', onData); stdin.off('end', finish); stdin.off('error', reject);
      stdin.pause();
      resolve(buffer.split(/\r?\n/)[0]);
    };
    const onData = chunk => { buffer += chunk; if (buffer.includes('\n')) finish(); };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', finish);
    stdin.on('error', reject);
    stdin.resume();
  });
}

/** Return a process code: 0 success, 2 usage error, 1 failure. Messages never contain the key value. */
export async function runKeyCommand(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, home = keyHome(env) } = {}) {
  const [action, provider, ...extra] = argv;
  const valid = extra.length === 0 && ((['set', 'remove'].includes(action) && provider === 'google') || (action === 'status' && provider === undefined));
  if (!valid) { stderr.write(`${USAGE}\n`); return 2; }
  try {
    if (action === 'status') {
      stdout.write(`${JSON.stringify(googleKeyStatus({ env, home }))}\n`);
    } else if (action === 'remove') {
      await removeGoogleKey({ home });
      stdout.write('google key removed\n');
      if (googleKeyStatus({ env, home }).google.present) stderr.write('OPTBREW_GOOGLE_API_KEY is still set in the environment\n');
    } else {
      const key = (stdin.isTTY ? await readHidden(stdin, stdout) : await readLine(stdin)).trim();
      if (!key) { stderr.write('no key entered; nothing saved\n'); return 2; }
      await saveGoogleKey({ home, key });
      stdout.write('google key saved\n');
    }
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  runKeyCommand(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

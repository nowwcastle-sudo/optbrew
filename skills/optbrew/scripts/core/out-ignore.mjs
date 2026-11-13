import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Whether the result folder is not there yet: only a folder a run creates ignores itself, never one the user made. */
export const outputIsNew = out => stat(out).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });

/**
 * Keeps a result folder out of the site project's version control: its raw responses and judgments are not part of the site.
 * A `.gitignore` that is already there is not touched.
 */
export const ignoreOutput = out => writeFile(path.join(out, '.gitignore'), '*\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });

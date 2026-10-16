import { endpoints, limits } from './config.mjs';

const NOT_FOUND = /chrome ux report data not found/i;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
// CLS counts shifts in session windows: a gap of 1 s ends a window and a window ends after 5 s (the web.dev definition).
const SESSION_GAP_MS = 1000;
const SESSION_CAP_MS = 5000;

/** `text` with the key removed, in the form it was sent and in its URL-encoded form. */
const without = (text, key) => key ? [key, encodeURIComponent(key)].reduce((rest, secret) => rest.split(secret).join(''), String(text)) : String(text);

/** One request. A network failure is a result too (`status: null`), so a dead network leaves evidence instead of an exception. */
async function ask(fetchFn, url, init, key) {
  try {
    const response = await fetchFn(url, init);
    return { status: response.status, text: without(await response.text(), key) };
  } catch (error) {
    return { status: null, error: without(error?.message ?? error, key) };
  }
}

/** Store what the source answered, cleaned of the key, and list it in the index's `cwv` section. */
async function keep(store, source, origin, result) {
  let body = result.text;
  try { body = JSON.parse(result.text); } catch { /* a body that is not JSON is kept as text */ }
  const record = { source, origin, status: result.status, ...(result.error === undefined ? { body } : { error: result.error }) };
  const { ref, sha256 } = await store.write('cwv', `${JSON.stringify(record, null, 2)}\n`);
  await store.append('cwv', { source, evidence_ref: ref, sha256 });
}

/**
 * Field Core Web Vitals of one origin, stored as evidence and never judged here. With the user's own Google key the
 * Chrome UX Report is asked first and PageSpeed Insights only when CrUX has no data for the origin; without a key
 * PageSpeed Insights is tried `psi_attempts` times, keyless. The key goes into the request only: no endpoint holds it
 * and every stored body or error has it removed.
 */
export async function collectCwv({ origin, key = null, fetchFn = fetch, store }) {
  if (key) {
    const crux = await ask(fetchFn, `${endpoints().crux}?key=${encodeURIComponent(key)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin }) }, key);
    await keep(store, 'crux', origin, crux);
    if (!(crux.status === HTTP_NOT_FOUND && NOT_FOUND.test(crux.text))) return;
  }
  for (let attempt = 0; attempt < limits().psi_attempts; attempt++) {
    const url = new URL(endpoints().psi);
    url.searchParams.set('url', `${origin}/`);
    if (key) url.searchParams.set('key', key);
    const psi = await ask(fetchFn, url.href, { method: 'GET' }, key);
    await keep(store, 'psi', origin, psi);
    if (psi.status === HTTP_OK) return;
  }
}

/** Evaluated in the page: the buffered LCP and layout-shift entries, as plain data. */
const READ_LAB = `new Promise(resolve => {
  const lcp = [], shifts = [];
  const addLcp = entry => lcp.push(entry.startTime);
  const addShift = entry => shifts.push({ startTime: entry.startTime, value: entry.value, hadRecentInput: entry.hadRecentInput });
  const watch = (type, add) => {
    const observer = new PerformanceObserver(list => list.getEntries().forEach(add));
    observer.observe({ type, buffered: true });
    return () => observer.takeRecords().forEach(add);
  };
  const drain = [watch('largest-contentful-paint', addLcp), watch('layout-shift', addShift)];
  // Buffered entries arrive in a task of their own; one more task later they have all been delivered.
  setTimeout(() => { drain.forEach(run => run()); resolve(JSON.stringify({ lcp, shifts })); }, 0);
})`;

/** The largest sum of shift values over session windows; shifts right after user input do not count. */
function layoutShift(shifts) {
  let best = 0, sum = 0, windowStart = null, last = null;
  for (const { startTime, value } of shifts.filter(shift => !shift.hadRecentInput).sort((a, b) => a.startTime - b.startTime)) {
    if (windowStart === null || startTime - last > SESSION_GAP_MS || startTime - windowStart > SESSION_CAP_MS) { sum = 0; windowStart = startTime; }
    sum += value;
    last = startTime;
    best = Math.max(best, sum);
  }
  return best;
}

/**
 * Lab Core Web Vitals of a page a `scopedPage` has already loaded, read with PerformanceObserver. `lcp` is the last
 * largest-contentful-paint entry in ms (null when the page painted none), `cls` the layout shift score. The caller keeps
 * the result in `RunState.lab_cwv`: it is shown as reference only and never becomes an observation.
 */
export async function labCwv({ page }) {
  const { lcp, shifts } = JSON.parse(await page.evaluate(READ_LAB));
  return { lcp: lcp.length ? lcp.at(-1) : null, cls: layoutShift(shifts) };
}

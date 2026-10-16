import { harnessSignals } from './config.mjs';
import { urlTarget } from './scope.mjs';

const OTHER = 'other';

/**
 * Which `harness:` values in the runbook front matter apply to each probe harness. This is the one place the two
 * vocabularies meet: `local` runbooks serve both local hosts, `any` serves everyone, and an unknown host (which may be a
 * local one that sets no signal, such as Codex with full network) gets `any` and `local` (R43).
 */
const RUNBOOK_HARNESSES = {
  'claude-code': ['local', 'any'],
  codex: ['local', 'codex', 'any'],
  'claude-code-cloud': ['claude-code-cloud', 'any'],
  [OTHER]: ['any', 'local'],
};

/** The runbook that saves a Google key for each probe harness (beside RUNBOOK_HARNESSES, the other place the two vocabularies meet). */
const KEY_SET_RUNBOOKS = { 'claude-code': 'key-set-local', codex: 'key-set-codex', 'claude-code-cloud': 'key-set-claude-cloud', [OTHER]: 'key-set-local' };

export function keySetRunbook(harness) {
  const id = KEY_SET_RUNBOOKS[harness];
  if (!id) throw new Error(`unknown harness: ${harness}`);
  return id;
}

export function runbookHarnesses(harness) {
  const values = RUNBOOK_HARNESSES[harness];
  if (!values) throw new Error(`unknown harness: ${harness}`);
  return values;
}

const isSet = (env, names) => names.some(name => typeof env?.[name] === 'string' && env[name] !== '');

/** The first harness in `harness-signals.json` (file order) with a signal variable set; no signal means `other`. */
const detectHarness = env => Object.keys(harnessSignals()).find(harness => isSet(env, harnessSignals()[harness].env_any)) ?? OTHER;

/**
 * Why the site cannot be reached, from the harness. A host that cut its own network (Codex sandbox with the
 * network-disabled variable, Claude Code cloud network level) is told apart from a site that is simply down.
 */
function blockReason(harness, env) {
  if (harness === 'claude-code-cloud') return 'cloud_network_level';
  if (harness === 'codex' && isSet(env, harnessSignals().codex.network_blocked_env_any ?? [])) return 'codex_sandbox';
  return 'site_down';
}

const proxyFailure = error => typeof error?.code === 'string' && error.code.startsWith('proxy_');
/** The request was refused by the scope rules (another site, a private address): that says nothing about the site being down. */
const scopeRejection = error => ['scope_rejected', 'redirect_outside_scope'].includes(error?.code);

/**
 * The start probe: harness, how the site is reached, Chrome, key presence and source tools. Everything is injected so a
 * test needs no network or Chrome. `selectTransport` takes `{ env, probeHost }`. `reach(selected)`, when given, does a
 * real first request; a proxy that refuses it is a network block, a scope rejection is no block at all, any other
 * failure is the site. A `selectTransport` error other than a DNS failure is thrown on purpose: the CLI then fails
 * with exit 2. The proxy is recorded as host and port only, and the key is recorded as present or absent, never by value.
 */
export async function probeEnvironment({ env = process.env, url, selectTransport, findChrome, readGoogleKey, home, sourceTools = [], reach = null }) {
  const harness = detectHarness(env);
  let selected = null;
  let failure = null;
  try { selected = await selectTransport({ env, probeHost: urlTarget(new URL(url)).host }); }
  catch (error) { if (error?.code !== 'dns_unresolvable') throw error; failure = error; }
  if (selected && reach) {
    try { await reach(selected); } catch (error) { if (!scopeRejection(error)) failure = error; }
  }
  let block = null;
  if (failure) block = !selected || proxyFailure(failure) ? blockReason(harness, env) : 'site_down';
  const chrome = await findChrome({ env });
  const found = Boolean(chrome?.path);
  return {
    harness,
    transport: selected ? (selected.proxy ? 'proxy' : 'direct') : null,
    address_vetting: selected?.address_vetting ?? null,
    proxy: selected?.proxy ? { host: selected.proxy.host, port: selected.proxy.port } : null,
    block_reason: block,
    chrome: { found, kind: found ? chrome.kind : null, reason: found ? null : chrome?.reason ?? 'chrome_not_found' },
    google_key: (await readGoogleKey({ env, home })) !== null,
    source_tools: [...new Set(sourceTools.map(tool => tool.trim()).filter(Boolean))],
    sitemap_pages: null,
  };
}

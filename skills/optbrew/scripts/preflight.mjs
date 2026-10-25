#!/usr/bin/env node
import { lookup } from 'node:dns/promises';
import { realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchScoped, links } from './core/collector.mjs';
import { findChrome as realFindChrome } from './core/chrome.mjs';
import { limits } from './core/config.mjs';
import { openStore } from './core/evidence-store.mjs';
import { pageBudget, readPreflight, selectPages } from './core/page-select.mjs';
import { pageFacts } from './core/facts.mjs';
import { decodeEntities } from './core/html.mjs';
import { readGoogleKey as realReadGoogleKey } from './core/keys.mjs';
import { probeEnvironment, runbookHarnesses } from './core/probe.mjs';
import { startRunbooks } from './core/runbooks.mjs';
import { assertUrlInScope, unbracket } from './core/scope.mjs';
import { selectTransport as realSelectTransport } from './core/transport.mjs';

const USAGE = 'usage: node skills/optbrew/scripts/preflight.mjs --url <URL> --out <dir> [--source-tools a,b] [--skill-root <path>] [--level beginner|brief]';
/** The guidance level is asked in the same start questions this file feeds, so a blocking runbook is shown at the beginner level. */
const START_LEVEL = 'beginner';
const SITEMAP_PATH = '/sitemap.xml';
const defaultSkillRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const locCount = text => (text.match(/<loc>/gi) ?? []).length;
const locs = text => [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(match => decodeEntities(match[1]));
const inner = (html, pattern) => { const found = pattern.exec(html)?.[1]; return found === undefined ? null : decodeEntities(found.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || null; };

/** The origins of the page's own site: itself, its apex/www twin and its http/https twin. A named port or an IP literal has no twin. */
function sameSiteOrigins(start) {
  if (start.port || isIP(unbracket(start.hostname))) return [start.origin];
  const twin = start.hostname.startsWith('www.') ? start.hostname.slice(4) : `www.${start.hostname}`;
  return ['http:', 'https:'].flatMap(protocol => [start.hostname, twin].map(host => `${protocol}//${host}`));
}

/** What an agent needs to propose the question list: where the page is, its title, description and first heading. */
function questionInput(artifact, html) {
  const tag = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i.exec(html)?.[0];
  const content = tag && /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  return { url: artifact.final_url, title: inner(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i), h1: inner(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i),
    description: content ? decodeEntities(content[1] ?? content[2]).trim() || null : null };
}

/** Facts the pages state about the business, one candidate per fact type and normalized value; the first page that states it is the source. */
function factCandidates(pages) {
  const seen = new Set();
  const candidates = [];
  for (const { artifact, html } of pages) {
    const facts = pageFacts(html);
    for (const bucket of [facts.visible, facts.linked]) for (const [type, values] of Object.entries(bucket)) for (const [key, value] of values) {
      if (seen.has(`${type}|${key}`)) continue;
      seen.add(`${type}|${key}`);
      candidates.push({ key: type, value, source_url: artifact.final_url });
    }
  }
  return candidates;
}

/**
 * The unscored read before the start questions (C17): the probe, the sitemap size, a few pages for question and fact
 * candidates, and the start runbooks. At most `preflight_pages` requests are sent in all, redirect hops and the sitemap
 * included. Evidence goes in its own store under `<out>/preflight/evidence`, never in the audit's evidence index, and
 * nothing here enters the protocol or a score.
 */
export async function preflight({ url, out, sourceTools = [], skillRoot = defaultSkillRoot, level = START_LEVEL, env = process.env, home,
  resolve = host => lookup(host, { all: true, verbatim: true }), selectTransport = realSelectTransport, findChrome = realFindChrome, readGoogleKey = realReadGoogleKey }) {
  const start = new URL(url);
  if (!['http:', 'https:'].includes(start.protocol)) throw new Error('url must be http or https');
  // The first request may end on the same site under another name (apex and www, http and https); once it lands, scope narrows to where it landed.
  const scopeOf = origins => ({ allowed: origins.map(origin => ({ origin, path_prefix: '/' })) });
  let scope = scopeOf(sameSiteOrigins(start));
  const dir = path.join(out, 'preflight');
  const evidenceDir = path.join(dir, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  const store = openStore(evidenceDir);
  const budget = limits().preflight_pages;
  let used = 0;
  const reserveRequest = () => { if (used >= budget) return false; used++; return true; };
  let route = null;

  // Where the first request was sent when that was another site (it is recorded for the run, which stops on it).
  let leftTo = null;
  const get = async href => {
    try {
      const artifact = await fetchScoped(href, { context: { scope }, ...route, reserveRequest });
      const { ref, sha256 } = await store.write(artifact.capability === 'raw_html' ? 'html' : 'bin', artifact.body);
      await store.append('raw', { normalized_url: artifact.normalized_url, evidence_ref: ref, content_hash: sha256 });
      return artifact;
    } catch (error) {
      await store.append('failures', { normalized_url: href, error: error.code ?? 'fetch_failed' });
      if (href === start.href && error.redirect_to) leftTo = error.redirect_to;
      throw error;
    }
  };
  const tryGet = href => get(href).catch(() => null);

  let first = null;
  const reach = async selected => {
    route = { transport: selected.transport, resolve: selected.resolve, addressVetting: selected.address_vetting };
    first = await get(start.href);
    scope = scopeOf([new URL(first.final_url).origin]);
  };
  const probe = await probeEnvironment({ env, url, selectTransport: input => selectTransport({ ...input, resolve }), findChrome, readGoogleKey, home, sourceTools, reach });

  const pages = [];
  const addPage = artifact => { if (artifact?.status === 200 && artifact.capability === 'raw_html') pages.push({ artifact, html: artifact.body.toString('utf8') }); };
  let sitemapPages = null;
  let sitemapBasis = null;
  // Where /sitemap.xml ended up: WordPress and Yoast send it on to an index file under another name.
  let sitemapFinal = null;
  // The sitemap files the audit will declare: /sitemap.xml, where it ended up, and the child files of an index that were read.
  const sitemapFiles = new Set();
  if (first && !probe.block_reason) {
    addPage(first);
    const sitemapUrl = new URL(SITEMAP_PATH, new URL(first.final_url).origin).href;
    const sitemap = await tryGet(sitemapUrl);
    sitemapFinal = sitemap?.status === 200 ? sitemap.final_url : null;
    sitemapFiles.add(sitemapUrl);
    if (sitemapFinal) sitemapFiles.add(sitemapFinal);
    if (sitemap?.status === 200) {
      const text = sitemap.body.toString('utf8');
      if (/<sitemapindex/i.test(text)) {
        const children = locs(text);
        let read = 0;
        let counted = 0;
        for (const child of children) {
          if (used >= budget) break;
          const artifact = await tryGet(child);
          if (artifact?.status === 200) { read += locCount(artifact.body.toString('utf8')); counted++; sitemapPages = read; sitemapFiles.add(child); }
        }
        sitemapBasis = counted === children.length ? 'exact' : 'lower_bound';
      } else { sitemapPages = locCount(text); sitemapBasis = 'exact'; }
    }
    const seen = new Set([start.href, first.normalized_url, sitemapUrl]);
    for (const href of pages.length ? links(pages[0].html, first.final_url) : []) {
      if (used >= budget) break;
      let normalized;
      try { normalized = assertUrlInScope(href, scope).href; } catch { continue; }
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      addPage(await tryGet(normalized));
    }
  }

  const startJson = {
    // Where the first request landed (after apex/www and http/https redirects): the address the audit should start from.
    requested_url: start.href,
    final_url: first?.final_url ?? null,
    redirected_to: leftTo,
    sitemap_final_url: sitemapFinal,
    probe: { ...probe, sitemap_pages: sitemapPages },
    sitemap_pages: sitemapPages,
    sitemap_pages_basis: sitemapBasis,
    sitemap_declared: sitemapFiles.size,
    max_urls_raise: null,
    question_candidates_input: pages.map(({ artifact, html }) => questionInput(artifact, html)),
    fact_candidates: factCandidates(pages),
    start_runbooks: startRunbooks(probe, { level, skillRoot, harnesses: runbookHarnesses(probe.harness) }),
  };
  const startPath = path.join(dir, 'start.json');
  await writeFile(startPath, `${JSON.stringify(startJson, null, 2)}\n`);
  // The raise is read back the way the run will read this folder, so both count the same pages and sitemap files.
  if (startJson.final_url) {
    startJson.max_urls_raise = await raisedLimit(out, startJson);
    await writeFile(startPath, `${JSON.stringify(startJson, null, 2)}\n`);
  }
  return { startJson, startPath };
}

/**
 * The `max_urls` a "raise" answer writes, so the agent does not do the arithmetic. It reads this preflight folder as the run does
 * (`readPreflight`), declares the same robots and sitemap files, and selects pages with the run's `selectPages` and `pageBudget`,
 * counting the fact-candidate pages as confirmed (they are chosen before sitemap pages). `null` when the default limit already
 * holds every sitemap page, so the sample question is not asked; else the smallest limit that holds them all, never above the cap.
 * A sitemap count that is only a lower bound gets the cap.
 */
export async function raisedLimit(out, startJson) {
  const { max_urls_default: base, max_urls_cap: cap, preflight_pages: readLimit } = limits();
  if (startJson.sitemap_pages_basis === 'lower_bound') return cap;
  const start = new URL(startJson.final_url);
  const preflightRead = await readPreflight(out, start.href);
  const scope = { allowed: [{ origin: start.origin, path_prefix: '/' }] };
  const inScope = href => { try { return assertUrlInScope(href, scope).href; } catch { return null; } };
  const known = new Set(['/robots.txt', '/sitemap.xml'].map(pathname => new URL(pathname, start.origin).href));
  let auxiliary = known.size;
  for (const href of [...new Set(preflightRead.sitemapFiles)].slice(0, readLimit)) {
    const normalized = inScope(href);
    if (normalized && !known.has(normalized)) { known.add(normalized); auxiliary++; }
  }
  const factUrls = [...new Set(startJson.fact_candidates.map(fact => fact.source_url))];
  const sitemapPages = budget => selectPages({ home: inScope(start.href), factUrls, preflight: preflightRead, scope, budget, auxiliary: known }).sources.sitemap_pages;
  const all = sitemapPages(Infinity);
  const fits = limit => sitemapPages(pageBudget(limit, auxiliary)) >= all;
  if (fits(base)) return null;
  for (let limit = base + 1; limit < cap; limit++) if (fits(limit)) return limit;
  return cap;
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
    const url = option('--url');
    const out = option('--out');
    if (!url || !out || args.length % 2 || args.some((arg, i) => i % 2 === 0 && !['--url', '--out', '--source-tools', '--skill-root', '--level'].includes(arg))) throw new Error(USAGE);
    const { startJson, startPath } = await preflight({ url, out: path.resolve(out), sourceTools: (option('--source-tools') ?? '').split(',').filter(Boolean),
      ...(option('--skill-root') ? { skillRoot: option('--skill-root') } : {}), ...(option('--level') ? { level: option('--level') } : {}) });
    process.stdout.write(`${JSON.stringify({ start_json: startPath, block_reason: startJson.probe.block_reason })}\n`);
  } catch (error) { process.stderr.write(`preflight failed: ${error.message}\n`); process.exitCode = 2; }
}

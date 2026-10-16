import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAudit } from '../../skills/optbrew/scripts/audit.mjs';

const siteRoot = new URL('../fixtures/sites/', import.meta.url);
const template = new URL('../fixtures/scoring/before.json', import.meta.url);
const VERSION_FIELDS = ['schema_version', 'evaluation_version', 'protocol_version'];

/** Copy of the observations without version fields, so a version bump never breaks the golden comparison. */
export function withoutVersions(observations) {
  return observations.map(o => Object.fromEntries(Object.entries(o).filter(([k]) => !VERSION_FIELDS.includes(k))));
}

/** Strips what varies per run: the random port, the temp directory, and the observation_id hashed from the port. */
function stable(o, port, root) {
  const { observation_id: _hash, ...rest } = o;
  const clean = v => typeof v === 'string'
    ? v.replaceAll(`127.0.0.1:${port}`, '127.0.0.1:PORT').replaceAll(root, '<out>').replaceAll(path.sep, '/') : v;
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, clean(v)]));
}

/** Audits each fixture site over a local HTTP server and returns the observations, tagged by site. */
export async function goldenObservations() {
  const out = [];
  for (const site of ['before', 'after']) {
    const body = await readFile(new URL(`index.${site}.html`, siteRoot));
    const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = await mkdtemp(path.join(os.tmpdir(), 'optbrew-golden-'));
    try {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/`;
      const context = JSON.parse(await readFile(template, 'utf8')).run_context;
      context.run_id = `golden-${site}`;
      context.target = url;
      context.environment = 'local';
      context.scope = { allowed: [{ origin: `http://127.0.0.1:${port}`, path_prefix: '/' }], local_targets: [{ host: '127.0.0.1', port }] };
      context.evidence_ref = 'context.json';
      context.protocol.page_types = [{ id: 'primary', urls: [{ original: url, normalized: url }] }];
      context.protocol.engines = ['google'];
      for (const family of context.protocol.families)
        if (family.applicability_decision) family.applicability_decision.evidence_ref = 'intake.json';
      const result = await runAudit({ context, modules: ['naver-searchadvisor'], outputDir: root });
      for (const o of result.observations) out.push(stable({ ...o, site }, port, root));
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  }
  return out;
}

import https from 'node:https';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { reserveCost, settleCost } from '../core/cost-ledger.mjs';

const ENDPOINT = new URL('https://api.anthropic.com/v1/messages');
const VERSION = '2023-06-01';

async function nodeTransport({ headers, body, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const req = https.request(ENDPOINT, { method: 'POST', headers, signal }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 5242880) { req.destroy(new Error('provider response too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('provider timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function observation(request, error, extra = {}) {
  return { provider: 'anthropic', surface: 'messages_api', model: request?.model ?? null,
    search_enabled: Array.isArray(request?.tools) && request.tools.some(x => /^web_search_/.test(x.type ?? '')),
    request_id: null, response_ref: null, usage: null, valid: false, error, evidence_ref: null, ...extra };
}

function actualUsage(bounds, usage) {
  if (!usage || typeof usage !== 'object') return null;
  const values = bounds.map(bound => {
    let amount;
    if (bound.unit === 'tokens') amount = (usage.input_tokens ?? NaN) + (usage.output_tokens ?? NaN);
    if (bound.unit === 'search_calls') amount = usage.server_tool_use?.web_search_requests;
    return Number.isSafeInteger(amount) && amount >= 0 && amount <= bound.amount ? { ...bound, amount } : null;
  });
  return values.every(Boolean) ? values : null;
}

/** Optional paid call; every attempt has a reservation and unknown billing keeps its cap. */
export async function requestAnthropic({ context, request, env = process.env, transport = nodeTransport, ledgerPath }) {
  const decision = context?.cost_decision;
  const upperBounds = decision?.providers?.anthropic?.upper_bounds;
  if (!decision?.approval_ref || !Array.isArray(upperBounds) || !upperBounds.length || !ledgerPath)
    return observation(request, 'cost_decision_required');
  if (!env?.ANTHROPIC_API_KEY) return observation(request, 'api_key_missing');
  if (!request || typeof request.model !== 'string' || !request.model || !Number.isInteger(request.max_tokens) || request.max_tokens < 1 ||
      !Array.isArray(request.messages) || !request.messages.length)
    return observation(request, 'invalid_request');
  const body = JSON.stringify(request);
  for (let attempt = 0; attempt < 2; attempt++) {
    let reservation;
    try { reservation = await reserveCost(ledgerPath, { provider: 'anthropic', upperBounds, approvalRef: decision.approval_ref, runId: context.run_id }); }
    catch { return observation(request, 'cost_reservation_failed'); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await Promise.race([
        transport({ url: ENDPOINT, headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': VERSION }, body, timeoutMs: 20000, signal: controller.signal }),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
      ]);
    } catch {
      await settleCost(ledgerPath, reservation.reservation_id, 'unknown');
      return observation(request, 'transport_or_timeout_unknown_billing');
    } finally { clearTimeout(timer); }
    let parsed;
    try { parsed = JSON.parse(Buffer.isBuffer(response.body) ? response.body.toString('utf8') : response.body); }
    catch { await settleCost(ledgerPath, reservation.reservation_id, 'unknown'); return observation(request, 'malformed_provider_json_unknown_billing'); }
    const actual = actualUsage(upperBounds, parsed?.usage);
    await settleCost(ledgerPath, reservation.reservation_id, actual ?? 'unknown');
    if (response.status >= 200 && response.status < 300 && parsed?.type === 'message') {
      const safeBody = JSON.stringify(parsed).replaceAll(env.ANTHROPIC_API_KEY, '[REDACTED]');
      const evidenceDir = path.join(path.dirname(ledgerPath), 'evidence', 'provider');
      const evidenceRef = path.join(evidenceDir, `anthropic-${createHash('sha256').update(safeBody).digest('hex')}.json`);
      try {
        await mkdir(evidenceDir, { recursive: true });
        try { await writeFile(evidenceRef, `${safeBody}\n`, { flag: 'wx' }); }
        catch (error) {
          if (error.code !== 'EEXIST' || await readFile(evidenceRef, 'utf8') !== `${safeBody}\n`) throw error;
        }
      } catch { return observation(request, 'provider_evidence_persist_failed'); }
      return observation(request, null, { valid: true, request_id: typeof parsed.id === 'string' ? parsed.id : null,
        response_ref: evidenceRef, usage: parsed.usage ?? null, evidence_ref: evidenceRef });
    }
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 1)
      return observation(request, `provider_http_${Number(response.status) || 'error'}`);
  }
  return observation(request, 'attempt_limit');
}

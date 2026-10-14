import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { validateEntity } from './contracts.mjs';

function amountKey(item, provider) { return `${provider}\u0000${item.unit}\u0000${item.currency ?? ''}`; }
function validAmounts(items, allowZero = false) {
  if (!Array.isArray(items) || !items.length) throw new Error('cost upper bounds required');
  const seen = new Set();
  for (const item of items) {
    if (!['credits', 'tokens', 'search_calls', 'currency_minor'].includes(item.unit) ||
        !Number.isSafeInteger(item.amount) || (allowZero ? item.amount < 0 : item.amount < 1) ||
        (item.unit === 'currency_minor' ? !/^[A-Z]{3}$/.test(item.currency ?? '') : item.currency != null))
      throw new Error('invalid cost unit or amount');
    const key = amountKey(item, '');
    if (seen.has(key)) throw new Error('duplicate cost unit');
    seen.add(key);
  }
}

async function locked(file, action) {
  const lock = `${file}.lock`;
  // ponytail: one ledger lock limits throughput; split by run only if this becomes measurable.
  let acquired = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await mkdir(lock); acquired = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 29) throw new Error('cost ledger lock exists; manual recovery required');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  if (!acquired) throw new Error('cost ledger lock exists');
  try {
    const ledger = validateEntity('CostLedger', JSON.parse(await readFile(file, 'utf8')));
    const result = await action(ledger);
    const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
    try { await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx' }); await rename(temporary, file); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    return result ?? ledger;
  } finally { await rm(lock, { recursive: true }); }
}

function heldAmount(ledger, provider, unit) {
  return ledger.reservations.reduce((total, reservation) => {
    if (reservation.provider !== provider) return total;
    const upper = reservation.upperBounds.find(x => amountKey(x, provider) === amountKey(unit, provider));
    if (!upper) return total;
    const settled = ledger.settlements.find(x => x.reservation_id === reservation.reservation_id && x.status === 'settled');
    return total + BigInt(settled?.actual?.find(x => amountKey(x, provider) === amountKey(unit, provider))?.amount ?? upper.amount);
  }, 0n);
}

/** Reserve a per-attempt upper bound before any paid provider request. */
export async function reserveCost(ledgerPath, { provider, upperBounds, approvalRef, runId }) {
  if (typeof provider !== 'string' || !provider || typeof approvalRef !== 'string' || !approvalRef) throw new Error('provider and approval required');
  validAmounts(upperBounds);
  return locked(ledgerPath, ledger => {
    if (ledger.approval_ref !== approvalRef) throw new Error('cost approval mismatch');
    if (runId !== undefined && ledger.run_id !== runId) throw new Error('cost ledger run mismatch');
    for (const requested of upperBounds) {
      const budget = ledger.budgets.find(x => x.provider === provider && amountKey(x, provider) === amountKey(requested, provider));
      if (!budget || !Number.isSafeInteger(budget.amount) || budget.amount < 0) throw new Error('cost cap missing');
      if (heldAmount(ledger, provider, requested) + BigInt(requested.amount) > BigInt(budget.amount)) throw new Error('cost cap exceeded');
    }
    const reservation = { reservation_id: randomUUID(), provider, upperBounds, status: 'reserved', approval_ref: approvalRef,
      created_at: new Date().toISOString() };
    ledger.reservations.push(reservation);
    return reservation;
  });
}

/** Unknown billing retains the entire reservation; known usage releases only unused headroom. */
export async function settleCost(ledgerPath, reservationId, actualOrUnknown) {
  return locked(ledgerPath, ledger => {
    const reservation = ledger.reservations.find(x => x.reservation_id === reservationId);
    if (!reservation || reservation.status !== 'reserved') throw new Error('reservation not open');
    const unknown = actualOrUnknown === 'unknown';
    if (!unknown) {
      validAmounts(actualOrUnknown, true);
      for (const actual of actualOrUnknown) {
        const upper = reservation.upperBounds.find(x => amountKey(x, reservation.provider) === amountKey(actual, reservation.provider));
        if (!upper || actual.amount > upper.amount) throw new Error('actual cost exceeds reserved bound');
      }
      if (actualOrUnknown.length !== reservation.upperBounds.length) throw new Error('actual cost units incomplete');
    }
    reservation.status = unknown ? 'unknown' : 'settled';
    ledger.settlements.push({ reservation_id: reservationId, status: reservation.status, actual: unknown ? null : actualOrUnknown,
      settled_at: new Date().toISOString() });
    return ledger;
  });
}

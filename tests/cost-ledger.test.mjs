import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reserveCost, settleCost } from '../skills/optbrew/scripts/core/cost-ledger.mjs';

async function ledger() {
  const dir = await mkdtemp(path.join(tmpdir(), 'optbrew-cost-'));
  const file = path.join(dir, 'ledger.json');
  await writeFile(file, JSON.stringify({ schema_version: '1.0.0', run_id: 'test', budgets: [{ provider: 'anthropic', unit: 'credits', amount: 10 }], reservations: [], settlements: [], approval_ref: 'approved/test', source_ref: 'test' }));
  return file;
}
const upperBounds = [{ unit: 'credits', amount: 6 }];

test('parallel reservations cannot exceed cap; unknown settlement keeps cap occupied', async () => {
  const file = await ledger();
  const results = await Promise.allSettled([reserveCost(file, { provider: 'anthropic', upperBounds, approvalRef: 'approved/test' }), reserveCost(file, { provider: 'anthropic', upperBounds, approvalRef: 'approved/test' })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const id = results.find(x => x.status === 'fulfilled').value.reservation_id;
  const settled = await settleCost(file, id, 'unknown');
  assert.equal(settled.reservations[0].status, 'unknown');
  await assert.rejects(reserveCost(file, { provider: 'anthropic', upperBounds, approvalRef: 'approved/test' }));
  assert.equal((await JSON.parse(await readFile(file, 'utf8'))).settlements[0].status, 'unknown');
});

test('known settlement releases unused amount; stale lock is not auto removed', async () => {
  const file = await ledger();
  const first = await reserveCost(file, { provider: 'anthropic', upperBounds, approvalRef: 'approved/test' });
  await settleCost(file, first.reservation_id, [{ unit: 'credits', amount: 2 }]);
  const second = await reserveCost(file, { provider: 'anthropic', upperBounds, approvalRef: 'approved/test' });
  assert.ok(second.reservation_id);
  await mkdir(`${file}.lock`);
  await assert.rejects(reserveCost(file, { provider: 'anthropic', upperBounds: [{ unit: 'credits', amount: 1 }], approvalRef: 'approved/test' }), /lock/i);
});

test('missing upper bound cannot be treated as zero cost', async () => {
  const file = await ledger();
  await assert.rejects(reserveCost(file, { provider: 'anthropic', upperBounds: [{ unit: 'credits', amount: 0 }], approvalRef: 'approved/test' }));
  await assert.rejects(reserveCost(file, { provider: 'anthropic', upperBounds: [{ unit: 'currency_minor', amount: 1 }], approvalRef: 'approved/test' }));
});

test('observed overrun is stored at actual amount and stops later reservations', async () => {
  const file = await ledger();
  const first = await reserveCost(file, { provider: 'anthropic', upperBounds, approvalRef: 'approved/test' });
  const result = await settleCost(file, first.reservation_id, [{ unit: 'credits', amount: 100 }]);
  assert.equal(result.reservations[0].status, 'overrun');
  assert.equal(result.settlements[0].actual[0].amount, 100);
  await assert.rejects(reserveCost(file, { provider: 'anthropic', upperBounds: [{ unit: 'credits', amount: 1 }], approvalRef: 'approved/test' }), /overrun|blocked/);
});

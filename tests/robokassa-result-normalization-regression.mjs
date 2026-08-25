import assert from 'node:assert/strict';
import { normalizeResult } from '../backend/src/gateways/robokassa.js';

for (const [OutSum, amount] of [
  ['1', 1],
  ['1.2', 1.2],
  ['1.23', 1.23],
  ['1.230000', 1.23],
  ['0001.20', 1.2],
  ['1990.00', 1990],
  ['1990.000000', 1990]
]) {
  const result = normalizeResult({ InvId: '42', OutSum });
  assert.equal(result.ok, true, `canonical decimal amount ${OutSum} should be accepted`);
  assert.equal(result.amount_rub, amount);
  assert.equal(result.payment_id, '42');
}

for (const OutSum of [
  '', ' 1.00', '1.00 ', '+1.00', '-1.00', '0', '0.00',
  '1e3', '0x10', '1,00', '1.0000000', '1.000001', '1.234', 'NaN', 'Infinity',
  '90071992547410.00'
]) {
  assert.deepEqual(normalizeResult({ InvId: '42', OutSum }),
    { ok: false, reason: 'bad_amount' },
    `ambiguous/non-positive/unsafe amount ${JSON.stringify(OutSum)} must be rejected`);
}

assert.equal(normalizeResult({ OutSum: '1.00' }).reason, 'missing_invoice');
for (const InvId of ['-1', '+1', '1.0', '1e2', 'invoice-1', ' 42', '42 ', '1'.repeat(21)]) {
  assert.deepEqual(normalizeResult({ InvId, OutSum: '1.00' }),
    { ok: false, reason: 'bad_invoice' },
    `non-decimal or unbounded invoice ${JSON.stringify(InvId)} must be rejected`);
}
assert.equal(normalizeResult({ InvId: '0', OutSum: '1.00' }).ok, true,
  'Robokassa may use zero as its decimal invoice id');
const paddedInvoice = normalizeResult({ InvId: '00042', OutSum: '1.00' });
assert.equal(paddedInvoice.invoice_id, '00042',
  'the acknowledgement must preserve the signed invoice spelling');
assert.equal(paddedInvoice.payment_id, '42',
  'equivalent decimal spellings must share one idempotency identity');

console.log('Robokassa result normalization regressions passed');

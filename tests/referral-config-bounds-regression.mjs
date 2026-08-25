import assert from 'node:assert/strict';
import {
  buyerBonusPct,
  ipDailyLimit,
  paidDays,
  withBuyerBonus
} from '../backend/src/referrals.js';

assert.equal(paidDays({}), 7);
assert.equal(paidDays({ REFERRAL_PAID_DAYS: '0' }), 0);
assert.equal(paidDays({ REFERRAL_PAID_DAYS: '30' }), 30);
for (const raw of ['', '-1', '7.5', '1e3', '3651', 'Infinity']) {
  assert.equal(paidDays({ REFERRAL_PAID_DAYS: raw }), 7,
    `unsafe paid-days config ${JSON.stringify(raw)} must use the bounded default`);
}

assert.equal(buyerBonusPct({ REFERRAL_BUYER_BONUS_PCT: '100' }), 100);
for (const raw of ['-1', '10.5', '1e2', '101', '1e308']) {
  assert.equal(buyerBonusPct({ REFERRAL_BUYER_BONUS_PCT: raw }), 10,
    `unsafe buyer bonus ${JSON.stringify(raw)} must not reach date arithmetic`);
}

assert.equal(ipDailyLimit({ REFERRAL_IP_DAILY_LIMIT: '0' }), 0);
assert.equal(ipDailyLimit({ REFERRAL_IP_DAILY_LIMIT: '10000' }), 10_000);
assert.equal(ipDailyLimit({ REFERRAL_IP_DAILY_LIMIT: '10001' }), 30);

const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const bonused = withBuyerBonus({ REFERRAL_BUYER_BONUS_PCT: '10' }, future);
assert.ok(Date.parse(bonused) > Date.parse(future));
assert.equal(withBuyerBonus({ REFERRAL_BUYER_BONUS_PCT: '0' }, future), future);

// This is the maximum representable ECMAScript date. Adding any positive
// percentage would make toISOString throw; payment processing must retain the
// original expiry instead.
const maxDate = '+275760-09-13T00:00:00.000Z';
assert.equal(withBuyerBonus({ REFERRAL_BUYER_BONUS_PCT: '10' }, maxDate), maxDate);

console.log('referral configuration-bound regressions passed');

/**
 * Revenue must not count money that was given back.
 *
 * `purchases` is an issuance mirror: a refunded order leaves its row (and its
 * amount) in place, and revoking the key does not remove the sale. The rollup
 * therefore used to report gross as "выручка" and derive profit from it, so a
 * refunded sale kept inflating both forever.
 *
 * Refunds settle on their own clock — a June purchase can be refunded in
 * August — so they are counted by `refunded_at` within the window, exactly as
 * an accounting period does, and reported alongside gross rather than folded
 * into it. The other half of the contract: when the refund source cannot be
 * read at all, net comes back null. Presenting gross as net would be the same
 * lie in a quieter voice.
 */
import assert from 'node:assert/strict';
import { statsPurchases } from '../backend/src/analytics.js';

class MoneyD1 {
  constructor({ purchases, refunds }) {
    this.purchases = purchases;
    this.refunds = refunds;
    this.refundBinds = null;
  }
  prepare(sql) {
    const db = this;
    const isRefund = /FROM payment_orders/.test(sql);
    const isSummary = /AS revenue_kopecks[\s\S]*FROM purchases/.test(sql) && /AS licenses/.test(sql);
    let binds = [];
    return {
      bind(...args) { binds = args; if (isRefund) db.refundBinds = args; return this; },
      async all() { return { results: isRefund ? [] : (db.purchases.list || []) }; },
      async first() {
        if (isRefund) {
          if (db.refunds instanceof Error) throw db.refunds;
          return db.refunds;
        }
        if (isSummary) return db.purchases.summary;
        return null;
      }
    };
  }
}

const SUMMARY = {
  licenses: 4, paid: 4, revenue_kopecks: 400000, avg_check_kopecks: 100000,
  subscriptions: 3, lifetimes: 1, revoked: 1, preorders: 0, referral_rewards: 0
};

/* -------- a settled refund comes off the top, gross stays visible -------- */
{
  const stats = await statsPurchases({
    DB: new MoneyD1({
      purchases: { summary: SUMMARY, list: [] },
      refunds: { refunds: 1, refunded_kopecks: 100000 }
    })
  }, { days: '30' });

  const s = stats.summary;
  assert.equal(s.revenue_rub, 4000, 'gross stays reported — it is what was charged');
  assert.equal(s.refunds, 1);
  assert.equal(s.refunded_rub, 1000);
  assert.equal(s.net_revenue_rub, 3000, 'net is what was actually kept');
  assert.equal(s.refunds_known, true);
}

/* ------------- no refunds in the window: net equals gross ------------- */
{
  const stats = await statsPurchases({
    DB: new MoneyD1({
      purchases: { summary: SUMMARY, list: [] },
      refunds: { refunds: 0, refunded_kopecks: null }
    })
  }, { days: '30' });
  assert.equal(stats.summary.net_revenue_rub, 4000);
  assert.equal(stats.summary.refunded_rub, 0,
    'SUM over no rows is NULL in SQL and must land as 0, not NaN');
}

/* --------- unreadable refund source: net is unknown, not gross --------- */
{
  const stats = await statsPurchases({
    DB: new MoneyD1({
      purchases: { summary: SUMMARY, list: [] },
      refunds: new Error('D1_ERROR: no such table: payment_orders')
    })
  }, { days: '30' });

  const s = stats.summary;
  assert.equal(s.revenue_rub, 4000, 'gross is still knowable without the orders table');
  assert.equal(s.refunds_known, false);
  assert.equal(s.net_revenue_rub, null,
    'an unknown net must be distinguishable from a net that equals gross');
}

/* ---------------- the refund window matches the sale window ---------------- */
{
  const db = new MoneyD1({
    purchases: { summary: SUMMARY, list: [] },
    refunds: { refunds: 0, refunded_kopecks: 0 }
  });
  const now = Date.now();
  await statsPurchases({ DB: db }, { days: '7' });
  assert.equal(db.refundBinds.length, 1);
  assert.ok(Math.abs(db.refundBinds[0] - (now - 7 * 24 * 60 * 60 * 1000)) < 5000,
    'refunds are windowed on the same cutoff as the sales they offset');

  const allTime = new MoneyD1({
    purchases: { summary: SUMMARY, list: [] },
    refunds: { refunds: 2, refunded_kopecks: 250000 }
  });
  const stats = await statsPurchases({ DB: allTime }, { days: '0' });
  assert.deepEqual(allTime.refundBinds, [],
    'all-time asks for every refund, unbounded');
  assert.equal(stats.summary.net_revenue_rub, 1500);
}

console.log('revenue refund netting regression passed');

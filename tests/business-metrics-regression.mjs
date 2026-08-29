/**
 * The four owner-facing business views: subscription state, checkout funnel,
 * per-customer margin, and the operational worklists.
 *
 * What these pin is mostly about NOT lying:
 *
 *  - MRR normalises each plan to 30 days from its own term, so a 90-day plan
 *    does not read as three months of revenue arriving at once.
 *  - `license_revocations` is authoritative. `purchases.status` is a
 *    best-effort mirror, so a key revoked for abuse must stop counting as live
 *    revenue even when the mirror write was lost.
 *  - A pending order inside its validity window is still in play; only one past
 *    it was abandoned. Counting in-flight carts as lost invents churn.
 *  - Licence keys are bearer credentials and never leave the worker whole on a
 *    route a browser can reach with the read-only stats token.
 *  - "I could not check the queues" is null, never zero. Zero means "nothing is
 *    stuck", and that is the one thing an operator must not be told wrongly.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  statsSubscriptions, statsFunnel, statsMargin, statsWorklists, statsPurchases
} from '../backend/src/analytics.js';

const DAY = 24 * 60 * 60 * 1000;
const schemaSql = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');

/* ------------------------- subscription state ------------------------- */

class SubsD1 {
  constructor(rows) { this.rows = rows; this.binds = {}; }
  prepare(sql) {
    const db = this;
    const key = /type = 'lifetime'/.test(sql) ? 'lifetime'
      : /AS lapsed/.test(sql) ? 'lapsed'
      : 'active';
    // The live-subscription predicate must consult the authoritative
    // revocation registry, not just the mirrored status column.
    if (key === 'active') {
      assert.match(sql, /license_revocations/,
        'active subscriptions must exclude durably revoked keys');
    }
    return {
      bind(...args) { db.binds[key] = args; return this; },
      async first() { return db.rows[key]; }
    };
  }
}

{
  const stats = await statsSubscriptions({
    DB: new SubsD1({
      // 40 live subs, 12 000 000 kopecks/month normalised = 120 000 ₽ MRR
      active: { active: 40, expiring_7d: 6, expiring_30d: 19, mrr_kopecks: 12000000 },
      lifetime: { n: 9 },
      lapsed: { n: 5 }
    })
  });
  assert.equal(stats.ok, true);
  assert.equal(stats.active, 40);
  assert.equal(stats.lifetimes, 9);
  assert.equal(stats.expiring_7d, 6);
  assert.equal(stats.lapsed_30d, 5);
  assert.equal(stats.mrr_rub, 120000);
  assert.equal(stats.arpu_rub, 3000, 'ARPU is MRR spread over live subscriptions');
}

{
  // An empty book must not divide by zero into NaN/Infinity on the tile.
  const stats = await statsSubscriptions({
    DB: new SubsD1({
      active: { active: 0, expiring_7d: 0, expiring_30d: 0, mrr_kopecks: null },
      lifetime: { n: 0 }, lapsed: { n: 0 }
    })
  });
  assert.equal(stats.mrr_rub, 0);
  assert.equal(stats.arpu_rub, null, 'no subscribers means no average, not 0 ₽');
}

{
  // The 30-day normalisation constant is what makes plans comparable.
  const db = new SubsD1({
    active: { active: 1, expiring_7d: 0, expiring_30d: 0, mrr_kopecks: 0 },
    lifetime: { n: 0 }, lapsed: { n: 0 }
  });
  await statsSubscriptions({ DB: db });
  assert.equal(db.binds.active[3], 30 * DAY,
    'MRR must normalise on a 30-day month, whatever each plan term is');
}

/* ---------------------------- checkout funnel ---------------------------- */

class FunnelD1 {
  constructor(row) { this.row = row; this.binds = null; }
  prepare(sql) {
    const db = this;
    assert.match(sql, /environment = 'production'/,
      'test-mode rehearsals must not read as real abandoned demand');
    return {
      bind(...args) { db.binds = args; return this; },
      async first() { return db.row; }
    };
  }
}

{
  const stats = await statsFunnel({
    DB: new FunnelD1({
      created: 100, created_kopecks: 30000000,
      paid: 62, paid_kopecks: 18600000,
      fulfilled: 60, review: 1, refunded: 1,
      expired: 30, in_flight: 8, abandoned_pending: 0,
      lost_kopecks: 9000000
    })
  }, 30);

  assert.equal(stats.created, 100);
  assert.equal(stats.paid, 62);
  assert.equal(stats.conversion_rate, 0.62);
  assert.equal(stats.abandoned, 30,
    'abandoned counts expired carts plus pending ones past their validity');
  assert.equal(stats.in_flight, 8,
    'an order still inside its window is in play, not lost');
  assert.equal(stats.lost_rub, 90000, 'the size of the prize for fixing checkout');
}

{
  const stats = await statsFunnel({
    DB: new FunnelD1({
      created: 0, created_kopecks: null, paid: 0, paid_kopecks: null,
      fulfilled: 0, review: 0, refunded: 0, expired: 0,
      in_flight: 0, abandoned_pending: 0, lost_kopecks: null
    })
  }, 7);
  assert.equal(stats.conversion_rate, null,
    '"nobody converted" and "nobody came" are different problems — 0% would say the first');
  assert.equal(stats.paid_rub, 0, 'SUM over no rows is NULL and must land as 0');
}

/* ----------------------------- margin ----------------------------- */

class MarginD1 {
  constructor(results) { this.results = results; this.binds = null; this.sql = ''; }
  prepare(sql) {
    const db = this;
    db.sql = sql;
    return {
      bind(...args) { db.binds = args; return this; },
      async all() { return { results: db.results }; }
    };
  }
}

{
  const db = new MarginD1([
    { license_key: 'SMESH-AAAA-BBBB-9below', type: 'subscription', status: 'active',
      amount_kopecks: 29900, issued_at: 1000, expires_at: 2000,
      devices: 2, api_cost_usd: 4.2, api_calls: 310 },
    { license_key: 'SMESH-CCCC-DDDD-EF12', type: 'lifetime', status: 'active',
      amount_kopecks: 149900, issued_at: 500, expires_at: null,
      devices: 1, api_cost_usd: 0.4, api_calls: 20 }
  ]);
  const stats = await statsMargin({ DB: db }, 30, 50);

  assert.match(db.sql, /json_each/,
    'the only surviving link is purchases.device_ids → events; devices.license_key is always NULL');
  assert.match(db.sql, /e\.type = 'ai_call'/,
    'client telemetry is opt-in, so margin must use server-observed calls only');

  const [worst] = stats.customers;
  assert.equal(worst.paid_rub, 299);
  assert.equal(worst.api_cost_usd, 4.2);
  assert.equal(worst.devices, 2);
  assert.equal(worst.key_hint, '••••elow', 'rows stay distinguishable without the key');
  for (const c of stats.customers) {
    assert.ok(!('license_key' in c),
      'a licence key is a bearer credential and must not reach a browser-held token');
    assert.ok(!JSON.stringify(c).includes('SMESH-'),
      'no fragment of a real key may survive anywhere in the row');
  }
  assert.equal(stats.paid_rub, 299 + 1499);
  assert.ok(Math.abs(stats.api_cost_usd - 4.6) < 1e-9);
}

{
  // The page bound is clamped, not trusted from the query string.
  const db = new MarginD1([]);
  await statsMargin({ DB: db }, 0, 99999);
  assert.equal(db.binds[1], 500, 'limit is clamped to the hard ceiling');
  assert.equal(db.binds[0], 0, 'days=0 means every paying customer');
}

/* --------------------------- worklists --------------------------- */

class WorklistD1 {
  constructor(counts, { broken = false } = {}) { this.counts = counts; this.broken = broken; }
  prepare(sql) {
    const db = this;
    const table = /delivery_outbox/.test(sql) ? 'delivery_exhausted'
      : /payment_review/.test(sql) ? 'payment_review_open'
      : /reconciliation_provider_error/.test(sql) ? 'payment_reconciliation_errors'
      : /refund_request_id IS NULL/.test(sql) ? 'refund_submission_unknown'
      : /payment_refund_poll/.test(sql) ? 'refund_poll_stalled'
      : /referral_credit_state\s*\n?\s*WHERE status = 'pending'/.test(sql) ? 'referral_unsettled'
      : /referral_credits/.test(sql) ? 'referral_legacy_unjournaled'
      : /support_forward_outbox/.test(sql) ? 'support_forward_exhausted'
      : 'subscription_notify_exhausted';
    return {
      bind() { return this; },
      async first() {
        if (db.broken) throw new Error('D1_ERROR: database unavailable');
        return { n: db.counts[table] || 0 };
      }
    };
  }
}

{
  const stats = await statsWorklists({
    DB: new WorklistD1({ delivery_exhausted: 2, payment_review_open: 1 })
  }, { deliveryMaxAttempts: 30, refundPollStalledAttempts: 6 });

  assert.equal(stats.ok, true);
  assert.equal(stats.worklists.delivery_exhausted, 2,
    'money taken and no key delivered is the sharpest queue there is');
  assert.equal(stats.worklists.payment_review_open, 1);
  assert.equal(stats.total, 3, 'the strip needs one number to decide whether to look');
}

{
  const stats = await statsWorklists({ DB: new WorklistD1({}, { broken: true }) }, {});
  assert.equal(stats.ok, true, 'a probe failure must not take down the view around it');
  assert.equal(stats.worklists, null);
  assert.equal(stats.total, null,
    '"could not check" must never render as the reassuring "0 stuck"');
  assert.equal(stats.unavailable, true);
}

/* ------------- purchases list no longer ships raw licence keys ------------- */

class PurchaseListD1 {
  constructor(rows, summary) { this.rows = rows; this.summary = summary; }
  prepare(sql) {
    const db = this;
    const isList = /SELECT \* FROM purchases/.test(sql);
    const isRefund = /FROM payment_orders/.test(sql);
    return {
      bind() { return this; },
      async all() { return { results: isList ? db.rows : [] }; },
      async first() { return isRefund ? { refunds: 0, refunded_kopecks: 0 } : db.summary; }
    };
  }
}

{
  const stats = await statsPurchases({
    DB: new PurchaseListD1(
      [{ license_key: 'SMESH-1111-2222-3333', issued_at: 5, type: 'subscription',
         gateway: 'robokassa', amount_rub: 299, amount_kopecks: 29900,
         email: 'b@example.com', status: 'active' }],
      { licenses: 1, paid: 1, revenue_kopecks: 29900, avg_check_kopecks: 29900,
        subscriptions: 1, lifetimes: 0, revoked: 0, preorders: 0, referral_rewards: 0 }
    )
  }, { days: '30' });

  const [row] = stats.purchases;
  assert.ok(!('license_key' in row),
    'the money list is rendered by date/amount/contact and never needs the key itself');
  assert.equal(row.key_hint, '••••3333');
  assert.equal(row.amount_rub, 299, 'every other displayed field survives masking');
  assert.equal(row.email, 'b@example.com');
}

/* ------------------- the same claims, against real SQL ------------------- */
//
// Everything above stubs D1, so it pins the JavaScript around each query and
// nothing inside it: the MRR normalisation lives in a SQL expression, and a
// mock that returns `mrr_kopecks` cannot tell a correct denominator from a
// wrong one. Run the real statements against the real schema so the numbers
// these panels print are the numbers this schema actually produces.

class SqliteD1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const db = this.db;
    const statement = (args = []) => ({
      bind: (...bound) => statement(bound),
      async first(column) {
        const row = db.prepare(sql).get(...args) || null;
        return column ? row?.[column] ?? null : row;
      },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) || 0 } }; }
    });
    return statement();
  }
}

function liveDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schemaSql);
  const insert = (table, row) => {
    const columns = Object.keys(row);
    sqlite.prepare(
      `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`
    ).run(...columns.map((column) => row[column]));
  };
  return { env: { DB: new SqliteD1(sqlite) }, insert };
}

const order = (patch) => ({
  gateway: 'robokassa', environment: 'production', currency: 'RUB',
  plan_type: 'subscription', fiscalization_mode: 'external',
  amount_kopecks: 29900, ...patch
});

{
  const NOW = Date.now();
  const { env, insert } = liveDatabase();

  // 299 ₽ over 30 days and 900 ₽ over 90 days are the SAME kind of customer per
  // month. If the term normalisation is ever dropped, the quarterly plan alone
  // would add 900 to MRR and this number becomes 1498.
  insert('purchases', { license_key: 'K-MONTH', type: 'subscription', status: 'active',
    amount_kopecks: 29900, issued_at: NOW - DAY, expires_at: NOW + 29 * DAY,
    device_ids: JSON.stringify(['dev-1', 'dev-2']) });
  insert('purchases', { license_key: 'K-QUARTER', type: 'subscription', status: 'active',
    amount_kopecks: 90000, issued_at: NOW - DAY, expires_at: NOW + 89 * DAY,
    device_ids: JSON.stringify(['dev-3']) });
  // Expires inside the week — the "what lapses next" number.
  insert('purchases', { license_key: 'K-SOON', type: 'subscription', status: 'active',
    amount_kopecks: 29900, issued_at: NOW - 27 * DAY, expires_at: NOW + 3 * DAY });
  // Revoked for abuse, but the best-effort status mirror still says active.
  insert('purchases', { license_key: 'K-REVOKED', type: 'subscription', status: 'active',
    amount_kopecks: 29900, issued_at: NOW - DAY, expires_at: NOW + 29 * DAY });
  insert('license_revocations', { license_key: 'K-REVOKED', revoked_at: NOW, reason: 'abuse' });
  insert('purchases', { license_key: 'K-LIFETIME', type: 'lifetime', status: 'active',
    amount_kopecks: 149900, issued_at: NOW - 5 * DAY });

  const subscriptions = await statsSubscriptions(env);
  assert.equal(subscriptions.mrr_rub, 299 + 300 + 299,
    'each plan contributes its own 30-day rate: the 90-day one adds 300, not 900');
  assert.equal(subscriptions.active, 3, 'the revoked key is not live revenue');
  assert.equal(subscriptions.lifetimes, 1, 'and a lifetime key is not recurring revenue');
  assert.equal(subscriptions.expiring_7d, 1);
  assert.equal(subscriptions.expiring_30d, 2, 'the 30-day window contains the 7-day one');

  // 100 created, 62 paid, 60 keyed, 30 expired carts, 8 still inside their
  // window, and one test-mode rehearsal that must not count as lost demand.
  let id = 1;
  for (let i = 0; i < 60; i++) insert('payment_orders', order({ order_id: id++, status: 'fulfilled', created_at: NOW - 2 * DAY, expires_at: NOW - DAY }));
  insert('payment_orders', order({ order_id: id++, status: 'review', created_at: NOW - 2 * DAY, expires_at: NOW - DAY }));
  insert('payment_orders', order({ order_id: id++, status: 'refunded', created_at: NOW - 2 * DAY, expires_at: NOW - DAY }));
  for (let i = 0; i < 30; i++) insert('payment_orders', order({ order_id: id++, status: 'expired', created_at: NOW - 2 * DAY, expires_at: NOW - DAY }));
  for (let i = 0; i < 8; i++) insert('payment_orders', order({ order_id: id++, status: 'pending', created_at: NOW - 60_000, expires_at: NOW + 3_600_000 }));
  insert('payment_orders', order({ order_id: id++, environment: 'test', status: 'expired', created_at: NOW - 2 * DAY, expires_at: NOW - DAY }));

  const funnel = await statsFunnel(env, 30);
  assert.equal(funnel.created, 100, 'the owner rehearsal is not real demand');
  assert.equal(funnel.paid, 62);
  assert.equal(funnel.fulfilled, 60);
  assert.equal(funnel.conversion_rate, 0.62);
  assert.equal(funnel.in_flight, 8, 'a cart still inside its window is in play');
  assert.equal(funnel.abandoned, 30, 'and is therefore not counted as abandoned');
  assert.equal(funnel.lost_rub, 30 * 299);

  // Margin joins purchases.device_ids → events through json_each, and counts
  // only 'ai_call' rows: a client-reported 'solve' is a different, opt-in
  // number and would double-count this spend.
  insert('events', { id: 1, device_id: 'dev-1', ts: NOW - 3_600_000, day: '2026-08-28', type: 'ai_call', cost_usd: 4.0 });
  insert('events', { id: 2, device_id: 'dev-2', ts: NOW - 3_600_000, day: '2026-08-28', type: 'ai_call', cost_usd: 0.2 });
  insert('events', { id: 3, device_id: 'dev-3', ts: NOW - 3_600_000, day: '2026-08-28', type: 'ai_call', cost_usd: 0.4 });
  insert('events', { id: 4, device_id: 'dev-1', ts: NOW - 3_600_000, day: '2026-08-28', type: 'solve', cost_usd: 99 });

  const margin = await statsMargin(env, 30, 100);
  const byHint = Object.fromEntries(margin.customers.map((c) => [c.key_hint, c]));
  assert.equal(byHint['••••ONTH'].devices, 2, 'json_each counts the activated devices');
  assert.ok(Math.abs(byHint['••••ONTH'].api_cost_usd - 4.2) < 1e-9,
    'both of this key devices are its cost, and the client solve row is not');
  assert.equal(byHint['••••ONTH'].api_calls, 2);
  assert.equal(margin.customers[0].key_hint, '••••ONTH', 'the expensive tail sorts first');

  // A paying customer the proxy never reported on. Their cost is UNKNOWN, and
  // reporting it as 0 made the unmeasured heavy user the most profitable row on
  // a panel whose entire job is finding loss-makers.
  const quiet = byHint['••••SOON'];
  assert.equal(quiet.api_calls, 0);
  assert.equal(quiet.cost_observed, false,
    'no reported calls means not measured, never "cost nothing"');
  assert.equal(byHint['••••ONTH'].cost_observed, true);
  assert.equal(margin.counted, 5, 'every paying key in the window is listed');
  assert.equal(margin.observed, 2, 'only the keys with reported usage are measurable');
  assert.equal(margin.unobserved, 3, 'and the panel must say how many it cannot see');
  assert.equal(margin.observed_paid_rub, 299 + 900,
    'cost totals are only fair against the revenue of the same observed subset');

  for (const customer of margin.customers) {
    assert.ok(!('license_key' in customer), 'no route a browser token reaches ships a whole key');
    assert.ok(!JSON.stringify(customer).includes('K-'), 'nor any fragment of one');
  }

  // Nine separate statements, no compound SELECT: workerd caps a UNION ALL and
  // this rollup is also the /admin/health probe, so it has to run there too.
  const worklists = await statsWorklists(env, {});
  assert.equal(worklists.total, 0, 'an empty book has nothing stuck');
  insert('delivery_outbox', { license_key: 'K-MONTH', email: 'b@example.com',
    created_at: NOW, attempts: 30, next_attempt_at: NOW });
  const stuck = await statsWorklists(env, { deliveryMaxAttempts: 30 });
  assert.equal(stuck.worklists.delivery_exhausted, 1,
    'money taken and no key delivered must surface from the real table');
}

console.log('business metrics regression passed');

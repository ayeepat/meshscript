// Regressions for three audit findings around the shared abuse budgets:
//  B-12: the referral-code IP limiter must be atomic — the historical KV
//        read-increment-write admitted every synchronized request and left
//        the counter at 1.
//  B-11: rejected traffic must stop consuming the limiting resource — once a
//        key is over its limit, further hits in the same isolate answer from
//        memory instead of writing to D1 on every rejected request.
//  B-09: identifier-bearing bookkeeping has a lifecycle — /t/delete erases
//        the device's budget rows, and the cron prune expires old budget,
//        quota, and tombstone rows.
import assert from 'node:assert/strict';
import { bumpIpBudget } from '../backend/src/referrals.js';
import {
  bumpDailyBudget, budgetBlockedToday, mskDay, pruneExpiredAnalytics, handleDeleteDevice
} from '../backend/src/analytics.js';

class FakeKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

// Executes budget/prune/delete SQL against in-memory maps. `ops` counts every
// statement that actually reaches "D1" so the B-11 shed can be observed.
class FakeD1 {
  budgets = new Map();     // `${day}|${scope}|${key}` -> count
  quota = new Map();       // `${day}|...` -> count
  tombstones = new Map();  // device -> deleted_at
  events = [];
  devices = new Map();     // device -> last_seen
  ops = 0;

  prepare(sql) {
    const db = this;
    return {
      bind: (...args) => ({
        async first() {
          db.ops += 1;
          if (sql.includes('SELECT (') && sql.includes('AS known')) {
            return db.devices.has(args[0]) || db.events.some((event) => event.device_id === args[0]) ||
              [...db.budgets.keys()].some((id) => id.includes(`|device|${args[0]}`)) ? 1 : 0;
          }
          if (sql.includes('INSERT INTO telemetry_budget')) {
            const [day, scope, key, amount] = args;
            const id = `${day}|${scope}|${key}`;
            const count = (db.budgets.get(id) || 0) + amount;
            db.budgets.set(id, count);
            return count;
          }
          return null;
        },
        async run() {
          db.ops += 1;
          if (sql.includes('DELETE FROM telemetry_budget WHERE day <')) {
            for (const id of [...db.budgets.keys()]) {
              if (id.slice(0, id.indexOf('|')) < args[0]) db.budgets.delete(id);
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes("DELETE FROM telemetry_budget WHERE scope = 'device'")) {
            for (const id of [...db.budgets.keys()]) {
              if (id.includes(`|device|${args[0]}`)) db.budgets.delete(id);
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM proxy_quota')) {
            for (const id of [...db.quota.keys()]) {
              if (id.slice(0, id.indexOf('|')) < args[0]) db.quota.delete(id);
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM device_tombstones')) {
            for (const [device, at] of [...db.tombstones]) {
              if (at < args[0]) db.tombstones.delete(device);
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM events WHERE ts <')) {
            db.events = db.events.filter((event) => event.ts >= args[0]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM devices') && sql.includes('last_seen <')) {
            for (const [device, lastSeen] of [...db.devices]) {
              const hasRecentEvent = db.events.some(
                (event) => event.device_id === device && event.ts >= args[0]
              );
              if (lastSeen < args[0] && !hasRecentEvent) db.devices.delete(device);
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO device_tombstones')) {
            db.tombstones.set(args[0], args[1]);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        }
      })
    };
  }

  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

const today = mskDay();

/* ---- B-12: synchronized referral-code requests cannot all be admitted ---- */
{
  const db = new FakeD1();
  const env = { LICENSES: new FakeKV(), DB: db, REFERRAL_IP_DAILY_LIMIT: '30' };
  const verdicts = await Promise.all(
    Array.from({ length: 100 }, () => bumpIpBudget(env, '198.51.100.77'))
  );
  assert.equal(verdicts.filter(Boolean).length, 30,
    'exactly the configured limit of synchronized requests may be admitted');
  // The counter retained every increment that reached D1; requests after the
  // over-limit verdict were shed in memory (B-11), so the count stops just
  // past the limit instead of the historical race's final value of ONE.
  assert.ok(db.budgets.get(`${today}|ref_ip|198.51.100.77`) >= 31,
    'the atomic counter must retain concurrent increments, never regress to 1');
}

/* ---- B-12 failure mode: configured D1 outage must not reopen KV race ---- */
{
  const kv = new FakeKV();
  const env = {
    LICENSES: kv,
    DB: { prepare() { throw new Error('simulated referral budget outage'); } },
    REFERRAL_IP_DAILY_LIMIT: '30'
  };
  assert.equal(await bumpIpBudget(env, '198.51.100.90'), false,
    'public code minting must fail closed when its atomic limiter is unavailable');
assert.equal([...kv.store.keys()].some((key) => key.startsWith('refip:')), false,
    'a configured D1 failure must never fall back to the raceable KV limiter');
}

{
  const kv = new FakeKV();
  assert.equal(await bumpIpBudget({
    LICENSES: kv,
    REFERRAL_IP_DAILY_LIMIT: '30'
  }, '198.51.100.91'), false,
  'a missing D1 binding must fail closed instead of using a raceable KV counter');
  assert.equal(kv.store.size, 0);
}

{
  const db = new FakeD1();
  const env = { LICENSES: new FakeKV(), DB: db, REFERRAL_IP_DAILY_LIMIT: '2' };
  assert.equal(await bumpIpBudget(env, ''), true);
  assert.equal(await bumpIpBudget(env, null), true);
  assert.equal(await bumpIpBudget(env, undefined), false,
    'a missing edge IP header must use a shared bounded bucket, never bypass admission');
  assert.ok(db.budgets.get(`${today}|ref_ip|unknown`) >= 3);
}

/* ---- B-11: over-limit keys stop consuming D1 ---- */
{
  const db = new FakeD1();
  const env = { LICENSES: new FakeKV(), DB: db, REFERRAL_IP_DAILY_LIMIT: '3' };
  for (let i = 0; i < 4; i++) await bumpIpBudget(env, '198.51.100.88');
  const opsAfterBlocking = db.ops;
  for (let i = 0; i < 50; i++) {
    assert.equal(await bumpIpBudget(env, '198.51.100.88'), false);
  }
  assert.equal(db.ops, opsAfterBlocking,
    'once a key is known over-limit, rejected requests must not reach D1 at all');

  // The shed is per-key: another IP still goes through the shared counter.
  assert.equal(await bumpIpBudget(env, '198.51.100.89'), true);
  assert.ok(db.ops > opsAfterBlocking);

  // And it only replays same-day verdicts — the helper admits again for a new
  // window because the cache key includes the day.
  assert.equal(await bumpDailyBudget(env, '2099-01-01', 'ref_ip', '198.51.100.88', 1, 3), 1,
    'a new day must consult D1 again instead of trusting a stale block');
  assert.equal(budgetBlockedToday('2099-01-01', 'ref_ip', '198.51.100.88'), false,
    'the in-memory shed cache must not retain a raw-IP verdict across daily windows');
}

/* ---- B-09: erasure removes device budget rows; the prune expires the rest ---- */
{
  const db = new FakeD1();
  const env = { DB: db };
  const device = 'cccccccc-3333-4333-8333-333333333333';
  const sixDaysAgo = mskDay(Date.now() - 6 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = mskDay(Date.now() - 7 * 24 * 60 * 60 * 1000);
  db.budgets.set(`${today}|device|${device}`, 12);
  db.budgets.set(`${sixDaysAgo}|ip|198.51.100.6`, 6);      // seventh retained bucket
  db.budgets.set(`${sevenDaysAgo}|ip|198.51.100.7`, 7);    // eighth bucket, pruned
  db.budgets.set(`2026-07-01|ip|203.0.113.55`, 400);       // stale, prunable
  db.budgets.set(`${today}|ip|203.0.113.55`, 40);          // fresh, kept
  db.quota.set('2026-07-01|SMESH-OLD|qwen', 9);            // stale quota day
  db.quota.set(`${today}|SMESH-NEW|qwen`, 3);
  db.tombstones.set('old-device', Date.now() - 48 * 60 * 60 * 1000);
  const oldTs = Date.now() - 100 * 24 * 60 * 60 * 1000;
  const recentTs = Date.now() - 10 * 24 * 60 * 60 * 1000;
  db.events.push(
    { device_id: 'expired-analytics-device', ts: oldTs },
    { device_id: 'active-analytics-device', ts: recentTs }
  );
  db.devices.set('expired-analytics-device', oldTs);
  db.devices.set('active-analytics-device', recentTs);

  const deleted = await handleDeleteDevice(new Request('https://smeshapi.site/t/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_id: device })
  }), env, device);
  assert.deepEqual(deleted, { ok: true, deleted: true });
  assert.equal(db.budgets.has(`${today}|device|${device}`), false,
    'user erasure must remove the device-keyed admission budget rows too');

  const pruned = await pruneExpiredAnalytics(env);
  assert.equal(pruned.pruned, true);
  assert.equal(pruned.budget_before_day, sixDaysAgo,
    'the retention boundary must be today plus exactly six prior Moscow days');
  assert.equal(db.budgets.has(`${sixDaysAgo}|ip|198.51.100.6`), true,
    'the seventh calendar bucket is retained');
  assert.equal(db.budgets.has(`${sevenDaysAgo}|ip|198.51.100.7`), false,
    'an eighth calendar bucket must not survive the seven-day policy');
  assert.equal(db.budgets.has('2026-07-01|ip|203.0.113.55'), false,
    'raw-IP budget rows must expire after the retention window');
  assert.equal(db.budgets.get(`${today}|ip|203.0.113.55`), 40, 'fresh rows survive');
  assert.equal(db.quota.has('2026-07-01|SMESH-OLD|qwen'), false, 'stale quota days expire');
  assert.equal(db.quota.has(`${today}|SMESH-NEW|qwen`), true);
  assert.equal(db.tombstones.has('old-device'), false, 'aged tombstones expire');
  assert.equal(db.events.some((event) => event.device_id === 'expired-analytics-device'), false,
    'pseudonymous event history must have a finite retention window');
  assert.equal(db.devices.has('expired-analytics-device'), false,
    'inactive device identifiers must be removed with their expired history');
  assert.equal(db.events.some((event) => event.device_id === 'active-analytics-device'), true);
  assert.equal(db.devices.has('active-analytics-device'), true);
  assert.equal(pruned.analytics_retention_days, 90);

  assert.deepEqual(await pruneExpiredAnalytics({}), { pruned: false },
    'no DB means nothing to prune, never a throw');
}

console.log('abuse budget lifecycle regressions passed');

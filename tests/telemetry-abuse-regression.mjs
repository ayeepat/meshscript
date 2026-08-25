import assert from 'node:assert/strict';
import { handleIngest } from '../backend/src/analytics.js';

class FakeD1 {
  budgets = new Map();
  eventBatches = 0;

  prepare(sql) {
    return {
      bind: (...args) => {
        if (sql.includes('INSERT INTO telemetry_budget')) {
          return {
            first: async () => {
              // Device admission is now a tombstone-gated INSERT..SELECT with
              // a literal scope; its fourth bind is the tombstone cutoff, not
              // the increment. Model both SQL shapes faithfully.
              const [day, scope, key, amount] = sql.includes("SELECT ?1, 'device'")
                ? [args[0], 'device', args[1], args[2]]
                : args;
              const id = `${day}|${scope}|${key}`;
              const current = this.budgets.get(id) || 0;
              const cap = args[4];
              const limit = args[5];
              // Production SQL saturates at limit+1 and then its WHERE clause
              // performs no further UPDATE/RETURNING work.
              if (Number.isFinite(limit) && current > limit) return null;
              const count = Number.isFinite(cap)
                ? Math.min(current + amount, cap)
                : current + amount;
              this.budgets.set(id, count);
              return count;
            }
          };
        }
        return { sql, args };
      }
    };
  }

  async batch(statements) {
    this.eventBatches += 1;
    return statements.map(() => ({ success: true }));
  }
}

function ingestRequest(device, { ip = '203.0.113.10', count = 25, padding = '' } = {}) {
  return new Request('https://smeshapi.site/t', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({
      device_id: device,
      browser: 'chrome',
      version: 'test',
      provider: 'qwen',
      padding,
      events: Array.from({ length: count }, (_, i) => ({
        ts: Date.now(), type: 'solve', subject: `event-${i}`
      }))
    })
  });
}

const db = new FakeD1();
const env = { DB: db };

// The body must be rejected before JSON parsing or any D1 admission/write.
const oversized = await handleIngest(ingestRequest(
  '00000000-0000-4000-8000-000000000000',
  { padding: 'x'.repeat(70 * 1024) }
), env);
assert.equal(oversized.status, 413);
assert.equal(db.budgets.size, 0);
assert.equal(db.eventBatches, 0);

// Twenty-one synchronized 25-event requests from one IP attempt 525 events.
// Atomic IP admission permits exactly the first 500; rotating device IDs does
// not create a new shared allowance.
const burst = await Promise.all(Array.from({ length: 21 }, (_, i) =>
  handleIngest(
    ingestRequest(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`),
    env,
    `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
  )
));
assert.equal(burst.filter((result) => result.ok).length, 20);
assert.equal(burst.filter((result) => result.status === 429).length, 1);
const ipBudget = [...db.budgets.entries()].find(([key]) => key.includes('|ip|203.0.113.10'));
assert.equal(ipBudget?.[1], 501,
  'the shared counter must saturate just over the limit instead of writing forever');

// One device is independently capped even when its IP still has room.
const db2 = new FakeD1();
const device = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sameDevice = await Promise.all(Array.from({ length: 13 }, () =>
  handleIngest(ingestRequest(device, { ip: '198.51.100.20' }), { DB: db2 }, device)
));
assert.equal(sameDevice.filter((result) => result.ok).length, 12);
assert.equal(sameDevice.at(-1).status, 429);

console.log('telemetry abuse regressions passed');

// Historical-payment compatibility and paid-but-unissued durability.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';
import { resultSignatureBase } from '../backend/src/gateways/robokassa.js';

const PASSWORD2 = 'historical-result-password-2';

class FakeKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

class SqliteD1 {
  constructor(db, { failReview = false } = {}) {
    this.db = db;
    this.failReview = failReview;
  }
  prepare(sql) {
    const owner = this;
    const statement = (args = []) => ({
      bind: (...bound) => statement(bound),
      async first(column) {
        const row = owner.db.prepare(sql).get(...args) || null;
        return column ? row?.[column] ?? null : row;
      },
      async all() { return { results: owner.db.prepare(sql).all(...args) }; },
      async run() {
        if (owner.failReview && sql.includes('INSERT OR IGNORE INTO payment_review')) {
          throw new Error('injected payment review failure');
        }
        const result = owner.db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) || 0 } };
      }
    });
    return statement();
  }
  async batch(statements) {
    this.db.exec('SAVEPOINT historical_payment_batch');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('RELEASE SAVEPOINT historical_payment_batch');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT historical_payment_batch');
      this.db.exec('RELEASE SAVEPOINT historical_payment_batch');
      throw error;
    }
  }
}

async function fixture(options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
  return {
    db,
    env: {
      DB: new SqliteD1(db, options),
      LICENSES: new FakeKV(),
      PAYMENT_ENVIRONMENT: 'production',
      ROBOKASSA_PASSWORD2_PRODUCTION: PASSWORD2,
      ROBOKASSA_HASH_ALGO: 'SHA-256',
      RUNTIME_WRITE_EPOCH: '1'
    }
  };
}

async function callback(env, fields) {
  const signature = createHash('sha256')
    .update(resultSignatureBase(fields, PASSWORD2), 'utf8').digest('hex');
  const waiting = [];
  const response = await worker.fetch(new Request('https://api.example/webhook/robokassa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, SignatureValue: signature }).toString()
  }), env, { waitUntil(promise) { waiting.push(Promise.resolve(promise).catch(() => {})); } });
  await Promise.all(waiting);
  return response;
}

function historicalLicense(paymentId, key, status = 'active') {
  return {
    key, type: 'lifetime', status, email: 'legacy@example.com',
    telegram_user_id: null, issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: null, payment_id: String(paymentId), gateway: 'robokassa',
    amount_kopecks: 99_000, amount_rub: 990, is_preorder: false,
    referral_code: null, device_ids: [], note: null
  };
}

// Claims created before payment_orders existed remain replayable because the
// immutable payment_issuance winner prevents any new entitlement from being
// minted. Mutable modern catalog settings are irrelevant to that history.
{
  const { db, env } = await fixture();
  const license = historicalLicense('700', 'SMESH-HISTORICAL-700');
  db.prepare(
    `INSERT INTO payment_issuance
       (gateway, payment_id, license_key, license_json, created_at)
     VALUES ('robokassa', ?, ?, ?, ?)`
  ).run('700', license.key, JSON.stringify(license), 1);

  const first = await callback(env, { OutSum: '990.00', InvId: '700' });
  assert.equal(await first.text(), 'OK700');
  assert.equal(JSON.parse(await env.LICENSES.get(license.key)).key, license.key);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM delivery_outbox').get().n, 1);

  env.LIFETIME_PRICE_RUB = '5000';
  const replay = await callback(env, { OutSum: '990.000000', InvId: '0700' });
  assert.equal(await replay.text(), 'OK0700');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_issuance').get().n, 1);

  const conflict = await callback(env, { OutSum: '1990.00', InvId: '700' });
  assert.equal(await conflict.text(), 'OK700');
  assert.equal(
    db.prepare('SELECT reason FROM payment_review WHERE payment_id = ?').get('700').reason,
    'issued_amount_mismatch'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_issuance').get().n, 1);
  db.close();
}

// An authoritative revocation recorded before first KV materialization wins
// over the issue-time snapshot: replay neither delivers nor creates a reward.
{
  const { db, env } = await fixture();
  const license = historicalLicense('701', 'SMESH-HISTORICAL-701');
  db.prepare(
    `INSERT INTO payment_issuance
       (gateway, payment_id, license_key, license_json, created_at)
     VALUES ('robokassa', ?, ?, ?, ?)`
  ).run('701', license.key, JSON.stringify(license), 1);
  db.prepare(
    'INSERT INTO license_revocations(license_key, revoked_at, reason) VALUES (?, ?, ?)'
  ).run(license.key, Date.now(), 'refund');

  const replay = await callback(env, { OutSum: '990.00', InvId: '701' });
  assert.equal(await replay.text(), 'OK701');
  assert.equal(JSON.parse(await env.LICENSES.get(license.key)).status, 'revoked');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM delivery_outbox').get().n, 0);
  db.close();
}

// If an unknown signed payment cannot be journaled, withhold OK so Robokassa
// remains the durable redelivery channel.
{
  const { db, env } = await fixture({ failReview: true });
  const response = await callback(env, {
    OutSum: '990.00', InvId: '702',
    Shp_environment: 'production', Shp_order_id: '702'
  });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).reason, 'payment_review_retry');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_review').get().n, 0);
  db.close();
}

console.log('robokassa historical replay and unissued-payment journal regressions passed');

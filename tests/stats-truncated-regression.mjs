/**
 * The stats endpoints run under hard scan bounds (100k event rows for
 * retention, 5000 KV records for referrals). Silent truncation made those
 * numbers look authoritative when they were partial, so the API exposes a
 * `truncated` flag. This pins the flag on BOTH sides of each bound — false
 * for small datasets, true exactly when the bound is hit — so the owner
 * dashboard can show its warning instead of a confidently wrong total.
 */
import assert from 'node:assert/strict';
import { statsRetention, statsReferrals } from '../backend/src/analytics.js';

class RetentionD1 {
  constructor(activityRows) { this.activityRows = activityRows; }
  prepare(sql) {
    const db = this;
    return {
      bind() { return this; },
      async all() {
        if (sql.includes('FROM devices')) {
          return { results: [{ device_id: 'device-1', first_seen: Date.now() - 40 * 24 * 60 * 60 * 1000 }] };
        }
        if (sql.includes('FROM events')) return { results: db.activityRows };
        return { results: [] };
      }
    };
  }
}

// Under the bound: authoritative, no warning.
{
  const env = { DB: new RetentionD1([{ device_id: 'device-1', day: '2026-07-01' }]) };
  const stats = await statsRetention(env);
  assert.equal(stats.ok, true);
  assert.equal(stats.truncated, false,
    'a scan under the row bound is complete and must not warn');
}

// At the bound: the scan was cut off and the API must say so.
{
  const cappedRows = Array.from({ length: 100000 }, (_, i) => ({
    device_id: 'device-1',
    day: `2026-0${(i % 6) + 1}-01`
  }));
  const env = { DB: new RetentionD1(cappedRows) };
  const stats = await statsRetention(env);
  assert.equal(stats.truncated, true,
    'hitting the 100k activity bound must surface truncated:true to consumers');
}

class RefListKV {
  constructor(pages) { this.pages = pages; this.records = new Map(); }
  async list({ cursor }) {
    const index = Number(cursor) || 0;
    const page = this.pages[index];
    return {
      keys: page.keys,
      list_complete: index >= this.pages.length - 1 && page.complete !== false,
      cursor: String(index + 1)
    };
  }
  async get(name) { return this.records.get(name) || null; }
}

// Small referral namespace: complete rollup.
{
  const kv = new RefListKV([{ keys: [{ name: 'ref:REF-AAAA-BBBB' }], complete: true }]);
  kv.records.set('ref:REF-AAAA-BBBB', JSON.stringify({
    code: 'REF-AAAA-BBBB', created_at: '2026-07-01T00:00:00Z', purchases: 2, days_earned: 14
  }));
  const stats = await statsReferrals({ LICENSES: kv });
  assert.equal(stats.truncated, false);
  assert.equal(stats.total_codes, 1);
  assert.equal(stats.total_referred_purchases, 2);
}

// More records than the 5000 safety bound: totals are partial and flagged.
{
  const record = (i) => `ref:REF-${String(i).padStart(4, '0')}-CODE`;
  const pages = Array.from({ length: 6 }, (_, p) => ({
    keys: Array.from({ length: 1000 }, (_, i) => ({ name: record(p * 1000 + i) })),
    complete: false
  }));
  const kv = new RefListKV(pages);
  for (let i = 0; i < 6000; i++) {
    kv.records.set(record(i), JSON.stringify({
      code: record(i).slice(4), created_at: '2026-07-01T00:00:00Z', purchases: 1, days_earned: 7
    }));
  }
  const stats = await statsReferrals({ LICENSES: kv });
  assert.equal(stats.truncated, true,
    'stopping at the 5000-record bound must surface truncated:true to consumers');
  assert.equal(stats.total_codes, 5000);
}

console.log('stats truncated regression passed');

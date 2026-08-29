/**
 * The owner dashboard's Telegram/feedback surface: /admin/stats/feedback and
 * /admin/stats/tickets.
 *
 * Three properties matter more than the arithmetic:
 *
 *  1. Partial schema degrades, it does not 500. subscription_notifications
 *     ships in a later migration than support_forward_outbox, so a worker whose
 *     D1 is one migration behind must still answer with the parts it CAN read
 *     and name the parts it cannot — a view that dies entirely is how an
 *     un-run migration turns into "the dashboard is broken".
 *
 *  2. Zero-because-unread is never rendered as zero-because-nothing-happened.
 *     `unavailable` carries that distinction, and an unsent survey reports a
 *     null response rate rather than 0%.
 *
 *  3. Ticket bodies come back newest-first and WITHOUT the sender's identity.
 *     KV lists lexicographically, so "ticket:1000" sorts before "ticket:999"
 *     and a naive slice returns the oldest tickets while claiming they are the
 *     newest. The identity fields are withheld because this endpoint is
 *     reachable from a browser with the read-only stats token.
 */
import assert from 'node:assert/strict';
import { statsFeedback, statsTickets } from '../backend/src/analytics.js';

const HOUR = 60 * 60 * 1000;

/** A D1 stub that answers by matching the table each statement reads. */
class FeedbackD1 {
  constructor({ rows = {}, missing = new Set() } = {}) {
    this.rows = rows;
    this.missing = missing;
    this.bound = [];
  }
  prepare(sql) {
    const db = this;
    // The coverage probe reads three tables in one statement, so it has to be
    // recognised before the single-table patterns it also matches.
    const table = /oldest_notification_at/.test(sql) ? 'coverage'
      : /FROM subscription_notifications/.test(sql) ? 'subscription_notifications'
      : /FROM license_telegram_links/.test(sql) ? 'license_telegram_links'
      : /FROM telegram_updates/.test(sql) ? 'telegram_updates'
      : /FROM support_forward_outbox/.test(sql) ? 'support_forward_outbox'
      : 'coverage';
    const key = table === 'subscription_notifications'
      ? (/answer_code/.test(sql) ? 'winback' : 'stages')
      : table;
    const answer = () => {
      // The coverage probe reads all three tables in one statement, so any
      // missing one takes it down with them — exactly like real D1.
      const touched = key === 'coverage'
        ? ['subscription_notifications', 'telegram_updates', 'support_forward_outbox']
        : [table];
      for (const t of touched) {
        if (db.missing.has(t)) throw new Error(`D1_ERROR: no such table: ${t}`);
      }
      return db.rows[key];
    };
    return {
      bind(...args) { db.bound.push({ key, args }); return this; },
      async all() { return { results: answer() || [] }; },
      async first() { return answer() || null; }
    };
  }
}

const FULL_ROWS = {
  stages: [
    { stage: 'expiry_3d', queued: 10, sent: 8, cancelled: 2, pending: 0, stalled: 0 },
    { stage: 'expiry_1d', queued: 9, sent: 6, cancelled: 3, pending: 0, stalled: 0 },
    { stage: 'expired', queued: 6, sent: 5, cancelled: 0, pending: 1, stalled: 1 },
    { stage: 'winback', queued: 5, sent: 4, cancelled: 0, pending: 1, stalled: 0 }
  ],
  winback: [{ code: 'price', n: 2 }, { code: 'bugs', n: 1 }],
  license_telegram_links: { total: 12, in_window: 3 },
  telegram_updates: [
    { kind: 'sub_card', n: 20 },
    { kind: 'submit_ticket', n: 4 },
    { kind: 'incomplete', n: 1 }
  ],
  support_forward_outbox: {
    total: 7, forwarded: 6, pending: 1, exhausted: 0, oldest_pending_at: 1000
  },
  coverage: {
    oldest_notification_at: 500, oldest_update_at: 900, oldest_ticket_at: 100
  }
};

/* ---------------------- 1. the complete rollup ---------------------- */
{
  const stats = await statsFeedback({ DB: new FeedbackD1({ rows: FULL_ROWS }) }, 30);
  assert.equal(stats.ok, true);
  assert.deepEqual(stats.unavailable, [], 'a healthy schema reports nothing unavailable');

  assert.equal(stats.reminders.expiry_3d.sent, 8);
  assert.equal(stats.reminders.expiry_1d.cancelled, 3,
    'a cancelled reminder is a renewal before the send, and must stay visible');
  assert.equal(stats.reminders.expired.stalled, 1);

  assert.equal(stats.winback.sent, 4);
  assert.equal(stats.winback.answered, 3, 'answered is the sum of the choice counts');
  assert.equal(stats.winback.response_rate, 3 / 4);
  assert.deepEqual(stats.winback.reasons, [{ code: 'price', n: 2 }, { code: 'bugs', n: 1 }]);

  assert.equal(stats.telegram.linked_total, 12);
  assert.equal(stats.telegram.updates_total, 25);
  assert.equal(stats.support.forwarded, 6);
  assert.equal(stats.coverage.oldest_update_at, 900,
    'the dashboard needs the real history floor to warn about the 7-day prune');
}

/* ------------- 2. a stage that never fired is zero, not absent ------------- */
{
  const rows = { ...FULL_ROWS, stages: [], winback: [] };
  const stats = await statsFeedback({ DB: new FeedbackD1({ rows }) }, 30);
  assert.deepEqual(stats.reminders.winback,
    { queued: 0, sent: 0, cancelled: 0, pending: 0, stalled: 0 },
    'every stage must render, including the ones with no rows yet');
  assert.equal(stats.winback.response_rate, null,
    'an unasked question has no response rate — 0% would read as "nobody answered"');
}

/* ---------------- 3. one migration behind: degrade and say so ---------------- */
{
  const stats = await statsFeedback({
    DB: new FeedbackD1({ rows: FULL_ROWS, missing: new Set(['subscription_notifications']) })
  }, 30);
  assert.equal(stats.ok, true, 'a missing table must not take the whole view down');
  assert.equal(stats.reminders.expiry_3d.sent, 0);
  assert.equal(stats.support.forwarded, 6, 'readable sources still report their real numbers');
  for (const source of ['reminders', 'winback', 'coverage']) {
    assert.ok(stats.unavailable.includes(source),
      `${source} reads the missing table and must be named as unread`);
  }
  assert.ok(!stats.unavailable.includes('support'),
    'a source that answered must not be reported as unavailable');
}

/* -------------------- 4. the window is actually applied -------------------- */
{
  const db = new FeedbackD1({ rows: FULL_ROWS });
  const now = Date.now();
  await statsFeedback({ DB: db }, 7);
  const windowed = db.bound.find((b) => b.key === 'stages');
  assert.ok(Math.abs(windowed.args[0] - (now - 7 * 24 * HOUR)) < 5000,
    'days=7 must bind a 7-day cutoff, not scan all history');

  const all = new FeedbackD1({ rows: FULL_ROWS });
  await statsFeedback({ DB: all }, 0);
  assert.equal(all.bound.find((b) => b.key === 'stages').args[0], 0,
    'days=0 means all time');
}

/* ------------------ 5. tickets: newest first, no identity ------------------ */
class TicketKV {
  constructor(records) { this.records = new Map(Object.entries(records)); }
  async list({ prefix, cursor }) {
    // KV pages lexicographically, which is the whole trap: 1000 < 999.
    const names = [...this.records.keys()].filter((n) => n.startsWith(prefix)).sort();
    const start = Number(cursor) || 0;
    const page = names.slice(start, start + 1000);
    const end = start + page.length;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: end >= names.length,
      cursor: String(end)
    };
  }
  async get(name) { return this.records.get(name) || null; }
}

{
  const records = {};
  for (const no of [998, 999, 1000, 1001]) {
    records[`ticket:${no}`] = JSON.stringify({
      no, mode: no === 1001 ? 'winback' : 'ticket', status: 'open',
      at: '2026-08-20T10:00:00.000Z', text: `сообщение ${no}`,
      uid: '5550001', username: 'student', name: 'Аня Е.'
    });
  }
  const stats = await statsTickets({ LICENSES: new TicketKV(records) }, 2);
  assert.equal(stats.ok, true);
  assert.equal(stats.total_retained, 4);
  assert.deepEqual(stats.tickets.map((t) => t.no), [1001, 1000],
    'newest tickets are the highest numbers, not the lexicographically last keys');

  const [newest] = stats.tickets;
  assert.equal(newest.mode, 'winback');
  assert.equal(newest.text, 'сообщение 1001', 'the point of the endpoint is the text');
  for (const field of ['uid', 'username', 'name']) {
    assert.ok(!(field in newest),
      `${field} identifies the sender and must not leave the worker on a stats-token route`);
  }
  assert.equal(stats.counts.open, 2, 'open counts what is shown, per mode-independent status');
}

/* ---- 6. a body that expired out of KV is skipped, not rendered as null ---- */
{
  const kv = new TicketKV({
    'ticket:1010': JSON.stringify({ no: 1010, mode: 'feature', status: 'resolved', at: null, text: 'идея' }),
    'ticket:1011': 'not json',
    'ticket:1012': JSON.stringify({ no: 1012, mode: 'ticket', status: 'open', at: null, text: 'вопрос' })
  });
  kv.records.delete('ticket:1012');
  kv.records.set('ticket:1012', null);
  const stats = await statsTickets({ LICENSES: kv }, 50);
  assert.deepEqual(stats.tickets.map((t) => t.no), [1010],
    'unparsable and expired records drop out instead of becoming empty rows');
  assert.equal(stats.counts.feature, 1);
  assert.equal(stats.counts.open, 0, 'a resolved ticket is not open');
}

console.log('feedback stats regression passed');

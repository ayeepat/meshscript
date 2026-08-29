// Shared rig for the subscription-bot regressions.
//
// The interesting behaviour here lives in SQL — conditional upserts, claim
// compare-and-set, the release fence — so these tests run the real statements
// against the real schema.sql in an in-memory SQLite database rather than a
// hand-written fake that would happily agree with whatever the code does.

import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const schemaSql = await readFile(new URL('../../backend/schema.sql', import.meta.url), 'utf8');

class SqliteD1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const db = this.db;
    const statement = (args = []) => ({
      bind: (...bound) => statement(bound),
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first(column) {
        const row = db.prepare(sql).get(...args) ?? null;
        return column ? (row?.[column] ?? null) : row;
      },
      async run() {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) || 0 } };
      }
    });
    return statement();
  }
  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

class FakeKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, String(value)); }
  async list() { return { keys: [], list_complete: true }; }
}

/** Telegram capture. `status(body, url)` decides each reply's HTTP status. */
export function captureTelegram({ status = () => 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const body = JSON.parse(init?.body || 'null');
    const method = target.split('/').pop();
    const code = status(body, target, method);
    calls.push({ method, body, status: code });
    return {
      ok: code >= 200 && code < 300,
      status: code,
      body: { cancel: async () => {} }
    };
  };
  return {
    calls,
    sent: (method = 'sendMessage') => calls.filter((call) => call.method === method),
    texts: () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text),
    reset: () => { calls.length = 0; }
  };
}

export function createEnv(overrides = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  return {
    DB: new SqliteD1(db),
    LICENSES: new FakeKV(),
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    SUPPORT_CHAT_ID: '4242',
    DEVICE_LIMIT: '1',
    sqlite: db,
    ...overrides
  };
}

/** Write a license the way issuance does: KV row plus the D1 purchases mirror. */
export async function seedLicense(env, license) {
  const { putLicense } = await import('../../backend/src/licenses.js');
  return putLicense(env, {
    key: 'SMESH-AAAA-BBBB-CCCC',
    type: 'subscription',
    status: 'active',
    email: null,
    telegram_user_id: null,
    issued_at: new Date().toISOString(),
    expires_at: null,
    subscription_days: 30,
    subscription_duration_ms: 30 * 24 * 60 * 60 * 1000,
    subscription_started_at: null,
    payment_id: null,
    gateway: 'robokassa',
    amount_kopecks: 14900,
    amount_rub: 149,
    is_preorder: false,
    referral_code: null,
    device_ids: [],
    note: null,
    ...license
  });
}

/** An active installation holding the single device slot. */
export function seedActivation(env, key, deviceId, {
  activatedAt = Date.now() - 60_000, lastSeenAt = Date.now(), tokenHash = 'seeded-hash'
} = {}) {
  env.sqlite.prepare(
    `INSERT INTO license_activations
       (license_key, status, device_id, token_hash, generation,
        activated_at, last_seen_at, deactivated_at)
     VALUES (?, 'active', ?, ?, 1, ?, ?, NULL)`
  ).run(key, deviceId, tokenHash, activatedAt, lastSeenAt);
}

export const privateMessage = (text, { from = 777, chat = from, replyTo = null } = {}) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: {
    message_id: Math.floor(Math.random() * 1e6),
    chat: { id: chat, type: 'private' },
    from: { id: from, first_name: 'Аня', username: 'anya' },
    text,
    ...(replyTo ? { reply_to_message: { text: replyTo } } : {})
  }
});

export const callback = (data, { from = 777, messageText = 'card' } = {}) => ({
  update_id: Math.floor(Math.random() * 1e9),
  callback_query: {
    id: 'cq-1',
    from: { id: from, first_name: 'Аня', username: 'anya' },
    data,
    message: {
      message_id: 55,
      chat: { id: from, type: 'private' },
      text: messageText
    }
  }
});

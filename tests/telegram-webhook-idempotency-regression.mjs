/**
 * M-5: Telegram webhook processing must be idempotent AND retry-safe.
 *
 * The handler persisted no update_id and always answered 200. Replaying update
 * 777 produced tickets 1001 and 1002, two owner forwards and two user
 * confirmations; replaying an owner reply delivered it twice. In the other
 * direction, an internal exception was still acknowledged as success, so failed
 * processing could never be retried — even though Telegram defines update_id
 * precisely for ignoring repeats and retries any unacknowledged delivery.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';

const SECRET = 'telegram_webhook_secret_token_0123456789';
const schemaSql = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');

class MemoryKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

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
      async run() {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) || 0 } };
      }
    });
    return statement();
  }
  async batch(statements) {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
}

function context() {
  const promises = [];
  return {
    ctx: { waitUntil(p) { promises.push(Promise.resolve(p).catch(() => {})); } },
    async settle() { await Promise.all(promises); }
  };
}

// Every outbound Bot API call this update would make.
let sentCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.includes('api.telegram.org')) {
    sentCalls.push({
      method: target.split('/').pop(),
      body: init?.body ? JSON.parse(init.body) : null
    });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

function environment(sqlite) {
  return {
    DB: new SqliteD1(sqlite),
    LICENSES: new MemoryKV(),
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    SUPPORT_CHAT_ID: '4242',
    RUNTIME_WRITE_EPOCH: '1'
  };
}

function webhookRequest(update) {
  return new Request('https://api.example/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': SECRET
    },
    body: JSON.stringify(update)
  });
}

const userMessage = (updateId) => ({
  update_id: updateId,
  message: {
    message_id: 55,
    from: { id: 900123 },
    chat: { id: 900123, type: 'private' },
    text: 'У меня не работает решение задачи, помогите пожалуйста'
  }
});

const ownerReply = (updateId) => ({
  update_id: updateId,
  message: {
    message_id: 88,
    from: { id: 4242 },
    chat: { id: 4242, type: 'private' },
    text: 'Проверьте ещё раз — всё исправлено.',
    reply_to_message: {
      message_id: 77,
      text: '🆘 Обращение #1001\n\nОтветьте на это сообщение.\n#id900123'
    }
  }
});

const ticketCount = (sqlite) =>
  sqlite.prepare('SELECT COUNT(*) AS n FROM support_forward_outbox').get().n;

try {
  /* ---- a replayed update must produce NO second ticket or message ---- */
  {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(schemaSql);
    const env = environment(sqlite);

    sentCalls = [];
    const { ctx, settle } = context();
    const first = await worker.fetch(webhookRequest(userMessage(777)), env, ctx);
    await settle();
    assert.equal(first.status, 200);
    const ticketsAfterFirst = ticketCount(sqlite);
    const callsAfterFirst = sentCalls.length;
    assert.ok(callsAfterFirst > 0, 'the first delivery must actually do the work');

    const replayCtx = context();
    const replay = await worker.fetch(webhookRequest(userMessage(777)), env, replayCtx.ctx);
    await replayCtx.settle();
    assert.equal(replay.status, 200, 'a duplicate must still be acknowledged');
    assert.equal((await replay.json()).duplicate, true);
    assert.equal(ticketCount(sqlite), ticketsAfterFirst,
      'replaying an update must not mint a second ticket');
    assert.equal(sentCalls.length, callsAfterFirst,
      'replaying an update must not re-forward or re-confirm anything');

    // A DIFFERENT update id is genuinely new work.
    const freshCtx = context();
    const fresh = await worker.fetch(webhookRequest(userMessage(778)), env, freshCtx.ctx);
    await freshCtx.settle();
    assert.equal(fresh.status, 200);
    assert.equal(ticketCount(sqlite), ticketsAfterFirst + 1,
      'a new update id is new work');
  }

  /* ---- a failed update must NOT be acknowledged ---- */
  {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(schemaSql);
    const env = environment(sqlite);
    // Break ticket minting so processSupportUpdate throws.
    sqlite.exec('DROP TABLE counters');

    sentCalls = [];
    const { ctx, settle } = context();
    const failed = await worker.fetch(webhookRequest(userMessage(901)), env, ctx);
    await settle();
    assert.equal(failed.status, 500,
      'an internal failure must not be acknowledged as success — Telegram retries on non-2xx');

    // The claim was released, so Telegram's retry can take the update again
    // rather than being answered "duplicate" forever.
    const row = sqlite.prepare(
      'SELECT completed_at, lease_until FROM telegram_updates WHERE update_id = 901'
    ).get();
    assert.equal(row.completed_at, null, 'a failed update must not be marked complete');
    assert.equal(row.lease_until, 0, 'and its lease must be released for the retry');

    // Repair the cause; the retry now succeeds.
    sqlite.exec('CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    const retryCtx = context();
    const retry = await worker.fetch(webhookRequest(userMessage(901)), env, retryCtx.ctx);
    await retryCtx.settle();
    assert.equal(retry.status, 200, 'the retry of a released update must be processed');
    assert.equal(
      sqlite.prepare('SELECT completed_at FROM telegram_updates WHERE update_id = 901')
        .get().completed_at != null,
      true
    );
  }

  /* ---- a LOST completion write must not be acknowledged, and its retry
          must not mint a second ticket ---- */
  {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(schemaSql);
    const env = environment(sqlite);
    // Injected failure: the external effects succeed, then the completion
    // write is lost. The handler used to swallow that and still answer 200 —
    // completed_at stayed NULL, so once the lease expired Telegram's retry ran
    // the whole submission again: tickets 1001 AND 1002, four bot calls.
    const realDb = env.DB;
    let dropCompletion = true;
    env.DB = {
      prepare(sql) {
        if (dropCompletion && sql.includes('SET completed_at')) {
          const noop = () => ({
            bind: () => noop(),
            async first() { return null; },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 0 } }; }
          });
          return noop();
        }
        return realDb.prepare(sql);
      },
      batch: (statements) => realDb.batch(statements)
    };

    sentCalls = [];
    const { ctx, settle } = context();
    const lost = await worker.fetch(webhookRequest(userMessage(4242)), env, ctx);
    await settle();
    assert.equal(lost.status, 500,
      'a lost completion write must not be acknowledged as success');
    assert.equal(ticketCount(sqlite), 1);
    const callsAfterFirst = sentCalls.length;
    const ticketNo = sqlite.prepare(
      'SELECT ticket_no FROM telegram_updates WHERE update_id = 4242'
    ).get().ticket_no;
    assert.ok(ticketNo, 'the minted ticket must be bound to the update');

    // Telegram redelivers. The completion write works this time.
    dropCompletion = false;
    const retryCtx = context();
    const retry = await worker.fetch(webhookRequest(userMessage(4242)), env, retryCtx.ctx);
    await retryCtx.settle();
    assert.equal(retry.status, 200);
    assert.equal(ticketCount(sqlite), 1,
      'the retry must reuse the bound ticket, not mint a second one');
    assert.equal(
      sqlite.prepare('SELECT ticket_no FROM telegram_updates WHERE update_id = 4242').get().ticket_no,
      ticketNo
    );
    assert.equal(sentCalls.length, callsAfterFirst,
      'the retry must not re-confirm to the user or re-forward to the owner');
    assert.ok(
      sqlite.prepare('SELECT completed_at FROM telegram_updates WHERE update_id = 4242')
        .get().completed_at != null
    );
  }

  /* ---- an update still in flight is refused, not double-processed ---- */
  {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(schemaSql);
    const env = environment(sqlite);
    // Simulate a live delivery holding the claim.
    sqlite.prepare(
      'INSERT INTO telegram_updates (update_id, claimed_at, lease_until) VALUES (?, ?, ?)'
    ).run(555, Date.now(), Date.now() + 60_000);

    sentCalls = [];
    const { ctx, settle } = context();
    const concurrent = await worker.fetch(webhookRequest(userMessage(555)), env, ctx);
    await settle();
    assert.equal(concurrent.status, 409,
      'a concurrent delivery must be refused so Telegram retries after the lease');
    assert.equal(sentCalls.length, 0, 'and must do no work of its own');
    assert.equal(ticketCount(sqlite), 0);
  }

  /* ---- a lost completion write must not relay an OWNER reply twice ---- */
  {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(schemaSql);
    const env = environment(sqlite);
    const realDb = env.DB;
    let dropCompletion = true;
    env.DB = {
      prepare(sql) {
        if (dropCompletion && sql.includes('SET completed_at')) {
          const noop = () => ({
            bind: () => noop(),
            async first() { return null; },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 0 } }; }
          });
          return noop();
        }
        return realDb.prepare(sql);
      },
      batch: (statements) => realDb.batch(statements)
    };

    sentCalls = [];
    const firstCtx = context();
    const first = await worker.fetch(webhookRequest(ownerReply(4343)), env, firstCtx.ctx);
    await firstCtx.settle();
    assert.equal(first.status, 500, 'the lost completion must remain retryable');
    const callsAfterFirst = sentCalls.length;
    assert.ok(callsAfterFirst >= 1, 'the first delivery must actually attempt the relay');

    dropCompletion = false;
    const retryCtx = context();
    const retry = await worker.fetch(webhookRequest(ownerReply(4343)), env, retryCtx.ctx);
    await retryCtx.settle();
    assert.equal(retry.status, 200);
    assert.equal(sentCalls.length, callsAfterFirst,
      'the retry must not send the same owner reply to the student again');
  }

  /* ---- no idempotency registry means no external webhook effects ---- */
  {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(schemaSql);
    const env = environment(sqlite);
    delete env.DB;
    sentCalls = [];
    const { ctx, settle } = context();
    const unavailable = await worker.fetch(webhookRequest(ownerReply(4444)), env, ctx);
    await settle();
    assert.equal(unavailable.status, 503,
      'a valid update must fail closed when its dedupe authority is unavailable');
    assert.equal(sentCalls.length, 0,
      'processing without replay protection must not contact Telegram');
  }

  /* ---- a stale lease holder cannot mutate a newer delivery's claim ---- */
  {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(schemaSql);
    const env = environment(sqlite);
    const originalGet = env.LICENSES.get.bind(env.LICENSES);
    let seqReads = 0;
    let announcePause;
    let releasePause;
    const paused = new Promise((resolve) => { announcePause = resolve; });
    const gate = new Promise((resolve) => { releasePause = resolve; });
    env.LICENSES.get = async (key) => {
      if (key === 'seq:ticket' && ++seqReads === 1) {
        announcePause();
        await gate;
      }
      return originalGet(key);
    };

    sentCalls = [];
    const staleCtx = context();
    const stalePromise = worker.fetch(webhookRequest(userMessage(4545)), env, staleCtx.ctx);
    await paused;
    const firstVersion = sqlite.prepare(
      'SELECT claimed_at FROM telegram_updates WHERE update_id = 4545'
    ).get().claimed_at;

    // Simulate expiry while the first worker is suspended in an external KV
    // read. The retry takes ownership and finishes before the stale worker
    // resumes — every later mutation must be fenced by claimed_at.
    sqlite.prepare('UPDATE telegram_updates SET lease_until = 0 WHERE update_id = 4545').run();
    const winnerCtx = context();
    const winner = await worker.fetch(webhookRequest(userMessage(4545)), env, winnerCtx.ctx);
    await winnerCtx.settle();
    assert.equal(winner.status, 200);
    const callsAfterWinner = sentCalls.length;
    const winnerRow = sqlite.prepare(
      'SELECT claimed_at, completed_at, ticket_no FROM telegram_updates WHERE update_id = 4545'
    ).get();
    assert.ok(winnerRow.claimed_at > firstVersion, 'a takeover must get a newer fencing token');
    assert.ok(winnerRow.completed_at != null);

    releasePause();
    const stale = await stalePromise;
    await staleCtx.settle();
    assert.equal(stale.status, 500,
      'the stale worker must fail its completion instead of completing the winner claim');
    assert.equal(ticketCount(sqlite), 1, 'the stale worker must not create a second ticket');
    assert.equal(sentCalls.length, callsAfterWinner,
      'the stale worker must not repeat the winner delivery effects');
    assert.deepEqual(
      sqlite.prepare(
        'SELECT claimed_at, completed_at, ticket_no FROM telegram_updates WHERE update_id = 4545'
      ).get(),
      winnerRow,
      'stale release/completion attempts must not mutate the winner row'
    );
  }

  /* ---- an EXPIRED lease is recoverable, not a permanent block ---- */
  {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(schemaSql);
    const env = environment(sqlite);
    // A delivery that died mid-processing: claimed, never completed, lease gone.
    sqlite.prepare(
      'INSERT INTO telegram_updates (update_id, claimed_at, lease_until) VALUES (?, ?, ?)'
    ).run(556, Date.now() - 600_000, Date.now() - 300_000);

    sentCalls = [];
    const { ctx, settle } = context();
    const recovered = await worker.fetch(webhookRequest(userMessage(556)), env, ctx);
    await settle();
    assert.equal(recovered.status, 200,
      'an abandoned claim must be re-claimable rather than lost forever');
    assert.equal(ticketCount(sqlite), 1);
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log('telegram webhook idempotency regression passed');

// Regression (audit B-13): concurrent support submissions used to race the
// KV read-increment-write ticket counter — two messages both became «#1001»,
// one ticket record silently overwrote the other, and the per-user rate
// counter undercounted to 1. Ticket numbers now come from the atomic D1
// counters table (seeded once from the legacy KV value so numbering
// continues), and the rate limit is an atomic minute-bucket budget.
import assert from 'node:assert/strict';

const calls = [];
let fetchGate = null;
let fetchStatus = () => 200;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  const body = JSON.parse(init?.body || 'null');
  calls.push({ url: target, body });
  if (fetchGate) await fetchGate;
  const status = fetchStatus(body, target);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: async () => {} }
  };
};

const {
  processSupportUpdate,
  retryPendingSupportForwards
} = await import('../backend/src/delivery/support.js');

class FakeKV {
  store = new Map();
  failTicketPuts = false;
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) {
    if (this.failTicketPuts && key.startsWith('ticket:')) {
      throw new Error('simulated ticket persistence outage');
    }
    this.store.set(key, value);
  }
}

class FakeD1 {
  counters = new Map();
  budgets = new Map();
  outbox = new Map();
  prepare(sql) {
    const db = this;
    return {
      bind: (...args) => ({
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO counters')) {
            if (!db.counters.has(args[0])) db.counters.set(args[0], args[1]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INTO support_forward_outbox')) {
            const [ticketNo, sourceChatId, sourceMessageId, hasAttachment, createdAt, nextAttemptAt] = args;
            if (db.outbox.has(ticketNo)) return { meta: { changes: 0 } };
            db.outbox.set(ticketNo, {
              ticket_no: ticketNo,
              source_chat_id: sourceChatId,
              source_message_id: sourceMessageId,
              has_attachment: hasAttachment,
              created_at: createdAt,
              attempts: 0,
              next_attempt_at: nextAttemptAt,
              claim_token: null,
              lease_until: null,
              text_forwarded_at: null,
              attachment_forwarded_at: null,
              forwarded_at: null
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('SET attempts = ?2') && sql.includes('support_forward_outbox')) {
            const [ticketNo, attempts, nextAttemptAt, token, leaseUntil, expectedAttempts, now] = args;
            const row = db.outbox.get(ticketNo);
            if (!row || row.forwarded_at != null || row.attempts !== expectedAttempts ||
                (row.lease_until != null && row.lease_until > now)) {
              return { meta: { changes: 0 } };
            }
            Object.assign(row, {
              attempts,
              next_attempt_at: nextAttemptAt,
              claim_token: token,
              lease_until: leaseUntil
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('SET text_forwarded_at = ?2')) {
            const [ticketNo, at, token] = args;
            const row = db.outbox.get(ticketNo);
            if (!row || row.forwarded_at != null || row.claim_token !== token ||
                row.text_forwarded_at != null) return { meta: { changes: 0 } };
            row.text_forwarded_at = at;
            return { meta: { changes: 1 } };
          }
          if (sql.includes('SET attachment_forwarded_at = ?2')) {
            const [ticketNo, at, token] = args;
            const row = db.outbox.get(ticketNo);
            if (!row || row.forwarded_at != null || row.claim_token !== token ||
                row.attachment_forwarded_at != null) return { meta: { changes: 0 } };
            row.attachment_forwarded_at = at;
            return { meta: { changes: 1 } };
          }
          if (sql.includes('SET forwarded_at = ?2')) {
            const [ticketNo, at, token] = args;
            const row = db.outbox.get(ticketNo);
            if (!row || row.forwarded_at != null || row.claim_token !== token ||
                row.text_forwarded_at == null ||
                (row.has_attachment && row.attachment_forwarded_at == null)) {
              return { meta: { changes: 0 } };
            }
            Object.assign(row, {
              forwarded_at: at,
              source_chat_id: null,
              source_message_id: null,
              claim_token: null,
              lease_until: null
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('SET claim_token = NULL') && sql.includes('support_forward_outbox')) {
            const [ticketNo, token] = args;
            const row = db.outbox.get(ticketNo);
            if (!row || row.forwarded_at != null || row.claim_token !== token) {
              return { meta: { changes: 0 } };
            }
            row.claim_token = null;
            row.lease_until = null;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
        async first() {
          if (sql.includes('UPDATE counters SET value = value + 1')) {
            const next = (db.counters.get(args[0]) || 0) + 1;
            db.counters.set(args[0], next);
            return next; // .first('value')
          }
          if (sql.includes('INSERT INTO telemetry_budget')) {
            const [bucket, uid] = args;
            const id = `${bucket}|support_rate|${uid}`;
            const current = db.budgets.get(id) || 0;
            if (current > args[3]) return null;
            const count = Math.min(current + 1, args[2]);
            db.budgets.set(id, count);
            return count; // .first('count')
          }
          return null;
        },
        async all() {
          if (!sql.includes('FROM support_forward_outbox')) return { results: [] };
          const [maxAttempts, now, limit] = args;
          return {
            results: [...db.outbox.values()]
              .filter((row) =>
                row.forwarded_at == null &&
                row.attempts < maxAttempts &&
                row.next_attempt_at <= now &&
                (row.lease_until == null || row.lease_until <= now)
              )
              .sort((a, b) =>
                a.next_attempt_at - b.next_attempt_at ||
                a.created_at - b.created_at
              )
              .slice(0, limit)
              .map((row) => ({ ...row }))
          };
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

const message = (uid, text) => ({
  message: {
    chat: { id: uid },
    from: { id: uid, first_name: `User${uid}` },
    message_id: uid,
    text
  }
});

const resetFetch = () => {
  calls.length = 0;
  fetchGate = null;
  fetchStatus = () => 200;
};

/* ---- concurrent submissions get distinct numbers; no ticket is lost ---- */
{
  resetFetch();
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: db };
  calls.length = 0;
  const [a, b] = await Promise.all([
    processSupportUpdate(env, message(7001, 'первый вопрос')),
    processSupportUpdate(env, message(7002, 'второй вопрос'))
  ]);
  assert.equal(a.kind, 'submit_ticket');
  assert.equal(b.kind, 'submit_ticket');
  assert.notEqual(a.no, b.no, 'concurrent submissions must never share a ticket number');
  assert.deepEqual([a.no, b.no].sort(), [1001, 1002]);
  assert.ok(kv.store.has('ticket:1001') && kv.store.has('ticket:1002'),
    'both ticket records must exist — neither may overwrite the other');
  const owners = calls.filter((c) => String(c.body?.chat_id) === '42').map((c) => c.body.text);
  assert.ok(owners.some((t) => t.includes('#1001')) && owners.some((t) => t.includes('#1002')),
    'the owner must receive both tickets under their own numbers');
}

/* ---- numbering continues from the legacy KV counter ---- */
{
  resetFetch();
  const kv = new FakeKV();
  await kv.put('seq:ticket', '1042');
  const env = { TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: new FakeD1() };
  const r = await processSupportUpdate(env, message(7003, 'вопрос после миграции'));
  assert.equal(r.no, 1043, 'the D1 sequence must seed from the legacy KV counter');
  assert.equal(await kv.get('seq:ticket'), '1043', 'the KV mirror stays readable for ops');
}

/* ---- the rate limit actually counts concurrent messages ---- */
{
  resetFetch();
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: db };
  const burst = await Promise.all(Array.from({ length: 7 }, (_, i) =>
    processSupportUpdate(env, message(8001, `сообщение ${i}`))));
  const admitted = burst.filter((r) => r.kind === 'submit_ticket').length;
  const limited = burst.filter((r) => r.kind === 'rate_limited').length;
  assert.equal(admitted, 5, 'exactly RATE_LIMIT concurrent messages may pass');
  assert.equal(limited, 2, 'the excess must be rate limited, not silently admitted');
  const bucketCount = [...db.budgets.entries()].find(([id]) => id.includes('|support_rate|8001'));
  assert.equal(bucketCount?.[1], 6,
    'the atomic bucket must saturate once blocked instead of writing forever');
  const writesAtSaturation = db.budgets.get(bucketCount[0]);
  const rejected = await Promise.all(Array.from({ length: 25 }, (_, i) =>
    processSupportUpdate(env, message(8001, `ещё ${i}`))));
  assert.ok(rejected.every((result) => result.kind === 'rate_limited'));
  assert.equal(db.budgets.get(bucketCount[0]), writesAtSaturation,
    'continued rejected traffic must not mutate the shared D1 row');
}

/* ---- a ticket is never acknowledged or forwarded before it is durable ---- */
{
  resetFetch();
  const kv = new FakeKV();
  kv.failTicketPuts = true;
  const env = {
    TELEGRAM_BOT_TOKEN: 't',
    SUPPORT_CHAT_ID: '42',
    LICENSES: kv,
    DB: new FakeD1()
  };
  calls.length = 0;
  const result = await processSupportUpdate(env, message(8050, 'не потеряйте это обращение'));
  assert.equal(result.kind, 'service_unavailable');
  assert.equal([...kv.store.keys()].some((key) => key.startsWith('ticket:')), false);
  assert.equal(
    calls.some((call) =>
      String(call.body?.chat_id) === '42' &&
      String(call.body?.text || '').includes('не потеряйте это обращение')
    ),
    false,
    'an undurable ticket must not be forwarded as though it can later be resolved'
  );
  assert.ok(calls.some((call) =>
    String(call.body?.chat_id) === '8050' &&
    String(call.body?.text || '').includes('временно недоступна')
  ), 'the user must receive an explicit retry instruction');
}

/* ---- configured D1 failures never fall back to raceable KV state ---- */
{
  resetFetch();
  const kv = new FakeKV();
  const rateOutage = {
    prepare() { throw new Error('simulated support rate outage'); }
  };
  calls.length = 0;
  const rateResult = await processSupportUpdate({
    TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: rateOutage
  }, message(8101, 'не должно пройти без лимитера'));
  assert.equal(rateResult.kind, 'service_unavailable');
  assert.equal([...kv.store.keys()].some((key) => key.startsWith('rate:')), false,
    'a configured D1 outage must not reopen the concurrent KV rate-limit race');
  assert.ok(calls.some((call) => String(call.body?.chat_id) === '8101'),
    'the user must be told to retry instead of having Telegram silently ack a lost message');

  const counterOutage = new FakeD1();
  const originalPrepare = counterOutage.prepare.bind(counterOutage);
  counterOutage.prepare = (sql) => {
    if (sql.includes('UPDATE counters SET value')) {
      return { bind: () => ({ first: async () => { throw new Error('simulated ticket counter outage'); } }) };
    }
    return originalPrepare(sql);
  };
  calls.length = 0;
  const ticketResult = await processSupportUpdate({
    TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: counterOutage
  }, message(8102, 'не должно получить коллизионный номер'));
  assert.equal(ticketResult.kind, 'service_unavailable');
  assert.equal([...kv.store.keys()].some((key) => key.startsWith('ticket:')), false);
  assert.equal(kv.store.has('seq:ticket'), false,
    'the failed atomic counter must not fall back to read-increment-write');
}

/* ---- no DB: fail closed instead of reopening the raceable KV fallback ---- */
{
  resetFetch();
  const kv = new FakeKV();
  const env = { TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv };
  const r = await processSupportUpdate(env, message(9001, 'без базы'));
  assert.equal(r.kind, 'service_unavailable');
  assert.equal([...kv.store.keys()].some((key) =>
    key.startsWith('ticket:') || key.startsWith('rate:') || key === 'seq:ticket'), false,
  'a missing D1 binding must not route through raceable KV counters');
}

/* ---- no acceptance if the forwarding retry row was not persisted ---- */
{
  resetFetch();
  const kv = new FakeKV();
  const db = new FakeD1();
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes('INTO support_forward_outbox')) {
      return { bind: () => ({ run: async () => { throw new Error('simulated outbox outage'); } }) };
    }
    return originalPrepare(sql);
  };
  const result = await processSupportUpdate({
    TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: db
  }, message(9051, 'нужна гарантированная доставка'));
  assert.equal(result.kind, 'service_unavailable');
  assert.equal(db.outbox.size, 0);
  assert.equal(calls.some((call) =>
    String(call.body?.chat_id) === '9051' &&
    String(call.body?.text || '').includes('принято')), false,
  'the user must not see acceptance before the retry row is durable');
  assert.equal(calls.some((call) => String(call.body?.chat_id) === '42'), false,
    'a non-retryable ticket must not be forwarded as if the workflow were durable');
}

/* ---- missing/invalid owner routing can never produce an acceptance ---- */
for (const badOwner of [undefined, '', 'not-a-chat', '-100123']) {
  resetFetch();
  const kv = new FakeKV();
  const db = new FakeD1();
  const result = await processSupportUpdate({
    TELEGRAM_BOT_TOKEN: 't',
    SUPPORT_CHAT_ID: badOwner,
    LICENSES: kv,
    DB: db
  }, message(9101, 'это нельзя потерять'));
  assert.equal(result.kind, 'service_unavailable');
  assert.equal([...kv.store.keys()].some((key) => key.startsWith('ticket:')), false);
  assert.equal(db.outbox.size, 0);
  assert.equal(db.budgets.size, 0,
    'a configuration outage must not retain a user identifier in the rate table');
  assert.equal(calls.some((call) =>
    String(call.body?.text || '').includes('принято')), false,
  'bad SUPPORT_CHAT_ID must never make a submission look accepted');
}

/* ---- provider failure leaves a durable, body-free retry row ---- */
{
  resetFetch();
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: db };
  fetchStatus = (body) => String(body?.chat_id) === '42' ? 503 : 200;
  const update = message(9201, 'сохраните даже во время сбоя');
  update.message.document = { file_id: 'document-id' };
  const result = await processSupportUpdate(env, update);
  assert.equal(result.kind, 'submit_ticket',
    'a durable outbox lets the bot acknowledge despite a transient owner-forward failure');
  const row = db.outbox.get(String(result.no));
  assert.ok(row && row.forwarded_at == null);
  assert.equal(row.attempts, 1);
  assert.equal(row.claim_token, null, 'a completed failed attempt releases its lease');
  assert.equal('text' in row || 'body' in row || 'name' in row || 'username' in row, false,
    'D1 retry rows must not duplicate the ticket body or sender profile');
  assert.equal(row.source_chat_id, '9201');
  assert.equal(row.source_message_id, 9201);
  assert.ok(calls.some((call) =>
    String(call.body?.chat_id) === '9201' &&
    String(call.body?.text || '').includes('принято')
  ), 'the user acceptance is sent only after retry state is durable');

  fetchStatus = () => 200;
  row.next_attempt_at = Date.now() - 1;
  resetFetch();
  assert.deepEqual(await retryPendingSupportForwards(env), { retried: 1, forwarded: 1 });
  assert.ok(row.forwarded_at);
  assert.equal(row.source_chat_id, null,
    'settlement must erase the source chat identifier from D1');
  assert.equal(row.source_message_id, null,
    'settlement must erase the source message identifier from D1');
  assert.equal(calls.filter((call) => call.url.endsWith('/sendMessage')).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith('/copyMessage')).length, 1);
}

/* ---- a live lease prevents a second cron sweep from lapping Telegram ---- */
{
  resetFetch();
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: db };
  fetchStatus = (body) => String(body?.chat_id) === '42' ? 503 : 200;
  const initial = await processSupportUpdate(env, message(9301, 'медленная доставка'));
  const row = db.outbox.get(String(initial.no));
  row.next_attempt_at = Date.now() - 1;
  fetchStatus = () => 200;
  let releaseFetch;
  fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  calls.length = 0;
  const slowSweep = retryPendingSupportForwards(env);
  while (!calls.length) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(row.lease_until > Date.now());
  row.next_attempt_at = Date.now() - 1;
  assert.deepEqual(await retryPendingSupportForwards(env), { retried: 0, forwarded: 0 },
    'an overlapping sweep must not reclaim an in-flight provider operation');
  releaseFetch();
  fetchGate = null;
  assert.deepEqual(await slowSweep, { retried: 1, forwarded: 1 });
}

/* ---- partial attachment failure retries only the unfinished operation ---- */
{
  resetFetch();
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: db };
  fetchStatus = (_body, url) => url.endsWith('/copyMessage') ? 503 : 200;
  const update = message(9351, 'в сообщении есть файл');
  update.message.document = { file_id: 'document-id' };
  const initial = await processSupportUpdate(env, update);
  const row = db.outbox.get(String(initial.no));
  assert.ok(row.text_forwarded_at, 'the successful text leg is durably checkpointed');
  assert.equal(row.attachment_forwarded_at, null);
  assert.equal(calls.filter((call) =>
    call.url.endsWith('/sendMessage') && String(call.body?.chat_id) === '42').length, 1);

  row.next_attempt_at = Date.now() - 1;
  resetFetch();
  assert.deepEqual(await retryPendingSupportForwards(env), { retried: 1, forwarded: 1 });
  assert.equal(calls.filter((call) =>
    call.url.endsWith('/sendMessage') && String(call.body?.chat_id) === '42').length, 0,
  'a retry must not duplicate an already-checkpointed owner message');
  assert.equal(calls.filter((call) => call.url.endsWith('/copyMessage')).length, 1);
  assert.ok(row.forwarded_at);
}

/* ---- owner confirmation reflects the relay result, not merely the attempt ---- */
{
  resetFetch();
  const kv = new FakeKV();
  const env = { TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: new FakeD1() };
  fetchStatus = (body) => String(body?.chat_id) === '9401' ? 403 : 200;
  const reply = await processSupportUpdate(env, {
    message: {
      chat: { id: 42 },
      from: { id: 42, first_name: 'Owner' },
      message_id: 5,
      text: 'ответ',
      reply_to_message: { text: '🆘 Обращение #1\n\n#id9401' }
    }
  });
  assert.equal(reply.kind, 'owner_reply');
  assert.equal(reply.delivered, false);
  assert.equal(calls.some((call) =>
    String(call.body?.chat_id) === '42' &&
    String(call.body?.text || '').startsWith('✓')), false,
  'the owner must not see a false success confirmation');
  assert.ok(calls.some((call) =>
    String(call.body?.chat_id) === '42' &&
    String(call.body?.text || '').includes('Не удалось')));
}

/* ---- a wedged ticket KV read cannot outlive the exclusive D1 lease ---- */
{
  resetFetch();
  const kv = new FakeKV();
  const db = new FakeD1();
  const initialEnv = {
    TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: db
  };
  fetchStatus = (body) => String(body?.chat_id) === '42' ? 503 : 200;
  const initial = await processSupportUpdate(
    initialEnv,
    message(9451, 'проверьте зависший KV')
  );
  const row = db.outbox.get(String(initial.no));
  row.next_attempt_at = Date.now() - 1;
  const hangingEnv = {
    ...initialEnv,
    LICENSES: { get: async () => new Promise(() => {}) },
    SUPPORT_KV_TIMEOUT_MS: '100'
  };
  const started = Date.now();
  assert.deepEqual(
    await retryPendingSupportForwards(hangingEnv),
    { retried: 1, forwarded: 0 }
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(row.claim_token, null,
    'a timed-out ticket read must release its token-bound lease for backoff retry');
}

/* ---- every forwarded Telegram text stays within the provider limit ---- */
{
  resetFetch();
  const kv = new FakeKV();
  const env = { TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kv, DB: new FakeD1() };
  await processSupportUpdate(env, message(9501, 'Я'.repeat(10_000)));
  await processSupportUpdate(env, {
    message: {
      chat: { id: 42 },
      from: { id: 42, first_name: 'Owner' },
      message_id: 6,
      text: 'О'.repeat(10_000),
      reply_to_message: { text: '🆘 Обращение #2\n\n#id9501' }
    }
  });
  for (const call of calls.filter((entry) => entry.url.endsWith('/sendMessage'))) {
    assert.ok(call.body.text.length <= 4096,
      `Telegram text exceeded 4096 characters: ${call.body.text.length}`);
  }
  const ownerForward = calls.find((call) =>
    String(call.body?.chat_id) === '42' &&
    String(call.body?.text || '').includes('Ответьте на это сообщение'));
  assert.ok(ownerForward.body.text.endsWith('#id9501'),
    'length clipping must preserve the owner-reply routing tag');
}

console.log('support ticket atomicity regressions passed');

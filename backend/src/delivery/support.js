/**
 * Support & feedback bot for СМЭШ AI.
 *
 * Menu-driven (/start):
 *   🆘 Создать обращение  → user describes a problem → routed to the owner
 *   💡 Предложить идею     → user describes an idea    → routed to the owner
 *
 * Each submission gets a sequential number (#1001, #1002, …), is stored in KV
 * (90-day history) and forwarded to SUPPORT_CHAT_ID with the sender's name. The
 * owner answers by *replying* to that message (the #id<uid> tag carries the
 * route). The user's confirmation carries a «✅ Вопрос решён» button that closes
 * their own ticket.
 *
 * Also: /help, a 5-messages/minute per-user rate limit, and a returned step log
 * (for /telegram/debug). Ticket bodies live in KV; the sequence and rate
 * budgets and the owner-forwarding outbox live authoritatively in D1 so
 * concurrent updates cannot collide and provider outages cannot lose tickets.
 */

import { fetchDelivery } from './http.js';

const TICKET_TTL = 60 * 60 * 24 * 90; // keep ticket records 90 days
const RATE_LIMIT = 5;                 // messages…
const TELEGRAM_TEXT_LIMIT = 4096;
export const SUPPORT_FORWARD_MAX_ATTEMPTS = 30;
const SUPPORT_FORWARD_LEASE_MS = 2 * 60_000;
const DEFAULT_SUPPORT_KV_TIMEOUT_MS = 5_000;

const WELCOME =
  'Здравствуйте! 👋 Это бот поддержки СМЭШ AI.\n\nЧем можем помочь? Выберите вариант ниже:';
const HELP_TEXT =
  'ℹ️ Бот поддержки СМЭШ AI\n\n' +
  'Здесь можно:\n' +
  '🆘 Создать обращение — задать вопрос или сообщить о проблеме\n' +
  '💡 Предложить идею — предложить, что добавить или улучшить\n\n' +
  'Нажмите /start, чтобы открыть меню. Мы ответим вам прямо в этом чате.';
const TICKET_PROMPT =
  '🆘 Опишите вашу проблему или вопрос одним сообщением — я сразу передам его в поддержку.';
const FEATURE_PROMPT =
  '💡 Расскажите о вашей идее одним сообщением — что бы вы хотели добавить или улучшить?';
const TEMPORARILY_UNAVAILABLE =
  '⚠️ Поддержка временно недоступна. Пожалуйста, отправьте сообщение ещё раз через несколько минут.';

const MENU = {
  inline_keyboard: [
    [{ text: '🆘 Создать обращение', callback_data: 'new_ticket' }],
    [{ text: '💡 Предложить идею', callback_data: 'new_feature' }]
  ]
};

// The routing tag is ALWAYS appended by routeSubmission after the user's own
// text, so the LAST match is ours. Matching the first would let a user write
// "#id<someone else>" in their ticket body and have the owner's reply DM'd to
// an arbitrary Telegram account.
const ID_RE = /#id(\d+)(?![\s\S]*#id\d)/;
const senderName = (u = {}) => [u.first_name, u.last_name].filter(Boolean).join(' ') || 'без имени';

function clipText(value, max, suffix = '') {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const keep = Math.max(0, max - suffix.length);
  let clipped = text.slice(0, keep);
  // Never leave an unpaired high surrogate at the end of a Telegram message.
  if (/[\uD800-\uDBFF]$/.test(clipped)) clipped = clipped.slice(0, -1);
  return clipped + suffix;
}

function telegramUserId(value) {
  const id = String(value ?? '').trim();
  if (!/^[1-9]\d{0,18}$/.test(id)) return null;
  try {
    return BigInt(id) <= 9_223_372_036_854_775_807n ? id : null;
  } catch {
    return null;
  }
}

function telegramChatId(value) {
  const id = String(value ?? '').trim();
  if (!/^-?[1-9]\d{0,18}$/.test(id)) return null;
  try {
    const parsed = BigInt(id);
    return parsed >= -9_223_372_036_854_775_808n &&
      parsed <= 9_223_372_036_854_775_807n ? id : null;
  } catch {
    return null;
  }
}

function supportOwnerId(env) {
  return telegramUserId(env.SUPPORT_CHAT_ID);
}

export function supportConfigValid(env) {
  // No bot token means the support integration is intentionally disabled.
  // Once the webhook bot is enabled, however, silently accepting no/invalid
  // owner route would strand every durable ticket in its outbox.
  return !env.TELEGRAM_BOT_TOKEN || !!supportOwnerId(env);
}

function supportKvTimeoutMs(env) {
  const configured = Number(env.SUPPORT_KV_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured >= 100 && configured <= 10_000
    ? configured
    : DEFAULT_SUPPORT_KV_TIMEOUT_MS;
}

async function boundedSupportKv(env, operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('support KV timeout')),
          supportKvTimeoutMs(env)
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function tg(env, method, body) {
  const payload = { ...body };
  if ((method === 'sendMessage' || method === 'editMessageText') && 'text' in payload) {
    payload.text = clipText(payload.text, TELEGRAM_TEXT_LIMIT);
  }
  let r;
  try {
    r = await fetchDelivery(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual'
    });
  } catch {
    // Fetch errors may include the token-bearing URL. Return a stable error
    // without ever logging or persisting the raw exception.
    console.error('telegram', method, 'network_error');
    return { method, to: payload.chat_id, status: 0, ok: false, error: 'network_error' };
  }
  const step = { method, to: payload.chat_id, status: r.status, ok: r.ok };
  if (!r.ok) {
    step.error = 'api_error';
    console.error('telegram', method, r.status);
  }
  try { await r.body?.cancel(); } catch { /* already closed */ }
  return step;
}

const askTicket = (env, chatId) => tg(env, 'sendMessage', {
  chat_id: chatId, text: TICKET_PROMPT,
  reply_markup: { force_reply: true, input_field_placeholder: 'Ваше сообщение…' }
});
const askFeature = (env, chatId) => tg(env, 'sendMessage', {
  chat_id: chatId, text: FEATURE_PROMPT,
  reply_markup: { force_reply: true, input_field_placeholder: 'Ваша идея…' }
});
const showMenu = (env, chatId, lead) => tg(env, 'sendMessage', {
  chat_id: chatId, text: lead, reply_markup: MENU
});

// Sequential ticket number from the atomic D1 counter. The historical KV
// read-increment-write let two concurrent submissions both receive «#1001»:
// one ticket:<no> record silently overwrote the other, losing a user's
// ticket and confusing the resolve button. Seeded once from the legacy KV
// counter so numbering continues; INSERT OR IGNORE makes concurrent first
// calls converge on one seed. A missing D1 binding fails closed: falling back
// to KV would recreate the exact lost-update race this counter exists to fix.
/**
 * The ticket number for THIS Telegram update, minting one only if the update
 * has not already produced one.
 *
 * A ticket is a non-idempotent effect: the counter moves. Binding it to
 * update_id is what makes the whole submission replay-safe, because every
 * downstream artefact (the KV record, the outbox row, the confirmation) is
 * keyed by the number. Without the binding, a completion write that failed —
 * or a worker that died before recording it — let Telegram's retry mint a
 * SECOND ticket for the same message once the lease expired.
 *
 * Reading before writing is safe here: only the delivery holding the lease
 * reaches this code, so there is no concurrent minter for the same update.
 *
 * Returns { no, fresh } — `fresh` is false on a replay, which is the signal to
 * skip the user-facing confirmation.
 */
async function reserveTicketNo(env, updateId, claimVersion) {
  if (!env.DB) throw new Error('support ticket counter unavailable');
  if (updateId == null) return { no: await nextTicketNo(env), fresh: true };
  if (!Number.isSafeInteger(claimVersion)) throw new Error('support update claim unavailable');

  const bound = await env.DB.prepare(
    'SELECT ticket_no FROM telegram_updates WHERE update_id = ?1'
  ).bind(updateId).first();
  if (bound?.ticket_no) return { no: Number(bound.ticket_no), fresh: false };

  const no = await nextTicketNo(env);
  const boundByUs = await env.DB.prepare(
    `UPDATE telegram_updates SET ticket_no = ?2
     WHERE update_id = ?1 AND ticket_no IS NULL
       AND claimed_at = ?3 AND completed_at IS NULL`
  ).bind(updateId, String(no), claimVersion).run();
  if ((boundByUs?.meta?.changes || 0) > 0) return { no, fresh: true };

  // A retry may have taken over while this worker awaited the counter/KV. It
  // either bound the canonical number already, or this stale worker must stop.
  const winner = await env.DB.prepare(
    'SELECT ticket_no FROM telegram_updates WHERE update_id = ?1'
  ).bind(updateId).first();
  if (winner?.ticket_no) return { no: Number(winner.ticket_no), fresh: false };
  throw new Error('support update lease changed');
}

/**
 * Atomically record a non-repeatable Telegram effect before it is attempted.
 * Telegram sendMessage has no idempotency key; if the network send succeeds
 * and our completion write is lost, retrying the effect would deliver twice.
 */
async function reserveTelegramUpdateEffect(env, updateId, claimVersion, effectKind) {
  if (updateId == null) return true;
  if (!env.DB || !Number.isSafeInteger(claimVersion)) {
    throw new Error('telegram update effect registry unavailable');
  }
  const marked = await env.DB.prepare(
    `UPDATE telegram_updates SET result_kind = ?3
     WHERE update_id = ?1 AND claimed_at = ?2 AND completed_at IS NULL
       AND result_kind IS NULL`
  ).bind(updateId, claimVersion, effectKind).run();
  if ((marked?.meta?.changes || 0) > 0) return true;
  const existing = await env.DB.prepare(
    'SELECT completed_at, result_kind FROM telegram_updates WHERE update_id = ?1'
  ).bind(updateId).first();
  if (existing?.completed_at == null && existing?.result_kind === effectKind) return false;
  throw new Error('telegram update effect claim changed');
}

async function nextTicketNo(env) {
  if (!env.DB) throw new Error('support ticket counter unavailable');
  try {
    const legacy = Number(await env.LICENSES.get('seq:ticket'));
    const seed = Number.isSafeInteger(legacy) && legacy >= 1000 ? legacy : 1000;
    await env.DB.prepare(
      'INSERT OR IGNORE INTO counters (name, value) VALUES (?1, ?2)'
    ).bind('support_ticket', seed).run();
    const next = Number(await env.DB.prepare(
      'UPDATE counters SET value = value + 1 WHERE name = ?1 RETURNING value'
    ).bind('support_ticket').first('value'));
    if (Number.isSafeInteger(next) && next > 0) {
      // Ops-visibility mirror only; the D1 row is the authority.
      await env.LICENSES.put('seq:ticket', String(next)).catch(() => {});
      return next;
    }
    throw new Error('support ticket counter returned no value');
  } catch (e) {
    console.error('support ticket counter unavailable', e?.name || 'error');
    throw new Error('support ticket counter unavailable');
  }
}

// Per-user rate limit on fixed one-minute buckets, counted atomically in D1
// (the KV read-modify-write undercounted under concurrency, so a burst never
// actually tripped it). Bucket rows age out with the telemetry_budget prune.
async function checkRate(env, uid) {
  if (!env.DB) {
    return { count: 0, blocked: true, justBlocked: false, unavailable: true };
  }
  try {
    const bucket = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
    const rawCount = await env.DB.prepare(
      `INSERT INTO telemetry_budget (day, scope, budget_key, count) VALUES (?1, 'support_rate', ?2, 1)
       ON CONFLICT(day, scope, budget_key) DO UPDATE SET
         count = MIN(telemetry_budget.count + 1, ?3)
       WHERE telemetry_budget.count <= ?4
       RETURNING count`
    ).bind(bucket, String(uid), RATE_LIMIT + 1, RATE_LIMIT).first('count');
    // Once the shared row is saturated, SQLite's conditional UPDATE is a
    // no-op and RETURNING yields no row. Continue rejecting without turning
    // every abusive message into another D1 write.
    if (rawCount == null) {
      return { count: RATE_LIMIT + 1, blocked: true, justBlocked: false };
    }
    const count = Number(rawCount) || 0;
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error('support rate counter returned no value');
    }
    return { count, blocked: count > RATE_LIMIT, justBlocked: count === RATE_LIMIT + 1 };
  } catch (e) {
    console.error('support rate counter unavailable', e?.name || 'error');
    return { count: 0, blocked: true, justBlocked: false, unavailable: true };
  }
}

function supportForwardBackoffMs(attempts) {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

async function enqueueSupportForward(env, no, msg) {
  if (!env.DB) throw new Error('support forward outbox unavailable');
  const hasAttachment = !!(msg.photo || msg.document);
  const sourceChatId = hasAttachment ? telegramChatId(msg.chat?.id) : null;
  const sourceMessageId = hasAttachment ? Number(msg.message_id) : null;
  if (hasAttachment &&
      (!sourceChatId ||
       !Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0)) {
    throw new Error('support attachment route unavailable');
  }
  const now = Date.now();
  // OR IGNORE: a replayed update reuses its bound ticket number, so this row
  // may already exist — complete with its forwarded markers. A plain INSERT
  // threw on the primary key and turned a harmless retry into a failure.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO support_forward_outbox
       (ticket_no, source_chat_id, source_message_id, has_attachment,
        created_at, attempts, next_attempt_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)`
  ).bind(
    String(no),
    sourceChatId,
    sourceMessageId,
    hasAttachment ? 1 : 0,
    now,
    now
  ).run();
  return {
    ticket_no: String(no),
    source_chat_id: sourceChatId,
    source_message_id: sourceMessageId,
    has_attachment: hasAttachment ? 1 : 0,
    attempts: 0,
    text_forwarded_at: null,
    attachment_forwarded_at: null
  };
}

async function claimSupportForward(env, ticketNo, expectedAttempts) {
  if (!env.DB) return null;
  const now = Date.now();
  const attempts = expectedAttempts + 1;
  const claimToken = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE support_forward_outbox
     SET attempts = ?2, next_attempt_at = ?3, claim_token = ?4, lease_until = ?5
     WHERE ticket_no = ?1 AND forwarded_at IS NULL AND attempts = ?6
       AND (lease_until IS NULL OR lease_until <= ?7)`
  ).bind(
    String(ticketNo),
    attempts,
    now + supportForwardBackoffMs(attempts),
    claimToken,
    now + SUPPORT_FORWARD_LEASE_MS,
    expectedAttempts,
    now
  ).run();
  return (claimed?.meta?.changes || 0) > 0 ? claimToken : null;
}

async function markSupportForwardPart(env, ticketNo, claimToken, column) {
  // column is selected internally, never derived from request data.
  const sql = column === 'attachment_forwarded_at'
    ? `UPDATE support_forward_outbox SET attachment_forwarded_at = ?2
       WHERE ticket_no = ?1 AND forwarded_at IS NULL AND claim_token = ?3
         AND attachment_forwarded_at IS NULL`
    : `UPDATE support_forward_outbox SET text_forwarded_at = ?2
       WHERE ticket_no = ?1 AND forwarded_at IS NULL AND claim_token = ?3
         AND text_forwarded_at IS NULL`;
  const marked = await env.DB.prepare(sql)
    .bind(String(ticketNo), Date.now(), claimToken).run();
  return (marked?.meta?.changes || 0) > 0;
}

async function settleSupportForward(env, ticketNo, claimToken) {
  const settled = await env.DB.prepare(
    `UPDATE support_forward_outbox
     SET forwarded_at = ?2, source_chat_id = NULL, source_message_id = NULL,
         claim_token = NULL, lease_until = NULL
     WHERE ticket_no = ?1 AND forwarded_at IS NULL AND claim_token = ?3
       AND text_forwarded_at IS NOT NULL
       AND (has_attachment = 0 OR attachment_forwarded_at IS NOT NULL)`
  ).bind(String(ticketNo), Date.now(), claimToken).run();
  return (settled?.meta?.changes || 0) > 0;
}

async function releaseSupportForwardClaim(env, ticketNo, claimToken) {
  try {
    await env.DB.prepare(
      `UPDATE support_forward_outbox
       SET claim_token = NULL, lease_until = NULL
       WHERE ticket_no = ?1 AND forwarded_at IS NULL AND claim_token = ?2`
    ).bind(String(ticketNo), claimToken).run();
  } catch (e) {
    console.error('support forward release failed', e?.name || 'error');
  }
}

function parseTicket(raw, expectedNo) {
  let ticket;
  try { ticket = JSON.parse(raw); } catch { return null; }
  if (!ticket || typeof ticket !== 'object') return null;
  const uid = telegramUserId(ticket.uid);
  if (!uid || String(ticket.no) !== String(expectedNo)) return null;
  return {
    no: String(expectedNo),
    mode: ticket.mode === 'feature' ? 'feature' : 'ticket',
    uid,
    name: clipText(ticket.name || 'без имени', 128),
    username: clipText(ticket.username || '', 64),
    text: clipText(ticket.text || '[вложение без текста]', 4000)
  };
}

function ownerForwardText(ticket) {
  const header = ticket.mode === 'feature'
    ? `💡 Предложение #${ticket.no}`
    : `🆘 Обращение #${ticket.no}`;
  const handle = ticket.username ? `@${ticket.username}` : '—';
  const prefix = `${header}\nОт: ${ticket.name} (${handle})\n\n`;
  const suffix =
    '\n\nОтветьте на это сообщение, чтобы написать пользователю.\n' +
    `#id${ticket.uid}`;
  const bodyLimit = Math.max(0, TELEGRAM_TEXT_LIMIT - prefix.length - suffix.length);
  return prefix + clipText(ticket.text, bodyLimit, bodyLimit > 1 ? '…' : '') + suffix;
}

async function runClaimedSupportForward(env, row, claimToken, ownerId) {
  const steps = [];
  let settled = false;
  try {
    // Ticket KV is a projection read inside a finite D1 lease. Bound it just
    // like the provider fetch so a wedged namespace cannot let a later cron
    // reclaim this row while the first worker remains stuck.
    const raw = await boundedSupportKv(
      env,
      () => env.LICENSES.get(`ticket:${row.ticket_no}`)
    );
    const ticket = raw ? parseTicket(raw, row.ticket_no) : null;
    if (!ticket) throw new Error('support ticket unavailable');

    let textForwarded = row.text_forwarded_at != null;
    if (!textForwarded) {
      const sent = await tg(env, 'sendMessage', {
        chat_id: ownerId,
        text: ownerForwardText(ticket)
      });
      steps.push(sent);
      if (!sent.ok) return { steps, settled: false };
      textForwarded = await markSupportForwardPart(
        env, row.ticket_no, claimToken, 'text_forwarded_at'
      );
      if (!textForwarded) return { steps, settled: false };
    }

    let attachmentForwarded =
      !row.has_attachment || row.attachment_forwarded_at != null;
    if (!attachmentForwarded) {
      const copied = await tg(env, 'copyMessage', {
        chat_id: ownerId,
        from_chat_id: row.source_chat_id,
        message_id: row.source_message_id
      });
      steps.push(copied);
      if (!copied.ok) return { steps, settled: false };
      attachmentForwarded = await markSupportForwardPart(
        env, row.ticket_no, claimToken, 'attachment_forwarded_at'
      );
      if (!attachmentForwarded) return { steps, settled: false };
    }

    settled = textForwarded && attachmentForwarded &&
      await settleSupportForward(env, row.ticket_no, claimToken);
    return { steps, settled };
  } finally {
    if (!settled) {
      await releaseSupportForwardClaim(env, row.ticket_no, claimToken);
    }
  }
}

async function attemptSupportForward(env, row, ownerId) {
  const expectedAttempts = Number(row.attempts);
  if (!Number.isSafeInteger(expectedAttempts) || expectedAttempts < 0) {
    return { claimed: false, settled: false, steps: [] };
  }
  let claimToken;
  try {
    claimToken = await claimSupportForward(
      env, row.ticket_no, expectedAttempts
    );
  } catch (e) {
    console.error('support forward claim failed', e?.name || 'error');
    return { claimed: false, settled: false, steps: [] };
  }
  if (!claimToken) return { claimed: false, settled: false, steps: [] };
  try {
    const result = await runClaimedSupportForward(env, row, claimToken, ownerId);
    return { claimed: true, ...result };
  } catch (e) {
    console.error('support forward failed', e?.name || 'error');
    return { claimed: true, settled: false, steps: [] };
  }
}

/**
 * Re-drive due owner forwards. The scan is bounded, and each row is claimed
 * by compare-and-set before Telegram is contacted, so overlapping cron runs
 * cannot forward the same ticket concurrently.
 */
export async function retryPendingSupportForwards(env, limit = 10) {
  const ownerId = supportOwnerId(env);
  if (!env.DB || !env.LICENSES || !env.TELEGRAM_BOT_TOKEN || !ownerId) {
    return { retried: 0, forwarded: 0 };
  }
  const requestedLimit = Number(limit);
  const boundedLimit = Math.max(1, Math.min(
    25,
    Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 10
  ));
  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT ticket_no, source_chat_id, source_message_id, has_attachment,
              attempts, text_forwarded_at, attachment_forwarded_at
       FROM support_forward_outbox
       WHERE forwarded_at IS NULL AND attempts < ?1 AND next_attempt_at <= ?2
         AND (lease_until IS NULL OR lease_until <= ?2)
       ORDER BY next_attempt_at, created_at LIMIT ?3`
    ).bind(SUPPORT_FORWARD_MAX_ATTEMPTS, Date.now(), boundedLimit).all();
  } catch (e) {
    console.error('support forward scan failed', e?.name || 'error');
    return { retried: 0, forwarded: 0 };
  }

  let retried = 0;
  let forwarded = 0;
  for (const row of rows?.results || []) {
    const result = await attemptSupportForward(env, row, ownerId);
    if (!result.claimed) continue;
    retried += 1;
    if (result.settled) forwarded += 1;
  }
  return { retried, forwarded };
}

export async function processSupportUpdate(
  env, update, { updateId = null, claimVersion = null } = {}
) {
  if (!env.TELEGRAM_BOT_TOKEN) return { kind: 'skip', reason: 'no_token' };
  const steps = [];
  const ownerId = supportOwnerId(env) || '';

  // ---- Button taps ----
  const cq = update.callback_query;
  if (cq) {
    const chatId = cq.message?.chat?.id;
    const data = cq.data || '';
    if (data === 'new_ticket') {
      steps.push(await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id }));
      if (chatId) steps.push(await askTicket(env, chatId));
      return { kind: 'callback_ticket', steps };
    }
    if (data === 'new_feature') {
      steps.push(await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id }));
      if (chatId) steps.push(await askFeature(env, chatId));
      return { kind: 'callback_feature', steps };
    }
    if (data.startsWith('resolve:')) {
      const r = await resolveTicket(env, { cq, ownerId });
      steps.push(...r.steps);
      return { kind: 'resolve', no: r.no, steps };
    }
    steps.push(await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id }));
    return { kind: 'callback_unknown', data, steps };
  }

  const msg = update.message;
  if (!msg || !msg.chat) return { kind: 'ignored', reason: 'no_message', steps };

  const chatId = msg.chat.id;
  if (!ownerId) {
    steps.push(await tg(env, 'sendMessage', { chat_id: chatId, text: TEMPORARILY_UNAVAILABLE }));
    return { kind: 'service_unavailable', steps };
  }
  const isOwner = ownerId && String(chatId) === ownerId;
  const text = msg.text || msg.caption || '';
  const replyText = msg.reply_to_message?.text || msg.reply_to_message?.caption || '';

  // ---- Rate limit (regular users only; never the owner) ----
  if (!isOwner) {
    const rl = await checkRate(env, msg.from?.id || chatId);
    if (rl.unavailable) {
      steps.push(await tg(env, 'sendMessage', { chat_id: chatId, text: TEMPORARILY_UNAVAILABLE }));
      return { kind: 'service_unavailable', steps };
    }
    if (rl.blocked) {
      if (rl.justBlocked) steps.push(await tg(env, 'sendMessage', {
        chat_id: chatId, text: '⏳ Слишком много сообщений подряд. Подождите минуту и попробуйте снова.'
      }));
      return { kind: 'rate_limited', count: rl.count, steps };
    }
  }

  // ---- Owner replying to a routed ticket/idea → relay to that user ----
  if (isOwner && replyText) {
    const m = replyText.match(ID_RE);
    if (m) {
      if (text) {
        const shouldRelay = await reserveTelegramUpdateEffect(
          env, updateId, claimVersion, 'owner_reply_started'
        );
        if (!shouldRelay) {
          return { kind: 'owner_reply_replay', to: m[1], delivered: null, steps };
        }
        const to = telegramUserId(m[1]);
        const relayed = to
          ? await tg(env, 'sendMessage', {
            chat_id: to, text: `💬 Ответ от команды СМЭШ AI:\n\n${text}`
          })
          : { method: 'sendMessage', to: m[1], status: 0, ok: false, error: 'invalid_chat' };
        steps.push(relayed);
        if (relayed.ok) {
          steps.push(await tg(env, 'sendMessage', {
            chat_id: ownerId, text: '✓ Отправлено пользователю.', reply_to_message_id: msg.message_id
          }));
        } else {
          steps.push(await tg(env, 'sendMessage', {
            chat_id: ownerId,
            text: '⚠️ Не удалось отправить ответ пользователю. Попробуйте ещё раз позже.',
            reply_to_message_id: msg.message_id
          }));
        }
        return { kind: 'owner_reply', to: m[1], delivered: relayed.ok, steps };
      }
      return { kind: 'owner_reply', to: m[1], steps };
    }
  }

  // ---- /start (incl. the ?start=support deep link) ----
  if (text.startsWith('/start')) {
    const payload = text.split(' ')[1] || '';
    if (payload === 'support') { steps.push(await askTicket(env, chatId)); return { kind: 'start_support', steps }; }
    steps.push(await showMenu(env, chatId, WELCOME));
    return { kind: 'start_menu', steps };
  }

  // ---- /help ----
  if (text.startsWith('/help')) {
    steps.push(await tg(env, 'sendMessage', { chat_id: chatId, text: HELP_TEXT, reply_markup: MENU }));
    return { kind: 'help', steps };
  }

  // ---- A reply to one of our prompts → a submission ----
  let mode = null;
  if (replyText.startsWith('🆘')) mode = 'ticket';
  else if (replyText.startsWith('💡')) mode = 'feature';
  if (!mode && !replyText) {
    if (isOwner) { steps.push(await showMenu(env, chatId, 'Выберите действие:')); return { kind: 'owner_menu', steps }; }
    mode = 'ticket'; // plain user message with no context → don't lose it
  }
  if (!mode) return { kind: 'ignored', reason: 'unrelated_reply', steps };

  let r;
  try {
    r = await routeSubmission(env, {
      mode, msg, ownerId, updateId, claimVersion
    });
  }
  catch {
    steps.push(await tg(env, 'sendMessage', { chat_id: chatId, text: TEMPORARILY_UNAVAILABLE }));
    return { kind: 'service_unavailable', steps };
  }
  steps.push(...r.steps);
  return { kind: `submit_${mode}`, no: r.no, steps };
}

async function routeSubmission(
  env, { mode, msg, ownerId, updateId = null, claimVersion = null }
) {
  const isFeature = mode === 'feature';
  const from = msg.from || {};
  const chatId = msg.chat.id;
  const userId = telegramUserId(from.id);
  if (!ownerId || !userId) throw new Error('support route unavailable');
  const body = (msg.text || msg.caption || '') || '[вложение без текста]';
  const steps = [];
  const { no, fresh } = await reserveTicketNo(env, updateId, claimVersion);

  // Minimal record — gives you a history and powers the «Вопрос решён» button.
  await env.LICENSES.put(`ticket:${no}`, JSON.stringify({
    no, mode, uid: userId, name: clipText(senderName(from), 128),
    username: from.username ? clipText(from.username, 64) : null,
    text: clipText(body, 4000), status: 'open', at: new Date().toISOString()
  }), { expirationTtl: TICKET_TTL });

  // Persist retry state before telling the user that support accepted their
  // message. The D1 row contains routing metadata only; the body stays in KV.
  const outbox = await enqueueSupportForward(env, no, msg);
  const forwarding = await attemptSupportForward(env, outbox, ownerId);
  steps.push(...forwarding.steps);

  // The confirmation is the one remaining non-idempotent external effect, so it
  // is sent only by the delivery that actually minted the ticket. A replay
  // (lease expiry after a lost completion write) re-drives the idempotent
  // outbox above but must not tell the student their message was received a
  // second time under the same number.
  if (fresh) {
    if (isFeature) {
      steps.push(await tg(env, 'sendMessage', {
        chat_id: chatId, text: `Спасибо за идею! 💡 Записал как предложение #${no} — мы обязательно его рассмотрим.`
      }));
    } else {
      steps.push(await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `Спасибо! Ваше обращение #${no} принято — мы ответим вам прямо здесь. 🙌`,
        reply_markup: { inline_keyboard: [[{ text: '✅ Вопрос решён', callback_data: `resolve:${no}` }]] }
      }));
    }
  }
  return { no, steps };
}

async function resolveTicket(env, { cq, ownerId }) {
  const steps = [];
  const no = (cq.data.split(':')[1] || '').trim();

  const raw = await env.LICENSES.get(`ticket:${no}`);
  const rec = raw ? JSON.parse(raw) : null;
  const isOwner = ownerId && String(cq.message?.chat?.id) === ownerId;
  const isTicketOwner = rec?.uid && String(cq.from?.id) === String(rec.uid);
  const canResolve = !rec?.uid || isOwner || isTicketOwner;
  if (rec && rec.status !== 'resolved' && canResolve) {
    rec.status = 'resolved';
    rec.resolvedAt = new Date().toISOString();
    await env.LICENSES.put(`ticket:${no}`, JSON.stringify(rec), { expirationTtl: TICKET_TTL });
    if (ownerId) steps.push(await tg(env, 'sendMessage', {
      chat_id: ownerId, text: `✅ Пользователь закрыл обращение #${no}.`
    }));
  }

  steps.push(await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Спасибо! Обращение закрыто.' }));
  if (cq.message && canResolve) {
    steps.push(await tg(env, 'editMessageText', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      text: `${cq.message.text || ''}\n\n✅ Обращение #${no} закрыто.`
    }));
  }
  return { no, steps };
}

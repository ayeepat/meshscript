/**
 * Subscription surface of the СМЭШ AI Telegram bot.
 *
 * Two halves that share one data model:
 *
 *   1. /sub (and the «🔑 Моя подписка» menu button) — what the buyer owns:
 *      plan, activation date, which installation holds the single device slot,
 *      when it runs out, and a button that releases that slot so the key can be
 *      activated somewhere else. Buyers who paid through the Telegram checkout
 *      are recognized by the id Telegram itself asserts; buyers delivered by
 *      email prove ownership once by sending the key (license_telegram_links).
 *
 *   2. The lifecycle messages — three days out, one day out, ten minutes after
 *      the subscription lapses, and a one-tap survey three days later for the
 *      people who did not come back. Each is a row in subscription_notifications
 *      claimed by compare-and-set under a lease before Telegram is contacted,
 *      because a Bot API send has no idempotency key and the cron sweep can
 *      overlap itself. UNIQUE(license_key, stage) is what makes "once" true.
 *
 * Everything user-visible is plain text on purpose: MarkdownV2 escaping is a
 * recurring source of mangled messages, and none of this copy needs formatting.
 *
 * This module runs BEFORE delivery/support.js on every update and claims only
 * what it recognizes (/sub, `sub:*` and `wb:*` callbacks, replies to its own
 * prompts), so an ordinary message still becomes a support ticket.
 */

import {
  checkRate, clipText, reserveTelegramUpdateEffect, routeSubmission,
  supportOwnerId, telegramUserId, tg
} from './support.js';
import {
  getLicense, normalizeExpiry, normalizeKey, releaseActivation, RELEASE_FENCE_MS
} from '../licenses.js';
import { bumpDailyBudget, mskDay } from '../analytics.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const SUBSCRIPTION_NOTIFY_MAX_ATTEMPTS = 12;
const NOTIFY_LEASE_MS = 2 * MINUTE_MS;
const NOTIFY_ENQUEUE_LIMIT = 200;
const NOTIFY_SEND_LIMIT = 20;
// A reminder that missed its moment by this much is worse than no reminder:
// «истекает через 3 дня» two days after the fact is just noise.
const NOTIFY_STALE_MS = 2 * DAY_MS;
// Clock skew and a five-minute cron leave a reminder marginally early; sending
// it is fine, rescheduling it for four minutes later is not.
const NOTIFY_DUE_TOLERANCE_MS = 10 * MINUTE_MS;
const NOTIFICATION_RETENTION_MS = 365 * DAY_MS;
// One Telegram account can hold several keys (a renewal mints a new one), but
// the card is a summary, not an archive.
const LINKED_KEY_LIMIT = 10;
const CARD_DETAIL_LIMIT = 3;
// Sending a key to the bot is a guess-and-check oracle for key existence, so
// wrong guesses are budgeted per account per Moscow day on top of the shared
// five-messages-a-minute limit.
const BIND_ATTEMPT_DAILY_LIMIT = 10;

const DEFAULT_RENEW_URL = 'https://smeshai.xyz/pricing/';

const BIND_PROMPT = '🔑 Пришлите ключ доступа одним сообщением — он выглядит так: SMESH-XXXX-XXXX-XXXX.';
const WINBACK_PROMPT = '✍️ Напишите одним сообщением, что было не так — читаем всё.';
const UNAVAILABLE =
  '⚠️ Не удалось получить данные подписки. Попробуйте ещё раз через пару минут.';
// Enough of each prompt to tell OUR force-reply apart from anything else the
// user might be replying to — the card itself also opens with 🔑.
const BIND_PROMPT_MARK = BIND_PROMPT.slice(0, 12);
const WINBACK_PROMPT_MARK = WINBACK_PROMPT.slice(0, 12);

const STAGE_OFFSETS = {
  expiry_3d: -3 * DAY_MS,
  expiry_1d: -1 * DAY_MS,
  expired: 10 * MINUTE_MS,
  winback: 3 * DAY_MS
};
const STAGES = Object.keys(STAGE_OFFSETS);

const WINBACK_REASONS = [
  ['price', '💸 Дорого'],
  ['unused', '🤷 Не пригодилось'],
  ['quality', '😕 Ответы не устроили'],
  ['bugs', '🐞 Ошибки и глюки'],
  ['alternative', '🔀 Пользуюсь другим'],
  ['other', '✍️ Другое (напишу)']
];
const WINBACK_REASON_LABELS = new Map(WINBACK_REASONS);

/* ------------------------------ formatting ----------------------------- */

const MOSCOW_DATE = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric'
});
const MOSCOW_DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit'
});

function formatDate(ms, { withTime = false } = {}) {
  if (!Number.isFinite(ms)) return '';
  const formatted = withTime
    ? MOSCOW_DATE_TIME.format(new Date(ms))
    : MOSCOW_DATE.format(new Date(ms));
  return withTime ? `${formatted} МСК` : formatted;
}

// «осталось 3 дня» / «2 часа». Russian plurals are not optional here: a bot
// that writes «17 дня» reads as machine output, which is exactly the wrong
// impression for a message asking someone for money.
function plural(count, one, few, many) {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  switch (count % 10) {
    case 1: return one;
    case 2: case 3: case 4: return few;
    default: return many;
  }
}

function humanizeLeft(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'срок истёк';
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return `осталось ${days} ${plural(days, 'день', 'дня', 'дней')}`;
  const hours = Math.floor(ms / (60 * MINUTE_MS));
  if (hours >= 1) return `осталось ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const minutes = Math.max(1, Math.floor(ms / MINUTE_MS));
  return `осталось ${minutes} ${plural(minutes, 'минута', 'минуты', 'минут')}`;
}

// The key is a bearer credential. The buyer already has it in this very chat
// from delivery, so the card identifies it rather than repeating it.
function maskKey(key) {
  const text = String(key || '');
  const tail = text.slice(-4);
  return tail ? `SMESH-····-····-${tail}` : 'ключ';
}

function maskDevice(deviceId) {
  const tail = String(deviceId || '').slice(-4);
  return tail ? `····${tail}` : 'неизвестное устройство';
}

function renewUrl(env) {
  const configured = String(env.SITE_PRICING_URL || '').trim();
  if (!configured) return DEFAULT_RENEW_URL;
  // Telegram rejects a malformed button URL with 400, which would burn the
  // whole retry budget of an otherwise fine reminder. Fall back instead.
  try {
    const url = new URL(configured);
    return url.protocol === 'https:' && configured.length <= 256
      ? url.toString()
      : DEFAULT_RENEW_URL;
  } catch {
    return DEFAULT_RENEW_URL;
  }
}

const renewButton = (env) => ({ text: '🔄 Продлить подписку', url: renewUrl(env) });

/* --------------------------- license resolution ------------------------- */

function expiryMs(license) {
  const canonical = license?.expires_at == null
    ? null
    : normalizeExpiry(license.expires_at);
  if (!canonical) return null;
  const ms = Date.parse(canonical);
  return Number.isFinite(ms) ? ms : null;
}

/** Is this license good for something after `atMs`? */
function coversAfter(license, atMs) {
  if (!license || license.status !== 'active') return false;
  const expires = expiryMs(license);
  if (license.type === 'lifetime') return expires == null || expires > atMs;
  return expires != null && expires > atMs;
}

/**
 * Every license this Telegram account owns, newest coverage first.
 *
 * Two sources, one rule: `purchases.telegram_user_id` is the identity Telegram
 * asserted at checkout, `license_telegram_links` is the identity a buyer proved
 * later by sending the key. KV remains authoritative for the license itself —
 * `purchases` is a mirror, and a stale mirror must never decide what the card
 * shows or who may release a device.
 */
async function resolveUserLicenses(env, userId) {
  if (!env.DB) return { ok: false, entries: [] };
  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT license_key FROM purchases WHERE telegram_user_id = ?1
       UNION
       SELECT license_key FROM license_telegram_links WHERE telegram_user_id = ?1
       LIMIT ?2`
    ).bind(String(userId), LINKED_KEY_LIMIT).all();
  } catch (error) {
    console.error('subscription license lookup failed', error?.name || 'error');
    return { ok: false, entries: [] };
  }

  const keys = [];
  for (const row of rows?.results || []) {
    const key = normalizeKey(row.license_key);
    if (key && !keys.includes(key)) keys.push(key);
  }
  if (!keys.length) return { ok: true, entries: [] };

  const activations = new Map();
  try {
    const placeholders = keys.map((_, index) => `?${index + 1}`).join(', ');
    const found = await env.DB.prepare(
      `SELECT license_key, status, device_id, activated_at, last_seen_at
       FROM license_activations WHERE license_key IN (${placeholders})`
    ).bind(...keys).all();
    for (const row of found?.results || []) activations.set(row.license_key, row);
  } catch (error) {
    console.error('subscription activation lookup failed', error?.name || 'error');
    return { ok: false, entries: [] };
  }

  const entries = [];
  for (const key of keys) {
    let license;
    try {
      license = await getLicense(env, key);
    } catch (error) {
      // A degraded entitlement registry must not be rendered as "no such key".
      console.error('subscription license read failed', error?.name || 'error');
      return { ok: false, entries: [] };
    }
    if (!license) continue;
    entries.push({
      key,
      license,
      activation: activations.get(key) || null,
      expires: expiryMs(license),
      usable: coversAfter(license, Date.now())
    });
  }

  entries.sort((left, right) => {
    if (left.usable !== right.usable) return left.usable ? -1 : 1;
    const leftExpiry = left.license.type === 'lifetime' && left.expires == null
      ? Number.MAX_SAFE_INTEGER
      : (left.expires ?? 0);
    const rightExpiry = right.license.type === 'lifetime' && right.expires == null
      ? Number.MAX_SAFE_INTEGER
      : (right.expires ?? 0);
    if (leftExpiry !== rightExpiry) return rightExpiry - leftExpiry;
    return left.key < right.key ? -1 : 1;
  });
  return { ok: true, entries };
}

/* ------------------------------- the card ------------------------------ */

function planLine(license) {
  if (license.type === 'lifetime') return 'Тариф: бессрочный доступ';
  const days = Number(license.subscription_days);
  if (Number.isSafeInteger(days) && days > 0) {
    return `Тариф: подписка на ${days} ${plural(days, 'день', 'дня', 'дней')}`;
  }
  return 'Тариф: подписка';
}

function deviceLines(entry) {
  const activation = entry.activation;
  if (!activation || activation.status !== 'active') {
    return ['Устройство: ключ ни к чему не привязан — можно активировать где угодно'];
  }
  const lines = [`Устройство: ${maskDevice(activation.device_id)}`];
  const activatedAt = Number(activation.activated_at);
  if (Number.isFinite(activatedAt) && activatedAt > 0) {
    lines.push(`Активирован: ${formatDate(activatedAt, { withTime: true })}`);
  }
  const lastSeen = Number(activation.last_seen_at);
  if (Number.isFinite(lastSeen) && lastSeen > 0) {
    lines.push(`Последняя проверка: ${formatDate(lastSeen, { withTime: true })}`);
  }
  return lines;
}

function expiryLine(entry) {
  const { license, expires } = entry;
  if (license.status !== 'active') return 'Статус: ключ отозван';
  if (license.type === 'lifetime') return 'Действует: бессрочно';
  if (expires == null) {
    return 'Срок: начнётся при первой активации ключа в расширении';
  }
  const now = Date.now();
  return expires > now
    ? `Действует до: ${formatDate(expires)} — ${humanizeLeft(expires - now)}`
    : `Закончилась: ${formatDate(expires)}`;
}

function cardBody(entry) {
  return [
    `Ключ: ${maskKey(entry.key)}`,
    planLine(entry.license),
    ...deviceLines(entry),
    expiryLine(entry)
  ].join('\n');
}

function buildCard(env, entries) {
  if (!entries.length) {
    return {
      text: [
        '🔑 Подписка СМЭШ AI',
        '',
        'За этим аккаунтом Telegram ключей не числится.',
        '',
        'Если вы покупали подписку на почту — пришлите ключ, и я привяжу его к этому чату. Если ещё не покупали — оформить можно на сайте.'
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔑 Привязать ключ', callback_data: 'sub:bind' }],
          [renewButton(env)]
        ]
      }
    };
  }

  const shown = entries.slice(0, CARD_DETAIL_LIMIT);
  const blocks = shown.map(cardBody);
  const lines = ['🔑 Подписка СМЭШ AI', '', blocks.join('\n\n')];
  if (entries.length > shown.length) {
    const rest = entries.length - shown.length;
    lines.push('', `Ещё ${rest} ${plural(rest, 'ключ', 'ключа', 'ключей')} — покажу по запросу в поддержке.`);
  }
  lines.push(
    '',
    'Один ключ работает на одном устройстве. Переезжаете на другой компьютер — нажмите «Отвязать от устройства»: слот освободится, и ключ можно будет вставить в настройках расширения там. Срок подписки от этого не сдвигается и не сгорает.'
  );

  const buttons = [];
  shown.forEach((entry, index) => {
    if (entry.activation?.status !== 'active') return;
    buttons.push([{
      text: shown.length > 1
        ? `🔓 Отвязать ${maskKey(entry.key)}`
        : '🔓 Отвязать от устройства',
      callback_data: `sub:rel:${index}:${entry.key.slice(-4)}`
    }]);
  });
  const primary = shown[0];
  if (!primary.usable) buttons.push([renewButton(env)]);
  buttons.push([{ text: '🔑 Привязать другой ключ', callback_data: 'sub:bind' }]);

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: buttons } };
}

async function sendCard(env, chatId, userId) {
  const resolved = await resolveUserLicenses(env, userId);
  if (!resolved.ok) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: UNAVAILABLE });
    return { ok: false };
  }
  const card = buildCard(env, resolved.entries);
  const step = await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: card.text,
    reply_markup: card.reply_markup,
    disable_web_page_preview: true
  });
  return { ok: true, step, entries: resolved.entries };
}

/* ------------------------------ release flow ---------------------------- */

function parseIndex(raw) {
  const index = Number(raw);
  return Number.isSafeInteger(index) && index >= 0 && index < CARD_DETAIL_LIMIT
    ? index
    : null;
}

/**
 * Re-resolve the entry a release button points at.
 *
 * The button carries a position and the key's last four characters, never the
 * key itself — callback data is echoed into the webhook debug record, and a
 * license key is a bearer credential. Re-resolving under the caller's own
 * identity is also what authorizes the release: an account can only ever act on
 * keys that already resolve to it.
 */
async function entryForCallback(env, userId, index, suffix) {
  const resolved = await resolveUserLicenses(env, userId);
  if (!resolved.ok) return { ok: false, reason: 'unavailable' };
  const entry = resolved.entries[index];
  if (!entry || entry.key.slice(-4) !== suffix) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true, entry };
}

const STALE_CARD =
  'Список ключей изменился. Откройте /sub заново — и повторите.';

async function askReleaseConfirmation(env, chatId, userId, index, suffix) {
  const found = await entryForCallback(env, userId, index, suffix);
  if (!found.ok) {
    return [await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: found.reason === 'stale' ? STALE_CARD : UNAVAILABLE
    })];
  }
  const entry = found.entry;
  if (entry.activation?.status !== 'active') {
    return [await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `Ключ ${maskKey(entry.key)} и так не привязан ни к какому устройству — можно активировать его где нужно.`
    })];
  }
  return [await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: [
      `Отвязать ключ ${maskKey(entry.key)} от устройства ${maskDevice(entry.activation.device_id)}?`,
      '',
      'На нём расширение перестанет решать задания. Ключ сразу можно вставить в настройках расширения на другом компьютере — срок подписки не изменится.'
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Да, отвязать', callback_data: `sub:relx:${index}:${suffix}` }],
        [{ text: '↩️ Отмена', callback_data: 'sub:card' }]
      ]
    }
  })];
}

async function performRelease(env, chatId, userId, index, suffix, reservation) {
  const found = await entryForCallback(env, userId, index, suffix);
  if (!found.ok) {
    return [await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: found.reason === 'stale' ? STALE_CARD : UNAVAILABLE
    })];
  }
  const entry = found.entry;

  // The release itself is the non-idempotent effect worth reserving: replaying
  // it would bump the activation generation again and re-arm the fence against
  // whatever device legitimately activated in between.
  if (!(await reservation())) {
    return [await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `Ключ ${maskKey(entry.key)} уже отвязан.`
    })];
  }

  const released = await releaseActivation(env, entry.key, { releasedBy: userId });
  if (!released.ok) {
    return [await tg(env, 'sendMessage', { chat_id: chatId, text: UNAVAILABLE })];
  }
  const fenceDays = Math.round(RELEASE_FENCE_MS / DAY_MS);
  return [await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: [
      `✅ Готово. Ключ ${maskKey(entry.key)} свободен.`,
      '',
      'Откройте расширение на нужном компьютере → ⚙️ Настройки → «Ключ доступа» → вставьте ключ. Подписка продолжится с того же дня.',
      '',
      `Со старого устройства ключ сам не вернётся: чтобы снова включить его там, вставьте ключ в настройках вручную (в ближайшие ${fenceDays} дней это единственный способ).`
    ].join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '🔑 Моя подписка', callback_data: 'sub:card' }]] }
  })];
}

/* -------------------------------- binding ------------------------------- */

async function currentOwner(env, key, license) {
  const fromLicense = telegramUserId(license?.telegram_user_id);
  if (fromLicense) return fromLicense;
  try {
    const row = await env.DB.prepare(
      'SELECT telegram_user_id FROM license_telegram_links WHERE license_key = ?1'
    ).bind(key).first();
    return telegramUserId(row?.telegram_user_id);
  } catch (error) {
    console.error('subscription link lookup failed', error?.name || 'error');
    return null;
  }
}

async function bindKey(env, chatId, userId, rawKey) {
  const key = normalizeKey(rawKey);
  const looksLikeKey = /^SMESH-[A-Z0-9-]{6,}$/.test(key);
  if (!looksLikeKey) {
    return [await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Это не похоже на ключ. Он выглядит так: SMESH-XXXX-XXXX-XXXX — скопируйте его целиком из сообщения о покупке.'
    })];
  }
  if (!env.DB) {
    return [await tg(env, 'sendMessage', { chat_id: chatId, text: UNAVAILABLE })];
  }

  // Guessing keys here would otherwise be a cheap existence oracle. Charge the
  // attempt BEFORE the lookup so a burst cannot outrun the counter, and treat
  // an exhausted budget as "no answer" rather than a different answer.
  const spent = await bumpDailyBudget(
    env, mskDay(), 'bind_attempt', String(userId), 1, BIND_ATTEMPT_DAILY_LIMIT
  ).catch(() => BIND_ATTEMPT_DAILY_LIMIT + 1);
  if (spent > BIND_ATTEMPT_DAILY_LIMIT) {
    return [await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Слишком много попыток за сегодня. Напишите в поддержку — привяжем ключ вручную.'
    })];
  }

  let license;
  try {
    license = await getLicense(env, key);
  } catch (error) {
    console.error('subscription bind lookup failed', error?.name || 'error');
    return [await tg(env, 'sendMessage', { chat_id: chatId, text: UNAVAILABLE })];
  }
  if (!license) {
    return [await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Такого ключа нет. Проверьте, что скопировали его целиком и без лишних символов.'
    })];
  }

  const owner = await currentOwner(env, key, license);
  if (owner && owner !== String(userId)) {
    return [await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Этот ключ уже привязан к другому аккаунту Telegram. Если это ваша покупка — напишите в поддержку, разберёмся.'
    })];
  }
  if (!owner) {
    try {
      await env.DB.prepare(
        `INSERT INTO license_telegram_links (license_key, telegram_user_id, linked_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(license_key) DO NOTHING`
      ).bind(key, String(userId), Date.now()).run();
    } catch (error) {
      console.error('subscription bind write failed', error?.name || 'error');
      return [await tg(env, 'sendMessage', { chat_id: chatId, text: UNAVAILABLE })];
    }
    // Read back: a concurrent bind from another account wins by primary key,
    // and the loser must not be told the key is theirs.
    const settled = await currentOwner(env, key, license);
    if (settled && settled !== String(userId)) {
      return [await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Этот ключ уже привязан к другому аккаунту Telegram. Если это ваша покупка — напишите в поддержку, разберёмся.'
      })];
    }
  }

  const steps = [await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: `✅ Ключ ${maskKey(key)} привязан к этому чату. Теперь /sub покажет срок и устройство, а я предупрежу, когда подписка будет заканчиваться.`
  })];
  const card = await sendCard(env, chatId, userId);
  if (card.step) steps.push(card.step);
  return steps;
}

/* ------------------------------ the survey ------------------------------ */

async function recordWinbackAnswer(env, id, userId, code) {
  // The row's own account is the authorization: callback data can be replayed
  // by a modified client, so the answer is only recorded for the person the
  // survey was sent to, and only once.
  const updated = await env.DB.prepare(
    `UPDATE subscription_notifications
     SET answer_code = ?3, answered_at = ?4
     WHERE id = ?1 AND telegram_user_id = ?2 AND stage = 'winback'
       AND answered_at IS NULL`
  ).bind(id, String(userId), code, Date.now()).run();
  return (updated?.meta?.changes || 0) > 0;
}

async function handleWinbackChoice(env, cq, chatId, userId, id, code) {
  const steps = [];
  if (!WINBACK_REASON_LABELS.has(code) || !env.DB) {
    return steps;
  }
  const recorded = await recordWinbackAnswer(env, id, userId, code);
  if (!recorded) {
    return [await tg(env, 'sendMessage', {
      chat_id: chatId, text: 'Ответ уже записан — спасибо!'
    })];
  }

  const label = WINBACK_REASON_LABELS.get(code);
  if (cq.message) {
    steps.push(await tg(env, 'editMessageText', {
      chat_id: chatId,
      message_id: cq.message.message_id,
      text: `${cq.message.text || ''}\n\nВаш ответ: ${label}. Спасибо!`
    }));
  }
  if (code === 'other') {
    steps.push(await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: WINBACK_PROMPT,
      reply_markup: { force_reply: true, input_field_placeholder: 'Что было не так…' }
    }));
    return steps;
  }

  // The count in D1 is the authority; this line is the owner's live feed. A
  // failed send costs a notification, never the datapoint.
  const ownerId = supportOwnerId(env);
  if (ownerId) {
    steps.push(await tg(env, 'sendMessage', {
      chat_id: ownerId,
      text: `🗳 Не продлил: ${label}\nОт: ${clipText(cq.from?.first_name || 'без имени', 64)}` +
        (cq.from?.username ? ` (@${clipText(cq.from.username, 64)})` : '')
    }));
  }
  steps.push(await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: 'Спасибо! Если захотите вернуться — подписка оформляется за минуту.',
    reply_markup: { inline_keyboard: [[renewButton(env)]] },
    disable_web_page_preview: true
  }));
  return steps;
}

/* ------------------------------- dispatch ------------------------------- */

const SUB_COMMAND_RE = /^\/sub(?:@[A-Za-z0-9_]+)?\s*$/;
const START_SUB_RE = /^\/start(?:@[A-Za-z0-9_]+)?\s+sub\s*$/;

/**
 * Claim the subscription-related updates and leave everything else alone.
 * Returns { handled:false } for anything the support surface should see.
 */
export async function processSubscriptionUpdate(
  env, update, { updateId = null, claimVersion = null } = {}
) {
  if (!env.TELEGRAM_BOT_TOKEN) return { handled: false };

  const cq = update?.callback_query;
  if (cq) {
    const data = typeof cq.data === 'string' ? cq.data : '';
    if (!data.startsWith('sub:') && !data.startsWith('wb:')) return { handled: false };
    return handleCallback(env, cq, data, { updateId, claimVersion });
  }

  const msg = update?.message;
  if (!msg || msg.chat?.type !== 'private') return { handled: false };
  const text = typeof msg.text === 'string' ? msg.text : '';
  const replyText = msg.reply_to_message?.text || '';
  const isCommand = SUB_COMMAND_RE.test(text.trim()) || START_SUB_RE.test(text.trim());
  const isBindReply = replyText.startsWith(BIND_PROMPT_MARK);
  const isWinbackReply = replyText.startsWith(WINBACK_PROMPT_MARK);
  if (!isCommand && !isBindReply && !isWinbackReply) return { handled: false };

  const chatId = msg.chat.id;
  const userId = telegramUserId(msg.from?.id);
  if (!userId) return { handled: false };

  const rate = await checkRate(env, userId);
  if (rate.unavailable) {
    const step = await tg(env, 'sendMessage', { chat_id: chatId, text: UNAVAILABLE });
    return { handled: true, kind: 'service_unavailable', steps: [step] };
  }
  if (rate.blocked) return { handled: true, kind: 'rate_limited', steps: [] };

  try {
    if (isCommand) {
      const card = await sendCard(env, chatId, userId);
      return {
        handled: true,
        kind: card.ok ? 'sub_card' : 'service_unavailable',
        steps: card.step ? [card.step] : []
      };
    }
    if (isBindReply) {
      const steps = await bindKey(env, chatId, userId, text);
      return { handled: true, kind: 'sub_bind', steps };
    }
    // Free-text survey answer: reuse the support pipeline so it is numbered,
    // durably forwarded, and answerable by a plain reply like any ticket.
    const ownerId = supportOwnerId(env);
    if (!ownerId) {
      const step = await tg(env, 'sendMessage', { chat_id: chatId, text: UNAVAILABLE });
      return { handled: true, kind: 'service_unavailable', steps: [step] };
    }
    const routed = await routeSubmission(env, {
      mode: 'winback', msg, ownerId, updateId, claimVersion
    });
    return { handled: true, kind: 'sub_winback_text', no: routed.no, steps: routed.steps };
  } catch (error) {
    console.error('subscription surface failed', error?.name || 'error');
    const step = await tg(env, 'sendMessage', { chat_id: chatId, text: UNAVAILABLE });
    return { handled: true, kind: 'service_unavailable', steps: [step] };
  }
}

async function handleCallback(env, cq, data, { updateId, claimVersion }) {
  const chatId = cq.message?.chat?.id;
  const userId = telegramUserId(cq.from?.id);
  const steps = [await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id })];
  if (!chatId || !userId || cq.message?.chat?.type !== 'private') {
    return { handled: true, kind: 'sub_callback_ignored', steps };
  }

  const rate = await checkRate(env, userId);
  if (rate.unavailable) {
    steps.push(await tg(env, 'sendMessage', { chat_id: chatId, text: UNAVAILABLE }));
    return { handled: true, kind: 'service_unavailable', steps };
  }
  if (rate.blocked) return { handled: true, kind: 'rate_limited', steps };

  try {
    if (data === 'sub:card') {
      const card = await sendCard(env, chatId, userId);
      if (card.step) steps.push(card.step);
      return {
        handled: true,
        kind: card.ok ? 'sub_card' : 'service_unavailable',
        steps
      };
    }
    if (data === 'sub:bind') {
      steps.push(await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: BIND_PROMPT,
        reply_markup: { force_reply: true, input_field_placeholder: 'SMESH-…' }
      }));
      return { handled: true, kind: 'sub_bind_prompt', steps };
    }

    const release = /^sub:(rel|relx):(\d+):([A-Z0-9]{4})$/.exec(data);
    if (release) {
      const index = parseIndex(release[2]);
      if (index == null) return { handled: true, kind: 'sub_callback_ignored', steps };
      const more = release[1] === 'rel'
        ? await askReleaseConfirmation(env, chatId, userId, index, release[3])
        : await performRelease(
          env, chatId, userId, index, release[3],
          () => reserveTelegramUpdateEffect(
            env, updateId, claimVersion, 'sub_release'
          )
        );
      steps.push(...more);
      return {
        handled: true,
        kind: release[1] === 'rel' ? 'sub_release_confirm' : 'sub_release',
        steps
      };
    }

    const winback = /^wb:(\d+):([a-z]+)$/.exec(data);
    if (winback) {
      const id = Number(winback[1]);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return { handled: true, kind: 'sub_callback_ignored', steps };
      }
      steps.push(...await handleWinbackChoice(env, cq, chatId, userId, id, winback[2]));
      return { handled: true, kind: 'sub_winback_choice', steps };
    }
    return { handled: true, kind: 'sub_callback_ignored', steps };
  } catch (error) {
    console.error('subscription callback failed', error?.name || 'error');
    steps.push(await tg(env, 'sendMessage', { chat_id: chatId, text: UNAVAILABLE }));
    return { handled: true, kind: 'service_unavailable', steps };
  }
}

/* ---------------------------- lifecycle sweep --------------------------- */

function notifyBackoffMs(attempts) {
  return Math.min(5 * MINUTE_MS * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

/**
 * Create (or reschedule) the rows for every subscription whose expiry is close
 * enough to matter. Rescheduling exists because expiry is not fixed at
 * purchase: a referral credit moves it, and a reminder that was queued for the
 * old date must move with it rather than fire on a subscription with three
 * weeks left.
 */
async function enqueueDueNotifications(env, now) {
  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT license_key, telegram_user_id, expires_at
       FROM purchases
       WHERE type = 'subscription' AND status = 'active'
         AND telegram_user_id IS NOT NULL
         AND expires_at IS NOT NULL
         AND expires_at >= ?1 AND expires_at <= ?2
       ORDER BY expires_at
       LIMIT ?3`
    ).bind(
      now - STAGE_OFFSETS.winback - NOTIFY_STALE_MS,
      now - STAGE_OFFSETS.expiry_3d,
      NOTIFY_ENQUEUE_LIMIT
    ).all();
  } catch (error) {
    console.error('subscription notification scan failed', error?.name || 'error');
    return { enqueued: 0 };
  }

  let enqueued = 0;
  for (const row of rows?.results || []) {
    const key = normalizeKey(row.license_key);
    const userId = telegramUserId(row.telegram_user_id);
    const expires = Number(row.expires_at);
    if (!key || !userId || !Number.isFinite(expires)) continue;
    for (const stage of STAGES) {
      const dueAt = expires + STAGE_OFFSETS[stage];
      try {
        const result = await env.DB.prepare(
          `INSERT INTO subscription_notifications
             (license_key, stage, telegram_user_id, due_at, created_at,
              attempts, next_attempt_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 0, ?4)
           ON CONFLICT(license_key, stage) DO UPDATE SET
             due_at = excluded.due_at,
             telegram_user_id = excluded.telegram_user_id,
             next_attempt_at = MAX(excluded.due_at, subscription_notifications.next_attempt_at)
           WHERE subscription_notifications.sent_at IS NULL
             AND subscription_notifications.cancelled_at IS NULL
             AND subscription_notifications.due_at <> excluded.due_at`
        ).bind(key, stage, userId, dueAt, now).run();
        enqueued += Number(result?.meta?.changes || 0);
      } catch (error) {
        console.error('subscription notification enqueue failed', error?.name || 'error');
      }
    }
  }
  return { enqueued };
}

/**
 * Is this reminder still the truth?
 *
 * 'send' — go ahead. 'cancel' — it never will be true again (renewed, revoked,
 * or simply too late to be useful). 'defer' — not yet, or the registry is
 * degraded; leave the row for a later sweep without burning an attempt.
 */
async function classifyNotification(env, row, now) {
  const key = normalizeKey(row.license_key);
  const userId = telegramUserId(row.telegram_user_id);
  if (!key || !userId || !STAGES.includes(row.stage)) return { action: 'cancel' };

  let license;
  try {
    license = await getLicense(env, key);
  } catch (error) {
    console.error('subscription notification license read failed', error?.name || 'error');
    return { action: 'defer' };
  }
  if (!license || license.status !== 'active' || license.type !== 'subscription') {
    return { action: 'cancel' };
  }
  const expires = expiryMs(license);
  if (expires == null) return { action: 'cancel' };

  const dueAt = expires + STAGE_OFFSETS[row.stage];
  if (dueAt > now + NOTIFY_DUE_TOLERANCE_MS) {
    return { action: 'defer', nextAttemptAt: dueAt };
  }
  if (now - dueAt > NOTIFY_STALE_MS) return { action: 'cancel' };
  const preExpiry = row.stage === 'expiry_3d' || row.stage === 'expiry_1d';
  if (preExpiry && expires <= now) return { action: 'cancel' };
  if (!preExpiry && expires > now) return { action: 'cancel' };

  // Someone who already renewed must never be told their access ended, and
  // must never be asked why they left. Renewal mints a NEW key, so the question
  // is about the person, not this row.
  const resolved = await resolveUserLicenses(env, userId);
  if (!resolved.ok) return { action: 'defer' };
  const covered = resolved.entries.some(
    (entry) => entry.key !== key && coversAfter(entry.license, preExpiry ? expires : now)
  );
  if (covered) return { action: 'cancel' };

  return { action: 'send', license, expires };
}

function notificationMessage(env, stage, expires, notificationId) {
  const renew = { inline_keyboard: [[renewButton(env)]] };
  if (stage === 'expiry_3d') {
    return {
      text: [
        `⏳ Подписка СМЭШ AI заканчивается через 3 дня — ${formatDate(expires)}.`,
        '',
        'Дальше расширение перестанет решать задания. Ключ и история никуда не денутся: продлите — и всё продолжит работать на том же устройстве.'
      ].join('\n'),
      reply_markup: renew
    };
  }
  if (stage === 'expiry_1d') {
    return {
      text: [
        `⏳ Подписка заканчивается завтра — ${formatDate(expires, { withTime: true })}.`,
        '',
        'Если продлить сегодня, перерыва не будет: ключ остаётся тем же, заново активировать ничего не нужно.'
      ].join('\n'),
      reply_markup: renew
    };
  }
  if (stage === 'expired') {
    return {
      text: [
        'Подписка СМЭШ AI закончилась.',
        '',
        'Расширение больше не решает задания — удалять и переустанавливать его не нужно: после оплаты ключ заработает сразу, в том же браузере.'
      ].join('\n'),
      reply_markup: renew
    };
  }
  return {
    text: 'Прошло три дня, а вы не вернулись — и это нормально. Но нам важно понять почему: один тап, и мы будем знать, что чинить.',
    reply_markup: {
      inline_keyboard: WINBACK_REASONS.map(([code, label]) => [{
        text: label, callback_data: `wb:${notificationId}:${code}`
      }])
    }
  };
}

async function claimNotification(env, row, now) {
  const attempts = Number(row.attempts);
  if (!Number.isSafeInteger(attempts) || attempts < 0) return null;
  const claimToken = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE subscription_notifications
     SET attempts = ?2, next_attempt_at = ?3, claim_token = ?4, lease_until = ?5
     WHERE id = ?1 AND sent_at IS NULL AND cancelled_at IS NULL
       AND attempts = ?6 AND (lease_until IS NULL OR lease_until <= ?7)`
  ).bind(
    row.id,
    attempts + 1,
    now + notifyBackoffMs(attempts + 1),
    claimToken,
    now + NOTIFY_LEASE_MS,
    attempts,
    now
  ).run();
  return (claimed?.meta?.changes || 0) > 0 ? claimToken : null;
}

async function finishNotification(env, id, claimToken, column) {
  // `column` is chosen internally, never derived from a row or request value.
  const sql = column === 'cancelled_at'
    ? `UPDATE subscription_notifications
       SET cancelled_at = ?2, claim_token = NULL, lease_until = NULL
       WHERE id = ?1 AND sent_at IS NULL AND cancelled_at IS NULL
         AND (claim_token = ?3 OR ?3 IS NULL)`
    : `UPDATE subscription_notifications
       SET sent_at = ?2, claim_token = NULL, lease_until = NULL
       WHERE id = ?1 AND sent_at IS NULL AND cancelled_at IS NULL
         AND claim_token = ?3`;
  const done = await env.DB.prepare(sql).bind(id, Date.now(), claimToken).run();
  return (done?.meta?.changes || 0) > 0;
}

async function deferNotification(env, id, dueAt) {
  try {
    // Rewrite due_at as well: the enqueue scan only reaches licenses whose
    // expiry is already near, so a subscription pushed weeks out by a referral
    // credit would otherwise keep a stale due_at until it drifts back into
    // range. Keeping the row self-describing is what makes the queue readable.
    await env.DB.prepare(
      `UPDATE subscription_notifications SET due_at = ?2, next_attempt_at = ?2
       WHERE id = ?1 AND sent_at IS NULL AND cancelled_at IS NULL`
    ).bind(id, dueAt).run();
  } catch (error) {
    console.error('subscription notification defer failed', error?.name || 'error');
  }
}

async function releaseNotificationClaim(env, id, claimToken) {
  try {
    await env.DB.prepare(
      `UPDATE subscription_notifications SET claim_token = NULL, lease_until = NULL
       WHERE id = ?1 AND claim_token = ?2 AND sent_at IS NULL`
    ).bind(id, claimToken).run();
  } catch (error) {
    console.error('subscription notification release failed', error?.name || 'error');
  }
}

async function sendDueNotifications(env, now, limit) {
  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT id, license_key, stage, telegram_user_id, due_at, attempts
       FROM subscription_notifications
       WHERE sent_at IS NULL AND cancelled_at IS NULL
         AND attempts < ?1 AND next_attempt_at <= ?2
         AND (lease_until IS NULL OR lease_until <= ?2)
       ORDER BY next_attempt_at, id
       LIMIT ?3`
    ).bind(SUBSCRIPTION_NOTIFY_MAX_ATTEMPTS, now, limit).all();
  } catch (error) {
    console.error('subscription notification sweep failed', error?.name || 'error');
    return { sent: 0, cancelled: 0 };
  }

  let sent = 0;
  let cancelled = 0;
  for (const row of rows?.results || []) {
    // Classify BEFORE claiming: a reminder that merely moved into the future
    // must not spend one of its finite attempts to find that out.
    const verdict = await classifyNotification(env, row, now);
    if (verdict.action === 'cancel') {
      if (await finishNotification(env, row.id, null, 'cancelled_at')) cancelled += 1;
      continue;
    }
    if (verdict.action === 'defer') {
      if (verdict.nextAttemptAt) await deferNotification(env, row.id, verdict.nextAttemptAt);
      continue;
    }

    let claimToken;
    try {
      claimToken = await claimNotification(env, row, now);
    } catch (error) {
      console.error('subscription notification claim failed', error?.name || 'error');
      continue;
    }
    if (!claimToken) continue;

    const message = notificationMessage(env, row.stage, verdict.expires, row.id);
    const step = await tg(env, 'sendMessage', {
      chat_id: row.telegram_user_id,
      text: message.text,
      reply_markup: message.reply_markup,
      disable_web_page_preview: true
    });
    if (step.ok) {
      if (await finishNotification(env, row.id, claimToken, 'sent_at')) sent += 1;
      continue;
    }
    // 400/403 mean this chat will never accept a message again (blocked bot,
    // deleted account). Retrying that thirty times is pure noise in the queue.
    if (step.status === 400 || step.status === 403) {
      if (await finishNotification(env, row.id, claimToken, 'cancelled_at')) cancelled += 1;
      continue;
    }
    await releaseNotificationClaim(env, row.id, claimToken);
  }
  return { sent, cancelled };
}

/**
 * One cron pass: refresh the queue, then deliver what is due. Bounded and
 * idempotent, so overlapping or skipped runs are harmless.
 */
export async function sweepSubscriptionNotifications(env, limit = NOTIFY_SEND_LIMIT) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return { enqueued: 0, sent: 0, cancelled: 0 };
  const now = Date.now();
  const bounded = Math.max(1, Math.min(50, Math.trunc(Number(limit)) || NOTIFY_SEND_LIMIT));
  const { enqueued } = await enqueueDueNotifications(env, now);
  const delivered = await sendDueNotifications(env, now, bounded);
  return { enqueued, ...delivered };
}

/** Age out release fences that have lapsed and long-settled reminder rows. */
export async function pruneSubscriptionLifecycle(env, now = Date.now()) {
  if (!env.DB) return { fences: 0, notifications: 0 };
  const [fences, notifications] = await env.DB.batch([
    env.DB.prepare('DELETE FROM license_release_fence WHERE released_at <= ?1')
      .bind(now - RELEASE_FENCE_MS),
    env.DB.prepare('DELETE FROM subscription_notifications WHERE created_at <= ?1')
      .bind(now - NOTIFICATION_RETENTION_MS)
  ]);
  return {
    fences: Number(fences?.meta?.changes || 0),
    notifications: Number(notifications?.meta?.changes || 0)
  };
}

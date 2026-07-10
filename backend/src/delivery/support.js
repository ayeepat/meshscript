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
 * (for /telegram/debug). State lives in KV (env.LICENSES): seq:ticket counter,
 * ticket:<no> records, rate:<uid> windows.
 */

const TICKET_TTL = 60 * 60 * 24 * 90; // keep ticket records 90 days
const RATE_LIMIT = 5;                 // messages…
const RATE_WINDOW = 60;               // …per this many seconds

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
const senderHandle = (u = {}) => (u.username ? `@${u.username}` : '—');

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const step = { method, to: body.chat_id, status: r.status, ok: r.ok };
  if (!r.ok) { step.error = await r.text(); console.error('telegram', method, r.status, step.error); }
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

// Sequential ticket number. KV isn't atomic, but at support-bot volume a
// read-increment-write is fine; the worst case is two tickets sharing a number.
async function nextTicketNo(env) {
  const cur = parseInt(await env.LICENSES.get('seq:ticket'), 10);
  const next = (Number.isFinite(cur) ? cur : 1000) + 1;
  await env.LICENSES.put('seq:ticket', String(next));
  return next;
}

// Fixed-window rate limit per user. The window starts at the first message and
// resets once RATE_WINDOW seconds pass without it being refreshed.
async function checkRate(env, uid) {
  const key = `rate:${uid}`;
  const now = Date.now();
  let count = 0, start = now;
  const raw = await env.LICENSES.get(key);
  if (raw) {
    try { const o = JSON.parse(raw); if (now - o.start < RATE_WINDOW * 1000) { count = o.count; start = o.start; } }
    catch { /* ignore corrupt value */ }
  }
  count += 1;
  await env.LICENSES.put(key, JSON.stringify({ count, start }), { expirationTtl: RATE_WINDOW + 5 }).catch(() => {});
  return { count, blocked: count > RATE_LIMIT, justBlocked: count === RATE_LIMIT + 1 };
}

export async function processSupportUpdate(env, update) {
  if (!env.TELEGRAM_BOT_TOKEN) return { kind: 'skip', reason: 'no_token' };
  const steps = [];
  const ownerId = String(env.SUPPORT_CHAT_ID || '');

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
  const isOwner = ownerId && String(chatId) === ownerId;
  const text = msg.text || msg.caption || '';
  const replyText = msg.reply_to_message?.text || msg.reply_to_message?.caption || '';

  // ---- Rate limit (regular users only; never the owner) ----
  if (!isOwner) {
    const rl = await checkRate(env, msg.from?.id || chatId);
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
        steps.push(await tg(env, 'sendMessage', {
          chat_id: m[1], text: `💬 Ответ от команды СМЭШ AI:\n\n${text}`
        }));
        steps.push(await tg(env, 'sendMessage', {
          chat_id: ownerId, text: '✓ Отправлено пользователю.', reply_to_message_id: msg.message_id
        }));
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

  const r = await routeSubmission(env, { mode, msg, chatId, ownerId });
  steps.push(...r.steps);
  return { kind: `submit_${mode}`, no: r.no, steps };
}

async function routeSubmission(env, { mode, msg, chatId, ownerId }) {
  const isFeature = mode === 'feature';
  const from = msg.from || {};
  const body = (msg.text || msg.caption || '') || '[вложение без текста]';
  const steps = [];
  const no = await nextTicketNo(env);

  // Minimal record — gives you a history and powers the «Вопрос решён» button.
  await env.LICENSES.put(`ticket:${no}`, JSON.stringify({
    no, mode, uid: from.id || null, name: senderName(from), username: from.username || null,
    text: body.slice(0, 4000), status: 'open', at: new Date().toISOString()
  }), { expirationTtl: TICKET_TTL }).catch(() => {});

  if (ownerId && from.id) {
    const header = isFeature ? `💡 Предложение #${no}` : `🆘 Обращение #${no}`;
    steps.push(await tg(env, 'sendMessage', {
      chat_id: ownerId,
      text:
        `${header}\n` +
        `От: ${senderName(from)} (${senderHandle(from)})\n\n` +
        `${body}\n\n` +
        'Ответьте на это сообщение, чтобы написать пользователю.\n' +
        `#id${from.id}`
    }));
    if (msg.photo || msg.document) {
      steps.push(await tg(env, 'copyMessage', {
        chat_id: ownerId, from_chat_id: chatId, message_id: msg.message_id
      }));
    }
  }

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
  return { no, steps };
}

async function resolveTicket(env, { cq, ownerId }) {
  const steps = [];
  const no = (cq.data.split(':')[1] || '').trim();

  const raw = await env.LICENSES.get(`ticket:${no}`);
  const rec = raw ? JSON.parse(raw) : null;
  if (rec && rec.status !== 'resolved') {
    rec.status = 'resolved';
    rec.resolvedAt = new Date().toISOString();
    await env.LICENSES.put(`ticket:${no}`, JSON.stringify(rec), { expirationTtl: TICKET_TTL }).catch(() => {});
    if (ownerId) steps.push(await tg(env, 'sendMessage', {
      chat_id: ownerId, text: `✅ Пользователь закрыл обращение #${no}.`
    }));
  }

  steps.push(await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Спасибо! Обращение закрыто.' }));
  if (cq.message) {
    steps.push(await tg(env, 'editMessageText', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      text: `${cq.message.text || ''}\n\n✅ Обращение #${no} закрыто.`
    }));
  }
  return { no, steps };
}

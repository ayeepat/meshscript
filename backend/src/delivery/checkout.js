/**
 * Telegram ownership binding for checkout deep links.
 *
 * The browser never supplies a Telegram username or numeric id. Telegram's
 * authenticated webhook gives us the trusted `from.id`; the short-lived
 * HMAC capability in `/start pay_<token>` identifies only the pending order.
 */

import * as payments from '../payments.js';
import { fetchDelivery } from './http.js';

const START_RE = /^\/start(?:@[A-Za-z0-9_]+)?\s+pay_([A-Za-z0-9_.-]{20,180})\s*$/;

function telegramUserId(value) {
  const id = String(value ?? '').trim();
  if (!/^[1-9]\d{0,18}$/.test(id)) return null;
  try {
    return BigInt(id) <= 9_223_372_036_854_775_807n ? id : null;
  } catch {
    return null;
  }
}

async function send(env, chatId, text) {
  const response = await fetchDelivery(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    }
  );
  if (!response.ok) throw new Error(`telegram checkout send failed: ${response.status}`);
  return { method: 'sendMessage', status: response.status, ok: true };
}

export async function processCheckoutStart(env, update) {
  const message = update?.message;
  const text = typeof message?.text === 'string' ? message.text : '';
  const match = START_RE.exec(text);
  if (!match) return { handled: false };

  const chatId = telegramUserId(message?.chat?.id);
  const fromId = telegramUserId(message?.from?.id);
  if (message?.chat?.type !== 'private' || !chatId || !fromId || chatId !== fromId) {
    if (chatId) {
      await send(env, chatId,
        'Откройте ссылку на оплату в личном чате с ботом — подключение из группы недоступно.');
    }
    return { handled: true, kind: 'checkout_private_chat_required' };
  }

  const result = await payments.bindCheckoutTelegram(env, match[1], fromId);
  if (result.ok) {
    const step = await send(env, chatId,
      '✓ Telegram подключён к оплате.\n\nВернитесь на smeshai.xyz — кнопка оплаты станет доступна. После подтверждения платежа лицензионный ключ придёт сюда.');
    return {
      handled: true,
      kind: result.already_bound ? 'checkout_already_connected' : 'checkout_connected',
      steps: [step]
    };
  }

  const messageText = result.reason === 'checkout_already_bound'
    ? 'Эта ссылка уже подключена к другому аккаунту Telegram. Вернитесь на сайт и создайте новую оплату.'
    : result.reason === 'checkout_expired'
      ? 'Ссылка на оплату истекла. Вернитесь на сайт и начните оформление заново.'
      : 'Не удалось подключить оплату по этой ссылке. Вернитесь на сайт и попробуйте ещё раз.';
  const step = await send(env, chatId, messageText);
  return { handled: true, kind: 'checkout_connect_rejected', reason: result.reason, steps: [step] };
}

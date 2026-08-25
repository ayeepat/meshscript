/**
 * Send the license key via Telegram DM.
 *
 * Set up:
 *   1. Talk to @BotFather → /newbot → save the bot token.
 *   2. `wrangler secret put TELEGRAM_BOT_TOKEN`
 *   3. The buyer opens the short-lived checkout deep link and presses Start.
 *      Telegram's authenticated private webhook supplies the numeric user id;
 *      the browser never supplies or edits that identity. Bots cannot DM cold
 *      users — Telegram's rule, not ours.
 *
 * If TELEGRAM_BOT_TOKEN is unset or the buyer never gave us a user_id,
 * the function quietly skips. Email then becomes the fallback.
 */
import { fetchDelivery } from './http.js';

export async function sendLicenseTelegram(env, {
  user_id, key, isPreorder, amount_kopecks = null, expires_at = null,
  payment_id = null, email = null
}) {
  if (!env.TELEGRAM_BOT_TOKEN || !user_id) return { skipped: true };

  const launchNote = isPreorder
    ? 'Расширение выйдет в конце июля. Мы сообщим вам, как только установочный файл будет готов — ключ заработает сразу.'
    : 'Откройте настройки расширения и вставьте ключ в поле «Лицензия».';

  const paymentLines = [];
  if (Number.isSafeInteger(amount_kopecks) && amount_kopecks > 0) {
    paymentLines.push(`Оплата подтверждена: ${formatKopecks(amount_kopecks)} ₽`);
  }
  if (expires_at) {
    const expiry = formatExpiry(expires_at);
    if (expiry) paymentLines.push(`Подписка действует до ${expiry}`);
  }
  if (/^\d+$/.test(String(payment_id || ''))) paymentLines.push(`Заказ №${payment_id}`);
  // Telegram and receipt email may belong to different family members. Do not
  // copy one channel's contact address into the other; the buyer already knows
  // which email they entered at Robokassa.
  if (email) paymentLines.push('Кассовый чек Robokassa отправит на указанный при оплате email');
  const paymentNote = paymentLines.length
    ? `${paymentLines.map(escapeMd).join('\n')}\n\n`
    : '';

  const text =
    '*Спасибо за поддержку\\!* 🙌\n\n' +
    paymentNote +
    'Ваш ключ доступа к *СМЭШ AI*:\n\n' +
    `\`${escapeMdCode(key)}\`\n\n` +
    `${escapeMd(launchNote)}\n\n` +
    '_Ключ активируется на одном устройстве\\. Чтобы перенести его на другой компьютер, нажмите «Деактивировать ключ на этом устройстве» в настройках расширения и активируйте ключ там\\. Если что — напишите прямо в этот чат\\._';

  let res;
  try {
    res = await fetchDelivery(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: user_id,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true
      }),
      redirect: 'manual'
    });
  } catch {
    return { skipped: false, ok: false, status: 0, error: 'network_error' };
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    return { skipped: false, ok: false, status: res.status, error: 'api_error' };
  }
  try { await res.body?.cancel(); } catch { /* already closed */ }
  return { skipped: false, ok: true };
}

function formatKopecks(value) {
  const rubles = Math.floor(value / 100);
  const kopecks = value % 100;
  return kopecks ? `${rubles},${String(kopecks).padStart(2, '0')}` : String(rubles);
}

function formatExpiry(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(date);
}

// MarkdownV2 reserves a long set of chars (https://core.telegram.org/bots/api#markdownv2-style).
// For prose OUTSIDE code spans, escape the full reserved set.
function escapeMd(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);
}

// INSIDE a `code` entity only ` and \ may be escaped — escaping anything else
// (e.g. the hyphens in SMESH-XXXX-…) makes Telegram render the backslashes
// literally, so the buyer copies a key like SMESH\-XXXX that /verify rejects.
function escapeMdCode(s) {
  return String(s).replace(/[`\\]/g, (c) => '\\' + c);
}

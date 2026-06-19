/**
 * Send the license key via Telegram DM.
 *
 * Set up:
 *   1. Talk to @BotFather → /newbot → save the bot token.
 *   2. `wrangler secret put TELEGRAM_BOT_TOKEN`
 *   3. The buyer must have messaged the bot at least once OR shared their
 *      user_id via the order form (Telegram Login Widget yields it cleanly).
 *      Bots can't DM cold users — Telegram's rule, not ours.
 *
 * If TELEGRAM_BOT_TOKEN is unset or the buyer never gave us a user_id,
 * the function quietly skips. Email then becomes the fallback.
 */

export async function sendLicenseTelegram(env, { user_id, key, isPreorder }) {
  if (!env.TELEGRAM_BOT_TOKEN || !user_id) return { skipped: true };

  const launchNote = isPreorder
    ? 'Расширение выйдет в конце июля. Мы сообщим вам, как только установочный файл будет готов — ключ заработает сразу.'
    : 'Откройте настройки расширения и вставьте ключ в поле «Лицензия».';

  const text =
    '*Спасибо за поддержку\\!* 🙌\n\n' +
    'Ваш ключ доступа к *СМЭШ AI*:\n\n' +
    `\`${escapeMd(key)}\`\n\n` +
    `${escapeMd(launchNote)}\n\n` +
    '_Ключ работает на трёх устройствах\\. Если что — напишите прямо в этот чат\\._';

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: user_id,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    })
  });
  if (!res.ok) {
    return { skipped: false, ok: false, status: res.status, error: await res.text() };
  }
  return { skipped: false, ok: true };
}

// MarkdownV2 reserves a long set of chars (https://core.telegram.org/bots/api#markdownv2-style).
// Escape everything outside the key's own block (we wrap the key in backticks
// which is monospace — chars inside backticks only need backslash for ` and \).
function escapeMd(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);
}

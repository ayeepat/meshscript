/**
 * Send the license key via email using Resend's HTTP API.
 * Free tier: 3000 emails/month, 100/day — well above preorder volume.
 *
 * Configure:
 *   wrangler secret put RESEND_API_KEY     # re_xxx from resend.com/api-keys
 *   in wrangler.toml: EMAIL_FROM = "СМЭШ AI <license@yourdomain>"
 *     (the from-address must be a verified sender / verified domain)
 *
 * If RESEND_API_KEY is unset the function quietly skips. Lets the operator
 * launch with Telegram-only delivery and add email later.
 */
import { fetchDelivery } from './http.js';

export async function sendLicenseEmail(env, { to, key, isPreorder, dedupe = true }) {
  if (!env.RESEND_API_KEY || !to) return { skipped: true };

  const launchNote = isPreorder
    ? 'Расширение выйдет в конце июля. Мы напишем вам, как только установочный файл будет готов — ваш ключ заработает сразу же.'
    : 'Откройте настройки расширения и вставьте ключ в поле «Лицензия».';

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0d0d0d;">
      <p style="font-size:14px;color:#5d5d66;margin:0 0 8px;">СМЭШ AI — Помощник для электронных журналов</p>
      <h1 style="font-size:20px;font-weight:700;margin:0 0 16px;">Спасибо! Ваш ключ доступа</h1>
      <div style="background:#f4f4f5;border-radius:12px;padding:18px;margin:0 0 20px;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:18px;letter-spacing:0.5px;text-align:center;">
        ${escapeHtml(key)}
      </div>
      <p style="font-size:14px;line-height:1.55;margin:0 0 12px;">${escapeHtml(launchNote)}</p>
      <p style="font-size:12px;color:#5d5d66;line-height:1.5;margin:24px 0 0;">
        Ключ активируется на одном устройстве. Чтобы перенести его на другой компьютер, нажмите «Деактивировать ключ на этом устройстве» в настройках расширения и активируйте ключ там. Если возникли вопросы — просто ответьте на это письмо.
      </p>
    </div>
  `;

  let res;
  try {
    res = await fetchDelivery('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      // Resend retains API idempotency keys for 24 hours. This covers the
      // ambiguous "provider accepted, isolate died before settlement" seam;
      // deliberate admin force-resends opt out via dedupe=false.
      ...(dedupe ? { 'Idempotency-Key': `license-delivery:${key}` } : {})
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'СМЭШ AI <onboarding@resend.dev>',
      to: [to],
      subject: 'Ваш ключ доступа к СМЭШ AI',
      html
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

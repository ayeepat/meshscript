/**
 * YooKassa webhook adapter.
 *
 * YooKassa authenticates webhooks two ways:
 *   1. IP allowlist — only specific YooKassa egress IPs send notifications.
 *      We check this first; it's a hard requirement.
 *   2. Basic auth header — optional; YooKassa lets you set a per-shop
 *      username/password that the worker can verify. Recommended.
 *
 * Docs: https://yookassa.ru/developers/using-api/webhooks
 *
 * Notification payload shape (relevant fields):
 *   {
 *     "type": "notification",
 *     "event": "payment.succeeded" | "payment.canceled" | "refund.succeeded",
 *     "object": {
 *       "id": "<payment_uuid>",
 *       "status": "succeeded",
 *       "amount": { "value": "990.00", "currency": "RUB" },
 *       "metadata": { ... },
 *       "description": "...",
 *       "captured_at": "...",
 *       "payment_method": { ... }
 *     }
 *   }
 *
 * To pass buyer contact info into the webhook, set `metadata` when creating
 * the payment on the client side:
 *   metadata: { email: "buyer@example.com", telegram_user_id: 12345 }
 *
 * Without that we have no way to deliver the key — the YooKassa form's
 * own email field is NOT echoed back in webhooks. The order page on
 * smesh.app must capture it before redirecting to YooKassa.
 */

// As of 2025; recheck https://yookassa.ru/developers/using-api/webhooks#ip
// every few months — they update this list when their infra changes.
const YOOKASSA_IPS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11/32',
  '77.75.156.35/32',
  '77.75.154.128/25',
  '2a02:5180::/32'
];

// Cheap CIDR-v4 match. v6 ranges (the ::/32) are accepted whole — Cloudflare
// already gives us a normalized IP, and we only have one v6 range to check.
function ipInRange(ip, cidr) {
  if (cidr.includes('::')) return ip.includes(':') && ip.startsWith(cidr.split('::')[0].split(':').slice(0, 2).join(':'));
  const [base, bits] = cidr.split('/');
  const mask = (0xffffffff << (32 - Number(bits))) >>> 0;
  const toInt = (s) => s.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

export function isYookassaIp(ip) {
  if (!ip) return false;
  return YOOKASSA_IPS.some((cidr) => ipInRange(ip, cidr));
}

/**
 * Optional Basic-auth check. Set a username/password pair in the YooKassa
 * dashboard under "HTTP-уведомления" and put them in worker secrets as
 * YOOKASSA_WEBHOOK_USER / YOOKASSA_WEBHOOK_PASS. Returns true if the secret
 * env vars are absent — in that case we rely on IP allowlisting alone.
 */
export function checkBasicAuth(request, env) {
  if (!env.YOOKASSA_WEBHOOK_USER || !env.YOOKASSA_WEBHOOK_PASS) return true;
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  const expected = 'Basic ' + btoa(`${env.YOOKASSA_WEBHOOK_USER}:${env.YOOKASSA_WEBHOOK_PASS}`);
  return header === expected;
}

/**
 * Server-to-server confirmation of a payment. A webhook body is attacker-
 * controllable if the IP allowlist or basic auth ever fails open (e.g. secrets
 * unset), so the amount/status in the notification must NOT be trusted on their
 * own. Re-fetch the payment straight from YooKassa's API and treat THAT as the
 * source of truth before issuing.
 *
 * Uses HTTP Basic auth: username = shopId, password = secret key.
 * Returns { ok:true, status, amount_rub } or { ok:false, reason }. When the shop
 * credentials aren't configured it returns { ok:true, skipped:true } so an
 * operator who hasn't set them yet keeps the old IP-allowlist-only behaviour —
 * but the worker logs a warning in that case.
 *
 * Docs: https://yookassa.ru/developers/api#get_payment
 */
export async function verifyPayment(env, paymentId) {
  if (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY) {
    return { ok: true, skipped: true };
  }
  if (!paymentId) return { ok: false, reason: 'no_payment_id' };
  const auth = 'Basic ' + btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`);
  let res;
  try {
    res = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: auth, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return { ok: false, reason: 'network' };
  }
  if (!res.ok) return { ok: false, reason: 'api_' + res.status };
  const p = await res.json().catch(() => null);
  if (!p || p.status !== 'succeeded' || p.paid !== true) {
    return { ok: false, reason: 'not_succeeded' };
  }
  return { ok: true, status: p.status, amount_rub: Number(p?.amount?.value || 0) };
}

/**
 * Translate a YooKassa notification into the canonical shape the worker's
 * issuance path expects. Returns null on events we don't act on (canceled,
 * refunded, anything not succeeded) so the worker can 200-OK them.
 */
export function parseNotification(payload) {
  if (!payload || payload.type !== 'notification') return null;
  if (payload.event !== 'payment.succeeded') return null;
  const o = payload.object || {};
  if (o.status !== 'succeeded') return null;
  const meta = o.metadata || {};
  return {
    gateway: 'yookassa',
    payment_id: o.id,
    amount_rub: Number((o.amount && o.amount.value) || 0),
    email: typeof meta.email === 'string' ? meta.email : null,
    telegram_user_id: meta.telegram_user_id ? Number(meta.telegram_user_id) : null,
    // Anything else the order page wants to thread through, e.g. UTM source.
    metadata: meta
  };
}

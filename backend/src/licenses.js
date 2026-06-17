/**
 * License storage + key generation.
 * Backed by a single Cloudflare KV namespace; rows are keyed by the license
 * key string itself. The shape is forward-compatible with Tier B
 * (subscriptions): adding a `type: "subscription"` with a finite expires_at
 * just works without migration.
 *
 *   {
 *     key: "SMESH-XXXX-XXXX-XXXX",
 *     type: "lifetime" | "subscription",
 *     status: "active" | "revoked",
 *     email: string | null,
 *     telegram_user_id: number | null,
 *     issued_at: ISO,
 *     expires_at: ISO | null,         // null = never (lifetime)
 *     payment_id: string | null,      // gateway's payment id, for idempotency
 *     gateway: "yookassa" | "tpay" | "manual",
 *     amount_rub: number | null,
 *     is_preorder: boolean,
 *     device_ids: string[],           // first-seen UUIDs; capped by DEVICE_LIMIT
 *     note: string | null
 *   }
 */

// Crockford base32 with confusable chars (0/O, 1/I/L, U) removed.
// 28 symbols — entropy per char ~4.8 bits. A 12-char key = ~58 bits, plenty
// for the volumes we'll see and short enough to type if Telegram delivery
// fails and the buyer has to copy it from email.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomChars(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

/** SMESH-XXXX-XXXX-XXXX. Always uppercase, no lookalikes. */
export function generateKey() {
  return `SMESH-${randomChars(4)}-${randomChars(4)}-${randomChars(4)}`;
}

/** Normalize user-supplied keys before lookup (lower→upper, strip spaces). */
export function normalizeKey(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export async function getLicense(env, key) {
  if (!key) return null;
  const raw = await env.LICENSES.get(normalizeKey(key));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function putLicense(env, license) {
  await env.LICENSES.put(license.key, JSON.stringify(license));
}

/**
 * Idempotent issuance. If a payment_id already produced a license, return that
 * one — protects against YooKassa replays and our own retries.
 *
 * We index by payment_id in a parallel KV key so the lookup is O(1).
 */
export async function findByPayment(env, gateway, paymentId) {
  if (!paymentId) return null;
  const key = await env.LICENSES.get(`payment:${gateway}:${paymentId}`);
  return key ? getLicense(env, key) : null;
}

export async function issueLicense(env, params) {
  const {
    gateway = 'manual',
    payment_id = null,
    email = null,
    telegram_user_id = null,
    type = 'lifetime',
    expires_at = null,
    amount_rub = null,
    is_preorder = false,
    note = null
  } = params;

  // Idempotency: same payment_id → same license, never a duplicate.
  if (payment_id) {
    const existing = await findByPayment(env, gateway, payment_id);
    if (existing) return existing;
  }

  // Collision-avoid loop. With 28^12 keyspace and preorder volumes this
  // basically never retries, but the check is free.
  let key, attempts = 0;
  do {
    key = generateKey();
    const collision = await env.LICENSES.get(key);
    if (!collision) break;
    if (++attempts > 5) throw new Error('keygen collisions exhausted');
  } while (true);

  const license = {
    key,
    type,
    status: 'active',
    email,
    telegram_user_id,
    issued_at: new Date().toISOString(),
    expires_at,
    payment_id,
    gateway,
    amount_rub,
    is_preorder,
    device_ids: [],
    note
  };
  await putLicense(env, license);
  if (payment_id) {
    await env.LICENSES.put(`payment:${gateway}:${payment_id}`, key);
  }
  return license;
}

/**
 * Verify a license for use on a specific device. Adds the device to the
 * license's device_ids on first-seen; rejects once the cap is reached.
 *
 * Returns `{ ok: true, type, expires_at }` on success or
 * `{ ok: false, reason }` on any failure mode — never throws on bad inputs
 * so the verify endpoint can stay simple.
 */
export async function verifyLicense(env, rawKey, deviceId) {
  const key = normalizeKey(rawKey);
  if (!key) return { ok: false, reason: 'not_found' };
  // Dev-bypass: a single hardcoded key the operator types into their own
  // Settings, lets them keep using the app without a real purchase. Set via
  // `wrangler secret put OWNER_LICENSE_KEY`. Empty/unset env disables the gate.
  if (env.OWNER_LICENSE_KEY && key === normalizeKey(env.OWNER_LICENSE_KEY)) {
    return { ok: true, type: 'lifetime', expires_at: null, owner: true };
  }
  const license = await getLicense(env, key);
  if (!license) return { ok: false, reason: 'not_found' };
  if (license.status !== 'active') return { ok: false, reason: 'revoked' };
  if (license.expires_at && Date.parse(license.expires_at) < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  const limit = Number(env.DEVICE_LIMIT || 3);
  if (deviceId) {
    if (!license.device_ids.includes(deviceId)) {
      if (license.device_ids.length >= limit) {
        return { ok: false, reason: 'device_limit', limit };
      }
      license.device_ids.push(deviceId);
      await putLicense(env, license);
    }
  }
  return { ok: true, type: license.type, expires_at: license.expires_at };
}

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
 *     gateway: "robokassa" | "tpay" | "manual",
 *     amount_rub: number | null,
 *     is_preorder: boolean,
 *     device_ids: string[],           // first-seen UUIDs; capped by DEVICE_LIMIT
 *     note: string | null
 *   }
 */

import { mirrorLicense } from './analytics.js';

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
  // Mirror into the D1 `purchases` table so the admin dashboard can query
  // revenue/retention with plain SQL. KV stays the source of truth: a D1
  // failure must never fail a payment webhook or a /verify device add.
  // (Import cycle with analytics.js is fine — both sides only call functions
  // at runtime, never during module evaluation.)
  try {
    await mirrorLicense(env, license);
  } catch (e) {
    console.warn('license mirror failed', license.key, String(e));
  }
}

/**
 * Look up the authoritative D1 payment claim, falling back to the historical
 * KV index for licenses issued before the payment_issuance migration.
 */
export async function findByPayment(env, gateway, paymentId) {
  if (!paymentId) return null;
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        'SELECT license_json FROM payment_issuance WHERE gateway = ?1 AND payment_id = ?2'
      ).bind(String(gateway), String(paymentId)).first();
      if (row?.license_json) {
        const license = JSON.parse(row.license_json);
        if (license?.key) return license;
      }
    } catch (e) {
      console.warn('payment issuance lookup failed', String(e));
    }
  }
  const key = await env.LICENSES.get(`payment:${gateway}:${paymentId}`);
  return key ? getLicense(env, key) : null;
}

// Atomically choose one license row for a gateway payment. The complete JSON
// is stored in D1 so a retry can recover and materialize the same KV row even
// if the winning invocation died after the SQL commit but before LICENSES.put.
async function claimPaymentLicense(env, gateway, paymentId, candidate) {
  if (!env.DB) throw new Error('payment issuance registry unavailable');
  const gatewayId = String(gateway);
  const payment = String(paymentId);
  const serialized = JSON.stringify(candidate);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO payment_issuance
       (gateway, payment_id, license_key, license_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(gatewayId, payment, candidate.key, serialized, Date.now()).run();
  const row = await env.DB.prepare(
    'SELECT license_json FROM payment_issuance WHERE gateway = ?1 AND payment_id = ?2'
  ).bind(gatewayId, payment).first();
  if (!row?.license_json) throw new Error('payment issuance claim failed');
  let winner;
  try { winner = JSON.parse(row.license_json); }
  catch { throw new Error('payment issuance registry is corrupt'); }
  if (!winner?.key || winner.gateway !== gateway || String(winner.payment_id) !== payment) {
    throw new Error('payment issuance registry mismatch');
  }
  return winner;
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

  // D1, not KV, is the authority for paid issuance. KV has no compare-and-swap:
  // two concurrent webhook deliveries could both miss its payment index and
  // mint different keys. Requiring D1 makes a missing migration/outage retryable
  // instead of silently issuing twice.
  if (payment_id) {
    if (!env.DB) throw new Error('payment issuance registry unavailable');
    const existing = await findByPayment(env, gateway, payment_id);
    if (existing) {
      const winner = await claimPaymentLicense(env, gateway, payment_id, existing);
      await putLicense(env, winner);
      await env.LICENSES.put(`payment:${gateway}:${payment_id}`, winner.key);
      return winner;
    }
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
  if (payment_id) {
    const winner = await claimPaymentLicense(env, gateway, payment_id, license);
    await putLicense(env, winner);
    await env.LICENSES.put(`payment:${gateway}:${payment_id}`, winner.key);
    return winner;
  }
  await putLicense(env, license);
  return license;
}

/**
 * Atomically claim a device slot for a license in D1 (the `license_devices`
 * table). Cloudflare KV has no compare-and-swap, so the historical
 * read-`device_ids`-then-write path let two concurrent /verify calls with
 * distinct devices both observe `length < limit` and both push — quietly
 * exceeding DEVICE_LIMIT. SQLite serializes writers, so a single conditional
 * INSERT whose `WHERE` re-counts the table under the write lock cannot race:
 * the second insert sees the first's committed row.
 *
 * Returns:
 *   { ok:true,  added:bool }   device is (now) claimed — added on first-seen
 *   { ok:false, reason:'device_limit' }  cap reached, device not present
 *   null                       D1 unavailable — caller MUST fall back to the KV
 *                              check so a D1 hiccup never fails an otherwise
 *                              valid verify (KV stays the source of truth).
 *
 * `knownDevices` (the KV license row's device_ids) are seeded first so the
 * count is authoritative even for licenses created before this table existed;
 * INSERT OR IGNORE keeps the seed idempotent and never widens the cap.
 */
async function claimDeviceSlot(env, key, deviceId, limit, knownDevices) {
  if (!env.DB) return null;
  try {
    const now = Date.now();
    if (knownDevices?.length) {
      await env.DB.batch(knownDevices.slice(0, 64).map((d) =>
        env.DB.prepare('INSERT OR IGNORE INTO license_devices (license_key, device_id, added_at) VALUES (?, ?, ?)')
          .bind(key, d, now)));
    }
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO license_devices (license_key, device_id, added_at)
       SELECT ?1, ?2, ?3
       WHERE (SELECT COUNT(*) FROM license_devices WHERE license_key = ?1) < ?4`
    ).bind(key, deviceId, now, limit).run();
    if ((res?.meta?.changes || 0) > 0) return { ok: true, added: true };
    // No row inserted: the device already holds a slot (allowed), or the cap is
    // full (rejected). One cheap existence check disambiguates.
    const existing = await env.DB.prepare(
      'SELECT 1 FROM license_devices WHERE license_key = ?1 AND device_id = ?2'
    ).bind(key, deviceId).first();
    return existing ? { ok: true, added: false } : { ok: false, reason: 'device_limit' };
  } catch (e) {
    // Missing table (pre-migration) or a D1 outage — fail OPEN to the KV path.
    console.warn('device slot registry unavailable, falling back to KV cap', String(e));
    return null;
  }
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
  // Operator bypass: a single server-side secret the operator types into their
  // own Settings, letting them keep using the app without a real purchase. Set
  // via `wrangler secret put OWNER_LICENSE_KEY`. Empty/unset env disables it.
  // Deliberately return the same public shape as a lifetime license so the
  // client UI/network response does not fingerprint this as an owner key.
  if (env.OWNER_LICENSE_KEY && key === normalizeKey(env.OWNER_LICENSE_KEY)) {
    return { ok: true, type: 'lifetime', expires_at: null };
  }
  const license = await getLicense(env, key);
  if (!license) return { ok: false, reason: 'not_found' };
  if (license.status !== 'active') return { ok: false, reason: 'revoked' };
  if (license.expires_at && Date.parse(license.expires_at) < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  const limit = Number(env.DEVICE_LIMIT || 3);
  if (deviceId) {
    // Real clients send crypto.randomUUID() (see the extension's history.js).
    // /verify is public, so bound what gets persisted: without this, a caller
    // who knows a key could push arbitrary multi-megabyte strings into the
    // license row (or burn its slots with garbage). Reject rather than treat
    // as absent — treating garbage as "no device" would let a scripted caller
    // skip device binding entirely.
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) {
      return { ok: false, reason: 'bad_device' };
    }
    const known = Array.isArray(license.device_ids) ? license.device_ids : [];
    // An already-accepted device needs no cap decision — the slot was claimed
    // when it was first seen — so the atomic D1 path only runs for a genuinely
    // NEW device (the sole contended operation), keeping hot re-verifies free.
    if (!known.includes(deviceId)) {
      const claim = await claimDeviceSlot(env, key, deviceId, limit, known);
      if (claim) {
        if (!claim.ok) return { ok: false, reason: 'device_limit', limit };
        // Mirror into the KV row for admin/display; D1 is authoritative for the
        // cap, so a failed/racing KV write can't reopen the slot.
        license.device_ids = [...known, deviceId];
        await putLicense(env, license);
      } else {
        // D1 unavailable — best-effort KV cap (the pre-existing behaviour).
        if (known.length >= limit) return { ok: false, reason: 'device_limit', limit };
        license.device_ids = [...known, deviceId];
        await putLicense(env, license);
      }
    }
  }
  return { ok: true, type: license.type, expires_at: license.expires_at };
}

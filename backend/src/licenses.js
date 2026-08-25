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
 *     expires_at: ISO | null,         // null = lifetime OR paid subscription awaiting first activation
 *     subscription_days: integer | null,
 *     subscription_duration_ms: integer | null,
 *     subscription_started_at: ISO | null,
 *     payment_id: string | null,      // gateway's payment id, for idempotency
 *     gateway: "robokassa" | "tpay" | "manual",
 *     amount_kopecks: integer | null,     // authoritative money representation
 *     amount_rub: number | null,          // compatibility/display only
 *     is_preorder: boolean,
 *     referral_code: string | null,      // validated checkout referral intent
 *     device_ids: string[],           // historical first-seen UUIDs (display/audit only)
 *     note: string | null
 *   }
 */

import { mirrorLicense } from './analytics.js';

// Crockford base32 with confusable chars (0/O, 1/I/L, U) removed.
// 30 symbols — entropy per char ~4.9 bits. A 12-char key = ~59 bits, plenty
// for the volumes we'll see and short enough to type if Telegram delivery
// fails and the buyer has to copy it from email.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const SINGLE_DEVICE_LIMIT = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SUBSCRIPTION_DAYS = 3650;

/**
 * Uniform symbols from ALPHABET. Shared with referrals.js so the two credential
 * generators cannot drift apart.
 *
 * 256 is not a multiple of the alphabet size, so a plain `byte % length` makes
 * the first (256 mod length) symbols measurably likelier and quietly shrinks
 * the effective keyspace of every license key and referral code. Reject the
 * biased tail of the byte range instead.
 */
export function randomChars(n) {
  const ceiling = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  const buf = new Uint8Array(n);
  let out = '';
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= ceiling) continue; // biased tail — draw again
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out;
}

/** SMESH-XXXX-XXXX-XXXX. Always uppercase, no lookalikes. */
export function generateKey() {
  return `SMESH-${randomChars(4)}-${randomChars(4)}-${randomChars(4)}`;
}

/** Normalize user-supplied keys before lookup (lower→upper, strip spaces). */
export function normalizeKey(raw) {
  if (typeof raw !== 'string') return '';
  let normalized = raw.trim().toUpperCase().replace(/\s+/g, '');
  // The public format contains 12 random characters. Accept the same key when
  // copied without the two visual grouping hyphens and restore its canonical
  // representation before the KV lookup. Existing 16-character/legacy keys
  // remain untouched and therefore keep working.
  const compact = /^SMESH-([23456789ABCDEFGHJKMNPQRSTVWXYZ]{12})$/.exec(normalized);
  if (compact) {
    normalized = `SMESH-${compact[1].slice(0, 4)}-${compact[1].slice(4, 8)}-${compact[1].slice(8)}`;
  }
  // KV keys are bounded and license credentials contain only this alphabet.
  // Reject malformed/oversized caller input before it reaches a storage lookup.
  return normalized.length <= 128 && /^[A-Z0-9-]+$/.test(normalized) ? normalized : '';
}

function subscriptionDays(raw) {
  const days = Number(raw);
  return Number.isSafeInteger(days) && days >= 1 && days <= MAX_SUBSCRIPTION_DAYS
    ? days
    : null;
}

function subscriptionDurationMs(raw) {
  const duration = Number(raw);
  return Number.isSafeInteger(duration) && duration >= DAY_MS &&
    duration <= MAX_SUBSCRIPTION_DAYS * DAY_MS
    ? duration
    : null;
}

// Paid subscriptions issued before activation-bound expiry stored only an
// absolute issue-time expiry. If such a Robokassa key has never been activated,
// recover the purchased duration from its immutable issuance row so that the
// buyer still receives the full period from first activation.
function activationDurationForLicense(license) {
  const stored = subscriptionDurationMs(license?.subscription_duration_ms);
  if (stored) return stored;
  const days = subscriptionDays(license?.subscription_days);
  if (days) return days * DAY_MS;
  if (license?.gateway !== 'robokassa') return null;
  const issued = Date.parse(license?.issued_at || '');
  const expires = Date.parse(license?.expires_at || '');
  const inferred = expires - issued;
  return subscriptionDurationMs(inferred);
}

function activationBoundExpiry(entitlement, activatedAt) {
  if (!entitlement) return null;
  const start = Number(activatedAt);
  if (!Number.isSafeInteger(start) || start <= 0) return null;
  const base = start + entitlement.duration_ms;
  if (!Number.isSafeInteger(base)) return null;
  return Math.max(base, entitlement.existing_expiry_ms || 0);
}

// Stored expiries are a security boundary, not free-form dates. JavaScript's
// Date parser accepts locale-dependent spellings and even normalizes impossible
// dates such as 2026-02-30. Accept only the exact UTC shape produced by
// Date#toISOString and round-trip it to reject calendar overflow.
export function normalizeExpiry(raw) {
  if (typeof raw !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) {
    return null;
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  try { return new Date(ms).toISOString() === raw ? raw : null; }
  catch { return null; }
}

// A malformed cap is an authorization configuration failure, not a number we
// should let JavaScript coerce. In particular, fractions silently round the
// practical cap up (`3.5` admits four devices), while zero/negative/huge values
// can lock out every buyer or make the cap meaningless. `null` tells the caller
// to fail closed only for a genuinely new device; known devices stay usable.
function configuredDeviceLimit(env) {
  const raw = env.DEVICE_LIMIT;
  if (raw == null || String(raw).trim() === '') return SINGLE_DEVICE_LIMIT;
  const limit = Number(raw);
  return Number.isSafeInteger(limit) && limit === SINGLE_DEVICE_LIMIT ? limit : null;
}

export function deviceLimitConfigValid(env) {
  return configuredDeviceLimit(env) != null;
}

export async function getLicense(env, key) {
  const normalized = normalizeKey(key);
  if (!normalized) return null;
  const raw = await env.LICENSES.get(normalized);
  if (!raw) return null;
  try {
    // KV is only the materialized row. Permanent revocation and the monotonic
    // referral-expiry journal are D1-authoritative, so EVERY entitlement read
    // overlays them. This keeps authorization correct even if an older
    // already-started KV write lands after a newer writer; no finite KV lease
    // can cancel an in-flight remote put.
    const stored = JSON.parse(raw);
    const durable = await overlayDurableLicenseState(env, stored);
    // Revocation is permanent and D1-authoritative. Repair a stale active KV
    // mirror while it is in hand so admin/delivery views do not keep exposing
    // the resurrected row. Expiry overlays are intentionally not written here:
    // a read-side whole-row write could overwrite an unrelated concurrent
    // device mirror. Referral application explicitly materializes its durable
    // absolute expiry under the target lock.
    if (stored.status !== 'revoked' && durable.status === 'revoked') {
      try {
        await env.LICENSES.put(normalized, JSON.stringify(durable));
        await mirrorLicenseBestEffort(env, durable);
      } catch (error) {
        // Authorization still uses the D1 verdict. A failed mirror repair is
        // availability/ops debt, not permission to grant the key.
        console.warn('revoked license mirror repair failed', error?.name || 'error');
      }
    }
    return durable;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

// Whole-row KV writes are vulnerable to stale-read lost updates. D1 carries
// the two entitlement facts that must NEVER be rolled back by such a write:
// permanent revocation and every absolute referral expiry already promised to
// this key. Overlay both before and after the KV put. The post-write fence gives
// a clean ordering guarantee:
//   - if a D1 mutation committed before the first read, the first put includes it;
//   - if it commits during the put, the second read heals the row;
//   - if it commits after the second read, that mutator's own KV write follows.
async function overlayDurableLicenseState(env, license) {
  if (!env.DB || !license?.key || license.status === 'revoked') return license;

  const checked = await getRevocation(env, license.key);
  if (!checked.ok) throw new Error('license revocation registry unavailable');
  if (checked.revocation) {
    const revokedAtMs = Number(checked.revocation.revoked_at);
    let revokedAt = license.revoked_at || null;
    if (!revokedAt && Number.isFinite(revokedAtMs)) {
      try { revokedAt = new Date(revokedAtMs).toISOString(); } catch { /* status is authoritative */ }
    }
    return {
      ...license,
      status: 'revoked',
      revoked_at: revokedAt,
      revoke_reason: license.revoke_reason || checked.revocation.reason || null
    };
  }

  if (license.type !== 'subscription') return license;
  let promised;
  try {
    promised = await env.DB.prepare(
      `SELECT MAX(target_expiry) AS expiry FROM referral_credit_state
       WHERE target_key = ?1 AND status = 'applied'`
    ).bind(license.key).first();
  } catch {
    // Once D1 is configured, silently writing around an unavailable entitlement
    // journal can permanently shorten paid referral time. Keep the operation
    // retryable instead.
    throw new Error('referral entitlement registry unavailable');
  }
  if (promised?.expiry == null) return license;
  const canonicalPromise = normalizeExpiry(promised.expiry);
  if (!canonicalPromise) throw new Error('referral entitlement registry is corrupt');
  const promisedMs = Date.parse(canonicalPromise);
  const current = normalizeExpiry(license.expires_at);
  const currentMs = current ? Date.parse(current) : NaN;
  if (Number.isFinite(currentMs) && currentMs >= promisedMs) return license;
  return { ...license, expires_at: new Date(promisedMs).toISOString() };
}

async function mirrorLicenseBestEffort(env, license) {
  // Mirror into the D1 `purchases` table so the admin dashboard can query
  // revenue/retention with plain SQL. KV stays the license source of truth;
  // the device-cap DECISION below deliberately fails closed when D1 is down.
  // (Import cycle with analytics.js is fine — both sides only call functions
  // at runtime, never during module evaluation.)
  try {
    await mirrorLicense(env, license);
  } catch (e) {
    // The license key is a bearer credential and must never enter logs.
    console.warn('license mirror failed', e?.name || 'error');
  }
}

export async function putLicense(env, license) {
  let durable = await overlayDurableLicenseState(env, license);
  await env.LICENSES.put(durable.key, JSON.stringify(durable));
  const fenced = await overlayDurableLicenseState(env, durable);
  if (fenced !== durable) {
    await env.LICENSES.put(fenced.key, JSON.stringify(fenced));
    durable = fenced;
  }
  await mirrorLicenseBestEffort(env, durable);
  return durable;
}

// D1 payment snapshots exist only to bridge the commit→KV crash seam. Once
// the KV license row exists it is the live source of truth: revocation, referral
// expiry extensions, and device claims must never be rolled back by a replay.
async function preferLivePaymentLicense(env, snapshot) {
  const live = snapshot?.key ? await getLicense(env, snapshot.key) : null;
  const license = live || snapshot;
  if (!license?.key) return { license, live: !!live };

  // Payment recovery is another path that can surface a stale-active KV row
  // (or the immutable issue-time snapshot) after a refund. Overlay the
  // insert-only D1 revocation before the caller decides whether to deliver or
  // credit this bearer key. This also closes the rare seam where the original
  // KV put succeeded but its materialization marker did not, allowing a later
  // stale-null read to consider rewriting the active snapshot.
  return { live: !!live, license: await overlayDurableLicenseState(env, license) };
}

/* -------- write-once KV materialization gate (kv_materializations) -------- */
// KV has no compare-and-set, so "write the row if a read says it's missing" is
// a stale-read race against every later mutation of that row: a delayed
// webhook replay can observe null, pause, and then overwrite a row that was
// revoked / device-bound / credited in between. D1 is strongly consistent and
// carries the two pieces KV cannot: a write-once flag recording that the row
// HAS been materialized (after which no recovery may ever write the snapshot
// again) and a per-name lease serializing the materializers themselves.

// Recovery is a rare payment-webhook path. A minute is intentionally much
// longer than a normal KV operation, while a crashed holder still self-heals
// on a later gateway retry. No finite D1 lease can retract an already-started
// external KV write; the conditional renewals below detect that pathological
// case, and this headroom makes a takeover during the write far less likely.
const KV_LOCK_LEASE_MS = 60_000;
const KV_LOCK_ATTEMPTS = 30;
const KV_LOCK_RETRY_DELAY_MS = 100;

export async function isMaterialized(env, name) {
  const row = await env.DB.prepare(
    'SELECT 1 AS done FROM kv_materializations WHERE name = ?1'
  ).bind(name).first();
  return !!row;
}

export async function markMaterialized(env, name) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO kv_materializations (name, materialized_at) VALUES (?1, ?2)'
  ).bind(name, Date.now()).run();
}

async function acquireKvLock(env, name) {
  for (let attempt = 0; attempt < KV_LOCK_ATTEMPTS; attempt++) {
    const now = Date.now();
    const acquired = await env.DB.prepare(
      `INSERT INTO kv_apply_locks(name, lease_until) VALUES(?1, ?2)
       ON CONFLICT(name) DO UPDATE SET lease_until = excluded.lease_until
       WHERE kv_apply_locks.lease_until < ?3
       RETURNING lease_until`
    ).bind(name, now + KV_LOCK_LEASE_MS, now).first();
    const leaseUntil = Number(acquired?.lease_until) || 0;
    if (leaseUntil) return leaseUntil;
    if (attempt < KV_LOCK_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, KV_LOCK_RETRY_DELAY_MS));
    }
  }
  return 0;
}

async function renewKvLock(env, name, leaseUntil) {
  const now = Date.now();
  const renewed = await env.DB.prepare(
    `UPDATE kv_apply_locks SET lease_until = ?3
     WHERE name = ?1 AND lease_until = ?2 AND lease_until >= ?4
     RETURNING lease_until`
  ).bind(name, leaseUntil, now + KV_LOCK_LEASE_MS, now).first();
  const next = Number(renewed?.lease_until) || 0;
  if (!next) throw new Error('license materialization lease lost');
  return next;
}

async function releaseKvLock(env, name, leaseUntil) {
  // Bound release to this lease so an expired holder cannot delete a takeover.
  await env.DB.prepare(
    'DELETE FROM kv_apply_locks WHERE name = ?1 AND lease_until = ?2'
  ).bind(name, leaseUntil).run();
}

/**
 * Look up the authoritative D1 payment claim, falling back to the historical
 * KV index for licenses issued before the payment_issuance migration. The D1
 * JSON is crash-recovery data only; an existing live KV row always wins.
 */
export async function findByPayment(env, gateway, paymentId) {
  if (!paymentId) return null;
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        'SELECT license_json FROM payment_issuance WHERE gateway = ?1 AND payment_id = ?2'
      ).bind(String(gateway), String(paymentId)).first();
      if (row?.license_json) {
        const snapshot = JSON.parse(row.license_json);
        if (snapshot?.key) return (await preferLivePaymentLicense(env, snapshot)).license;
      }
    } catch (e) {
      console.warn('payment issuance lookup failed', String(e));
    }
  }
  const key = await env.LICENSES.get(`payment:${gateway}:${paymentId}`);
  return key ? getLicense(env, key) : null;
}

// Atomically choose one license row for a gateway payment. The complete JSON
// is stored in D1 only so a retry can materialize a MISSING KV row if the
// winner died after the SQL commit. It must never overwrite a live KV row.
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

// Complete the D1→KV seam for either claim site. The snapshot may only be
// written while the D1 write-once flag is unset AND under the per-key lease:
// without both, a replay that reads a stale "missing" KV verdict could pause
// and then overwrite a revocation or device claim that landed in between. Once
// the flag is set the row provably existed, so a missing read is KV staleness
// and the snapshot must never be written again.
async function materializePaymentLicense(env, gateway, paymentId, snapshot) {
  // The payment index pointer is content-immutable for a claimed payment
  // (payment → winning key never changes), so replaying it is always safe.
  await env.LICENSES.put(`payment:${gateway}:${paymentId}`, snapshot.key);
  const name = `license:${snapshot.key}`;
  if (await isMaterialized(env, name)) {
    return (await preferLivePaymentLicense(env, snapshot)).license;
  }
  let lease = await acquireKvLock(env, name);
  // Contention exhausting the lease is transient; throwing keeps the webhook
  // non-acked so the gateway redelivers into the idempotent claim.
  if (!lease) throw new Error('license materialization contended');
  try {
    if (await isMaterialized(env, name)) {
      return (await preferLivePaymentLicense(env, snapshot)).license;
    }
    const preferred = await preferLivePaymentLicense(env, snapshot);
    // Fence the stale-read decision immediately before the destructive
    // snapshot write. A post-write renewal detects a write that abnormally
    // outlived the lease and keeps the D1 marker retryable; it cannot undo a
    // KV put that has already landed, hence the deliberately long lease above.
    lease = await renewKvLock(env, name, lease);
    if (!preferred.live) {
      // Route even the first materialization through the same pre/post D1
      // entitlement fence as every later whole-row write. A revocation can
      // commit after preferLivePaymentLicense() but before this put begins;
      // a direct snapshot write would otherwise land active after the revoke.
      preferred.license = await putLicense(env, preferred.license);
      lease = await renewKvLock(env, name, lease);
    }
    await markMaterialized(env, name);
    lease = await renewKvLock(env, name, lease);
    return preferred.license;
  } finally {
    await releaseKvLock(env, name, lease);
  }
}

/**
 * Recover an already-claimed payment without re-deriving today's price, plan,
 * contact, or expiry. Gateway retries can arrive after those mutable settings
 * change; the immutable D1 payment claim is the authority for what the original
 * accepted callback issued. Returns null only when no historical claim/index
 * exists, and otherwise repairs the D1→KV materialization seam idempotently.
 */
export async function recoverPaymentLicense(env, gateway, paymentId) {
  if (!paymentId) return null;
  const existing = await findByPayment(env, gateway, paymentId);
  if (!existing) return null;
  if (!env.DB) throw new Error('payment issuance registry unavailable');
  const winner = await claimPaymentLicense(env, gateway, paymentId, existing);
  return materializePaymentLicense(env, gateway, paymentId, winner);
}

export async function issueLicense(env, params) {
  const {
    gateway = 'manual',
    payment_id = null,
    email = null,
    telegram_user_id = null,
    type = 'lifetime',
    expires_at = null,
    subscription_days = null,
    subscription_duration_ms = null,
    amount_kopecks = null,
    amount_rub = null,
    is_preorder = false,
    referral_code = null,
    note = null,
    defer_materialization = false
  } = params;

  if (defer_materialization &&
      (gateway !== 'referral' || !String(payment_id || '').startsWith('referral:'))) {
    throw new Error('deferred materialization is referral-only');
  }

  let canonicalAmountKopecks = amount_kopecks;
  if (canonicalAmountKopecks == null && amount_rub != null) {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount_rub));
    canonicalAmountKopecks = match
      ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'))
      : null;
  }
  if (canonicalAmountKopecks != null &&
      (!Number.isSafeInteger(canonicalAmountKopecks) || canonicalAmountKopecks <= 0)) {
    throw new Error('invalid amount_kopecks');
  }

  // Time-bound correctness at the single issuance chokepoint (webhook, admin,
  // referral rewards all pass through here): an unknown type or a subscription
  // without a real expiry would read as "never expires" downstream.
  if (type !== 'lifetime' && type !== 'subscription') {
    throw new Error(`unknown license type: ${String(type).slice(0, 32)}`);
  }
  const canonicalExpiry = expires_at == null ? null : normalizeExpiry(expires_at);
  if (expires_at != null && !canonicalExpiry) {
    throw new Error('invalid expires_at');
  }
  const canonicalDays = subscription_days == null ? null : subscriptionDays(subscription_days);
  if (subscription_days != null && !canonicalDays) {
    throw new Error('invalid subscription_days');
  }
  let canonicalDuration = subscription_duration_ms == null
    ? null
    : subscriptionDurationMs(subscription_duration_ms);
  if (subscription_duration_ms != null && !canonicalDuration) {
    throw new Error('invalid subscription_duration_ms');
  }
  if (!canonicalDuration && canonicalDays) canonicalDuration = canonicalDays * DAY_MS;
  if (type === 'subscription' && canonicalExpiry == null && canonicalDuration == null) {
    throw new Error('subscription requires expires_at or duration');
  }
  if (type === 'lifetime' && (canonicalDays != null || canonicalDuration != null)) {
    throw new Error('lifetime cannot have subscription duration');
  }

  // D1, not KV, is the authority for paid issuance. KV has no compare-and-swap:
  // two concurrent webhook deliveries could both miss its payment index and
  // mint different keys. Requiring D1 makes a missing migration/outage retryable
  // instead of silently issuing twice.
  if (payment_id) {
    if (!env.DB) throw new Error('payment issuance registry unavailable');
    const existing = defer_materialization
      ? await findByPayment(env, gateway, payment_id)
      : await recoverPaymentLicense(env, gateway, payment_id);
    if (existing) return existing;
  }

  // Collision-avoid loop. With 30^12 keyspace and preorder volumes this
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
    expires_at: canonicalExpiry,
    subscription_days: type === 'subscription' ? canonicalDays : null,
    subscription_duration_ms: type === 'subscription' ? canonicalDuration : null,
    subscription_started_at: null,
    payment_id,
    gateway,
    amount_kopecks: canonicalAmountKopecks,
    amount_rub: canonicalAmountKopecks == null ? null : canonicalAmountKopecks / 100,
    is_preorder,
    referral_code: typeof referral_code === 'string' &&
      /^REF-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(referral_code)
      ? referral_code
      : null,
    device_ids: [],
    note
  };
  if (payment_id) {
    const winner = await claimPaymentLicense(env, gateway, payment_id, license);
    return defer_materialization
      ? winner
      : materializePaymentLicense(env, gateway, payment_id, winner);
  }
  await putLicense(env, license);
  return license;
}

/* --------------------- D1-authoritative revocation --------------------- */
// The KV license row is rewritten wholesale by concurrent mutators (the
// /verify device mirror below, referral expiry extensions) and KV reads can
// be stale for up to a minute, so a revocation recorded only as KV status can
// be resurrected to "active" by any in-flight read-modify-write. D1 is
// strongly consistent and this registry is insert-only: once a key is here,
// no KV write can ever un-revoke it.

export async function getRevocation(env, key) {
  // Some manual/test environments intentionally have no D1 binding. Preserve
  // that compatibility signal separately from a configured registry that
  // failed: a transient D1 error must never be indistinguishable from "no
  // revocation row", because stale-active KV is not authorization evidence.
  if (!env.DB) return { ok: true, revocation: null };
  try {
    const revocation = await env.DB.prepare(
      'SELECT revoked_at, reason FROM license_revocations WHERE license_key = ?1'
    ).bind(key).first() || null;
    return { ok: true, revocation };
  } catch (e) {
    console.warn('license revocation registry unavailable', String(e));
    return { ok: false, revocation: null };
  }
}

async function revocationVerdict(env, key, license) {
  const checked = await getRevocation(env, key);
  if (!checked.ok) return { ok: false, reason: 'service_unavailable' };
  const revocation = checked.revocation;
  if (!revocation) return null;

  // The KV mirror lost or never saw the revocation (stale read, or a
  // concurrent read-modify-write resurrected it). D1 is authoritative; heal
  // the freshest mirror best-effort and reject regardless of the KV outcome.
  const current = (await getLicense(env, key)) || license;
  current.status = 'revoked';
  if (!current.revoked_at && revocation.revoked_at) {
    current.revoked_at = new Date(Number(revocation.revoked_at)).toISOString();
  }
  try { await putLicense(env, current); } catch { /* next verify heals */ }
  return { ok: false, reason: 'revoked' };
}

/**
 * Record the AUTHORITATIVE D1 revocation for a well-formed key, whether or not
 * a readable KV projection exists.
 *
 * This is the entry point money-moving callers must use. getLicense() returns
 * null both for "no such key" and for a projection whose JSON does not parse,
 * so gating the durable write on it meant a refund could complete — cash
 * returned, order marked refunded — while no permanent revocation ever landed.
 * If that key were later restored into KV, the entitlement would still work.
 * The D1 registry is insert-only and strongly consistent, so it does not need
 * KV's cooperation; the projection is repaired afterwards, best effort.
 *
 * Returns { ok, revoked_at, license } — `license` is the healed projection, or
 * null when there was nothing readable to heal. Throws when the revocation
 * cannot be proven durable, so callers retry instead of proceeding.
 */
export async function revokeLicenseDurable(env, rawKey, reason = null) {
  const key = normalizeKey(rawKey);
  if (!key) return { ok: false, reason: 'bad_key', revoked_at: null, license: null };
  if (!env.DB) throw new Error('revocation registry unavailable');
  const revokedAt = Date.now();
  const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 500) || null : null;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO license_revocations (license_key, revoked_at, reason) VALUES (?1, ?2, ?3)'
    ).bind(key, revokedAt, safeReason),
    // A referral row is keyed by the purchased/source license. Cancel every
    // not-yet-linearized reward in the same strongly-consistent transaction as
    // revocation, and remove its pending entitlement promise. materialized_at
    // mirrors the pending-cancel in reverseReferralCreditForPurchase so both
    // writers leave the identical terminal row and the reversal's "already"
    // branch recognizes this one too.
    env.DB.prepare(
      `UPDATE referral_credit_state
       SET status = 'cancelled', materialized_at = ?2, target_kind = NULL,
           target_key = NULL, target_expiry = NULL, retry_after = 0,
           last_error_at = NULL
       WHERE license_key = ?1 AND status = 'pending'`
    ).bind(key, revokedAt)
  ]);
  // INSERT OR IGNORE reports no change for an already-revoked key, so the
  // batch's own row count proves nothing. Read the registry back: callers that
  // are about to release money need positive evidence the row is THERE, not
  // merely that a statement was submitted without throwing.
  const proof = await getRevocation(env, key);
  if (!proof.ok || !proof.revocation) {
    throw new Error('license revocation is not durable');
  }

  // Best effort from here on. A missing or corrupt projection must never be
  // able to undo or block the durable revocation proven above.
  let license = null;
  try {
    license = await getLicense(env, key);
  } catch (error) {
    console.warn('revoked license projection unreadable', error?.name || 'error');
  }
  if (license) {
    license.status = 'revoked';
    license.revoked_at = license.revoked_at || new Date(revokedAt).toISOString();
    license.revoke_reason = safeReason || license.revoke_reason || null;
    try {
      await putLicense(env, license);
    } catch (error) {
      // Every entitlement read overlays D1 (see overlayDurableLicenseState),
      // so the key is already unusable. This is mirror debt, not access.
      console.warn('revoked license projection repair failed', error?.name || 'error');
    }
  }
  const durableAt = Number(proof.revocation.revoked_at);
  return {
    ok: true,
    revoked_at: Number.isFinite(durableAt) ? durableAt : revokedAt,
    license
  };
}

/**
 * Admin revoke (refunds, fraud) — same durable write, plus the "unknown key is
 * a 404" contract the admin endpoint reports. Money-moving callers must use
 * revokeLicenseDurable instead: for them an unreadable projection is a reason
 * to revoke anyway, not a reason to skip it.
 * Returns the revoked license, or null when the key does not exist.
 */
export async function revokeLicense(env, rawKey, reason = null) {
  const key = normalizeKey(rawKey);
  if (!key) return null;
  if (!env.DB) throw new Error('revocation registry unavailable');
  if (!(await getLicense(env, key))) return null;
  const result = await revokeLicenseDurable(env, key, reason);
  return result.license;
}

const ACTIVATION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function cleanActivationToken(raw) {
  const token = typeof raw === 'string' ? raw.trim() : '';
  return ACTIVATION_TOKEN_RE.test(token) ? token : '';
}

function randomActivationToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function activationTokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedHistoricalDevices(env, key, knownDevices, now) {
  const valid = Array.isArray(knownDevices)
    ? [...new Set(knownDevices.filter((device) =>
      typeof device === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(device)).slice(0, 64))]
    : [];
  if (!valid.length) return;
  await env.DB.batch(valid.map((device, index) => env.DB.prepare(
    'INSERT OR IGNORE INTO license_devices (license_key, device_id, added_at) VALUES (?1, ?2, ?3)'
  ).bind(key, device, now + index)));
}

/**
 * Authorize exactly one active extension installation.
 *
 * The client UUID identifies the installation but is not an authenticator.
 * First activation returns a random bearer capability; every later verify and
 * deactivation must prove possession of it. A competing installation that only
 * knows the license key receives `device_in_use` and cannot take over.
 */
async function claimActiveInstallation(
  env, key, deviceId, rawToken, knownDevices, entitlement = null, attempt = 0
) {
  if (!env.DB) return { ok: false, reason: 'registry_unavailable' };
  try {
    const now = Date.now();
    const suppliedToken = cleanActivationToken(rawToken);
    const suppliedHash = suppliedToken ? await activationTokenHash(suppliedToken) : '';
    const row = await env.DB.prepare(
      `SELECT status, device_id, token_hash, generation, activated_at
       FROM license_activations WHERE license_key = ?1`
    ).bind(key).first();

    const existingExpiry = row?.activated_at == null
      ? null
      : activationBoundExpiry(entitlement, row.activated_at);
    if (entitlement && row && existingExpiry == null) {
      return { ok: false, reason: 'registry_unavailable' };
    }
    if (existingExpiry != null && existingExpiry <= now) {
      return { ok: false, reason: 'expired' };
    }

    if (row?.status === 'active') {
      if (row.device_id !== deviceId || !suppliedHash || row.token_hash !== suppliedHash) {
        return { ok: false, reason: 'device_in_use', device_number: 1 };
      }
      const touched = await env.DB.prepare(
        `UPDATE license_activations SET last_seen_at = ?4
         WHERE license_key = ?1 AND status = 'active' AND device_id = ?2 AND token_hash = ?3`
      ).bind(key, deviceId, suppliedHash, now).run();
      if ((touched?.meta?.changes || 0) < 1) {
        if (attempt < 1) {
          return claimActiveInstallation(
            env, key, deviceId, rawToken, knownDevices, entitlement, attempt + 1
          );
        }
        return { ok: false, reason: 'device_in_use', device_number: 1 };
      }
      return {
        ok: true,
        activated: false,
        generation: Number(row.generation) || 1,
        activated_at: Number(row.activated_at) || null,
        expires_at: existingExpiry == null ? null : new Date(existingExpiry).toISOString()
      };
    }

    // Before this migration `license_devices` was the only record. Preserve
    // continuity by letting its earliest historical installation become device
    // №1; a random first caller with a copied key cannot steal an old license.
    if (!row) {
      await seedHistoricalDevices(env, key, knownDevices, now);
      const legacy = await env.DB.prepare(
        `SELECT device_id FROM license_devices
         WHERE license_key = ?1 ORDER BY added_at, device_id LIMIT 1`
      ).bind(key).first();
      if (legacy?.device_id && legacy.device_id !== deviceId) {
        return { ok: false, reason: 'device_in_use', device_number: 1 };
      }
    }

    const token = randomActivationToken();
    const tokenHash = await activationTokenHash(token);
    let changed = 0;
    if (row?.status === 'inactive') {
      const updated = await env.DB.prepare(
        `UPDATE license_activations
         SET status = 'active', device_id = ?2, token_hash = ?3,
             generation = generation + 1, activated_at = COALESCE(activated_at, ?4),
             last_seen_at = ?4, deactivated_at = NULL
         WHERE license_key = ?1 AND status = 'inactive'`
      ).bind(key, deviceId, tokenHash, now).run();
      changed = Number(updated?.meta?.changes || 0);
    } else {
      const inserted = await env.DB.prepare(
        `INSERT OR IGNORE INTO license_activations
           (license_key, status, device_id, token_hash, generation,
            activated_at, last_seen_at, deactivated_at)
         VALUES (?1, 'active', ?2, ?3, 1, ?4, ?4, NULL)`
      ).bind(key, deviceId, tokenHash, now).run();
      changed = Number(inserted?.meta?.changes || 0);
    }
    if (changed > 0) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO license_devices (license_key, device_id, added_at) VALUES (?1, ?2, ?3)'
      ).bind(key, deviceId, now).run();
      const activatedAt = Number(row?.activated_at) || now;
      const expiresAt = activationBoundExpiry(entitlement, activatedAt);
      if (entitlement && expiresAt == null) {
        return { ok: false, reason: 'registry_unavailable' };
      }
      return {
        ok: true,
        activated: true,
        activated_at: activatedAt,
        expires_at: expiresAt == null ? null : new Date(expiresAt).toISOString(),
        activation_token: token
      };
    }
    if (attempt < 2) {
      return claimActiveInstallation(
        env, key, deviceId, rawToken, knownDevices, entitlement, attempt + 1
      );
    }
    return { ok: false, reason: 'device_in_use', device_number: 1 };
  } catch (error) {
    console.warn('license activation registry unavailable; failing closed', error?.name || 'error');
    return { ok: false, reason: 'registry_unavailable' };
  }
}

async function mirrorHistoricalDevice(env, key, deviceId, license) {
  let fresh;
  try { fresh = (await getLicense(env, key)) || license; }
  catch { return license; }

  // A first-activation KV projection may fail, while this later historical
  // device mirror succeeds. Never let that recovery write restore the old
  // issue-time expiry. Preserve the activation start/frozen duration and the
  // later of the two expiry projections; durable referral promises are still
  // overlaid again inside putLicense().
  let projectionChanged = false;
  const projectedStart = normalizeExpiry(license.subscription_started_at);
  const projectedDuration = subscriptionDurationMs(license.subscription_duration_ms);
  const projectedExpiry = normalizeExpiry(license.expires_at);
  if (projectedStart && projectedDuration && projectedExpiry) {
    const freshExpiry = normalizeExpiry(fresh.expires_at);
    const laterExpiry = !freshExpiry ||
      (projectedExpiry && Date.parse(projectedExpiry) > Date.parse(freshExpiry))
      ? projectedExpiry
      : freshExpiry;
    const projectedDays = subscriptionDays(license.subscription_days);
    projectionChanged = fresh.subscription_started_at !== projectedStart ||
      fresh.subscription_duration_ms !== projectedDuration ||
      (projectedDays != null && fresh.subscription_days !== projectedDays) ||
      fresh.expires_at !== laterExpiry;
    if (projectionChanged) {
      fresh = {
        ...fresh,
        subscription_started_at: projectedStart,
        subscription_duration_ms: projectedDuration,
        ...(projectedDays != null ? { subscription_days: projectedDays } : {}),
        expires_at: laterExpiry
      };
    }
  }

  const freshKnown = Array.isArray(fresh.device_ids) ? fresh.device_ids : [];
  if (!freshKnown.includes(deviceId) || projectionChanged) {
    fresh.device_ids = [...freshKnown, deviceId];
    if (freshKnown.includes(deviceId)) fresh.device_ids = freshKnown;
    try { return await putLicense(env, fresh); }
    catch (error) { console.warn('license device mirror failed', error?.name || 'error'); }
  }
  return fresh;
}

/** Explicit sign-out. Revoked/expired licenses may still deactivate so the
 * buyer can move the key after renewal or operator repair. */
export async function deactivateLicense(env, rawKey, deviceId, rawToken) {
  const key = normalizeKey(rawKey);
  const token = cleanActivationToken(rawToken);
  if (!key) return { ok: false, reason: 'not_found' };
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(deviceId || ''))) {
    return { ok: false, reason: 'bad_device' };
  }
  if (!token) return { ok: false, reason: 'bad_activation' };
  if (!env.DB) return { ok: false, reason: 'service_unavailable' };
  try {
    const hash = await activationTokenHash(token);
    const now = Date.now();
    const result = await env.DB.prepare(
      `UPDATE license_activations
       SET status = 'inactive', device_id = NULL, token_hash = NULL,
           generation = generation + 1, deactivated_at = ?4
       WHERE license_key = ?1 AND status = 'active' AND device_id = ?2 AND token_hash = ?3`
    ).bind(key, deviceId, hash, now).run();
    if ((result?.meta?.changes || 0) > 0) return { ok: true };
    const row = await env.DB.prepare(
      'SELECT status FROM license_activations WHERE license_key = ?1'
    ).bind(key).first();
    if (row?.status === 'inactive') return { ok: true, already_inactive: true };
    return { ok: false, reason: 'activation_mismatch' };
  } catch (error) {
    console.warn('license deactivation registry unavailable', error?.name || 'error');
    return { ok: false, reason: 'service_unavailable' };
  }
}

/** Verify a license for one authenticated active installation. */
export async function verifyLicense(env, rawKey, deviceId, activationToken = '') {
  const key = normalizeKey(rawKey);
  if (!key) return { ok: false, reason: 'not_found' };
  // Operator bypass: a single server-side secret the operator types into their
  // own Settings, letting them keep using the app without a real purchase. Set
  // via `wrangler secret put OWNER_LICENSE_KEY`. Empty/unset env disables it.
  // Deliberately return the same public shape as a lifetime license so the
  // client UI/network response does not fingerprint this as an owner key.
  const ownerLicense = env.OWNER_LICENSE_KEY && key === normalizeKey(env.OWNER_LICENSE_KEY);
  let license;
  if (ownerLicense) {
    license = { key, type: 'lifetime', status: 'active', expires_at: null, device_ids: [] };
  } else {
    try {
      license = await getLicense(env, key);
    } catch (error) {
      console.warn('license entitlement registry unavailable', error?.name || 'error');
      return { ok: false, reason: 'service_unavailable' };
    }
    if (!license) return { ok: false, reason: 'not_found' };
    if (license.status !== 'active') return { ok: false, reason: 'revoked' };
    const initialRevocation = await revocationVerdict(env, key, license);
    if (initialRevocation) return initialRevocation;
  }
  // Only the two issuance types have defined authorization semantics. A
  // corrupt/legacy typo with no expiry used to fall through as an eternal
  // license; treat unknown state as an availability failure instead.
  if (license.type !== 'lifetime' && license.type !== 'subscription') {
    return { ok: false, reason: 'service_unavailable' };
  }
  const canonicalExpiry = license.expires_at == null
    ? null
    : normalizeExpiry(license.expires_at);
  const durationMs = license.type === 'subscription'
    ? activationDurationForLicense(license)
    : null;
  const activationEntitlement = durationMs == null
    ? null
    : {
        duration_ms: durationMs,
        existing_expiry_ms: canonicalExpiry ? Date.parse(canonicalExpiry) : 0
      };

  // Legacy/manual subscriptions without a purchased duration keep their
  // absolute expiry. New paid subscriptions (and unactivated historical
  // Robokassa rows) are checked against D1's immutable first activated_at in
  // claimActiveInstallation below. A corrupt row matches neither shape and
  // fails closed instead of becoming eternal.
  if (license.type === 'subscription' && !activationEntitlement) {
    const expiresMs = canonicalExpiry ? Date.parse(canonicalExpiry) : NaN;
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      return { ok: false, reason: 'expired' };
    }
  } else if (license.type === 'lifetime' && license.expires_at != null) {
    const expiresMs = canonicalExpiry ? Date.parse(canonicalExpiry) : NaN;
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      return { ok: false, reason: 'expired' };
    }
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(deviceId || ''))) {
    return { ok: false, reason: 'bad_device' };
  }
  if (configuredDeviceLimit(env) == null) return { ok: false, reason: 'service_unavailable' };
  const activation = await claimActiveInstallation(
    env, key, deviceId, activationToken, license.device_ids, activationEntitlement
  );
  if (!activation.ok) {
    return activation.reason === 'registry_unavailable'
      ? { ok: false, reason: 'service_unavailable' }
      : activation;
  }
  if (!ownerLicense) {
    if (activationEntitlement) {
      const effectiveExpiry = normalizeExpiry(activation.expires_at);
      const startMs = Number(activation.activated_at);
      if (!effectiveExpiry || !Number.isSafeInteger(startMs) || startMs <= 0) {
        return { ok: false, reason: 'service_unavailable' };
      }
      const startedAt = new Date(startMs).toISOString();
      if (license.expires_at !== effectiveExpiry ||
          license.subscription_started_at !== startedAt ||
          license.subscription_duration_ms !== durationMs) {
        const activatedLicense = {
          ...license,
          expires_at: effectiveExpiry,
          subscription_started_at: startedAt,
          subscription_duration_ms: durationMs
        };
        try { license = await putLicense(env, activatedLicense); }
        catch (error) {
          // D1 activated_at + the frozen duration remain authoritative, so a
          // failed KV mirror cannot shorten, restart, or make the subscription
          // eternal. A later verified request repairs the projection.
          console.warn('subscription activation mirror failed', error?.name || 'error');
          license = activatedLicense;
        }
      }
    }
    license = await mirrorHistoricalDevice(env, key, deviceId, license);
    const finalRevocation = await revocationVerdict(env, key, license);
    if (finalRevocation) return finalRevocation;
  }
  return {
    ok: true,
    type: license.type,
    expires_at: license.expires_at,
    ...(activation.activation_token ? { activation_token: activation.activation_token } : {})
  };
}

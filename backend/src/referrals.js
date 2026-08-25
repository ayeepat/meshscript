/**
 * Referral program: enter a friend's code at checkout, both sides win.
 *
 * There is exactly ONE reward path, and it is gated on a real payment:
 *   - A buyer types a REF code into the pay page. The site threads it to
 *     Robokassa as a SIGNED custom param (Shp_ref_code), which Robokassa
 *     echoes back to our ResultURL webhook. (It may also live in the
 *     authoritative D1 payment order.)
 *   - On confirmed payment: the REFERRER earns REFERRAL_PAID_DAYS (7) of
 *     subscription, and the BUYER's own new subscription is extended by
 *     REFERRAL_BUYER_BONUS_PCT (10%) — a 30-day plan becomes 33 days.
 *
 * Because the only reward requires money to change hands, there is NO
 * client-side "claim/activate" tracking, no device fingerprinting, and no
 * abuse cap — every payout corresponds to real revenue. Self-referral detection
 * is identity-based and best-effort: delivery email/Telegram is compared with
 * the referrer's explicit and device-linked licenses, while checkout device_id
 * is an extra signal when present. A never-licensed referrer's first purchase,
 * or a buyer rotating fresh contact identities, can still pass; no code here
 * claims otherwise, but the resulting payout remains backed by real revenue.
 *
 * The anonymous device_id locates one stable invite code, but is NOT accepted
 * as authorization. A separate 256-bit `referral_auth` capability is generated
 * by the extension, stored only in trusted local storage, and persisted here as
 * a SHA-256 digest. This prevents a leaked/reused device id from disclosing the
 * reward key or redirecting future rewards to an attacker's license.
 *
 * KV layout (shared LICENSES namespace):
 *   ref:<CODE>            — the referrer's record (stats + where days land);
 *                           legacy_purchases / legacy_days_earned capture the
 *                           pre-journal counter baseline exactly once
 *   refauth:<sha256>       — referral capability digest → its stable code
 *   refowner:<device_id>  — legacy/admin/analytics pointer only; never auth
 *   refpaid:<license_key> — legacy mirror materialized after D1 says applied
 *
 * KV is eventually consistent with no transactions. D1 referral_auth_claims
 * chooses one code per capability; referral_credits owns the one-payout claim;
 * referral_credit_state makes partial work retryable and referral_apply_locks
 * serializes both each code's KV read-modify-write sequence and each shared
 * license target's expiry reservation/application.
 */

import {
  getLicense, putLicense, issueLicense, normalizeKey, randomChars,
  isMaterialized, markMaterialized, getRevocation, recoverPaymentLicense
} from './licenses.js';
// Runtime-only cycle with analytics.js (which imports cleanDeviceId from
// here) — same pattern as the licenses↔analytics cycle: both sides only call
// functions at request time, never during module evaluation.
import { bumpDailyBudget, mskDay } from './analytics.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const REFERRAL_CODE_CLAIM_ATTEMPTS = 12;
const REFERRAL_CREDIT_BATCH_LIMIT = 25;
const REFERRAL_RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;

// Codes use the same confusable-free alphabet and the same unbiased sampler as
// license keys — imported rather than copied so a fix to one cannot miss the
// other (the local copy previously carried a modulo bias of its own).
function newCode() {
  return `REF-${randomChars(4)}-${randomChars(4)}`;
}

/** Accepts "ref 1234 5678", "REF-1234-5678", "ref12345678" → canonical form. */
export function normalizeRefCode(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^REF[A-Z0-9]{8}$/.test(s)) return '';
  return `REF-${s.slice(3, 7)}-${s.slice(7, 11)}`;
}

// Legacy/admin lookups still need to address identifiers written by older
// builds, so this compatibility parser remains deliberately broader than the
// public-ingress parser below.
export function cleanDeviceId(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9-]{8,64}$/.test(s) ? s : '';
}

// Every current extension install is created with crypto.randomUUID(). Public
// endpoints must accept only that exact, content-free shape: a loose
// "identifier" field otherwise lets a caller persist a phone number, email
// fragment, or license-like credential anywhere device_id is stored.
export function cleanPublicDeviceId(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s)
    ? s
    : '';
}

// 32 random bytes encoded as unpadded base64url. Keep the exact shape narrow so
// malformed credentials never become attacker-controlled large hash inputs.
export function cleanReferralAuth(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_-]{43}$/.test(s) ? s : '';
}

async function referralAuthHash(secret) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeTextEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let diff = a.length ^ b.length;
  const width = Math.max(a.length, b.length, 64);
  for (let i = 0; i < width; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function referralAuthMatches(ref, secret) {
  const auth = cleanReferralAuth(secret);
  if (!auth || typeof ref?.auth_hash !== 'string') return false;
  return constantTimeTextEqual(ref.auth_hash, await referralAuthHash(auth));
}

// Existing deployments created referral rows before the independent capability
// existed. Migration is deliberately narrow: the client must know its cached
// invite code AND prove an already-recorded active license is already bound to
// this device. An empty record is not safe for first-caller-wins migration: its
// public invite code can earn value later, while a device id is explicitly not
// an authorization credential. Rows without stronger evidence fail closed and
// require operator recovery.
async function canMigrateLegacyAuth(env, ref, device, ownKey, knownCode) {
  if (normalizeRefCode(knownCode || '') !== ref.code) return false;
  const candidate = ownKey && (ownKey === ref.owner_license_key || ownKey === ref.reward_key)
    ? ownKey
    : null;
  if (!candidate) return false;
  const license = await getLicense(env, candidate);
  return !!(license && license.status === 'active' &&
    Array.isArray(license.device_ids) && license.device_ids.includes(device));
}

/* ------------------------------ env knobs ----------------------------- */

const envInt = (env, name, dflt, max) => {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return dflt;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return dflt;
  const n = Number(text);
  return Number.isSafeInteger(n) && n <= max ? n : dflt;
};
export const paidDays = (env) => envInt(env, 'REFERRAL_PAID_DAYS', 7, 3650);
export const REFERRAL_REWARD_CAP_DAYS = 30;
export const buyerBonusPct = (env) => envInt(env, 'REFERRAL_BUYER_BONUS_PCT', 10, 100);
export const ipDailyLimit = (env) => envInt(env, 'REFERRAL_IP_DAILY_LIMIT', 30, 10_000);

/* ----------------------------- KV helpers ----------------------------- */

async function getJson(env, key) {
  const raw = await env.LICENSES.get(key);
  if (!raw) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  // ref:* is a materialized projection, not the authority for earned value.
  // A KV put that started under an old lease can finish after a newer payout
  // and leave the raw object with old counters or a detached reward pointer.
  // Rebuild those monotonic fields from D1 on every production read so public
  // status, checkout checks, admin inspection, and the next mutation all see
  // the durable state even when the last physical KV writer was stale.
  if (env.DB && key.startsWith('ref:') && value && typeof value === 'object') {
    const code = typeof value.code === 'string' ? value.code : key.slice(4);
    // Legacy records and deterministic test fixtures predate today's public
    // code grammar. Storage identity still has one unambiguous requirement:
    // the embedded code must exactly name the KV key and stay tightly bounded.
    if (!code || code.length > 64 || key !== `ref:${code}`) {
      throw new Error('referral materialization is corrupt');
    }
    value.code = code;
    const claim = await env.DB.prepare(
      'SELECT auth_hash FROM referral_auth_claims WHERE code = ?1'
    ).bind(code).first();
    if (claim?.auth_hash) value.auth_hash = claim.auth_hash;
    await reattachRewardIntent(env, value);
    await applyJournalTotals(env, value);
  }
  return value;
}

const putJson = (env, key, value, opts) =>
  env.LICENSES.put(key, JSON.stringify(value), opts);

/**
 * Daily per-IP counter for the invite-code endpoint. Returns true when the
 * request is allowed. The counter is the atomic D1 budget: the historical KV
 * read-increment-write raced — N synchronized requests could all read 0, all
 * be admitted, and leave the counter at 1, so the limiter never actually
 * bounded unauthenticated record minting. A missing/unavailable D1 binding
 * fails closed instead of silently reopening the raceable path.
 */
export async function bumpIpBudget(env, ip) {
  const limit = ipDailyLimit(env);
  if (!limit) return true; // 0 explicitly disables the limiter
  if (!env.DB) return false;
  // Cloudflare normally supplies cf-connecting-ip, but local proxies and
  // misconfigured routes may not. A missing header must share one bounded
  // bucket instead of becoming an unauthenticated limiter bypass.
  const budgetKey = String(ip || '').trim().slice(0, 64) || 'unknown';
  try {
    return (await bumpDailyBudget(env, mskDay(), 'ref_ip', budgetKey, 1, limit)) <= limit;
  } catch (e) {
    console.warn('referral ip budget unavailable; rejecting', e?.name || 'error');
    return false;
  }
}

/* ------------------------- referrer: get a code ----------------------- */

/**
 * Create (or return the existing) referral code for a capability. Idempotence
 * is keyed by the capability digest, not device id: otherwise someone who
 * learns another installation's pseudonymous device id could pre-claim or
 * block its referral identity. `refowner:<device>` remains only as a legacy,
 * admin, and analytics pointer. `licenseKey` (optional) is remembered so
 * rewards can extend an active subscription directly.
 */
export async function getOrCreateCode(env, deviceId, licenseKey, referralAuth, knownCode) {
  const device = cleanDeviceId(deviceId);
  if (!device) return { ok: false, reason: 'bad_device' };
  const auth = cleanReferralAuth(referralAuth);
  if (!auth) return { ok: false, reason: 'bad_auth' };
  const authHash = await referralAuthHash(auth);
  const ownKey = normalizeKey(licenseKey || '') || null;

  // The capability is the primary identity. This also means a malicious
  // caller cannot squat a victim's device id before the real installation's
  // first request: the victim's independent capability gets its own record.
  const authCode = await env.LICENSES.get(`refauth:${authHash}`);
  if (authCode) {
    const ref = await getJson(env, `ref:${authCode}`);
    if (ref && await referralAuthMatches(ref, auth)) {
      // Routine refreshes must not rewrite the record at all; a real pointer
      // change goes through the leased, journal-reconciled path so it can
      // never clobber a payout that landed concurrently or that a stale KV
      // read has not seen yet.
      if (ownKey && ref.owner_license_key !== ownKey) {
        await mutateReferralRecord(env, ref.code, (fresh) => {
          if (fresh.owner_license_key === ownKey) return false;
          fresh.owner_license_key = ownKey;
          return true;
        }, authHash);
      }
      return { ok: true, code: ref.code };
    }
    // A hash-key collision is infeasible; a mismatch here means corrupt
    // storage. Fail closed instead of silently rebinding the capability.
    return { ok: false, reason: 'unauthorized' };
  }

  const existingCode = await env.LICENSES.get(`refowner:${device}`);
  if (existingCode) {
    const ref = await getJson(env, `ref:${existingCode}`);
    if (ref) {
      if (!ref.auth_hash) {
        if (!(await canMigrateLegacyAuth(env, ref, device, ownKey, knownCode))) {
          return { ok: false, reason: 'legacy_auth_required' };
        }
        const updated = await mutateReferralRecord(env, ref.code, (fresh) => {
          let changed = false;
          if (!fresh.auth_hash) { fresh.auth_hash = authHash; changed = true; }
          if (ownKey && fresh.owner_license_key !== ownKey) {
            fresh.owner_license_key = ownKey;
            changed = true;
          }
          return changed;
        }, authHash);
        // Another capability may have migrated the record while this request
        // validated; never point this capability at a record it does not own.
        if (updated?.auth_hash !== authHash) return { ok: false, reason: 'unauthorized' };
        await env.LICENSES.put(`refauth:${authHash}`, ref.code);
        return { ok: true, code: ref.code };
      }
      if (!(await referralAuthMatches(ref, auth))) {
        // This modern record belongs to a different capability that merely
        // declared the same pseudonymous device id. Device ids are not auth;
        // do not let its pointer block creation for the present capability.
        return await createReferralRecord(env, device, ownKey, authHash);
      }
      // Keep the owner's license pointer fresh (they may have bought a sub
      // after generating the code) — again only via the leased path.
      if (ownKey && ref.owner_license_key !== ownKey) {
        await mutateReferralRecord(env, ref.code, (fresh) => {
          if (fresh.owner_license_key === ownKey) return false;
          fresh.owner_license_key = ownKey;
          return true;
        }, authHash);
      }
      await env.LICENSES.put(`refauth:${authHash}`, ref.code);
      return { ok: true, code: ref.code };
    }
    // Dangling pointer (should not happen) — fall through and recreate.
  }

  return createReferralRecord(env, device, ownKey, authHash);
}

/**
 * Rewrite ref:<code> outside the payout path. getOrCreateCode used to rewrite
 * the whole record unleased on every refresh: interleaved with a payout sweep
 * — or fed by a stale KV read — that write could reset purchases/days_earned
 * and detach reward_key AFTER a credit had materialized, leaving the reward
 * undiscoverable. Every non-payout write now (a) happens only when `mutate`
 * reports a real change, (b) serializes against sweeps via the same per-code
 * lease, and (c) rebuilds counters and the reward pointer from the D1 journal
 * so even a stale read cannot persist a pre-payout view of the record.
 */
async function mutateReferralRecord(env, code, mutate, expectedAuthHash = null) {
  if (!env.DB) {
    // Manual/test environments keep the legacy best-effort write.
    const ref = await getJson(env, `ref:${code}`);
    if (!ref) return null;
    if (expectedAuthHash && ref.auth_hash && ref.auth_hash !== expectedAuthHash) {
      throw new Error('referral record authorization changed');
    }
    let repairedAuth = false;
    if (expectedAuthHash && !ref.auth_hash) { ref.auth_hash = expectedAuthHash; repairedAuth = true; }
    if (mutate(ref) === false && !repairedAuth) return ref;
    await putJson(env, `ref:${code}`, ref);
    return ref;
  }
  return withReferralLease(env, code, 'referral record update contended', async (renew) => {
    const ref = await getJson(env, `ref:${code}`);
    if (!ref) return null;
    await renew();
    if (expectedAuthHash && ref.auth_hash && ref.auth_hash !== expectedAuthHash) {
      throw new Error('referral record authorization changed');
    }
    let repairedAuth = false;
    if (expectedAuthHash && !ref.auth_hash) { ref.auth_hash = expectedAuthHash; repairedAuth = true; }
    if (mutate(ref) === false && !repairedAuth) return ref;
    await reattachRewardIntent(env, ref);
    await applyJournalTotals(env, ref);
    await renew();
    await putJson(env, `ref:${code}`, ref);
    await renew();
    // The record provably exists — protect it from claim-recovery rewrites.
    await markMaterialized(env, `ref:${code}`);
    await renew();
    return ref;
  });
}

async function claimReferralCode(env, authHash) {
  // Recover a claim that committed before its KV pointers materialized.
  const existing = await env.DB.prepare(
    'SELECT code FROM referral_auth_claims WHERE auth_hash = ?1'
  ).bind(authHash).first();
  if (existing?.code) return existing.code;

  for (let attempt = 0; attempt < REFERRAL_CODE_CLAIM_ATTEMPTS; attempt++) {
    const candidate = newCode();
    // Preserve compatibility with pre-D1 referral rows that have no SQL claim.
    if (await env.LICENSES.get(`ref:${candidate}`)) continue;

    // Schema enforces both auth_hash and code uniqueness. INSERT OR IGNORE has
    // two useful outcomes: a same-auth concurrent winner appears in the SELECT
    // below, while a different auth that owns this code leaves no row for this
    // auth and therefore makes us generate a fresh candidate.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO referral_auth_claims (auth_hash, code, created_at)
       VALUES (?1, ?2, ?3)`
    ).bind(authHash, candidate, Date.now()).run();
    const claim = await env.DB.prepare(
      'SELECT code FROM referral_auth_claims WHERE auth_hash = ?1'
    ).bind(authHash).first();
    if (claim?.code) return claim.code;
  }
  throw new Error('ref codegen collisions exhausted');
}

async function createReferralRecord(env, device, ownKey, authHash) {
  let code;
  if (env.DB) {
    code = await claimReferralCode(env, authHash);
  } else {
    let attempts = 0;
    do {
      code = newCode();
      if (!(await env.LICENSES.get(`ref:${code}`))) break;
      if (++attempts > 5) throw new Error('ref codegen collisions exhausted');
    } while (true);
  }

  const ref = {
    code,
    owner_device_id: device,
    owner_license_key: ownKey,
    auth_hash: authHash,
    created_at: new Date().toISOString(),
    purchases: 0,      // paying friends who used this code at checkout
    days_earned: 0,    // total subscription days credited to the referrer
    reward_key: null   // dedicated reward license, minted on first credit
  };
  if (env.DB) {
    await materializeReferralRecord(env, code, ref);
  } else if (!(await env.LICENSES.get(`ref:${code}`))) {
    // Manual/test environments without D1 keep the best-effort legacy check.
    await putJson(env, `ref:${code}`, ref);
  }
  await env.LICENSES.put(`refauth:${authHash}`, code);
  // Compatibility pointer for analytics/admin lookup and legacy migration.
  // Public endpoints never treat it as proof of ownership.
  await env.LICENSES.put(`refowner:${device}`, code);
  return { ok: true, code };
}

// Write the initial ref:<code> record exactly once. A recovery of the D1 claim
// can read a stale-null KV verdict while a concurrent purchase is crediting the
// SAME code; an unguarded write would reset its counters and reward pointer to
// zero. The write therefore happens only under the code's apply lease (so it
// cannot interleave with a sweep) and only while the D1 write-once flag says
// the record has never been materialized. The sweep sets the same flag, so a
// record that has ever earned a credit is permanently protected.
async function materializeReferralRecord(env, code, initialRef) {
  const name = `ref:${code}`;
  if (await isMaterialized(env, name)) return;
  return withReferralLease(env, code, 'referral record materialization contended', async (renew) => {
    if (await isMaterialized(env, name)) return;
    const existing = await getJson(env, name);
    await renew();
    if (!existing) {
      await putJson(env, name, initialRef);
      await renew();
    }
    await markMaterialized(env, name);
    await renew();
  });
}

/* --------------------- checkout: resolve + validate ------------------- */

/**
 * Validate a code the buyer entered at checkout. Pure (no writes): the webhook
 * uses `.valid` to decide the buyer bonus, then credits the referrer.
 *   { valid: true, ref }              — apply the reward
 *   { valid: false, reason }          — ignore silently, issue a plain license
 * Best-effort only: explicit license pointers plus up to five licenses already
 * activated on the referrer's device supply identities. This catches repeat
 * self-referral after first activation, but not a never-licensed first purchase
 * or a buyer rotating contact identities. Missing identities never match.
 */
export async function resolveReferral(env, {
  code: rawCode, buyerDeviceId, buyerEmail, buyerTelegramId
} = {}) {
  const code = normalizeRefCode(rawCode || '');
  if (!code) return { valid: false, reason: 'bad_code' };
  const ref = await getJson(env, `ref:${code}`);
  if (!ref) return { valid: false, reason: 'not_found' };
  const buyer = cleanDeviceId(buyerDeviceId || '');
  if (buyer && ref.owner_device_id === buyer) return { valid: false, reason: 'self_referral' };

  const email = typeof buyerEmail === 'string' ? buyerEmail.trim().toLowerCase() : '';
  const telegramRaw = buyerTelegramId === null || buyerTelegramId === undefined
    ? '' : String(buyerTelegramId).trim();
  const telegram = telegramRaw && Number.isFinite(Number(telegramRaw)) ? Number(telegramRaw) : null;
  const keys = new Set([ref.owner_license_key, ref.reward_key].filter(Boolean));
  if (env.DB && ref.owner_device_id) {
    try {
      const rows = await env.DB.prepare(
        'SELECT license_key FROM license_devices WHERE device_id = ?1 LIMIT 5'
      ).bind(ref.owner_device_id).all();
      for (const row of rows?.results || []) if (row?.license_key) keys.add(row.license_key);
    } catch (e) {
      // Identity correlation is defense in depth, not payment availability:
      // a D1 outage must not reject an otherwise legitimate paid purchase.
      console.warn('referral device identity lookup unavailable', e?.name || 'error');
    }
  }
  for (const key of keys) {
    const license = await getLicense(env, key);
    if (!license) continue;
    const ownerEmail = typeof license.email === 'string' ? license.email.trim().toLowerCase() : '';
    const ownerTelegramRaw = license.telegram_user_id === null || license.telegram_user_id === undefined
      ? '' : String(license.telegram_user_id).trim();
    const ownerTelegram = ownerTelegramRaw && Number.isFinite(Number(ownerTelegramRaw))
      ? Number(ownerTelegramRaw) : null;
    if ((email && ownerEmail && email === ownerEmail) ||
        (telegram !== null && ownerTelegram !== null && telegram === ownerTelegram)) {
      return { valid: false, reason: 'self_referral' };
    }
  }
  return { valid: true, ref };
}

/**
 * The paying friend's own new subscription, extended by the buyer bonus.
 * Returns a new ISO string; passes null/lifetime expiry through untouched
 * (you can't extend "never"). Bonus = REFERRAL_BUYER_BONUS_PCT % of the
 * license's remaining duration, which at issue time is the full plan length
 * (30-day plan → +3 days).
 */
export function withBuyerBonus(env, expiresAtIso) {
  const pct = buyerBonusPct(env);
  if (!pct || !expiresAtIso) return expiresAtIso;
  const exp = Date.parse(expiresAtIso);
  if (!Number.isFinite(exp)) return expiresAtIso;
  const bonusMs = Math.max(0, exp - Date.now()) * (pct / 100);
  const bonused = exp + bonusMs;
  // Date#toISOString throws outside the representable range. A malformed
  // environment value or corrupt far-future plan must not turn an otherwise
  // valid paid webhook into a retry loop.
  if (!Number.isFinite(bonused) || Math.abs(bonused) > 8.64e15) return expiresAtIso;
  return new Date(bonused).toISOString();
}

/**
 * Credit the referrer for a confirmed purchase. D1 records a fixed target and
 * absolute expiry, then a per-code lease sweeps every pending row in order.
 * Retries are therefore idempotent and later purchases self-heal older work.
 * Without D1, manual/test environments retain the legacy KV-marker path.
 */
export async function creditReferrerForPurchase(env, ref, licenseKey) {
  const licKey = normalizeKey(licenseKey || '');
  if (!ref?.code || !licKey) return { credited: false, reason: 'bad_input' };

  const marker = `refpaid:${licKey}`;
  if (env.DB) {
    const now = Date.now();
    // D1 batch is one transaction. State goes first and is guarded by the
    // absence of a claim: a new purchase creates pending+claim together; a
    // legacy claim cannot gain a replayable state; a new-style retry keeps its
    // existing pending row. Thus claim ⇔ state at creation, with no crash seam.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO referral_credit_state
           (license_key, ref_code, days, status, created_at, applied_at,
            materialized_at, target_kind, target_key, target_expiry)
         SELECT ?1, ?2,
                MIN(?3, ?5 - COALESCE((
                  SELECT SUM(days) FROM referral_credit_state
                  WHERE ref_code = ?2 AND status IN ('pending', 'applied')
                ), 0)),
                'pending', ?4, NULL, NULL, NULL, NULL, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM referral_credits WHERE license_key = ?1
         ) AND NOT EXISTS (
           SELECT 1 FROM license_revocations WHERE license_key = ?1
         ) AND COALESCE((
           SELECT SUM(days) FROM referral_credit_state
           WHERE ref_code = ?2 AND status IN ('pending', 'applied')
         ), 0) < ?5`
      ).bind(licKey, ref.code, paidDays(env), now, REFERRAL_REWARD_CAP_DAYS),
      env.DB.prepare(
        `INSERT OR IGNORE INTO referral_credits
           (license_key, ref_code, claimed_at)
         SELECT ?1, ?2, ?3
         WHERE EXISTS (
           SELECT 1 FROM referral_credit_state
           WHERE license_key = ?1 AND status = 'pending'
         ) AND NOT EXISTS (
           SELECT 1 FROM license_revocations WHERE license_key = ?1
         )`
      ).bind(licKey, ref.code, now)
    ]);

    let state = await env.DB.prepare(
      `SELECT license_key, ref_code, days, status, materialized_at,
              target_kind, target_key, target_expiry, target_generation
       FROM referral_credit_state WHERE license_key = ?1`
    ).bind(licKey).first();
    // A claim with no state predates this retryable journal. Treating it as
    // pending could replay a reward that the legacy code already applied.
    if (!state || (state.status === 'applied' && state.materialized_at != null)) {
      return { credited: false, reason: 'already' };
    }
    const sweep = await sweepPendingReferralCode(env, state.ref_code, ref);
    if (!sweep.locked) return { credited: false, reason: 'pending' };
    state = await getCreditState(env, licKey);
    if (state?.status === 'applied') return { credited: true, days: Number(state.days) || 0 };
    return { credited: false, reason: 'pending' };
  } else {
    // Compatibility for non-payment/manual environments. Paid issuance itself
    // now requires D1, so production referral payouts always use the atomic path.
    if (await env.LICENSES.get(marker)) return { credited: false, reason: 'already' };
  }
  const fresh = (await getJson(env, `ref:${ref.code}`)) || ref;
  const remaining = Math.max(0, REFERRAL_REWARD_CAP_DAYS - (Number(fresh.days_earned) || 0));
  const awardDays = Math.min(paidDays(env), remaining);
  if (awardDays <= 0) {
    await env.LICENSES.put(marker, ref.code);
    return { credited: false, reason: 'cap_reached' };
  }
  fresh.purchases = (fresh.purchases || 0) + 1;
  await creditReferrer(env, fresh, awardDays);
  await putJson(env, `ref:${fresh.code}`, fresh);
  // In the no-DB compatibility path too, a failed reward write must remain
  // retryable; claiming before the writes permanently lost the credit.
  await env.LICENSES.put(marker, ref.code);
  return { credited: true, days: awardDays };
}

/** True when gateway ack is safe because D1 owns this credit's retry state. */
export async function hasDurableCredit(env, licenseKey) {
  const key = normalizeKey(licenseKey || '');
  if (!env.DB || !key) return false;
  const row = await env.DB.prepare(
    'SELECT 1 AS durable FROM referral_credits WHERE license_key = ?1'
  ).bind(key).first();
  return !!row;
}

async function getCreditState(env, licenseKey) {
  return env.DB.prepare(
    `SELECT license_key, ref_code, days, status, created_at, applied_at, materialized_at,
            target_kind, target_key, target_expiry, target_generation
     FROM referral_credit_state WHERE license_key = ?1`
  ).bind(licenseKey).first();
}

async function acquireReferralLease(env, refCode) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const now = Date.now();
    const acquired = await env.DB.prepare(
      `INSERT INTO referral_apply_locks(ref_code, lease_until) VALUES(?1, ?2)
       ON CONFLICT(ref_code) DO UPDATE SET lease_until = excluded.lease_until
       WHERE referral_apply_locks.lease_until < ?3
       RETURNING lease_until`
    ).bind(refCode, now + 15_000, now).first();
    const leaseUntil = Number(acquired?.lease_until) || 0;
    if (leaseUntil) return leaseUntil;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return 0;
}

async function renewReferralLease(env, refCode, leaseUntil) {
  const now = Date.now();
  const renewed = await env.DB.prepare(
    `UPDATE referral_apply_locks SET lease_until = ?3
     WHERE ref_code = ?1 AND lease_until = ?2 AND lease_until >= ?4
     RETURNING lease_until`
  ).bind(refCode, leaseUntil, now + 15_000, now).first();
  const next = Number(renewed?.lease_until) || 0;
  if (!next) throw new Error('referral lease lost');
  return next;
}

async function withReferralLease(env, lockName, contentionMessage, operation) {
  let leaseUntil = await acquireReferralLease(env, lockName);
  if (!leaseUntil) throw new Error(contentionMessage);
  const renew = async () => {
    leaseUntil = await renewReferralLease(env, lockName, leaseUntil);
  };
  try {
    return await operation(renew);
  } finally {
    // Bind release to the latest lease generation so an expired holder can
    // never delete a takeover's row.
    await env.DB.prepare(
      'DELETE FROM referral_apply_locks WHERE ref_code = ?1 AND lease_until = ?2'
    ).bind(lockName, leaseUntil).run();
  }
}

async function unsettledCount(env, refCode) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM referral_credit_state
     WHERE ref_code = ?1 AND (
       status = 'pending' OR (status = 'applied' AND materialized_at IS NULL)
     )`
  ).bind(refCode).first();
  return Number(row?.count) || 0;
}

async function persistCreditIntent(env, state, kind, key, expiry) {
  const result = await env.DB.prepare(
    `UPDATE referral_credit_state
     SET target_kind = ?2, target_key = ?3, target_expiry = ?4
     WHERE license_key = ?1 AND status = 'pending' AND target_key IS NULL`
  ).bind(state.license_key, kind, key, expiry).run();
  if ((result?.meta?.changes || 0) < 1) {
    throw new Error('referral source changed before intent persistence');
  }
  state.target_kind = kind;
  state.target_key = key;
  state.target_expiry = expiry;
}

async function withTargetLease(env, targetKey, operation) {
  const lockName = `target:${targetKey}`;
  return withReferralLease(env, lockName, 'referral target contended', operation);
}

// Every expiry this journal has ever promised a target, from strongly
// consistent D1. A KV license read can lag a colo behind, so deriving a new
// intent from KV alone can silently re-base BELOW days an earlier credit
// already granted — the journal then says N days while the license carries
// fewer. toISOString output is fixed-width UTC, so MAX() compares
// chronologically. Pending intents count too: their write is absolute and
// will land, so the next credit must chain on top of them.
async function promisedTargetExpiry(env, targetKey) {
  const row = await env.DB.prepare(
    'SELECT MAX(target_expiry) AS expiry FROM referral_credit_state WHERE target_key = ?1'
  ).bind(targetKey).first();
  return row?.expiry || null;
}

async function referralTargetEligible(env, target, expectedKey) {
  const embeddedKey = normalizeKey(target?.key || '');
  if (!embeddedKey || embeddedKey !== normalizeKey(expectedKey || '')) return false;
  if (target?.status !== 'active' || target.type !== 'subscription' ||
      !Number.isFinite(Date.parse(target.expires_at || ''))) {
    return false;
  }
  const checked = await getRevocation(env, embeddedKey);
  if (!checked.ok) throw new Error('license revocation registry unavailable');
  return !checked.revocation;
}

async function clearCreditIntent(env, state) {
  const targetKey = state.target_key;
  if (!targetKey) return;
  const cleared = await env.DB.prepare(
    `UPDATE referral_credit_state
     SET target_kind = NULL, target_key = NULL, target_expiry = NULL,
         target_generation = target_generation + 1
     WHERE license_key = ?1 AND status = 'pending' AND target_key = ?2`
  ).bind(state.license_key, targetKey).run();
  if ((cleared?.meta?.changes || 0) === 0) {
    throw new Error('referral credit intent changed concurrently');
  }
  state.target_kind = null;
  state.target_key = null;
  state.target_expiry = null;
  state.target_generation = Math.max(0, Number(state.target_generation) || 0) + 1;
}

async function persistExistingTargetIntent(env, state, kind, targetKey) {
  return withTargetLease(env, targetKey, async (renew) => {
    // Re-read after acquiring the target lock. Another code may have extended
    // this same subscription while we waited, and KV before the lock is not a
    // safe base for an absolute journal promise.
    const target = await getLicense(env, targetKey);
    // KV may still say "active" after revokeLicense committed its authoritative
    // insert-only D1 row. Never reserve a paid referral reward against that
    // stale mirror: the entitlement would be marked spent but remain unusable.
    if (!(await referralTargetEligible(env, target, targetKey))) return false;
    const promised = await promisedTargetExpiry(env, target.key);
    await renew();
    const expiry = extendedExpiry(maxExpiry(target.expires_at, promised), Number(state.days) || 0);
    await persistCreditIntent(env, state, kind, target.key, expiry);
    return true;
  });
}

async function resolveCreditIntent(env, ref, state) {
  if (state.target_key) return state;

  if (ref.owner_license_key) {
    const persisted = await persistExistingTargetIntent(
      env, state, 'owner', ref.owner_license_key
    );
    if (persisted) return state;
  }

  if (ref.reward_key) {
    const persisted = await persistExistingTargetIntent(
      env, state, 'reward', ref.reward_key
    );
    if (persisted) return state;
  }

  const days = Number(state.days) || 0;
  const candidateExpiry = extendedExpiry(null, days);
  // issueLicense's payment_issuance claim makes this mint replay-safe: a crash
  // before intent persistence repeats `referral:<purchased key>` and recovers
  // the SAME reward key/expiry instead of minting another license. This is the
  // sole target mutation needed before target_key can exist; every later write
  // is preceded by the durable intent below and is absolute.
  const reward = await issueLicense(env, {
    gateway: 'referral',
    // Generation zero preserves the historical claim identity. If that target
    // is revoked before application, clearCreditIntent durably advances the
    // generation so every retry converges on a fresh payment claim instead of
    // recovering the same unusable key forever.
    payment_id: referralRewardPaymentId(state),
    type: 'subscription',
    expires_at: candidateExpiry,
    note: `referral reward · code ${ref.code}`,
    // Reserve the deterministic D1 claim only. The bearer license is not put
    // in KV until the source+target revocation checks atomically mark this
    // credit applied below.
    defer_materialization: true
  });
  await persistCreditIntent(env, state, 'reward', reward.key, reward.expires_at || candidateExpiry);
  return state;
}

async function applyCreditIntent(env, state) {
  return withTargetLease(env, state.target_key, async (renew) => {
    let target = await getLicense(env, state.target_key);
    if (!target && state.target_kind === 'reward' && state.status === 'applied') {
      target = await recoverPaymentLicense(
        env, 'referral', referralRewardPaymentId(state)
      );
      if (normalizeKey(target?.key || '') !== normalizeKey(state.target_key || '')) {
        // The frozen claim no longer names this target: nothing a retry can
        // fix. Tagged so the sweep parks this ONE row instead of aborting the
        // referrer's whole batch (transient failures still propagate).
        throw Object.assign(new Error('referral reward claim mismatch'),
          { code: 'referral_credit_unsettleable' });
      }
    }
    // A target can be revoked or corrupted after its intent was persisted but
    // before a retry applies it. Detach the still-pending intent so the next
    // pass can choose/mint a live subscription instead of losing the reward.
    if (!(await referralTargetEligible(env, target, state.target_key))) {
      // Only a PENDING intent may be detached. Once the row is 'applied' the
      // target is frozen (promisedTargetExpiry already counts it), and
      // clearCreditIntent's status='pending' guard would match zero rows and
      // throw — which used to abort the whole code's sweep and strand every
      // later credit for that referrer behind one dead target.
      if (state.status === 'pending') await clearCreditIntent(env, state);
      return false;
    }
    // Include EVERY promised expiry, not only this state's. A different code
    // can reserve a later absolute expiry between this state's persistence and
    // application; any writer holding the shared target lock materializes the
    // monotonic global maximum and therefore can never shorten another credit.
    const promised = await promisedTargetExpiry(env, state.target_key);
    await renew();
    const expiry = maxExpiry(target.expires_at, maxExpiry(state.target_expiry, promised));
    // getLicense overlays the D1 promise for authorization, so equality here
    // does NOT prove the KV materialization already landed. Always write the
    // absolute global maximum before marking this credit applied. This keeps
    // the D1 journal and its KV projection convergent after crashes, retries,
    // and a prior delayed writer.
    target.expires_at = expiry;
    await putLicense(env, target);
    // Detect an abnormally slow KV write that outlived its lease. Leaving the
    // state pending makes the bounded recovery sweep re-materialize the D1
    // maximum instead of acknowledging a potentially lapped write.
    await renew();
    return true;
  });
}

function referralRewardPaymentId(state) {
  const generation = Math.max(0, Number(state?.target_generation) || 0);
  return generation > 0
    ? `referral:${state.license_key}:g${generation}`
    : `referral:${state.license_key}`;
}

async function cancelRevokedSourceCredit(env, state) {
  const checked = await getRevocation(env, state.license_key);
  if (!checked.ok) throw new Error('license revocation registry unavailable');
  if (!checked.revocation) return false;
  await env.DB.prepare(
    `UPDATE referral_credit_state
     SET status = 'cancelled', materialized_at = ?2, target_kind = NULL,
         target_key = NULL, target_expiry = NULL, retry_after = 0,
         last_error_at = NULL
     WHERE license_key = ?1 AND status = 'pending'`
  ).bind(state.license_key, Date.now()).run();
  state.status = 'cancelled';
  state.materialized_at = Date.now();
  state.target_kind = null;
  state.target_key = null;
  state.target_expiry = null;
  return true;
}

async function applyPendingCredit(env, ref, state) {
  // Retarget immediately when a stale/revoked pointer is discovered. Three
  // attempts cover owner → stored reward → newly minted reward; repeated
  // concurrent revocations remain safely pending for the bounded recovery job.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await cancelRevokedSourceCredit(env, state)) return false;
    await resolveCreditIntent(env, ref, state);
    // This conditional update is the D1 linearization point for BOTH the
    // purchased/source key and the reward target. No external KV entitlement
    // write occurs until this transaction says the reward was earned.
    const marked = await env.DB.prepare(
      `UPDATE referral_credit_state SET status = 'applied', applied_at = ?2
       WHERE license_key = ?1 AND status = 'pending' AND target_key = ?3
         AND NOT EXISTS (
           SELECT 1 FROM license_revocations WHERE license_key = ?3
         ) AND NOT EXISTS (
           SELECT 1 FROM license_revocations WHERE license_key = ?1
         )`
    ).bind(state.license_key, Date.now(), state.target_key).run();
    if ((marked?.meta?.changes || 0) > 0) {
      state.status = 'applied';
      // The reward is now durably earned against a frozen target. If that
      // target became unusable inside the window between this linearization and
      // the KV write, report the row as unsettled rather than throwing: the
      // caller records it for the bounded recovery sweep and the health
      // worklist, and — crucially — keeps processing this code's other credits.
      return await applyCreditIntent(env, state);
    }
    if (await cancelRevokedSourceCredit(env, state)) return false;
    await clearCreditIntent(env, state);
  }
  return false;
}

function maxExpiry(existingIso, targetIso) {
  const existing = Date.parse(existingIso || '');
  const target = Date.parse(targetIso || '');
  if (!Number.isFinite(target)) return existingIso;
  if (Number.isFinite(existing) && existing >= target) return existingIso;
  return new Date(target).toISOString();
}

// Reattach a minted-but-detached reward pointer from the D1 intent journal.
// Repairs the narrow crash-after-applied/before-ref-put seam AND any stale KV
// read that predates the mint: a later writer reuses the already-minted
// destination instead of leaving it undiscoverable (or minting a second one).
async function reattachRewardIntent(env, ref) {
  if (ref.reward_key) return;
  const rewardIntent = await env.DB.prepare(
    `SELECT target_key FROM referral_credit_state
     WHERE ref_code = ?1 AND target_kind = 'reward' AND target_key IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`
  ).bind(ref.code).first();
  if (rewardIntent?.target_key) ref.reward_key = rewardIntent.target_key;
}

// Baseline and derived counters share one KV object/put: absent baseline
// means counters are still pure legacy, so capture them exactly once; once
// present, every replay recomputes baseline + D1 and can never double-count.
async function applyJournalTotals(env, ref) {
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS purchases, COALESCE(SUM(days), 0) AS days_earned
     FROM referral_credit_state WHERE ref_code = ?1 AND status = 'applied'`
  ).bind(ref.code).first();
  if (!Number.isFinite(ref.legacy_purchases)) {
    ref.legacy_purchases = Number(ref.purchases) || 0;
  }
  if (!Number.isFinite(ref.legacy_days_earned)) {
    ref.legacy_days_earned = Number(ref.days_earned) || 0;
  }
  ref.purchases = ref.legacy_purchases + (Number(totals?.purchases) || 0);
  ref.days_earned = ref.legacy_days_earned + (Number(totals?.days_earned) || 0);
}

/**
 * Reverse the reward earned by a purchase that was later refunded/revoked.
 * The cancellation and all later absolute promises are rewritten atomically
 * in D1; the cancelled row keeps the exact reduced target expiry until the KV
 * projection is confirmed, so a crash can retry without subtracting twice.
 */
export async function reverseReferralCreditForPurchase(env, licenseKey) {
  const sourceKey = normalizeKey(licenseKey || '');
  if (!env.DB || !sourceKey) return { reversed: false, reason: 'bad_input' };
  let state = await getCreditState(env, sourceKey);
  if (!state) return { reversed: false, reason: 'none' };
  if (state.status === 'pending') {
    await env.DB.prepare(
      `UPDATE referral_credit_state
       SET status = 'cancelled', materialized_at = ?2, target_kind = NULL,
           target_key = NULL, target_expiry = NULL, retry_after = 0,
           last_error_at = NULL
       WHERE license_key = ?1 AND status = 'pending'`
    ).bind(sourceKey, Date.now()).run();
    return { reversed: true, days: 0 };
  }
  if (state.status === 'cancelled' && state.materialized_at != null) {
    return { reversed: false, reason: 'already' };
  }
  // A cancelled row with no target pointer was cancelled while still pending —
  // either by the branch above or by revokeLicenseDurable, which cancels
  // pending rows in the same D1 batch as the revocation and then has every
  // caller reverse the referral for that purchase. Nothing was ever
  // linearized: no expiry was granted and no counters moved, so the correct
  // answer is the one the pending branch returns, not a throw that would 500
  // /admin/revoke and stall the refund cron on every sweep.
  if (state.status === 'cancelled' && state.target_kind == null && state.target_key == null &&
      state.target_expiry == null && state.applied_at == null) {
    const marked = await env.DB.prepare(
      `UPDATE referral_credit_state
       SET materialized_at = ?2, retry_attempts = 0, retry_after = 0,
           last_error_at = NULL
       WHERE license_key = ?1 AND status = 'cancelled'
         AND applied_at IS NULL AND materialized_at IS NULL
         AND target_kind IS NULL AND target_key IS NULL AND target_expiry IS NULL`
    ).bind(sourceKey, Date.now()).run();
    if ((marked?.meta?.changes || 0) > 0) return { reversed: true, days: 0 };
    const latest = await getCreditState(env, sourceKey);
    if (latest?.status === 'cancelled' && latest.materialized_at != null) {
      return { reversed: false, reason: 'already' };
    }
    throw new Error('referral reversal changed concurrently');
  }
  if ((state.status !== 'applied' && state.status !== 'cancelled') || !state.target_key) {
    throw new Error('referral reversal state is invalid');
  }

  const targetKey = state.target_key;
  const refCode = state.ref_code;
  let reversedDays = Number(state.days) || 0;
  await withTargetLease(env, targetKey, async (renew) => {
    state = await getCreditState(env, sourceKey);
    let desiredExpiry = state.target_kind === 'reversal' ? state.target_expiry : null;
    if (state.status === 'applied') {
      const rows = (await env.DB.prepare(
        `SELECT license_key, days, created_at, target_expiry
         FROM referral_credit_state
         WHERE target_key = ?1 AND status = 'applied'
         ORDER BY created_at, license_key`
      ).bind(targetKey).all())?.results || [];
      const index = rows.findIndex((row) => row.license_key === sourceKey);
      if (index < 0) throw new Error('referral reversal source disappeared');
      const deltaMs = reversedDays * DAY_MS;
      const finalMs = Math.max(...rows.map((row) => Date.parse(row.target_expiry || '')));
      if (!Number.isFinite(finalMs) || deltaMs <= 0) {
        throw new Error('referral reversal expiry is invalid');
      }
      desiredExpiry = new Date(finalMs - deltaMs).toISOString();
      const statements = [];
      for (let i = index + 1; i < rows.length; i++) {
        const expiryMs = Date.parse(rows[i].target_expiry || '');
        if (!Number.isFinite(expiryMs)) throw new Error('referral promise is invalid');
        statements.push(env.DB.prepare(
          `UPDATE referral_credit_state SET target_expiry = ?2
           WHERE license_key = ?1 AND status = 'applied'`
        ).bind(rows[i].license_key, new Date(expiryMs - deltaMs).toISOString()));
      }
      statements.push(env.DB.prepare(
        `UPDATE referral_credit_state
         SET status = 'cancelled', target_kind = 'reversal', target_expiry = ?2,
             materialized_at = NULL, retry_after = 0, last_error_at = NULL
         WHERE license_key = ?1 AND status = 'applied' AND target_key = ?3`
      ).bind(sourceKey, desiredExpiry, targetKey));
      await env.DB.batch(statements);
      state.status = 'cancelled';
      state.target_kind = 'reversal';
      state.target_expiry = desiredExpiry;
    }
    if (state.status !== 'cancelled' || state.target_kind !== 'reversal' ||
        !Number.isFinite(Date.parse(desiredExpiry || ''))) {
      throw new Error('referral reversal retry state is invalid');
    }

    await renew();
    const target = await getLicense(env, targetKey);
    if (target?.status === 'active' && target.type === 'subscription') {
      target.expires_at = desiredExpiry;
      await putLicense(env, target);
    }
  });

  // Rebuild the public counters after releasing the target lock. Normal
  // payouts acquire code→target; taking them in the opposite nested order
  // would deadlock under load.
  await withReferralLease(env, refCode, 'referral projection contended', async (renew) => {
    const ref = await getJson(env, `ref:${refCode}`);
    if (!ref) throw new Error('referral record unavailable');
    await renew();
    await applyJournalTotals(env, ref);
    await putJson(env, `ref:${refCode}`, ref);
    await markMaterialized(env, `ref:${refCode}`);
  });
  // `materialized_at` covers BOTH absolute KV projections. Marking it after
  // only the target expiry would strand stale public counters if their later
  // KV write failed; leaving NULL makes the cron repeat both writes safely.
  const marked = await env.DB.prepare(
    `UPDATE referral_credit_state
     SET materialized_at = ?2, retry_attempts = 0, retry_after = 0,
         last_error_at = NULL
     WHERE license_key = ?1 AND status = 'cancelled'
       AND target_kind = 'reversal' AND target_expiry = ?3
       AND materialized_at IS NULL`
  ).bind(sourceKey, Date.now(), state.target_expiry).run();
  if ((marked?.meta?.changes || 0) < 1) {
    const latest = await getCreditState(env, sourceKey);
    if (!(latest?.status === 'cancelled' && latest.materialized_at != null)) {
      throw new Error('referral reversal changed concurrently');
    }
  }
  return { reversed: true, days: reversedDays };
}

async function sweepPendingReferralCode(env, refCode, fallbackRef = null) {
  let leaseUntil = await acquireReferralLease(env, refCode);
  if (!leaseUntil) return { locked: false, applied: 0, stillPending: await unsettledCount(env, refCode) };

  let applied = 0;
  try {
    const rows = await env.DB.prepare(
      `SELECT license_key, ref_code, days, status, created_at, applied_at, materialized_at,
              target_kind, target_key, target_expiry, target_generation
       FROM referral_credit_state
       WHERE ref_code = ?1 AND (
         status = 'pending' OR (status = 'applied' AND materialized_at IS NULL)
       )
       ORDER BY created_at, license_key
       LIMIT ?2`
    ).bind(refCode, REFERRAL_CREDIT_BATCH_LIMIT).all();
    const pending = rows?.results || [];
    const ref = (await getJson(env, `ref:${refCode}`)) ||
      (fallbackRef?.code === refCode ? fallbackRef : null);
    if (!ref) throw new Error('referral record unavailable');
    await reattachRewardIntent(env, ref);

    // One row whose target died must not strand the referrer's other credits.
    // Settle every row this pass can settle, remember the ones it cannot, and
    // raise the failure only after the record and the journal are consistent.
    const settled = [];
    const stalled = [];
    for (const state of pending) {
      // A sweep may contain many stranded rows. Renew around the awaited KV/D1
      // work so the 15s lease cannot expire and admit a concurrent KV writer;
      // losing ownership aborts safely because target writes are absolute.
      leaseUntil = await renewReferralLease(env, refCode, leaseUntil);
      const wasAlreadyApplied = state.status === 'applied';
      try {
        if (wasAlreadyApplied) {
          if (!(await applyCreditIntent(env, state))) {
            stalled.push(state.license_key);
            continue;
          }
        } else if (!(await applyPendingCredit(env, ref, state))) {
          // Source revocation is a terminal cancellation, not a transient target
          // failure that should back off and retry forever.
          if (state.status === 'cancelled') continue;
          stalled.push(state.license_key);
          continue;
        }
        leaseUntil = await renewReferralLease(env, refCode, leaseUntil);
      } catch (error) {
        // Only a row that no retry can fix is parked. Everything else —
        // a failed KV write, a lost lease, a D1 outage — is transient and must
        // still reach the caller, which decides whether the gateway may be
        // acked (see settleIssuedRobokassaPayment / hasDurableCredit).
        if (error?.code !== 'referral_credit_unsettleable') throw error;
        // The license key is a bearer credential and never enters logs; the
        // health worklist and referral_credit_state carry the identity.
        console.warn('referral credit is unsettleable; parked for operator review');
        stalled.push(state.license_key);
        continue;
      }
      try { await env.LICENSES.put(`refpaid:${state.license_key}`, refCode); }
      catch (e) {
        // Operator mirror only; D1 already says applied. Do not strand counter
        // and reward-pointer materialization behind a non-authoritative KV key.
        console.warn('referral paid marker unavailable', e?.name || 'error');
      }
      // Missing/revoked reward pointers resolve to a new idempotent target;
      // keep the ref record aimed at the target this sweep actually credited.
      if (state.target_kind === 'reward' && ref.reward_key !== state.target_key) {
        ref.reward_key = state.target_key;
      }
      settled.push(state.license_key);
      if (!wasAlreadyApplied) applied += 1;
    }

    leaseUntil = await renewReferralLease(env, refCode, leaseUntil);
    // The no-DB compatibility path still increments raw counters and is only
    // for manual/tests; it must not interleave with production's journal path.
    await applyJournalTotals(env, ref);
    await putJson(env, `ref:${refCode}`, ref);
    // The record now provably exists with credited state: set the write-once
    // flag so no claim-recovery may ever rewrite the initial zeroed record.
    await markMaterialized(env, `ref:${refCode}`);
    // `applied` means the entitlement landed; materialized_at separately says
    // the user-visible ref:* record was rebuilt from D1. A crash between these
    // writes leaves NULL and deliberately schedules harmless re-materialization.
    // Scope this to the rows THIS pass actually settled: a code-wide update
    // would also clear the retry state of a stalled row and hide it from the
    // health worklist.
    if (settled.length) {
      const now = Date.now();
      await env.DB.batch(settled.map((licenseKey) => env.DB.prepare(
        `UPDATE referral_credit_state
         SET materialized_at = ?2, retry_attempts = 0, retry_after = 0,
             last_error_at = NULL
         WHERE license_key = ?1 AND status = 'applied' AND materialized_at IS NULL`
      ).bind(licenseKey, now)));
    }
    // Back off the stuck rows individually instead of raising for the whole
    // code. A permanently dead target would otherwise make every later purchase
    // on this code look like a failure to its caller, and the code-wide backoff
    // in retryPendingReferralCredits would punish rows that settled fine.
    if (stalled.length) await deferReferralCredits(env, stalled);
    return {
      locked: true, applied, stalled: stalled.length,
      stillPending: await unsettledCount(env, refCode)
    };
  } finally {
    // Bind release to this lease so an expired holder cannot delete a takeover.
    await env.DB.prepare(
      'DELETE FROM referral_apply_locks WHERE ref_code = ?1 AND lease_until = ?2'
    ).bind(refCode, leaseUntil).run();
  }
}

// Row-scoped backoff for credits a sweep could not settle (their target was
// revoked or corrupted). Mirrors deferReferralCodeRetry's schedule, but leaves
// the rows that DID settle in this pass untouched.
async function deferReferralCredits(env, licenseKeys) {
  if (!licenseKeys.length) return;
  const now = Date.now();
  const statements = [];
  for (const licenseKey of licenseKeys) {
    const row = await env.DB.prepare(
      'SELECT retry_attempts FROM referral_credit_state WHERE license_key = ?1'
    ).bind(licenseKey).first();
    const attempts = Math.min(30, Math.max(0, Number(row?.retry_attempts) || 0) + 1);
    const delay = Math.min(60_000 * 2 ** Math.min(12, attempts - 1), REFERRAL_RETRY_MAX_DELAY_MS);
    statements.push(env.DB.prepare(
      `UPDATE referral_credit_state
       SET retry_attempts = ?2, retry_after = ?3, last_error_at = ?4
       WHERE license_key = ?1 AND (
         status = 'pending' OR (status = 'applied' AND materialized_at IS NULL) OR
         (status = 'cancelled' AND target_kind = 'reversal' AND materialized_at IS NULL)
       )`
    ).bind(licenseKey, attempts, now + delay, now));
  }
  await env.DB.batch(statements);
}

async function deferReferralCodeRetry(env, refCode) {
  const current = await env.DB.prepare(
    `SELECT MAX(retry_attempts) AS attempts FROM referral_credit_state
     WHERE ref_code = ?1 AND (
       status = 'pending' OR (status = 'applied' AND materialized_at IS NULL)
     )`
  ).bind(refCode).first();
  const attempts = Math.min(30, Math.max(0, Number(current?.attempts) || 0) + 1);
  const delay = Math.min(60_000 * 2 ** Math.min(12, attempts - 1),
    REFERRAL_RETRY_MAX_DELAY_MS);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE referral_credit_state
     SET retry_attempts = ?2, retry_after = ?3, last_error_at = ?4
     WHERE ref_code = ?1 AND (
       status = 'pending' OR (status = 'applied' AND materialized_at IS NULL)
     )`
  ).bind(refCode, attempts, now + delay, now).run();
}

/** Bounded recovery for payouts and refund reversals that have not reached KV. */
export async function retryPendingReferralCredits(env, limit = 50) {
  if (!env.DB) return { codes: 0, applied: 0, still_pending: 0 };
  const bounded = Math.max(1, Math.min(50, Math.floor(Number(limit) || 50)));
  const reversalRows = (await env.DB.prepare(
    `SELECT license_key FROM referral_credit_state
     WHERE status = 'cancelled' AND target_kind = 'reversal'
       AND materialized_at IS NULL AND retry_after <= ?1
     ORDER BY retry_after, created_at, license_key
     LIMIT ?2`
  ).bind(Date.now(), bounded).all())?.results || [];
  let reversalPending = 0;
  for (const row of reversalRows) {
    try {
      await reverseReferralCreditForPurchase(env, row.license_key);
    } catch (e) {
      console.warn('referral reversal retry failed', e?.name || 'error');
      reversalPending += 1;
      try { await deferReferralCredits(env, [row.license_key]); }
      catch (deferError) {
        console.warn('referral reversal retry backoff failed', deferError?.name || 'error');
      }
    }
  }
  const remaining = bounded - reversalRows.length;
  if (remaining <= 0) {
    return {
      codes: 0, applied: 0,
      still_pending: reversalPending, stalled: 0
    };
  }
  const rows = await env.DB.prepare(
    `SELECT ref_code FROM referral_credit_state
     WHERE (
       status = 'pending' OR (status = 'applied' AND materialized_at IS NULL)
     ) AND retry_after <= ?1
     GROUP BY ref_code
     ORDER BY MIN(retry_after), MIN(created_at)
     LIMIT ?2`
  ).bind(Date.now(), remaining).all();
  let applied = 0;
  let stillPending = 0;
  let stalled = 0;
  const codes = rows?.results || [];
  for (const row of codes) {
    try {
      const result = await sweepPendingReferralCode(env, row.ref_code);
      applied += result.applied;
      stillPending += result.stillPending;
      stalled += result.stalled || 0;
    } catch (e) {
      console.warn('pending referral retry failed', e?.name || 'error');
      try { await deferReferralCodeRetry(env, row.ref_code); }
      catch (deferError) {
        console.warn('pending referral retry backoff failed', deferError?.name || 'error');
      }
      stillPending += await unsettledCount(env, row.ref_code);
    }
  }
  return {
    codes: codes.length, applied,
    still_pending: stillPending + reversalPending, stalled
  };
}

/* --------------------------- crediting days --------------------------- */

/** expires_at = max(now, current expiry) + days — never shortens, gaps don't burn days. */
function extendedExpiry(currentIso, days) {
  const current = currentIso ? Date.parse(currentIso) : NaN;
  const base = Math.max(Date.now(), Number.isFinite(current) ? current : 0);
  return new Date(base + days * DAY_MS).toISOString();
}

/**
 * Land `days` on the referrer. Mutates `ref` (counters, reward_key) — the
 * caller persists the record. Preference order:
 *   1. the referrer's own registered key, IF it is an active subscription
 *      (extending a lifetime key is meaningless, a revoked one forbidden);
 *   2. the code's dedicated reward license, minted/replaced as needed.
 */
async function creditReferrer(env, ref, days) {
  if (!days) return;

  if (ref.owner_license_key) {
    const own = await getLicense(env, ref.owner_license_key);
    if (own && own.status === 'active' && own.type === 'subscription' && own.expires_at) {
      own.expires_at = extendedExpiry(own.expires_at, days);
      await putLicense(env, own);
      ref.days_earned += days;
      return;
    }
  }

  if (ref.reward_key) {
    const reward = await getLicense(env, ref.reward_key);
    if (reward && reward.status === 'active') {
      reward.expires_at = extendedExpiry(reward.expires_at, days);
      await putLicense(env, reward);
      ref.days_earned += days;
      return;
    }
    // Missing or revoked reward key: fall through and mint a fresh one.
  }

  const reward = await issueLicense(env, {
    gateway: 'referral',
    type: 'subscription',
    expires_at: new Date(Date.now() + days * DAY_MS).toISOString(),
    note: `referral reward · code ${ref.code}`
  });
  ref.reward_key = reward.key;
  ref.days_earned += days;
}

/* ------------------------------- status ------------------------------- */

/** Everything the Settings referral card shows, looked up by device. */
export async function referralStatus(env, deviceId, referralAuth) {
  const device = cleanDeviceId(deviceId);
  if (!device) return { ok: false, reason: 'bad_device' };
  const auth = cleanReferralAuth(referralAuth);
  if (!auth) return { ok: false, reason: 'bad_auth' };
  const authHash = await referralAuthHash(auth);

  const out = {
    ok: true,
    code: null,
    purchases: 0,
    days_earned: 0,
    reward_key: null,
    reward_expires_at: null,
    paid_days: paidDays(env),
    reward_cap_days: REFERRAL_REWARD_CAP_DAYS,
    buyer_bonus_pct: buyerBonusPct(env)
  };

  let code = await env.LICENSES.get(`refauth:${authHash}`);
  if (!code) {
    // Migration/backfill only. A modern refowner pointer for a different
    // capability is ignored because the device id is not authorization.
    const legacyCode = await env.LICENSES.get(`refowner:${device}`);
    const legacy = legacyCode ? await getJson(env, `ref:${legacyCode}`) : null;
    if (legacy && !legacy.auth_hash) return { ok: false, reason: 'legacy_auth_required' };
    if (legacy && await referralAuthMatches(legacy, auth)) {
      code = legacy.code;
      await env.LICENSES.put(`refauth:${authHash}`, code);
    }
  }
  if (code) {
    const ref = await getJson(env, `ref:${code}`);
    if (ref) {
      if (!ref.auth_hash) return { ok: false, reason: 'legacy_auth_required' };
      if (!(await referralAuthMatches(ref, auth))) return { ok: false, reason: 'unauthorized' };
      out.code = ref.code;
      out.purchases = ref.purchases;
      out.days_earned = ref.days_earned;
      if (ref.reward_key) {
        const reward = await getLicense(env, ref.reward_key);
        if (reward && reward.status === 'active') {
          out.reward_key = reward.key;
          out.reward_expires_at = reward.expires_at;
        }
      }
    }
  }
  return out;
}

/**
 * Validate a code without side effects — for the checkout page to confirm
 * "this code is real, you'll get +N%" before charging. Deliberately reveals
 * nothing about the referrer.
 */
export async function checkCode(env, rawCode) {
  const code = normalizeRefCode(rawCode || '');
  if (!code) return { ok: true, valid: false, reason: 'bad_code', buyer_bonus_pct: buyerBonusPct(env) };
  const ref = await getJson(env, `ref:${code}`);
  return { ok: true, valid: !!ref, code, buyer_bonus_pct: buyerBonusPct(env) };
}

/** Admin inspection: full record by code or device id. */
export async function adminReferralLookup(env, { code: rawCode, device_id }) {
  const device = cleanDeviceId(device_id || '');
  let code = normalizeRefCode(rawCode || '');
  if (!code && device) code = (await env.LICENSES.get(`refowner:${device}`)) || '';
  const ref = code ? await getJson(env, `ref:${code}`) : null;
  const reward = ref?.reward_key ? await getLicense(env, ref.reward_key) : null;
  return { ref, reward };
}

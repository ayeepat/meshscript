/**
 * Referral program: enter a friend's code at checkout, both sides win.
 *
 * There is exactly ONE reward path, and it is gated on a real payment:
 *   - A buyer types a REF code into the pay page. The site threads it to
 *     Robokassa as a SIGNED custom param (Shp_ref_code), which Robokassa
 *     echoes back to our ResultURL webhook. (It may also live in the
 *     pre-registered order:<InvId> KV record.)
 *   - On confirmed payment: the REFERRER earns REFERRAL_PAID_DAYS (7) of
 *     subscription, and the BUYER's own new subscription is extended by
 *     REFERRAL_BUYER_BONUS_PCT (10%) — a 30-day plan becomes 33 days.
 *
 * Because the only reward requires money to change hands, there is NO
 * client-side "claim/activate" tracking, no device fingerprinting, and no
 * abuse cap — every payout corresponds to real revenue. Self-referral is
 * blocked only best-effort: a static checkout doesn't know the buyer's
 * device_id, and paying yourself to self-refer is not a viable exploit.
 *
 * The anonymous device_id is used ONLY so a device can own/reuse one stable
 * invite code; it is not an identity or an anti-abuse signal.
 *
 * KV layout (shared LICENSES namespace):
 *   ref:<CODE>            — the referrer's record (stats + where days land)
 *   refowner:<device_id>  — device → its own code (idempotent code creation)
 *   refpaid:<license_key> — legacy mirror of the authoritative D1 claim
 *   refip:<ip>:<date>     — daily per-IP counter for /referral/code
 *
 * KV is eventually consistent with no transactions. D1 referral_credits is
 * therefore the authority for one payout per purchased license; the KV marker
 * remains only for compatibility and operator visibility.
 */

import { getLicense, putLicense, issueLicense, normalizeKey } from './licenses.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Same confusable-free alphabet as license keys.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomChars(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

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

// Device ids are crypto.randomUUID() on well-behaved clients; accept a loose
// superset but bound the length so KV keys stay sane.
export function cleanDeviceId(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9-]{8,64}$/.test(s) ? s : '';
}

/* ------------------------------ env knobs ----------------------------- */

const envInt = (env, name, dflt) => {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
export const paidDays = (env) => envInt(env, 'REFERRAL_PAID_DAYS', 7);
export const buyerBonusPct = (env) => envInt(env, 'REFERRAL_BUYER_BONUS_PCT', 10);
export const ipDailyLimit = (env) => envInt(env, 'REFERRAL_IP_DAILY_LIMIT', 30);

/* ----------------------------- KV helpers ----------------------------- */

async function getJson(env, key) {
  const raw = await env.LICENSES.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const putJson = (env, key, value, opts) =>
  env.LICENSES.put(key, JSON.stringify(value), opts);

/**
 * Daily per-IP counter for the invite-code endpoint. Approximate (KV
 * read-modify-write races undercount), which is fine — it only has to stop
 * dumb bulk minting; the reward itself is payment-gated. Returns true when
 * the request is allowed.
 */
export async function bumpIpBudget(env, ip) {
  const limit = ipDailyLimit(env);
  if (!limit || !ip) return true; // 0 disables the limiter
  const key = `refip:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(await env.LICENSES.get(key)) || 0;
  if (used >= limit) return false;
  await env.LICENSES.put(key, String(used + 1), { expirationTtl: 2 * 24 * 60 * 60 });
  return true;
}

/* ------------------------- referrer: get a code ----------------------- */

/**
 * Create (or return the existing) referral code for a device. Idempotent per
 * device via refowner:<device_id>. `licenseKey` (optional) is the referrer's
 * own license — remembered so rewards can extend an active subscription of
 * theirs directly instead of minting a separate reward key.
 */
export async function getOrCreateCode(env, deviceId, licenseKey) {
  const device = cleanDeviceId(deviceId);
  if (!device) return { ok: false, reason: 'bad_device' };
  const ownKey = normalizeKey(licenseKey || '') || null;

  const existingCode = await env.LICENSES.get(`refowner:${device}`);
  if (existingCode) {
    const ref = await getJson(env, `ref:${existingCode}`);
    if (ref) {
      // Keep the owner's license pointer fresh (they may have bought a sub
      // after generating the code).
      if (ownKey && ref.owner_license_key !== ownKey) {
        ref.owner_license_key = ownKey;
        await putJson(env, `ref:${ref.code}`, ref);
      }
      return { ok: true, code: ref.code };
    }
    // Dangling pointer (should not happen) — fall through and recreate.
  }

  let code, attempts = 0;
  do {
    code = newCode();
    if (!(await env.LICENSES.get(`ref:${code}`))) break;
    if (++attempts > 5) throw new Error('ref codegen collisions exhausted');
  } while (true);

  const ref = {
    code,
    owner_device_id: device,
    owner_license_key: ownKey,
    created_at: new Date().toISOString(),
    purchases: 0,      // paying friends who used this code at checkout
    days_earned: 0,    // total subscription days credited to the referrer
    reward_key: null   // dedicated reward license, minted on first credit
  };
  await putJson(env, `ref:${code}`, ref);
  await env.LICENSES.put(`refowner:${device}`, code);
  return { ok: true, code };
}

/* --------------------- checkout: resolve + validate ------------------- */

/**
 * Validate a code the buyer entered at checkout. Pure (no writes): the webhook
 * uses `.valid` to decide the buyer bonus, then credits the referrer.
 *   { valid: true, ref }              — apply the reward
 *   { valid: false, reason }          — ignore silently, issue a plain license
 * `buyerDeviceId` is optional and usually absent (static checkout); when
 * present it blocks obvious self-referral.
 */
export async function resolveReferral(env, { code: rawCode, buyerDeviceId } = {}) {
  const code = normalizeRefCode(rawCode || '');
  if (!code) return { valid: false, reason: 'bad_code' };
  const ref = await getJson(env, `ref:${code}`);
  if (!ref) return { valid: false, reason: 'not_found' };
  const buyer = cleanDeviceId(buyerDeviceId || '');
  if (buyer && ref.owner_device_id === buyer) return { valid: false, reason: 'self_referral' };
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
  return new Date(exp + bonusMs).toISOString();
}

/**
 * Credit the referrer for a confirmed purchase. Idempotent per purchased
 * license via refpaid:<key> (safe against Robokassa webhook retries). Re-reads
 * the ref record so a concurrent update isn't clobbered by a stale copy.
 * `ref` is the record returned by resolveReferral (used for its code).
 */
export async function creditReferrerForPurchase(env, ref, licenseKey) {
  const licKey = normalizeKey(licenseKey || '');
  if (!ref?.code || !licKey) return { credited: false, reason: 'bad_input' };

  const marker = `refpaid:${licKey}`;
  if (env.DB) {
    const claim = await env.DB.prepare(
      `INSERT OR IGNORE INTO referral_credits
         (license_key, ref_code, claimed_at)
       VALUES (?1, ?2, ?3)`
    ).bind(licKey, ref.code, Date.now()).run();
    if ((claim?.meta?.changes || 0) === 0) return { credited: false, reason: 'already' };
  } else {
    // Compatibility for non-payment/manual environments. Paid issuance itself
    // now requires D1, so production referral payouts always use the atomic path.
    if (await env.LICENSES.get(marker)) return { credited: false, reason: 'already' };
  }
  // Mirror the claim before crediting. As before, failure prefers one missed
  // free reward over a duplicate; D1 closes the simultaneous-delivery race.
  await env.LICENSES.put(marker, ref.code);

  const fresh = (await getJson(env, `ref:${ref.code}`)) || ref;
  fresh.purchases = (fresh.purchases || 0) + 1;
  await creditReferrer(env, fresh, paidDays(env));
  await putJson(env, `ref:${fresh.code}`, fresh);
  return { credited: true, days: paidDays(env) };
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
export async function referralStatus(env, deviceId) {
  const device = cleanDeviceId(deviceId);
  if (!device) return { ok: false, reason: 'bad_device' };

  const out = {
    ok: true,
    code: null,
    purchases: 0,
    days_earned: 0,
    reward_key: null,
    reward_expires_at: null,
    paid_days: paidDays(env),
    buyer_bonus_pct: buyerBonusPct(env)
  };

  const code = await env.LICENSES.get(`refowner:${device}`);
  if (code) {
    const ref = await getJson(env, `ref:${code}`);
    if (ref) {
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

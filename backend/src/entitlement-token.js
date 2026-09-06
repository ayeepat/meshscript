/**
 * Short-lived capability for the paid AI proxy.
 *
 * The license key and activation token stop at the license Worker. The VPS
 * receives only this signed, purpose-bound token and a pseudonymous license
 * reference. A short lifetime bounds the delay between a revocation and the
 * VPS refusing new work without making the VPS a second license database.
 */

import { cleanPublicDeviceId } from './referrals.js';

const TOKEN_PREFIX = 'et1';
const TOKEN_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const MAX_TOKEN_CHARS = 2048;
const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

async function hmacKey(secret, usage) {
  const text = String(secret || '');
  if (text.length < 32) return null;
  return crypto.subtle.importKey(
    'raw', encoder.encode(text), { name: 'HMAC', hash: 'SHA-256' }, false, usage
  );
}

async function licenseReference(rawKey) {
  const bytes = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', encoder.encode(String(rawKey || ''))
  ));
  return `h:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function issueEntitlementToken(env, {
  licenseKey, deviceId: rawDeviceId, licenseType = null, licenseExpiresAt = null
}, now = Date.now()) {
  const deviceId = cleanPublicDeviceId(rawDeviceId);
  const issuedAt = Math.trunc(Number(now));
  const key = await hmacKey(env?.ENTITLEMENT_SECRET, ['sign']);
  if (!key || !licenseKey || !deviceId || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    return null;
  }
  const normalizedLicenseExpiry = typeof licenseExpiresAt === 'string'
    ? licenseExpiresAt.slice(0, 64)
    : null;
  const parsedLicenseExpiry = normalizedLicenseExpiry ? Date.parse(normalizedLicenseExpiry) : NaN;
  const expiresAt = Number.isFinite(parsedLicenseExpiry)
    ? Math.min(issuedAt + TOKEN_TTL_MS, Math.trunc(parsedLicenseExpiry))
    : issuedAt + TOKEN_TTL_MS;
  if (expiresAt <= issuedAt) return null;
  const payloadBytes = encoder.encode(JSON.stringify({
    v: 1,
    p: 'ai',
    l: await licenseReference(licenseKey),
    d: deviceId,
    t: typeof licenseType === 'string' ? licenseType.slice(0, 32) : null,
    le: normalizedLicenseExpiry,
    iat: issuedAt,
    exp: expiresAt
  }));
  const payload = bytesToBase64Url(payloadBytes);
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, encoder.encode(`${TOKEN_PREFIX}.${payload}`)
  ));
  return {
    token: `${TOKEN_PREFIX}.${payload}.${bytesToBase64Url(signature)}`,
    expires_at: expiresAt
  };
}

export async function verifyEntitlementToken(env, rawToken, now = Date.now()) {
  const token = typeof rawToken === 'string' ? rawToken : '';
  if (!token || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: 'missing_token' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: 'bad_token' };
  const payloadBytes = base64UrlToBytes(parts[1]);
  const signature = base64UrlToBytes(parts[2]);
  const key = await hmacKey(env?.ENTITLEMENT_SECRET, ['verify']);
  if (!payloadBytes || !signature || !key) return { ok: false, reason: 'bad_token' };
  const authentic = await crypto.subtle.verify(
    'HMAC', key, signature, encoder.encode(`${TOKEN_PREFIX}.${parts[1]}`)
  );
  if (!authentic) return { ok: false, reason: 'bad_token' };

  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes)); }
  catch { return { ok: false, reason: 'bad_token' }; }
  const current = Math.trunc(Number(now));
  const issuedAt = Number(payload?.iat);
  const expiresAt = Number(payload?.exp);
  const deviceId = cleanPublicDeviceId(payload?.d);
  if (payload?.v !== 1 || payload?.p !== 'ai' ||
      typeof payload?.l !== 'string' || !/^h:[a-f0-9]{64}$/.test(payload.l) ||
      !deviceId || !Number.isSafeInteger(current) || !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) || issuedAt < 0 ||
      expiresAt <= issuedAt || expiresAt > issuedAt + TOKEN_TTL_MS ||
      issuedAt > current + CLOCK_SKEW_MS ||
      expiresAt <= current || expiresAt > current + TOKEN_TTL_MS + CLOCK_SKEW_MS) {
    return { ok: false, reason: expiresAt <= current ? 'expired_token' : 'bad_token' };
  }
  return {
    ok: true,
    license_ref: payload.l,
    device_id: deviceId,
    license_type: typeof payload.t === 'string' ? payload.t : null,
    license_expires_at: typeof payload.le === 'string' ? payload.le : null,
    issued_at: issuedAt,
    expires_at: expiresAt
  };
}

export const ENTITLEMENT_TOKEN_TTL_MS = TOKEN_TTL_MS;

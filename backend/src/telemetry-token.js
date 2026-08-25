/**
 * Short-lived telemetry attestations.
 *
 * Anonymous telemetry used to accept any caller-chosen device id, which meant
 * an unauthenticated script could manufacture users and product metrics. A
 * successful /verify now issues a narrow HMAC capability bound to the exact
 * claimed device. /t accepts only that capability; it grants no read access
 * and cannot be used for license verification or AI requests.
 */

import { cleanPublicDeviceId } from './referrals.js';

const TOKEN_PREFIX = 'tm1';
const TOKEN_TTL_MS = 26 * 60 * 60 * 1000;
const ERASURE_TOKEN_PREFIX = 'te1';
const ERASURE_TOKEN_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TOKEN_CHARS = 1024;
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
    // Reject non-canonical aliases so signer and verifier always agree on one
    // representation of the authenticated bytes.
    return bytesToBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

async function hmacKey(secret, usage) {
  const text = String(secret || '');
  if (text.length < 32) return null;
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(text),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage
  );
}

export async function issueTelemetryToken(env, rawDeviceId, now = Date.now()) {
  const deviceId = cleanPublicDeviceId(rawDeviceId);
  const issuedAt = Math.trunc(Number(now));
  if (!deviceId || !Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
  const key = await hmacKey(env?.INGEST_KEY, ['sign']);
  if (!key) return null;

  const payloadBytes = encoder.encode(JSON.stringify({
    v: 1,
    d: deviceId,
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_MS
  }));
  const payload = bytesToBase64Url(payloadBytes);
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${TOKEN_PREFIX}.${payload}`)
  ));
  return {
    token: `${TOKEN_PREFIX}.${payload}.${bytesToBase64Url(signature)}`,
    expires_at: issuedAt + TOKEN_TTL_MS
  };
}

export async function verifyTelemetryToken(env, rawToken, now = Date.now()) {
  const token = typeof rawToken === 'string' ? rawToken : '';
  if (!token || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: 'missing_token' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return { ok: false, reason: 'bad_token' };
  }
  const payloadBytes = base64UrlToBytes(parts[1]);
  const signature = base64UrlToBytes(parts[2]);
  const key = await hmacKey(env?.INGEST_KEY, ['verify']);
  if (!payloadBytes || !signature || !key) return { ok: false, reason: 'bad_token' };

  const authentic = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(`${TOKEN_PREFIX}.${parts[1]}`)
  );
  if (!authentic) return { ok: false, reason: 'bad_token' };

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'bad_token' };
  }
  const current = Math.trunc(Number(now));
  const deviceId = cleanPublicDeviceId(payload?.d);
  const issuedAt = Number(payload?.iat);
  const expiresAt = Number(payload?.exp);
  if (
    payload?.v !== 1 ||
    !deviceId ||
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt < 0 ||
    expiresAt !== issuedAt + TOKEN_TTL_MS ||
    issuedAt > current + CLOCK_SKEW_MS ||
    expiresAt <= current ||
    expiresAt > current + TOKEN_TTL_MS + CLOCK_SKEW_MS
  ) {
    return { ok: false, reason: expiresAt <= current ? 'expired_token' : 'bad_token' };
  }
  return { ok: true, device_id: deviceId, expires_at: expiresAt };
}

/** A longer-lived, deletion-only capability retained across license sign-out. */
export async function issueErasureToken(env, rawDeviceId, now = Date.now()) {
  const deviceId = cleanPublicDeviceId(rawDeviceId);
  const issuedAt = Math.trunc(Number(now));
  if (!deviceId || !Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
  const key = await hmacKey(env?.INGEST_KEY, ['sign']);
  if (!key) return null;
  const payloadBytes = encoder.encode(JSON.stringify({
    v: 1, p: 'erase', d: deviceId, iat: issuedAt, exp: issuedAt + ERASURE_TOKEN_TTL_MS
  }));
  const payload = bytesToBase64Url(payloadBytes);
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, encoder.encode(`${ERASURE_TOKEN_PREFIX}.${payload}`)
  ));
  return {
    token: `${ERASURE_TOKEN_PREFIX}.${payload}.${bytesToBase64Url(signature)}`,
    expires_at: issuedAt + ERASURE_TOKEN_TTL_MS
  };
}

export async function verifyErasureToken(env, rawToken, now = Date.now()) {
  const token = typeof rawToken === 'string' ? rawToken : '';
  if (!token || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: 'missing_token' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== ERASURE_TOKEN_PREFIX) {
    return { ok: false, reason: 'bad_token' };
  }
  const payloadBytes = base64UrlToBytes(parts[1]);
  const signature = base64UrlToBytes(parts[2]);
  const key = await hmacKey(env?.INGEST_KEY, ['verify']);
  if (!payloadBytes || !signature || !key) return { ok: false, reason: 'bad_token' };
  const authentic = await crypto.subtle.verify(
    'HMAC', key, signature, encoder.encode(`${ERASURE_TOKEN_PREFIX}.${parts[1]}`)
  );
  if (!authentic) return { ok: false, reason: 'bad_token' };
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes)); }
  catch { return { ok: false, reason: 'bad_token' }; }
  const current = Math.trunc(Number(now));
  const deviceId = cleanPublicDeviceId(payload?.d);
  const issuedAt = Number(payload?.iat);
  const expiresAt = Number(payload?.exp);
  if (payload?.v !== 1 || payload?.p !== 'erase' || !deviceId ||
      !Number.isSafeInteger(current) || !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) || issuedAt < 0 ||
      expiresAt !== issuedAt + ERASURE_TOKEN_TTL_MS ||
      issuedAt > current + CLOCK_SKEW_MS || expiresAt <= current ||
      expiresAt > current + ERASURE_TOKEN_TTL_MS + CLOCK_SKEW_MS) {
    return { ok: false, reason: expiresAt <= current ? 'expired_token' : 'bad_token' };
  }
  return { ok: true, device_id: deviceId, expires_at: expiresAt };
}

export const TELEMETRY_TOKEN_TTL_MS = TOKEN_TTL_MS;
export const TELEMETRY_ERASURE_TOKEN_TTL_MS = ERASURE_TOKEN_TTL_MS;

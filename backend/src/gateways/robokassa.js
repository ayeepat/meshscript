/**
 * Robokassa ResultURL adapter.
 *
 * Robokassa sends successful-payment notifications to the shop's ResultURL as
 * UTF-8 form/query parameters. The authenticity check is SignatureValue:
 *
 *   OutSum:InvId:Password#2[:Shp_key=value...]
 *
 * Shp_* parameters must be sorted alphabetically and included exactly as they
 * were returned. After accepting a valid notification, the handler must return
 * plain text OK{InvId}, for example OK5.
 *
 * Docs: https://docs.robokassa.ru/ru/notifications-and-redirects
 */

import { readBodyBounded } from '../request-body.js';

const ROBOKASSA_IPS = new Set(['185.59.216.65', '185.59.217.65']);
const MAX_RESULT_BODY_BYTES = 16 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_PROVIDER_TIMEOUT_MS = 10 * 1000;
const MIN_PROVIDER_TIMEOUT_MS = 10;
const MAX_PROVIDER_TIMEOUT_MS = 60 * 1000;
const OP_STATE_URL = 'https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpStateExt';
const REFUND_CREATE_URL = 'https://services.robokassa.ru/RefundService/Refund/Create';
const REFUND_STATE_URL = 'https://services.robokassa.ru/RefundService/Refund/GetState';

const SHA_ALGORITHMS = {
  SHA1: 'SHA-1',
  'SHA-1': 'SHA-1',
  SHA256: 'SHA-256',
  'SHA-256': 'SHA-256',
  SHA384: 'SHA-384',
  'SHA-384': 'SHA-384',
  SHA512: 'SHA-512',
  'SHA-512': 'SHA-512'
};

export function isSupportedHashAlgorithm(algorithm = 'MD5') {
  const normalized = String(algorithm || 'MD5').toUpperCase().replace(/_/g, '-');
  return normalized === 'MD5' || !!SHA_ALGORITHMS[normalized];
}

// The refund API signs a JWT, so it accepts only the HMAC family — a narrower
// set than the callback signature above. Readiness must check THIS allowlist:
// validating a refund algorithm against isSupportedHashAlgorithm would pass
// something like RS256 and only fail later, inside createRefund, after the
// order had already been moved into an unretryable refund state.
const REFUND_HASH_ALGORITHMS = new Set(['HS256', 'HS384', 'HS512']);

export function isSupportedRefundHashAlgorithm(algorithm = 'HS256') {
  return REFUND_HASH_ALGORITHMS.has(String(algorithm || 'HS256').toUpperCase());
}

export function shouldEnforceIpAllowlist(env) {
  return String(env.ROBOKASSA_ENFORCE_IP_ALLOWLIST || '').toLowerCase() === 'true';
}

export function isRobokassaIp(ip) {
  return ROBOKASSA_IPS.has(String(ip || '').trim());
}

export async function readResultFields(request) {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    if (new TextEncoder().encode(url.search).byteLength > MAX_RESULT_BODY_BYTES) {
      throw Object.assign(new Error('result payload too large'), { status: 413 });
    }
    return fieldsFromParams(url.searchParams);
  }

  const contentType = request.headers.get('content-type') || '';
  const body = await readBodyBounded(request, MAX_RESULT_BODY_BYTES);
  if (!body.ok) throw Object.assign(new Error(body.reason), { status: body.status });
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return fieldsFromParams(new URLSearchParams(body.text));
    }
    const form = await new Response(body.bytes, { headers: { 'Content-Type': contentType } }).formData();
    const out = Object.create(null);
    for (const [key, value] of form.entries()) out[key] = typeof value === 'string' ? value : '';
    return out;
  }

  if (contentType.includes('application/json')) {
    const parsed = JSON.parse(body.text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')]))
      : Object.create(null);
  }

  return fieldsFromParams(new URLSearchParams(body.text));
}

export function fieldsFromParams(params) {
  const out = Object.create(null);
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

export function invoiceId(fields) {
  return first(fields, 'InvId', 'InvID', 'InvoiceID');
}

export function normalizeResult(fields) {
  const invId = invoiceId(fields);
  if (!invId) return { ok: false, reason: 'missing_invoice' };
  // Robokassa's InvId is a decimal order number. Preserve the signed spelling
  // for the required OK{InvId} acknowledgement, but canonicalize the payment
  // identity below so "42" and "00042" cannot claim two licenses.
  if (!/^\d{1,20}$/.test(invId)) return { ok: false, reason: 'bad_invoice' };
  const paymentId = BigInt(invId).toString();

  const outSum = first(fields, 'OutSum');
  // Production ResultURL notifications use six fractional digits, while the
  // test environment may use two. RUB is still accounted in kopecks: accept
  // the provider's wider spelling only when the sub-kopeck digits are zero.
  // Number() also accepts whitespace, exponents and hex, so parse the exact
  // signed decimal representation instead of coercing it.
  const amountMatch = /^(\d+)(?:\.(\d{1,6}))?$/.exec(outSum);
  if (!amountMatch) return { ok: false, reason: 'bad_amount' };
  const fractional = (amountMatch[2] || '').padEnd(6, '0');
  if (fractional.slice(2) !== '0000') return { ok: false, reason: 'bad_amount' };
  const wholeRub = Number(amountMatch[1]);
  const kopecks = wholeRub * 100 + Number(fractional.slice(0, 2));
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0) {
    return { ok: false, reason: 'bad_amount' };
  }
  return {
    ok: true,
    gateway: 'robokassa',
    invoice_id: invId,
    payment_id: paymentId,
    amount_kopecks: kopecks,
    // Compatibility/display only. Authorization and accounting use kopecks.
    amount_rub: kopecks / 100,
    raw: fields
  };
}

export async function verifyResultSignature(fields, password2, algorithm = 'MD5') {
  if (!password2) return { ok: false, reason: 'missing_password2' };
  const signature = first(fields, 'SignatureValue');
  if (!signature) return { ok: false, reason: 'missing_signature' };

  let expected;
  try {
    expected = await hashHex(resultSignatureBase(fields, password2), algorithm || 'MD5');
  } catch (e) {
    return { ok: false, reason: 'unsupported_hash' };
  }

  return timingSafeEqual(expected.toLowerCase(), String(signature).toLowerCase())
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}

export function resultSignatureBase(fields, password2) {
  const outSum = first(fields, 'OutSum');
  const invId = invoiceId(fields);
  return [outSum, invId, password2, ...shpPairs(fields)].join(':');
}

export function paymentSignatureBase({
  merchantLogin, outSum, invId, password1, receipt = '', stepByStep = '',
  resultUrl2 = '', successUrl2 = '', successUrl2Method = '',
  failUrl2 = '', failUrl2Method = '', token = '', shp = {}
}) {
  const parts = [merchantLogin, outSum, invId];
  // Robokassa's extended payment-interface fields are signature modifiers,
  // not decorative form values. They must appear in this exact provider
  // order before Password #1 whenever they are sent. In particular, leaving
  // alternative return URLs out of the signature lets the provider reject a
  // checkout that otherwise looks valid in the browser.
  for (const modifier of [
    receipt, stepByStep, resultUrl2, successUrl2, successUrl2Method,
    failUrl2, failUrl2Method, token
  ]) {
    if (modifier !== '' && modifier != null) parts.push(String(modifier));
  }
  parts.push(password1, ...shpPairs(shp));
  return parts.join(':');
}

export function formatKopecks(kopecks) {
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0) throw new Error('invalid kopecks');
  return `${Math.floor(kopecks / 100)}.${String(kopecks % 100).padStart(2, '0')}`;
}

const ROBOKASSA_EXPIRATION_TIME_ZONE = 'Europe/Moscow';

/**
 * Robokassa's gateway-side payment deadline. The payment-interface contract
 * requires exactly `YYYY-MM-DDThh:mm` (no seconds or offset). Robokassa treats
 * zone-less timestamps as Moscow wall time, so format in that zone explicitly
 * instead of relying on the Worker's locale.
 *
 * Not signed — it is not part of any SignatureValue base string — so it is
 * added to the field set only.
 */
function formatExpirationDate(expiresAt) {
  const at = new Date(Number(expiresAt));
  if (!Number.isFinite(at.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: ROBOKASSA_EXPIRATION_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(at).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function providerTimeoutMs(value) {
  const configured = Number(value);
  return Number.isSafeInteger(configured) &&
    configured >= MIN_PROVIDER_TIMEOUT_MS && configured <= MAX_PROVIDER_TIMEOUT_MS
    ? configured
    : DEFAULT_PROVIDER_TIMEOUT_MS;
}

// Abort real fetches and independently reject the caller. The Promise.race is
// essential for injected or non-compliant fetchers that ignore AbortSignal;
// the signal still cancels the network/body stream in production.
async function withProviderDeadline(timeoutMs, operation) {
  const controller = new AbortController();
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('robokassa provider timeout');
          error.name = 'TimeoutError';
          reject(error);
          controller.abort();
        }, providerTimeoutMs(timeoutMs));
      })
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function createPaymentFields({
  merchantLogin, password1, algorithm = 'MD5', amountKopecks, invId,
  description = '', email = null, isTest = false, receipt = '', shp = {},
  expiresAt = null, resultUrl2 = '', successUrl2 = '', failUrl2 = ''
}) {
  const outSum = formatKopecks(amountKopecks);
  // Robokassa requires the compact UTF-8 Receipt JSON to be URL-encoded both
  // in the field value and in the SignatureValue base string. The browser's
  // form encoding adds the transport layer on top of this provider encoding.
  const encodedReceipt = receipt ? encodeURIComponent(String(receipt)) : '';
  // URL2 has two representations in Robokassa's classic interface: the raw
  // URL is the form-field value (ordinary form transport encodes it once),
  // while SignatureValue covers encodeURIComponent(raw URL). Receipt differs:
  // its already-encoded value is deliberately sent in the field as well.
  const encodedResultUrl2 = resultUrl2 ? encodeURIComponent(String(resultUrl2)) : '';
  const encodedSuccessUrl2 = successUrl2 ? encodeURIComponent(String(successUrl2)) : '';
  const encodedFailUrl2 = failUrl2 ? encodeURIComponent(String(failUrl2)) : '';
  const fields = {
    MerchantLogin: String(merchantLogin || ''),
    OutSum: outSum,
    InvId: String(invId || ''),
    Description: String(description || '').slice(0, 100),
    ...Object.fromEntries(Object.entries(shp).sort(([a], [b]) => a.localeCompare(b)))
  };
  if (!fields.MerchantLogin || !password1 || !/^\d+$/.test(fields.InvId)) {
    throw new Error('invalid payment fields');
  }
  if (email) fields.Email = String(email);
  if (encodedReceipt) fields.Receipt = encodedReceipt;
  if (resultUrl2) fields.ResultUrl2 = String(resultUrl2);
  if (successUrl2) {
    fields.SuccessUrl2 = String(successUrl2);
    fields.SuccessUrl2Method = 'GET';
  }
  if (failUrl2) {
    fields.FailUrl2 = String(failUrl2);
    fields.FailUrl2Method = 'GET';
  }
  // Without this the 30-minute order TTL was purely LOCAL: the customer could
  // leave the provider checkout open and pay after our deadline, and the signed
  // callback then landed on an expired order — acknowledged into manual review
  // instead of issuing the licence they had just paid for.
  if (expiresAt != null) {
    const expiration = formatExpirationDate(expiresAt);
    if (!expiration) throw new Error('invalid payment expiry');
    fields.ExpirationDate = expiration;
  }
  if (isTest) fields.IsTest = '1';
  fields.SignatureValue = await hashHex(paymentSignatureBase({
    merchantLogin: fields.MerchantLogin,
    outSum,
    invId: fields.InvId,
    password1,
    receipt: encodedReceipt,
    resultUrl2: encodedResultUrl2,
    successUrl2: encodedSuccessUrl2,
    successUrl2Method: fields.SuccessUrl2Method || '',
    failUrl2: encodedFailUrl2,
    failUrl2Method: fields.FailUrl2Method || '',
    shp
  }), algorithm);
  return fields;
}

export async function queryOperationState({
  merchantLogin, invoiceId: id, password2, algorithm = 'MD5', fetcher = fetch,
  timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS
}) {
  const invoice = String(id || '');
  if (!merchantLogin || !password2 || !/^\d+$/.test(invoice)) {
    throw new Error('invalid operation-state request');
  }
  const signature = await hashHex(`${merchantLogin}:${invoice}:${password2}`, algorithm);
  const url = new URL(OP_STATE_URL);
  url.searchParams.set('MerchantLogin', merchantLogin);
  url.searchParams.set('InvoiceID', invoice);
  url.searchParams.set('Signature', signature);
  return withProviderDeadline(timeoutMs, async (signal) => {
    const response = await fetcher(url.toString(), {
      method: 'GET', headers: { Accept: 'application/xml' }, redirect: 'error', signal
    });
    if (!response.ok) throw new Error(`operation-state http ${response.status}`);
    const body = await readBodyBounded(response, MAX_PROVIDER_RESPONSE_BYTES);
    if (!body.ok || /<!DOCTYPE|<!ENTITY/i.test(body.text)) {
      throw new Error('invalid operation-state response');
    }
    const resultBlock = xmlBlock(body.text, 'Result');
    const stateBlock = xmlBlock(body.text, 'State');
    const infoBlock = xmlBlock(body.text, 'Info');
    const resultCode = strictInteger(xmlText(resultBlock, 'Code'));
    if (resultCode == null) throw new Error('invalid operation-state result');
    return {
      result_code: resultCode,
      state_code: strictInteger(xmlText(stateBlock, 'Code')),
      out_currency: xmlText(infoBlock, 'OutCurrLabel'),
      out_sum: xmlText(infoBlock, 'OutSum'),
      op_key: xmlText(infoBlock, 'OpKey')
    };
  });
}

export async function createRefund({
  opKey, password3, invoiceItems = null, algorithm = 'HS256', fetcher = fetch,
  timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS
}) {
  const normalizedAlgorithm = String(algorithm || 'HS256').toUpperCase();
  if (!isSupportedRefundHashAlgorithm(normalizedAlgorithm) || !opKey || !password3) {
    throw new Error('invalid refund request');
  }
  const payload = { OpKey: String(opKey) };
  if (invoiceItems) payload.InvoiceItems = invoiceItems;
  const token = await signJwt(payload, password3, normalizedAlgorithm);
  return withProviderDeadline(timeoutMs, async (signal) => {
    const response = await fetcher(REFUND_CREATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'application/json' },
      body: token,
      redirect: 'error',
      signal
    });
    if (!response.ok) throw new Error(`refund-create http ${response.status}`);
    const parsed = await readProviderJson(response);
    const requestId = String(parsed?.requestId || '');
    if (parsed?.success !== true || !isGuid(requestId)) {
      return { ok: false, reason: safeProviderLabel(parsed?.message) || 'refund_rejected' };
    }
    return { ok: true, request_id: requestId };
  });
}

export async function queryRefundState({
  requestId, fetcher = fetch, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS
}) {
  const id = String(requestId || '');
  if (!isGuid(id)) throw new Error('invalid refund state request');
  const url = new URL(REFUND_STATE_URL);
  url.searchParams.set('id', id);
  return withProviderDeadline(timeoutMs, async (signal) => {
    const response = await fetcher(url.toString(), {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal
    });
    if (!response.ok) throw new Error(`refund-state http ${response.status}`);
    const parsed = await readProviderJson(response);
    if (String(parsed?.requestId || '').toLowerCase() !== id.toLowerCase()) {
      throw new Error('invalid refund state response');
    }
    const label = String(parsed?.label || '').toLowerCase();
    if (!['processing', 'finished', 'canceled'].includes(label)) {
      throw new Error('invalid refund state label');
    }
    return { request_id: id, label, amount: String(parsed.amount ?? '') };
  });
}

export function okResponse(invId) {
  return new Response(`OK${invId}`, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

async function hashHex(input, algorithm) {
  const normalized = String(algorithm || 'MD5').toUpperCase().replace(/_/g, '-');
  if (normalized === 'MD5') return md5Hex(input);

  const subtleName = SHA_ALGORITHMS[normalized];
  if (!subtleName) throw new Error(`Unsupported hash algorithm: ${algorithm}`);

  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest(subtleName, bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function signJwt(payload, password, algorithm) {
  const header = { alg: algorithm, typ: 'JWT' };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const subtleAlgorithm = `SHA-${algorithm.slice(2)}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password),
    { name: 'HMAC', hash: subtleAlgorithm }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function base64UrlJson(value) {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function readProviderJson(response) {
  const body = await readBodyBounded(response, MAX_PROVIDER_RESPONSE_BYTES);
  if (!body.ok) throw new Error('invalid provider response');
  try {
    const parsed = JSON.parse(body.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('invalid provider response');
  }
}

function xmlBlock(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}>`,
    'i'
  ).exec(String(xml || ''));
  return match ? match[1] : '';
}

function xmlText(xml, name) {
  const raw = xmlBlock(xml, name);
  if (!raw || /<[^>]+>/.test(raw)) return '';
  return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}

function strictInteger(value) {
  return /^-?\d+$/.test(String(value || '')) ? Number(value) : null;
}

function isGuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeProviderLabel(value) {
  const label = String(value || '').trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(label) ? label : '';
}

function shpPairs(fields) {
  return Object.keys(fields)
    .filter((key) => key.startsWith('Shp_'))
    .sort()
    .map((key) => `${key}=${fields[key] ?? ''}`);
}

function first(fields, ...names) {
  for (const name of names) {
    if (fields && fields[name] != null && fields[name] !== '') return String(fields[name]);
  }
  return '';
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function leftRotate(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function md5Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >>> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];
  const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true));
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const next = d;
      d = c;
      c = b;
      b = (b + leftRotate((a + f + constants[i] + words[g]) >>> 0, shifts[i])) >>> 0;
      a = next;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return bytesToHex(out);
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

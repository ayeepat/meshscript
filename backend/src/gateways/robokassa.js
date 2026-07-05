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

const ROBOKASSA_IPS = new Set(['185.59.216.65', '185.59.217.65']);

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

export function shouldEnforceIpAllowlist(env) {
  return String(env.ROBOKASSA_ENFORCE_IP_ALLOWLIST || '').toLowerCase() === 'true';
}

export function isRobokassaIp(ip) {
  return ROBOKASSA_IPS.has(String(ip || '').trim());
}

export async function readResultFields(request) {
  if (request.method === 'GET') {
    return fieldsFromParams(new URL(request.url).searchParams);
  }

  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const out = {};
    for (const [key, value] of form.entries()) out[key] = typeof value === 'string' ? value : '';
    return out;
  }

  if (contentType.includes('application/json')) {
    const body = await request.json();
    return body && typeof body === 'object' ? Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v ?? '')])) : {};
  }

  const text = await request.text();
  return fieldsFromParams(new URLSearchParams(text));
}

export function fieldsFromParams(params) {
  const out = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

export function invoiceId(fields) {
  return first(fields, 'InvId', 'InvID', 'InvoiceID');
}

export function normalizeResult(fields) {
  const invId = invoiceId(fields);
  if (!invId) return { ok: false, reason: 'missing_invoice' };

  const outSum = first(fields, 'OutSum');
  const amount = Number(outSum);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'bad_amount' };

  return {
    ok: true,
    gateway: 'robokassa',
    invoice_id: invId,
    payment_id: invId,
    amount_rub: amount,
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

export function paymentSignatureBase({ merchantLogin, outSum, invId, password1, receipt = '', shp = {} }) {
  const parts = [merchantLogin, outSum, invId];
  if (receipt) parts.push(receipt);
  parts.push(password1, ...shpPairs(shp));
  return parts.join(':');
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

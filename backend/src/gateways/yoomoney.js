/**
 * YooMoney (wallet / Quickpay) webhook adapter.
 *
 * This is the lightweight sibling of gateways/yookassa.js. Where YooKassa is the
 * business acquirer (needs ИП / self-employed registration), YooMoney lets an
 * INDIVIDUAL take payments to a personal wallet via a Quickpay button — no legal
 * entity required. Good fit for a solo preorder launch.
 *
 * ── How authenticity is enforced ──────────────────────────────────────────
 * YooMoney does NOT publish a stable egress IP range, so (unlike YooKassa) the
 * IP allowlist is not an option. The ONLY authenticity control is the SHA-1
 * signature YooMoney attaches to every notification. We MUST verify it or the
 * endpoint mints free licenses for anyone who can POST to it.
 *
 *   sha1_hash = SHA1(
 *     notification_type & operation_id & amount & currency &
 *     datetime & sender & codepro & <notification_secret> & label
 *   )
 *
 * `notification_secret` comes from https://yoomoney.ru/transfer/myservices/http-notification
 * (the same page where you register the notification URL). Store it as the worker
 * secret YOOMONEY_NOTIFICATION_SECRET.
 *
 * ── Notification payload (application/x-www-form-urlencoded) ───────────────
 *   notification_type : "p2p-incoming" | "card-incoming"
 *   operation_id      : unique id of the operation      (idempotency key)
 *   amount            : credited to your wallet AFTER fees, e.g. "990.00"
 *   withdraw_amount   : debited from the sender
 *   currency          : "643" (RUB)
 *   datetime          : ISO 8601
 *   sender            : payer's wallet (may be empty for card)
 *   codepro           : "true" => PROTECTED payment, payer can still cancel it.
 *                       Never deliver a key until it's accepted.
 *   label             : YOUR field — we thread the buyer's delivery contact
 *                       (email) or an order id through it (see resolveContact).
 *   sha1_hash         : the signature above
 *   test_notification : present ("true") when YooMoney sends a test ping
 *   unaccepted        : "true" while a codepro payment is still unaccepted
 *
 * To carry the buyer's contact, the order page builds the Quickpay link with
 * `label=<buyer email>` (or a pre-registered order id). Without a contact we
 * have nowhere to send the key — the worker acks 200 but does not issue.
 *
 * Docs: https://yoomoney.ru/docs/wallet/using-api/notification-p2p-incoming
 */

// Fields that feed the SHA-1, in the EXACT order YooMoney specifies. The secret
// is spliced in at the notification_secret position (see verifyNotification).
const HASH_FIELDS = [
  'notification_type', 'operation_id', 'amount', 'currency',
  'datetime', 'sender', 'codepro' /* <secret> */, 'label'
];

/** Pull the notification fields out of the parsed form body into a plain object. */
export function parseForm(form) {
  const get = (k) => {
    const v = form.get(k);
    return v == null ? '' : String(v);
  };
  return {
    notification_type: get('notification_type'),
    operation_id: get('operation_id'),
    amount: get('amount'),
    withdraw_amount: get('withdraw_amount'),
    currency: get('currency'),
    datetime: get('datetime'),
    sender: get('sender'),
    codepro: get('codepro'),
    label: get('label'),
    sha1_hash: get('sha1_hash'),
    test_notification: get('test_notification'),
    unaccepted: get('unaccepted')
  };
}

async function sha1Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string compare (both are lowercase hex of fixed length here, but
// stay defensive so a length/timing side-channel can't leak the expected hash).
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the notification signature. Returns true only when the recomputed
 * SHA-1 matches the one YooMoney sent. Returns false (never throws) if the
 * secret is unset — an unsigned-config deploy must FAIL CLOSED, not open.
 */
export async function verifyNotification(fields, secret) {
  if (!secret) return false;
  if (!fields || !fields.sha1_hash) return false;
  const parts = HASH_FIELDS.map((f) => (f === 'label' ? fields.label : fields[f]) ?? '');
  // Splice the secret in at the notification_secret position (between codepro
  // and label): the docs' formula is …&codepro&<secret>&label.
  parts.splice(HASH_FIELDS.indexOf('codepro') + 1, 0, secret);
  const expected = await sha1Hex(parts.join('&'));
  return timingSafeEqual(expected, String(fields.sha1_hash).toLowerCase());
}

/**
 * Decide whether a verified notification is actually fulfillable, and normalize
 * it into the shape the issuance path wants. Returns { ok:false, reason } for
 * anything we must NOT issue on (test ping, protected/unaccepted payment, wrong
 * currency) so the worker can ack 200 without minting a key.
 *
 * @param {object} fields   parsed + already-signature-verified notification
 * @param {object} [opts]
 * @param {boolean} [opts.allowTest]  treat a test_notification as issuable (default false)
 */
export function normalize(fields, { allowTest = false } = {}) {
  // A test ping from the YooMoney dashboard: signature is valid but there's no
  // real money. Ack it so setup shows "success", but don't issue.
  if (fields.test_notification === 'true' && !allowTest) {
    return { ok: false, reason: 'test' };
  }
  // Protected (codepro) payments can still be cancelled by the sender. Delivering
  // a key now risks a chargeback with the product already handed over. Wait for
  // the follow-up notification where codepro is no longer set / unaccepted flips.
  if (fields.codepro === 'true' || fields.unaccepted === 'true') {
    return { ok: false, reason: 'unaccepted' };
  }
  // RUB only (643), strictly — a missing/empty currency must NOT pass. Real
  // notifications always carry it; anything else is misconfig or a probe.
  if (fields.currency !== '643') {
    return { ok: false, reason: 'currency' };
  }
  const amount = Number(fields.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'amount' };
  }
  return {
    ok: true,
    gateway: 'yoomoney',
    payment_id: fields.operation_id,   // idempotency key
    amount_rub: amount,                 // AFTER YooMoney's fee
    label: fields.label || '',
    raw: fields
  };
}

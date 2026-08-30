/**
 * «Пригласи друга» ships switched OFF, and the switch has to mean the same
 * thing on both sides of the wire:
 *
 *   backend  — the three /referral/* routes answer `coming_soon` without
 *              touching storage, and a code typed into a checkout page that
 *              has not caught up earns the buyer no bonus and the referrer no
 *              days (backend/wrangler.toml REFERRALS_ENABLED="false").
 *   extension — the Settings card stays visible but inert, says «Скоро», and
 *               answers a click instead of silently doing nothing
 *               (src/lib/config.js REFERRALS_ENABLED === false).
 *
 * Every assertion here has a switched-ON twin. A kill switch that also passes
 * its tests when the feature is dead in both positions proves nothing, and the
 * live paths behind it are still the paths this programme launches on.
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';
import * as payments from '../backend/src/payments.js';
import { resultSignatureBase } from '../backend/src/gateways/robokassa.js';
import { REFERRALS_ENABLED } from '../src/lib/config.js';

const CODE = 'REF-CDEA-0001';
const PASSWORD1 = 'referral-switch-payment-password-1';
const PASSWORD2 = 'referral-switch-result-password-2';
const DAY_MS = 24 * 60 * 60 * 1000;
const schemaSql = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');
const settingsSource = await readFile(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
const settingsHtml = await readFile(new URL('../src/settings/settings.html', import.meta.url), 'utf8');
const serviceWorkerSource = await readFile(
  new URL('../src/background/service-worker.js', import.meta.url), 'utf8'
);
const wranglerToml = await readFile(new URL('../backend/wrangler.toml', import.meta.url), 'utf8');

/* ------------------------- the shipped positions ---------------------- */

assert.equal(REFERRALS_ENABLED, false, 'the extension card ships switched off');
assert.match(wranglerToml, /^REFERRALS_ENABLED = "false"$/m,
  'the deployed backend position must be pinned in wrangler.toml, not left to an unset var');

/* --------------------------- public routes ---------------------------- */

// Storage that fails loudly. A refusal is only cheap if it happens before any
// binding is touched: these routes are unauthenticated, so a switched-off
// programme must not leave an anonymous KV/D1 lookup reachable.
const hostileStorage = {
  LICENSES: {
    async get(key) { throw new Error(`disabled referrals must not read KV (${key})`); },
    async put(key) { throw new Error(`disabled referrals must not write KV (${key})`); }
  },
  DB: { prepare(sql) { throw new Error(`disabled referrals must not touch D1 (${sql})`); } }
};
const ctx = { waitUntil() {} };
const DEVICE = '11111111-1111-4111-8111-111111111111';

const post = (path, body, env) => worker.fetch(new Request(`https://api.example${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
  body: JSON.stringify(body)
}), env, ctx);

const check = (code, env) => worker.fetch(
  new Request(`https://api.example/referral/check?code=${encodeURIComponent(code)}`, {
    headers: { 'CF-Connecting-IP': '198.51.100.7' }
  }),
  env,
  ctx
);

// Unset, explicitly false, and anything that is not an affirmative value all
// mean OFF. The programme must never come back because a var was mistyped.
for (const value of [undefined, 'false', '0', 'no', 'off', '', '  ', 'maybe', 'TRUE-ish']) {
  const env = value === undefined
    ? { ...hostileStorage }
    : { ...hostileStorage, REFERRALS_ENABLED: value };
  const label = value === undefined ? '(unset)' : JSON.stringify(value);

  const code = await post('/referral/code', { device_id: DEVICE, referral_auth: 'a'.repeat(43) }, env);
  assert.equal(code.status, 503, `REFERRALS_ENABLED=${label} must refuse /referral/code`);
  assert.deepEqual(await code.json(), { ok: false, reason: 'coming_soon' });
  assert.equal(code.headers.get('access-control-allow-origin'), '*',
    'the refusal is still a cross-origin answer the extension has to be able to read');

  const status = await post('/referral/status', { device_id: DEVICE, referral_auth: 'a'.repeat(43) }, env);
  assert.equal(status.status, 503, `REFERRALS_ENABLED=${label} must refuse /referral/status`);
  assert.deepEqual(await status.json(), { ok: false, reason: 'coming_soon' });

  // The checkout page asks this one before charging, so it stays a 200 verdict:
  // `enabled:false` lets the page say «скоро» instead of «неверный код», and a
  // zero bonus stops it advertising days the webhook will not grant.
  const verdict = await check(CODE, env);
  assert.equal(verdict.status, 200, `REFERRALS_ENABLED=${label} must still answer /referral/check`);
  assert.deepEqual(await verdict.json(), {
    ok: true, enabled: false, valid: false, reason: 'coming_soon', buyer_bonus_pct: 0
  });
}

// Switched on, the same requests reach the live handlers again. (A malformed
// code is answered by normalizeRefCode's fast path, so this probe proves the
// routing without needing storage.)
const liveEnv = { ...hostileStorage, REFERRALS_ENABLED: 'true' };
const liveVerdict = await check('ABCDEFGH', liveEnv);
assert.equal(liveVerdict.status, 200);
assert.deepEqual(await liveVerdict.json(),
  { ok: true, valid: false, reason: 'bad_code', buyer_bonus_pct: 10 },
  'the switch must restore the real verdict shape, bonus percentage included');

/* ------------------------- checkout and payout ------------------------ */

class MemoryKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, String(value)); }
  async list() { return { keys: [], list_complete: true }; }
}

class SqliteD1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const db = this.db;
    const statement = (args = []) => ({
      bind: (...bound) => statement(bound),
      async first(column) {
        const row = db.prepare(sql).get(...args) || null;
        return column ? row?.[column] ?? null : row;
      },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) || 0 } };
      }
    });
    return statement();
  }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function paidEnvironment(referralsEnabled) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schemaSql);
  const kv = new MemoryKV();
  // A referral record that is real, materialized and eligible: nothing about
  // THIS purchase should be what stops the payout — only the switch.
  kv.store.set(`ref:${CODE}`, JSON.stringify({
    code: CODE,
    owner_device_id: '22222222-2222-4222-8222-222222222222',
    owner_license_key: null,
    purchases: 0,
    days_earned: 0,
    reward_key: null,
    auth_hash: 'a'.repeat(64)
  }));
  return {
    sqlite,
    kv,
    env: {
      DB: new SqliteD1(sqlite),
      LICENSES: kv,
      REFERRALS_ENABLED: referralsEnabled,
      RUNTIME_WRITE_EPOCH: '1',
      PAYMENT_ENVIRONMENT: 'production',
      ROBOKASSA_MERCHANT_LOGIN: 'smesh-referral-switch',
      ROBOKASSA_PASSWORD1_PRODUCTION: PASSWORD1,
      ROBOKASSA_PASSWORD2_PRODUCTION: PASSWORD2,
      ROBOKASSA_HASH_ALGO: 'SHA-256',
      ROBOKASSA_FISCALIZATION_MODE: 'external',
      ROBOKASSA_OUT_CURRENCY_LABEL: 'RUB',
      SUBSCRIPTION_PRICE_RUB: '149',
      SUBSCRIPTION_DAYS: '30',
      LIFETIME_PRICE_RUB: '999',
      ROBOKASSA_SUCCESS_URL2: 'https://site.example/checkout/success/',
      ROBOKASSA_FAIL_URL2: 'https://site.example/checkout/',
      CHECKOUT_CAPABILITY_SECRET: 'referral-switch-checkout-capability-secret-01234',
      INGEST_KEY: 'referral-switch-distinct-ingest-secret-0123456789',
      RESEND_API_KEY: 'referral-switch-resend-key',
      EMAIL_FROM: 'Smesh <license@example.com>'
    }
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const target = String(input?.url || input);
  if (target === 'https://api.resend.com/emails') return new Response('', { status: 200 });
  throw new Error(`unexpected external request in referral switch regression: ${target}`);
};

/** Buy a subscription with `CODE` typed at checkout; return the issued license. */
async function purchaseWithReferral(rig, ip) {
  const order = await payments.createRobokassaOrder(rig.env, {
    plan: 'subscription', email: `buyer-${ip}@example.com`, referral_code: CODE
  }, ip);
  assert.equal(order.ok, true);
  assert.equal(
    rig.sqlite.prepare('SELECT referral_code FROM payment_orders WHERE order_id = ?')
      .get(order.order_id).referral_code,
    CODE,
    'the order must actually carry the code — otherwise this test proves nothing'
  );

  const fields = {
    OutSum: order.fields.OutSum,
    InvId: String(order.order_id),
    Shp_environment: 'production',
    Shp_order_id: String(order.order_id)
  };
  fields.SignatureValue = createHash('sha256')
    .update(resultSignatureBase(fields, PASSWORD2), 'utf8').digest('hex');

  const pending = [];
  const response = await worker.fetch(new Request('https://api.example/webhook/robokassa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  }), rig.env, { waitUntil: (promise) => pending.push(Promise.resolve(promise)) });
  await Promise.all(pending);
  assert.equal(response.status, 200, await response.text());

  // Follow the payment index rather than scanning: a rewarded purchase also
  // mints the REFERRER's subscription, and this must return the buyer's.
  const issuedKey = rig.kv.store.get(`payment:robokassa:${order.order_id}`);
  assert.ok(issuedKey, 'the paid callback must index a license for this payment');
  return JSON.parse(rig.kv.store.get(issuedKey));
}

try {
  // Switched OFF: a real payment still succeeds — that is the one thing a
  // referral must never break — but it buys the plain plan and pays nobody.
  const off = paidEnvironment('false');
  const plain = await purchaseWithReferral(off, '192.0.2.40');
  assert.equal(plain.subscription_duration_ms, 30 * DAY_MS,
    'a disabled programme must not extend the buyer by the +10% bonus');
  assert.equal(plain.referral_code, null,
    'the claim must freeze no referral, so no later redelivery can pay this code out');
  assert.equal(
    [...off.kv.store.keys()].some((key) => key.startsWith('refpaid:')), false,
    'no purchase marker may be written for a code that earned nothing'
  );
  assert.equal(JSON.parse(off.kv.store.get(`ref:${CODE}`)).purchases, 0,
    'the referrer must see no purchase credited');
  assert.equal(
    off.sqlite.prepare('SELECT COUNT(*) AS n FROM referral_credits').get().n, 0,
    'no durable credit row may be journaled while the programme is off'
  );
  off.sqlite.close();

  // Switched ON: the identical fixture pays out. Without this half, the
  // assertions above would keep passing after the feature was accidentally
  // broken for good.
  const on = paidEnvironment('true');
  const rewarded = await purchaseWithReferral(on, '192.0.2.41');
  assert.equal(rewarded.subscription_duration_ms, Math.round(30 * DAY_MS * 1.1),
    'the switch must restore the buyer bonus');
  assert.equal(rewarded.referral_code, CODE);
  assert.equal(on.sqlite.prepare('SELECT COUNT(*) AS n FROM referral_credits').get().n, 1,
    'the switch must restore the referrer credit');
  on.sqlite.close();
} finally {
  globalThis.fetch = realFetch;
}

/* ---------------------------- Settings card --------------------------- */

// The markup is honest on its own: nothing in the shipped HTML may promise
// bonus days before settings.js has decided whether the card is live. A flash
// of "+7 дней подписки" on every settings open would be a promise we are not
// currently keeping.
const soonLede = /<p id="refSoonLede">(?!.*hidden)[^<]*Приглашения[^<]*<\/p>/.test(settingsHtml);
assert.ok(soonLede, 'settings.html must ship the «скоро» lede visible');
assert.match(settingsHtml, /<p id="refLiveLede" hidden>[\s\S]*?\+10% дней/,
  'the live promise must ship hidden');
assert.match(settingsHtml, /<span class="licstatus" id="refSoon" data-state="idle">Скоро<\/span>/);
assert.match(settingsHtml, /<p class="ref-soon-note" id="refSoonNote" role="status" hidden>/,
  'the coming-soon note ships hidden and announces itself when revealed');
assert.match(settingsHtml, /<p class="ref-hint" id="refLiveHint" hidden>/);

// The referral network is not merely ignored, it is never called.
assert.match(settingsSource, /if \(REFERRALS_ENABLED\) loadReferralUi\(\);/,
  'the card must not fetch a code the backend refuses to mint');
assert.match(
  serviceWorkerSource,
  /if \(status\?\.ok && REFERRALS_ENABLED\) \{/,
  'license activation must not queue a referral pointer sync while the programme is off'
);
assert.match(
  serviceWorkerSource,
  /if \(!REFERRALS_ENABLED\) return clearReferralPointerIntent\(intent\.id\);/,
  'an intent left over from an earlier build must be dropped, not retried forever'
);

const referralUiSource = (() => {
  const start = settingsSource.indexOf('/* ---------- Referral («Пригласи друга») ---------- */');
  const end = settingsSource.indexOf('/* ---------- Privacy consent ---------- */', start);
  assert.ok(start >= 0 && end > start, 'referral UI source must be extractable');
  return settingsSource.slice(start, end);
})();

function cardContext(enabled) {
  const ids = [
    'refCode', 'refCopyCode', 'refCopyInvite', 'refRewardCopy', 'refSoonNote',
    'refSoon', 'refSoonLede', 'refLiveLede', 'refSoonHint', 'refLiveHint'
  ];
  // The shipped settings.html starting state: «скоро» copy up, live copy and
  // the note down, copy buttons inert until something enables them.
  const shipsHidden = new Set(['refLiveLede', 'refLiveHint', 'refSoonNote']);
  const elements = Object.fromEntries(ids.map((id) => [id, {
    id,
    textContent: id === 'refCode' ? '·····' : '',
    hidden: shipsHidden.has(id),
    disabled: id.startsWith('refCopy'),
    classes: new Set(),
    attributes: {},
    classList: null,
    onclick: null,
    setAttribute(name, value) { this.attributes[name] = value; }
  }]));
  for (const element of Object.values(elements)) {
    element.classList = { add: (name) => element.classes.add(name) };
  }
  const timers = [];
  const copied = [];
  const network = [];
  const context = {
    Promise,
    REFERRALS_ENABLED: enabled,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    Date,
    navigator: { clipboard: { writeText: async (text) => { copied.push(text); } } },
    getMyReferralCode: async () => { network.push('code'); return CODE; },
    fetchReferralStatus: async () => { network.push('status'); return { ok: true }; },
    document: { getElementById: (id) => elements[id] }
  };
  vm.runInNewContext(
    `${referralUiSource}\nglobalThis.__card = { wireReferral, loadReferralUi };`,
    context,
    { filename: `settings-referral-card-${enabled ? 'live' : 'soon'}.js` }
  );
  return { context, elements, timers, copied, network };
}

{
  // Switched off: the card answers the click. A `disabled` button would say
  // nothing back to a student who came here looking for their invite code.
  const card = cardContext(false);
  card.context.__card.wireReferral();
  assert.equal(card.elements.refSoonNote.hidden, true, 'the note stays hidden until asked');

  for (const id of ['refCopyCode', 'refCopyInvite']) {
    const button = card.elements[id];
    assert.equal(button.disabled, false, `${id} must stay clickable`);
    assert.ok(button.classes.has('soon'), `${id} must not look ready`);
    assert.equal(button.attributes['aria-disabled'], 'true',
      `${id} must announce that it is not a live action`);
  }

  card.elements.refCopyCode.onclick();
  assert.equal(card.elements.refSoonNote.hidden, false, 'a click must reveal the coming-soon note');
  assert.equal(card.elements.refCopyCode.textContent, 'Скоро :)',
    'the answer must appear where the student pressed');
  card.timers.pop()();
  assert.equal(card.elements.refCopyCode.textContent, '',
    'the flash must restore the button label');

  card.elements.refCode.onclick();
  assert.equal(card.elements.refSoonNote.hidden, false,
    'the code placeholder answers the same way — it is the first thing anyone clicks');

  assert.deepEqual(card.copied, [], 'nothing may be copied: there is no code to copy');
  assert.deepEqual(card.network, [], 'wiring the inert card must not call the backend');
  assert.equal(card.elements.refSoon.hidden, false, 'the «Скоро» pill stays up');
  assert.equal(card.elements.refLiveLede.hidden, true);
}

{
  // Switched on: the same source restores the real card.
  const card = cardContext(true);
  card.context.__card.wireReferral();
  assert.equal(card.elements.refSoon.hidden, true, 'the «Скоро» pill comes down');
  assert.equal(card.elements.refSoonLede.hidden, true);
  assert.equal(card.elements.refLiveLede.hidden, false, 'the live promise is revealed');
  assert.equal(card.elements.refSoonHint.hidden, true);
  assert.equal(card.elements.refLiveHint.hidden, false);

  await card.elements.refCopyCode.onclick({ currentTarget: card.elements.refCopyCode });
  assert.deepEqual(card.copied, ['·····'], 'the live card copies the code again');

  await card.context.__card.loadReferralUi();
  assert.deepEqual(card.network, ['code', 'status'], 'the live card talks to the backend again');
}

console.log('referral coming-soon switch regression passed');

# СМЭШ AI — license backend

Cloudflare Worker that takes a YooKassa webhook, mints a license key, and
delivers it via email (Resend) and/or Telegram bot. The extension's `/verify`
endpoint sits here too.

Designed to scale to ~10k licenses before any of the free-tier limits start
to bite. Workers free tier: 100k requests/day. KV free tier: 100k reads,
1k writes per day, 1 GB storage.

## Stack

- **Cloudflare Workers** — HTTP server, ~5 ms cold start, free tier covers preorders.
- **Cloudflare KV** — license rows, keyed by license string + a parallel `payment:<id>` index for idempotency.
- **Resend** (optional) — transactional email for delivering keys.
- **Telegram Bot API** (optional) — DM delivery for buyers who shared their TG user_id.

The design lets you launch with either Resend OR Telegram. If both env vars
are set, both fire and the buyer gets the key in both places.

## Routes

| Route                    | Auth                                    | Purpose                                  |
|--------------------------|-----------------------------------------|------------------------------------------|
| `GET /verify`            | none (CORS open — rate-limit at the edge)| Extension calls this to validate a key. |
| `POST /webhook/yookassa` | YooKassa IP + basic auth + API confirm  | Auto-issue on `payment.succeeded`.       |
| `POST /webhook/yoomoney` | SHA-1 signature (`YOOMONEY_NOTIFICATION_SECRET`) | Auto-issue on wallet top-up.    |
| `POST /admin/issue`      | `X-Admin-Token` header                  | Manual issue (test keys, comp licenses). |
| `POST /admin/revoke`     | `X-Admin-Token` header                  | Mark a key revoked (refunds, fraud).     |
| `GET /admin/license`     | `X-Admin-Token` header                  | Inspect one license by key.              |
| `GET /health`            | none                                    | Liveness ping.                           |

## Setup (≈30 minutes)

### 1. Install Wrangler and log in

```sh
cd backend
npm install
npx wrangler login
```

### 2. Create the KV namespace

```sh
npx wrangler kv namespace create LICENSES
# → prints `id = "abcd1234..."`. Paste it into wrangler.toml under
#   [[kv_namespaces]].id, replacing REPLACE_ME_WITH_KV_NAMESPACE_ID.
```

### 3. Set secrets

```sh
# Required
npx wrangler secret put ADMIN_SECRET            # any long random string
npx wrangler secret put YOOKASSA_SECRET_KEY     # YooKassa → Настройки → Ключи API

# Strongly recommended (the IP allowlist is a single line of defense without it)
npx wrangler secret put YOOKASSA_WEBHOOK_USER
npx wrangler secret put YOOKASSA_WEBHOOK_PASS

# Pick at least one delivery channel
npx wrangler secret put RESEND_API_KEY          # re_xxx from resend.com/api-keys
npx wrangler secret put TELEGRAM_BOT_TOKEN      # from @BotFather

# Optional: dev-bypass key. Type this into your own extension Settings and
# the gate always passes for you without a real purchase.
npx wrangler secret put OWNER_LICENSE_KEY       # e.g. SMESH-OWNR-OWNR-OWNR
```

Also set `YOOKASSA_SHOP_ID` and `EMAIL_FROM` in `wrangler.toml` under `[vars]`
(these are not secret).

### 4. Deploy

```sh
npx wrangler deploy
```

Wrangler prints your worker URL (e.g. `https://smesh-licenses.<account>.workers.dev`).
Hit `GET /health` to confirm it's up. Then point a custom domain at it from
Cloudflare → Workers → Triggers → Custom Domains. The extension will call
`https://api.smesh.app/verify` (or whatever domain you pick — update
`BACKEND_URL` in `src/lib/config.js`).

### 5. Configure YooKassa

YooKassa dashboard → Settings → HTTP-уведомления:
- URL: `https://<your-worker-url>/webhook/yookassa`
- Events: at minimum `payment.succeeded`. Add `refund.succeeded` later.
- Basic auth (username + password) — set the same values you put in
  `YOOKASSA_WEBHOOK_USER` / `YOOKASSA_WEBHOOK_PASS`.

### 6. Build the order page

YooKassa's drop-in payment widget or hosted checkout works fine. The
**only non-obvious requirement** is that you MUST pass `metadata` when you
create the payment so the webhook knows where to deliver the key:

```js
// Server-side (your order page, NOT this worker)
const payment = await yookassa.createPayment({
  amount: { value: '990.00', currency: 'RUB' },
  capture: true,
  confirmation: { type: 'redirect', return_url: 'https://smesh.app/thanks' },
  description: 'СМЭШ AI — лицензия (предзаказ)',
  metadata: {
    email: buyerEmail,                    // collected on the order form
    telegram_user_id: buyerTgId || null   // if they connected Telegram first
  }
});
```

The webhook will refuse to issue if neither `email` nor `telegram_user_id`
is present — there'd be no way to deliver the key.

## Manual issue (e.g. for comp licenses or testing)

```sh
curl -X POST https://api.smesh.app/admin/issue \
  -H "X-Admin-Token: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "you@example.com",
    "type": "lifetime",
    "amount_rub": 0,
    "note": "founder",
    "deliver": false
  }'
```

The response includes the generated key. With `"deliver": false` no email/TG
fires — useful for seeding your own dev-bypass key.

## Verify a key

```sh
curl 'https://api.smesh.app/verify?key=SMESH-XXXX-XXXX-XXXX&device_id=test'
# → { "ok": true, "type": "lifetime", "expires_at": null }
```

## Support bot

Reuses the same `TELEGRAM_BOT_TOKEN`. The «Поддержка» buttons in the extension
(popup + settings) open `t.me/<bot>?start=support`. A user writes to the bot,
the worker forwards the ticket to you, and your replies relay back to the user.

Setup:

```sh
# 1. Your numeric Telegram id — message @userinfobot, it replies with your id.
npx wrangler secret put SUPPORT_CHAT_ID

# 2. Any long random string — authenticates Telegram's webhook calls.
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

npx wrangler deploy

# 3. Tell Telegram where to send updates (use the SAME secret as step 2).
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://api.smesh.app/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Then set `SUPPORT_BOT_URL` in `src/lib/config.js` to your bot's `@username`.
To answer a user, just **reply** to the ticket message in Telegram — the bot
relays your reply to them. `wrangler tail` shows webhook logs.

## YooMoney (wallet / Quickpay) — no business registration needed

YooKassa needs a registered business (ИП / ООО / самозанятый). If you're launching
as an individual, **YooMoney** takes payments to a personal wallet via a Quickpay
button. The worker handles both — pick whichever your account allows.

### 1. Register the notification endpoint

YooMoney → https://yoomoney.ru/transfer/myservices/http-notification
- **URL**: `https://<your-worker-url>/webhook/yoomoney`
- Copy the **secret** shown on that page → it's the SHA-1 signing key:

```sh
npx wrangler secret put YOOMONEY_NOTIFICATION_SECRET
```

There is **no IP allowlist** for YooMoney — the SHA-1 signature is the only
authenticity control, so the worker rejects any notification whose `sha1_hash`
doesn't recompute (`gateways/yoomoney.js`). A deploy with the secret unset
**fails closed** (every notification is rejected).

### 2. Build the Quickpay button (order page)

Point the form at `https://yoomoney.ru/quickpay/confirm.xml`. The one field that
matters for delivery is **`label`** — thread the buyer's contact through it:

```html
<form method="POST" action="https://yoomoney.ru/quickpay/confirm.xml">
  <input type="hidden" name="receiver"     value="<your wallet number>">
  <input type="hidden" name="quickpay-form" value="shop">
  <input type="hidden" name="targets"      value="СМЭШ AI — подписка">
  <input type="hidden" name="paymentType"  value="AC">
  <input type="hidden" name="sum"          value="199">
  <!-- label carries the delivery contact back to the webhook -->
  <input type="hidden" name="label"        value="buyer@example.com">
  <input type="hidden" name="successURL"   value="https://smeshai.xyz/thanks">
  <button type="submit">Оплатить</button>
</form>
```

`label` accepts either:
- a **bare email** — the worker delivers the key straight there, or
- an **order id** you generated and wrote to KV as `order:<id> = {"email":…,"telegram_user_id":…}`
  (short TTL) — use this when you want to keep the email out of the pay URL or
  attach a Telegram id.

### 3. Protected payments & fees

- The worker refuses to issue on `codepro`/`unaccepted` notifications (the payer
  can still cancel those) and on `test_notification` pings — it acks 200 without
  minting a key.
- `amount` in the notification is **after YooMoney's fee** (up to ~3% on card
  payments), so a buyer paying the exact sticker price arrives slightly below
  it. The worker grosses the net amount back up by `YOOMONEY_FEE_PCT` (default
  5%) before the floor and plan checks, so thresholds are set in **sticker
  prices**, not net amounts. The license record still stores the real net
  amount received.
- **Set `MIN_PAYMENT_RUB` before the pay page goes live.** The Quickpay form is
  just POST fields — anyone can copy it and resubmit with `sum=1` and their own
  email in `label`, and YooMoney signs that 1₽ notification like any real
  payment. The worker acks-without-issuing anything below the floor (it falls
  back to the lowest plan floor when unset; with nothing set there is **no**
  floor and every issuance logs a warning).

## Subscriptions (both gateways)

A subscription is just a license with a finite `expires_at`. Pricing lives in
`wrangler.toml` `[vars]` and maps the confirmed payment amount to a plan
(`planFromAmount` in `worker.js`):

```toml
SUBSCRIPTION_MIN_RUB = "199"   # >= this (and < lifetime) → 30-day subscription
LIFETIME_MIN_RUB     = "990"   # >= this → lifetime
SUBSCRIPTION_DAYS    = "30"
MIN_PAYMENT_RUB      = "199"   # hard floor — below this NOTHING issues
YOOMONEY_FEE_PCT     = "5"     # gross-up for YooMoney's net-of-fee amounts
```

Amounts below every configured floor do **not** issue anything (the worker acks
200 with `note: "amount_below_plan"`); they never fall back to lifetime.

The buyer's mental model is exactly the license flow: **pay → receive a code →
paste it into Settings**. When a subscription lapses, `/verify` returns
`{ ok:false, reason:'expired' }`, Settings shows «Срок действия ключа истёк»,
and the buyer renews by purchasing again and pasting the new code. No migration
was needed — `expires_at` was in the schema from day one.

**Recurring auto-charge** (charge the card every month without re-buying) is a
separate, larger piece: YooKassa supports it via saved payment methods; YooMoney
Quickpay does not. Until then, renewal = a fresh purchase + a fresh code, which
matches the "buy → get code → enter code" model.

## Swapping YooKassa for T-Pay

Replace one file: `src/gateways/yookassa.js` → `src/gateways/tpay.js`.
Implement the same three exports (`isTpayIp`, `checkAuth`, `parseNotification`).
Update one import in `src/worker.js`. ~30 minutes of work.

## Operational notes

- **Logs**: `npx wrangler tail` streams real-time logs from production.
- **Inspecting state**: `npx wrangler kv key list --binding LICENSES --remote`.
- **Backup**: `wrangler kv bulk get` once a week into a file in cold storage
  is enough — KV is durable, but a backup protects against your own admin mistakes.
- **Rotating secrets**: `wrangler secret put <NAME>` overwrites in place.

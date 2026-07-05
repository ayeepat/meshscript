# СМЭШ AI — license backend

Cloudflare Worker that accepts a Robokassa ResultURL notification, mints a
license key, and delivers it via email (Resend) and/or Telegram bot. The
extension's `/verify` endpoint sits here too.

Designed to scale to ~10k licenses before any of the free-tier limits start
to bite. Workers free tier: 100k requests/day. KV free tier: 100k reads,
1k writes per day, 1 GB storage.

## Stack

- **Cloudflare Workers** — HTTP server, ~5 ms cold start, free tier covers preorders.
- **Cloudflare KV** — license rows, keyed by license string + a parallel `payment:<gateway>:<id>` index for idempotency.
- **Robokassa** — hosted payment form + ResultURL callback.
- **Resend** (optional) — transactional email for delivering keys.
- **Telegram Bot API** (optional) — DM delivery for buyers who shared their TG user_id.

The design lets you launch with either Resend OR Telegram. If both env vars
are set, both fire and the buyer gets the key in both places.

## Routes

| Route                     | Auth                                      | Purpose                                  |
|---------------------------|-------------------------------------------|------------------------------------------|
| `GET /verify`             | none (CORS open — rate-limit at the edge) | Extension calls this to validate a key. |
| `POST /webhook/robokassa` | `SignatureValue` with password #2         | Auto-issue on a successful ResultURL.    |
| `GET /webhook/robokassa`  | same as POST                              | Accepted for dashboards configured as GET. |
| `POST /admin/issue`       | `X-Admin-Token` header                    | Manual issue (test keys, comp licenses). |
| `POST /admin/revoke`      | `X-Admin-Token` header                    | Mark a key revoked (refunds, fraud).     |
| `GET /admin/license`      | `X-Admin-Token` header                    | Inspect one license by key.              |
| `GET /health`             | none                                      | Liveness ping.                           |

## Setup

### 1. Install Wrangler and log in

```sh
cd backend
npm install
npx wrangler login
```

### 2. Create the KV namespace

```sh
npx wrangler kv namespace create LICENSES
# Paste the printed id into wrangler.toml under [[kv_namespaces]].id.
```

### 3. Set secrets

```sh
# Required
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put ROBOKASSA_PASSWORD2

# Pick at least one delivery channel
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN

# Optional: dev-bypass key. Type this into your own extension Settings and
# the gate always passes for you without a real purchase.
npx wrangler secret put OWNER_LICENSE_KEY
```

Also check `[vars]` in `wrangler.toml`:

```toml
ROBOKASSA_HASH_ALGO = "MD5"
ROBOKASSA_ENFORCE_IP_ALLOWLIST = "false"
EMAIL_FROM = "СМЭШ AI <license@smesh.app>"
```

`ROBOKASSA_HASH_ALGO` must match the algorithm selected in Robokassa technical
settings. `MD5` is Robokassa's default and is supported by the Worker.

### 4. Deploy

```sh
npx wrangler deploy
```

Wrangler prints your worker URL, for example
`https://smesh-licenses.<account>.workers.dev`. Hit `GET /health` to confirm
it's up. Then point a custom domain at it from Cloudflare → Workers → Triggers
→ Custom Domains. The extension will call `https://api.smesh.app/verify` (or
whatever domain you pick — update `BACKEND_URL` in `src/lib/config.js`).

### 5. Configure Robokassa

Robokassa dashboard → shop → technical settings:

- **ResultURL**: `https://<your-worker-url>/webhook/robokassa`
- **ResultURL method**: `POST` recommended. `GET` also works.
- **SuccessURL / FailURL**: your public thanks/fail pages.
- **Password #2**: store the same value in `ROBOKASSA_PASSWORD2`.
- **Hash algorithm**: keep `MD5` or set the same value in `ROBOKASSA_HASH_ALGO`.

The Worker verifies Robokassa's ResultURL signature as:

```text
OutSum:InvId:Password#2:Shp_key=value:Shp_other=value
```

When the signature is valid, the Worker returns the exact plain-text response
Robokassa expects: `OK{InvId}`.

Optional IP filtering can be enabled with:

```toml
ROBOKASSA_ENFORCE_IP_ALLOWLIST = "true"
```

The built-in allowlist is `185.59.216.65` and `185.59.217.65`, matching the
current Robokassa ResultURL documentation. Signature verification is always
required, even when IP filtering is disabled.

### 6. Build the order page

The pay page should create a unique numeric `InvId`, calculate `SignatureValue`
server-side with password #1, then submit the buyer to:

```text
https://auth.robokassa.ru/Merchant/Index.aspx
```

Minimal Node example for a server-rendered form:

```js
import { createHash } from 'node:crypto';

function md5(value) {
  return createHash('md5').update(value).digest('hex');
}

function signature({ merchantLogin, outSum, invId, password1, shp }) {
  const shpPairs = Object.keys(shp)
    .sort()
    .map((key) => `${key}=${shp[key]}`);
  return md5([merchantLogin, outSum, invId, password1, ...shpPairs].join(':'));
}

const shp = {
  Shp_email: buyerEmail
};
if (buyerTelegramId) shp.Shp_telegram_user_id = String(buyerTelegramId);

const fields = {
  MerchantLogin: process.env.ROBOKASSA_MERCHANT_LOGIN,
  OutSum: '199.00',
  InvId: String(orderId),
  Description: 'СМЭШ AI — подписка',
  Email: buyerEmail,
  Culture: 'ru',
  ...shp
};

fields.SignatureValue = signature({
  merchantLogin: fields.MerchantLogin,
  outSum: fields.OutSum,
  invId: fields.InvId,
  password1: process.env.ROBOKASSA_PASSWORD1,
  shp
});
```

The Worker resolves delivery contact in this order:

1. Signed `Shp_email` / `Shp_telegram_user_id` from the payment form.
2. KV record `order:<InvId>` containing `{ "email": "...", "telegram_user_id": ... }`.
3. Robokassa's `EMail` callback field as a fallback.

Prefer `Shp_*` or the KV order record because those are tied to the signed
invoice. The Worker acks valid payments without issuing if it cannot find an
email or Telegram user id.

## Manual Issue

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

## Verify A Key

```sh
curl 'https://api.smesh.app/verify?key=SMESH-XXXX-XXXX-XXXX&device_id=test'
# → { "ok": true, "type": "lifetime", "expires_at": null }
```

## Support Bot

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

# 3. Tell Telegram where to send updates.
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://api.smesh.app/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Then set `SUPPORT_BOT_URL` in `src/lib/config.js` to your bot's `@username`.
To answer a user, just **reply** to the ticket message in Telegram — the bot
relays your reply to them. `wrangler tail` shows webhook logs.

## Test Payments

Robokassa test mode uses a separate test password #1 and password #2 from the
shop's technical settings. For a test run:

1. Generate the payment form signature with the test password #1.
2. Add `IsTest=1` to the form.
3. Put the test password #2 into the Worker secret `ROBOKASSA_PASSWORD2`.
4. Complete a test payment and confirm the ResultURL response is `OK{InvId}`.

For production, rotate `ROBOKASSA_PASSWORD2` back to the production password #2
before accepting real payments.

## Subscriptions

A subscription is just a license with a finite `expires_at`. Pricing lives in
`wrangler.toml` `[vars]` and maps the signed payment amount to a plan
(`planFromAmount` in `worker.js`):

```toml
SUBSCRIPTION_MIN_RUB = "199"   # >= this and < lifetime → 30-day subscription
LIFETIME_MIN_RUB     = "990"   # >= this → lifetime
SUBSCRIPTION_DAYS    = "30"
MIN_PAYMENT_RUB      = "199"   # hard floor — below this nothing issues
```

Amounts below every configured floor do **not** issue anything (the Worker still
returns `OK{InvId}` to Robokassa); they never fall back to lifetime.

The buyer's mental model is exactly the license flow: **pay → receive a code →
paste it into Settings**. When a subscription lapses, `/verify` returns
`{ ok:false, reason:'expired' }`, Settings shows «Срок действия ключа истёк»,
and the buyer renews by purchasing again and pasting the new code.

## Operational Notes

- **Logs**: `npx wrangler tail` streams real-time logs from production.
- **Inspecting state**: `npx wrangler kv key list --binding LICENSES --remote`.
- **Backup**: `wrangler kv bulk get` once a week into a file in cold storage
  is enough — KV is durable, but a backup protects against admin mistakes.
- **Rotating secrets**: `wrangler secret put <NAME>` overwrites in place.

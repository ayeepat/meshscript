# смэш — license backend

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

| Route                    | Auth                       | Purpose                                  |
|--------------------------|----------------------------|------------------------------------------|
| `GET /verify`            | none (CORS open)           | Extension calls this to validate a key. |
| `POST /webhook/yookassa` | YooKassa IP + basic auth   | Auto-issue on `payment.succeeded`.       |
| `POST /admin/issue`      | `X-Admin-Token` header     | Manual issue (test keys, comp licenses). |
| `POST /admin/revoke`     | `X-Admin-Token` header     | Mark a key revoked (refunds, fraud).     |
| `GET /admin/license`     | `X-Admin-Token` header     | Inspect one license by key.              |
| `GET /health`            | none                       | Liveness ping.                           |

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
  description: 'смэш — лицензия (предзаказ)',
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

## When subscriptions launch (Tier B)

Three changes, no migration:

1. `issueLicense({ type: 'subscription', expires_at: '<30d from now>' })`.
2. Add a recurring-charge webhook handler that extends `expires_at` by 30 days.
3. The extension already handles `expires_at` correctly — verifying returns
   `{ ok: false, reason: 'expired' }` when the window closes.

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

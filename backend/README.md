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
| `POST /verify`            | key on first activation; activation bearer thereafter | Activate or verify the one authorized installation. |
| `POST /deactivate`        | key + device id + activation bearer         | Explicitly release device number 1 for another device. |
| `POST /ai/chat`           | disabled by default (`410 Gone`)            | Retired Worker proxy; production AI goes through the VPS. |
| `POST /checkout/session`  | none (CORS open; per-IP budget)     | Freeze a plan/promo and return a short-lived Telegram capability. |
| `POST /checkout/status`   | checkout capability                     | Poll Telegram, payment, fulfillment and delivery state without exposing PII/key. |
| `POST /checkout/payment`  | checkout capability + verified Telegram binding | Freeze email/consent and return signed hosted-payment fields. |
| `POST /payments/robokassa/order` | legacy; disabled in production | Former direct order route; it must not bypass Telegram ownership binding. |
| `POST /webhook/robokassa` | `SignatureValue` with password #2         | Auto-issue on a successful ResultURL.    |
| `GET /webhook/robokassa`  | same as POST                              | Accepted for dashboards configured as GET. |
| `POST /referral/code`     | 256-bit install capability + per-IP budget | Get/create an install's invite code.    |
| `GET /referral/check`     | none                                      | Validate a code at checkout (before charging). |
| `POST /referral/status`   | 256-bit install capability                | Referral stats + reward key.             |
| `POST /t/delete`          | deletion-only erasure capability          | Delete the authenticated installation's analytics rows. |
| `GET /admin/stats/*`      | `X-Stats-Token`; exact dashboard origin   | Read-only owner analytics.               |
| `GET /admin/health`       | `X-Admin-Token` header; CLI/server only   | Readiness: bindings, schema, payment config, operator worklists. |
| `POST /admin/issue`       | `X-Admin-Token` header; CLI/server only   | Manual issue (test keys, comp licenses). |
| `POST /admin/revoke`      | `X-Admin-Token` header; CLI/server only   | Mark a key revoked (refunds, fraud).     |
| `POST /admin/payment/reconcile` | `X-Admin-Token` header; CLI/server only | Query OpStateExt and recover a missed production callback. |
| `POST /admin/payment/refund` | `X-Admin-Token` header; CLI/server only | Start one confirmed full refund; cron revokes after provider completion. |
| `POST /admin/payment-review/resolve` | `X-Admin-Token` header; CLI/server only | Close a reviewed payment with a durable resolution and note. |
| `GET /admin/license`      | `X-Admin-Token` header; CLI/server only   | Inspect one license by key.              |
| `GET /admin/referral`     | `X-Admin-Token` header; CLI/server only   | Inspect a referral by code or device id. |
| `POST /admin/referral/retry-pending` | `X-Admin-Token` header; CLI/server only | Recover bounded pending or unmaterialized referral credits. |
| `GET /health`             | none                                      | Liveness ping.                           |

### AI proxy authority

Production Qwen/DeepSeek traffic has one authority: the polling service in
`backend-vps/`. The duplicate Worker `POST /ai/chat` route is retired and
returns `410 Gone` while `AI_PROXY_LEGACY_ENABLED=false`. If an emergency
rollback explicitly enables it, requests still require the one-device
`activation_token`; a license key and public device id alone are insufficient.
Keep the provider account on prepaid credit as a final spend ceiling.

Applied migrations are also required for telemetry ingestion: its
`telemetry_budget` table provides atomic per-IP and per-device abuse limits.
`/t` additionally requires the short-lived HMAC capability returned by a
successful `/verify`, bound to that exact device id; anonymous callers cannot
manufacture users. Browser-reported token/cost values are discarded, while
provider-observed usage arrives through the separately `INGEST_KEY`-gated
`/t/ai` path. Without the D1 table `/t` deliberately fails instead of falling
back to the old raceable KV counter.

`POST /verify` uses the same table for an enforced per-IP budget of 200
anonymous `not_found` lookups per Moscow day. It reserves a slot before the KV
read, then atomically refunds recognized keys (active, expired, revoked or at
the device cap) and backend outages. Once an IP has accumulated the full 200
misses, every later guess — even one that happens to be correct — is rejected
before KV until the daily window resets. That deliberate fail-closed behavior
both caps storage work and removes the valid-key oracle; investigate a shared
VPS egress that reaches it instead of weakening the limit. An edge rule may
still be added as defense in depth.

### Referral program

Full mechanics live in `src/referrals.js` (see its header comment). Short
version: every device mints one invite code (`REF-XXXX-XXXX`), shown in the
extension's Settings. Rewards are payment-gated and the authoritative D1
journal caps each referral code at **30 earned days total**; client state
cannot raise or reset that ceiling:

The device UUID only locates a referral record. Code creation, license-pointer
updates, status, and reward-key disclosure also require a separate random
256-bit `referral_auth` capability kept in the extension's trusted local
storage; the backend stores only its SHA-256 digest. Legacy valuable referral
rows without cryptographic auth fail closed unless the client can prove an
already-recorded active license is already bound to that device.

- The buyer types a friend's code into the pay page at checkout.
- On the confirmed Robokassa payment, the **referrer** earns
  `REFERRAL_PAID_DAYS` (7) subscription days, and the **buyer's own** new
  subscription is extended by `REFERRAL_BUYER_BONUS_PCT` (10%) — a 30-day plan
  becomes 33 days (subscriptions only; lifetime can't be extended).
- One payout per purchased license key, ever (idempotent across webhook
  retries). Referrer days land on their own registered subscription key if
  they have one, otherwise on an auto-minted reward license (gateway
  `referral`) whose key Settings shows them.
- Refund or fraud revocation cancels a pending reward or subtracts an already
  applied reward exactly once, then rebuilds the public counters from D1.

**Checkout integration (site side, `meshsitereal`).** The pay page calls
`POST /checkout/session` with `{ plan: "month"|"school", promo_code? }`.
The Worker freezes the exact kopecks, duration, currency, environment and
receipt in D1 and returns a short-lived browser HMAC capability plus a
separate, purpose-bound `t.me/smeshaibot?start=pay_<telegram-capability>`.
Telegram's authenticated private
`/start` update binds its trusted numeric `from.id`; the browser never asks for
or accepts a Telegram username/id. The page polls `POST /checkout/status` and,
after binding, calls `POST /checkout/payment` with the capability, email and
explicit terms acceptance. That final call returns the Robokassa URL plus
signed form fields. The browser submits the fields unchanged; it never chooses
`OutSum`, signs a payment, or treats the browser return as proof. Direct/static
Robokassa links are not an authorized checkout path.

The capability MAC uses a dedicated 32+ character
`CHECKOUT_CAPABILITY_SECRET`, stored only in the Worker. It is deliberately
separate from `INGEST_KEY`, which is shared with the VPS. No checkout signing
key is stored in D1, returned to the browser, or committed to the repository.
Browser and Telegram capabilities use distinct domains, so neither token is
accepted at the other channel's authoritative endpoint.

- The payment response includes integrity-bound `Shp_environment` and `Shp_order_id`.
  The ResultURL handler requires both and an exact D1 order match before it can
  mint anything.
- Test checkout uses a separate Worker, D1 database and test credentials. The
  production Worker always creates production orders.
- Before charging, the page can call `GET /referral/check?code=REF-…` →
  `{ valid, buyer_bonus_pct }` to show "code valid — you'll get +10%".

Invalid, self-referred, or absent codes are ignored silently — a real payment
never fails over a referral.

## Setup

### 1. Install Wrangler and log in

Cloudflare account email for this deployment: `ermd20199@gmail.com`.
This is an account-recovery/operator note, not a secret; never record the
account password, API tokens, or recovery codes in the repository.

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
# A distinct read-only secret for the owner analytics dashboard (>=32 bytes).
npx wrangler secret put STATS_SECRET
npx wrangler secret put ROBOKASSA_PASSWORD1_PRODUCTION
npx wrangler secret put ROBOKASSA_PASSWORD2_PRODUCTION
npx wrangler secret put ROBOKASSA_PASSWORD3_PRODUCTION

# Pick at least one delivery channel
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN

# Required for authenticated Telegram support and checkout identity binding.
# Use 32+ random characters from A-Z, a-z, 0-9, _ and -.
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# Optional: dev-bypass key. Type this into your own extension Settings and
# the gate always passes for you without a real purchase.
npx wrangler secret put OWNER_LICENSE_KEY

# Optional only when intentionally enabling the retired Worker AI route.
npx wrangler secret put AI_PROXY_API_KEY

# At least 32 random bytes. Signs /verify telemetry capabilities and also
# authenticates the VPS provider-observed /t/ai feed.
npx wrangler secret put INGEST_KEY

# At least 32 random bytes and Worker-only. Signs browser/Telegram checkout
# capabilities; never copy it to the site, extension, VPS or Telegram.
npx wrangler secret put CHECKOUT_CAPABILITY_SECRET
```

Also check `[vars]` in `wrangler.toml`:

```toml
ROBOKASSA_MERCHANT_LOGIN = "<exact MerchantLogin from Robokassa>"
ROBOKASSA_HASH_ALGO = "SHA256"
PAYMENT_ENVIRONMENT = "production"
ROBOKASSA_OUT_CURRENCY_LABEL = "RUB"
ROBOKASSA_REFUND_HASH_ALGO = "HS256"
ROBOKASSA_FISCALIZATION_MODE = "provider"
ROBOKASSA_RECEIPT_TAX = "none"
ROBOKASSA_RECEIPT_PAYMENT_METHOD = "full_payment"
ROBOKASSA_RECEIPT_PAYMENT_OBJECT = "service"
SUBSCRIPTION_PRICE_RUB = "149"
LIFETIME_PRICE_RUB = "0"
MONTHLY_PRICE_RUB = "149"
MONTHLY_DAYS = "30"
SCHOOL_YEAR_PRICE_RUB = "999"
SCHOOL_YEAR_DAYS = "273"
CHECKOUT_PROMO_MONTH_PRICE_RUB = "10"
CHECKOUT_TELEGRAM_BOT_USERNAME = "smeshaibot"
ROBOKASSA_SUCCESS_URL2 = "https://smeshai.xyz/checkout/success/"
ROBOKASSA_FAIL_URL2 = "https://smeshai.xyz/checkout/"
LEGACY_PAYMENT_ORDER_ENABLED = "false"
ROBOKASSA_ENFORCE_IP_ALLOWLIST = "true"
DEVICE_LIMIT = "1"
AI_PROXY_LEGACY_ENABLED = "false"
EMAIL_FROM = "СМЭШ AI <license@smesh.app>"
```

Keep the optional promo code out of tracked configuration and set it as a
Worker secret only while it should be accepted:

```bash
npx wrangler secret put CHECKOUT_PROMO_CODE
```

`ROBOKASSA_HASH_ALGO` must match the algorithm selected in Robokassa technical
settings. Production is configured for `SHA256`; select the same algorithm in
the Robokassa cabinet before deployment. The ResultURL IP allowlist remains
enabled in addition to mandatory signature verification.

Configure the authoritative standard ResultURL in the Robokassa cabinet as
`https://smeshapi.site/webhook/robokassa` with method `POST`. The
Worker deliberately does not send `ResultUrl2`: that option uses Robokassa's
separate JWS notification format, while `/webhook/robokassa` verifies the
classic Password #2 `SignatureValue`. Success and failure redirects are owned
by the Robokassa cabinet. Checkout does not send the optional `SuccessUrl2`,
`FailUrl2`, or `Shp_*` modifiers; its Password #1 signature is the documented
minimal receipt form `MerchantLogin:OutSum:InvId:Receipt:Password#1`. The
signed invoice and amount are then matched to the authoritative D1 order.

`ROBOKASSA_MERCHANT_LOGIN` is required and must exactly match the shop's
MerchantLogin. It is not a password, but this repository deliberately does not
guess it; keep the verified value as a Cloudflare dashboard variable (preserved
by `keep_vars = true`) or add the exact value to the deployment configuration.

The four fiscalization values above are examples, not tax advice. Before
launch, have the merchant's accountant select the real tax, payment-method and
payment-object codes. With `ROBOKASSA_FISCALIZATION_MODE=provider`, checkout
freezes a compact receipt JSON on the order, URL-encodes and signs it exactly as
Robokassa requires, and reuses the frozen item for a refund receipt. Optional
`ROBOKASSA_RECEIPT_SNO` overrides the tax system configured in the Robokassa
cabinet.

If receipts are legally and operationally issued outside Robokassa, set
`ROBOKASSA_FISCALIZATION_MODE=external` only after confirming that path with the
accountant and provider. For that mode, the explicit
`ROBOKASSA_REFUND_ALLOW_MONEY_ONLY=true` override permits a money-only provider
refund. Readiness stays red until one complete path is selected, rather than
silently launching with no receipt decision.

### 4. Deploy

```sh
npx wrangler d1 migrations apply smesh-analytics --remote
npx wrangler deploy --keep-vars --var RUNTIME_WRITE_EPOCH:1
```

Apply migrations first, including `0010_single_device_activation.sql`. Paid
issuance, one-device activation and referral rewards deliberately fail closed
unless their atomic D1 registries exist.

`RUNTIME_WRITE_EPOCH` is a required, dashboard-managed non-secret variable.
The first deploy uses `1`, matching migration `0005_runtime_write_fence.sql`.
Do not pin it in `wrangler.toml`: the backup protocol rotates it, and
`keep_vars = true` preserves the current value on later ordinary deploys.
Every D1/KV mutation fails closed if the variable is absent, stale, or the
durable row is disabled; `/admin/health` exposes the exact mismatch.

Deployed databases evolve only through `migrations/` — `schema.sql` is the
full-schema snapshot for fresh/local databases and must be edited in the same
commit as any new migration (the schema-migration-parity regression enforces
the mirror). Reapplying `schema.sql` to an existing database is NOT a
migration: `CREATE TABLE IF NOT EXISTS` silently keeps an old table's shape.

#### One-time adoption for a database already at `schema.sql`

There are two mutually exclusive upgrade paths:

- A new/old production database with the pre-`0003` outbox and referral table
  shapes uses the normal `d1 migrations apply` command above.
- A live database that was already created from the **current** `schema.sql`
  snapshot, but whose `d1_migrations` ledger is absent or incomplete, must be
  adopted. Do not let `0003` rebuild that current shape: its old-column copy
  would discard live claim leases and referral retry/generation fields.

First inspect whether `runtime_write_fence` exists. Do **not** run ordinary
migrations against an already-current unledgered database: `0003` correctly
rejects that source shape.

If the fence table and fence-aware Worker already exist, follow the
[maintenance-gated two-store backup procedure](#backup-consistent-two-store-snapshot)
through artifact validation, keep maintenance enabled, and run adoption under
that gate.

For the immediately preceding exact `0001`..`0004` current snapshot, the fence
does not exist yet, so that backup protocol cannot be the bootstrap. Run the
adoption file directly from a clean checkout **before** any normal migration
command. The one remote-file ingestion atomically creates/seeds only the
additive `runtime_write_fence` table, verifies the entire pre-existing schema,
and records the proven ledger; any guard failure rolls the new table and ledger
back together, and no application row is rewritten. Then deploy the
fence-aware Worker with epoch `1` and require green admin readiness:

```sh
npx wrangler d1 execute smesh-analytics --remote --file=scripts/adopt-current-schema.sql --yes
npx wrangler d1 migrations list smesh-analytics --remote
npx wrangler d1 migrations apply smesh-analytics --remote
npx wrangler deploy --keep-vars --var RUNTIME_WRITE_EPOCH:1
curl -i -H "X-Admin-Token: $ADMIN_TOKEN" https://smeshapi.site/admin/health
```

Use `--file`, not copied individual statements: remote D1 file ingestion is
atomic and restores the original database if a guard fails. The adoption file
verifies every current column signature plus the complete canonical
`sqlite_master` DDL, the exact named-index set (including uniqueness, origin,
partialness, expressions and ordered columns), and the known non-NULL ledger
before one all-or-nothing ledger insert; it never rewrites application rows.
It accepts both exact `sqlite_master` products: comment-preserving direct
SQLite loads and the comment-free statements produced by the pinned
Wrangler/D1 ingestion path. Only SQLite's `sqlite_*` internals and the exact
D1-owned `_cf_KV` / `_cf_METADATA` table shapes are exempt—an arbitrary or
malformed `_cf_*` object is rejected. CI runs adoption through Wrangler's real
local D1 runtime in addition to Node's SQLite probes. The script accepts the
exact pre-fence current snapshot, a contiguous compatible prefix ledger, and
idempotent reruns. A pre-existing fence table must already contain its valid
singleton authority row; adoption never hides a partial `0005` by repairing it.
An old, partial, or future/unknown shape fails with
`smesh_adoption_requires_exact_current_schema`. If that happens, stop: the
database was not adopted and must be inspected/repaired before deployment.
`0003_operational_leases.sql` has its own pre-shape guard as a second safety
net, so accidentally applying it to a current/partial table aborts before DDL.
If adoption ran under an existing maintenance gate, only after its checks
succeed should you perform the backup procedure's maintenance-off steps. If it
bootstrapped the pre-fence snapshot, the first green fence-aware deployment is
what makes every later cross-store backup protocol enforceable.

After deploy, run the existing authenticated `POST /admin/backfill-licenses`
once. In addition to refreshing the purchase mirror it now purges legacy raw
user-agent/license telemetry and any old `license_ref` pseudonyms, and seeds
the `kv_materializations` write-once flags for every existing license and
referral record (so webhook replays can never rewrite a pre-migration row's
issue-time snapshot); it works whether or not that optional legacy column
exists.

The `[triggers]` cron in `wrangler.toml` is part of the payment path: it
re-drives failed key deliveries (`delivery_outbox`) and stranded referral
credits/reversals every five minutes. Before expiring or pruning a pending
production order, it queries Robokassa and fulfills a confirmed missed callback
through the same idempotent settlement path. It also enforces analytics lifecycle: abuse/quota
identifiers expire after seven days, and pseudonymous event/inactive-device
rows expire after `ANALYTICS_RETENTION_DAYS` (90 by default, clamped to
30–365). Rows that exhaust their delivery attempts stay in
`delivery_outbox` with `delivered_at IS NULL` — that is the "buyer paid but
never got the key" worklist; check it if a buyer reports a missing key.

Dashboard note: every `GET /admin/stats/*` request uses `X-Stats-Token` backed
by the distinct `STATS_SECRET`; the browser never receives `ADMIN_SECRET`.
`GET /admin/stats/retention` and `/admin/stats/referrals`
return `truncated: true` when their hard scan bounds were hit (100k event
rows / 5000 KV records). The owner dashboard must render a "partial data"
warning when the flag is set — the totals are floors, not exact values.
`GET /admin/stats/purchases` is a real paginated list:
`?days=N&limit=1..500`; follow the opaque `next_cursor` as `cursor=...` while
`has_more` is true. `offset`/`next_offset` remain bounded compatibility fields
for older dashboards; invalid or oversized offsets are rejected rather than
silently clamped onto a repeated page.

Wrangler prints your worker URL, for example
`https://smesh-licenses.<account>.workers.dev`. Hit `GET /health` to confirm
it's up. The production custom domain is bound from Cloudflare → Workers →
Triggers → Custom Domains as `https://smeshapi.site`. The extension calls
`https://smeshapi.site/verify` via `BACKEND_URL` in `src/lib/config.js`.

### 5. Configure Robokassa

Robokassa dashboard → shop → technical settings:

- **ResultURL**: `https://<your-worker-url>/webhook/robokassa`
- **ResultURL method**: `POST` recommended. `GET` also works.
- **SuccessURL**: `https://smeshai.xyz/checkout/success/` (GET).
- **FailURL**: `https://smeshai.xyz/checkout/` (GET).
- **Production Password #1/#2/#3**: store them only in the corresponding
  `ROBOKASSA_PASSWORD{1,2,3}_PRODUCTION` secrets.
- **Hash algorithm**: select `SHA256`, matching `ROBOKASSA_HASH_ALGO`.

The Worker verifies Robokassa's ResultURL signature as:

```text
OutSum:InvId:Password#2:Shp_key=value:Shp_other=value
```

When the signature is valid, the Worker returns the exact plain-text response
Robokassa expects: `OK{InvId}`.

Robokassa may spell production `OutSum` values with six fractional digits
(`199.000000`), while test callbacks commonly use two. The Worker accepts both
forms but rejects non-zero sub-kopeck digits because licenses and plan floors
are accounted in whole kopecks.

Optional IP filtering can be enabled with:

```toml
ROBOKASSA_ENFORCE_IP_ALLOWLIST = "true"
```

The built-in allowlist is `185.59.216.65` and `185.59.217.65`, matching the
current Robokassa ResultURL documentation. Signature verification is always
required, even when IP filtering is disabled.

### 6. Build the checkout page

The pay page first creates a server-priced checkout and sends the user through
the bot deep link. Only after `/checkout/status` reports `telegram_bound` does
it request provider fields. It sends product intent, email and consent, never a
Telegram id, `InvId`, `OutSum` or gateway password:

```js
const session = await fetch('https://smeshapi.site/checkout/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ plan: 'month', promo_code: promoCode || undefined })
}).then((response) => response.json());

// User opens session.telegram_url; the authenticated bot binds Telegram's
// private from.id. Poll /checkout/status with { token: session.token }.
const order = await fetch('https://smeshapi.site/checkout/payment', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: session.token,
    email: buyerEmail,
    accepted_terms: true
  })
}).then((response) => response.json());

const form = document.createElement('form');
form.method = 'POST';
form.action = order.payment_url;
for (const [name, value] of Object.entries(order.fields)) {
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = name;
  input.value = value;
  form.append(input);
}
document.body.append(form);
form.submit();
```

Submit the returned `fields` unchanged. D1 is the only current order authority;
the callback's signed amount must equal its integer `amount_kopecks`, and its
environment/order custom fields must match. Unknown callbacks are journaled but
cannot mint. Historical `payment_issuance` rows without an order remain
replayable only because they already freeze one immutable winner.

## Manual Issue

Admin routes intentionally reject browser requests. Keep `ADMIN_SECRET` only
in a local shell environment or a server-side secret store; never place it in
a static dashboard, extension, browser storage, URL, or client-side code.

```sh
curl -X POST https://smeshapi.site/admin/issue \
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

The first device receives a random `activation_token`. Store it as a bearer
secret and send it on every later verify/proxy/deactivate request. A competing
installation receives `device_in_use` and the user-facing instruction to sign
out of device number 1; knowing the license key does not transfer the slot.

```sh
curl -X POST 'https://smeshapi.site/verify' \
  -H 'Content-Type: application/json' \
  -d '{"key":"SMESH-XXXX-XXXX-XXXX","device_id":"123e4567-e89b-42d3-a456-426614174000"}'
# → { "ok": true, ..., "activation_token": "<43-character bearer>" }

curl -X POST 'https://smeshapi.site/deactivate' \
  -H 'Content-Type: application/json' \
  -d '{"key":"SMESH-XXXX-XXXX-XXXX","device_id":"123e4567-e89b-42d3-a456-426614174000","activation_token":"<bearer>"}'
# → { "ok": true, "deactivated": true }
```

Deactivation is the only supported transfer path. It releases the active slot
but retains the historical activation ledger for audit and referral integrity.

## Support Bot

Reuses the same `TELEGRAM_BOT_TOKEN`. The «Поддержка» buttons in the extension
(popup + settings) open `t.me/<bot>?start=support`. A user writes to the bot,
the worker forwards the ticket to you, and your replies relay back to the user.

Setup:

```sh
# 1. Your numeric Telegram id — message @userinfobot, it replies with your id.
npx wrangler secret put SUPPORT_CHAT_ID

# 2. A 32+ character random string using A-Z, a-z, 0-9, _ or - — authenticates
# Telegram's webhook calls and therefore its trusted checkout identity.
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

npx wrangler deploy

# 3. Tell Telegram where to send updates. ADMIN_SECRET is a separate Worker
# secret; read it silently and pass it as a header so neither credential enters
# a URL or shell history.
read -s ADMIN_TOKEN
curl -fsS -X POST \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  https://smeshapi.site/telegram/setup
```

The webhook fails closed with HTTP 503 when `TELEGRAM_WEBHOOK_SECRET` is
missing, weak or outside Telegram's allowed alphabet; bad configuration never
disables authentication. Telegram operator helpers use `ADMIN_SECRET` through
`X-Admin-Token`, never the webhook credential:

```sh
curl -fsS -H "X-Admin-Token: $ADMIN_TOKEN" https://smeshapi.site/telegram/info
curl -fsS -X POST -H "X-Admin-Token: $ADMIN_TOKEN" \
  "https://smeshapi.site/telegram/test?chat=<CHAT_ID>"
curl -fsS -H "X-Admin-Token: $ADMIN_TOKEN" https://smeshapi.site/telegram/debug
unset ADMIN_TOKEN
```

Then set `SUPPORT_BOT_URL` in `src/lib/config.js` to your bot's `@username`.
To answer a user, just **reply** to the ticket message in Telegram — the bot
relays your reply to them. `wrangler tail` shows webhook logs.

## Test Payments

Robokassa test mode uses a separate test password #1 and password #2 from the
shop's technical settings. Never swap either test password into the production
Worker: a test callback is not real revenue, and ResultURL does not carry a
trusted `IsTest` field.

Create a separate test Worker with its own D1 database and KV namespace. Set
`PAYMENT_ENVIRONMENT=test`, `ROBOKASSA_PASSWORD1_TEST` and
`ROBOKASSA_PASSWORD2_TEST` there. Its order endpoint adds `IsTest=1` and stores
orders as `environment='test'`; the callback must match that environment. Keep
the production deployment, database and `*_PRODUCTION` secrets unchanged.

For a sandbox run, call the test Worker's order endpoint, submit exactly the
returned fields, complete the test payment, and confirm `OK{InvId}`, one
`payment_orders.status='fulfilled'` row and one `payment_issuance` row. Do not
reuse a test `InvId` in production.

## Subscriptions

A subscription is a license with a finite `expires_at`. The order endpoint owns
the catalog and freezes one exact price in integer kopecks before redirecting:

```toml
MONTHLY_PRICE_RUB       = "149"
MONTHLY_DAYS            = "30"
SCHOOL_YEAR_PRICE_RUB   = "999"
SCHOOL_YEAR_DAYS        = "273"
```

Prices use canonical positive RUB decimals with at most two fractional digits.
Whitespace, exponent notation, sub-kopeck fractions and values outside the safe
integer-kopeck range make readiness fail. A callback must equal the frozen
`amount_kopecks` exactly; no threshold or client-selected amount can choose a
different product.
`SUBSCRIPTION_DAYS` likewise accepts only a canonical whole number from 1 to
3650; exponent and whitespace coercions fail readiness instead of silently
changing the entitlement duration.

The buyer's mental model is exactly the license flow: **pay → receive a code →
paste it into Settings**. When a subscription lapses, `/verify` returns
`{ ok:false, reason:'expired' }`, Settings shows «Срок действия ключа истёк»,
and the buyer renews by purchasing again and pasting the new code.

## Operational Notes

- **Logs**: `npx wrangler tail` streams real-time logs from production.
- **Inspecting state**: `npx wrangler kv key list --binding LICENSES --remote`.
- **Monitoring**: point the uptime checker at `GET /admin/health` with the
  `X-Admin-Token` header — it answers 503 whenever a dependency of the paid
  paths is broken (KV/D1 bindings, exact complete schema/index DDL,
  runtime write-fence epoch, order catalog, environment-specific Robokassa
  passwords, refund configuration, delivery channel, distinct admin/stats
  secrets, telemetry signing key, and the legacy AI key only if that route is
  enabled) and reports the operator worklists (exhausted deliveries,
  unresolved paid-but-unissued payments and ambiguous refund submissions).
  The public `/health` is liveness only and deliberately checks nothing.
- **Rotating secrets**: `wrangler secret put <NAME>` overwrites in place.

### Payment review, reconciliation and refunds

`payment_review` is a worklist, not a log you ignore. Investigate each open row
against the Robokassa cabinet, then close it with
`POST /admin/payment-review/resolve` and a required resolution plus note. The
Worker writes `resolved_at`; readiness reports rows still open.

Cron automatically checks due pending production orders before expiry and
before contact-data pruning. For immediate/operator recovery of a missing
callback, call `POST /admin/payment/reconcile` with `{ "order_id": "…" }`.
The Worker queries OpStateExt using production
Password#2 and requires success state `100`, the configured merchant currency
and exact frozen kopecks before recovering fulfillment. Test payments cannot be
queried through OpStateExt.

To refund a fulfilled production order, first confirm the fiscal configuration,
then call `POST /admin/payment/refund` with `{ "order_id": "…", "reason":
"…", "confirm_full_refund": true }`. Only full refunds are automated. The
request is durably reserved before the provider call, never automatically
resubmitted after an ambiguous network failure, and cron polls the returned
request id. The license and any still-pending referral payout are revoked only
after Robokassa reports `finished`. `refund_submission_unknown` in readiness
requires cabinet reconciliation; do not send another refund blindly.

### Backup: consistent two-store snapshot

Back up **both** stores weekly into encrypted cold storage. KV alone is not a
complete backup: D1 authoritatively owns payment idempotency
(`payment_issuance`), device-cap slots (`license_devices`), revocations,
referral journals, delivery/support outboxes, and the paid-but-unissued review
queue. Conversely, support ticket bodies and the live license projections exist
in KV. A sequential live export can therefore produce an unrecoverable split
(for example, a D1 support-outbox row whose `ticket:<no>` KV body is absent).

Run the following from `backend/` during a low-traffic maintenance window.
Both gate changes re-upload the Worker, so use a clean checkout of the exact
commit already serving production; never let a backup deploy unrelated local
changes. Abort if this prints anything:

```sh
git status --porcelain --untracked-files=normal
```

1. Read `ADMIN_SECRET` without putting it in shell history. Before changing
   anything, `GET /admin/health` must be HTTP 200 with
   `checks.backup_maintenance: true`, `checks.write_fence: true`, and
   `write_fence.writes_enabled: 1`:

   ```sh
   read -s ADMIN_TOKEN
   curl -i -H "X-Admin-Token: $ADMIN_TOKEN" https://smeshapi.site/admin/health
   ```

2. Atomically close the durable D1 fence **and rotate its epoch first**. This
   revokes every old deployment at its next actual D1/KV mutation, even if an
   invocation is still waiting on an arbitrarily slow request body. Record the
   returned `write_epoch`, enter it as `NEXT_EPOCH`, and validate it as digits:

   ```sh
   npx wrangler d1 execute smesh-analytics --remote --json --command \
     "UPDATE runtime_write_fence SET write_epoch = write_epoch + 1, writes_enabled = 0, updated_at = unixepoch('subsec') * 1000 WHERE singleton = 1 AND writes_enabled = 1 RETURNING write_epoch, writes_enabled"
   read -r NEXT_EPOCH
   case "$NEXT_EPOCH" in (''|*[!0-9]*) echo "invalid epoch" >&2; exit 1;; esac
   ```

   The update must return exactly one row with `writes_enabled: 0`. If it does
   not, stop; do not deploy and do not export.

3. Deploy maintenance to **100% of traffic immediately**, using that exact new
   epoch. Do not use a Versions gradual rollout or traffic split. Confirm in
   Cloudflare that the new deployment owns 100% before continuing:

   ```sh
   npx wrangler deploy --keep-vars --var BACKUP_MAINTENANCE:true \
     --var RUNTIME_WRITE_EPOCH:"$NEXT_EPOCH"
   curl -i -H "X-Admin-Token: $ADMIN_TOKEN" https://smeshapi.site/admin/health
   ```

   `--keep-vars` is required: production may contain dashboard-managed
   non-secret overrides, and a CLI deployment must not delete or reset them
   merely to toggle the backup gate. Wrangler preserves secrets separately.

   The request must be HTTP 503 with `checks.backup_maintenance: false`,
   `checks.write_fence: true`, `write_fence.database_epoch` equal to
   `NEXT_EPOCH`, and `write_fence.writes_enabled: 0`. Those values prove both
   admission and durable storage authority are closed; `/health` is
   liveness-only and is not sufficient.

4. Keep both gates closed and wait **120 full seconds** before either export.
   The per-write primary-D1 check occurs after request-body parsing and before
   each storage call, so a held body cannot extend authority and cron work is
   stopped at its next mutation. This short quiescence covers only a mutation
   already between its successful fence read and storage completion, plus KV's
   cross-location propagation window. Do not run manual issue/revoke/backfill
   commands during this window.

   ```sh
   sleep 120
   ```

5. Still under the gate, export KV first and D1 second. The script forces its
   directory and files to owner-only access; keep a restrictive umask for the
   Wrangler-created SQL dump and repair its mode explicitly:

   ```sh
   BACKUP_DIR="backups/$(date -u +%Y%m%dT%H%M%SZ)"
   node scripts/backup-kv.mjs "$BACKUP_DIR"
   (umask 077; npx wrangler d1 export smesh-analytics --remote --output="$BACKUP_DIR/d1.sql")
   chmod 600 "$BACKUP_DIR/d1.sql"
   ```

6. Validate the exact artifacts before lifting maintenance. `restore.json`
   must be non-empty, parse as a restore array of string key/value pairs, and
   the D1 dump must execute cleanly in a fresh SQLite database:

   ```sh
   test -s "$BACKUP_DIR/restore.json" && test -s "$BACKUP_DIR/d1.sql"
   node --input-type=module -e '
     import { readFileSync } from "node:fs";
     import { DatabaseSync } from "node:sqlite";
     const rows = JSON.parse(readFileSync(process.argv[1], "utf8"));
     if (!Array.isArray(rows) || rows.some((r) =>
       !r || typeof r.key !== "string" || typeof r.value !== "string")) {
       throw new Error("invalid KV restore artifact");
     }
     const db = new DatabaseSync(":memory:");
     db.exec(readFileSync(process.argv[2], "utf8"));
     const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
     db.close();
     if (integrity !== "ok") throw new Error(`D1 dump integrity: ${integrity}`);
     console.log(`validated ${rows.length} KV rows and the D1 dump`);
   ' "$BACKUP_DIR/restore.json" "$BACKUP_DIR/d1.sql"
   ```

   If any export or validation fails, leave maintenance enabled and start a new
   backup directory after resolving the error. Never bless a partial directory.

7. Reopen the durable row for exactly `NEXT_EPOCH` while the 100% maintenance
   deployment still rejects every new route and cron invocation. The guarded
   `WHERE` must return exactly one row; otherwise leave maintenance on:

   ```sh
   npx wrangler d1 execute smesh-analytics --remote --json --command \
     "UPDATE runtime_write_fence SET writes_enabled = 1, updated_at = unixepoch('subsec') * 1000 WHERE singleton = 1 AND write_epoch = $NEXT_EPOCH AND writes_enabled = 0 RETURNING write_epoch, writes_enabled"
   ```

8. Disable maintenance with another immediate 100% deploy using the **same**
   epoch. Then require HTTP 200, `checks.backup_maintenance: true`,
   `checks.write_fence: true`, and `write_fence.writes_enabled: 1` before
   declaring service restored:

   ```sh
   npx wrangler deploy --keep-vars --var BACKUP_MAINTENANCE:false \
     --var RUNTIME_WRITE_EPOCH:"$NEXT_EPOCH"
   curl -i -H "X-Admin-Token: $ADMIN_TOKEN" https://smeshapi.site/admin/health
   unset ADMIN_TOKEN
   ```

Copy the whole owner-only directory to encrypted cold storage. `restore.json`,
`d1.sql`, and the retained per-chunk manifests together form the restore set;
the manifests make an interrupted or partial export auditable.

### Disaster recovery: restore drill

Practice this quarterly with a fresh, non-production Worker. Never import a D1
dump or KV artifact over a live namespace: the restore helpers deliberately
require empty targets, and a half-restored pair must never receive traffic.

1. Check out the exact backed-up commit. Create a fresh D1 database and fresh KV
   namespace, put their ids into a temporary recovery `wrangler.toml`, and keep
   the recovery Worker on an unused hostname with `BACKUP_MAINTENANCE=true`.
2. Import D1, then query its integrity and fence row. The dump was taken while
   `writes_enabled=0`; if it is not still closed, stop.

   ```sh
   BACKUP_DIR="backups/<timestamp>"
   npx wrangler d1 execute smesh-analytics --remote --file="$BACKUP_DIR/d1.sql"
   npx wrangler d1 execute smesh-analytics --remote --command \
     "PRAGMA integrity_check; SELECT write_epoch, writes_enabled FROM runtime_write_fence WHERE singleton = 1"
   ```

3. Restore and read back every KV value into the fresh namespace. The script
   refuses a non-empty namespace and keeps the exact put/check chunks beside the
   backup as an audit trail.

   ```sh
   node scripts/restore-kv.mjs "$BACKUP_DIR/restore.json"
   ```

4. Deploy the recovery Worker at 100% maintenance with
   `RUNTIME_WRITE_EPOCH` equal to the restored fence. Require the expected
   schema, zero restore mismatches, inspect the payment/refund/delivery
   worklists, and verify several sampled licenses and their revocations.
5. In a drill, stop here and record duration/results. In a real disaster, move
   the production route only after both stores pass. Reopen the restored D1
   fence for that exact epoch, deploy `BACKUP_MAINTENANCE=false` to 100%, and
   require `/admin/health` HTTP 200. If any step fails, keep the recovery Worker
   gated and start again with new empty stores; never patch a partial restore in
   place.

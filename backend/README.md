# СМЭШ AI license, payment and telemetry Worker

Cloudflare Worker for licenses, payment fulfillment, consent receipts, optional
content-free telemetry, support delivery and the server-side GDZ proxy. AI
inference runs in ../backend-vps and is authorized with short-lived
entitlements issued here.

## Stack

- Cloudflare Workers: HTTP entrypoint and cron retry driver.
- KV binding LICENSES: active license mirror.
- D1 binding DB: authoritative operational, payment, consent and telemetry data.
- Robokassa: payment processing and refunds.
- Telegram and Resend: optional license/support delivery channels.
- Wrangler 4.114.0: local development, migrations and deployment.

The Worker must be deployed with Workers Observability disabled. Request bodies,
license keys, task content and provider responses must not be added to logs,
Logpush, Analytics, APM or crash reports.

## Public routes

| Route | Purpose |
| --- | --- |
| GET /health | Liveness only; does not prove paid flows are ready. |
| POST /verify | Verifies a license/device lease and issues telemetry, erasure and 10-minute AI entitlement capabilities. |
| POST /deactivate | Releases the authenticated device activation. |
| POST /consent/receipt | Stores the current purpose choices against a pseudonymous license reference. |
| POST /checkout/session | Creates a server-owned checkout session. |
| POST /checkout/payment | Creates a payment for that session. |
| POST /checkout/status | Returns server-verified payment and delivery state. |
| GET/POST /webhook/robokassa | Validates Robokassa callbacks and fulfills the authoritative order. |
| POST /telegram/webhook | Handles authenticated bot updates and delivery/support flows. |
| POST /gdz/fetch | Fetches a public reference URL through a fixed server allowlist. |
| POST /t | Optional, attested, content-free client telemetry. |
| POST /t/ai | Optional, authenticated, content-free gateway usage telemetry. |
| POST /t/delete | Deletes telemetry for the authenticated installation. |

## Admin routes

Readiness is GET /admin/health with X-Admin-Token. It verifies bindings, the
complete D1 schema, payment/refund configuration, write fence, delivery config,
worklists, telemetry secret and entitlement secret. Monitor this endpoint, not
the public liveness route.

Mutation endpoints use ADMIN_SECRET. Read-only statistics use a distinct
STATS_SECRET. The main operations UI is the sibling smeshaidashboard project.

Important routes include:

- POST /admin/issue and POST /admin/revoke
- GET /admin/license
- POST /admin/payment/reconcile
- POST /admin/payment/refund
- POST /admin/payment-review/resolve
- GET /admin/stats/*
- GET /admin/referral and POST /admin/referral/retry-pending
- POST /telegram/setup, POST /telegram/test and GET /telegram/info

Never put admin or stats secrets in source, query strings, browser history or
persistent browser storage.

## Authorization boundaries

A successful POST /verify checks the license, revocation registry, expiry,
device UUID and one-device activation lease. The response includes a signed
et1 entitlement with:

- purpose ai;
- SHA-256 pseudonymous license reference;
- canonical device UUID;
- license type/expiry metadata;
- exact 10-minute lifetime.

The raw license key and activation credential stop at this Worker. The
inference gateway shares only ENTITLEMENT_SECRET and verifies the capability
locally. It does not call /verify and cannot accept raw credentials.

Consent receipt version 4 stores receipt UUID, pseudonymous license reference,
device UUID, four booleans, client timestamp and server timestamp. It never
stores task content, answers, files or the raw license key. Terms,
AI-processing and eligibility are required by the UI; telemetry is independent
and off by default.

## Database

schema.sql is the fresh-install schema. Numbered changes live in migrations/.
Apply every migration before deploying code:

~~~sh
cd backend
npm ci
npx wrangler d1 migrations apply smesh-analytics --remote
npx wrangler deploy --keep-vars
~~~

Current schema includes migrations 0001 through 0012. Migration 0012 creates
the consent_receipts table and its pseudonymous lookup index.

For a database that already matches schema.sql but has no Wrangler migration
ledger, follow scripts/adopt-current-schema.sql exactly. The adoption script
checks every expected table/index signature before inserting migration
bookmarks; it must fail rather than bless a drifted database.

RUNTIME_WRITE_EPOCH is an operational write fence. The configured value and
the singleton D1 row must match, and writes_enabled must match maintenance
state. Do not change only one side.

## Required configuration

Tracked non-secret variables live in wrangler.toml. Secrets are entered through
wrangler secret put and are never committed.

Core secrets:

- ADMIN_SECRET and STATS_SECRET: at least 32 random bytes and different.
- INGEST_KEY: at least 32 bytes for telemetry attestation/ingest.
- ENTITLEMENT_SECRET: at least 32 bytes; exactly the same value on the VPS.
- CHECKOUT_CAPABILITY_SECRET: at least 32 bytes and separate from INGEST_KEY.
- Robokassa production passwords 1, 2 and 3.
- TELEGRAM_WEBHOOK_SECRET and TELEGRAM_BOT_TOKEN when Telegram is enabled.
- RESEND_API_KEY when email delivery is enabled.

Core bindings:

- LICENSES KV namespace.
- DB D1 database.
- Custom domain smeshapi.site.

Keep PAYMENT_ENVIRONMENT=production only with production credentials and a
production D1 database. Test payments belong to a separate Worker/database.
Robokassa merchant, hash, fiscalization and receipt fields must match the
merchant cabinet and accountant-approved tax treatment.

## Local development

~~~sh
cd backend
npm ci
npm run dev
~~~

The repository-level regression suite is authoritative:

~~~sh
cd ..
npm test
~~~

Tests use local fakes and pinned Wrangler D1 where appropriate. Never point
tests at production KV, D1, payment credentials or delivery channels.

## Deployment order

1. Review compliance/data-flows.json and the live privacy/agreement text.
2. Confirm all secrets/bindings and RUNTIME_WRITE_EPOCH.
3. Apply D1 migrations remotely.
4. Deploy with keep-vars so dashboard-managed variables are preserved.
5. Call authenticated /admin/health and require HTTP 200 with ok=true.
6. Exercise a test license verification and confirm an entitlement is returned.
7. Confirm payment callback, delivery, support and refund worklists.
8. Confirm Workers Observability and content-bearing Logpush/APM are disabled.

A deploy is incomplete while readiness is red.

## Payments and delivery

Checkout state is server-owned and capability-bound. The Worker verifies
Robokassa signatures, amount, order binding and payment state before issuing
access. Webhook acknowledgment is idempotent; delivery retries through durable
outbox/worklist state. Full bank-card details never reach this Worker.

Refund and reconciliation actions are privileged, auditable operations.
Unknown provider outcomes remain in a reviewable state rather than being
guessed as success or failure. Resolve open worklists through the operations
dashboard before considering payment health green.

Email and Telegram are alternative delivery/contact channels. Configure only
the channels actually disclosed in the public privacy policy and operator
notification.

## Telemetry and retention

Telemetry is accepted only with a short-lived device-bound capability or the
server INGEST_KEY. The server ignores content/credential fields and keeps only
the bounded event schema. Client and gateway calls must send telemetry only
when the separate local telemetry choice is true.

Default telemetry retention is 90 days. The scheduled Worker cleans expired
rows and retries bounded delivery/payment/referral work. Task text, answers and
files are not valid telemetry fields.

## Backup and restore

KV and D1 form one logical service and must be snapshotted together. D1 owns
payment idempotency, device slots, revocations and work queues; KV contains the
live license projection and support bodies. A sequential live export can create
an inconsistent pair.

Run this procedure from `backend/` in a low-traffic window, using a clean
checkout of the exact production commit. Abort if this prints anything:

~~~sh
git status --porcelain --untracked-files=normal
~~~

1. Read `ADMIN_SECRET` without putting it in shell history. Before changing
   anything, `/admin/health` must return HTTP 200 with
   `checks.backup_maintenance: true`, `checks.write_fence: true` and
   `write_fence.writes_enabled: 1`.

   ~~~sh
   read -s ADMIN_TOKEN
   curl -i -H "X-Admin-Token: $ADMIN_TOKEN" https://smeshapi.site/admin/health
   ~~~

2. Atomically close the D1 write fence and rotate its epoch. Record the returned
   `write_epoch` as `NEXT_EPOCH`; the update must return exactly one row with
   `writes_enabled: 0`.

   ~~~sh
   npx wrangler d1 execute smesh-analytics --remote --json --command \
     "UPDATE runtime_write_fence SET write_epoch = write_epoch + 1, writes_enabled = 0, updated_at = unixepoch('subsec') * 1000 WHERE singleton = 1 AND writes_enabled = 1 RETURNING write_epoch, writes_enabled"
   read -r NEXT_EPOCH
   case "$NEXT_EPOCH" in (''|*[!0-9]*) echo "invalid epoch" >&2; exit 1;; esac
   ~~~

3. Deploy maintenance to 100% of traffic with that epoch. Do not use a gradual
   rollout or traffic split.

   ~~~sh
   npx wrangler deploy --keep-vars --var BACKUP_MAINTENANCE:true \
     --var RUNTIME_WRITE_EPOCH:"$NEXT_EPOCH"
   curl -i -H "X-Admin-Token: $ADMIN_TOKEN" https://smeshapi.site/admin/health
   ~~~

   `--keep-vars` is required because production can contain dashboard-managed
   non-secret variables. Readiness must now return HTTP 503 with
   `checks.backup_maintenance: false`, `checks.write_fence: true`, the matching
   database epoch and `write_fence.writes_enabled: 0`.

4. Keep both gates closed for the bounded in-flight mutation and KV propagation
   window. Do not run manual issue/revoke/backfill commands during it.

   ~~~sh
   sleep 120
   ~~~

5. Export KV and D1 under owner-only permissions.

   ~~~sh
   BACKUP_DIR="backups/$(date -u +%Y%m%dT%H%M%SZ)"
   node scripts/backup-kv.mjs "$BACKUP_DIR"
   (umask 077; npx wrangler d1 export smesh-analytics --remote --output="$BACKUP_DIR/d1.sql")
   chmod 600 "$BACKUP_DIR/d1.sql"
   ~~~

6. Validate both artifacts before reopening writes. The KV artifact must contain
   only string key/value rows; the D1 dump must execute and pass integrity check
   in an isolated database.

   ~~~sh
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
   ~~~

   If validation fails, leave maintenance enabled, diagnose the cause and start
   a new backup directory. Do not treat a partial directory as a backup.

7. Reopen only the matching epoch while the maintenance deployment still blocks
   routes and cron work. The guarded update must return exactly one row.

   ~~~sh
   npx wrangler d1 execute smesh-analytics --remote --json --command \
     "UPDATE runtime_write_fence SET writes_enabled = 1, updated_at = unixepoch('subsec') * 1000 WHERE singleton = 1 AND write_epoch = $NEXT_EPOCH AND writes_enabled = 0 RETURNING write_epoch, writes_enabled"
   ~~~

8. Disable maintenance at 100% traffic with the same epoch. Require HTTP 200,
   `checks.backup_maintenance: true`, `checks.write_fence: true` and
   `write_fence.writes_enabled: 1` before declaring the service restored.

   ~~~sh
   npx wrangler deploy --keep-vars --var BACKUP_MAINTENANCE:false \
     --var RUNTIME_WRITE_EPOCH:"$NEXT_EPOCH"
   curl -i -H "X-Admin-Token: $ADMIN_TOKEN" https://smeshapi.site/admin/health
   unset ADMIN_TOKEN
   ~~~

Copy the complete owner-only directory to encrypted cold storage. Keep
`restore.json`, `d1.sql`, chunk manifests, hashes, timestamp, Worker commit,
database id, KV namespace id and write epoch together.

### Disaster-recovery drill

Practice quarterly with fresh, isolated bindings. Never import over live or
non-empty stores.

1. Check out the backed-up commit. Create a fresh D1 database, KV namespace and
   recovery Worker on an unused hostname with maintenance enabled.
2. Import D1 and verify its integrity and closed fence.

   ~~~sh
   BACKUP_DIR="backups/<timestamp>"
   npx wrangler d1 execute smesh-analytics --remote --file="$BACKUP_DIR/d1.sql"
   npx wrangler d1 execute smesh-analytics --remote --command \
     "PRAGMA integrity_check; SELECT write_epoch, writes_enabled FROM runtime_write_fence WHERE singleton = 1"
   ~~~

3. Restore and read back every KV value. The helper refuses a non-empty target.

   ~~~sh
   node scripts/restore-kv.mjs "$BACKUP_DIR/restore.json"
   ~~~

4. Deploy the recovery Worker with the restored epoch while maintenance remains
   on. Require schema/readiness, worklist and sampled license/revocation checks.
5. In a drill, stop and record results. In a real recovery, switch production
   traffic only after both stores pass; then reopen that exact epoch, deploy with
   maintenance false and require `/admin/health` HTTP 200.

## Privacy and compliance controls

- Workers Observability is disabled in wrangler.toml.
- safeErrorText emits bounded error class/code only, never message/stack/body.
- Consent receipt and telemetry tables contain no task content.
- AI entitlement contains a pseudonymous license reference rather than the key.
- The public data-flow source of truth is ../compliance/data-flows.json.
- Russian operator/localization/cross-border actions are tracked in
  ../docs/LEGAL-OPERATIONS-RU.md.
- Processor routing and independent feature switches are controlled by
  smeshaidashboard and published by the VPS /processors and
  /public/runtime-config endpoints.

Update the documents whenever actual bindings, vendors, countries, retention,
purpose or data fields change.

# СМЭШ AI inference gateway

Node 24 service that authorizes AI work, enforces quotas and processor policy,
proxies the selected task to 302.AI, and exposes the answer through short polls.
Caddy terminates TLS and forwards only to the loopback listener.

```
Extension ──POST /ai/start───▶  ai.smeshapi.site
          ◀─{ job_id, token }─       │ local entitlement verification
Extension ──GET /ai/poll──┐         └─ POST (SSE) ──▶ api.302.ai (live model chain,
          ◀─{chunk,done}──┘             bounded in memory per job)
Extension ──POST /ai/cancel──▶  abort upstream work
Extension ──POST /ai/upload-ticket──▶ one bounded attachment capability
Extension ──POST /ai/blob────────────▶ short chunks bound to that capability
```

The license Worker verifies the raw license and returns a 10-minute HMAC
entitlement containing only a pseudonymous license reference, canonical device
UUID and the `ai` purpose. This service accepts only that entitlement. Raw
license keys and activation tokens are not accepted, stored or logged here.

The client feeds each poll chunk into `createSseSink` in `src/lib/http.js`, so
the visible UI remains progressive. `POST /ai/chat` is admin-only diagnostics;
the extension uses start/poll/cancel.

Large screenshots, PDFs and replayed history use `/ai/upload-ticket` followed
by 8 KiB `/ai/blob` chunks. The final start references `messages_blob`; the
server reassembles and validates it in bounded memory. Tickets are bound to the
pseudonymous license/device principal and a generated blob id.

Upload tickets reserve their declared size before any chunks are accepted.
Reservations are capped at 40 MiB process-wide, 10 MiB/device, 12 MiB/license
and 18 MiB/IP, with at most two live tickets per device/license and four per
IP. A ticket must receive its first chunk within 12 seconds; only genuinely new
bytes extend the 20-second progress deadline. The absolute upload lifetime is
ten minutes, so duplicates and slow drips cannot pin memory indefinitely.

## Files

- `server.js` — the gateway (Node 24 LTS, zero npm dependencies). Entitlements
  are verified locally; per-minute bursts are held in memory, while
  pseudonymous per-license and global daily quotas are
  atomically persisted before a job is accepted
  (`/var/lib/smesh-proxy/quota.json`); poll jobs buffered in
  memory (bounded: max 24 active and 64 total retained, abandoned jobs aborted
  after 90s, done jobs GC'd after 5 min). Long polls are admitted at most two
  per job/token, six per client IP, and 32 process-wide, leaving listener
  capacity for health checks and unrelated users. A `{type:'file'}` data-URI
  part re-routes the job to the configured PDF chain (bootstrapped from
  `PROXY_PDF_MODEL`, default
  `gemini-2.5-flash-lite`). Model chains, limits and pricing estimates hot-reload
  from `/var/lib/smesh-proxy/model-config.json`.
- `setup.sh` — one-shot installer for Ubuntu 22.04/24.04. Installs Node +
  Caddy, drops `server.js`, a systemd unit, and a Caddyfile, and starts it.
  **Embeds a generated copy of `server.js`** — after editing `server.js`, run
  `npm run sync:vps`. `npm test` and the push/pull-request CI workflow run
  `tests/vps-setup-parity.mjs`, so the deployable copy cannot drift from the
  canonical file unnoticed.

## Caddy: HTTP/1.1-only + `Connection: close` — load-bearing, do not "fix"
The DPI clamp is per-CONNECTION: Chrome pools one TLS connection per origin,
so with h2 every /ai/poll rides the connection opened at /ai/start and stalls
once it ages past the clamp window (proven live: polls 1–2 fine, poll 3 hung
forever). The Caddyfile therefore pins `protocols h1` + `header Connection
close`, forcing a fresh sub-5s connection per request. Re-enabling h2/h3
resurrects the mid-answer hang for RU users.

## Deploy (GCP example)

Keep the real project id, billing-account email, instance name, and static IP
in a private password manager or ops notebook—not in the repository. The
examples below assume `GCP_PROJECT`, `GCP_INSTANCE`, and `GCP_ZONE` are set in
the operator's shell.

1. Create an `e2-small` Ubuntu 24.04 VM near RU (`europe-west3`), firewall tag
   `smesh-proxy` (rule `smesh-allow-web` opens 80+443; default VPC rule opens 22).
2. Reserve a static external IP (`smesh-ai-proxy-ip`) and attach it.
3. Cloudflare DNS: point `ai.smeshapi.site` → static IP, **DNS only (grey cloud)**.
4. `gcloud --project "$GCP_PROJECT" compute scp setup.sh "$GCP_INSTANCE:/tmp/" --zone="$GCP_ZONE"`, then
   `gcloud --project "$GCP_PROJECT" compute ssh "$GCP_INSTANCE" --zone="$GCP_ZONE" --command="bash /tmp/setup.sh"`.
5. `sudo nano /etc/smesh-proxy.env` → paste the 302.AI key and `INGEST_KEY`
   (same value as the worker secret `npx wrangler secret put INGEST_KEY`; this
   enables opt-in server-observed usage reporting to `POST /t/ai`). Set
   `ENTITLEMENT_SECRET` to the same strong secret as the license Worker. Set
   `RUNTIME_CONFIG_PRIVATE_KEY_B64` to the base64-encoded P-256 private key
   whose public half is pinned in the extension. Generate a separate
   model-control key with `openssl rand -hex 32` and save it as `MODEL_ADMIN_KEY`.
   The default dashboard origin is
   `https://ayeepat.github.io`; override `MODEL_DASHBOARD_ORIGIN` only when the
   dashboard moves. Then run `sudo systemctl restart smesh-proxy`.
6. Verify readiness: `curl -fsS https://ai.smeshapi.site/ready` must return
   `ok:true` and true checks for `upstream_key`, `entitlement_secret`,
   `runtime_signing_key`, `quota_config`, `quota_store` and `model_config`.
   Invalid or out-of-range quota configuration fails readiness and AI admission
   closed rather than silently increasing spend.
   `/health` is intentionally liveness-only and can remain 200 while required
   configuration or quota storage is unavailable.
7. Update deploy: **re-run the installer**, exactly like step 4 —
   `gcloud compute scp setup.sh …` then `bash /tmp/setup.sh`. `setup.sh` is
   idempotent and is the only path that applies EVERY dependent change, not
   just the app code: it upgrades an existing Node 20 host to the declared
   Node 24 (the systemd unit runs `/usr/bin/node`), and it rewrites the systemd
   unit and the Caddy site config. It also embeds the current `server.js`
   verbatim — `npm run sync:vps` keeps that payload byte-identical, and
   `npm run test:vps-parity` gates it.

   Copying `server.js` alone — which this step used to prescribe — leaves an
   existing host on stale, untested runtime and service configuration: new
   server code can then run under an old Node major or an old unit/Caddy
   config that was never tested together. Only use the file-only path as a
   deliberate hotfix when you have confirmed the runtime and service
   configuration are already current:
   `sudo install -o root -g smeshai -m 640 /tmp/server.js
   /opt/smesh-proxy/server.js && sudo systemctl restart smesh-proxy`.
   Either way, finish with the `/ready` check in step 6.
8. Host move: this service's quota authority is a local file, so two accepting
   hosts are **not** a zero-downtime cluster. Before the final quota copy, stop
   admissions on the old host and wait for its in-flight jobs to settle; then
   stop `smesh-proxy`, copy `/var/lib/smesh-proxy/quota.json` once, start the new
   host and require `/ready`. Flip DNS only after that check, and keep the old
   service stopped throughout DNS propagation. Otherwise both snapshots can
   spend the same per-license/global allowance and one host's increments will
   be lost. A genuinely overlap-safe cutover requires one shared atomic quota
   store. The Caddy certificate may be copied earlier (`/var/lib/caddy`, then
   `chown caddy:caddy`) because it is not quota authority.

## Extension side
- `src/lib/smesh-proxy.js` — start → poll → cancel client (the only caller).
- `src/lib/config.js` — `AI_BACKEND_URL = 'https://ai.smeshapi.site'`.
- `manifest.json` — `https://ai.smeshapi.site/*` in `host_permissions`.

## Live model control (no extension release)

The extension sends only the stable internal routes `deepseek` (Auto) and
`qwen` (Think). The VPS resolves those names to the currently saved 302.AI
model chains. A dashboard save affects every **new** request immediately; an
in-flight job keeps the route snapshot it started with.

`deepseek` is now only a compatibility id. **One model answers everything that
is not a PDF**: Auto, Think and the cheap standard chain all default to
`qwen3.8-flash` (multimodal, so no separate vision model), with `qwen3.7-plus`
and `qwen-vl-plus` behind it as fallbacks. PDFs keep their own independently
verified chain on `gemini-2.5-flash-lite`. A test solve and a homework solve
therefore run on the same model whichever route the client picked.

The quality policy is applied per **actual model**, not per route, because each
model has a different thinking knob:

| model | what the VPS sends |
| --- | --- |
| `qwen3.8-flash` | `reasoning_effort` in **Qwen's** vocabulary — `low` / `medium` / `xhigh`, note there is no `high`. МЭШ homework and tests always get `xhigh`; only a request that explicitly sent `tier: "standard"` (the any-site path) may ask for less, and its `low`/`medium`/`high` hint is translated. |
| other `qwen*` | nothing — pre-3.8 Qwen thinks by default and has no effort levels, so a client's hint is dropped. |
| `glm-5.3-flash` | `thinking: {type: "enabled"}` + `reasoning_effort: "max"`, regardless of the low-effort hint an older extension sends. |
| anything else | the client's `reasoning_effort`, if the route has passthrough enabled. |

`response_format: json_object` is dropped for **every** Qwen model when the
request carries an image, where Qwen's JSON mode is unreliable; the answer
parser recovers the shape from prose.

Cheapness on the standard chain now comes from a lower **effort**, not a
different vendor: `qwen3.8-flash` at `low` rather than GLM. `glm-5.3-flash`
still trails that chain as a fallback, so a Qwen-wide outage does not take the
post-frontier allowance down with it, and it is one click away as a dashboard
preset. The DeepSeek preset restores `deepseek-v4-flash` for Auto text but
keeps a multimodal model for images, because DeepSeek V4 is text-only.

If 302.AI ever rejects `reasoning_effort` on a model the policy sends it to, it
answers HTTP 400 with `err_code: -10003`. That is treated as a rejected
**field**, not a rejected model: the same model is retried once with the field
removed (`isParameterRejection`), so the failure mode is a shallower answer
rather than a dead route. `API_302_KEY=… bash tests/302ai-verify.sh` is the
check that settles per-model support.

The owner dashboard calls `GET/PUT /admin/model-config` with
`X-Model-Admin-Key`. This key is separate from `ADMIN_KEY`, `STATS_SECRET`,
`INGEST_KEY` and `AI_PROXY_API_KEY`. It can change only:

- Auto and Think text/vision chains (any valid model id accepted by 302.AI's
  OpenAI-compatible `/v1/chat/completions` endpoint);
- the standard text/vision chain and isolated PDF chain;
- the shared starts-per-minute cap, combined frontier allowance per licence,
  standard allowance, global breaker, and emergency `force_standard` switch;
- exact per-model prices used by owner analytics.
- the server-side processor allowlist and public operator/privacy metadata;
- independent switches for text AI, images, documents, journal attachments,
  autofill, other-site solving, telemetry and GDZ.

Every routed model must have an enabled processor record. `GET /processors`
publishes the current register without credentials. `GET /public/runtime-config`
publishes only the eight feature flags inside a signed P-256 envelope; the
extension rejects unsigned, stale or unknown configuration.

After the combined frontier allowance is exhausted, the request is admitted on
the standard chain instead of returning a frontier-limit error. The defaults
are 5 starts per rolling minute, 15 combined Auto + Think requests, then 70
standard requests per Moscow day (85 total). Exact idempotent `/ai/start`
retries reuse their original job and do not count again; a minute-limit
rejection happens before daily quota is charged. Minute counters are held in
memory and begin with an empty window after a service restart, while daily
counters remain durable. Config writes
are bounded, validated, fsynced and atomically renamed. The API rejects stale
dashboard revisions with HTTP 409 and retains ten rollback snapshots. A corrupt
or unwriteable config fails AI admission closed until a valid dashboard save or
operator repair succeeds.

Browser access is restricted to the exact `MODEL_DASHBOARD_ORIGIN`. The key
must contain at least 32 bytes, failed attempts are rate-limited, and neither
the 302.AI key nor task content is returned by the control API. For local
dashboard work, set `MODEL_DASHBOARD_ORIGIN=http://127.0.0.1:4599` temporarily
and restart the service; restore the production origin before deployment.

## Ops
- Logs: `journalctl -u smesh-proxy -f` (app), `journalctl -u caddy -f` (TLS).
- Restart after env change: `sudo systemctl restart smesh-proxy`.
- Monitor `GET /ready`, not `/health`; readiness fails closed when the upstream
  key is absent or quota accounting cannot be read and durably rewritten.
- The production listener is fixed by systemd to `127.0.0.1:8080`, matching
  Caddy. Do not add `PORT` or `HOST` to `/etc/smesh-proxy.env`; the unit removes
  legacy overrides so the private listener cannot drift from Caddy.
- The 302.AI key lives **only** in `/etc/smesh-proxy.env` (chmod 600) — never in
  the repo or the client.
- Never log request/response bodies, entitlement tokens, file names or model
  content. Caddy is intentionally configured without an access log; keep APM
  and crash-report payload capture disabled.

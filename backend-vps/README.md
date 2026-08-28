# СМЭШ AI proxy (off-Cloudflare, polling transport)

The **AI proxy only**. Russian DPI (TSPU) applies a bandwidth clamp keyed on
the TLS SNI `*.smeshapi.site`: **any** connection to that name living longer
than ~6–12s is throttled to zero — on Cloudflare *and* on this box alike
(proven from an RU client: the same 2s-heartbeat probe died at ~6s via the CF
worker and ~12s here over h2, while a 66s stream from httpbin.org on the same
RU connection completed fine). So long-lived streaming to RU is impossible on
this SNI, but sub-second requests always get through — that's why `/verify`
and `/health` never broke.

The fix is a **polling pseudo-stream**: every RU-facing request is short.

```
Extension ──POST /ai/start───▶  ai.smeshapi.site (this box, DNS-only / grey-cloud)
          ◀─{ job_id }───────       │ POST /verify ──▶ smeshapi.site (CF worker, licenses)
Extension ──GET /ai/poll──┐         └─ POST (SSE) ──▶ api.302.ai (live model chain,
          ◀─{chunk,done}──┘ ~0.6s        buffered in memory per job — this leg
   … repeat until done …                 never touches Russia)
Extension ──POST /ai/cancel──▶  (abort: stop paying 302.AI)
Extension ──POST /ai/upload-ticket──▶ (validates license, authorizes one blob)
Extension ──POST /ai/blob──▶    (short chunks, bound to that ticket)

Extension ──everything else──▶ smeshapi.site (CF worker, unchanged)
```

Every paid upload/start/chat request is bound to three values: license key,
device UUID and the random `activation_token` issued by the first successful
Worker `/verify`. The key plus UUID alone cannot use or transfer a license.
Only the authenticated Settings “Deactivate license / sign out” action releases
device number 1; a competing installation is told to sign out there first.

The client feeds each poll's chunk into the same SSE parser it uses for
direct streams (`createSseSink` in `src/lib/http.js`), so the UI still
reveals the answer token-by-token. The legacy streaming `POST /ai/chat` is
kept on this box for curl diagnostics only.

**The clamp is symmetric — it kills UPLOAD too, and it is a per-connection
TRANSFER ALLOWANCE (~16 KB), not just a time window.** Measured from RU: a
big upload delivered exactly 16 KB then crawled to a 408, and 96 KB chunks
died with 0 bytes through. So EVERY request — `/ai/start` included — must fit
under ~16 KB. When the start body would be bigger (screenshot, PDF, long
replayed history), the client slices the whole `messages` JSON into **8 KB**
 substring chunks and `POST`s them to **`/ai/blob`** on a few parallel
 connections (each connection brings its own allowance). Before the chunks,
 the extension obtains a short-lived `/ai/upload-ticket` after server-side
 license verification; every chunk and the final `/ai/start` are bound to that
 ticket's generated blob id, license, and device. The server reassembles the
 string (bounded and swept by GC) and `/ai/start` arrives
 tiny with `{ messages_blob: <id> }`, which `prepareChat` parses back into
 `messages`. See `uploadBlob` in `src/lib/smesh-proxy.js`.

Upload tickets reserve their declared size before any chunks are accepted.
Reservations are capped at 40 MiB process-wide, 10 MiB/device, 12 MiB/license
and 18 MiB/IP, with at most two live tickets per device/license and four per
IP. A ticket must receive its first chunk within 12 seconds; only genuinely new
bytes extend the 20-second progress deadline. The absolute upload lifetime is
ten minutes, so duplicates and slow drips cannot pin memory indefinitely.

## Files
- `server.js` — the proxy (Node 24 LTS, **zero npm deps**). License verified via
  the CF worker `/verify` per request with its activation bearer; per-license + global daily quotas
  are atomically persisted before a job is accepted
  (`/var/lib/smesh-proxy/quota.json`); poll jobs buffered in
  memory (bounded: max 24 active and 64 total retained, abandoned jobs aborted
  after 90s, done jobs GC'd after 5 min). Long polls are admitted at most two
  per job/token, six per client IP, and 32 process-wide, leaving listener
  capacity for health checks and unrelated users. PDFs: a `{type:'file'}` data-URI part re-routes the
  job to the configured PDF chain (bootstrapped from `PROXY_PDF_MODEL`, default
  `gemini-2.5-flash`). Model chains, limits and pricing estimates hot-reload
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
   enables opt-in server-observed usage reporting to `POST /t/ai`). Generate a
   separate model-control key with `openssl rand -hex 32` and save it as
   `MODEL_ADMIN_KEY`. The default dashboard origin is
   `https://ayeepat.github.io`; override `MODEL_DASHBOARD_ORIGIN` only when the
   dashboard moves. Then run `sudo systemctl restart smesh-proxy`.
6. Verify readiness: `curl -fsS https://ai.smeshapi.site/ready` must return
   `{"ok":true,"checks":{"upstream_key":true,"quota_config":true,"quota_store":true,"model_config":true}}`.
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

The owner dashboard calls `GET/PUT /admin/model-config` with
`X-Model-Admin-Key`. This key is separate from `ADMIN_KEY`, `STATS_SECRET`,
`INGEST_KEY` and `AI_PROXY_API_KEY`. It can change only:

- Auto and Think text/vision chains (any valid model id accepted by 302.AI's
  OpenAI-compatible `/v1/chat/completions` endpoint);
- the standard text/vision chain and isolated PDF chain;
- the combined frontier allowance per licence, standard allowance, global
  breaker, and emergency `force_standard` switch;
- exact per-model prices used by owner analytics.

After the combined frontier allowance is exhausted, the request is admitted on
the standard chain instead of returning a frontier-limit error. Config writes
are bounded, validated, fsynced and atomically renamed. The API rejects stale
dashboard revisions with HTTP 409 and retains ten rollback snapshots. A corrupt
or unwriteable config fails AI admission closed until a valid dashboard save or
operator repair succeeds.

Browser access is restricted to the exact `MODEL_DASHBOARD_ORIGIN`. The key
must contain at least 32 bytes, failed attempts are rate-limited, and neither
the 302.AI key nor task content is returned by the control API. For local
dashboard work, set `MODEL_DASHBOARD_ORIGIN=http://127.0.0.1:4599` temporarily
and restart the service; restore the production origin before deployment.

## Incident 2026-07-14: every solve failed with «ИИ-сервис временно недоступен»

**Symptom.** For ~20 minutes every real request from every user died with the
UNAVAILABLE toast (both providers — users saw «Qwen: ИИ-сервис временно
недоступен…» and assumed a Qwen outage). `journalctl -u smesh-proxy` showed
only `verify http error 404`, repeating. Meanwhile `/health` was fine, 302.AI
answered normally, and **synthetic `/verify` probes from the same VM — curl
and a fresh `node -e` process, 22 requests — all returned 200.**

**Root cause (inferred, high confidence).** The license check to the CF
worker (`smeshapi.site/verify`) used global `fetch()`, whose shared undici
pool keeps TLS connections to Cloudflare alive across requests. One pooled
connection went bad — pinned to an edge state that answered **404 for the
worker route** — and because the pool kept reusing it, every *real* verify
rode the poisoned socket while every *fresh* connection reached a healthy
edge. `systemctl restart smesh-proxy` (new process → new pool) cured it
instantly, which strongly supports—but does not uniquely prove—the
connection-state theory: nothing else changed (no deploy on either side that
day).

**Why users saw "unavailable" instead of a license error.** Correct behavior:
a non-200 from `/verify` is infrastructure trouble, not a verdict on the key,
so the proxy answered 503 UNAVAILABLE rather than "key not found". The gap
was resilience, not semantics.

**Fixes now in `server.js` — do not undo any of these:**
1. `postJsonFresh()` — verify runs over `node:https` with `agent: false`
   (fresh connection per request, `Connection: close`). No pool → no poisoned
   socket to reuse. Verify is low-volume (ok-verdicts cached 60 s), so the
   extra ~50 ms handshake is irrelevant. **Never "optimize" this back to
   `fetch()`/keep-alive.**
2. One retry (400 ms apart) on a non-200 / thrown verify — each attempt on
   its own fresh connection.
3. A last-known-good **grace store** (`verifyGrace`, 10 min TTL): if
   `/verify` is unreachable but this license+device verified ok within the
   window, the solve proceeds (loudly logged). Explicit negative verdicts
   evict the grace entry, so a revoked key can't hide behind an outage for
   longer than the TTL.
4. The verify error log now includes status, `cf-ray`, `server` header, and a
   body snippet — a bare `verify http error 404` proved undiagnosable live.

**If UNAVAILABLE toasts ever spike again:** check
`journalctl -u smesh-proxy --since '30 min ago' | grep verify` — if you see
`verify http error` with a `cf-ray` id, it's the CF edge again; the immediate
remedy is `sudo systemctl restart smesh-proxy` (drops all pooled state), and
the ray id lets Cloudflare support trace the edge. If there's no ray id /
`server=cloudflare`, something between GCP and CF is intercepting.

## Ops
- Logs: `journalctl -u smesh-proxy -f` (app), `journalctl -u caddy -f` (TLS).
- Restart after env change: `sudo systemctl restart smesh-proxy`.
- Monitor `GET /ready`, not `/health`; readiness fails closed when the upstream
  key is absent or quota accounting cannot be read and durably rewritten.
- The production listener is fixed by systemd to `127.0.0.1:8080`, matching
  Caddy. Do not add `PORT` or `HOST` to `/etc/smesh-proxy.env`; legacy values
  are deliberately removed from the service environment on installer upgrades.
- The 302.AI key lives **only** in `/etc/smesh-proxy.env` (chmod 600) — never in
  the repo or the client.
- `/ai/streamtest` (here and the temp copy in `backend/src/worker.js`) is the
  RU-DPI probe used for the diagnosis — costs nothing, useful for re-measuring
  RU behavior whenever the clamp changes.

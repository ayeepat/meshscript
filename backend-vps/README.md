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
          ◀─{ job_id }───────       │  GET /verify ──▶ smeshapi.site (CF worker, licenses)
Extension ──GET /ai/poll──┐         └─ POST (SSE) ──▶ api.302.ai (Qwen / DeepSeek,
          ◀─{chunk,done}──┘ ~0.6s        buffered in memory per job — this leg
   … repeat until done …                 never touches Russia)
Extension ──POST /ai/cancel──▶  (abort: stop paying 302.AI)

Extension ──everything else──▶ smeshapi.site (CF worker, unchanged)
```

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
connections (each connection brings its own allowance); the server
reassembles the string (bounded + 90s TTL, swept by GC) and `/ai/start`
arrives tiny with `{ messages_blob: <id> }`, which `prepareChat` parses back
into `messages`. See `uploadBlob` in `src/lib/smesh-proxy.js`.

## Files
- `server.js` — the proxy (Node 18+, **zero npm deps**). License verified via
  the CF worker `/verify` per request; per-license + global daily quotas
  enforced locally (`/var/lib/smesh-proxy/quota.json`); poll jobs buffered in
  memory (bounded: max 100 active, abandoned jobs aborted after 90s, done
  jobs GC'd after 5 min). PDFs: a `{type:'file'}` data-URI part re-routes the
  job to the Gemini chain (`PROXY_PDF_MODEL`, default `gemini-2.5-flash` —
  verified reading PDFs on 302.AI), since neither Qwen nor DeepSeek can.
- `setup.sh` — one-shot installer for Ubuntu 22.04/24.04. Installs Node +
  Caddy, drops `server.js`, a systemd unit, and a Caddyfile, and starts it.
  **Embeds a copy of `server.js`** — keep them in sync (re-splice the heredoc
  if you edit `server.js`).

## Caddy: HTTP/1.1-only + `Connection: close` — load-bearing, do not "fix"
The DPI clamp is per-CONNECTION: Chrome pools one TLS connection per origin,
so with h2 every /ai/poll rides the connection opened at /ai/start and stalls
once it ages past the clamp window (proven live: polls 1–2 fine, poll 3 hung
forever). The Caddyfile therefore pins `protocols h1` + `header Connection
close`, forcing a fresh sub-5s connection per request. Re-enabling h2/h3
resurrects the mid-answer hang for RU users.

## Deploy (summary — box live at 34.141.121.103, GCP europe-west3, migrated off AWS 2026-07-09)
GCP project `project-2bc53756-d2a7-40e9-be4` (account ermd219@gmail.com), instance
`smesh-ai-proxy`, zone `europe-west3-a`.
1. Create an `e2-small` Ubuntu 24.04 VM near RU (`europe-west3`), firewall tag
   `smesh-proxy` (rule `smesh-allow-web` opens 80+443; default VPC rule opens 22).
2. Reserve a static external IP (`smesh-ai-proxy-ip`) and attach it.
3. Cloudflare DNS: point `ai.smeshapi.site` → static IP, **DNS only (grey cloud)**.
4. `gcloud compute scp setup.sh smesh-ai-proxy:/tmp/ --zone=europe-west3-a`, then
   `gcloud compute ssh smesh-ai-proxy --zone=europe-west3-a --command="bash /tmp/setup.sh"`.
5. `sudo nano /etc/smesh-proxy.env` → paste the 302.AI key → `sudo systemctl restart smesh-proxy`.
6. Verify: `curl -s https://ai.smeshapi.site/health` → `{"ok":true}`.
7. Update deploy: `gcloud compute scp server.js smesh-ai-proxy:/tmp/ --zone=europe-west3-a`, then
   `sudo install -m 644 /tmp/server.js /opt/smesh-proxy/server.js && sudo systemctl restart smesh-proxy`.
8. Zero-downtime host move: tar `/var/lib/caddy` on the old box and restore it on
   the new one (chown `caddy:caddy`) so the Let's Encrypt cert is valid before the
   DNS flip; copy `/var/lib/smesh-proxy/quota.json` too so daily quotas survive.

## Extension side
- `src/lib/smesh-proxy.js` — start → poll → cancel client (the only caller).
- `src/lib/config.js` — `AI_BACKEND_URL = 'https://ai.smeshapi.site'`.
- `manifest.json` — `https://ai.smeshapi.site/*` in `host_permissions`.

## Ops
- Logs: `journalctl -u smesh-proxy -f` (app), `journalctl -u caddy -f` (TLS).
- Restart after env change: `sudo systemctl restart smesh-proxy`.
- The 302.AI key lives **only** in `/etc/smesh-proxy.env` (chmod 600) — never in
  the repo or the client.
- `/ai/streamtest` (here and the temp copy in `backend/src/worker.js`) is the
  RU-DPI probe used for the diagnosis — costs nothing, useful for re-measuring
  RU behavior whenever the clamp changes.

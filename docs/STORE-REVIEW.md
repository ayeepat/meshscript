# Store review notes — СМЭШ AI

Plain-language justification for every permission and data flow, written for a
Chrome Web Store / Opera Add-ons reviewer. Nothing here is a marketing claim —
each point maps to code in this repo.

## What the extension does

A personal homework/test assistant for the Moscow school diary **МЭШ**
(`school.mos.ru`). New users activate a purchased СМЭШ license, which routes AI
requests through our proxy. An older installation that already holds the
user's own provider key may continue to call that provider directly. The
extension reads the homework on the page the user is already viewing, sends it
to an AI provider, and shows the answer. It never logs into anything on the
user's behalf and never submits a test.

**Provider selection is not exposed to the user.** As shipped
(`SHOW_PROVIDER_UI = false` in `src/lib/config.js`) there is no provider picker
and no field for a third-party API key. Fresh installations therefore use the
licensed proxy. The bring-your-own-key adapters (OpenRouter, Groq, Alibaba
Model Studio) remain in the source and still run for an installation that was
configured before the flag was introduced and still holds its own key; those
requests go directly to the selected provider, which is why the corresponding
host permissions remain below. The vendor names are hidden from the product UI
only. They are named in full here and in the privacy policy at
`smeshai.xyz/privacy`, and the consent screen says that homework content may be
sent either through the СМЭШ proxy or directly with a previously saved key.

## Consent gate (required before any data leaves the device)

On first run the popup shows a consent screen that states plainly that task
text, test screenshots and attached files (including audio clips sent for
transcription) leave the device and go to third-party AI services. Licensed AI
requests use our proxy at `ai.smeshapi.site`; a pre-existing bring-your-own-key
setup may call its provider directly. Those services are OpenRouter, Groq,
Qwen (Alibaba) and DeepSeek; they are named in the linked privacy policy rather
than in the checkbox text, which keeps the in-product disclosure readable for
a schoolchild while the full list stays one click away. No AI request of any
kind (solving, transcription) is made until the
user accepts (`src/lib/consent.js`; every outbound handler in
`src/background/service-worker.js` re-checks it). The shared provider and
transcription network boundaries perform one final storage-backed check
immediately before `fetch`, and a storage-change listener aborts pending work
when consent is withdrawn. Consent is reviewable and revocable in Settings →
«Конфиденциальность и данные».

## Permissions

| Permission | Why it is needed |
|---|---|
| `storage`, `unlimitedStorage` | All local: settings, API keys, the GDZ catalog cache, and a **7-day** solve history. `unlimitedStorage` because a cached textbook catalog and inlined answer images can exceed the default quota. Nothing is synced. `chrome.storage.local` is locked to trusted contexts (`setAccessLevel`) so content scripts cannot read keys. |
| `activeTab` | On an explicit user click, screenshot the visible test page and read its text to solve it. |
| `scripting` | Inject the content script that reads the user's homework cards and fills test answers into the form fields on the Mesh page. |
| `alarms` | A periodic local-data retention sweep (history 7 d, week scan 24 h, pending file handoffs 1 h). No network involved. |

## Host permissions

| Host | Why |
|---|---|
| `https://school.mos.ru/*`, `https://uchebnik.mos.ru/*` | Read the user's **own** diary/homework/test player and download attachments from the two exact Mesh origins, inside the user's already-authenticated session. Scripted child-frame capture additionally requires a positively identified test-player document; unrelated MOS frames are excluded. |
| `https://openrouter.ai/*`, `https://api.groq.com/*`, `https://dashscope-intl.aliyuncs.com/*` | The BYO-key AI providers (OpenRouter, Groq, and Alibaba Model Studio for power users' own Qwen/DeepSeek keys). Not reachable from the shipped UI — see "Provider selection is not exposed" above — but still used by pre-existing installs that hold their own key, and by Groq Whisper for audio transcription. |
| `https://ai.smeshapi.site/*` | Our AI proxy for licensed users: Qwen/DeepSeek requests require the license, anonymous device id and the random one-device activation bearer; the key and public UUID alone are insufficient. Receives the same consent-gated task content as a direct provider call. |
| `https://*.smeshai.xyz/*` | One-way `GET` of a small, P-256-signed static config envelope (`extension-config.json`) used to select a pre-approved scrape selector or show an "update available" notice without a re-publish. The signature is rechecked on network and cache reads; no user data is sent. |
| `https://smeshapi.site/*` | License check (`POST /verify`, with credentials in a bounded JSON body), the GDZ proxy (`POST /gdz/fetch`, see below) and, **only if the user opts in**, anonymous usage statistics (see below). |

## GDZ textbook answers (no host permission, no declarativeNetRequest)

When the user pins a textbook, common exercises are answered from published
"ГДЗ" solution scans instead of an AI call. **The extension does not contact
either GDZ host.** It sends the URL it wants to our own Worker
(`POST https://smeshapi.site/gdz/fetch`, `backend/src/gdz.js`), which fetches
it and returns the JSON or the image.

That indirection exists because the GDZ mobile API sits behind DDoS-Guard,
which returns data only to the mobile app's `okhttp` User-Agent and 403s a
browser one. MV3 `fetch()` cannot set `User-Agent`; a Worker can. Earlier
versions of this extension therefore used a `declarativeNetRequest` session
rule to rewrite that single header. **That permission has been removed**, along
with the three GDZ host permissions, and `tests/gdz-proxy-regression.mjs` fails
the build if any of them — or a call to `chrome.declarativeNetRequest` — comes
back.

The proxy route is not an open relay:

- a valid, active license is required and re-verified server-side per request,
  including the one-active-device activation lease (the same gate as the AI
  proxy);
- a per-license daily request cap (`GDZ_DAILY_LIMIT`), bucketed by a SHA-256 of
  the key so no license key is stored in the counter table;
- a server-side host allowlist (HTTPS only, exact host or a real subdomain
  label, no credentials, no non-default port) that is deliberately a separate
  copy from the extension's — the client's check is advisory, this one is the
  boundary;
- byte ceilings and a timeout on every upstream read, with redirects followed
  manually and re-validated at each hop.

No homework content is sent to the proxy: the request body contains the
license/device activation credentials, a request kind and a public GDZ URL.
Homework text never enters this path.

## Data handling

- **AI providers** receive task text / screenshots / attachments (and audio
  clips for transcription on listening tasks) over HTTPS — authenticated with
  the user's own key on the BYO path, or with the license key on the proxy
  path. This is the core function and is gated by consent. Nothing leaves the
  device during a passive week scan: whether a homework card needs a file is
  decided on-device by regex heuristics (`src/lib/task-classifier.js`), and the
  first network request for a row happens only after the user presses «Решить»
  on that row.
- **The Mesh session token** is read from the page's own `localStorage` solely
  to download the user's own attachments. Downloads are restricted to an
  explicit `school.mos.ru`/`uchebnik.mos.ru` allowlist (HTTPS only, redirects
  re-validated hop by hop) and the token is never sent anywhere else.
- **Pseudonymous usage statistics are OPT-IN and off by default.** If (and only
  if) the user enables the separate «Анонимная статистика» toggle in Settings,
  small content-free batches go to `smeshapi.site/t` with a short-lived,
  device-bound capability issued by a successful license verification;
  licensed proxy calls may additionally send provider-observed token/cost
  facts server-side to `/t/ai`. The client batch contains event type,
  canonical subject name, provider/model, browser family, extension version,
  license *type* and the same random device UUID used by `/verify`. Never task
  text, answers, files, client-asserted financial totals, the raw user agent,
  or the license key (`src/lib/telemetry.js`;
  `backend/src/analytics.js` ignores legacy credential fields and purges any
  previously stored raw or pseudonymous license identifiers). Server-side
  event/device rows expire after 90 days by default (bounded configuration
  range: 30–365 days). A
  Settings button disables further statistics and deletes the device's rows
  server-side (`POST /t/delete`) using a separate long-lived, deletion-only
  HMAC capability; a public device UUID cannot delete another installation's
  data. Another button wipes all locally collected data.
- **History is local-only** with a 7-day TTL (`src/lib/history.js`), enforced
  both on read and by a periodic `alarms` sweep.

## Not present

No background tracking (statistics are opt-in, content-free and deletable), no
ad/affiliate injection, no remote code execution (no `eval`, no remotely-loaded
scripts — the remote config is signed and validated *data*, and selectors must
exactly match a compiled allowlist before reaching `querySelector`), no automatic
form submission of tests.

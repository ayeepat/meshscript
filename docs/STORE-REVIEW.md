# Store review notes — СМЭШ AI

Plain-language justification for every permission and data flow, written for a
Chrome Web Store / Opera Add-ons reviewer. Nothing here is a marketing claim —
each point maps to code in this repo.

## What the extension does

A personal homework/test assistant for the Moscow school diary **МЭШ**
(`school.mos.ru`). The user either pastes their **own** API key for an AI
provider or activates a purchased СМЭШ license (which routes through our own
proxy); the extension reads the homework on the page they are already looking
at, optionally sends it to that provider, and shows the answer. It never logs
into anything on the user's behalf and never submits a test.

## Consent gate (required before any data leaves the device)

On first run the popup shows a consent screen that states plainly that task
text, test screenshots and attached files (including audio clips sent for
transcription) go to the chosen AI provider — OpenRouter, Groq, Qwen (Alibaba)
or DeepSeek, the latter two via our proxy `ai.smeshapi.site` on the license
path. No AI request of any kind (solving, transcription) is made until the
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
| `declarativeNetRequest` | Installs one narrowly scoped **session rule** for GDZ requests (`buildGdzUaRule` / `ensureUaRule`): see below. |

## Host permissions

| Host | Why |
|---|---|
| `https://school.mos.ru/*`, `https://uchebnik.mos.ru/*` | Read the user's **own** diary/homework/test player and download attachments from the two exact Mesh origins, inside the user's already-authenticated session. Scripted child-frame capture additionally requires a positively identified test-player document; unrelated MOS frames are excluded. |
| `https://openrouter.ai/*`, `https://api.groq.com/*`, `https://dashscope-intl.aliyuncs.com/*` | The BYO-key AI providers that generate answers (OpenRouter, Groq, and Alibaba Model Studio for power users' own Qwen/DeepSeek keys). |
| `https://ai.smeshapi.site/*` | Our AI proxy for licensed users: Qwen/DeepSeek requests require the license, anonymous device id and the random one-device activation bearer; the key and public UUID alone are insufficient. Receives the same consent-gated task content as a direct provider call. |
| `https://gdz-ru.com/*`, `https://*.gdz-ru.com/*`, `https://gdz.ru/*` | Fetch ready textbook answers (GDZ) when the user pins a textbook, so common exercises don't need an AI call. |
| `https://*.smeshai.xyz/*` | One-way `GET` of a small, P-256-signed static config envelope (`extension-config.json`) used to select a pre-approved scrape selector or show an "update available" notice without a re-publish. The signature is rechecked on network and cache reads; no user data is sent. |
| `https://smeshapi.site/*` | License check (`POST /verify`, with credentials in a bounded JSON body) and, **only if the user opts in**, anonymous usage statistics (see below). |

## The declarativeNetRequest rule (the part reviewers ask about)

Before its first GDZ API/image request in each service-worker lifetime,
`src/lib/gdz-api.js` calls `chrome.declarativeNetRequest.updateSessionRules()`
with the single rule built by `src/lib/gdz-ua-rule.js`. Session rules disappear
when the browser session ends, so the worker recreates it when needed; there is
no static rule resource in the manifest.

The rule rewrites the `User-Agent` header to `okhttp/4.9.1` only when both
conditions hold: the request targets `gdz-ru.com` (including subdomains), and
the initiator is this extension's own runtime ID. It is limited to the resource
types used by extension fetches and GDZ media. The GDZ mobile API sits behind
DDoS-Guard, which returns data only to the mobile app's User-Agent; MV3
`fetch()` cannot set `User-Agent` directly, hence the rule. It does not block,
redirect, or read requests, and it cannot modify page-initiated traffic or
traffic to another host.

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

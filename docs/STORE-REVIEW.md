# Store review notes — СМЭШ AI

Plain-language justification for every permission and data flow, written for a
Chrome Web Store / Opera Add-ons reviewer. Nothing here is a marketing claim —
each point maps to code in this repo.

## What the extension does

A personal homework/test assistant for the Moscow school diary **МЭШ**
(`school.mos.ru`). Users activate a purchased СМЭШ license, which routes every
AI request through our own proxy. The extension reads the homework on the page
the user is already viewing, sends it to an AI provider, and shows the answer.
It never logs into anything on the user's behalf and never submits a test.

It is an independent product and is not affiliated with, endorsed by, or
operated by МЭШ, mos.ru, or the Moscow Department of Education. The extension
only reads pages the signed-in user opens themselves.

**Provider selection is not exposed, and this build ships no direct-to-vendor
path at all.** With `SHOW_PROVIDER_UI = false` (`src/lib/config.js`) there is no
provider picker and no field for a third-party API key, so **every** AI request
goes through `ai.smeshapi.site`. The bring-your-own-key adapters (OpenRouter,
Groq, Alibaba Model Studio) remain in the source behind that flag, but the
matching host permissions were **removed** from `manifest.json`: an unreachable
host permission is not a permission we should be asking for.
`tests/byo-provider-surface-regression.mjs` fails the build if the flag is ever
re-enabled without restoring them. The model vendor is an internal server-side
routing choice: 302.AI receives the request and forwards it to the model chain
currently selected by the operator. The privacy policy at
`smeshai.xyz/privacy` must therefore name 302.AI, explain this downstream-model
routing, and keep its current processor list accurate. The consent screen says
that homework content is sent to third-party AI services through the СМЭШ
proxy.

## Consent gate (required before any data leaves the device)

On first run the popup shows a consent screen that states plainly that task
text, test screenshots and attached files leave the device and go to
third-party AI services. All AI requests use our proxy at `ai.smeshapi.site`.
The immediate processor behind it is 302.AI; the VPS selects separate live
chains for Auto, Think, standard, vision and PDF requests. Changing that chain
does not change what data leaves the device, but the public privacy policy must
be updated before introducing a downstream processor it does not already
cover. Audio is deliberately **not** listed as an outbound category:
transcription runs on a BYO Groq key this build cannot collect, so an attached
clip never leaves the device — the provider adapters replace it with a text note
(`fileToContentPart` in `src/lib/deepseek.js`). No AI request of any
kind is made until the
user accepts (`src/lib/consent.js`; every outbound handler in
`src/background/service-worker.js` re-checks it). The shared provider and
transcription network boundaries perform one final storage-backed check
immediately before `fetch`, and a storage-change listener aborts pending work
when consent is withdrawn. Consent is reviewable and revocable in Settings →
«Конфиденциальность и данные».

## Permissions

| Permission | Why it is needed |
|---|---|
| `storage`, `unlimitedStorage` | All local: settings, API keys, the GDZ catalog cache, a **7-day** solve history and a **7-day** cache of already-solved test pages (kept so reopening the same questions does not re-bill the same completion). `unlimitedStorage` because a cached textbook catalog and inlined answer images can exceed the default quota. Nothing is synced. `chrome.storage.local` is locked to trusted contexts (`setAccessLevel`) so content scripts cannot read keys. |
| `activeTab` | On an explicit user click, screenshot the visible test page and read its text to solve it. |
| `scripting` | Inject the content script that reads the user's homework cards and fills test answers into the form fields on the Mesh page. |
| `alarms` | A periodic local-data retention sweep (history 7 d, solved-test cache 7 d, week scan 24 h, pending file handoffs 1 h). No network involved. |

## Host permissions

| Host | Why |
|---|---|
| `https://school.mos.ru/*`, `https://uchebnik.mos.ru/*` | Read the user's **own** diary/homework/test player and download attachments from the two exact Mesh origins, inside the user's already-authenticated session. Scripted child-frame capture additionally requires a positively identified test-player document; unrelated MOS frames are excluded. |
| `https://ai.smeshapi.site/*` | Our AI proxy for licensed users, and **the only origin any AI request reaches**. Requests require the license, anonymous device id and the random one-device activation bearer; the key and public UUID alone are insufficient. The VPS sends consent-gated task content to 302.AI using its currently saved model chain. |
| `https://smeshai.xyz/*` | One-way `GET` of a small, P-256-signed static config envelope (`extension-config.json`) used to select a pre-approved scrape selector or show an "update available" notice without a re-publish. The signature is rechecked on network and cache reads; no user data is sent. Apex only — the site 301s `www.` to apex and the fetch refuses redirects. Normal links to the public site do not need host access. |
| `https://smeshapi.site/*` | License check (`POST /verify`, with credentials in a bounded JSON body), the GDZ proxy (`POST /gdz/fetch`, see below) and, **only if the user opts in**, anonymous usage statistics (see below). |

## Optional host permissions — solving on other sites

| Optional host | Why |
|---|---|
| `http://*/*`, `https://*/*` | Requested **one site at a time**, never at install, so a student can also solve a quiz or an exercise that is not on Mesh. |

This is the only broad pattern in the manifest and it is deliberately
`optional_host_permissions`: **nothing is granted at install time**, the install
prompt is unchanged, and the extension has no access to any site the user has
not personally approved in Chrome's own dialog.

How it works, and the limits that are enforced in code (see
`src/lib/web-solve.js` and `tests/web-solve-regression.mjs`):

- The student opens a page, clicks the toolbar icon and presses «Разрешить на
  этом сайте». The extension requests **that one origin** (`https://host/*`),
  not the broad pattern. Granting an origin is what registers the in-page
  «Решить» button there (`chrome.scripting.registerContentScripts`); revoking it
  unregisters it. Every granted site is listed, and revocable, in Settings →
  «Решение на других сайтах».
- Only the **top-level document** of a granted page is ever read or filled.
  Child frames are excluded by construction, so a third-party iframe on a
  granted page can neither contribute text to a request nor receive an autofill,
  and cannot send the extension any privileged message.
- The page is read through a bounded content extractor that keeps the question
  and drops site furniture, capped at ~10 000 characters. **No screenshot is
  taken on this path** — an in-page click confers no `activeTab`.
- The floating button does not appear on every page of a granted site: a scored
  heuristic has to recognise a question or an answer form first.
- Mesh and our own hosts are excluded from this machinery entirely, so the
  school flow cannot be redirected through it.
- These pages are answered on the cheaper model chain at low reasoning effort;
  the school allowance is not spent on them.

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

- **AI providers** receive task text / screenshots / attachments over HTTPS,
  always through the СМЭШ proxy and authenticated with the license key. Audio
  clips are the one attachment type that never leaves the device in this build
  (see the consent section above). This is the core function and is gated by
  consent. Nothing leaves the
  device during a passive week scan: whether a homework card needs a file is
  decided on-device by regex heuristics (`src/lib/task-classifier.js`), and the
  first network request for a row happens only after the user presses «Решить»
  on that row.
- **The Mesh session token** is read from the page's own `localStorage` solely
  to download the user's own attachments. Downloads are restricted to an
  explicit `school.mos.ru`/`uchebnik.mos.ru` allowlist (HTTPS only, redirects
  re-validated hop by hop) and the token is never sent anywhere else.
- **Pseudonymous usage statistics are covered by the single consent tick.** The
  separate «Анонимная статистика» toggle was removed: accepting the terms and
  privacy policy is what enables statistics, and declining or withdrawing that
  consent stops them (`src/lib/consent.js` writes `telemetryEnabled` alongside
  the consent record; `src/lib/telemetry.js` still checks both at flush time).
  Nothing is sent before that acceptance. The linked terms and privacy policy
  are therefore the disclosure surface — the extension UI no longer enumerates
  what is collected. While consent stands,
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

No background tracking (statistics require the user's acceptance, are
content-free and deletable), no
ad/affiliate injection, no remote code execution (no `eval`, no remotely-loaded
scripts — the remote config is signed and validated *data*, and selectors must
exactly match a compiled allowlist before reaching `querySelector`), no automatic
form submission of tests.

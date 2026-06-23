# Store review notes — СМЭШ AI

Plain-language justification for every permission and data flow, written for a
Chrome Web Store / Opera Add-ons reviewer. Nothing here is a marketing claim —
each point maps to code in this repo.

## What the extension does

A personal homework/test assistant for the Moscow school diary **МЭШ**
(`school.mos.ru`). The user pastes their **own** API key for an AI provider; the
extension reads the homework on the page they are already looking at, optionally
sends it to that provider, and shows the answer. It never logs into anything on
the user's behalf and never submits a test.

## Consent gate (required before any data leaves the device)

On first run the popup shows a consent screen that states plainly that task text,
test screenshots and attached files are sent to the chosen AI provider. No AI
request is made until the user accepts (`src/lib/consent.js`, enforced again
server-side-of-the-extension in `src/background/service-worker.js`). Consent is
reviewable and revocable in Settings → «Конфиденциальность и данные».

## Permissions

| Permission | Why it is needed |
|---|---|
| `storage`, `unlimitedStorage` | All local: settings, API keys, the GDZ catalog cache, and a **7-day** solve history. `unlimitedStorage` because a cached textbook catalog and inlined answer images can exceed the default quota. Nothing is synced. |
| `activeTab` | On an explicit user click, screenshot the visible test page and read its text to solve it. |
| `scripting` | Inject the content script that reads the user's homework cards and fills test answers into the form fields on the Mesh page. |
| `declarativeNetRequest` | One static rule only (`src/rules/gdz-ua.json`): see below. |

## Host permissions

| Host | Why |
|---|---|
| `https://school.mos.ru/*`, `https://*.mos.ru/*` | Read the user's **own** diary/homework and download attachments from the Mesh file store, inside the user's already-authenticated session. |
| `https://openrouter.ai/*`, `https://api.groq.com/*` | The AI providers that generate answers. The user supplies their own key. |
| `https://gdz-ru.com/*`, `https://*.gdz-ru.com/*`, `https://gdz.ru/*` | Fetch ready textbook answers (GDZ) when the user pins a textbook, so common exercises don't need an AI call. |
| `https://*.smeshai.xyz/*` | One-way `GET` of a small static config file (`extension-config.json`) used to hot-fix a scrape selector or show an "update available" notice without a re-publish. Sends no user data. |

## The declarativeNetRequest rule (the part reviewers ask about)

`src/rules/gdz-ua.json` contains **one** static rule. It rewrites the
`User-Agent` header to `okhttp/4.9.1` **only on requests to `gdz-ru.com`**. The
GDZ mobile API sits behind DDoS-Guard, which returns data only to the mobile
app's User-Agent; MV3 `fetch()` cannot set `User-Agent` directly, hence the rule.
It does **not** block, redirect, or read any request, and it touches **no other
host**. There is no dynamic rule generation.

## Data handling

- **AI providers** receive task text / screenshots / attachments over HTTPS,
  authenticated with the user's own key. This is the core function and is gated
  by consent.
- **The Mesh session token** is read from the page's own `localStorage` solely
  to download the user's own attachments. It is **host-gated** to `*.mos.ru`
  (`isMeshHost` in `service-worker.js`) and is never sent anywhere else.
- **No analytics, no tracking, no third-party telemetry.** The optional license
  backend only ever sees a license key + an anonymous random device UUID. The
  remote runtime-config (`src/lib/remote-config.js`) is a one-way `GET` of a
  static JSON file and sends no user data.
- **History is local-only** with a 7-day TTL (`src/lib/history.js`).

## Not present

No background tracking, no ad/affiliate injection, no remote code execution
(no `eval`, no remotely-loaded scripts — the remote config is validated *data*,
only ever passed to `querySelector`), no automatic form submission of tests.

# СМЭШ AI

Manifest V3 Chrome extension: a personal homework assistant for the Mesh
(`school.mos.ru`) platform. Scans the homeworks page, detects subjects with
robust DOM traversal (no hardcoded MUI class names), and solves tasks using
subject-aware prompts. Two AI providers: **OpenRouter** (paid, Gemini 2.5 Flash
— the main solver, answers stream token-by-token) and **Groq** (free — used for
menial tasks like classification). Solve history is stored locally in the
browser (`chrome.storage.local`) with a 7-day TTL — no backend, no account, no
shared keys. No login automation — it works inside your already logged-in
browser session, which also lets it **auto-fetch homework attachments**
straight from Mesh.

## File structure

```
manifest.json
src/
  content/scraper.js          # DOM scraping, pattern/vocabulary based
  popup/                      # week of homework (collapsible days) + Solve + file upload
  dashboard/                  # full-window solve view; sidebar = week's lessons
  settings/                   # keys, editable prompts, history viewer
  background/service-worker.js# AI provider orchestration (+ streaming port)
  lib/                        # ai.js, openrouter.js, groq.js, http.js, history.js, prompts.js,
                              #   subject-router.js, gdz-api.js, gdz-match.js
  rules/gdz-ua.json           # DNR rule: rewrites UA on gdz-ru.com requests
assets/icons/                 # icon16/48/128.png
assets/fonts/                 # Manrope (woff2)
```

## Setup — exactly what YOU must do

### 1. Get the AI provider keys
- **OpenRouter** (main solver): https://openrouter.ai/keys → create a key
  (`sk-or-v1-…`). This is the paid provider — keep usage to actual solves.
- **Groq** (free, no card): https://console.groq.com/keys → create a key
  (`gsk_…`). Used for cheap/menial tasks (task classification). Optional but
  recommended; without it those tasks fall back to local heuristics.

### 2. Load the extension in Chrome
1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this project folder.

### 3. Configure keys
1. Click the extension icon → the **⚙️ gear** (opens Settings), or right-click
   the icon → **Options**.
2. Paste **OpenRouter API Key** and **Groq API Key**, and pick the provider.
3. (Optional) Edit the base prompt for any subject category.
4. Click **Сохранить** (Save).

### 4. Use it
1. Log into Mesh and open `school.mos.ru/diary/homeworks/homeworks`.
2. Click the extension icon. It scans the whole visible week of homework;
   each day is a collapsible section (the nearest day starts expanded).
   For in-app Mesh tests, open the test page, switch the popup to the
   **Тест** tab and press the button: the extension screenshots the visible
   screen + extracts the page text and replies with question numbers and
   answers only (no explanations). Scroll to the next question and press
   again. Test answers are not persisted.
3. Press **Solve** on a subject to open the full-window dashboard. The
   sidebar lists every lesson of the week — click one to solve it (the AI
   is only called when you open a lesson, and each lesson keeps its own
   chat while the tab is open). Solve history (7-day TTL) is viewable in
   Settings, not in the sidebar.

## Notes & trade-offs
- **Local-only history.** Solve history lives in `chrome.storage.local` with a
  7-day TTL, scoped to this browser profile. No backend, no shared keys, no
  account — clearing extension data or reinstalling wipes it.
- **Auto-fetch attachments.** For tasks that reference a file ("сделать из
  прикреплённого файла"), the popup pulls the file straight from your logged-in
  Mesh session and attaches it automatically — no manual download. It falls
  back to manual upload if nothing is found. The discovery call hits the
  verified `lesson_schedule_items/<id>` family-API endpoint (with the Bearer
  token + `X-mes-*` headers) in `src/content/scraper.js`; the files live on
  `school.mos.ru/ej/attachments/...` and are pulled by the service worker.
- **Streaming answers.** The dashboard solve streams tokens live over a
  `chrome.runtime` port (OpenRouter/Groq SSE). The popup test solver stays a
  single round-trip.
- **Answer mode.** A Кратко/Объяснить toggle in the dashboard header switches
  between a concise worked answer (still shows steps) and a full tutor-style
  explanation.
- **Paste images.** In the dashboard composer, Ctrl/⌘+V pastes a screenshot or
  snipped photo of a textbook page directly into the chat.
- **Friendly errors.** Bad key / no credit / rate-limit failures surface as a
  short Russian message instead of a raw provider dump (see `src/lib/http.js`).
- **GDZ catalog (ready-made answers).** In Settings → **Каталог ГДЗ** you pick a
  grade and add the textbooks / workbooks for your subjects. After that, tasks
  like «упр. 25» or «Р.т. с. 74» get the matching GDZ answer images pulled in
  automatically instead of prompting for a photo. It talks to the gdz.ru
  mobile-app backend (not the JS-challenged public site): a `declarativeNetRequest`
  rule (`src/rules/gdz-ua.json`) rewrites the User-Agent to the `okhttp` UA that
  DDoS-Guard allowlists, since MV3 `fetch()` can't set it. The catalog is cached
  (7-day TTL) and resolved tasks are cached per book + number, so it's zero AI
  cost after the first catalog fetch (`src/lib/gdz-api.js`, `src/lib/gdz-match.js`).
- **Popup file uploads** attached next to a task are handed to the dashboard
  and included with the lesson's first AI message.
- **Russian language guard:** a bare “Упр. 25” with no uploaded page photo makes
  the assistant ask for a photo instead of inventing the exercise text.

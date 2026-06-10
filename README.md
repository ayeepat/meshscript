# meshscript

Manifest V3 Chrome extension: a personal homework assistant for the Mesh
(`school.mos.ru`) platform. Scans the homeworks page, detects subjects with
robust DOM traversal (no hardcoded MUI class names), and solves tasks with the
Gemini API using subject-aware prompts. Solve history is stored in Supabase
with a 7-day TTL. No login automation — it works inside your already logged-in
browser session.

## File structure

```
manifest.json
src/
  content/scraper.js          # DOM scraping, pattern/vocabulary based
  popup/                      # subject list + Solve + file upload
  dashboard/                  # full-window solve view with sidebar history
  settings/                   # keys, editable prompts, history viewer
  background/service-worker.js# Gemini + GDZ fallback + Supabase orchestration
  lib/                        # gemini.js, supabase.js, prompts.js, subject-router.js
supabase/schema.sql           # tables + pg_cron 7-day auto-delete
assets/icons/                 # icon16/48/128.png (you add these)
```

## Setup — exactly what YOU must do

### 1. Add icons
Put `icon16.png`, `icon48.png`, `icon128.png` in `assets/icons/`. Any square
PNGs work. (Chrome refuses to load the extension if these are missing.)

### 2. Create the Supabase project + run the schema
1. Go to https://supabase.com, create a project (free tier is fine).
2. Open **SQL Editor** and paste the entire contents of `supabase/schema.sql`,
   then **Run**.
3. `pg_cron` is supported on Supabase. If `create extension pg_cron` errors,
   enable it under **Database → Extensions** (search `pg_cron`, toggle on),
   then re-run only the `cron.schedule(...)` line.
4. From **Project Settings → API**, copy the **Project URL** and the **anon
   public** key. You will paste these into the extension Settings.

### 3. Get a Gemini API key
1. Go to https://aistudio.google.com/app/apikey (Google AI Studio).
2. Click **Create API key**, copy it.

### 4. Load the extension in Chrome
1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this project folder.

### 5. Configure keys
1. Click the extension icon → the **⚙️ gear** (opens Settings), or right-click
   the icon → **Options**.
2. Paste **Gemini API Key**, **Supabase URL**, **Supabase anon key**.
3. (Optional) Edit the base prompt for any subject category.
4. Click **Сохранить** (Save).

### 6. Use it
1. Log into Mesh and open `school.mos.ru/diary/homeworks/homeworks`.
2. Click the extension icon. It scans the next upcoming day with homework.
3. Press **Solve** on a subject to open the full-window dashboard, or upload a
   file where prompted (PDF / Word / screenshot).

## Notes & trade-offs
- **No auth.** Rows are scoped by an anonymous `device_id`. With the anon key +
  permissive RLS, anyone with the key could access data. Fine for a private
  2–3 user tool; do not publish the anon key.
- **GDZ fallback** is best-effort only. GDZ/reshebnik sites are Cloudflare
  protected and usually block cross-origin fetches, so the reliable path is
  Gemini-direct. See comments in `service-worker.js`.
- **Russian language guard:** a bare “Упр. 25” with no uploaded page photo makes
  the assistant ask for a photo instead of inventing the exercise text.

# Chrome Web Store submission — СМЭШ AI 1.0.0

This file is the copy-and-paste source for the Chrome Developer Dashboard. It
matches `manifest.json`, the consent screen, and `docs/STORE-REVIEW.md`.

## Package

Run:

```sh
npm run verify
npm run package:extension
npm run verify:package
```

Upload `smesh-ai-chrome-v1.0.0.zip`. The package is deterministic and contains
only `manifest.json`, the extension runtime, bundled fonts, and icons.

## Product details

**Language:** Russian

**Category:** Education

**Name:** СМЭШ AI

**Summary (from the manifest, 86 characters):**

> Личный ИИ-помощник по домашним заданиям для электронного дневника МЭШ (school.mos.ru).

**Detailed description:**

> СМЭШ AI читает домашнее задание на открытой странице электронного дневника МЭШ и показывает ответ в отдельной вкладке. Условие не нужно копировать вручную.
>
> Что умеет расширение:
>
> • собирает домашние задания за видимую неделю и группирует их по дням;
> • объясняет решение или даёт короткий ответ;
> • работает с прикреплёнными файлами, изображениями и PDF;
> • помогает с тестами МЭШ: распознаёт видимый вопрос, показывает ответы и может заполнить поля по команде пользователя;
> • хранит историю решений локально в браузере в течение 7 дней;
> • подбирает готовые ответы из добавленных пользователем учебников и рабочих тетрадей.
>
> Задания на аудирование расширение не решает по звуку: пришлите расшифровку записи текстом.
>
> Расширение работает внутри уже открытой сессии электронного дневника. Оно не получает логин или пароль, не входит в аккаунт и не нажимает кнопку отправки теста.
>
> СМЭШ AI — независимый продукт. Он не связан ни с одним электронным журналом и не является чьим-либо официальным сервисом.
>
> Перед первым запросом СМЭШ AI просит принять условия использования и политику конфиденциальности. Только после этого текст задания, скриншот или выбранный файл отправляется ИИ-сервису через сервер СМЭШ. Тем же согласием покрывается анонимная статистика без содержимого заданий; отключить её и удалить собранные данные можно кнопкой в настройках.
>
> Для ответов нужен ключ доступа СМЭШ. Тарифы, инструкция и поддержка: https://smeshai.xyz/
>
> Ответы создаёт ИИ. Проверяйте важные вычисления и формулировки по учебнику или у преподавателя.

## Graphic assets

- Store icon: `assets/icons/icon128.png` — 128×128 PNG.
- Screenshot 1: `store-assets/screenshots/01-homework-popup.png` — 1280×800.
- Screenshot 2: `store-assets/screenshots/02-test-answers.png` — 1280×800.
- Screenshot 3: `store-assets/screenshots/03-pdf-solution.png` — 1280×800.
- Screenshot 4: `store-assets/screenshots/04-gdz-solution.png` — 1280×800.
- Small promo tile: `store-assets/promo/small-tile-440x280.png`.
- Marquee promo tile: `store-assets/promo/marquee-1400x560.png` (optional).

The screenshots are frames from the real product recordings in `motion/public`.
They contain no invented review score, install count, testimonial, or store
badge.

⚠️ **Three asset problems are still open and must be resolved before upload:**

- `02-test-answers.png` shows a live МЭШ account identifier («Личный кабинет
  ID: …») in the top-right corner. Redact it — it is another person's account
  number on a public listing.
- `04-gdz-solution.png` reproduces a watermarked gdz.ru answer scan of a
  copyrighted textbook. Using a publisher's page as our own marketing image
  invites a takedown; replace or drop the screenshot.
- `03-pdf-solution.png` opens with «Не могу прослушать аудио…», so the first
  line a shopper reads is a limitation. Recapture or drop it.
- The promo tiles read «СМЭШ · Помощник электронного журнала», which matches
  neither the listing name («СМЭШ AI») nor the manifest summary. Align the
  wording when the tiles are redrawn.

## URLs

- Homepage: `https://smeshai.xyz/`
- Privacy policy: `https://smeshai.xyz/privacy`
- Support: `https://t.me/smeshaibot?start=support`
- Terms: `https://smeshai.xyz/terms`
- Official URL: verify `smeshai.xyz` in Google Search Console, then select it
  in the dashboard.

## Privacy practices

**Single purpose:**

> Помогать пользователю решать домашние задания и тесты на открытых им страницах электронного дневника МЭШ с помощью ИИ.

**Remote code:**

> No, this extension does not use remote code. All executable JavaScript and CSS is included in the submitted package. The extension downloads only data: AI responses, licensed API responses, and a signed configuration envelope whose values are restricted to compiled allowlists.

### Permission justifications

**storage**

> Stores the user's settings, consent, license state, selected textbooks, short-lived attachment handoffs, and 7-day solution history locally. The extension does not use sync storage.

**unlimitedStorage**

> The local textbook catalog and solution history can contain inlined answer images and exceed Chrome storage.local's ordinary quota. This permission prevents silent loss of user-requested local data.

**activeTab**

> After the user presses “Решить тест”, captures only the active school.mos.ru or uchebnik.mos.ru test tab. Code rejects every other origin before capture.

**scripting**

> Reads visible homework/test content and fills test fields only on the two declared МЭШ origins, after a user action. It never submits a test.

**alarms**

> Runs local retention cleanup for 7-day history, 24-hour week scans, and 1-hour pending file handoffs. It also retries a pending referral-code sync after a transient failure.

**Host permissions**

> school.mos.ru and uchebnik.mos.ru are the two diary surfaces the user asks the extension to read. smeshapi.site verifies licenses, proxies textbook answers, and receives content-free telemetry covered by the same acceptance that gates every AI request. ai.smeshapi.site is the only origin that answers AI requests. smeshai.xyz serves a signed, data-only runtime configuration over a single GET. The extension requests no AI-vendor origins: every model call is proxied.

### Data-use disclosures

Select the dashboard categories that correspond to these flows:

- **Website content:** homework text, visible test text/screenshots, and files the
  user explicitly asks the extension to solve. Used only to produce the answer.
- **Authentication information:** the СМЭШ license key, one-device activation
  credential, and any provider key retained by an older installation. Stored in
  trusted extension storage and sent only to the service that verifies or uses it.
- **User activity:** only if the user separately enables anonymous statistics.
  Events contain action type, canonical subject, provider/model, browser family,
  extension version, license type, and a random device UUID. They never contain
  homework text, answers, files, the license key, or financial totals.

Do not select financial/payment information, health information, precise
location, personal communications, or web history: the extension does not
collect those categories. Payment happens on the separate website, not in the
extension.

**Child-audience declaration.** The dashboard asks whether the item is directed
to children. The audience is Russian schoolchildren, so this cannot be answered
by reflex: the extension stores a random device UUID and offers an off-by-default
analytics toggle, which is what the question is actually about. Decide the answer
together with the same counsel who signs off the Russian age label below, and
keep the two answers consistent.

Certify all Limited Use statements. The data is used for the visible homework
assistant, its security, and optional aggregate product analytics. It is not
sold, used for advertising, or used for credit decisions.

## Reviewer instructions

This item needs test instructions because the main features require both a
valid СМЭШ license and access to a МЭШ diary/test page.

**Steps:**

1. Install the extension. Chrome opens the onboarding tour
   (`src/welcome/welcome.html`) in a full tab: six Russian steps ending on ГДЗ,
   with the price and the working `https://smeshai.xyz/` link on step 2. It is
   shown once per device — the ✕ confirms before dismissing it, and reopening
   the extension afterwards goes straight to the popup.
2. Open the toolbar popup. It shows the consent and license screen.
3. Enter the reviewer license below, accept the disclosure, and press «Начать».
4. Sign in with the reviewer МЭШ account below and open
   `https://school.mos.ru/diary/homeworks/homeworks`.
5. Open the extension, select a homework row, and press «Решить».
6. For the test flow, open a test on school.mos.ru or uchebnik.mos.ru, choose
   «Тест» in the popup, and press «Решить тест». The extension will not submit.
7. Open Settings → «Конфиденциальность и данные» to inspect consent withdrawal,
   statistics withdrawal, and local-data deletion.

**REQUIRED BEFORE SUBMISSION — replace these lines in the dashboard, not in the extension package:**

- Reviewer license: `[ISSUE A LONG-LIVED REVIEW-ONLY SMESH KEY]`
- Reviewer МЭШ login: `[PROVIDE A NON-PERSONAL TEST ACCOUNT — SEE THE WARNING BELOW]`
- Reviewer МЭШ password: `[PROVIDE THE TEST ACCOUNT PASSWORD]`
- Any extra navigation note: `[ADD ONLY IF THE TEST CONTENT IS NOT IMMEDIATELY VISIBLE]`

⚠️ **Steps 4–6 depend on a МЭШ account, and those are issued by the Moscow
Department of Education to enrolled pupils.** There may be no account you can
lawfully hand to a Google reviewer, and an item a reviewer cannot exercise is
commonly rejected as unverifiable. Decide this before submitting, not after the
first rejection. In order of preference:

1. Obtain a genuine non-personal demo/teacher account if the department issues
   one, and say in the notes that it contains no real pupil data.
2. Otherwise, host an unlisted screen recording that walks all seven steps
   end to end, link it in the reviewer notes, and state plainly that МЭШ
   credentials cannot be shared because they identify a real minor.
   Steps 1–3 and 7 (install, welcome page, consent, licence, privacy controls)
   still work with no МЭШ account at all — say so explicitly, so the reviewer
   knows how much they can verify directly.

## Russian-market compliance sign-off

These are human/account-level checks and cannot be proven by the extension ZIP.
Complete them before sending public traffic to the paid product:

- Confirm that the seller/contractor details shown on the live site, agreement,
  Robokassa shop, receipts, and support channel all identify the same party.
- Have Russian counsel confirm the current personal-data operator notification,
  Russian primary-storage setup, and any required cross-border-transfer filings
  for the AI and infrastructure recipients named in the privacy policy.
- Have the accountant confirm the Robokassa fiscalization mode and receipt
  values (`sno`, tax, payment method, payment object), including the current
  requirements for online-payment receipts.
- In production, complete one real low-value purchase and one refund. Verify the
  signed callback, license delivery and revocation, fiscal receipts, and the
  reconciliation/admin-health queues end to end.
- Confirm that the public agreement and cancellation/refund process match the
  actual license product, and record the age-label decision for this
  school-oriented service.
- Apply the current Russian internet-ad labeling process to any paid launch
  placements; the Chrome Web Store listing copy must remain factual and
  evidence-backed.

This is a release-control checklist, not legal or tax sign-off. The operator,
data-transfer, consumer-term, receipt, and age-label decisions should be
confirmed for the actual business entity and production architecture.

## Production prerequisites (verify by curl, not by memory)

The extension ZIP can be perfect while the services behind it are not. Re-run
these checks before every submission — a green test suite says nothing about
what is actually deployed.

- [x] **Deploy the current AI proxy.** `GET https://ai.smeshapi.site/ready` must
      return `ok:true` with all three checks true. **Done 2026-08-27** — the box
      had been running the 11 July build for six weeks, missing the +2034/−228
      rewrite, so every `vps-*` regression was green about code that was not
      serving traffic. Re-deploy by re-running the installer (see
      `backend-vps/README.md` step 7), never by copying `server.js` alone.
      `/health` is liveness only and returns `ok:true` even on a stale build —
      `/ready` is the gate, because it is the endpoint a stale build lacks.
- [ ] **Optional: publish the signed runtime config.** Not a launch blocker —
      `getRuntimeConfig()` is fail-open, so a 404 changes nothing for users. It
      buys the ability to fix a МЭШ DOM change, post a notice, or set
      `minExtensionVersion` *without* waiting on a store review. Publish at the
      **apex** (`www.` 301s there and the fetch refuses redirects). Signed
      envelopes expire after 7 days, so only turn this on alongside a re-signing
      job — see `docs/RUNTIME-CONFIG.md`.
- [ ] **Confirm the license backend.** `POST https://smeshapi.site/verify` with a
      junk key must answer a structured JSON error, and `GET /health` must report
      `maintenance:false`.

## Final publisher checklist

- [ ] Register the developer account and enable two-step verification.
- [ ] Verify ownership of `smeshai.xyz` in Google Search Console.
- [ ] Clear the production prerequisites above.
- [ ] Resolve the three open screenshot/promo problems listed under "Graphic assets".
- [ ] Decide the reviewer-access plan for the МЭШ-dependent steps (see the warning in "Reviewer instructions").
- [ ] Confirm the live privacy and terms URLs match the disclosures above.
- [ ] Complete the Russian-market compliance sign-off above with counsel and the accountant.
- [ ] Issue the review-only license and non-personal МЭШ test account.
- [ ] Upload the verified ZIP and the store assets listed above.
- [ ] Paste the listing, permission, data-use, and reviewer text from this file.
- [ ] Choose Russian, Education, and the intended distribution regions.
- [ ] Select deferred publishing so approval does not publish before the launch check.
- [ ] After approval, install the staged item in a clean Chrome profile and run the seven reviewer steps once more.

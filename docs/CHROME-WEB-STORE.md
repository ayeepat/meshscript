# Chrome Web Store submission — СМЭШ AI 1.0.0

Copy source for the Chrome Developer Dashboard. It must be rechecked against
manifest.json, docs/STORE-REVIEW.md and the live legal pages before submission.

## Package

~~~sh
npm run verify
npm run package:extension
npm run verify:package
~~~

Upload smesh-ai-chrome-v1.0.0.zip.

## Product details

Language: Russian

Category: Education

Name: СМЭШ AI

Summary:

> Личный ИИ-помощник по домашним заданиям для электронного журнала школьника.

Detailed description:

> СМЭШ AI читает выбранное домашнее задание или тест на открытой пользователем
> странице электронного журнала и показывает разбор в отдельной вкладке.
>
> Расширение собирает задания за видимую неделю, объясняет решения, работает с
> выбранными изображениями, PDF и вложениями, предлагает ответы на видимый тест
> и может заполнить поля только по команде пользователя. Оно не нажимает кнопку
> отправки. История решений хранится только в браузере 7 дней.
>
> Расширение работает внутри уже открытой сессии: оно не получает логин или
> пароль и не входит в аккаунт. Вложение загружается только после выбора
> задания; сессионный токен используется один раз в памяти и не отправляется
> серверам СМЭШ или AI-провайдерам.
>
> Перед первым AI-запросом пользователь отдельно подтверждает условия,
> AI-обработку и правомерность использования сервиса. Необязательная телеметрия
> без содержимого выключена по умолчанию и не влияет на доступ к функциям.
>
> Выбранный текст, снимок или файл передаётся через защищённый прокси СМЭШ к
> одному из публично зарегистрированных AI-процессоров. Для ответов нужен ключ
> доступа СМЭШ. СМЭШ AI — независимый продукт и не является официальным
> сервисом электронного журнала.
>
> Ответ создаёт искусственный интеллект и он может ошибаться. Проверяйте важные
> вычисления и формулировки.

## URLs

- Homepage: https://smeshai.xyz/
- Privacy: https://smeshai.xyz/privacy/
- Terms: https://smeshai.xyz/agreement/
- AI processors: https://smeshai.xyz/processors/
- Support: https://t.me/smeshaibot?start=support

## Assets

- Icon: assets/icons/icon128.png
- Screenshots: store-assets/screenshots/
- Promo tiles: store-assets/promo/

Publish only images captured from the current product, with no real account
identifiers, personal data, misleading metrics or third-party copyrighted
answer scans. Product name and claims must match the listing.

## Single purpose

> Помогать пользователю разбирать домашние задания и тесты на открытых им
> страницах с помощью искусственного интеллекта.

## Remote code

Select No.

> All executable JavaScript and CSS is packaged with the extension. Network
> responses are data only: license/API results, AI output and a signed runtime
> configuration restricted to compiled feature fields. No remote script is
> evaluated.

## Permission justifications

storage / unlimitedStorage:

> Stores local settings, independent consent choices, license state, selected
> textbooks, temporary attachment handoffs and 7-day solution history. Sync is
> not used. Images can exceed the ordinary local-storage quota.

activeTab:

> After an explicit user action, captures the visible electronic-journal test
> tab. Other origins are rejected before capture.

scripting:

> Reads visible homework/test fields and fills suggested answers only after a
> user action. The extension never submits the test.

alarms:

> Runs local retention cleanup for history, week scans and temporary handoffs.

Host permissions:

> The declared journal origins let the extension read the user's open page and
> download a selected attachment inside the existing session. smeshapi.site
> verifies licenses, receives minimal consent receipts, proxies allowlisted GDZ
> references and receives optional content-free telemetry. ai.smeshapi.site is
> the only AI gateway and receives a short-lived entitlement instead of a raw
> license key. smeshai.xyz hosts product/legal pages.

Optional host permissions:

> Nothing is granted at install. If the user wants help on another site, Chrome
> asks them to approve that one exact origin. The extension reads bounded
> top-level visible text only, excludes child frames, takes no screenshot on
> this path, never submits the form and lets the user revoke access.

## Data-use disclosures

Website content:

> Selected homework/test text, visible screenshot and user-selected attachment
> are used only to produce the requested answer.

Authentication information:

> The СМЭШ license and one-device activation credential are sent only to the
> license service. The AI gateway receives a 10-minute signed entitlement, not
> the raw credentials.

User activity:

> Only after a separate optional opt-in. Bounded events may include action,
> canonical subject, processor/model, browser family, extension version,
> license type, random device UUID and server-observed token/cost counts. Never
> task text, answers, files, license keys or payment details.

Do not select financial/card details, health, precise location, personal
communications or browsing history for the extension. Payment is a separate
website flow and the extension does not receive full card data.

Certify the Limited Use statements only after confirming the current package
matches these disclosures. Data is not sold, used for advertising or used for
credit decisions.

## Children/audience

The product is likely to be accessed by schoolchildren. Answer the dashboard's
child-audience question accordingly and keep it consistent with the privacy
policy. The product asks for a legal-permission/parental-permission attestation
but does not verify age or collect a child's email/document; do not describe
that checkbox as verified parental consent.

## Reviewer instructions

1. Install the extension and finish the onboarding page.
2. Open the popup.
3. Check the three required confirmations; leave telemetry off to verify it is
   optional.
4. Enter the review-only license and press «Начать».
5. Open the supplied non-personal journal test account and select one task.
6. Start a solution; for a test, verify that fields are filled only on command
   and the form is not submitted.
7. Open Settings and verify independent consent/telemetry controls and local
   data deletion.

Dashboard-only reviewer data:

- Review license: [ISSUE A REVIEW-ONLY KEY]
- Non-personal test account login: [ADD IF LAWFULLY SHAREABLE]
- Test account password: [ADD IF LAWFULLY SHAREABLE]
- Screen-recording URL: [USE WHEN JOURNAL CREDENTIALS CANNOT BE SHARED]

Do not put live pupil credentials in the submission. A screen recording can
cover the journal-only steps while the reviewer directly verifies installation,
consent, settings and license behavior.

## Final publisher checklist

- npm run verify and package verification pass.
- Live privacy, agreement, AI and processors pages return 200.
- Three required choices are independent; telemetry starts unchecked.
- Raw license/activation credentials do not enter the AI inference request.
- Journal session token is absent from popup, backend and logs.
- Processor register equals the enabled server routing allowlist.
- All eight kill switches are tested from smeshaidashboard.
- Cloudflare Observability/Logpush/Analytics and APM/crash content capture are
  disabled; Caddy has no access log.
- Roskomnadzor operator and separate cross-border notices have been reviewed.
- Seller identity, Robokassa shop, receipt configuration, prices, refunds and
  support contact agree.
- Review assets contain no personal data or unlicensed third-party material.

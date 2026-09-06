# Store review notes — СМЭШ AI

Brief factual map for browser-extension reviewers. The single purpose is to
help a user understand and answer homework or tests on a page they opened. The
extension does not sign in, collect journal credentials or submit a test.

СМЭШ AI is independent and is not affiliated with the electronic-journal
operator or a government body.

## User controls

Before the first AI request, the user separately confirms:

1. the terms and privacy policy;
2. processing of the selected task by third-party AI processors;
3. legal permission to use the service and, where required, permission from a
   parent or legal representative.

Telemetry is a fourth, optional choice and is off by default. Declining it does
not block AI. Consent can be changed in Settings. A minimal pseudonymous receipt
is sent only after a valid license check; it contains no task, answer, file or
raw license key.

Independent signed switches can disable AI text, images, documents, journal
attachments, autofill, other-site solving, telemetry and GDZ without an
extension release.

## Permissions

| Permission | Justification |
| --- | --- |
| `storage` | Local settings, consent choices, license state, textbook cache, temporary handoffs and 7-day solution history. No sync storage. |
| `unlimitedStorage` | User-selected images and short-lived local handoffs can exceed the ordinary local quota. |
| `activeTab` | After an explicit click, capture the visible electronic-journal test page. Non-journal origins are rejected before capture. |
| `scripting` | Read visible homework/test fields and, only on command, fill suggested answers. The extension never submits the form. |
| `alarms` | Local retention cleanup for history, week scans and temporary handoffs. |

## Host permissions

| Host | Justification |
| --- | --- |
| Declared electronic-journal origins | Read the signed-in user's open page and download an attachment the user selected. The one-time journal session token stays in memory inside the service worker, is limited to the two declared journal hosts, and never reaches popup, backend or logs. Redirects are checked again. |
| https://smeshapi.site/* | Verify/deactivate licenses, submit minimal consent receipts, retrieve allowlisted GDZ references and, only after separate opt-in, send content-free telemetry. |
| https://ai.smeshapi.site/* | Start/poll/cancel AI work and upload bounded chunks. The gateway receives a 10-minute entitlement, not the raw license key or activation token. |
| https://smeshai.xyz/* | Product/legal pages and data-only configuration. Runtime feature configuration comes from the AI gateway as a signed P-256 envelope; no task content is attached to its GET. |

## Optional host permissions

The manifest declares http://*/* and https://*/* only as optional permissions.
Nothing is granted at install. A user must approve one exact origin in Chrome's
own dialog, can revoke it later, and sees the registered site in Settings.

On an approved non-journal site the extension reads bounded visible text and
form labels from the top-level document only. It does not read child frames,
take a screenshot, submit a form, or access a site that the user did not
approve.

## Cloud AI

A request starts only after the user selects a task and the three required
confirmations are present. The selected task text and only necessary
user-selected screenshot/file go:

extension → ai.smeshapi.site → 302.AI → one enabled processor.

The current public register is https://smeshai.xyz/processors/. The server
rejects a routed model unless its processor record is present and enabled.
Users do not supply vendor API keys, and the extension has no AI-vendor host
permissions.

The AI gateway keeps content only in bounded transient memory while the job is
active. Application/access/APM/crash logs must not contain prompts, answers,
files, entitlement tokens or journal tokens.

## Data disclosures

Select the store categories that cover:

- Website content: selected task text, visible test screenshot and selected
  attachment, used only to produce the requested answer.
- Authentication information: the СМЭШ license and device activation data,
  used only with the license service. AI processors receive only the
  short-lived entitlement at the СМЭШ gateway, not those raw credentials.
- User activity: only for separate optional telemetry. Events contain bounded
  action/model/browser/version/license-type/device fields and server-observed
  token/cost counts. No task content, answer, file, license key or payment data.

Payment happens on the separate website. The extension does not collect full
card details, health data, precise location, personal communications or
browsing history.

## Other functions

GDZ requests use `POST https://smeshapi.site/gdz/fetch`. The implementation in
`backend/src/gdz.js` fetches only a public URL from its server-side allowlist.
Homework text and the journal session token are not part of that flow.

Solution history stays in chrome.storage.local for 7 days. Passive week scans
remain local and do not contact an AI provider.

## Not present

No advertising or affiliate injection, sale of data, remote executable code,
automatic form submission, background page-content collection, or telemetry
without opt-in.

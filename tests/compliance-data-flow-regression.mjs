#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('compliance/data-flows.json'));
const consent = await read('src/lib/consent.js');
const inference = await read('src/lib/smesh-proxy.js');
const worker = await read('backend/src/worker.js');
const payments = await read('backend/src/payments.js');
const analytics = await read('backend/src/analytics.js');
const licenses = await read('backend/src/licenses.js');
const serviceWorker = await read('src/background/service-worker.js');
const scraper = await read('src/content/scraper.js');
const vps = await read('backend-vps/server.js');
const wrangler = await read('backend/wrangler.toml');
const setup = await read('backend-vps/setup.sh');
const popup = await read('src/popup/popup.html');
const settings = await read('src/settings/settings.html');
const store = await read('docs/CHROME-WEB-STORE.md');
const operations = await read('docs/LEGAL-OPERATIONS-RU.md');

assert.equal(manifest.schema_version, 1);
assert.equal(manifest.defaults.telemetry_enabled, false);
assert.equal(manifest.defaults.remote_ai_before_consent, false);
assert.equal(manifest.defaults.server_content_logging, false);

const consentFlow = manifest.flows.find((flow) => flow.id === 'consent');
assert.deepEqual(consentFlow.required_choices, ['terms', 'ai_processing', 'eligibility']);
assert.deepEqual(consentFlow.optional_choices, ['telemetry']);
assert.ok(consentFlow.excluded.includes('task_content'));
assert.ok(consentFlow.excluded.includes('raw_license_key'));
assert.match(consent, /terms:\s*false, ai_processing:\s*false,\s*\n?\s*telemetry:\s*false, eligibility:\s*false/);
assert.match(consent, /telemetryEnabled:\s*rec\.telemetry/);

const eligibilityText =
  'Я подтверждаю, что вправе пользоваться сервисом и, когда это требуется, получил(а) разрешение родителя или законного представителя.';
assert.ok(popup.includes(eligibilityText));
assert.ok(settings.includes(eligibilityText));

assert.match(inference, /entitlement_token:\s*status\.entitlement_token/);
assert.doesNotMatch(inference, /(?:license_key|activation_token)\s*:/,
  'the inference request body must not contain raw license credentials');
assert.doesNotMatch(vps, /LICENSE_VERIFY_URL|verifyLicenseUpstream|activation_token/,
  'the inference VPS must have no remote/raw-license verification path');
assert.match(worker, /INSERT OR IGNORE INTO consent_receipts/);
assert.match(worker, /Object\.keys\(body\).*allowedFields/);

const features = [
  'ai_text', 'ai_images', 'ai_documents', 'mesh_attachments',
  'autofill', 'other_sites', 'telemetry', 'gdz'
];
assert.deepEqual(manifest.feature_switches, features);
for (const feature of features) {
  assert.ok(vps.includes(`'${feature}'`), `VPS config is missing ${feature}`);
}
assert.match(vps, /config\.features\.ai_text/);
assert.match(vps, /config\.features\.ai_images/);
assert.match(vps, /config\.features\.ai_documents/);
assert.match(vps, /prep\.telemetryOptIn\s*&&\s*admission\.telemetryEnabled/,
  'server telemetry must require both user opt-in and the central kill switch');
for (const combinedAutofillAction of ['PILL_SOLVE_PAGE', 'PILL_SOLVE_ALL', 'WEB_SOLVE_PAGE']) {
  assert.match(serviceWorker, new RegExp(`FILL_ANSWERS_TAB[\\s\\S]{0,200}'${combinedAutofillAction}'[\\s\\S]{0,160}features\\.autofill`),
    `${combinedAutofillAction} must not bypass the autofill kill switch`);
}

assert.match(wrangler, /\[observability\]\s*\nenabled\s*=\s*false/);
assert.match(setup, /Caddy access logging is intentionally not enabled/);
assert.equal(manifest.logging_policy.content_in_application_logs, false);
assert.equal(manifest.logging_policy.content_in_apm_or_crash_reports, false);
assert.doesNotMatch(scraper, /cs-download[^\n]*,\s*url\s*\)/,
  'attachment debug logs must not emit signed/user-specific URLs');
assert.doesNotMatch(serviceWorker, /\[solve\] threw[^\n]*(?:message|String\(e)/,
  'solve console logs must not echo provider errors that can contain task material');
for (const [name, source] of Object.entries({ worker, payments, analytics, licenses })) {
  assert.doesNotMatch(source, /console\.(?:warn|error)\([^\n]*String\((?:e|error)\)/,
    `${name} operational logs must reduce exceptions to bounded error codes`);
}
assert.doesNotMatch(worker, /console\.(?:warn|error)\([^\n]*(?:\bip\b|payment_id|order_id|invoiceId\()/,
  'operational logs must not emit source addresses or payment identifiers');
const gdz = await read('backend/src/gdz.js');
assert.doesNotMatch(gdz, /gdz-proxy: unexpected error[^\n]*(?:\.stack|String\(e\))/,
  'GDZ exception logs must not echo content-bearing stack/message values');
assert.match(await read('backend/src/analytics.js'), /key_hint:\s*maskLicenseKey\(license_key\)/,
  'stats endpoints must reduce legacy bearer license keys to a display hint');

assert.match(store, /AI-(?:процесс|провайдер)|AI gateway/i);
assert.match(store, /заполн(?:ить|яет|ение)/i);
assert.match(store, /another site|друг(?:ом|их) сайт/i);
assert.match(store, /MESH/i);
assert.match(operations, /Статья 18\(5\)/);
assert.match(operations, /трансграничной передаче/);
assert.match(operations, /302\.ai\/legal\/terms/,
  'the launch checklist must preserve the 302.AI downstream-use contract blocker');
assert.match(operations, /выключить `ai_text`, `ai_images` и `ai_documents`/,
  'the launch checklist must name the safe state until processor approval exists');

console.log('compliance data-flow regressions passed');

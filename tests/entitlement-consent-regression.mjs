#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';
import {
  ENTITLEMENT_TOKEN_TTL_MS,
  issueEntitlementToken,
  verifyEntitlementToken
} from '../backend/src/entitlement-token.js';

const secret = 'entitlement-consent-regression-secret-at-least-32-bytes';
const env = { ENTITLEMENT_SECRET: secret };
const now = Date.now();
const rawLicense = 'SMESH-PRIVATE-LICENSE-MUST-STOP-AT-WORKER';
const deviceId = '123e4567-e89b-42d3-a456-426614174321';

const issued = await issueEntitlementToken(env, {
  licenseKey: rawLicense,
  deviceId,
  licenseType: 'subscription',
  licenseExpiresAt: '2027-01-01T00:00:00.000Z'
}, now);
assert.ok(issued?.token?.startsWith('et1.'));
assert.equal(issued.expires_at, now + ENTITLEMENT_TOKEN_TTL_MS);
assert.equal(issued.token.includes(rawLicense), false);

const [, encodedPayload] = issued.token.split('.');
const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
assert.equal(payload.p, 'ai');
assert.match(payload.l, /^h:[a-f0-9]{64}$/);
assert.equal(payload.d, deviceId);
assert.equal(JSON.stringify(payload).includes(rawLicense), false,
  'the capability payload must contain only a pseudonymous license reference');

const verified = await verifyEntitlementToken(env, issued.token, now + 1);
assert.equal(verified.ok, true);
assert.equal(verified.license_ref, payload.l);
assert.equal(verified.device_id, deviceId);
assert.deepEqual(await verifyEntitlementToken(env, issued.token, issued.expires_at), {
  ok: false,
  reason: 'expired_token'
});

const tampered = issued.token.slice(0, -1) + (issued.token.endsWith('A') ? 'B' : 'A');
assert.equal((await verifyEntitlementToken(env, tampered, now + 1)).ok, false);

function signedTokenWithPurpose(purpose) {
  const custom = { ...payload, p: purpose };
  const encoded = Buffer.from(JSON.stringify(custom)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`et1.${encoded}`).digest('base64url');
  return `et1.${encoded}.${signature}`;
}
assert.deepEqual(await verifyEntitlementToken(env, signedTokenWithPurpose('telemetry'), now + 1), {
  ok: false,
  reason: 'bad_token'
});

const shortLicenseExpiry = new Date(now + 2 * 60 * 1000).toISOString();
const shortEntitlement = await issueEntitlementToken(env, {
  licenseKey: rawLicense,
  deviceId,
  licenseType: 'subscription',
  licenseExpiresAt: shortLicenseExpiry
}, now);
assert.equal(shortEntitlement.expires_at, Date.parse(shortLicenseExpiry),
  'an AI capability must never outlive the underlying license');
assert.equal((await verifyEntitlementToken(env, shortEntitlement.token, now + 1)).ok, true);
assert.equal(
  (await verifyEntitlementToken(env, shortEntitlement.token, shortEntitlement.expires_at)).reason,
  'expired_token'
);

class CaptureD1 {
  writes = [];
  prepare(sql) {
    const db = this;
    const statement = (args = []) => ({
      bind: (...bound) => statement(bound),
      async run() {
        db.writes.push({ sql, args });
        return { meta: { changes: 1 } };
      }
    });
    return statement();
  }
}

const db = new CaptureD1();
const workerEnv = { ...env, DB: db };
const receipt = {
  entitlement_token: issued.token,
  receipt_id: '123e4567-e89b-42d3-a456-426614174999',
  version: 4,
  terms: true,
  ai_processing: true,
  telemetry: false,
  eligibility: true,
  client_at: new Date(now).toISOString()
};
const postReceipt = (body) => worker.fetch(new Request('https://smeshapi.site/consent/receipt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}), workerEnv, { waitUntil() {} });

const response = await postReceipt(receipt);
assert.equal(response.status, 201);
assert.deepEqual(await response.json(), { ok: true });
assert.equal(db.writes.length, 1);
assert.match(db.writes[0].sql, /INSERT OR IGNORE INTO consent_receipts/);
assert.deepEqual(db.writes[0].args.slice(0, 9), [
  receipt.receipt_id, payload.l, deviceId, 4, 1, 1, 0, 1, receipt.client_at
]);
assert.equal(JSON.stringify(db.writes[0]).includes(rawLicense), false);

const extraContent = await postReceipt({ ...receipt, task_content: 'private homework text' });
assert.equal(extraContent.status, 400,
  'unknown fields must be rejected so consent transport cannot become a content sink');
assert.equal(db.writes.length, 1);

const invalid = await postReceipt({ ...receipt, entitlement_token: tampered });
assert.equal(invalid.status, 403);
assert.equal(db.writes.length, 1, 'invalid capabilities must be rejected before storage');

console.log('entitlement and consent receipt regressions passed');

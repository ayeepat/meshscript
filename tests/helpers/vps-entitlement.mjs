import crypto from 'node:crypto';

export const TEST_ENTITLEMENT_SECRET =
  'smesh-test-entitlement-secret-2026-at-least-32-bytes';

// Test-only P-256 key. It carries no production authority; it exists so the
// local VPS readiness and signed-runtime-config paths exercise real signing.
export const TEST_RUNTIME_CONFIG_PRIVATE_KEY_B64 =
  'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JR0hBZ0VBTUJNR0J5cUdTTTQ5QWdFR0NDcUdTTTQ5QXdFSEJHMHdhd0lCQVFRZ3ZVYThzd0lxbkMxK211bHYKejMyeVUyeWRLVlREUk1XeXB4d2xTVGdaakE2aFJBTkNBQVNxSUdiZ1VQd09qa2hpM1dacUJLaHBvbHQ0eFhpYQpramplSXJkdjdMdWVwQmh1QWVFS3BkWFJZb2w4Mm5JNlVsLzBKZitRcDQ5RDFKbDdSRjR3QTZWQgotLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tCg==';

export const TEST_RUNTIME_CONFIG_PUBLIC_KEY_JWK = Object.freeze({
  kty: 'EC',
  crv: 'P-256',
  x: 'qiBm4FD8Do5IYt1magSoaaJbeMV4mpI43iK3b-y7nqQ',
  y: 'GG4B4Qql1dFiiXzacjpSX_Ql_5Cnj0PUmXtEXjADpUE'
});

export const TEST_VPS_SECURITY_ENV = Object.freeze({
  ENTITLEMENT_SECRET: TEST_ENTITLEMENT_SECRET,
  RUNTIME_CONFIG_PRIVATE_KEY_B64: TEST_RUNTIME_CONFIG_PRIVATE_KEY_B64,
});

export function issueTestEntitlement({
  licenseKey = 'SMESH-TEST-TEST-TEST',
  deviceId = '00000000-0000-4000-8000-000000000001',
  now = Date.now(),
} = {}) {
  const issuedAt = Math.trunc(now);
  const payload = {
    v: 1,
    p: 'ai',
    l: 'h:' + crypto.createHash('sha256').update(String(licenseKey)).digest('hex'),
    d: deviceId,
    iat: issuedAt,
    exp: issuedAt + 10 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', TEST_ENTITLEMENT_SECRET)
    .update(`et1.${encoded}`)
    .digest('base64url');
  return `et1.${encoded}.${signature}`;
}

export function entitlementBody(identity = {}) {
  return { entitlement_token: issueTestEntitlement(identity) };
}

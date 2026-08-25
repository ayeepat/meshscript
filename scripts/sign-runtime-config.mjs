#!/usr/bin/env node
/** Sign a bare runtime-config JSON file into the envelope consumed by the extension. */

import { readFile, writeFile, rename, rm, realpath, stat } from 'node:fs/promises';
import { createPublicKey, createPrivateKey, randomUUID, sign, verify } from 'node:crypto';
import path from 'node:path';
import { RUNTIME_CONFIG_PUBLIC_KEY_JWK } from '../src/lib/config.js';

const [inputPath, outputPath, keyPath = '.secrets/runtime-config-signing-key.pem'] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/sign-runtime-config.mjs INPUT.json OUTPUT.json [PRIVATE_KEY.pem]');
  process.exit(2);
}

const fail = (message) => { console.error(message); process.exit(2); };

// Paths are positional, so a transposed argument is an easy mistake with an
// expensive outcome: with OUTPUT == KEY the script previously exited zero after
// atomically replacing a P-256 PRIVATE KEY with envelope JSON.
//
// Comparing path.resolve() strings is not enough — a SYMLINK is a different
// string pointing at the same file, so `key.pem -> out.json` slipped through,
// the key was read through the link, and the rename then clobbered the real
// target. Resolve symlinks (falling back to the parent directory for a path
// that does not exist yet, so `dir-link/out.json` still collides) and compare
// filesystem identity for anything that does exist.
async function resolveTarget(target) {
  try {
    return await realpath(target);
  } catch {
    try {
      return path.join(await realpath(path.dirname(target)), path.basename(target));
    } catch {
      return path.resolve(target);
    }
  }
}

async function fileIdentity(target) {
  try {
    const info = await stat(target); // follows symlinks, like the reads below
    return `${info.dev}:${info.ino}`;
  } catch {
    return null; // does not exist yet — the path comparison is the only guard
  }
}

const resolved = {
  input: await resolveTarget(inputPath),
  output: await resolveTarget(outputPath),
  key: await resolveTarget(keyPath)
};
// Publish to the path the operator actually named. `resolved.output` is used
// only for collision detection because it follows symlinks; renaming to it
// would overwrite the symlink target rather than replace the output entry.
const destinationPath = path.resolve(outputPath);
const identity = {
  input: await fileIdentity(inputPath),
  output: await fileIdentity(outputPath),
  key: await fileIdentity(keyPath)
};
const collides = (a, b) =>
  resolved[a] === resolved[b] || (identity[a] !== null && identity[a] === identity[b]);

if (collides('output', 'key')) fail('refusing to overwrite the signing key with the output');
if (collides('output', 'input')) fail('refusing to overwrite the input with the output');
if (collides('input', 'key')) fail('input and signing key must be different files');

const raw = JSON.parse(await readFile(resolved.input, 'utf8'));
const now = Date.now();
const MAX_SIGNED_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('config must be a JSON object');
if (!Number.isSafeInteger(raw.configVersion) || raw.configVersion < 1) {
  fail('configVersion must be a positive integer');
}
if (!Number.isSafeInteger(raw.issuedAt) || !Number.isSafeInteger(raw.expiresAt)) {
  fail('issuedAt and expiresAt must be integer millisecond timestamps');
}
if (raw.issuedAt > now + 5 * 60 * 1000 || raw.issuedAt < now - 24 * 60 * 60 * 1000) {
  fail('issuedAt must be within the last 24 hours (allowing five minutes of clock skew)');
}
if (raw.expiresAt <= now || raw.expiresAt <= raw.issuedAt ||
    raw.expiresAt - raw.issuedAt > MAX_SIGNED_VALIDITY_MS) {
  fail('expiresAt must be in the future and no more than seven days after issuedAt');
}
const payloadBytes = Buffer.from(JSON.stringify(raw), 'utf8');

// The extension verifies an ECDSA P-256 signature in 64-byte P1363 form
// (src/lib/remote-config.js). Any other key type produces a "successful" run
// whose output every client rejects: an RSA-2048 key exited zero and emitted a
// 256-byte signature. Reject it here, where the operator can still see why.
const privateKey = createPrivateKey(await readFile(resolved.key, 'utf8'));
if (privateKey.asymmetricKeyType !== 'ec') {
  fail(`signing key must be EC P-256, got ${privateKey.asymmetricKeyType}`);
}
const curve = privateKey.asymmetricKeyDetails?.namedCurve;
if (curve !== 'prime256v1') fail(`signing key must use the P-256 curve, got ${curve}`);

const signature = sign('sha256', payloadBytes, { key: privateKey, dsaEncoding: 'ieee-p1363' });
if (signature.byteLength !== 64) {
  fail(`expected a 64-byte P1363 signature, got ${signature.byteLength}`);
}

// Self-verify with the derived public key before publishing anything. A
// signature the signer itself cannot check is never worth renaming into place.
const publicKey = createPublicKey(privateKey);
if (!verify('sha256', payloadBytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)) {
  fail('self-verification failed — refusing to emit an unusable envelope');
}

// Pin the exact public key shipped to clients on every run. Key rotation must
// update the extension's checked-in verifier first; an environment variable
// must not be able to bypass the release authority.
const expected = RUNTIME_CONFIG_PUBLIC_KEY_JWK;
const actual = publicKey.export({ format: 'jwk' });
if (actual.x !== expected.x || actual.y !== expected.y || actual.crv !== expected.crv) {
  fail('signing key does not match the runtime-config public key');
}

const base64url = (bytes) => Buffer.from(bytes).toString('base64url');
const envelope = { payload: base64url(payloadBytes), signature: base64url(signature) };
const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
try {
  await writeFile(temporaryPath, JSON.stringify(envelope) + '\n', { flag: 'wx', mode: 0o644 });
  await rename(temporaryPath, destinationPath);
} catch (error) {
  await rm(temporaryPath, { force: true }).catch(() => {});
  throw error;
}

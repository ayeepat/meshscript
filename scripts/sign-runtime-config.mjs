#!/usr/bin/env node
/** Sign a bare runtime-config JSON file into the envelope consumed by the extension. */

import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID, sign } from 'node:crypto';

const [inputPath, outputPath, keyPath = '.secrets/runtime-config-signing-key.pem'] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/sign-runtime-config.mjs INPUT.json OUTPUT.json [PRIVATE_KEY.pem]');
  process.exit(2);
}

const raw = JSON.parse(await readFile(inputPath, 'utf8'));
const payloadBytes = Buffer.from(JSON.stringify(raw), 'utf8');
const privateKey = await readFile(keyPath, 'utf8');
const signature = sign('sha256', payloadBytes, { key: privateKey, dsaEncoding: 'ieee-p1363' });
const base64url = (bytes) => Buffer.from(bytes).toString('base64url');
const envelope = { payload: base64url(payloadBytes), signature: base64url(signature) };
const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
try {
  await writeFile(temporaryPath, JSON.stringify(envelope) + '\n', { flag: 'wx', mode: 0o644 });
  await rename(temporaryPath, outputPath);
} catch (error) {
  await rm(temporaryPath, { force: true }).catch(() => {});
  throw error;
}

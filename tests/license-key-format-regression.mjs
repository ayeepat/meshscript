import assert from 'node:assert/strict';
import { generateKey, normalizeKey } from '../backend/src/licenses.js';
import {
  normalizeEnteredLicenseKey,
  validateEnteredLicenseKey
} from '../src/lib/license.js';

const KEY_PATTERN = /^SMESH-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
const generated = new Set();
for (let index = 0; index < 500; index += 1) {
  const key = generateKey();
  assert.match(key, KEY_PATTERN);
  assert.equal(key.length, 20, 'SMESH- plus 12 random characters and two grouping hyphens');
  generated.add(key);
}
assert.equal(generated.size, 500, 'the key generator must not collapse to a repeated value');

const canonical = 'SMESH-2345-6789-ABCD';
const compact = 'smesh-23456789abcd';
assert.equal(normalizeKey(compact), canonical);
assert.equal(normalizeEnteredLicenseKey(compact), canonical);
assert.equal(normalizeKey(`  ${canonical.toLowerCase()}  `), canonical);
assert.equal(normalizeEnteredLicenseKey(`  ${canonical.toLowerCase()}  `), canonical);
assert.equal(normalizeEnteredLicenseKey('`SMESH\\-2345\\-6789\\-ABCD`'), canonical,
  'keys copied from an older Markdown Telegram message must be repaired');

assert.deepEqual(validateEnteredLicenseKey(''), { ok: true, key: '', empty: true });
assert.deepEqual(validateEnteredLicenseKey(compact), { ok: true, key: canonical, empty: false });
assert.equal(validateEnteredLicenseKey('SMESH-2345').reason, 'too_short');
assert.match(validateEnteredLicenseKey('SMESH-2345').message, /слишком короткий/i);
assert.equal(validateEnteredLicenseKey(`SMESH-${'A'.repeat(20)}`).reason, 'too_long');
assert.match(validateEnteredLicenseKey('WRONG-2345-6789-ABCD').message, /начинаться с SMESH-/i);
assert.equal(validateEnteredLicenseKey('SMESH-OOOO-OOOO-OOOO').reason, 'bad_format',
  'ambiguous characters excluded by the public key alphabet must be rejected locally');

const legacy = 'SMESH-2345-6789-ABCD-EFGH';
assert.equal(normalizeKey(legacy), legacy, 'existing 16-character keys remain valid');
assert.equal(normalizeEnteredLicenseKey(legacy), legacy, 'the extension preserves legacy keys');
assert.deepEqual(validateEnteredLicenseKey(legacy), { ok: true, key: legacy, empty: false });

console.log('license key-format regressions passed');

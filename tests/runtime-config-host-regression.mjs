/**
 * The runtime-config URL must actually be fetchable.
 *
 * Three independent things have to line up, and each one has already been wrong
 * in this repo at least once:
 *
 *  1. `fetchFresh()` uses `redirect: 'error'`, so the URL must be the origin the
 *     site serves directly. `www.smeshai.xyz` 301s to the apex, which means a
 *     `www.` URL can never resolve no matter what is published behind it.
 *  2. MV3 needs a `host_permissions` entry matching that origin. A pattern for a
 *     different host silently turns the fetch into a CORS failure.
 *  3. Both are swallowed — `getRuntimeConfig()` is fail-open by design — so a
 *     break here produces no error anywhere, just a permanently absent hot-fix
 *     channel. Only a build-time check catches it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const manifest = JSON.parse(source('../manifest.json'));
const config = source('../src/lib/config.js');

const declared = /export const RUNTIME_CONFIG_URL = '([^']+)';/.exec(config);
assert.ok(declared, 'RUNTIME_CONFIG_URL must stay a plain string literal in config.js');

const url = new URL(declared[1]);
assert.equal(url.protocol, 'https:', 'the runtime config must be fetched over HTTPS');
assert.equal(url.hostname, 'smeshai.xyz',
  'the runtime config must be fetched from the apex host: www. 301s to it and ' +
  'remote-config.js refuses redirects');

/** Chrome match patterns: `*.host` also matches `host` itself. */
function hostPatternMatches(pattern, origin) {
  const match = /^https:\/\/([^/]+)\/\*$/.exec(pattern);
  if (!match) return false;
  const host = match[1];
  if (host.startsWith('*.')) {
    const base = host.slice(2);
    return origin.hostname === base || origin.hostname.endsWith(`.${base}`);
  }
  return origin.hostname === host;
}

assert.ok(
  manifest.host_permissions.some((pattern) => hostPatternMatches(pattern, url)),
  `no host_permissions entry matches ${url.origin} — the runtime config fetch would be blocked`,
);

// The fetch deliberately refuses redirects; if that ever relaxes, the host
// check above stops being sufficient and this test needs to grow with it.
assert.match(source('../src/lib/remote-config.js'), /redirect: 'error'/,
  'remote-config must keep refusing redirects, or the host guarantee above weakens');

// Notice links are navigations, not fetches, so tolerating both spellings there
// is correct — but the Chrome Web Store origin must stay in the accept-list.
assert.match(source('../src/lib/remote-config.js'), /https:\/\/chromewebstore\.google\.com/,
  'an "update available" notice must be able to link to the store listing');

console.log('runtime config host regression passed');

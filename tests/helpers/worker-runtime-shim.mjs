import { timingSafeEqual } from 'node:crypto';

// Legacy unit fixtures intentionally model only the storage behavior under
// test. Production has no such marker: missing RUNTIME_WRITE_EPOCH therefore
// fails every mutation closed. Fence-specific regressions set the epoch and
// exercise the real wrapper even with this compatibility marker present.
globalThis.__SMESH_TEST_ALLOW_LEGACY_FENCE_ENV__ = true;

// Cloudflare Workers exposes crypto.subtle.timingSafeEqual(), while Node's Web
// Crypto does not yet. Install the equivalent Node primitive so local tests
// exercise the production branch instead of weakening worker.js for the test
// environment.
export const timingSafeEqualCalls = { count: 0 };

if (typeof crypto.subtle.timingSafeEqual !== 'function') {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value(a, b) {
      timingSafeEqualCalls.count += 1;
      const left = Buffer.from(a.buffer || a, a.byteOffset || 0, a.byteLength);
      const right = Buffer.from(b.buffer || b, b.byteOffset || 0, b.byteLength);
      return left.byteLength === right.byteLength && timingSafeEqual(left, right);
    }
  });
}

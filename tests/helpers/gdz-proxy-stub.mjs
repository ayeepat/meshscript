/**
 * Stand-in for the licensed GDZ proxy in extension-side regressions.
 *
 * GDZ fetching moved to the Worker (backend/src/gdz.js) so the extension could
 * drop `declarativeNetRequest`. Client tests used to stub `globalThis.fetch`
 * and dispatch on a gdz-ru.com URL; now the only outbound request is one POST
 * to `smeshapi.site/gdz/fetch` carrying `{kind, url}`. This unwraps that
 * envelope so a test can keep expressing its fixtures in terms of the upstream
 * GDZ URL it actually cares about.
 *
 * Lives under tests/helpers/ deliberately: scripts/run-regressions.mjs globs
 * `tests/*.mjs` non-recursively, so a shared module here is not run as a test.
 */

import { BACKEND_URL } from '../../src/lib/config.js';

const ENDPOINT = `${BACKEND_URL}/gdz/fetch`;

/**
 * Seed the credential lib/gdz-proxy.js requires before it will call out. The
 * proxy client only checks that a key is PRESENT (the server is the authority),
 * so a well-shaped fake is enough.
 */
export function seedLicense(store) {
  store.licenseStatus = {
    ok: true,
    key: 'SMESH-TEST-TEST-TEST',
    activation_token: 'a'.repeat(43)
  };
  store.licenseGeneration = '';
  store.deviceId = '00000000-0000-4000-8000-000000000000';
}

/**
 * Replace globalThis.fetch with one that answers the proxy route.
 *
 * @param {object} opts
 * @param {object} opts.store            the test's chrome.storage.local backing object
 * @param {(kind: string, url: string) => Promise<object>|object} opts.upstream
 *   returns the proxy's success payload for this request — `{data}` for
 *   kind 'json', `{image}` for 'image'/'cover', `{ref}` for 'human'. Throw or
 *   return null to make the proxy answer with an error.
 * @returns {Array<{kind:string,url:string}>} every request made, in order
 */
export function installGdzProxyStub({ store, upstream }) {
  seedLicense(store);
  const requests = [];

  globalThis.fetch = async (url, init = {}) => {
    if (url !== ENDPOINT) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(init.body);
    requests.push({ kind: body.kind, url: body.url });

    let payload;
    try {
      payload = await upstream(body.kind, body.url);
    } catch (e) {
      // Mirrors the Worker: an upstream failure is a 502 with a student-facing
      // sentence, never the raw reason.
      return jsonResponse(
        { ok: false, error: { message: String(e?.message || e) } },
        502
      );
    }
    if (!payload) {
      return jsonResponse({ ok: false, error: { message: 'ГДЗ недоступен.' } }, 502);
    }
    // Escape hatch for fixtures JSON.stringify cannot round-trip. V8's
    // stringify recurses and overflows on a deeply nested structure, while its
    // parse is iterative — so a `rawData` fixture is the only way to hand the
    // client the pathological document that the iterative-flatten test needs.
    if (typeof payload.rawData === 'string') {
      return rawResponse(`{"ok":true,"data":${payload.rawData}}`);
    }
    return jsonResponse({ ok: true, ...payload });
  };

  return requests;
}

function jsonResponse(value, status = 200) {
  return rawResponse(JSON.stringify(value), status);
}

function rawResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(text))
    }
  });
}

/** Wrap raw image bytes the way the proxy returns them. */
export function proxyImage(bytes, mimeType = 'image/png') {
  return { image: { mimeType, dataBase64: Buffer.from(bytes).toString('base64') } };
}

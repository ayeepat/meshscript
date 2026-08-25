// The referral client used to parse every /referral/* body and drop the HTTP
// status, so an infrastructure error page (HTML from a proxy or a 5xx) threw a
// raw SyntaxError instead of the network failure callers translate. A JSON
// verdict must still be honoured whatever the status, because the backend
// answers a genuine refusal as { ok:false, reason } rather than a 2xx.
import assert from 'node:assert/strict';

const store = new Map([
  ['deviceId', '5fa85f64-5717-4562-b3fc-2c963f66afa6'],
  ['referralState', { auth: 'a'.repeat(43) }],
]);
globalThis.chrome = { storage: { local: {
  async get(keys) {
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store.get(key)]));
    return { [keys]: store.get(keys) };
  },
  async set(entries) { for (const [key, value] of Object.entries(entries)) store.set(key, value); },
  async remove(key) { store.delete(key); }
} } };

const originalFetch = globalThis.fetch;
const reply = (body, status = 200) => {
  globalThis.fetch = async () => new Response(body, { status });
};

const { fetchReferralStatus, getMyReferralCode } = await import('../src/lib/referral.js');

try {
  // An HTML error page is a transport failure, not a malformed verdict.
  reply('<html><body>502 Bad Gateway</body></html>', 502);
  await assert.rejects(fetchReferralStatus(), (error) => {
    assert.ok(!(error instanceof SyntaxError),
      'an error page must not surface as a JSON parse error');
    assert.match(error.message, /referral http 502/);
    return true;
  });

  // A 200 that is not JSON at all is equally not a verdict.
  reply('not json at all', 200);
  await assert.rejects(fetchReferralStatus(), /referral: malformed response/);

  // A refusal carried as a JSON body is a real verdict and must reach callers
  // with its reason intact, whatever status it rode in on.
  reply(JSON.stringify({ ok: false, reason: 'revoked' }), 403);
  await assert.rejects(fetchReferralStatus(), /revoked/);

  reply(JSON.stringify({ ok: true, code: 'SMESH-REF-1', purchases: 2, days_earned: 4 }));
  const status = await fetchReferralStatus();
  assert.equal(status.code, 'SMESH-REF-1');
  assert.equal(status.purchases, 2);

  // A pointer refresh that hits an error page reports the network failure its
  // callers translate, and must not persist or return a stale code.
  store.set('referralState', { auth: 'a'.repeat(43) });
  reply('<html>503</html>', 503);
  await assert.rejects(getMyReferralCode({ sync: true }), /network/);
  assert.equal(store.get('referralState').code, undefined,
    'a failed pointer refresh must not invent a cached code');
} finally {
  globalThis.fetch = originalFetch;
}

// Every context helper must agree: a content script has both a document and
// chrome.runtime, so only the extension-page protocol distinguishes it.
{
  const sources = await Promise.all(['referral.js', 'license.js', 'history.js'].map(
    (name) => import('node:fs/promises')
      .then((fs) => fs.readFile(new URL(`../src/lib/${name}`, import.meta.url), 'utf8'))
  ));
  for (const [index, source] of sources.entries()) {
    const helper = source.slice(source.indexOf('function isExtensionPageContext()'));
    assert.match(helper.slice(0, 400), /location\.protocol === 'chrome-extension:'/,
      `isExtensionPageContext #${index} must gate on the extension page protocol`);
  }
}

console.log('referral client transport regression passed');

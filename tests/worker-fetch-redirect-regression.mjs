/**
 * Outbound Worker fetches must use a redirect mode workerd implements.
 *
 * Every Robokassa server-to-server call passed `redirect: 'error'`. Chrome and
 * Node accept it; workerd refuses it outright and throws a TypeError BEFORE the
 * request leaves the Worker:
 *
 *   Invalid redirect value, must be one of "follow" or "manual" ("error" won't
 *   be implemented since it does not make sense at the edge; use "manual" and
 *   check the response status code).
 *
 * So reconciliation, refund creation and refund polling never reached the
 * provider even once in production — 1977 logged failures, zero successes —
 * while `reconcileRobokassaOrder` recorded each one as an opaque
 * `transport_error`, indistinguishable from a network fault. The whole suite
 * stayed green throughout because every provider test injects a `fetcher`, and
 * a plain function validates no init at all.
 *
 * Two guards, because either alone leaks the bug back in:
 *   1. a static scan, which reaches call sites no behavioural test drives;
 *   2. a workerd-faithful fetcher, which proves the three live provider calls
 *      actually survive the runtime's validation.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import {
  createRefund,
  queryOperationState,
  queryRefundState
} from '../backend/src/gateways/robokassa.js';

// workerd accepts exactly these two. Keep in sync with the runtime, not with
// the fetch spec — 'error' is spec-legal and still rejected at the edge.
const WORKERD_REDIRECT_MODES = new Set(['follow', 'manual']);

/* -------------------------- 1. static scan -------------------------- */

async function* workerSourceFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) yield* workerSourceFiles(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}

const offenders = [];
for await (const file of workerSourceFiles(new URL('../backend/src/', import.meta.url))) {
  const source = await readFile(file, 'utf8');
  for (const [, quote, mode] of source.matchAll(/redirect:\s*(['"])(.*?)\1/g)) {
    void quote;
    if (!WORKERD_REDIRECT_MODES.has(mode)) {
      offenders.push(`${file.pathname.split('/backend/').pop()}: redirect: '${mode}'`);
    }
  }
}
assert.deepEqual(
  offenders, [],
  `worker code uses a redirect mode workerd rejects:\n  ${offenders.join('\n  ')}`
);

/* ---------------------- 2. workerd-faithful fetcher ---------------------- */

function workerdFetcher(handler) {
  return async (input, init = {}) => {
    if (init.redirect !== undefined && !WORKERD_REDIRECT_MODES.has(init.redirect)) {
      throw new TypeError(
        'Invalid redirect value, must be one of "follow" or "manual" ("error" ' +
        "won't be implemented since it does not make sense at the edge; use " +
        '"manual" and check the response status code).'
      );
    }
    return handler(String(input), init);
  };
}

// The guard has to be able to fail, or every assertion below is vacuous.
await assert.rejects(
  workerdFetcher(() => new Response(''))('https://example.test', { redirect: 'error' }),
  (error) => error instanceof TypeError && /Invalid redirect value/.test(error.message),
  'the workerd fetcher must reject the redirect mode that broke production'
);

const OP_STATE_XML = `<?xml version="1.0" encoding="utf-8"?>
<OperationStateResponse xmlns="http://merchant.roboxchange.com/WebService/">
  <Result><Code>0</Code><Description>OK</Description></Result>
  <State><Code>100</Code></State>
  <Info><OutCurrLabel>RUB</OutCurrLabel><OutSum>149.00</OutSum>
    <OpKey>7a4f2c1e-0b3d-4a6f-9c2e-15d8b0a3e7f4</OpKey></Info>
</OperationStateResponse>`;
const REFUND_REQUEST_ID = '3f2b8c14-5d6e-4a7b-8c9d-0e1f2a3b4c5d';

const state = await queryOperationState({
  merchantLogin: 'smesh', invoiceId: '7203183968501879', password2: 'password-2',
  fetcher: workerdFetcher(() => new Response(OP_STATE_XML, { status: 200 }))
});
assert.equal(state.result_code, 0, 'operation state must parse a real provider verdict');
assert.equal(state.state_code, 100);
assert.equal(state.op_key, '7a4f2c1e-0b3d-4a6f-9c2e-15d8b0a3e7f4');

const refund = await createRefund({
  opKey: '7a4f2c1e-0b3d-4a6f-9c2e-15d8b0a3e7f4', password3: 'password-3',
  fetcher: workerdFetcher(() => new Response(
    JSON.stringify({ success: true, requestId: REFUND_REQUEST_ID }), { status: 200 }
  ))
});
assert.deepEqual(refund, { ok: true, request_id: REFUND_REQUEST_ID });

const refundState = await queryRefundState({
  requestId: REFUND_REQUEST_ID,
  fetcher: workerdFetcher(() => new Response(
    JSON.stringify({ requestId: REFUND_REQUEST_ID, label: 'processing', amount: '149.00' }),
    { status: 200 }
  ))
});
assert.equal(refundState.label, 'processing');
assert.equal(refundState.request_id, REFUND_REQUEST_ID);

// A 3xx must still be refused: 'manual' hands back the redirect as a response
// rather than following it, and the provider callers reject any non-2xx. This
// is the guarantee 'error' was reaching for, and the reason 'follow' is not an
// acceptable substitute here.
await assert.rejects(
  queryOperationState({
    merchantLogin: 'smesh', invoiceId: '1', password2: 'password-2',
    fetcher: workerdFetcher(() => new Response('', {
      status: 302, headers: { Location: 'https://elsewhere.test/' }
    }))
  }),
  /operation-state http 302/,
  'a redirected provider response must never be followed or accepted'
);

console.log('worker fetch redirect-mode regression passed');

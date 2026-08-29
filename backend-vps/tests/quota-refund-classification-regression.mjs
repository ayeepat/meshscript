/**
 * A daily reservation may only be handed back when the provider provably did
 * no billable work. The VPS proxy used to refund on ANY failure to obtain a
 * stream — including a client cancellation that arrived after the whole POST
 * body had already been written to 302.AI. That let a user run `quota: 1 →
 * cancel → 0` in a loop, so the per-license and global "the bill cannot run
 * away" caps stopped bounding ambiguous provider work.
 *
 * connectUpstream now classifies every failure and reports `refundable`; the
 * two release sites (runJob and the streaming path) only refund when it is
 * true. This exercises the classifier directly against the production source.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const serverSource = await readFile(serverPath, 'utf8');

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section not found: ${startMarker}`);
  return source.slice(start, end);
}

const classifierSource = sourceSection(
  serverSource,
  'const PRE_DISPATCH_RETRY_CODES',
  '\n\n/* --------------------------- poll-job store'
);

// connectUpstream applies the quality policy per ACTUAL model, so it reaches
// for the model regexes declared far above the classifier section. They are
// EXTRACTED from the production file rather than re-typed here: a hand-copied
// regex would drift from the real policy without any test noticing, and a
// missing one is not a soft failure — the sandbox throws ReferenceError on
// every connect, which is how this suite broke when the GLM branch landed.
const modelPolicySource = sourceSection(
  serverSource,
  'const GLM_53_FLASH',
  '\nconst MAX_BODY_BYTES'
);

// Only the collaborators connectUpstream actually reaches for. sleep is a
// no-op so the retry ladder does not slow the suite down.
function makeContext({ fetchImpl, models = ['qwen-test'], sleepImpl = async () => {} }) {
  const calls = [];
  const context = {
    console: { error() {}, warn() {}, log() {} },
    JSON,
    String,
    Set,
    Number,
    UPSTREAM_CONNECT_RETRIES: 2,
    UPSTREAM_CONNECT_RETRY_DELAY_MS: 0,
    MAX_TOKENS_OUT: 8192,
    REASONING_EFFORTS: new Set(['low', 'medium', 'high']),
    UNAVAILABLE: 'unavailable',
    UPSTREAM_KEY: 'sk-test',
    sleep: sleepImpl,
    upstreamUrl: () => 'https://provider.invalid/v1/chat/completions',
    modelChoices: () => models,
    isUnpurchased: (text) => /No available models|"err_code"\s*:\s*-10008/i.test(text || ''),
    readResponseTextBounded: async (response) => response.__text,
    fetch: async (...args) => { calls.push(args); return fetchImpl(calls.length); }
  };
  vm.runInNewContext(
    `${modelPolicySource}\n${classifierSource}\nglobalThis.__connectUpstream = connectUpstream;`,
    context,
    { filename: 'connect-upstream.js' }
  );
  return { context, calls };
}

const provider = { name: 'Qwen' };
const connect = (context, signal) => context.__connectUpstream(
  provider, {}, [{ role: 'user', content: 'hi' }], false, false, signal
);

function upstreamResponse(status, text) {
  return { ok: status >= 200 && status < 300, status, __text: text };
}

function transportError(code) {
  const error = new Error(code);
  error.cause = { code };
  return error;
}

/* ---- cancellation during a proven pre-dispatch backoff is still free ---- */
{
  const controller = new AbortController();
  const { context, calls } = makeContext({
    sleepImpl: async () => { controller.abort(); },
    fetchImpl: async (attempt) => {
      if (attempt === 1) throw transportError('ECONNREFUSED');
      return upstreamResponse(200, '');
    }
  });
  const result = await connect(context, controller.signal);
  assert.equal(result.err.status, 499);
  assert.equal(result.err.refundable, true,
    'a cancel between two attempts must not consume quota when the first attempt provably never connected');
  assert.equal(calls.length, 1,
    'an already-cancelled retry must be stopped before a second fetch is issued');
}

/* ---- cancellation after dispatch is ambiguous: keep the reservation ---- */
{
  const controller = new AbortController();
  const { context, calls } = makeContext({
    fetchImpl: async () => {
      // The provider has the complete request body by now; the client's
      // cancel lands while we are waiting for response headers.
      controller.abort();
      throw transportError('ABORT_ERR');
    }
  });
  const result = await connect(context, controller.signal);
  assert.equal(result.upstream, undefined);
  assert.equal(result.err.status, 499);
  assert.equal(result.err.refundable, false,
    'a cancel that lands after the body was written must NOT refund the day');
  assert.equal(calls.length, 1);
}

/* ---- cancellation before any dispatch really is free ---- */
{
  const controller = new AbortController();
  controller.abort();
  const { context, calls } = makeContext({ fetchImpl: async () => upstreamResponse(200, '') });
  const result = await connect(context, controller.signal);
  assert.equal(result.err.status, 499);
  assert.equal(result.err.refundable, true,
    'nothing was ever sent, so the slot goes back');
  assert.equal(calls.length, 0, 'no request may be dispatched after a pre-aborted signal');
}

/* ---- a connection that was never established is refundable ---- */
for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']) {
  const { context } = makeContext({ fetchImpl: async () => { throw transportError(code); } });
  const result = await connect(context, null);
  assert.equal(result.err.status, 502);
  assert.equal(result.err.refundable, true, `${code} proves the body never left`);
}

/* ---- a reset mid-flight is ambiguous: keep the reservation ---- */
for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'ETIMEDOUT']) {
  const { context } = makeContext({ fetchImpl: async () => { throw transportError(code); } });
  const result = await connect(context, null);
  assert.equal(result.err.status, 502);
  assert.equal(result.err.refundable, false,
    `${code} can fire after a complete POST body — the slot stands`);
}

/* ---- explicit provider refusals are refundable ---- */
for (const status of [400, 401, 402, 403, 404, 413, 422, 429]) {
  const { context } = makeContext({
    fetchImpl: async () => upstreamResponse(status, '{"error":"refused"}')
  });
  const result = await connect(context, null);
  assert.equal(result.err.refundable, true,
    `HTTP ${status} is the provider declining to run the model`);
}

/* ---- ambiguous 5xx keeps the reservation ---- */
for (const status of [500, 502, 503, 504]) {
  const { context } = makeContext({
    fetchImpl: async () => upstreamResponse(status, '{"error":"boom"}')
  });
  const result = await connect(context, null);
  assert.equal(result.err.refundable, false,
    `HTTP ${status} may follow completed paid work — the slot stands`);
}

/* ---- "no available models" is non-billable despite arriving as 503 ---- */
{
  const { context } = makeContext({
    fetchImpl: async () => upstreamResponse(
      503, '{"error":{"err_code":-10008,"message":"No available models currently"}}'
    )
  });
  const result = await connect(context, null);
  assert.equal(result.err.status, 503);
  assert.equal(result.err.refundable, true, 'an unrouted model ran nothing');
}

/* ---- a fallback chain that ends in an ambiguous 5xx keeps the slot ---- */
{
  const { context, calls } = makeContext({
    models: ['qwen-a', 'qwen-b'],
    fetchImpl: async (n) => (n === 1
      ? upstreamResponse(503, '{"error":{"err_code":-10008}}')
      : upstreamResponse(500, '{"error":"boom"}'))
  });
  const result = await connect(context, null);
  assert.equal(calls.length, 2, 'the unpurchased first model must fall through');
  assert.equal(result.err.refundable, false,
    'the LAST failure decides, and an ambiguous 5xx is not refundable');
}

/* ---- positive control: a healthy stream is handed back ---- */
{
  const { context } = makeContext({ fetchImpl: async () => upstreamResponse(200, '') });
  const result = await connect(context, null);
  assert.ok(result.upstream, 'a 2xx must return the stream, not an error');
  assert.equal(result.err, undefined);
}

/* ---- both release sites must consult the classification ---- */
{
  const runJobRelease = sourceSection(
    serverSource, 'if (!conn.upstream) {', 'job.tConnected = Date.now();'
  );
  assert.match(runJobRelease, /if \(conn\.err\.refundable\) releaseAdmissionQuota\(job\)/,
    'runJob must gate its refund on the classification');

  const streamRelease = sourceSection(
    serverSource, 'Same rule as the poll runner', 'res.writeHead(200, {'
  );
  assert.match(streamRelease, /if \(conn\.err\.refundable\) releaseAdmissionQuota\(quotaHolder\)/,
    'the streaming path must gate its refund on the classification');
}

console.log('vps quota refund classification regression passed');

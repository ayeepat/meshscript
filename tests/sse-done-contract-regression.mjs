/**
 * SSE completion contract: OpenAI-style streams terminate every COMPLETED
 * answer with `data: [DONE]`. A body that merely ends (proxy idle cut,
 * upstream dying with a clean FIN) is indistinguishable from truncation, so
 * the shared sink must refuse to present partial text as a finished answer.
 * Guards both direct-provider postStream() and the СМЭШ proxy poll loop —
 * they share this parser.
 */
import assert from 'node:assert/strict';
import { createSseSink, EMPTY_ANSWER, postStream } from '../src/lib/http.js';

// A complete stream still returns its text.
{
  const sink = createSseSink({ label: 'Test' });
  sink.push('data: {"choices":[{"delta":{"content":"Привет"}}]}\n\n');
  sink.push('data: [DONE]\n\n');
  assert.equal(sink.finish(), 'Привет');
}

// Headers can arrive while the body stalls forever. The idle timer must map
// that body-read AbortError to the same student-facing timeout as a stalled
// initial fetch, not leak a raw DOMException.
{
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener('abort', () => {
        controller.error(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(
    postStream('https://provider.example/stream', {
      body: { messages: [] }, label: 'Test', timeoutMs: 5,
    }),
    (error) => error?.name === 'Error' && /превышено время ожидания/.test(error.message),
  );
}

// The same body-read seam exists for non-OK responses. A caller cancellation
// must remain an AbortError even though the bounded error-body reader treats
// stream failures as an empty diagnostic string.
{
  const external = new AbortController();
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener('abort', () => {
        controller.error(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  }), { status: 503 });
  const pending = postStream('https://provider.example/error-stream', {
    body: { messages: [] }, label: 'Test', timeoutMs: 1000, signal: external.signal,
  });
  external.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
}

// Graceful EOF without [DONE] must throw — and must not report usage for an
// answer that never completed.
{
  let usageFired = false;
  const sink = createSseSink({
    label: 'Test',
    onUsage: () => { usageFired = true; }
  });
  sink.push('data: {"model":"m1","usage":{"completion_tokens":1},"choices":[{"delta":{"content":"partial-clean-eof"}}]}\n\n');
  assert.throws(() => sink.finish(), /не полностью/,
    'a clean EOF without the terminal frame is an incomplete answer');
  assert.equal(usageFired, false, 'no usage report for an incomplete answer');
}

// [DONE] split across chunk boundaries (and left in the trailing buffer)
// still counts: finish() drains the buffer before deciding.
{
  const sink = createSseSink({ label: 'Test' });
  sink.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n\nda');
  sink.push('ta: [DONE]');
  assert.equal(sink.finish(), 'ok');
}

// An empty but COMPLETE stream keeps the sentinel semantics.
{
  const sink = createSseSink({ label: 'Test' });
  sink.push('data: [DONE]\n\n');
  assert.equal(sink.finish(), EMPTY_ANSWER);
}

console.log('sse done contract regression passed');

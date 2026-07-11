/**
 * Fetch a response without ever buffering an unbounded decompressed body.
 * Content-Length is only an early hint: it may be absent and, for compressed
 * responses, describes compressed bytes while the stream exposes decompressed
 * bytes. Counting the stream is therefore the only real memory bound.
 */

export async function fetchBounded(url, { maxBytes, timeoutMs, ...fetchOpts }) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative number');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
    const declared = res.headers.get('content-length');
    if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
      controller.abort();
      throw new Error(`Response body exceeds ${maxBytes} bytes`);
    }
    if (typeof res.body?.getReader !== 'function') {
      controller.abort();
      throw new Error('Response body stream unavailable');
    }

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        try { await reader.cancel('response too large'); } catch { /* already closed by abort */ }
        throw new Error(`Response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { res, bytes };
  } finally {
    clearTimeout(timer);
  }
}

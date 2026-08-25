/**
 * Fetch a response without ever buffering an unbounded decompressed body.
 * Content-Length is only an early hint: it may be absent and, for compressed
 * responses, describes compressed bytes while the stream exposes decompressed
 * bytes. Counting the stream is therefore the only real memory bound.
 */

export async function fetchBounded(url, {
  maxBytes,
  timeoutMs,
  allowedUrl = null,
  maxRedirects = 0,
  ...fetchOpts
}) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative number');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = new URL(url);
    if (allowedUrl && !allowedUrl(current.href)) throw new Error('Request URL left allowlist');
    let res;
    for (let redirects = 0; ; redirects++) {
      res = await fetch(current.href, {
        ...fetchOpts,
        ...(allowedUrl ? { redirect: 'manual' } : {}),
        signal: controller.signal
      });
      const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
      if (!allowedUrl || !isRedirect) break;
      let next;
      try {
        if (redirects >= maxRedirects) throw new Error('Too many redirects');
        const location = res.headers.get('location');
        if (!location) throw new Error('Redirect missing Location');
        next = new URL(location, current);
        if (!allowedUrl(next.href)) throw new Error('Redirect left allowlist');
      } finally {
        try { await res.body?.cancel(); } catch { /* best-effort connection cleanup */ }
      }
      current = next;
    }
    // Browsers report the final URL. Recheck it as defense in depth even though
    // manual redirect walking validated each requested target before fetch().
    if (allowedUrl && res.url && !allowedUrl(res.url)) {
      controller.abort();
      throw new Error('Response URL left allowlist');
    }
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

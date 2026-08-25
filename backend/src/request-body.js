/**
 * Read request bodies without ever buffering more than the route's explicit
 * byte budget. Content-Length is only a fast rejection: an attacker may omit
 * it or use chunked transfer encoding, so the streamed byte count is the
 * authority.
 */
export async function readBodyBounded(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'too_large', status: 413 };
  }
  if (typeof request.body?.getReader !== 'function') {
    return { ok: false, reason: 'bad_body', status: 400 };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('request body too large'); } catch { /* already closed */ }
        return { ok: false, reason: 'too_large', status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'bad_body', status: 400 };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return {
      ok: true,
      bytes,
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    };
  } catch {
    return { ok: false, reason: 'bad_body', status: 400 };
  }
}

export async function readJsonBounded(request, maxBytes) {
  const body = await readBodyBounded(request, maxBytes);
  if (!body.ok) return body;
  try { return { ok: true, value: JSON.parse(body.text) }; }
  catch { return { ok: false, reason: 'bad_json', status: 400 }; }
}

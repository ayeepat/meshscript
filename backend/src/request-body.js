/**
 * Read request bodies without ever buffering more than the route's explicit
 * byte budget. Content-Length is only a fast rejection: an attacker may omit
 * it or use chunked transfer encoding, so the streamed byte count is the
 * authority.
 */
/**
 * Bounded read with NO text decoding. Use for binary payloads (proxied GDZ
 * answer images): readBodyBounded's fatal UTF-8 decode rejects any byte
 * sequence that isn't valid UTF-8, which every JPEG is.
 *
 * Works on a Request or a Response — both expose `headers` and a `body`
 * stream, and both need the same "Content-Length is a hint, the streamed count
 * is the authority" treatment.
 */
export async function readBytesBounded(source, maxBytes) {
  const declared = Number(source.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'too_large', status: 413 };
  }
  if (typeof source.body?.getReader !== 'function') {
    return { ok: false, reason: 'bad_body', status: 400 };
  }

  const reader = source.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('body too large'); } catch { /* already closed */ }
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
  return { ok: true, bytes };
}

export async function readBodyBounded(request, maxBytes) {
  const read = await readBytesBounded(request, maxBytes);
  if (!read.ok) return read;
  try {
    return {
      ok: true,
      bytes: read.bytes,
      text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)
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

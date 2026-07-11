/**
 * Outbound image shrinker. Runs ONLY in the background service worker.
 *
 * Why: every image rides to the provider inside ONE JSON POST body (a data
 * URI in /ai/start for the СМЭШ proxy), and for RU users that whole body must
 * clear the wire within the DPI clamp window (~6–12s of connection life —
 * see smesh-proxy.js). A phone photo of a worksheet is 3–6 MB, a retina PNG
 * even more; as base64 that's 4–8 MB and the upload dies mid-body (observed:
 * 408 with 16 KB received). The proxy server also rejects data URIs over
 * 6 MB. Downscaling to ≤1800 px and re-encoding as JPEG cuts a typical photo
 * 5–15× with no practical loss for reading homework text, and shrinks every
 * provider's token bill along the way.
 *
 * Uses createImageBitmap + OffscreenCanvas (both available in MV3 workers).
 * Fail-open everywhere: any decode/encode problem returns the ORIGINAL file —
 * a too-big upload that might still succeed beats a dropped attachment.
 */

const MAX_SIDE = 1800;            // longest side after downscale — plenty to read a worksheet
const JPEG_QUALITY = 0.8;
const SKIP_UNDER_B64_CHARS = 300_000; // ~220 KB raw: already cheap to ship, not worth a re-encode

// Decompression-bomb guard: a tiny PNG can declare absurd dimensions and blow
// up RAM at DECODE time (w*h*4 bytes), long before any canvas work. Read the
// dimensions straight from the container headers first — cheap, no decode —
// and skip the whole recompression when they're implausible for homework.
const MAX_DECODE_PIXELS = 50_000_000; // ~50 MP ≈ 200 MB RGBA
const MAX_DECODE_SIDE = 20_000;

// Header-level dimensions for the formats we deliberately decode. Returning
// null is a security decision: unknown or malformed formats are never handed to
// createImageBitmap(), because their decoded allocation cannot be bounded first.
export function imageDimensions(bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // PNG: 8-byte signature, then the IHDR chunk carries width/height first.
    if (bytes.length > 24 && dv.getUint32(0) === 0x89504e47 &&
        dv.getUint32(4) === 0x0d0a1a0a && dv.getUint32(8) === 13 &&
        dv.getUint32(12) === 0x49484452) {
      return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    // GIF87a/89a: little-endian logical screen size right after "GIF87a"/"GIF89a".
    if (bytes.length > 10 && dv.getUint32(0) === 0x47494638 &&
        ((bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61)) {
      return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
    }
    // WebP: all three bitstream forms expose dimensions before pixel decode.
    // Simple files start with VP8 / VP8L; extended/animated files use VP8X.
    if (bytes.length >= 30 && dv.getUint32(0) === 0x52494646 && dv.getUint32(8) === 0x57454250) {
      const chunk = dv.getUint32(12);
      if (chunk === 0x56503858) { // VP8X
        const w = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
        const h = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
        return { w, h };
      }
      if (chunk === 0x5650384c && bytes[20] === 0x2f && bytes.length >= 25) { // VP8L
        const bits = dv.getUint32(21, true);
        return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >>> 14) & 0x3fff) };
      }
      if (chunk === 0x56503820 && bytes.length >= 30 &&
          bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) { // VP8
        return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
      }
    }
    // JPEG: walk the marker chain to the first SOF0–SOF15 frame header.
    if (bytes.length > 4 && dv.getUint16(0) === 0xffd8) {
      let off = 2;
      while (off + 9 < bytes.length) {
        if (bytes[off] !== 0xff) { off++; continue; }
        const marker = bytes[off + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
        const len = dv.getUint16(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: dv.getUint16(off + 5), w: dv.getUint16(off + 7) };
        }
        if (len < 2) break;
        off += 2 + len;
      }
    }
  } catch { /* malformed header — fall through */ }
  return null;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000; // chunk so String.fromCharCode args don't overflow the stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Recompress ONE image file ({ mimeType, dataBase64, name }) if it's worth it.
 * Returns the original object untouched for non-images, small images, SVG
 * (createImageBitmap can't size it in a worker), or on any failure.
 */
export async function compressImageFile(f) {
  let bmp = null;
  try {
    const mime = f?.mimeType || '';
    if (!mime.startsWith('image/') || mime === 'image/svg+xml') return f;
    if (!f.dataBase64 || f.dataBase64.length < SKIP_UNDER_B64_CHARS) return f;

    const bytes = base64ToBytes(f.dataBase64);
    // Decode only formats whose dimensions were authenticated by a recognized
    // container header. Unsupported/spoofed formats still ship unchanged, but
    // can no longer trigger an unbounded local bitmap allocation.
    const dim = imageDimensions(bytes);
    if (!dim || dim.w * dim.h > MAX_DECODE_PIXELS ||
        Math.max(dim.w, dim.h) > MAX_DECODE_SIDE || dim.w < 1 || dim.h < 1) {
      return f;
    }
    const blob = new Blob([bytes], { type: mime });
    bmp = await createImageBitmap(blob);
    // Backstop against a decoder/container disagreement.
    if (bmp.width * bmp.height > MAX_DECODE_PIXELS ||
        Math.max(bmp.width, bmp.height) > MAX_DECODE_SIDE || bmp.width < 1 || bmp.height < 1) {
      return f;
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha — a transparent PNG would otherwise composite onto
    // BLACK and turn a line drawing into an unreadable dark blob.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);

    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    const outB64 = bytesToBase64(new Uint8Array(await out.arrayBuffer()));
    // A rare pathological case (already-optimal JPEG) can come out bigger.
    if (outB64.length >= f.dataBase64.length) return f;
    return { ...f, mimeType: 'image/jpeg', dataBase64: outB64 };
  } catch {
    return f;
  } finally {
    try { bmp?.close(); } catch { /* already closed */ }
  }
}

/** Recompress every image in a files array; non-images pass through as-is. */
export async function compressImageFiles(files = []) {
  return Promise.all(files.map(compressImageFile));
}

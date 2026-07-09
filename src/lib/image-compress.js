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
  try {
    const mime = f?.mimeType || '';
    if (!mime.startsWith('image/') || mime === 'image/svg+xml') return f;
    if (!f.dataBase64 || f.dataBase64.length < SKIP_UNDER_B64_CHARS) return f;

    const blob = new Blob([base64ToBytes(f.dataBase64)], { type: mime });
    const bmp = await createImageBitmap(blob);
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
    bmp.close();

    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    const outB64 = bytesToBase64(new Uint8Array(await out.arrayBuffer()));
    // A rare pathological case (already-optimal JPEG) can come out bigger.
    if (outB64.length >= f.dataBase64.length) return f;
    return { ...f, mimeType: 'image/jpeg', dataBase64: outB64 };
  } catch {
    return f;
  }
}

/** Recompress every image in a files array; non-images pass through as-is. */
export async function compressImageFiles(files = []) {
  return Promise.all(files.map(compressImageFile));
}

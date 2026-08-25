/**
 * Local text extraction for Office Open XML files (.docx / .pptx / .xlsx) and
 * a file-prep pass — WITHOUT any network or AI call.
 *
 * Office files are ZIP containers of XML. The service worker has a native
 * DecompressionStream (raw DEFLATE), so we parse the ZIP central directory
 * ourselves and inflate only the parts that hold text. This turns attachments
 * that both providers used to refuse ("офисные файлы я не читаю") into inline
 * text the model can actually solve from — and it spends zero API credits.
 *
 * prepareFiles() runs once in the solver: each office file becomes a text/plain
 * file carrying its extracted contents; everything else passes through. Images,
 * PDFs and plain text are already handled downstream, so this only adds the
 * missing Office formats.
 */

import { isOfficeFile } from './file-kinds.js';
import { clipText } from './clip-text.js';

/* ---------- base64 <-> bytes/utf-8 ---------- */

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function base64ToUtf8(b64) {
  try { return new TextDecoder('utf-8', { fatal: false }).decode(base64ToBytes(b64)); }
  catch { return null; }
}

export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000; // chunk so String.fromCharCode args don't overflow the stack
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/* ---------- minimal ZIP reader ---------- */

const MAX_ZIP_ENTRIES = 4096;

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Read the central directory: it carries reliable compression methods, sizes
// and offsets (local headers may defer sizes to a trailing data descriptor).
function readZip(buf) {
  if (buf.length < 22) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Scan backwards for the End Of Central Directory signature (PK\x05\x06).
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50 &&
        i + 22 + dv.getUint16(i + 20, true) === buf.length) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const disk = dv.getUint16(eocd + 4, true);
  const centralDisk = dv.getUint16(eocd + 6, true);
  const diskCount = dv.getUint16(eocd + 8, true);
  const count = dv.getUint16(eocd + 10, true);
  const centralSize = dv.getUint32(eocd + 12, true);
  const centralOffset = dv.getUint32(eocd + 16, true);
  const commentLength = dv.getUint16(eocd + 20, true);
  // This reader intentionally supports one ordinary (non-ZIP64) disk only.
  // Requiring the directory to end exactly at EOCD makes every offset/length
  // below relative to one validated region rather than attacker-chosen bytes.
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count ||
      count > MAX_ZIP_ENTRIES || count === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff ||
      eocd + 22 + commentLength !== buf.length ||
      centralOffset > eocd || centralSize !== eocd - centralOffset) return null;

  const centralEnd = centralOffset + centralSize;
  let off = centralOffset;
  const entries = [];
  const localOffsets = new Set();
  const names = new Set();
  for (let n = 0; n < count; n++) {
    if (off + 46 > centralEnd || dv.getUint32(off, true) !== 0x02014b50) return null;
    const flags = dv.getUint16(off + 8, true);
    const method = dv.getUint16(off + 10, true);
    const crc = dv.getUint32(off + 16, true);
    const compSize = dv.getUint32(off + 20, true);
    const outSize = dv.getUint32(off + 24, true);
    const fnLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const startDisk = dv.getUint16(off + 34, true);
    const localOff = dv.getUint32(off + 42, true);
    const next = off + 46 + fnLen + extraLen + commentLen;
    if (next > centralEnd || startDisk !== 0 || (flags & 1) !== 0 ||
        localOff === 0xffffffff || localOffsets.has(localOff) || localOff + 30 > centralOffset) return null;

    const nameBytes = buf.subarray(off + 46, off + 46 + fnLen);
    const localFlags = dv.getUint16(localOff + 6, true);
    const localMethod = dv.getUint16(localOff + 8, true);
    const localNameLen = dv.getUint16(localOff + 26, true);
    const localExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dv.getUint32(localOff, true) !== 0x04034b50 || localFlags !== flags ||
        localMethod !== method || dataStart > centralOffset || dataEnd > centralOffset ||
        !sameBytes(nameBytes, buf.subarray(localOff + 30, localOff + 30 + localNameLen))) return null;
    // Without a data descriptor the local CRC/sizes must corroborate the
    // central directory. Stored entries cannot change size by definition.
    if ((flags & 0x08) === 0 &&
        (dv.getUint32(localOff + 14, true) !== crc ||
         dv.getUint32(localOff + 18, true) !== compSize ||
         dv.getUint32(localOff + 22, true) !== outSize)) return null;
    if (method === 0 && compSize !== outSize) return null;

    const name = new TextDecoder().decode(nameBytes);
    if (names.has(name)) return null;
    entries.push({ name, method, compSize, outSize, crc, localOff, dataStart, localEnd: dataEnd });
    names.add(name);
    localOffsets.add(localOff);
    off = next;
  }
  if (off !== centralEnd) return null;
  const localRanges = [...entries].sort((a, b) => a.localOff - b.localOff);
  for (let i = 1; i < localRanges.length; i++) {
    if (localRanges[i - 1].localEnd > localRanges[i].localOff) return null;
  }
  return { buf, dv, entries };
}

// ZIP-bomb guards: a real OOXML text part is a few MB at worst, but DEFLATE
// happily expands a kilobyte of input into gigabytes. Cap each entry's
// decompressed size AND the ratio against its compressed size, plus one shared
// budget across all entries of a document — homework never legitimately gets
// near these numbers.
const MAX_ENTRY_OUT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_OUT_BYTES = 48 * 1024 * 1024;
const MAX_INFLATE_RATIO = 400; // vs compSize, for entries over ~4 KB

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Bounded streaming inflate: count output bytes as they arrive and abort the
// stream the moment the cap is crossed — never buffer an unbounded body.
async function inflateRaw(bytes, maxOut) {
  const ds = new DecompressionStream('deflate-raw');
  const reader = new Blob([bytes]).stream().pipeThrough(ds).getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxOut) {
        try { await reader.cancel('zip entry too large'); } catch { /* closed */ }
        return null;
      }
      chunks.push(value);
    }
  } catch { return null; }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// Decompressed bytes for one central-directory entry, or null. `budget` is the
// per-document remaining-output allowance ({ left }) shared across entries.
async function readEntry(zip, entry, budget) {
  const { buf } = zip;
  if (entry.outSize > MAX_ENTRY_OUT_BYTES || entry.outSize > (budget?.left ?? MAX_TOTAL_OUT_BYTES)) return null;
  const data = buf.subarray(entry.dataStart, entry.dataStart + entry.compSize);
  const ratioCap = entry.compSize > 4096 ? entry.compSize * MAX_INFLATE_RATIO : MAX_ENTRY_OUT_BYTES;
  if (entry.outSize > ratioCap) return null;
  const maxOut = Math.min(MAX_ENTRY_OUT_BYTES, ratioCap, entry.outSize, budget?.left ?? MAX_TOTAL_OUT_BYTES);
  if (maxOut <= 0) return null;
  let out = null;
  if (entry.method === 0) out = data.byteLength <= maxOut ? data : null; // stored
  else if (entry.method === 8) out = await inflateRaw(data, maxOut);     // deflate
  if (out && (out.byteLength !== entry.outSize || crc32(out) !== entry.crc)) out = null;
  if (out && budget) budget.left -= out.byteLength;
  return out;
}

function readNamed(zip, name, budget) {
  const e = zip.entries.find((x) => x.name === name);
  return e ? readEntry(zip, e, budget) : Promise.resolve(null);
}

/* ---------- XML -> text ---------- */

const decodeBytes = (bytes) => new TextDecoder('utf-8', { fatal: false }).decode(bytes);

function xmlEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&'); // last, so a literal &amp;lt; survives correctly
}

function tidy(s) {
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

// In OOXML, visible text lives only inside text-run tags; everything else is
// structural. So we turn the structural breaks we care about into whitespace,
// strip all remaining tags, and what's left is the document's text.
function docxToText(xml) {
  const s = xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return tidy(xmlEntities(s));
}

function slideToText(xml) {
  const s = xml
    .replace(/<a:br\b[^>]*\/?>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return tidy(xmlEntities(s));
}

// sharedStrings.xml holds all TEXT cell values, one per <si> entry, indexed by
// the position the worksheet's `t="s"` cells reference. An <si> can hold either
// a single <t> or several <r><t> runs (rich text) — concatenate the runs.
//
// NOTE: an earlier version read ONLY sharedStrings (text cells) and so dropped
// every numeric cell — a mostly-numeric sheet extracted to empty and the user
// was wrongly told to "send it as a PDF/photo". We now parse the worksheets too.
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  xml.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (_, si) => {
    let s = '';
    si.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, (__, t) => { s += t; return ''; });
    out.push(xmlEntities(s));
    return '';
  });
  return out;
}

// A worksheet stores each cell as <c r="A1" t="..."><v>…</v></c> (or an inline
// <is><t>…</t></is> for inline strings). Numbers are stored INLINE in <v> and
// are NOT in sharedStrings, so reading sharedStrings alone drops every numeric
// cell — the bug this fixes. Resolve `t="s"` refs against the shared strings and
// take the literal <v> for everything else (numbers, booleans). Rows are
// newline-separated and cells tab-separated with padding for skipped columns,
// so the original table alignment survives into the model prompt.
function sheetToText(xml, shared) {
  const rows = [];
  xml.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (_, row) => {
    const cells = [];
    let lastIndex = -1;
    row.replace(/<c\b([^>]*)>([\s\S]*?)<\/c>/g, (__, attrs, body) => {
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      let val = '';
      if (type === 's') {
        const v = (body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        if (v != null) val = shared[+v] ?? '';
      } else if (type === 'inlineStr') {
        body.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, (___, t) => { val += t; return ''; });
        val = xmlEntities(val);
      } else {
        const v = (body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        if (v != null) val = xmlEntities(v);
      }
      if (val !== '') {
        const columnLetters = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
        let columnIndex = -1;
        if (columnLetters) {
          columnIndex = 0;
          for (const letter of columnLetters) columnIndex = columnIndex * 26 + letter.charCodeAt(0) - 64;
          columnIndex -= 1;
        }
        if (columnIndex < 0 || columnIndex > lastIndex + 64) {
          // A real homework sheet does not jump across >64 empty columns. Clamp
          // hostile coordinates such as XFD1 instead of allocating a 16K row.
          columnIndex = lastIndex + 1;
        }
        while (cells.length <= columnIndex) cells.push('');
        cells[columnIndex] = val;
        lastIndex = Math.max(lastIndex, columnIndex);
      }
      return '';
    });
    if (cells.length) rows.push(cells.join('\t'));
    return '';
  });
  return rows.join('\n');
}

/**
 * Extract plain text from a .docx/.pptx/.xlsx file object {mimeType, dataBase64,
 * name}. Returns null for anything that isn't a readable OOXML zip (e.g. a
 * legacy binary .doc/.ppt/.xls), so the caller can fall back gracefully.
 */
export async function extractOfficeText(file) {
  const buf = base64ToBytes(file.dataBase64 || '');
  const zip = readZip(buf);
  if (!zip) return null;

  const name = (file.name || '').toLowerCase();
  const mime = (file.mimeType || '').toLowerCase();
  // Shared decompressed-output budget for every entry of this document — the
  // per-entry and ratio caps live in readEntry (zip-bomb guard).
  const budget = { left: MAX_TOTAL_OUT_BYTES };
  let text = '';

  if (name.endsWith('.docx') || mime.includes('wordprocessingml')) {
    const bytes = await readNamed(zip, 'word/document.xml', budget);
    if (bytes) text = docxToText(decodeBytes(bytes));
  } else if (name.endsWith('.pptx') || mime.includes('presentationml')) {
    const slides = zip.entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .sort((a, b) => (+a.name.match(/(\d+)/)[1]) - (+b.name.match(/(\d+)/)[1]));
    const chunks = [];
    for (let i = 0; i < slides.length; i++) {
      const bytes = await readEntry(zip, slides[i], budget);
      const t = bytes && slideToText(decodeBytes(bytes));
      if (t) chunks.push(`[Слайд ${i + 1}]\n${t}`);
    }
    text = chunks.join('\n\n');
  } else if (name.endsWith('.xlsx') || mime.includes('spreadsheetml')) {
    // Read shared strings (text cells) AND every worksheet (numbers live inline
    // in the sheet, not in sharedStrings — see sheetToText). A purely-numeric
    // spreadsheet has an empty/absent sharedStrings.xml, so worksheet parsing is
    // what makes numeric data extractable at all.
    const ssBytes = await readNamed(zip, 'xl/sharedStrings.xml', budget);
    const shared = parseSharedStrings(ssBytes ? decodeBytes(ssBytes) : '');
    const sheets = zip.entries
      .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
      .sort((a, b) => (+a.name.match(/(\d+)/)[1]) - (+b.name.match(/(\d+)/)[1]));
    const chunks = [];
    for (let i = 0; i < sheets.length; i++) {
      const bytes = await readEntry(zip, sheets[i], budget);
      const t = bytes && sheetToText(decodeBytes(bytes), shared);
      if (t) chunks.push(sheets.length > 1 ? `[Лист ${i + 1}]\n${t}` : t);
    }
    text = chunks.join('\n\n');
    // Fallback: if worksheet parsing yielded nothing (unusual layout), at least
    // surface the shared text strings so a text-only sheet still extracts.
    if (!text && shared.length) text = tidy(shared.join('\n'));
  }

  text = clipText(text || '', 100000).trim();
  return text || null;
}

/**
 * Pre-process an upload list before it reaches a provider: replace each Office
 * file with a text/plain file carrying its extracted contents (keeping the
 * original name so the model sees which file it came from). Best-effort — if a
 * file can't be parsed it passes through unchanged and the provider's existing
 * "send it as PDF/photo" note applies.
 */
export async function prepareFiles(files = []) {
  const out = [];
  for (const f of files) {
    if (isOfficeFile(f)) {
      let text = null;
      try { text = await extractOfficeText(f); } catch { /* fall through */ }
      if (text) {
        out.push({ mimeType: 'text/plain', dataBase64: utf8ToBase64(text), name: f.name });
        continue;
      }
    }
    out.push(f);
  }
  return out;
}

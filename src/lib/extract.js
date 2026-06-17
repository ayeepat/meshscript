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

// Read the central directory: it carries reliable compression methods, sizes
// and offsets (local headers may defer sizes to a trailing data descriptor).
function readZip(buf) {
  if (buf.length < 22) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Scan backwards for the End Of Central Directory signature (PK\x05\x06).
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const fnLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + fnLen));
    entries.push({ name, method, compSize, localOff });
    off += 46 + fnLen + extraLen + commentLen;
  }
  return { buf, dv, entries };
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Decompressed bytes for one central-directory entry, or null.
async function readEntry(zip, entry) {
  const { buf, dv } = zip;
  if (dv.getUint32(entry.localOff, true) !== 0x04034b50) return null;
  const fnLen = dv.getUint16(entry.localOff + 26, true);
  const extraLen = dv.getUint16(entry.localOff + 28, true);
  const start = entry.localOff + 30 + fnLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data;            // stored
  if (entry.method === 8) return inflateRaw(data); // deflate
  return null;
}

function readNamed(zip, name) {
  const e = zip.entries.find((x) => x.name === name);
  return e ? readEntry(zip, e) : Promise.resolve(null);
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
// take the literal <v> for everything else (numbers, booleans). Rows are newline-
// separated, cells tab-separated, so the layout survives into the model prompt.
function sheetToText(xml, shared) {
  const rows = [];
  xml.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (_, row) => {
    const cells = [];
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
      if (val !== '') cells.push(val);
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
  let text = '';

  if (name.endsWith('.docx') || mime.includes('wordprocessingml')) {
    const bytes = await readNamed(zip, 'word/document.xml');
    if (bytes) text = docxToText(decodeBytes(bytes));
  } else if (name.endsWith('.pptx') || mime.includes('presentationml')) {
    const slides = zip.entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .sort((a, b) => (+a.name.match(/(\d+)/)[1]) - (+b.name.match(/(\d+)/)[1]));
    const chunks = [];
    for (let i = 0; i < slides.length; i++) {
      const bytes = await readEntry(zip, slides[i]);
      const t = bytes && slideToText(decodeBytes(bytes));
      if (t) chunks.push(`[Слайд ${i + 1}]\n${t}`);
    }
    text = chunks.join('\n\n');
  } else if (name.endsWith('.xlsx') || mime.includes('spreadsheetml')) {
    // Read shared strings (text cells) AND every worksheet (numbers live inline
    // in the sheet, not in sharedStrings — see sheetToText). A purely-numeric
    // spreadsheet has an empty/absent sharedStrings.xml, so worksheet parsing is
    // what makes numeric data extractable at all.
    const ssBytes = await readNamed(zip, 'xl/sharedStrings.xml');
    const shared = parseSharedStrings(ssBytes ? decodeBytes(ssBytes) : '');
    const sheets = zip.entries
      .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
      .sort((a, b) => (+a.name.match(/(\d+)/)[1]) - (+b.name.match(/(\d+)/)[1]));
    const chunks = [];
    for (let i = 0; i < sheets.length; i++) {
      const bytes = await readEntry(zip, sheets[i]);
      const t = bytes && sheetToText(decodeBytes(bytes), shared);
      if (t) chunks.push(sheets.length > 1 ? `[Лист ${i + 1}]\n${t}` : t);
    }
    text = chunks.join('\n\n');
    // Fallback: if worksheet parsing yielded nothing (unusual layout), at least
    // surface the shared text strings so a text-only sheet still extracts.
    if (!text && shared.length) text = tidy(shared.join('\n'));
  }

  text = (text || '').slice(0, 100000).trim();
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

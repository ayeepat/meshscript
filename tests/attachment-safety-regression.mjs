import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';

import { extractOfficeText } from '../src/lib/extract.js';
import { compressImageFile } from '../src/lib/image-compress.js';
import { clipText } from '../src/lib/clip-text.js';
import {
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_PROXY_MESSAGES_CHARS,
  MAX_REQUEST_FILE_BYTES,
  deduplicateRequestFiles,
  validateProxyMessagesBudget,
  validateRequestFileBudget
} from '../src/lib/upload-limits.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(name, text, method = 0) {
  const nameBytes = Buffer.from(name);
  const output = Buffer.from(text);
  const data = method === 8 ? deflateRawSync(output) : output;
  const crc = crc32(output);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(output.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const centralOffset = local.length + nameBytes.length + data.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(output.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, eocd]);
}

const documentXml = '<w:document><w:body><w:p><w:r><w:t>Безопасный ZIP</w:t></w:r></w:p></w:body></w:document>';
const goodZip = makeZip('word/document.xml', documentXml);
const officeFile = (bytes) => ({ name: 'task.docx', dataBase64: bytes.toString('base64') });
assert.equal(await extractOfficeText(officeFile(goodZip)), 'Безопасный ZIP');
assert.equal(
  await extractOfficeText(officeFile(makeZip('word/document.xml', documentXml, 8))),
  'Безопасный ZIP',
  'normal DEFLATE-compressed OOXML entries must still extract'
);

const sheetXml = '<worksheet><sheetData><row r="1">' +
  '<c r="A1" t="inlineStr"><is><t>A</t></is></c>' +
  '<c r="C1" t="inlineStr"><is><t>C</t></is></c>' +
  '</row></sheetData></worksheet>';
const sheetFile = {
  name: 'gap.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  dataBase64: makeZip('xl/worksheets/sheet1.xml', sheetXml).toString('base64')
};
assert.equal(
  await extractOfficeText(sheetFile),
  'A\t\tC',
  'XLSX extraction must preserve empty columns from cell coordinates'
);

assert.equal(clipText('коротко', 20), 'коротко', 'under-limit source text stays byte-for-byte unchanged');
const clipped = clipText('x'.repeat(50001), 50000);
assert.ok(clipped.startsWith('x'.repeat(50000)), 'clipped source keeps the requested original prefix');
assert.ok(
  clipped.endsWith('\n[…текст обрезан: файл длиннее 50 000 символов, показано начало]'),
  'clipped source ends with an explicit readable Russian truncation marker'
);

const badCount = Buffer.from(goodZip);
badCount.writeUInt16LE(4097, badCount.length - 14);
badCount.writeUInt16LE(4097, badCount.length - 12);
assert.equal(await extractOfficeText(officeFile(badCount)), null, 'oversized ZIP entry counts must be rejected');

const badCentralSize = Buffer.from(goodZip);
badCentralSize.writeUInt32LE(1, badCentralSize.length - 10);
assert.equal(await extractOfficeText(officeFile(badCentralSize)), null, 'inconsistent central directory bounds must be rejected');

const badLocalOffset = Buffer.from(goodZip);
const centralOffset = badLocalOffset.readUInt32LE(badLocalOffset.length - 6);
badLocalOffset.writeUInt32LE(centralOffset + 1, centralOffset + 42);
assert.equal(await extractOfficeText(officeFile(badLocalOffset)), null, 'local headers outside the data region must be rejected');

const badCrc = Buffer.from(goodZip);
badCrc.writeUInt32LE(0, centralOffset + 16);
badCrc.writeUInt32LE(0, 14);
assert.equal(await extractOfficeText(officeFile(badCrc)), null, 'entry CRC mismatches must be rejected');

const makeLargeWebp = (kind) => {
  const bytes = Buffer.alloc(230_000);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write(kind, 12, 'ascii');
  if (kind === 'VP8X') {
    bytes.writeUInt32LE(10, 16);
    const widthMinusOne = 20_000;
    bytes[24] = widthMinusOne & 0xff;
    bytes[25] = (widthMinusOne >>> 8) & 0xff;
    bytes[26] = (widthMinusOne >>> 16) & 0xff;
  } else if (kind === 'VP8L') {
    bytes.writeUInt32LE(5, 16);
    bytes[20] = 0x2f;
    const packed = 0x3fff | (0x3fff << 14);
    bytes.writeUInt32LE(packed >>> 0, 21);
  } else {
    bytes.writeUInt32LE(10, 16);
    bytes[23] = 0x9d;
    bytes[24] = 0x01;
    bytes[25] = 0x2a;
    bytes.writeUInt16LE(0x3fff, 26);
    bytes.writeUInt16LE(0x3fff, 28);
  }
  return { name: 'bomb.webp', mimeType: 'image/webp', dataBase64: bytes.toString('base64') };
};

let bitmapCalls = 0;
globalThis.createImageBitmap = async () => { bitmapCalls++; throw new Error('must not decode'); };
for (const kind of ['VP8X', 'VP8L', 'VP8 ']) {
  const file = makeLargeWebp(kind);
  assert.equal(await compressImageFile(file), file);
}
assert.equal(bitmapCalls, 0, 'oversized WebP dimensions must be rejected before createImageBitmap');

const unknownImage = {
  name: 'unknown.bmp', mimeType: 'image/bmp',
  dataBase64: Buffer.alloc(300_001, 0x41).toString('base64')
};
assert.equal(await compressImageFile(unknownImage), unknownImage);
assert.equal(bitmapCalls, 0, 'unrecognised image formats must never reach createImageBitmap');

const spoofedPng = {
  name: 'spoofed.png', mimeType: 'image/png',
  dataBase64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300_001)]).toString('base64')
};
assert.equal(await compressImageFile(spoofedPng), spoofedPng);
assert.equal(bitmapCalls, 0, 'partial image signatures must never reach createImageBitmap');

assert.equal(MAX_REQUEST_FILE_BYTES, 6 * 1024 * 1024);
const proxySource = readFileSync(new URL('../backend-vps/server.js', import.meta.url), 'utf8');
const proxyLimitMiB = Number(proxySource.match(/MAX_BLOB_CHARS\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/)?.[1]);
assert.equal(proxyLimitMiB, 9, 'the regression assumes the licensed proxy messages-blob ceiling is 9 MiB');
assert.equal(
  MAX_PROXY_MESSAGES_CHARS,
  proxyLimitMiB * 1024 * 1024,
  'the exact client-side serialized messages ceiling must match the VPS blob ceiling'
);
assert.ok(
  Math.ceil(MAX_REQUEST_FILE_BYTES * 4 / 3) <= (proxyLimitMiB - 1) * 1024 * 1024,
  'base64 attachments must leave at least 1 MiB of the proxy blob for JSON, prompts and replayed text'
);
const threeMiBBase64 = 'A'.repeat(4 * 1024 * 1024);
const atLimit = validateRequestFileBudget([
  { name: 'one.pdf', dataBase64: threeMiBBase64 },
  { name: 'two.pdf', dataBase64: threeMiBBase64 }
]);
assert.equal(atLimit.ok, true, 'multiple files may fill the shared 6 MiB decoded budget exactly');
const overLimit = validateRequestFileBudget([
  { name: 'one.pdf', dataBase64: threeMiBBase64 },
  { name: 'two.pdf', dataBase64: threeMiBBase64 + 'AAAA' }
]);
assert.equal(overLimit.ok, false, 'combined files over the proxy-safe budget must be rejected locally');

const base64ForBytes = (bytes) => {
  const groups = Math.floor(bytes / 3);
  const remainder = bytes % 3;
  return 'A'.repeat(groups * 4) + (remainder === 1 ? 'AA==' : remainder === 2 ? 'AAA=' : '');
};
const tenMiBAudio = { name: 'lesson.mp3', mimeType: 'audio/mpeg', dataBase64: base64ForBytes(10 * 1024 * 1024) };
const fiveMiBPdf = { name: 'task.pdf', mimeType: 'application/pdf', dataBase64: base64ForBytes(5 * 1024 * 1024) };
assert.equal(validateRequestFileBudget([tenMiBAudio]).ok, true, '10 MiB audio alone fits the Whisper budget');
assert.equal(
  validateRequestFileBudget([tenMiBAudio, fiveMiBPdf]).ok,
  true,
  'audio and non-audio aggregates use independent request budgets'
);
assert.equal(
  validateRequestFileBudget([{ name: 'large.pdf', dataBase64: base64ForBytes(7 * 1024 * 1024) }]).ok,
  false,
  '7 MiB of non-audio files still exceeds the proxy-safe aggregate'
);
const overAudio = validateRequestFileBudget([{
  name: 'long.mp3', mimeType: 'audio/mpeg', dataBase64: base64ForBytes(MAX_AUDIO_UPLOAD_BYTES + 1024 * 1024)
}]);
assert.equal(overAudio.ok, false, '26 MiB of audio exceeds the Whisper aggregate');
assert.match(overAudio.error, /аудиофайлов/, 'audio aggregate failures identify the audio-specific limit');

const replayA = 'A'.repeat(2048);
const replayB = replayA.slice(0, 1024) + 'B' + replayA.slice(1025, -1) + 'C';
const replayFiles = deduplicateRequestFiles([
  { name: 'template.pdf', dataBase64: replayA },
  { name: 'template.pdf', dataBase64: replayB },
  { name: 'template.pdf', dataBase64: replayA }
]);
assert.equal(replayFiles.files.length, 2, 'middle/end differences prevent a same-name same-length collision');
assert.equal(replayFiles.files[0].dataBase64, replayA);
assert.equal(replayFiles.files[1].dataBase64, replayB, 'an actually identical replay is still removed');

// The cheap replay bucket samples only head/middle/tail. A distinct body whose
// changed byte is outside those samples must survive; the bucket is an
// optimization, never an equality decision.
const replayUnsampled = replayA.slice(0, 400) + 'Z' + replayA.slice(401);
const sampledCollisionFiles = deduplicateRequestFiles([
  { name: 'same-name.pdf', dataBase64: replayA },
  { name: 'same-name.pdf', dataBase64: replayUnsampled },
  { name: 'same-name.pdf', dataBase64: replayA }
]);
assert.equal(sampledCollisionFiles.files.length, 2,
  'same-name/length files that collide in all samples must remain distinct');
assert.equal(sampledCollisionFiles.files[1].dataBase64, replayUnsampled);

const emptyMessageJson = JSON.stringify([{ role: 'user', content: '' }]);
const exactMessages = [{
  role: 'user',
  content: 'x'.repeat(MAX_PROXY_MESSAGES_CHARS - emptyMessageJson.length)
}];
const exactMessagesBudget = validateProxyMessagesBudget(exactMessages);
assert.equal(exactMessagesBudget.ok, true, 'the exact 9 MiB messages JSON boundary must be accepted');
assert.equal(exactMessagesBudget.totalChars, MAX_PROXY_MESSAGES_CHARS);
exactMessages[0].content += 'x';
assert.equal(
  validateProxyMessagesBudget(exactMessages).ok,
  false,
  'prompt and replayed text must not push the serialized messages blob even one character over its ceiling'
);

const smeshProxySource = readFileSync(new URL('../src/lib/smesh-proxy.js', import.meta.url), 'utf8');
assert.match(
  smeshProxySource,
  /validateProxyMessagesBudget\(messages\)/,
  'the exact serialized-size guard must run at the licensed proxy boundary'
);
assert.match(smeshProxySource,
  /if \(!jobId \|\| !jobToken\) throw new Error/,
  'a tokenless start response must fail before polling or unauthenticated cancellation');
assert.match(smeshProxySource,
  /!isUploadToken\(ticket\.upload_token\) \|\| !isUuidV4\(ticket\.blob_id\)/,
  'blob capabilities must accept the base64url token and UUID blob id emitted by the VPS');
const fetchTextBody = smeshProxySource.slice(
  smeshProxySource.indexOf('async function fetchText('),
  smeshProxySource.indexOf('// Abort-aware sleep')
);
assert.match(fetchTextBody,
  /readResponseTextBounded[\s\S]*?if \(ctrl\.signal\.aborted\) throw new DOMException/,
  'a body-read timeout must not be returned as a successful empty response');

// These scripts are classic content/background entry points, so keep a small
// wiring assertion that the production timers span body reads via finally.
for (const path of ['../src/background/service-worker.js', '../src/content/scraper.js']) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(source, /ATTACHMENT_FETCH_TIMEOUT_MS\s*=\s*30\s*\*\s*1000/);
  assert.match(source, /setTimeout\(\(\) => ctrl\.abort\(\), ATTACHMENT_FETCH_TIMEOUT_MS\)/);
  assert.match(source, /finally\s*\{[\s\S]*?clearTimeout\(timer\);[\s\S]*?ctrl\.abort\(\);/);
}
const scraperSource = readFileSync(new URL('../src/content/scraper.js', import.meta.url), 'utf8');
assert.match(scraperSource, /MESH_LESSON_JSON_MAX_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/);
assert.doesNotMatch(scraperSource, /await res\.(?:json|text)\(/,
  'Mesh API and diagnostic responses must use streamed byte-capped readers');

// Execute the production normalizer. Reserved-character escapes are already a
// valid part of URL.href; decoding and re-encoding them turns %2F into %252F
// and invalidates signed attachment URLs.
{
  const start = scraperSource.indexOf('function normalizeUrl(');
  const end = scraperSource.indexOf('// Bounds ONE diagnostic probe', start);
  assert.ok(start >= 0 && end > start, 'attachment URL normalizer must be extractable');
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${scraperSource.slice(start, end)}\nthis.normalizeUrl = normalizeUrl;`,
    context
  );
  const encoded = 'https://school.mos.ru/ej/attachments/a%2Fb.pdf?sig=x%2Fy%3Dz%26q';
  assert.equal(context.normalizeUrl(encoded), encoded,
    'valid reserved-character escapes must survive normalization byte-for-byte');
}

console.log('attachment safety regressions passed');

import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_HEADER = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORED = 0;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = (1 << 5) | 1; // 1980-01-01
const ZIP_UNIX_FILE_MODE = (0o100644 << 16) >>> 0;
const MAX_ZIP_32 = 0xffffffff;
const compareArchiveNames = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const PACKAGE_TREES = Object.freeze([
  { directory: 'src', extensions: new Set(['.css', '.html', '.js', '.mjs']) },
  { directory: 'assets/fonts', extensions: new Set(['.woff2']) },
  { directory: 'assets/icons', extensions: new Set(['.png']) },
  // Product screenshots shown by the onboarding tour. Bundled rather than
  // hotlinked from the site: the tour is the student's first minute with the
  // extension and must not depend on the network to have any pictures in it.
  { directory: 'assets/onboarding', extensions: new Set(['.jpg']) },
]);

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  crcTable[index] = value >>> 0;
}

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertArchiveName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') ||
      name.includes('\\') || name.startsWith('/') ||
      name !== path.posix.normalize(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe extension archive path: ${JSON.stringify(name)}`);
  }
  if (!/^[\x20-\x7e]+$/.test(name)) {
    throw new Error(`extension archive paths must be printable ASCII: ${JSON.stringify(name)}`);
  }
}

async function collectTree(repoRoot, tree) {
  const files = [];
  async function walk(relativeDirectory) {
    const absoluteDirectory = path.join(repoRoot, relativeDirectory);
    const directoryStat = await lstat(absoluteDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`extension package root must be a real directory: ${relativeDirectory}`);
    }
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => compareArchiveNames(left.name, right.name));
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symbolic links are forbidden in the extension package: ${relative}`);
      }
      if (entry.isDirectory()) {
        await walk(relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`unsupported filesystem entry in extension package: ${relative}`);
      }
      if (!tree.extensions.has(path.extname(entry.name))) continue;
      files.push(relative);
    }
  }
  await walk(tree.directory);
  return files;
}

export async function collectExtensionEntries(repoRoot = DEFAULT_ROOT) {
  const manifestStat = await lstat(path.join(repoRoot, 'manifest.json'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error('manifest.json must be a regular file');
  }
  const names = ['manifest.json'];
  for (const tree of PACKAGE_TREES) names.push(...await collectTree(repoRoot, tree));
  names.sort();
  if (new Set(names).size !== names.length) throw new Error('duplicate extension package path');

  const entries = [];
  for (const name of names) {
    assertArchiveName(name);
    const data = await readFile(path.join(repoRoot, ...name.split('/')));
    if (data.length > MAX_ZIP_32) throw new Error(`file exceeds ZIP32 limit: ${name}`);
    entries.push({ name, data });
  }
  return entries;
}

function localHeader(entry, nameBytes, crc) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(ZIP_LOCAL_HEADER, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  header.writeUInt16LE(ZIP_STORED, 8);
  header.writeUInt16LE(ZIP_DOS_TIME, 10);
  header.writeUInt16LE(ZIP_DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(entry, nameBytes, crc, localOffset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(ZIP_CENTRAL_HEADER, 0);
  header.writeUInt16LE((3 << 8) | ZIP_VERSION, 4);
  header.writeUInt16LE(ZIP_VERSION, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  header.writeUInt16LE(ZIP_STORED, 10);
  header.writeUInt16LE(ZIP_DOS_TIME, 12);
  header.writeUInt16LE(ZIP_DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(entry.data.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(ZIP_UNIX_FILE_MODE, 38);
  header.writeUInt32LE(localOffset, 42);
  return header;
}

export function createExtensionZip(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('extension package is empty');
  if (entries.length > 0xffff) throw new Error('extension package exceeds ZIP32 entry limit');

  const sorted = [...entries].sort((left, right) => compareArchiveNames(left.name, right.name));
  if (new Set(sorted.map((entry) => entry.name)).size !== sorted.length) {
    throw new Error('duplicate extension package path');
  }

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of sorted) {
    assertArchiveName(entry.name);
    if (!Buffer.isBuffer(entry.data)) throw new TypeError(`entry data must be a Buffer: ${entry.name}`);
    const nameBytes = Buffer.from(entry.name, 'utf8');
    if (nameBytes.length > 0xffff) throw new Error(`ZIP path is too long: ${entry.name}`);
    const crc = crc32(entry.data);
    const local = localHeader(entry, nameBytes, crc);
    const central = centralHeader(entry, nameBytes, crc, localOffset);
    localParts.push(local, nameBytes, entry.data);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + entry.data.length;
    if (localOffset > MAX_ZIP_32) throw new Error('extension package exceeds ZIP32 size limit');
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.length > MAX_ZIP_32 ||
      localOffset + centralDirectory.length > MAX_ZIP_32) {
    throw new Error('extension package exceeds ZIP32 directory limit');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_HEADER, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function checkedSlice(buffer, start, length, label) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) ||
      start < 0 || length < 0 || start + length > buffer.length) {
    throw new Error(`truncated ZIP ${label}`);
  }
  return buffer.subarray(start, start + length);
}

function requireHeaderField(actual, expected, label) {
  if (actual !== expected) throw new Error(`unsupported ZIP ${label}: ${actual}`);
}

export function inspectExtensionZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('ZIP is empty or truncated');
  const endOffset = buffer.length - 22;
  requireHeaderField(buffer.readUInt32LE(endOffset), ZIP_END_HEADER, 'end signature');
  requireHeaderField(buffer.readUInt16LE(endOffset + 4), 0, 'disk number');
  requireHeaderField(buffer.readUInt16LE(endOffset + 6), 0, 'central-directory disk');
  requireHeaderField(buffer.readUInt16LE(endOffset + 20), 0, 'comment length');
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  requireHeaderField(diskEntries, totalEntries, 'split entry count');
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) throw new Error('ZIP central-directory bounds mismatch');

  const result = [];
  const names = new Set();
  let cursor = centralOffset;
  let expectedLocalOffset = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    checkedSlice(buffer, cursor, 46, 'central header');
    requireHeaderField(buffer.readUInt32LE(cursor), ZIP_CENTRAL_HEADER, 'central signature');
    requireHeaderField(buffer.readUInt16LE(cursor + 8), ZIP_UTF8_FLAG, 'flags');
    requireHeaderField(buffer.readUInt16LE(cursor + 10), ZIP_STORED, 'compression method');
    requireHeaderField(buffer.readUInt16LE(cursor + 12), ZIP_DOS_TIME, 'modification time');
    requireHeaderField(buffer.readUInt16LE(cursor + 14), ZIP_DOS_DATE, 'modification date');
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    requireHeaderField(compressedSize, size, 'stored size');
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    requireHeaderField(extraLength, 0, 'central extra length');
    requireHeaderField(commentLength, 0, 'entry comment length');
    requireHeaderField(buffer.readUInt16LE(cursor + 34), 0, 'entry disk');
    const localOffset = buffer.readUInt32LE(cursor + 42);
    requireHeaderField(localOffset, expectedLocalOffset, 'local entry order');
    const name = checkedSlice(buffer, cursor + 46, nameLength, 'central name').toString('utf8');
    assertArchiveName(name);
    if (names.has(name)) throw new Error(`duplicate ZIP path: ${name}`);
    names.add(name);
    cursor += 46 + nameLength;

    checkedSlice(buffer, localOffset, 30, 'local header');
    requireHeaderField(buffer.readUInt32LE(localOffset), ZIP_LOCAL_HEADER, 'local signature');
    requireHeaderField(buffer.readUInt16LE(localOffset + 6), ZIP_UTF8_FLAG, 'local flags');
    requireHeaderField(buffer.readUInt16LE(localOffset + 8), ZIP_STORED, 'local compression method');
    requireHeaderField(buffer.readUInt16LE(localOffset + 10), ZIP_DOS_TIME, 'local modification time');
    requireHeaderField(buffer.readUInt16LE(localOffset + 12), ZIP_DOS_DATE, 'local modification date');
    requireHeaderField(buffer.readUInt32LE(localOffset + 14), crc, 'local CRC');
    requireHeaderField(buffer.readUInt32LE(localOffset + 18), size, 'local compressed size');
    requireHeaderField(buffer.readUInt32LE(localOffset + 22), size, 'local size');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    requireHeaderField(localNameLength, nameLength, 'local name length');
    requireHeaderField(localExtraLength, 0, 'local extra length');
    const localName = checkedSlice(buffer, localOffset + 30, localNameLength, 'local name').toString('utf8');
    requireHeaderField(localName, name, 'local name');
    const dataOffset = localOffset + 30 + localNameLength;
    const data = checkedSlice(buffer, dataOffset, size, `${name} data`);
    requireHeaderField(crc32(data), crc, `${name} CRC`);
    expectedLocalOffset = dataOffset + size;
    result.push({ name, data, crc, dataOffset });
  }
  requireHeaderField(cursor, centralOffset + centralSize, 'central-directory size');
  requireHeaderField(expectedLocalOffset, centralOffset, 'local-directory size');
  return result;
}

export async function buildExtensionZip(repoRoot = DEFAULT_ROOT) {
  return createExtensionZip(await collectExtensionEntries(repoRoot));
}

export async function defaultArchivePath(repoRoot = DEFAULT_ROOT) {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
  if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version || '')) {
    throw new Error(`invalid Chrome extension version: ${JSON.stringify(manifest.version)}`);
  }
  return path.join(repoRoot, `smesh-ai-chrome-v${manifest.version}.zip`);
}

export async function writeExtensionArchive(outputPath, repoRoot = DEFAULT_ROOT) {
  const zip = await buildExtensionZip(repoRoot);
  inspectExtensionZip(zip);
  const absoluteOutput = path.resolve(outputPath || await defaultArchivePath(repoRoot));
  if (path.extname(absoluteOutput).toLowerCase() !== '.zip') {
    throw new Error(`extension archive output must end in .zip: ${absoluteOutput}`);
  }
  for (const protectedPath of ['manifest.json', 'src', 'assets']) {
    const absoluteProtected = path.join(repoRoot, protectedPath);
    const relative = path.relative(absoluteProtected, absoluteOutput);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error(`refusing to overwrite extension source with an archive: ${absoluteOutput}`);
    }
  }
  const temporary = `${absoluteOutput}.tmp-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o644);
  try {
    await handle.writeFile(zip);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, absoluteOutput);
  return {
    outputPath: absoluteOutput,
    bytes: zip.length,
    entries: inspectExtensionZip(zip).length,
    sha256: createHash('sha256').update(zip).digest('hex'),
  };
}

export async function verifyExtensionArchive(archivePath, repoRoot = DEFAULT_ROOT) {
  const absoluteArchive = path.resolve(archivePath || await defaultArchivePath(repoRoot));
  const [actual, expected] = await Promise.all([
    readFile(absoluteArchive),
    buildExtensionZip(repoRoot),
  ]);
  const entries = inspectExtensionZip(actual);
  if (!actual.equals(expected)) {
    throw new Error(
      `extension archive is stale or non-reproducible: ${absoluteArchive}\n` +
      'Run npm run package:extension and verify the regenerated file.'
    );
  }
  return {
    archivePath: absoluteArchive,
    bytes: actual.length,
    entries: entries.length,
    sha256: createHash('sha256').update(actual).digest('hex'),
  };
}

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {crc32} from 'node:zlib';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_FONT_BYTES = 1024 * 1024;
const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
const FFPROBE_TIMEOUT_MS = 20_000;
const FFMPEG_DECODE_TIMEOUT_MS = 60_000;

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function throwValidationErrors(label, errors) {
  if (errors.length > 0) {
    throw new Error(`${label}:\n- ${errors.join('\n- ')}`);
  }
}

function assertPinnedSha256(buffer, expected) {
  if (!/^[a-f0-9]{64}$/.test(String(expected || ''))) {
    throw new Error('manifest SHA-256 is missing or invalid');
  }
  const actual = createHash('sha256').update(buffer).digest('hex');
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch; expected ${expected}, found ${actual}`);
  }
  return actual;
}

export function assertSafeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (value.includes('\0') || value.includes('\\') || value.includes('?') || value.includes('#')) {
    throw new Error(`${label} contains a forbidden path character`);
  }
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    throw new Error(`${label} must be a normalized relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
}

function resolveContained(root, relativePath, label) {
  assertSafeRelativePath(relativePath, label);
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, ...relativePath.split('/'));
  const relative = path.relative(absoluteRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside its asset root`);
  }
  return absolute;
}

async function readBoundedRegularFile(filePath, maximumBytes) {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('file is missing');
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('path is not a regular file');
    if (metadata.size <= 0) throw new Error('file is empty');
    if (metadata.size > maximumBytes) {
      throw new Error(`file is too large (${metadata.size} bytes; maximum ${maximumBytes})`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function inspectPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error('not a PNG file');
  }

  let offset = 8;
  let chunkIndex = 0;
  let dimensions = null;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawEnd = false;

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error('truncated PNG chunk header');
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd > Number.MAX_SAFE_INTEGER || chunkEnd > buffer.length) {
      throw new Error('truncated PNG chunk data');
    }

    const type = buffer.toString('ascii', typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('PNG has an invalid chunk type');
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = crc32(buffer.subarray(typeStart, dataEnd)) >>> 0;
    if (actualCrc !== expectedCrc) throw new Error(`PNG ${type} chunk has an invalid CRC`);

    if (chunkIndex === 0 && type !== 'IHDR') throw new Error('PNG IHDR is not the first chunk');
    if (type === 'IHDR') {
      if (dimensions || length !== 13) throw new Error('PNG has an invalid IHDR chunk');
      const width = buffer.readUInt32BE(dataStart);
      const height = buffer.readUInt32BE(dataStart + 4);
      const bitDepth = buffer[dataStart + 8];
      const colorType = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filter = buffer[dataStart + 11];
      const interlace = buffer[dataStart + 12];
      const allowedDepths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!positiveInteger(width) || !positiveInteger(height)) {
        throw new Error('PNG dimensions must be positive');
      }
      if (!allowedDepths[colorType]?.includes(bitDepth) ||
          compression !== 0 || filter !== 0 || ![0, 1].includes(interlace)) {
        throw new Error('PNG has an unsupported IHDR format');
      }
      dimensions = {width, height};
    } else if (type === 'PLTE') {
      if (sawImageData || length === 0 || length % 3 !== 0 || length > 768) {
        throw new Error('PNG has an invalid PLTE chunk');
      }
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (!dimensions || imageDataEnded || length === 0) {
        throw new Error('PNG has an invalid IDAT sequence');
      }
      sawImageData = true;
    } else if (type === 'IEND') {
      if (!sawImageData || length !== 0) throw new Error('PNG has an invalid IEND chunk');
      sawEnd = true;
      if (chunkEnd !== buffer.length) throw new Error('PNG has trailing bytes after IEND');
    } else {
      if (sawImageData) imageDataEnded = true;
      if (type[0] === type[0].toUpperCase()) {
        throw new Error(`PNG contains unsupported critical chunk ${type}`);
      }
    }

    offset = chunkEnd;
    chunkIndex += 1;
    if (sawEnd) break;
  }

  if (!dimensions || !sawImageData || !sawEnd) {
    throw new Error('PNG is missing required chunks');
  }

  // Indexed-color PNGs require a palette. The other supported color types do not.
  const colorType = buffer[8 + 8 + 9];
  if (colorType === 3 && !sawPalette) throw new Error('indexed PNG is missing its palette');
  return dimensions;
}

export function inspectWoff2(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 48 ||
      buffer.toString('ascii', 0, 4) !== 'wOF2') {
    throw new Error('not a WOFF2 file');
  }
  const declaredLength = buffer.readUInt32BE(8);
  const tableCount = buffer.readUInt16BE(12);
  const reserved = buffer.readUInt16BE(14);
  const uncompressedSize = buffer.readUInt32BE(16);
  const compressedSize = buffer.readUInt32BE(20);
  if (declaredLength !== buffer.length) throw new Error('WOFF2 declared length is invalid');
  if (tableCount < 1 || tableCount > 4096 || reserved !== 0) {
    throw new Error('WOFF2 table header is invalid');
  }
  if (uncompressedSize < 12 || compressedSize < 1 || compressedSize > buffer.length - 48) {
    throw new Error('WOFF2 size fields are invalid');
  }
  return {tableCount, uncompressedSize, compressedSize};
}

export function inspectWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 ||
      buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  if (buffer.readUInt32LE(4) !== buffer.length - 8) {
    throw new Error('WAV RIFF size does not match the file');
  }

  let format = null;
  let dataBytes = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > Number.MAX_SAFE_INTEGER || end > buffer.length) {
      throw new Error(`truncated WAV ${id} chunk`);
    }
    if (id === 'fmt ') {
      if (format || length < 16) throw new Error('WAV has an invalid fmt chunk');
      format = {
        codec: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      if (dataBytes != null) throw new Error('WAV has multiple data chunks');
      dataBytes = length;
    }
    const next = end + (length % 2);
    if (next > buffer.length) throw new Error(`truncated WAV ${id} padding`);
    offset = next;
  }
  if (!format || dataBytes == null) throw new Error('WAV is missing fmt or data');
  if (format.blockAlign === 0 || format.byteRate === 0 || dataBytes % format.blockAlign !== 0) {
    throw new Error('WAV alignment fields are invalid');
  }
  return {
    ...format,
    dataBytes,
    durationSeconds: dataBytes / format.byteRate,
  };
}

function parseFrameRate(value) {
  const match = String(value).match(/^(\d+)\/(\d+)$/);
  if (!match) return Number.NaN;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  return denominator > 0 ? numerator / denominator : Number.NaN;
}

function commandFailure(result) {
  const detail = String(result.error?.message || result.stderr || `exit ${result.status}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
  return detail || 'unknown command failure';
}

function inspectMp4(filePath, asset, fps, ffprobeCommand, ffmpegCommand) {
  const probe = spawnSync(ffprobeCommand, [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries',
    'stream=codec_name,codec_type,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames,duration:format=duration',
    '-of', 'json',
    filePath,
  ], {
    encoding: 'utf8',
    maxBuffer: COMMAND_OUTPUT_LIMIT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: FFPROBE_TIMEOUT_MS,
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(`ffprobe failed: ${commandFailure(probe)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
  const stream = parsed.streams?.[0];
  if (!stream || parsed.streams.length !== 1) throw new Error('MP4 has no primary video stream');
  if (stream.codec_type !== 'video' || stream.codec_name !== 'h264') {
    throw new Error(`MP4 must use H.264; found ${stream.codec_name || 'unknown'}`);
  }
  if (stream.pix_fmt !== 'yuv420p') {
    throw new Error(`MP4 must use yuv420p; found ${stream.pix_fmt || 'unknown'}`);
  }
  if (stream.width < asset.minimumWidth || stream.height < asset.minimumHeight) {
    throw new Error(
      `MP4 is ${stream.width}x${stream.height}; scene requires at least ` +
      `${asset.minimumWidth}x${asset.minimumHeight}`
    );
  }
  if (parseFrameRate(stream.r_frame_rate) !== fps ||
      parseFrameRate(stream.avg_frame_rate) !== fps) {
    throw new Error(
      `MP4 must be constant ${fps} fps; found ` +
      `${stream.r_frame_rate || 'unknown'} / ${stream.avg_frame_rate || 'unknown'}`
    );
  }

  const durationSeconds = Number(stream.duration ?? parsed.format?.duration);
  const requiredSeconds =
    (asset.scene.trimBefore + asset.scene.durationInFrames * asset.scene.playbackRate) / fps;
  if (!finitePositive(durationSeconds) || durationSeconds + 1 / fps < requiredSeconds) {
    throw new Error(
      `MP4 is ${Number.isFinite(durationSeconds) ? durationSeconds.toFixed(3) : 'unknown'}s; ` +
      `scene requires ${requiredSeconds.toFixed(3)}s`
    );
  }
  const requiredFrames = Math.ceil(requiredSeconds * fps - 1e-9);
  const declaredFrames = Number(stream.nb_frames);
  const decodedFrames = Number(stream.nb_read_frames);
  if (!positiveInteger(declaredFrames) || !positiveInteger(decodedFrames) ||
      declaredFrames < requiredFrames || decodedFrames < requiredFrames) {
    throw new Error(
      `MP4 has ${stream.nb_read_frames || 'unknown'} decoded frames and ` +
      `${stream.nb_frames || 'unknown'} declared frames; scene requires ${requiredFrames}`
    );
  }

  const decode = spawnSync(ffmpegCommand, [
    '-nostdin',
    '-v', 'error',
    '-xerror',
    '-i', filePath,
    '-map', '0:v:0',
    '-an',
    '-f', 'null',
    '-',
  ], {
    encoding: 'utf8',
    maxBuffer: COMMAND_OUTPUT_LIMIT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: FFMPEG_DECODE_TIMEOUT_MS,
  });
  if (decode.error || decode.status !== 0) {
    throw new Error(`full MP4 decode failed: ${commandFailure(decode)}`);
  }

  return {
    codec: stream.codec_name,
    pixelFormat: stream.pix_fmt,
    width: stream.width,
    height: stream.height,
    fps,
    durationSeconds,
    frames: decodedFrames,
  };
}

export function validateReleaseManifest({
  releaseAssets,
  fontAssets,
  sceneProbes,
  composition,
}) {
  const errors = [];
  const paths = new Set();
  const assetEntries = Object.entries(releaseAssets || {});
  if (assetEntries.length === 0) errors.push('release asset manifest is empty');

  for (const [key, asset] of assetEntries) {
    try {
      assertSafeRelativePath(asset?.path, `RELEASE_ASSETS.${key}.path`);
      if (!/^[a-f0-9]{64}$/.test(String(asset?.sha256 || ''))) {
        throw new Error('SHA-256 identity must be 64 lowercase hex characters');
      }
      if (paths.has(asset.path)) throw new Error(`duplicates path ${asset.path}`);
      paths.add(asset.path);
      if (asset.type === 'image') {
        if (!positiveInteger(asset.width) || !positiveInteger(asset.height)) {
          throw new Error('image dimensions must be positive integers');
        }
      } else if (asset.type === 'video') {
        if (!positiveInteger(asset.minimumWidth) || !positiveInteger(asset.minimumHeight)) {
          throw new Error('video minimum dimensions must be positive integers');
        }
        const scene = asset.scene;
        if (!Number.isInteger(scene?.startFrame) || !Number.isInteger(scene?.endFrame) ||
            scene.startFrame < 0 || scene.endFrame <= scene.startFrame ||
            scene.durationInFrames !== scene.endFrame - scene.startFrame ||
            !Number.isInteger(scene.trimBefore) || scene.trimBefore < 0 ||
            !finitePositive(scene.playbackRate)) {
          throw new Error('video scene timing is invalid');
        }
      } else if (asset.type === 'audio') {
        if (asset.codec !== 'pcm_s16le' || !positiveInteger(asset.channels) ||
            !positiveInteger(asset.sampleRate) || !positiveInteger(asset.bitsPerSample) ||
            !finitePositive(asset.durationSeconds)) {
          throw new Error('audio expectations are invalid');
        }
      } else {
        throw new Error(`unsupported asset type ${asset.type || 'missing'}`);
      }
    } catch (error) {
      errors.push(`${key}: ${error.message}`);
    }
  }

  for (const [key, font] of Object.entries(fontAssets || {})) {
    try {
      assertSafeRelativePath(font?.path, `RELEASE_FONT_ASSETS.${key}.path`);
      if (!/^[a-f0-9]{64}$/.test(String(font?.sha256 || ''))) {
        throw new Error('SHA-256 identity must be 64 lowercase hex characters');
      }
      if (paths.has(font.path)) throw new Error(`duplicates path ${font.path}`);
      paths.add(font.path);
      if (typeof font.cssUrl !== 'string' || !font.cssUrl.startsWith('./assets/') ||
          font.cssUrl.includes('\\') || font.cssUrl.includes('..')) {
        throw new Error('font CSS URL is invalid');
      }
    } catch (error) {
      errors.push(`${key}: ${error.message}`);
    }
  }

  const coveredAssets = new Set();
  const probeIds = new Set();
  const probeFrames = new Set();
  for (const probe of sceneProbes || []) {
    if (typeof probe?.id !== 'string' || !probe.id || probeIds.has(probe.id)) {
      errors.push(`scene probe has an invalid or duplicate id ${probe?.id || 'missing'}`);
      continue;
    }
    probeIds.add(probe.id);
    if (!Number.isInteger(probe.frame) || probe.frame < 0 ||
        probe.frame >= composition.durationInFrames || probeFrames.has(probe.frame)) {
      errors.push(`${probe.id}: scene probe frame ${probe.frame} is invalid or duplicate`);
    }
    probeFrames.add(probe.frame);
    if (!Array.isArray(probe.assetKeys) || probe.assetKeys.length === 0) {
      errors.push(`${probe.id}: scene probe covers no release assets`);
      continue;
    }
    for (const assetKey of probe.assetKeys) {
      const asset = releaseAssets[assetKey];
      if (!asset || !['image', 'video'].includes(asset.type)) {
        errors.push(`${probe.id}: unknown visual asset ${assetKey}`);
        continue;
      }
      coveredAssets.add(assetKey);
      if (asset.type === 'video' &&
          (probe.frame < asset.scene.startFrame || probe.frame >= asset.scene.endFrame)) {
        errors.push(`${probe.id}: frame ${probe.frame} is outside ${assetKey}'s active scene`);
      }
    }
  }

  for (const [key, asset] of assetEntries) {
    if (['image', 'video'].includes(asset.type) && !coveredAssets.has(key)) {
      errors.push(`${key}: visual asset is not covered by a scene probe`);
    }
    if (asset.type === 'video' && asset.scene.endFrame > composition.durationInFrames) {
      errors.push(`${key}: video scene extends beyond the composition`);
    }
  }
  const soundtrack = releaseAssets.soundtrack;
  const compositionSeconds = composition.durationInFrames / composition.fps;
  if (!soundtrack || Math.abs(soundtrack.durationSeconds - compositionSeconds) > 1e-9) {
    errors.push('soundtrack duration does not match the composition');
  }

  throwValidationErrors('Release asset manifest is invalid', errors);
}

export function validateSourceAssetCoverage({
  javascriptSources,
  stylesheetSource,
  releaseAssets,
  fontAssets,
}) {
  const errors = [];
  const combinedJavaScript = Object.entries(javascriptSources)
    .filter(([name]) => !name.endsWith('/release-assets.mjs'))
    .map(([, source]) => source)
    .join('\n');

  const literalAssetPaths = [
    ...combinedJavaScript.matchAll(/(['"`])(?:\.\/)?assets\/[^'"`\s)]+/g),
  ].map((match) => match[0]);
  if (literalAssetPaths.length > 0) {
    errors.push(
      `asset paths outside release-assets.mjs are forbidden: ${literalAssetPaths.join(', ')}`
    );
  }

  for (const key of Object.keys(releaseAssets)) {
    const pattern = new RegExp(`\\bRELEASE_ASSETS\\.${key}\\b`);
    if (!pattern.test(combinedJavaScript)) {
      errors.push(`${key}: manifest entry is not referenced by the composition source`);
    }
  }

  for (const match of combinedJavaScript.matchAll(/\bstaticFile\s*\(\s*([^)]*?)\s*\)/gs)) {
    const argument = match[1].trim();
    if (argument === 'asset.path' || argument === 'SMESH_AD_SOUNDTRACK') continue;
    const assetReference = argument.match(/^RELEASE_ASSETS\.([A-Za-z][A-Za-z0-9]*)\.path$/);
    if (!assetReference || !releaseAssets[assetReference[1]]) {
      errors.push(`staticFile() has a non-manifest argument: ${argument || 'empty'}`);
    }
  }

  const timedVideoUseCounts = new Map();
  const smeshSource = javascriptSources['src/SmeshAd.jsx'] || '';
  for (const match of smeshSource.matchAll(/<TimedVideo\b([\s\S]*?)\/>/g)) {
    const source = match[1].match(
      /\basset=\{RELEASE_ASSETS\.([A-Za-z][A-Za-z0-9]*)\}/
    );
    const key = source?.[1];
    if (!key || releaseAssets[key]?.type !== 'video') {
      errors.push('TimedVideo must use a video path from RELEASE_ASSETS');
      continue;
    }
    timedVideoUseCounts.set(key, (timedVideoUseCounts.get(key) || 0) + 1);
  }
  for (const [key, asset] of Object.entries(releaseAssets)) {
    if (asset.type === 'video' && timedVideoUseCounts.get(key) !== 1) {
      errors.push(`${key}: expected exactly one TimedVideo use`);
    }
  }

  const cssUrls = [
    ...stylesheetSource.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g),
  ].map((match) => match[2]);
  const expectedCssUrls = new Set(Object.values(fontAssets).map((font) => font.cssUrl));
  for (const expected of expectedCssUrls) {
    if (cssUrls.filter((value) => value === expected).length !== 1) {
      errors.push(`${expected}: expected exactly one stylesheet font reference`);
    }
  }
  for (const cssUrl of cssUrls) {
    if (!expectedCssUrls.has(cssUrl)) {
      errors.push(`stylesheet has an unmanifested local URL: ${cssUrl}`);
    }
  }

  throwValidationErrors('Release asset source coverage failed', errors);
}

export async function validateReleaseAssetFiles({
  motionRoot,
  releaseAssets,
  fontAssets = {},
  fps,
  ffprobeCommand = 'ffprobe',
  ffmpegCommand = 'ffmpeg',
}) {
  const publicRoot = path.join(motionRoot, 'public');
  const errors = [];
  const summaries = {};

  for (const [key, asset] of Object.entries(releaseAssets)) {
    try {
      const filePath = resolveContained(publicRoot, asset.path, `${key}.path`);
      if (asset.type === 'image') {
        const bytes = await readBoundedRegularFile(filePath, MAX_IMAGE_BYTES);
        assertPinnedSha256(bytes, asset.sha256);
        const image = inspectPng(bytes);
        if (image.width !== asset.width || image.height !== asset.height) {
          throw new Error(
            `PNG is ${image.width}x${image.height}; expected ${asset.width}x${asset.height}`
          );
        }
        summaries[key] = image;
      } else if (asset.type === 'audio') {
        const bytes = await readBoundedRegularFile(filePath, MAX_AUDIO_BYTES);
        assertPinnedSha256(bytes, asset.sha256);
        const audio = inspectWav(bytes);
        const expectedByteRate =
          asset.sampleRate * asset.channels * asset.bitsPerSample / 8;
        if (audio.codec !== 1 || audio.channels !== asset.channels ||
            audio.sampleRate !== asset.sampleRate ||
            audio.bitsPerSample !== asset.bitsPerSample ||
            audio.blockAlign !== asset.channels * asset.bitsPerSample / 8 ||
            audio.byteRate !== expectedByteRate ||
            Math.abs(audio.durationSeconds - asset.durationSeconds) > 1 / asset.sampleRate) {
          throw new Error(
            `WAV format is ${audio.channels}ch/${audio.sampleRate}Hz/` +
            `${audio.bitsPerSample}bit/${audio.durationSeconds.toFixed(6)}s`
          );
        }
        summaries[key] = audio;
      } else if (asset.type === 'video') {
        const bytes = await readBoundedRegularFile(filePath, MAX_VIDEO_BYTES);
        assertPinnedSha256(bytes, asset.sha256);
        summaries[key] = inspectMp4(
          filePath,
          asset,
          fps,
          ffprobeCommand,
          ffmpegCommand
        );
      }
    } catch (error) {
      errors.push(`${key} (${asset.path}): ${error.message}`);
    }
  }

  for (const [key, font] of Object.entries(fontAssets)) {
    try {
      const filePath = resolveContained(motionRoot, font.path, `${key}.path`);
      const bytes = await readBoundedRegularFile(filePath, MAX_FONT_BYTES);
      assertPinnedSha256(bytes, font.sha256);
      summaries[key] = inspectWoff2(bytes);
    } catch (error) {
      errors.push(`${key} (${font.path}): ${error.message}`);
    }
  }

  throwValidationErrors('Release asset file validation failed', errors);
  return summaries;
}

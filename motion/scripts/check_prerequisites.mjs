#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SMESH_AD_DURATION_SECONDS,
  SMESH_AD_SOUNDTRACK,
} from '../src/composition.mjs';

const motionRoot = fileURLToPath(new URL('..', import.meta.url));
const errors = [];

function parseVersion(value) {
  const match = String(value).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match.slice(1, 4).map((part) => Number(part || 0)) : null;
}

function atLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if ((actual[index] || 0) > minimum[index]) return true;
    if ((actual[index] || 0) < minimum[index]) return false;
  }
  return true;
}

function command(commandName, args) {
  const result = spawnSync(commandName, args, {
    cwd: motionRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    errors.push(
      `${commandName} ${args.join(' ')} failed: ` +
      String(result.error?.message || result.stderr || `exit ${result.status}`).trim()
    );
    return '';
  }
  return String(result.stdout || result.stderr).trim();
}

const nodeVersion = parseVersion(process.versions.node);
if (!nodeVersion || !atLeast(nodeVersion, [24, 0, 0])) {
  errors.push(`Node.js 24+ is required; found ${process.versions.node}`);
}

const python = process.env.PYTHON || 'python3';
const pythonText = command(python, ['--version']);
const pythonVersion = parseVersion(pythonText);
if (!pythonVersion || pythonVersion[0] !== 3 || pythonVersion[1] !== 13) {
  errors.push(`Python 3.13 is required; found ${pythonText || 'unknown'}`);
}

const requirements = await readFile(path.join(motionRoot, 'requirements.txt'), 'utf8');
const numpyRequirement = requirements.match(/^\s*numpy==([^\s\\#]+)(?:\s*\\)?\s*$/m)?.[1];
if (!numpyRequirement) {
  errors.push('requirements.txt must pin NumPy with numpy==<version>');
}
const numpyVersion = command(python, ['-c', 'import numpy; print(numpy.__version__)']);
if (numpyRequirement && numpyVersion !== numpyRequirement) {
  errors.push(`NumPy ${numpyRequirement} is required; found ${numpyVersion || 'not installed'}`);
}

const ffmpegText = command('ffmpeg', ['-version']);
const ffmpegVersion = parseVersion(ffmpegText.split('\n')[0]);
if (!ffmpegVersion || !atLeast(ffmpegVersion, [6, 1, 0])) {
  errors.push(`FFmpeg 6.1+ is required; found ${ffmpegText.split('\n')[0] || 'unknown'}`);
}
command('ffprobe', ['-version']);

function uint16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function uint32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function inspectWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let format = null;
  let dataBytes = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const length = uint32(buffer, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) throw new Error(`truncated ${id} chunk`);
    if (id === 'fmt ') {
      if (length < 16) throw new Error('short fmt chunk');
      format = {
        codec: uint16(buffer, start),
        channels: uint16(buffer, start + 2),
        sampleRate: uint32(buffer, start + 4),
        byteRate: uint32(buffer, start + 8),
        blockAlign: uint16(buffer, start + 12),
        bitsPerSample: uint16(buffer, start + 14),
      };
    } else if (id === 'data') {
      dataBytes = length;
    }
    offset = end + (length % 2);
  }
  if (!format || dataBytes == null) throw new Error('missing fmt or data chunk');
  const seconds = dataBytes / format.byteRate;
  return { ...format, dataBytes, seconds };
}

let wav = null;
try {
  const soundtrackPath = path.join(motionRoot, 'public', SMESH_AD_SOUNDTRACK);
  wav = inspectWav(await readFile(soundtrackPath));
  if (wav.codec !== 1 || wav.channels !== 2 || wav.sampleRate !== 48_000 ||
      wav.bitsPerSample !== 16 || wav.blockAlign !== 4 || wav.byteRate !== 192_000) {
    errors.push(
      `soundtrack must be stereo 48 kHz 16-bit PCM; found ` +
      `${wav.channels}ch/${wav.sampleRate}Hz/${wav.bitsPerSample}bit codec ${wav.codec}`
    );
  }
  if (Math.abs(wav.seconds - SMESH_AD_DURATION_SECONDS) > 1 / 48_000) {
    errors.push(
      `soundtrack is ${wav.seconds.toFixed(6)}s but the composition is ` +
      `${SMESH_AD_DURATION_SECONDS.toFixed(6)}s`
    );
  }
} catch (error) {
  errors.push(`soundtrack validation failed: ${error.message}`);
}

if (errors.length) {
  throw new Error(`Motion prerequisites failed:\n- ${errors.join('\n- ')}`);
}

console.log(
  `motion prerequisites passed (Node ${process.versions.node}, ${pythonText}, ` +
  `NumPy ${numpyVersion}, FFmpeg ${ffmpegVersion.join('.')}, soundtrack ${wav.seconds.toFixed(1)}s)`
);

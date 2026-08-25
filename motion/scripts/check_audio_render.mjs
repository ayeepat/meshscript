#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcodeRelease } from './transcode_release.mjs';
import { createTempWorkspace } from './temp_workspace.mjs';

const motionRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(motionRoot, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
const outputDirectory = createTempWorkspace('smesh-motion-audio-');
const remotionOutput = path.join(outputDirectory, 'audio-probe-source.mp4');
const output = path.join(outputDirectory, 'audio-probe-release.mp4');

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    cli,
    'render',
    'src/index.jsx',
    'SmeshAd',
    remotionOutput,
    '--frames=0-29',
    '--scale=0.1',
    '--codec=h264',
    '--audio-codec=aac',
    '--audio-bitrate=192K',
    '--enforce-audio-track',
    '--concurrency=1',
  ], {
    cwd: motionRoot,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) return resolve();
    reject(new Error(`audio render probe failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
  });
});

await transcodeRelease(remotionOutput, output);

const probe = spawnSync('ffprobe', [
  '-v', 'error',
  '-select_streams', 'a:0',
  '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels',
  '-of', 'json',
  output,
], {
  cwd: motionRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (probe.error || probe.status !== 0) {
  throw new Error(
    `ffprobe failed for rendered audio: ` +
    String(probe.error?.message || probe.stderr || `exit ${probe.status}`).trim()
  );
}
const stream = JSON.parse(probe.stdout).streams?.[0];
if (stream?.codec_type !== 'audio' || stream.codec_name !== 'aac' ||
    stream.sample_rate !== '48000' || stream.channels !== 2) {
  throw new Error(`rendered ad has an invalid audio stream: ${JSON.stringify(stream || null)}`);
}

const videoProbe = spawnSync('ffprobe', [
  '-v', 'error',
  '-select_streams', 'v:0',
  '-show_entries', 'stream=color_range,color_space,color_transfer,color_primaries',
  '-of', 'json',
  output,
], {
  cwd: motionRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (videoProbe.error || videoProbe.status !== 0) {
  throw new Error(
    `ffprobe failed for rendered video: ` +
    String(videoProbe.error?.message || videoProbe.stderr || `exit ${videoProbe.status}`).trim()
  );
}
const video = JSON.parse(videoProbe.stdout).streams?.[0];
if (video?.color_range !== 'tv' || video.color_space !== 'bt709' ||
    video.color_transfer !== 'bt709' || video.color_primaries !== 'bt709') {
  throw new Error(`rendered ad has invalid color metadata: ${JSON.stringify(video || null)}`);
}

const decoded = spawnSync('ffmpeg', [
  '-v', 'error',
  '-i', output,
  '-map', '0:a:0',
  '-f', 's16le',
  '-acodec', 'pcm_s16le',
  '-',
], {
  cwd: motionRoot,
  encoding: null,
  maxBuffer: 2 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (decoded.error || decoded.status !== 0) {
  throw new Error(
    `failed to decode rendered audio: ` +
    String(decoded.error?.message || decoded.stderr || `exit ${decoded.status}`).trim()
  );
}
let peak = 0;
for (let offset = 0; offset + 1 < decoded.stdout.length; offset += 2) {
  peak = Math.max(peak, Math.abs(decoded.stdout.readInt16LE(offset)));
}
if (peak < 32) throw new Error(`rendered audio is silent (PCM peak ${peak})`);

console.log(
  `motion audio render passed (${stream.codec_name}, ${stream.sample_rate} Hz, ` +
  `${stream.channels} channels, PCM peak ${peak}, ${output})`
);

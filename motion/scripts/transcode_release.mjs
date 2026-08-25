#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const motionRoot = fileURLToPath(new URL('..', import.meta.url));

export async function transcodeRelease(inputPath, outputPath) {
  if (!inputPath || !outputPath) {
    throw new Error('Usage: node scripts/transcode_release.mjs INPUT.mp4 OUTPUT.mp4');
  }
  const input = path.resolve(motionRoot, inputPath);
  const output = path.resolve(motionRoot, outputPath);
  if (input === output) throw new Error('release transcode input and output must differ');

  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y',
      '-i', input,
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-vf',
      'scale=in_range=pc:out_range=tv:in_color_matrix=bt470bg:out_color_matrix=bt709,' +
        'format=yuv420p,' +
        'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '16',
      '-profile:v', 'high',
      '-level:v', '4.2',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-shortest',
      '-movflags', '+faststart',
      '-map_metadata', '-1',
      '-map_chapters', '-1',
      '-color_range', 'tv',
      '-colorspace', 'bt709',
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      output,
    ], {
      cwd: motionRoot,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`release transcode failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
  return output;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await transcodeRelease(process.argv[2], process.argv[3]);
}

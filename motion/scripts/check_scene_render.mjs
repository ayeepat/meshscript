#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  SMESH_AD_COMPOSITION,
  SMESH_AD_COMPOSITION_ID,
} from '../src/composition.mjs';
import {RELEASE_SCENE_PROBES} from '../src/release-assets.mjs';
import {validateRenderedSceneFrames} from './scene_render_validation.mjs';
import {createTempWorkspace} from './temp_workspace.mjs';

const motionRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(
  motionRoot,
  'node_modules',
  '@remotion',
  'cli',
  'remotion-cli.js'
);
const outputDirectory = createTempWorkspace('smesh-motion-scenes-');
const scale = 0.1;
const timeoutMs = 10 * 60_000;
const firstFrame = RELEASE_SCENE_PROBES[0]?.frame;
const frameStep = RELEASE_SCENE_PROBES[1]?.frame - firstFrame;
if (!Number.isInteger(firstFrame) || !Number.isInteger(frameStep) || frameStep <= 0 ||
    RELEASE_SCENE_PROBES.some(
      (probe, index) => probe.frame !== firstFrame + index * frameStep
    )) {
  throw new Error(
    'production scene probes must be a non-empty evenly spaced frame sequence'
  );
}

// Render the production composition itself at every declared source frame.
// A wrapper composition can accidentally freeze on one frame while still
// emitting the expected number of files, which would make this gate illusory.
await new Promise((resolve, reject) => {
  let timedOut = false;
  const lastFrame = RELEASE_SCENE_PROBES.at(-1).frame;
  const child = spawn(process.execPath, [
    cli,
    'render',
    'src/index.jsx',
    SMESH_AD_COMPOSITION_ID,
    outputDirectory,
    '--sequence',
    '--image-format=png',
    `--frames=${firstFrame}-${lastFrame}`,
    `--every-nth-frame=${frameStep}`,
    `--scale=${scale}`,
    '--muted',
    '--concurrency=1',
    '--timeout=120000',
    '--overwrite',
  ], {
    cwd: motionRoot,
    shell: false,
    stdio: 'inherit',
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  child.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once('exit', (code, signal) => {
    clearTimeout(timeout);
    if (code === 0) return resolve();
    if (timedOut) {
      return reject(new Error(`scene render timed out after ${timeoutMs}ms`));
    }
    reject(new Error(
      `scene render failed (${signal ? `signal ${signal}` : `exit ${code}`})`
    ));
  });
});

const entries = await readdir(outputDirectory, {withFileTypes: true});
const pngFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
  .map((entry) => entry.name)
  .sort();
const expectedFiles = RELEASE_SCENE_PROBES
  .map((_, index) => `element-${index}.png`);
if (pngFiles.length !== expectedFiles.length ||
    pngFiles.some((filename, index) => filename !== expectedFiles[index])) {
  throw new Error(
    `scene render output set was ${JSON.stringify(pngFiles)}; ` +
    `expected ${JSON.stringify(expectedFiles)}`
  );
}
const renders = await Promise.all(
  expectedFiles.map(async (filename) => ({
    filename,
    buffer: await readFile(path.join(outputDirectory, filename)),
  }))
);

const summaries = validateRenderedSceneFrames({
  renders,
  sceneProbes: RELEASE_SCENE_PROBES,
  expectedWidth: Math.round(SMESH_AD_COMPOSITION.width * scale),
  expectedHeight: Math.round(SMESH_AD_COMPOSITION.height * scale),
});

console.log(
  `motion scene render passed (${summaries.length} distinct production frames, ` +
  `${outputDirectory})\n` +
  summaries
    .map((summary) =>
      `- ${summary.id}@${summary.frame} ${summary.filename} sha256 ${summary.sha256}`
    )
    .join('\n')
);

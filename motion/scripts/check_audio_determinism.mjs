#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMESH_AD_SOUNDTRACK } from '../src/composition.mjs';
import {assertSoundtrackFreshness} from './audio_freshness.mjs';
import { createTempWorkspace } from './temp_workspace.mjs';

const motionRoot = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.PYTHON || 'python3';
const outputDirectory = createTempWorkspace('smesh-soundtrack-');
const outputs = [
  path.join(outputDirectory, 'generation-a.wav'),
  path.join(outputDirectory, 'generation-b.wav'),
];
const timeoutMs = 5 * 60_000;

async function generate(output) {
  await new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn(python, ['scripts/make_audio.py', '--output', output], {
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
        return reject(new Error(
          `soundtrack reproducibility probe timed out after ${timeoutMs}ms`
        ));
      }
      reject(new Error(
        `soundtrack reproducibility probe failed ` +
        `(${signal ? `signal ${signal}` : `exit ${code}`})`
      ));
    });
  });
  return readFile(output);
}

// Keep synthesis sequential: each run holds several 20-second float buffers,
// and parallel generation would double peak memory for no verification gain.
const checkedIn = await readFile(path.join(motionRoot, 'public', SMESH_AD_SOUNDTRACK));
const first = await generate(outputs[0]);
const second = await generate(outputs[1]);
assertSoundtrackFreshness({checkedIn, generations: [first, second]});
const sha256 = createHash('sha256').update(first).digest('hex');
console.log(`motion soundtrack reproducibility passed (sha256 ${sha256})`);

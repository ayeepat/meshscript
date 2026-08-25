#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const motionRoot = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.PYTHON || 'python3';

await new Promise((resolve, reject) => {
  const child = spawn(python, ['scripts/make_audio.py'], {
    cwd: motionRoot,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) return resolve();
    reject(new Error(`soundtrack generation failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
  });
});

#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempWorkspace } from './temp_workspace.mjs';

const motionRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(motionRoot, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
const output = createTempWorkspace('smesh-motion-bundle-');

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    cli,
    'bundle',
    'src/index.jsx',
    `--out-dir=${output}`,
  ], {
    cwd: motionRoot,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) return resolve();
    reject(new Error(`Remotion bundle failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
  });
});

await access(path.join(output, 'index.html'));
console.log(`motion bundle check passed (${output})`);

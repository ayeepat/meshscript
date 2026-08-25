import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const testsDirectory = new URL('./', import.meta.url);
const tests = (await readdir(testsDirectory))
  .filter((name) => name.endsWith('-regression.mjs'))
  .sort();

if (!tests.length) throw new Error('no backend-vps regression tests found');

for (const test of tests) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(test, testsDirectory))], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${test} failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

console.log(`all ${tests.length} backend-vps regression files passed`);

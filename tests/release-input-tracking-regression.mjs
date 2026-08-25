import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], {
  cwd: repoRoot, encoding: 'utf8'
}).split('\0').filter(Boolean));

const excludedDirectories = new Set(['node_modules', 'build', 'output', 'qa_assets']);
async function releaseFiles(relativeDirectory) {
  const files = [];
  async function walk(relative) {
    const entries = await readdir(path.join(repoRoot, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }
  await walk(relativeDirectory);
  return files;
}

const required = new Set([
  'manifest.json', 'package.json', 'package-lock.json',
  '.github/workflows/regressions.yml'
]);
for (const directory of [
  'src', 'backend/src', 'backend/migrations', 'backend/scripts',
  'backend-vps/tests', 'scripts', 'tests', 'motion'
]) {
  for (const file of await releaseFiles(directory)) required.add(file);
}

const missing = [...required].filter((file) => !tracked.has(file)).sort();
assert.deepEqual(missing, [],
  `release inputs must be in the Git index; untracked files disappear from CI/deploy:\n${missing.join('\n')}`);

console.log(`release input tracking regression passed (${required.size} indexed inputs)`);

#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseHtml } from 'parse5';
import { parse as parseCss } from 'postcss';
import { parseDocument } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const ignoredDirectories = new Set([
  '.git',
  '.secrets',
  '.wrangler',
  'node_modules',
]);
const ignoredPrefixes = [
  'motion/build/',
  'motion/output/',
  'motion/qa_assets/',
];
const files = [];

function portable(relative) {
  return relative.split(path.sep).join('/');
}

function isIgnored(relative) {
  const normalized = portable(relative);
  return ignoredPrefixes.some((prefix) => normalized.startsWith(prefix));
}

async function collect(relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`source tree contains an unchecked symbolic link: ${portable(child)}`);
    }
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name) && !isIgnored(`${child}/`)) await collect(child);
    } else if (entry.isFile()) {
      files.push(portable(child));
    }
  }
}

await collect();
files.sort();

const byExtension = (pattern) => files.filter((file) => pattern.test(file));
const scripts = byExtension(/\.(?:cjs|js|mjs)$/);
const jsxFiles = byExtension(/\.jsx$/);
const jsonFiles = byExtension(/\.json$/);
const shellFiles = byExtension(/\.sh$/);
const pythonFiles = byExtension(/\.py$/);
const yamlFiles = byExtension(/\.ya?ml$/);
const tomlFiles = byExtension(/\.toml$/);
const htmlFiles = byExtension(/\.html$/);
const cssFiles = byExtension(/\.css$/);

for (const file of scripts) {
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
}

for (const file of jsonFiles) {
  JSON.parse(await readFile(path.join(root, file), 'utf8'));
}

for (const file of shellFiles) {
  execFileSync('bash', ['-n', path.join(root, file)], { stdio: 'pipe' });
}

const pythonCompile = [
  'import pathlib, sys',
  'filename = sys.argv[1]',
  'source = pathlib.Path(filename).read_text(encoding="utf-8")',
  'compile(source, filename, "exec")',
].join('; ');
for (const file of pythonFiles) {
  execFileSync('python3', ['-c', pythonCompile, path.join(root, file)], { stdio: 'pipe' });
}

for (const file of yamlFiles) {
  const document = parseDocument(await readFile(path.join(root, file), 'utf8'), {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length) {
    throw new Error(`${file}: ${document.errors.map((error) => error.message).join('; ')}`);
  }
}

const tomlCompile = [
  'import pathlib, sys, tomllib',
  'tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))',
].join('; ');
for (const file of tomlFiles) {
  execFileSync('python3', ['-c', tomlCompile, path.join(root, file)], { stdio: 'pipe' });
}

for (const file of htmlFiles) {
  const errors = [];
  parseHtml(await readFile(path.join(root, file), 'utf8'), {
    onParseError(error) { errors.push(error); },
  });
  if (errors.length) {
    throw new Error(`${file}: ${errors.map((error) =>
      `${error.code} at ${error.startLine}:${error.startCol}`).join('; ')}`);
  }
}

for (const file of cssFiles) {
  parseCss(await readFile(path.join(root, file), 'utf8'), {
    from: path.join(root, file),
  });
}

if (!jsxFiles.length) throw new Error('motion JSX sources were not discovered');

console.log(
  `source check passed (${scripts.length} JS, ${jsxFiles.length} JSX, ${pythonFiles.length} Python, ` +
  `${shellFiles.length} shell, ${jsonFiles.length} JSON, ${yamlFiles.length} YAML, ` +
  `${tomlFiles.length} TOML, ${htmlFiles.length} HTML, ${cssFiles.length} CSS; ` +
  'JSX compilation is verified by the motion bundle check)'
);

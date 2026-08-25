#!/usr/bin/env node

import {
  defaultArchivePath,
  verifyExtensionArchive,
  writeExtensionArchive,
} from './extension-package.mjs';

function usage() {
  return 'Usage: node scripts/package-extension.mjs [--output PATH] [--verify [PATH]]';
}

const args = process.argv.slice(2);
let output = null;
let verifyOnly = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--output') {
    if (output != null || !args[index + 1]) throw new Error(usage());
    output = args[index + 1];
    index += 1;
  } else if (arg === '--verify') {
    if (verifyOnly) throw new Error(usage());
    verifyOnly = true;
    if (args[index + 1] && !args[index + 1].startsWith('--')) {
      if (output != null) throw new Error(usage());
      output = args[index + 1];
      index += 1;
    }
  } else {
    throw new Error(usage());
  }
}

if (!output) output = await defaultArchivePath();
const result = verifyOnly
  ? await verifyExtensionArchive(output)
  : await writeExtensionArchive(output);
console.log(
  `${verifyOnly ? 'verified' : 'wrote'} ${verifyOnly ? result.archivePath : result.outputPath} ` +
  `(${result.entries} files, ${result.bytes} bytes, sha256 ${result.sha256})`
);

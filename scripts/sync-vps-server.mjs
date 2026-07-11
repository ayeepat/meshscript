#!/usr/bin/env node
/** Keep setup.sh's deployable server payload byte-identical to server.js. */

import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const serverPath = new URL('../backend-vps/server.js', import.meta.url);
const setupPath = new URL('../backend-vps/setup.sh', import.meta.url);
const startMarker = `sudo tee "$APP_DIR/server.js" >/dev/null <<'SMESH_SERVER_EOF'\n`;
const endMarker = '\nSMESH_SERVER_EOF';

const [server, setup, setupStat] = await Promise.all([
  readFile(serverPath, 'utf8'),
  readFile(setupPath, 'utf8'),
  stat(setupPath)
]);
const start = setup.indexOf(startMarker);
const end = start < 0 ? -1 : setup.indexOf(endMarker, start + startMarker.length);
if (start < 0 || end < 0) throw new Error('setup.sh server heredoc markers not found');

const normalizedServer = server.endsWith('\n') ? server.slice(0, -1) : server;
const next = setup.slice(0, start + startMarker.length) + normalizedServer + setup.slice(end);
if (next === setup) {
  console.log('backend-vps/setup.sh already matches server.js');
  process.exit(0);
}

const temporaryPath = new URL(`../backend-vps/.setup.sh.${randomUUID()}.tmp`, import.meta.url);
try {
  await writeFile(temporaryPath, next, { flag: 'wx', mode: setupStat.mode });
  await chmod(temporaryPath, setupStat.mode);
  await rename(temporaryPath, setupPath);
} catch (error) {
  await rm(temporaryPath, { force: true }).catch(() => {});
  throw error;
}
console.log('synchronized backend-vps/setup.sh with server.js');

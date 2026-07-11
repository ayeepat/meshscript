import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [server, setup] = await Promise.all([
  readFile(new URL('../backend-vps/server.js', import.meta.url), 'utf8'),
  readFile(new URL('../backend-vps/setup.sh', import.meta.url), 'utf8')
]);
const startMarker = `sudo tee "$APP_DIR/server.js" >/dev/null <<'SMESH_SERVER_EOF'\n`;
const endMarker = '\nSMESH_SERVER_EOF';
const start = setup.indexOf(startMarker);
const end = start < 0 ? -1 : setup.indexOf(endMarker, start + startMarker.length);
assert.ok(start >= 0 && end > start, 'setup.sh server heredoc markers must exist');

const embedded = setup.slice(start + startMarker.length, end) + '\n';
assert.equal(embedded, server,
  'setup.sh must deploy the canonical server.js; run node scripts/sync-vps-server.mjs');

console.log('vps setup/server parity regression passed');

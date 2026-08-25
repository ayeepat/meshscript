import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [server, setup] = await Promise.all([
  readFile(new URL('../server.js', import.meta.url), 'utf8'),
  readFile(new URL('../setup.sh', import.meta.url), 'utf8')
]);

const envTemplate = setup.match(/<<'ENV_EOF'\n([\s\S]*?)\nENV_EOF/)?.[1] || '';
const unit = setup.match(/<<'UNIT_EOF'\n([\s\S]*?)\nUNIT_EOF/)?.[1] || '';
const caddy = setup.match(/<<CADDY_EOF\n([\s\S]*?)\nCADDY_EOF/)?.[1] || '';

assert.ok(envTemplate && unit && caddy, 'setup templates must remain statically inspectable');
assert.doesNotMatch(envTemplate, /^PORT=/m,
  'the operator env must not expose a port that can drift from Caddy');
assert.doesNotMatch(envTemplate, /^HOST=/m,
  'the operator env must not override the loopback-only production binding');
const environmentFileIndex = unit.indexOf('EnvironmentFile=/etc/smesh-proxy.env');
const unsetListenerIndex = unit.indexOf('UnsetEnvironment=PORT HOST');
const execIndex = unit.indexOf('ExecStart=/usr/bin/node /opt/smesh-proxy/server.js');
assert.ok(
  environmentFileIndex >= 0 &&
  unsetListenerIndex > environmentFileIndex &&
  execIndex > unsetListenerIndex,
  'systemd must remove legacy listener overrides after loading the operator env file'
);
assert.match(caddy, /^\s*reverse_proxy 127\.0\.0\.1:8080 \{$/m,
  'Caddy and the systemd listener must use the same fixed internal port');
assert.match(server, /const port = Number\(value \|\| 8080\);/,
  'the canonical server default must agree with the production service and Caddy');
assert.match(server, /const host = String\(value \|\| '127\.0\.0\.1'\)/,
  'the canonical server host default must remain loopback-only');

console.log('backend-vps setup listener/Caddy parity regression passed');

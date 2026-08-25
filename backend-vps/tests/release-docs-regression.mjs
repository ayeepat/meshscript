import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const [workflow, rootReadme, vpsReadme, setup] = await Promise.all([
  readFile(new URL('../../.github/workflows/regressions.yml', import.meta.url), 'utf8'),
  readFile(new URL('../../README.md', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
  readFile(new URL('../setup.sh', import.meta.url), 'utf8')
]);

const workflowDocument = parse(workflow);
const testJob = workflowDocument?.jobs?.test;
assert.ok(testJob && testJob.if !== false && String(testJob.if || '').trim() !== 'false',
  'the release-test job must be enabled');
const enabledSteps = (testJob.steps || []).filter((step) =>
  step.if !== false && String(step.if || '').trim() !== 'false'
);
const commandSteps = enabledSteps.map((step) => String(step.run || '').trim());
assert.ok(commandSteps.includes('npm --prefix backend-vps test'),
  'an enabled CI step must execute VPS readiness, quota, and installer regressions');
assert.ok(commandSteps.includes('npm --prefix motion run check'),
  'an enabled CI step must execute the complete Motion release guard');
assert.equal(
  (testJob.steps || []).some((step) =>
    String(step.run || '').includes('npm --prefix backend-vps test') &&
    (step.if === false || String(step.if || '').trim() === 'false')
  ),
  false,
  'a disabled lookalike command must not satisfy the VPS CI gate'
);
assert.doesNotMatch(workflow, /run: npm --prefix motion run audio/,
  'CI must not overwrite the checked-in soundtrack before its freshness check');

// The root README is Russian and ends with this section, so the match must
// also terminate at end-of-file, not only at the next `## ` heading.
const verification = rootReadme.match(/## Разработчикам\n([\s\S]*?)(?=\n## |$)/)?.[1] || '';
for (const requiredCommand of [
  'npm run verify',
  'npm --prefix backend-vps test',
  'npm --prefix motion run check',
  'npm --prefix backend run deploy -- --dry-run',
  'npm run package:extension',
  'npm run verify:package'
]) {
  assert.ok(verification.includes(requiredCommand),
    `root verification docs must include ${requiredCommand}`);
}

assert.match(vpsReadme, /Verify readiness:[\s\S]*\/ready/,
  'deployment instructions must gate on readiness');
assert.match(vpsReadme, /\/health` is intentionally liveness-only/,
  'documentation must distinguish liveness from readiness');
assert.match(vpsReadme, /Do not add `PORT` or `HOST`/,
  'operator documentation must prevent listener/Caddy drift');
assert.match(setup, /curl -fsS https:\/\/\$\{DOMAIN\}\/ready/,
  'installer completion output must direct the operator to readiness');

console.log('release workflow and verification documentation regression passed');

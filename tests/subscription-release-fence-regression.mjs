// Regression: releasing a device from the Telegram bot has to STICK.
//
// Deactivation only marks the activation row inactive, and claimActiveInstallation
// re-activates whichever installation verifies first. The released machine still
// holds the key and re-verifies on its own 24-hour clock, so before the fence a
// remote release was silently undone minutes later — and the buyer's new
// computer kept being told the key was in use on device №1.
//
// The fence names the released DEVICE, not its bearer token, because a client
// that drops the token on a rejected verdict would otherwise become eligible to
// re-claim the seat by doing exactly that.
import assert from 'node:assert/strict';
import {
  createEnv, seedLicense
} from './helpers/subscription-harness.mjs';

const {
  verifyLicense, releaseActivation, RELEASE_FENCE_MS
} = await import('../backend/src/licenses.js');

const KEY = 'SMESH-AAAA-BBBB-CCCC';
const DEVICE_A = 'device-aaaa-1111';
const DEVICE_B = 'device-bbbb-2222';

const env = createEnv();
await seedLicense(env, { key: KEY, telegram_user_id: '777' });

const activationRow = () => env.sqlite.prepare(
  'SELECT status, device_id, activated_at, generation FROM license_activations WHERE license_key = ?'
).get(KEY);
const fenceRow = () => env.sqlite.prepare(
  'SELECT device_id, released_at, released_by FROM license_release_fence WHERE license_key = ?'
).get(KEY) ?? null;

// ---- first activation ----
const first = await verifyLicense(env, KEY, DEVICE_A, '');
assert.equal(first.ok, true, 'the first installation must activate');
const tokenA = first.activation_token;
assert.match(tokenA || '', /^[A-Za-z0-9_-]{43}$/);
const activatedAt = activationRow().activated_at;
const firstExpiry = first.expires_at;
assert.ok(firstExpiry, 'an activation-bound subscription gets its expiry at activation');

// ---- the owner releases it from the bot ----
const released = await releaseActivation(env, KEY, { releasedBy: '777' });
assert.deepEqual(
  { ok: released.ok, released: released.released, device_id: released.device_id },
  { ok: true, released: true, device_id: DEVICE_A }
);
assert.equal(activationRow().status, 'inactive');
assert.deepEqual(
  { device_id: fenceRow().device_id, released_by: fenceRow().released_by },
  { device_id: DEVICE_A, released_by: '777' },
  'the fence records which installation was released, and by whom'
);

// ---- the released device keeps revalidating: it must NOT take the seat back --
const withToken = await verifyLicense(env, KEY, DEVICE_A, tokenA);
assert.deepEqual({ ok: withToken.ok, reason: withToken.reason },
  { ok: false, reason: 'released_remotely' });
assert.equal(activationRow().status, 'inactive',
  'a background revalidation must not re-activate the released installation');

// The client drops its activation token on a rejected verdict. A token-keyed
// fence would have treated the next call as a brand-new installation and handed
// the seat straight back.
const withoutToken = await verifyLicense(env, KEY, DEVICE_A, '');
assert.deepEqual({ ok: withoutToken.ok, reason: withoutToken.reason },
  { ok: false, reason: 'released_remotely' });
assert.equal(activationRow().status, 'inactive');

// ---- the point of the release: another computer can now activate ----
const second = await verifyLicense(env, KEY, DEVICE_B, '');
assert.equal(second.ok, true, 'the new installation must be able to claim the seat');
assert.equal(activationRow().device_id, DEVICE_B);
assert.equal(fenceRow(), null, 'a completed transfer clears the fence');
assert.equal(activationRow().activated_at, activatedAt,
  'transferring a device must not restart the paid period');
assert.equal(second.expires_at, firstExpiry,
  'the subscription keeps the expiry it had before the transfer');

// ---- a deliberate re-activation on the released device is allowed ----
await releaseActivation(env, KEY, { releasedBy: '777' });
assert.equal(fenceRow().device_id, DEVICE_B);
const background = await verifyLicense(env, KEY, DEVICE_B, '');
assert.equal(background.reason, 'released_remotely');
const deliberate = await verifyLicense(env, KEY, DEVICE_B, '', { intent: true });
assert.equal(deliberate.ok, true,
  'the user re-entering the key on that computer is exactly the case the fence must allow');
assert.equal(fenceRow(), null);

// ---- an un-updated client that never sends intent heals when the fence lapses --
await releaseActivation(env, KEY, { releasedBy: '777' });
env.sqlite.prepare(
  'UPDATE license_release_fence SET released_at = ? WHERE license_key = ?'
).run(Date.now() - RELEASE_FENCE_MS - 1, KEY);
const afterWindow = await verifyLicense(env, KEY, DEVICE_B, '');
assert.equal(afterWindow.ok, true,
  'the fence is bounded: an installation that never learns to send intent is not bricked');

// ---- releasing an already-inactive license is a no-op, not an error ----
await releaseActivation(env, KEY, { releasedBy: '777' });
const again = await releaseActivation(env, KEY, { releasedBy: '777' });
assert.deepEqual({ ok: again.ok, released: again.released },
  { ok: true, released: false }, 'a repeated release must not bump the generation again');

// ---- a release must never fence out a device that legitimately holds the seat --
const holder = await verifyLicense(env, KEY, DEVICE_A, '', { intent: true });
assert.equal(holder.ok, true);
env.sqlite.prepare('DELETE FROM license_release_fence WHERE license_key = ?').run(KEY);
env.sqlite.prepare(
  `INSERT INTO license_release_fence (license_key, device_id, released_at, released_by)
   VALUES (?, ?, ?, ?)`
).run(KEY, DEVICE_A, Date.now(), '777');
const stillActive = await verifyLicense(env, KEY, DEVICE_A, holder.activation_token);
assert.equal(stillActive.ok, true,
  'a stale fence must not block the installation that currently owns the activation');

console.log('subscription release fence regression passed');

import assert from 'node:assert/strict';
import { statsUserDetail, statsUsers } from '../backend/src/analytics.js';

const rawKey = 'SMESH-LEGACY-BEARER-1234';
const deviceId = '123e4567-e89b-42d3-a456-426614174000';
const row = {
  device_id: deviceId,
  first_seen: 1,
  last_seen: 2,
  browser: 'chrome',
  version: '1.0.0',
  provider: 'deepseek',
  license_key: rawKey,
  license_type: 'subscription',
  cost_usd: 0
};

const DB = {
  prepare(sql) {
    return {
      bind() { return this; },
      async first() {
        if (sql.includes('SELECT * FROM devices')) return { ...row };
        if (sql.includes('COUNT(*) AS n FROM devices')) return { n: 1 };
        return null;
      },
      async all() {
        if (sql.includes('FROM devices d') && sql.includes('LEFT JOIN')) {
          return { results: [{ ...row }] };
        }
        return { results: [] };
      },
      async run() { return { success: true }; }
    };
  }
};
const env = {
  DB,
  LICENSES: {
    async get(key) {
      if (key !== rawKey) return null;
      return JSON.stringify({
        key: rawKey,
        type: 'subscription',
        status: 'active',
        expires_at: '2026-10-01T00:00:00.000Z',
        device_ids: [deviceId],
        internal_note: 'must not leave KV'
      });
    },
    async put() {}
  }
};

const list = await statsUsers(env, { days: '1' });
assert.equal(list.users.length, 1);
assert.equal(list.users[0].license_key, undefined);
assert.equal(list.users[0].key_hint, '••••1234');
assert.equal(JSON.stringify(list).includes(rawKey), false,
  'list endpoint must not export a legacy bearer key');

const detail = await statsUserDetail(env, deviceId);
assert.equal(detail.device.license_key, undefined);
assert.equal(detail.device.key_hint, '••••1234');
assert.deepEqual(detail.license, {
  type: 'subscription', status: 'active', expires_at: '2026-10-01T00:00:00.000Z'
});
assert.equal(JSON.stringify(detail).includes(rawKey), false,
  'detail endpoint must not export a bearer key through either device or license objects');
assert.equal(JSON.stringify(detail).includes('internal_note'), false);

console.log('analytics secret output regression passed');

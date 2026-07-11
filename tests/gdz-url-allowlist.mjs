import assert from 'node:assert/strict';
import { isGdzApiUrl, isGdzHumanUrl, isGdzCoverUrl } from '../src/lib/gdz-hosts.js';

assert.equal(isGdzApiUrl('https://gdz-ru.com/x'), true);
assert.equal(isGdzApiUrl('https://img.gdz-ru.com/x'), true);
assert.equal(isGdzHumanUrl('https://gdz.ru/book/'), true);
assert.equal(isGdzCoverUrl('https://gdz.ru/book/'), true);
assert.equal(isGdzCoverUrl('https://img.gdz-ru.com/x'), true);

assert.equal(isGdzApiUrl('http://gdz-ru.com/x'), false);
assert.equal(isGdzApiUrl('https://evilgdz-ru.com/x'), false);
assert.equal(isGdzApiUrl('https://gdz-ru.com.evil.com/x'), false);
assert.equal(isGdzHumanUrl('https://gdz.ru@evil.com/'), false);
assert.equal(isGdzApiUrl('https://gdz-ru.com:8443/x'), false);
assert.equal(isGdzApiUrl('javascript:alert(1)'), false);
assert.equal(isGdzHumanUrl('not a url at all'), false);

console.log('GDZ URL allowlist regression passed');

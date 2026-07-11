import assert from 'node:assert/strict';
import { buildGdzUaRule, GDZ_UA_RULE_ID } from '../src/lib/gdz-ua-rule.js';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const rule = buildGdzUaRule(extensionId);

assert.equal(rule.id, GDZ_UA_RULE_ID);
assert.equal(rule.priority, 1);
assert.deepEqual(rule.condition.initiatorDomains, [extensionId]);
assert.equal(rule.condition.urlFilter, '||gdz-ru.com/');
assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest', 'image', 'media', 'other']);
assert.equal(rule.action.type, 'modifyHeaders');
assert.deepEqual(rule.action.requestHeaders, [
  { header: 'user-agent', operation: 'set', value: 'okhttp/4.9.1' }
]);

console.log('GDZ User-Agent rule scoping regression passed');

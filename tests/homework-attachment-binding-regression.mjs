import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { principalBindingMatches } from '../src/lib/principal-binding.js';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const scraper = source('../src/content/scraper.js');
const popup = source('../src/popup/popup.js');
const worker = source('../src/background/service-worker.js');

const principalA = JSON.stringify(['v2', 'account-a', 'subject-a', 'student-a', 'selected', '']);
const principalB = JSON.stringify(['v2', 'account-b', 'subject-b', 'student-b', 'selected', '']);
const accountOnlyPrincipal = JSON.stringify(['v2', 'account-a', 'subject-a', '', 'account', '']);
const unboundPrincipal = JSON.stringify(['v2', '', '', '', 'unbound', '']);
const rowToken = '11111111-1111-4111-8111-111111111111';

const bindingStart = scraper.indexOf("const HOMEWORK_CONTEXT_CHANGED =");
const bindingEnd = scraper.indexOf(
  '\n/**\n * Resolve the numeric student_id',
  bindingStart,
);
assert.ok(bindingStart >= 0 && bindingEnd > bindingStart,
  'homework principal guard source must be extractable');
const bindingSource = scraper.slice(bindingStart, bindingEnd);

let livePrincipal = principalA;
const bindingContext = {
  homeworkRowContexts: new Map([[rowToken, null]]),
  currentPrincipalIdentity: () => livePrincipal,
  document: { documentElement: { contains: () => true } },
};
vm.createContext(bindingContext);
vm.runInContext(
  `${bindingSource}\n` +
    'this.homeworkContextMatches = homeworkContextMatches;' +
    'this.assertHomeworkContext = assertHomeworkContext;',
  bindingContext,
);

assert.equal(bindingContext.homeworkContextMatches(principalA, null, rowToken), true);
livePrincipal = principalB;
assert.equal(bindingContext.homeworkContextMatches(principalA, null, rowToken), false,
  'a same-document account/child switch must revoke an old row');
livePrincipal = principalA;
assert.equal(
  bindingContext.homeworkContextMatches(
    principalA,
    null,
    '22222222-2222-4222-8222-222222222222',
  ),
  false,
  'a token absent from the latest scan must be rejected',
);
assert.equal(bindingContext.homeworkContextMatches(principalA, 'ambiguous child', rowToken), false);
livePrincipal = unboundPrincipal;
assert.equal(bindingContext.homeworkContextMatches(principalA, null, rowToken), false,
  'an unbound diary principal must fail closed');
livePrincipal = accountOnlyPrincipal;
assert.equal(bindingContext.homeworkContextMatches(accountOnlyPrincipal, null, rowToken), false,
  'an account without an explicit selected child must not authorize child-owned homework');
livePrincipal = principalA;
const detachedRowToken = '55555555-5555-4555-8555-555555555555';
const detachedRow = { detached: true };
bindingContext.homeworkRowContexts.set(detachedRowToken, new WeakRef(detachedRow));
bindingContext.document.documentElement.contains = () => false;
assert.equal(bindingContext.homeworkContextMatches(principalA, null, detachedRowToken), false,
  'a row removed by a same-document diary rerender must lose authority');
bindingContext.document.documentElement.contains = () => true;
// A root the WeakRef can no longer produce (detached and then collected) is
// the same verdict as a detached-but-alive root — never a silent fallback to
// the principal-only check that null-root (text-only) tokens legitimately use.
class CollectedRowRef extends WeakRef { deref() { return undefined; } }
const collectedRowToken = '66666666-6666-4666-8666-666666666666';
bindingContext.homeworkRowContexts.set(collectedRowToken, new CollectedRowRef({}));
assert.equal(bindingContext.homeworkContextMatches(principalA, null, collectedRowToken), false,
  'a collected row root must lose authority, not pass on principal alone');
bindingContext.document.documentElement.contains = () => true;
livePrincipal = unboundPrincipal;
assert.throws(
  () => bindingContext.assertHomeworkContext(principalA, null, rowToken),
  (error) => error?.code === 'HOMEWORK_CONTEXT_CHANGED',
);

// Exercise the real discovery continuation. If identity changes while the
// student lookup is pending, no lesson API request or bearer-bearing result may
// escape.
const listStart = scraper.indexOf('async function listMaterialUrls(');
const listEnd = scraper.indexOf('\n/**\n * Diagnostic for the file auto-fetch', listStart);
assert.ok(listStart >= 0 && listEnd > listStart,
  'attachment discovery source must be extractable');
const listSource = scraper.slice(listStart, listEnd);
let apiCalls = 0;
livePrincipal = principalA;
const discoveryContext = {
  ...bindingContext,
  currentPrincipalIdentity: () => livePrincipal,
  attachmentFeatureEnabled: async () => true,
  findAuthToken: () => 'secret-bearer',
  meshHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
  dbg() {},
  jwtPayload: () => ({ msh: 'account-a' }),
  resolveStudentId: async () => {
    livePrincipal = principalB;
    return { id: '12345' };
  },
  LESSON_API: () => 'https://school.mos.ru/api/lesson',
  fetchMeshJson: async () => {
    apiCalls += 1;
    return { res: { ok: true }, json: {} };
  },
  urlsForHomework: () => ({ urls: [], candidates: [] }),
  scanPageForFileLinks: () => ({ urls: [], candidates: [] }),
  isSameOrigin: () => false,
  fetchInlineFile: async () => null,
};
vm.createContext(discoveryContext);
vm.runInContext(
  `${bindingSource}\n${listSource}\nthis.listMaterialUrls = listMaterialUrls;`,
  discoveryContext,
);
await assert.rejects(
  discoveryContext.listMaterialUrls(
    7,
    'task',
    9,
    rowToken,
    principalA,
    null,
  ),
  (error) => error?.code === 'HOMEWORK_CONTEXT_CHANGED',
);
assert.equal(apiCalls, 0,
  'identity must be rechecked after student resolution and before the lesson API');

// Exercise the worker's two independent owners: current local scan state and
// the live content-script row/principal check.
const verifyStart = worker.indexOf('async function verifyHomeworkDownloadBinding(');
const verifyEnd = worker.indexOf('\n// Only the MESH content script', verifyStart);
assert.ok(verifyStart >= 0 && verifyEnd > verifyStart,
  'worker homework binding verifier must be extractable');
const verifySource = worker.slice(verifyStart, verifyEnd);
const scanId = '33333333-3333-4333-8333-333333333333';
let cachedWeek = {
  scanId,
  principal: principalA,
  principalError: null,
};
let contentMatches = true;
const verifyContext = {
  principalBindingMatches,
  chrome: {
    storage: {
      local: {
        async get() { return { weekHomework: cachedWeek }; },
      },
    },
    tabs: {
      async sendMessage() { return { ok: true, matches: contentMatches }; },
    },
  },
};
vm.createContext(verifyContext);
vm.runInContext(
  `${verifySource}\nthis.verifyHomeworkDownloadBinding = verifyHomeworkDownloadBinding;`,
  verifyContext,
);
const downloadBinding = {
  tabId: 41,
  scanId,
  principal: principalA,
  principalError: null,
  rowToken,
};
await assert.doesNotReject(
  verifyContext.verifyHomeworkDownloadBinding(downloadBinding),
);
cachedWeek = { ...cachedWeek, scanId: '44444444-4444-4444-8444-444444444444' };
await assert.rejects(
  verifyContext.verifyHomeworkDownloadBinding(downloadBinding),
  /Скан домашних заданий/,
);
cachedWeek = { scanId, principal: principalA, principalError: null };
contentMatches = false;
await assert.rejects(
  verifyContext.verifyHomeworkDownloadBinding(downloadBinding),
  /Страница, аккаунт или ученик/,
);

// A switch during the privileged cross-origin fetch must discard the bytes,
// not return them and rely on the popup to notice.
const downloadStart = worker.indexOf('async function downloadFiles(payload = {})');
const downloadEnd = worker.indexOf('\n/**\n * MAIN-world MathQuill', downloadStart);
assert.ok(downloadStart >= 0 && downloadEnd > downloadStart,
  'bound download source must be extractable');
const downloadSource = worker.slice(downloadStart, downloadEnd);
let verifyCalls = 0;
const downloadContext = {
  attachmentHeaders: (headers) => headers,
  meshHeadersFromToken: () => ({}),
  MAX_REQUEST_FILE_BYTES: 1024,
  isAllowedAttachmentUrl: () => true,
  verifyHomeworkDownloadBinding: async () => {
    verifyCalls += 1;
    if (verifyCalls === 3) throw new Error('binding changed while downloading');
  },
  downloadFile: async () => ({
    name: 'private.pdf',
    mimeType: 'application/pdf',
    dataBase64: 'c2VjcmV0',
    byteLength: 6,
  }),
};
vm.createContext(downloadContext);
vm.runInContext(`${downloadSource}\nthis.downloadFiles = downloadFiles;`, downloadContext);
await assert.rejects(
  downloadContext.downloadFiles({
    ...downloadBinding,
    urls: ['https://school.mos.ru/private.pdf'],
    token: 'one-time-mesh-token',
  }),
  /binding changed while downloading/,
);

assert.match(
  popup,
  /MESH_LIST_MATERIALS[\s\S]*?principal: card\.principal,[\s\S]*?principalError: card\.principalError/,
  'discovery must carry the immutable scan principal',
);
assert.match(
  scraper,
  /type: 'DOWNLOAD_FILES'[\s\S]*?token,[\s\S]*?scanId,[\s\S]*?principal: expectedPrincipal,[\s\S]*?rowToken/,
  'the content script must pass the one-time token with scan/principal/row binding',
);
assert.match(
  scraper,
  /type: 'GET_ACTION_TOKEN'[\s\S]*?action: 'DOWNLOAD_FILES'[\s\S]*?type: 'DOWNLOAD_FILES'[\s\S]*?token: grant\.token/,
  'the bearer-bearing request must consume a one-time action capability',
);
assert.match(
  worker,
  /const CONTENT_ACTIONS = new Set\([\s\S]*?'DOWNLOAD_FILES'/,
  'the worker must actually require the one-time action capability for attachment downloads',
);
assert.match(
  scraper,
  /GET_RUNTIME_CONFIG[\s\S]*?features\?\.mesh_attachments[\s\S]*?await attachmentFeatureEnabled\(\)[\s\S]*?findAuthToken\(\)/,
  'the signed attachment switch must be checked before the bearer is read',
);
assert.match(
  popup,
  /type: 'MESH_DOWNLOAD_CANDIDATE'[\s\S]*?\.\.\.attachmentBindingPayload\(card\)/,
  'manual candidate selection must retain tab/scan/principal/row binding',
);
assert.doesNotMatch(
  popup,
  /type: 'DOWNLOAD_FILES'|candidateAuth|Authorization:/,
  'the popup must never receive or relay the MESH bearer token',
);
assert.match(
  popup,
  /type: 'OPEN_DASHBOARD'[\s\S]*?tabId: scanContext\.tabId,[\s\S]*?scanId: scanContext\.scanId/,
  'dashboard launch must be rechecked against the original scan tab',
);
assert.match(
  scraper,
  /result\.principal = binding\.principal/,
  'week scans must store the full account/child principal, not only a student id',
);
assert.match(
  worker,
  /DOWNLOAD_FILES:[\s\S]*?'token'[\s\S]*?isHomeworkScanId\(msg\.payload\.scanId\)[\s\S]*?isHomeworkScanId\(msg\.payload\.rowToken\)/,
  'the privileged message schema must require the token and immutable binding components',
);

console.log('homework attachment binding regression passed');

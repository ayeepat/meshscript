import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

let storedRateLimits = {};
globalThis.chrome = {
  storage: {
    local: {
      async get() {
        return {
          rateLimits: storedRateLimits,
          rateUsage: {},
          rateAttempts: {},
          rateHistory: {},
          rateReservations: {}
        };
      }
    }
  }
};

const { MAX_DAILY_LIMIT, getUsage } = await import('../src/lib/rate-limit.js');
assert.equal(MAX_DAILY_LIMIT, 10000);
storedRateLimits = { openrouter: 999999, groq: '999999999999999999999999999999999999' };
const usage = await getUsage();
assert.equal(usage.openrouter.limit, 10000, 'numeric stored limits must be capped at the advertised ceiling');
assert.equal(usage.groq.limit, 10000, 'huge hand-edited string limits must be capped at the advertised ceiling');

const scraper = source('../src/content/scraper.js');
const markerGuardStart = scraper.indexOf('const QNUM_TEXT_RE =');
const markerCollectorStart = scraper.indexOf('function collectQuestionMarkers()', markerGuardStart);
const markerCollectorEnd = scraper.indexOf('\n// The question number for a node', markerCollectorStart);
assert.ok(markerGuardStart >= 0 && markerCollectorStart > markerGuardStart && markerCollectorEnd > markerCollectorStart,
  'question heading guard source must be extractable');
const markerGuardBlock = scraper.slice(markerGuardStart, markerCollectorStart);
const questionContext = {};
vm.runInNewContext(
  `${markerGuardBlock}\n` +
  `globalThis.acceptQuestionMarker = (s) => {\n` +
  `  const m = s.match(QNUM_TEXT_RE);\n` +
  `  return m && isAuthoritativeQuestionMarker(s, m) ? Number(m[1]) : null;\n` +
  `};`,
  questionContext,
  { filename: 'scraper-question-reference-guard.js' }
);
assert.equal(questionContext.acceptQuestionMarker('См. задание 3'), null);
assert.equal(questionContext.acceptQuestionMarker('из задания 2'), null);
assert.equal(questionContext.acceptQuestionMarker('После задания 3 откройте подсказку'), null);
assert.equal(questionContext.acceptQuestionMarker('Ответ к заданию 4'), null);
assert.equal(questionContext.acceptQuestionMarker('ЗАДАНИЕ №3'), 3);
assert.equal(questionContext.acceptQuestionMarker('Выполните задание 3'), 3);
assert.equal(questionContext.acceptQuestionMarker('ЗАДАНИЕ №3. Решите уравнение'), 3);
assert.equal(questionContext.acceptQuestionMarker('Ответьте на вопрос 4: выберите один вариант'), 4);
assert.equal(questionContext.acceptQuestionMarker('Прочитайте задание 3 в учебнике'), null);
assert.equal(questionContext.acceptQuestionMarker('Ответьте на вопрос 4 из параграфа 2'), null);
assert.equal(questionContext.acceptQuestionMarker('Рассмотрите задание 5 на странице 42'), null);

function textNode(value) {
  return { nodeType: 3, nodeValue: value, parentElement: null };
}

function element(tagName, children = [], attrs = {}) {
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    parentElement: null,
    childNodes: children,
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
    get textContent() {
      return children.map((child) => child.nodeValue ?? child.textContent ?? '').join('');
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function markerFixture() {
  return element('body', [
    element('h2', [textNode('ЗАДАНИЕ №3. Решите уравнение')]),
    element('h3', [element('span', [textNode('ЗАДАНИЕ')]), element('span', [textNode('№6')])]),
    element('p', [textNode('Прочитайте задание 8')]),
    element('div', [textNode('Ответьте на вопрос 9: выберите один вариант')]),
    element('h4', [textNode('Рассмотрите задание 10 докажите утверждение')]),
    element('p', [textNode('Прочитайте задание 3 в учебнике')]),
    element('p', [textNode('Ответьте на вопрос 4 из параграфа 2')]),
    element('p', [textNode('Рассмотрите задание 5 на странице 42')]),
    element('p', [
      textNode('Прочитайте '),
      element('span', [textNode('задание')]),
      element('span', [textNode('11')]),
      textNode(' в учебнике'),
    ]),
  ]);
}

function markerVmContext(body) {
  return {
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
      body,
      documentElement: body,
      createTreeWalker(root) {
        const texts = [];
        const visit = (node) => {
          if (node.nodeType === 3) texts.push(node);
          else for (const child of node.childNodes || []) visit(child);
        };
        visit(root);
        let index = 0;
        return { nextNode: () => texts[index++] || null };
      },
    },
    normalize: (text) => String(text || '').replace(/\s+/g, ' ').trim(),
  };
}

const collectorContext = markerVmContext(markerFixture());
vm.runInNewContext(
  `${scraper.slice(markerGuardStart, markerCollectorEnd)}\n` +
  'globalThis.markerNumbers = collectQuestionMarkers().map((marker) => marker.number);',
  collectorContext,
  { filename: 'scraper-question-marker-collector.js' },
);
assert.deepEqual(JSON.parse(JSON.stringify(collectorContext.markerNumbers)), [3, 6, 8, 9, 10],
  'real headings/instructions must survive while prose references, including split spans, are rejected');

const workerForMarkers = source('../src/background/service-worker.js');
const mathQuillMarkerBlock = workerForMarkers.slice(
  workerForMarkers.indexOf('var QRE =', workerForMarkers.indexOf('function fillMathQuillMain')),
  workerForMarkers.indexOf('var numFor =', workerForMarkers.indexOf('function fillMathQuillMain')),
);
assert.match(mathQuillMarkerBlock, /isAuthoritativeMarker\(s, mm, markerNode\)/,
  'the MAIN-world MathQuill mirror must apply the same prose-reference guard');
assert.match(mathQuillMarkerBlock, /markerTextScope\(tn\)[\s\S]*?ps\.match\(QRE\)/,
  'split-span MathQuill headings must be classified from their combined semantic scope');
const mathQuillContext = markerVmContext(markerFixture());
vm.runInNewContext(
  `${mathQuillMarkerBlock}\nglobalThis.markerNumbers = markers.map((marker) => marker.n);`,
  mathQuillContext,
  { filename: 'mathquill-question-marker-collector.js' },
);
assert.deepEqual(JSON.parse(JSON.stringify(mathQuillContext.markerNumbers)), [3, 6, 8, 9, 10],
  'MAIN-world MathQuill marker classification must exactly mirror content-script semantics');

const mathQuillCanonicalBlock = workerForMarkers.slice(
  workerForMarkers.indexOf('var toLatex =', workerForMarkers.indexOf('function fillMathQuillMain')),
  workerForMarkers.indexOf('// Per-field values', workerForMarkers.indexOf('function fillMathQuillMain')),
);
const mathQuillCanonicalContext = {};
vm.runInNewContext(
  `${mathQuillCanonicalBlock}\n` +
    'globalThis.toLatex = toLatex; globalThis.canonicalLatex = canonicalLatex;',
  mathQuillCanonicalContext,
  { filename: 'mathquill-readback-canonicalization.js' },
);
assert.equal(
  mathQuillCanonicalContext.canonicalLatex(
    mathQuillCanonicalContext.toLatex('-8/3')
  ),
  mathQuillCanonicalContext.canonicalLatex('\\frac{-8}{3}'),
  'known MathQuill fraction/sign presentation differences may compare equal',
);
assert.notEqual(
  mathQuillCanonicalContext.canonicalLatex('17'),
  mathQuillCanonicalContext.canonicalLatex('42'),
  'an older non-empty MathQuill value must not certify a rejected new answer',
);
assert.match(workerForMarkers,
  /canonicalLatex\(after\) !== intendedCanonical[\s\S]*?complete = false/,
  'the actual MathQuill readback must match the intended answer before success');
assert.match(workerForMarkers,
  /setTimeout\(resolve, 80\)[\s\S]*?canonicalLatex\(settled\) !== intendedCanonical/,
  'controlled MathQuill fields must be rechecked after delayed reconciliation');

const localStore = {};
const sessionStore = {};
const area = (store) => ({
  async get(key) { return { [key]: store[key] }; },
  async set(values) { Object.assign(store, values); },
  async remove(key) {
    for (const item of (Array.isArray(key) ? key : [key])) delete store[item];
  }
});
globalThis.chrome = { storage: { local: area(localStore), session: area(sessionStore) } };
const { storeDashboardLaunch, consumeDashboardLaunch } = await import('../src/lib/dashboard-launch.js');
const scanA = '11111111-1111-4111-8111-111111111111';
const scanB = '22222222-2222-4222-8222-222222222222';
const launchId = await storeDashboardLaunch({
  subject: 'Алгебра',
  scanId: scanA,
  principal: 'student-42',
  principalError: 'ambiguous multi-child selection'
});
const launchPayload = await consumeDashboardLaunch(launchId);
assert.equal(launchPayload.scanId, scanA, 'scan capability must survive the encrypted launch handoff');
assert.equal(launchPayload.principal, 'student-42', 'principal must survive the consume-once launch handoff');
assert.equal(launchPayload.principalError, 'ambiguous multi-child selection',
  'principal discovery errors must survive the consume-once launch handoff');

const { isHomeworkScanId, principalBindingMatches } = await import('../src/lib/principal-binding.js');
assert.equal(isHomeworkScanId(scanA), true);
assert.equal(isHomeworkScanId('predictable-label'), false);
assert.equal(principalBindingMatches({
  cacheScanId: scanA,
  launchScanId: scanA,
  cachePrincipal: 'student-42',
  launchPrincipal: 'student-42'
}), true, 'matching scan capability and principal authorize this exact cache');
assert.equal(principalBindingMatches({
  cachePrincipal: 'student-42',
  launchPrincipal: 'student-42'
}), false, 'matching principals without a scan capability are insufficient');
assert.equal(principalBindingMatches({
  cacheScanId: scanA,
  launchScanId: scanA,
  cachePrincipal: null,
  launchPrincipal: null
}), true, 'two unavailable principals are safe only under the same opaque scan capability');
assert.equal(principalBindingMatches({ cachePrincipal: null, launchPrincipal: null }), false,
  'two unknown legacy principals must not match without the same scan capability');
assert.equal(principalBindingMatches({
  cacheScanId: scanA,
  launchScanId: scanB,
  cachePrincipal: 'student-42',
  launchPrincipal: 'student-42'
}), false, 'a launch cannot consume a different scan even when principals match');
assert.equal(principalBindingMatches({
  cacheScanId: scanA,
  launchScanId: scanA,
  cachePrincipal: 'student-42',
  launchPrincipal: null
}), false,
  'asymmetric identity must fail closed');
assert.equal(principalBindingMatches({
  cacheScanId: scanA,
  launchScanId: scanA,
  cachePrincipal: null,
  launchPrincipal: 'student-42'
}), false,
  'asymmetric identity must fail closed in either direction');
assert.equal(principalBindingMatches({
  cacheScanId: scanA,
  launchScanId: scanA,
  cachePrincipal: null,
  launchPrincipal: null,
  launchError: 'ambiguous multi-child selection'
}), false, 'an explicit ambiguity signal is not equivalent to unavailable identity');

const dashboard = source('../src/dashboard/dashboard.js');
const popup = source('../src/popup/popup.js');
const worker = source('../src/background/service-worker.js');
assert.match(
  dashboard,
  /freshWeek && !principalBindingMatches\(\{[\s\S]*?cacheScanId,[\s\S]*?launchScanId,/,
  'all fresh-week cache consumption, including direct opening, must require the scan binding'
);
assert.match(popup, /render\(resp\.data, crypto\.randomUUID\(\), tab\.id\)/,
  'each successful popup scan must mint a fresh opaque capability');
assert.match(popup, /weekHomework:[\s\S]*?scanId: scanContext\.scanId/,
  'the popup must persist the capability beside the exact scanned week');
assert.match(worker, /openDashboard\(payload\)[\s\S]*?verifyHomeworkDownloadBinding\(payload\)/,
  'the worker must revalidate the live scan, principal, and row before launching');
assert.match(worker, /OPEN_DASHBOARD:[\s\S]*?isHomeworkScanId\(msg\.payload\.scanId\)/,
  'the privileged OPEN_DASHBOARD boundary must validate scan capabilities');
assert.match(scraper, /const binding = currentHomeworkPrincipal\(\);[\s\S]*?result\.principalError = binding\.error/,
  'ambiguous or unbound profile discovery must propagate into cache/launch binding');

console.log('verified findings E-26–E-29 regressions passed');

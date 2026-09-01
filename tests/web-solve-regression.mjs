/**
 * "Solve a question on any web page" — the rules that keep the new path from
 * costing the МЭШ product anything.
 *
 * Four properties are load-bearing and each one is pinned below:
 *
 *  1. REACH. The extension ships no broad host permission. A generic page is
 *     readable only on an origin the user granted, Mesh and our own hosts are
 *     excluded from that machinery entirely, and a granted page speaks to the
 *     worker through a strictly narrower message set than a Mesh page does.
 *  2. IDENTITY. A web capture is ONE top-level document carrying an
 *     origin-scoped principal. It can never be matched against a Mesh capture,
 *     and a Mesh-shaped principal can never masquerade as a web one.
 *  3. COST. Every non-Mesh request is pinned to the cheap standard chain at low
 *     effort, and the hint that does it is downgrade-only.
 *  4. QUIET. The pill must not appear on every page of a granted site — a lone
 *     search box is not a quiz — and the scrape must strip site furniture and
 *     stay inside its character budget.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  expectedWebPrincipal,
  isMeshHostname,
  isWebSolvableUrl,
  webCapturePrincipal,
  webOriginPattern,
  webPillExcludeMatches,
  webPillMatchPatterns,
  WEB_SOLVE_EFFORT,
  WEB_SOLVE_PROVIDER,
  WEB_SOLVE_TIER,
} from '../src/lib/web-solve.js';
import {
  CAPTURE_MODE_WEB,
  isTestCaptureContext,
  isWebCapture,
  sameTestCaptureContext,
} from '../src/lib/test-capture-context.js';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const scraper = source('../src/content/scraper.js');
const pillSource = source('../src/content/test-pill.js');
const worker = source('../src/background/service-worker.js');
const manifest = JSON.parse(source('../manifest.json'));

function sectionOf(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section missing: ${startMarker}`);
  return text.slice(start, end);
}

/* ================= 1. Reach ================= */

{
  // Mesh keeps its own (stricter) path; a stray optional grant must never
  // downgrade a Mesh page onto the generic reader.
  for (const url of [
    'https://school.mos.ru/diary/',
    'https://uchebnik.mos.ru/exam/challenge/1',
  ]) {
    assert.equal(isWebSolvableUrl(url), false, `${url} must stay on the Mesh path`);
  }
  // Our own hosts are in host_permissions, so they come back from
  // permissions.getAll() — without this they would get a pill on the pricing page.
  for (const url of ['https://smeshai.xyz/', 'https://smeshapi.site/verify', 'https://ai.smeshapi.site/']) {
    assert.equal(isWebSolvableUrl(url), false, `${url} is ours, not a page with questions`);
  }
  for (const url of [
    'chrome://extensions',
    'chrome-extension://abc/popup.html',
    'file:///Users/x/quiz.html',
    'about:blank',
    '',
  ]) {
    assert.equal(isWebSolvableUrl(url), false, `${url} must not be solvable`);
  }
  assert.equal(isWebSolvableUrl('https://example.com/quiz?id=3'), true);
  assert.equal(isWebSolvableUrl('http://localhost:8080/test'), true);

  assert.equal(webOriginPattern('https://example.com/quiz?id=3'), 'https://example.com/*');
  assert.equal(webOriginPattern('http://localhost:8080/t'), 'http://localhost:8080/*');
  assert.equal(webOriginPattern('https://school.mos.ru/x'), '',
    'an ineligible tab must yield no pattern rather than something requestable');
}

{
  // permissions.getAll() returns the manifest's REQUIRED origins too. Feeding
  // those straight into registerContentScripts would put the generic pill on
  // Mesh (which already has the static one) and on our own site.
  const granted = [
    ...manifest.host_permissions,
    'https://example.com/*',
    'https://*.quizsite.org/*',
    'file:///*',
    'chrome://*/*',
  ];
  const matches = webPillMatchPatterns(granted);
  assert.deepEqual(matches, ['https://example.com/*', 'https://*.quizsite.org/*'],
    'only third-party http(s) grants may register the generic pill');

  assert.deepEqual(webPillMatchPatterns(['*://*/*']), ['*://*/*'],
    'an explicit all-sites grant is the user\'s call and must survive the filter');
  const excluded = webPillExcludeMatches();
  for (const host of ['school.mos.ru', 'uchebnik.mos.ru', 'smeshai.xyz']) {
    assert.ok(excluded.includes(`*://${host}/*`),
      `${host} must be excluded even under an all-sites grant`);
  }
  assert.deepEqual(webPillMatchPatterns(null), [], 'a missing grant list registers nothing');
}

{
  // The manifest must keep asking for nothing broad at install time.
  assert.deepEqual(
    manifest.optional_host_permissions,
    ['http://*/*', 'https://*/*'],
    'generic solving must live behind OPTIONAL host permissions'
  );
  for (const pattern of manifest.host_permissions) {
    assert.ok(!pattern.includes('*://*') && pattern !== '<all_urls>',
      `host_permissions must stay narrow: ${pattern}`);
  }
  // The pill is registered at runtime, never statically, off Mesh.
  const staticMatches = manifest.content_scripts.flatMap((entry) => entry.matches);
  for (const pattern of staticMatches) {
    assert.ok(/mos\.ru/.test(pattern), `static content scripts must stay on Mesh: ${pattern}`);
  }
}

{
  // A granted page gets a strictly smaller message set than a Mesh page: it can
  // solve and fill the page in front of it, and can never reach the multi-page
  // autopilot, which clicks through a graded test.
  const senderTypes = sectionOf(worker, 'const SENDER_MESSAGE_TYPES = {', '\n};');
  const webSet = sectionOf(senderTypes, '  web: new Set([', '  ]),');
  for (const forbidden of ['PILL_SOLVE_ALL', 'PILL_SOLVE_PAGE']) {
    assert.ok(!webSet.includes(forbidden),
      `a generic page must not be able to send ${forbidden}`);
  }
  assert.ok(webSet.includes('WEB_SOLVE_PAGE'));
  const meshSet = sectionOf(senderTypes, '  content: new Set([', '  ]),');
  assert.ok(!meshSet.includes('WEB_SOLVE_PAGE'),
    'a Mesh page must not be able to drive the generic path either');

  // Both classes still burn a single-use capability token.
  assert.ok(
    worker.includes("if ((senderClass === 'content' || senderClass === 'web') && CONTENT_ACTIONS.has(msg.type)"),
    'generic-page actions must consume an action token like Mesh ones do'
  );
  assert.ok(
    worker.includes('if (!SENDER_MESSAGE_TYPES[senderClass]?.has(msg.action))'),
    'a token may only be minted for an action the sender class is allowed to send'
  );
}

{
  // classifyMessageSender, executed. A subframe of a granted page is a third
  // party (an ad, an embed) and must get no authority at all.
  const classifySource = sectionOf(
    worker,
    'function sameOrigin(a, b) {',
    'function validateMessage(senderClass, msg) {'
  );
  const context = {
    URL,
    chrome: { runtime: { id: 'smeshid' } },
    EXTENSION_PAGE_PREFIX: 'chrome-extension://smeshid/',
    isSafeId: (v) => Number.isSafeInteger(v) && v >= 0,
    isMeshContentUrl: (url) => /^https:\/\/(school|uchebnik)\.mos\.ru\//.test(String(url || '')),
    isWebSolvableUrl,
  };
  vm.createContext(context);
  vm.runInContext(`${classifySource}\nthis.__classify = classifyMessageSender;`, context);
  const classify = context.__classify;

  const page = 'https://example.com/quiz';
  assert.equal(
    classify({ id: 'smeshid', frameId: 0, tab: { id: 4, url: page }, url: page }),
    'web'
  );
  assert.equal(
    classify({ id: 'smeshid', frameId: 3, tab: { id: 4, url: page }, url: 'https://ads.example.net/f' }),
    null,
    'a subframe of a granted page must have no authority'
  );
  assert.equal(
    classify({ id: 'smeshid', frameId: 0, tab: { id: 4, url: page }, url: 'https://evil.test/f' }),
    null,
    'a top frame whose own URL disagrees with the tab URL must be refused'
  );
  assert.equal(
    classify({ id: 'other', frameId: 0, tab: { id: 4, url: page }, url: page }),
    null,
    'another extension must never be classified'
  );
  // Mesh classification is untouched.
  const mesh = 'https://school.mos.ru/diary/';
  assert.equal(
    classify({ id: 'smeshid', frameId: 0, tab: { id: 4, url: mesh }, url: mesh }),
    'content'
  );
}

/* ================= 2. Identity ================= */

{
  // scraper.js cannot import lib/web-solve.js (classic content script), so the
  // principal shape exists twice. This is the assertion that keeps them equal.
  const scraperPrincipal = sectionOf(
    scraper,
    'function webCapturePrincipalIdentity() {',
    '\n/**'
  );
  const context = { location: { href: 'https://example.com/quiz?x=1' }, URL, JSON };
  vm.createContext(context);
  vm.runInContext(`${scraperPrincipal}\nthis.__principal = webCapturePrincipalIdentity;`, context);
  assert.equal(
    context.__principal(),
    webCapturePrincipal('https://example.com'),
    'scraper.js and lib/web-solve.js must mint the identical web principal'
  );
  assert.equal(expectedWebPrincipal('https://example.com/quiz?x=1'), context.__principal());
  assert.equal(expectedWebPrincipal('https://school.mos.ru/x'), '',
    'a Mesh URL has no web principal');

  // The origin — not the path — is the isolation unit, so two pages of one site
  // share a reuse scope and two sites never do.
  assert.equal(
    expectedWebPrincipal('https://example.com/a'),
    expectedWebPrincipal('https://example.com/b')
  );
  assert.notEqual(
    expectedWebPrincipal('https://example.com/a'),
    expectedWebPrincipal('https://other.example/a')
  );
  assert.ok(isMeshHostname('school.mos.ru') && !isMeshHostname('example.com'));
}

{
  const document0 = (overrides = {}) => ({
    frameId: 0,
    documentId: 'doc-1',
    pageId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    signature: 'sig-1',
    principal: webCapturePrincipal('https://example.com'),
    url: 'https://example.com/quiz',
    isTestDocument: true,
    ...overrides,
  });
  const webCapture = (overrides = {}) => ({
    tabId: 7,
    url: 'https://example.com/quiz',
    documentId: 'doc-1',
    signature: '0:sig-1',
    documents: [document0()],
    mode: CAPTURE_MODE_WEB,
    ...overrides,
  });

  assert.equal(isTestCaptureContext(webCapture()), true);
  assert.equal(isWebCapture(webCapture()), true);
  assert.equal(isWebCapture({ ...webCapture(), mode: undefined }), false,
    'an absent mode still means Mesh, so old payloads keep their old meaning');

  // A generic capture is exactly ONE top-level document. A child frame off Mesh
  // is an ad or a widget and may neither feed a prompt nor receive an autofill.
  assert.equal(
    isTestCaptureContext(webCapture({
      documents: [document0(), document0({
        frameId: 1,
        documentId: 'doc-2',
        pageId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
      })],
      signature: '0:sig-1||1:sig-1',
    })),
    false,
    'a web capture must never carry a child frame'
  );
  // The principal has to be the origin-scoped web identity: a Mesh document
  // whose account signals were unreadable must not be laundered into one.
  assert.equal(
    isTestCaptureContext(webCapture({
      documents: [document0({ principal: JSON.stringify(['v2', 'acct', 'sub', 'kid', 'selected', '']) })],
    })),
    false,
    'a Mesh-shaped principal must not satisfy a web capture'
  );
  assert.equal(
    isTestCaptureContext(webCapture({
      documents: [document0({ principal: JSON.stringify(['v2', '', '', '', 'web', '']) })],
    })),
    false,
    'a web principal with no origin carries no identity'
  );
  assert.equal(
    isTestCaptureContext(webCapture({ url: 'https://example.com/other' })),
    false,
    'the capture URL and its top document must agree'
  );
  assert.equal(isTestCaptureContext(webCapture({ mode: 'sideways' })), false,
    'an unknown mode must be refused outright');

  // The two modes are never interchangeable, even when every other field lines up.
  const asMesh = { ...webCapture() };
  delete asMesh.mode;
  assert.equal(sameTestCaptureContext(webCapture(), asMesh), false,
    'a web capture must never match a Mesh read of the same tab');
  assert.equal(sameTestCaptureContext(webCapture(), webCapture()), true);
}

{
  // Mesh captures are untouched by the mode work: still multi-frame, still
  // requiring an identity-bearing principal somewhere in the capture.
  const meshDocument = (overrides = {}) => ({
    frameId: 0,
    documentId: 'm-1',
    pageId: '3f2504e0-4f89-41d3-9a0c-0305e82c3311',
    signature: 'sig',
    principal: JSON.stringify(['v2', 'acct', '', 'kid', 'selected', '']),
    url: 'https://school.mos.ru/dt/x/go?subcategory_id=1',
    isTestDocument: true,
    ...overrides,
  });
  const meshCapture = {
    tabId: 3,
    url: 'https://school.mos.ru/dt/x/go?subcategory_id=1',
    documentId: 'm-1',
    signature: '0:sig',
    documents: [meshDocument()],
  };
  assert.equal(isTestCaptureContext(meshCapture), true);
  assert.equal(
    isTestCaptureContext({
      ...meshCapture,
      documents: [meshDocument({ principal: JSON.stringify(['v2', '', '', '', 'unbound', '']) })],
    }),
    false,
    'an all-unknown Mesh capture must still fail closed'
  );
}

/* ================= 3. Cost ================= */

{
  assert.equal(WEB_SOLVE_TIER, 'standard');
  assert.equal(WEB_SOLVE_EFFORT, 'low');
  assert.equal(WEB_SOLVE_PROVIDER, 'deepseek');

  const solveWeb = sectionOf(worker, 'async function solveWebPage(', 'async function fillWebAnswersInTab(');
  assert.ok(solveWeb.includes('reasoning: { effort: WEB_SOLVE_EFFORT }'),
    'the any-site solve must run at the pinned low effort');
  assert.ok(solveWeb.includes('tier: WEB_SOLVE_TIER'),
    'the any-site solve must ask for the cheap chain');
  assert.ok(solveWeb.includes('provider: WEB_SOLVE_PROVIDER') && solveWeb.includes('proxyOnly: true'),
    'the any-site solve must force the licensed proxy even for grandfathered BYO installs');
  assert.ok(!solveWeb.includes('normalizeAIProvider(provider'),
    'page-provided/stored provider choices must not bypass the GLM route');

  // The per-question re-solve is the other paid call on this path; it must obey
  // the same rule instead of quietly inheriting Mesh\'s high effort.
  const resolveOne = sectionOf(worker, 'async function resolveOneQuestion(', 'function normalizeParts(');
  assert.ok(resolveOne.includes("const effort = web ? WEB_SOLVE_EFFORT : 'high';"),
    'a re-solve off Mesh must drop to the cheap effort');
  assert.ok(resolveOne.includes('...(web ? { tier: WEB_SOLVE_TIER } : {})'),
    'a re-solve off Mesh must also ask for the cheap chain');
  assert.ok(resolveOne.includes('...(web ? { provider: WEB_SOLVE_PROVIDER, proxyOnly: true } : {})'),
    'a re-solve off Mesh must force the same licensed proxy route');

  const deepseek = source('../src/lib/deepseek.js');
  assert.ok(deepseek.includes('const key = proxyOnly ? null : await getByoKey();'),
    'the forced web route must ignore a hidden Alibaba BYO key');
  const ai = source('../src/lib/ai.js');
  assert.ok(ai.includes('const legacyDeepseekByo = opts.proxyOnly ? false : Boolean(await getByoKey());'),
    'a screenshot re-solve must not be diverted to direct BYO by the vision router');

  // Downgrade-only, in the client...
  const proxy = source('../src/lib/smesh-proxy.js');
  assert.ok(proxy.includes("if (tier === 'standard') body.tier = 'standard';"),
    'the proxy client must send only the standard downgrade, never a tier upgrade');

  // ...and in the server, where it forces the cheap tier but can never request
  // the frontier one.
  const vps = source('../backend-vps/server.js');
  assert.ok(
    vps.includes("const tier = requestStandard === true || limits.force_standard ||"),
    'the VPS must let the client force the standard tier'
  );
  assert.ok(
    vps.includes("prep.body?.tier === 'standard'"),
    'the VPS must read the tier hint from the whitelisted request options'
  );
  assert.ok(
    vps.includes("if (body.tier === 'standard') requestOptions.tier = 'standard';"),
    "'standard' must be the only accepted value of the hint"
  );
  // GLM is forced to think; only an EXPLICIT standard request may keep its own
  // effort, so already-installed Auto clients are still overridden to max.
  assert.ok(
    vps.includes("upstreamBody.reasoning_effort = body.tier === 'standard' && REASONING_EFFORTS.has(body.reasoning_effort)"),
    'GLM must honour the effort only for an explicit standard-tier request'
  );
  assert.ok(
    vps.includes('upstreamBody.thinking = { type: \'enabled\' };'),
    'GLM must still be told to think at all'
  );
}

/* ================= 4. Quiet: pill detection ================= */

function pillFor(href, { counts = {}, texts = [], clock = null, probe = null, furniture = false } = {}) {
  // `furniture: true` puts every matched control inside a <nav>, the way a
  // site's own dropdown toggles and filter checkboxes actually sit.
  const control = furniture
    ? { getAttribute: () => '', closest: (selector) => (/nav/.test(selector) ? { tagName: 'NAV' } : null) }
    : { getAttribute: () => '', closest: () => null };
  const window = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
  };
  const context = {
    window,
    location: { href, pathname: '/', search: '' },
    document: {
      fonts: null,
      body: {},
      querySelectorAll(selector) {
        return new Array(counts[selector] || 0).fill(control);
      },
      createTreeWalker() {
        if (probe) probe.walks += 1;
        let index = 0;
        return { nextNode: () => (index < texts.length ? { nodeValue: texts[index++] } : null) };
      },
    },
    NodeFilter: { SHOW_TEXT: 4 },
    chrome: {
      storage: {
        session: { get() { /* suspend build: detection only */ } },
        onChanged: { addListener() {} },
      },
      runtime: { onMessage: { addListener() {} } },
    },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    Date: clock ? { now: () => clock.now } : Date,
    console,
  };
  window.window = window;
  vm.runInNewContext(pillSource, context, { filename: 'test-pill.js' });
  return window.__smeshPill;
}

const SEL_CHOICE = 'input[type=radio], input[type=checkbox], [role="radio"]';
const SEL_LIST = 'select, [role="listbox"], [role="combobox"]';
const SEL_AREA = 'textarea';
const SEL_TEXT = 'input[type=text], input[type=number], input:not([type])';

{
  const page = 'https://example.com/anything';

  // THE false-positive case. Almost every site on the web has a search box; the
  // pill appearing on all of them is how a helpful feature becomes adware.
  assert.equal(
    pillFor(page, { counts: { [SEL_TEXT]: 1 }, texts: ['Добро пожаловать на наш сайт'] })
      .shouldShowPill(),
    false,
    'a lone search box must not put a pill on the page'
  );
  assert.equal(
    pillFor(page, { texts: ['Читайте последние новости и подписывайтесь на рассылку.'] })
      .shouldShowPill(),
    false,
    'ordinary prose must not put a pill on the page'
  );

  // A real quiz: several choice controls.
  assert.equal(
    pillFor(page, { counts: { [SEL_CHOICE]: 4 } }).shouldShowPill(),
    true,
    'a multiple-choice form is exactly what this feature is for'
  );
  // A printed exercise with no form at all is still worth answering.
  assert.equal(
    pillFor(page, {
      texts: [
        'Сколько будет 17 умножить на 24?',
        'Почему вода расширяется при замерзании?',
      ],
    }).shouldShowPill(),
    true,
    'a page of questions with no form must still offer a solve'
  );
  // One question mark is not a quiz; two plus a question word is.
  assert.equal(
    pillFor(page, { texts: ['Как дела, дорогой читатель?'] }).shouldShowPill(),
    false,
    'a single rhetorical question must not trigger the pill'
  );
  // A free-text answer box next to a question.
  assert.equal(
    pillFor(page, {
      counts: { [SEL_TEXT]: 1 },
      texts: ['What is 17 multiplied by 24?'],
    }).shouldShowPill(),
    true,
    'the basic one-question/one-input page must show the solve pill'
  );
  assert.equal(
    pillFor(page, {
      counts: { [SEL_AREA]: 1 },
      texts: ['Задание 3. Напишите короткое эссе о своём городе.'],
    }).shouldShowPill(),
    true
  );
  assert.equal(
    pillFor(page, { counts: { [SEL_LIST]: 1 }, texts: ['Выберите правильный вариант из списка ниже'] })
      .shouldShowPill(),
    true
  );

  // ---- the three false positives found on a real ru.wikipedia.org article ----

  // (a) A «?» ANYWHERE used to count. Every wiki page carries URLs with query
  //     strings in its text, which read as two questions and showed the pill on
  //     every encyclopedia article.
  assert.equal(
    pillFor(page, {
      texts: [
        'https://ru.wikipedia.org/w/index.php?title=Фотосинтез&oldid=154421755',
        '<img src="https://ru.wikipedia.org/wiki/Special:CentralAutoLogin/start?useformat=desktop">',
      ],
    }).shouldShowPill(),
    false,
    'a URL query string is not a question'
  );
  // (b) Unanchored Russian word matching: «Несколько» contains «сколько»,
  //     «задача которых» contains «задач», «сравнительно» contains «сравните».
  assert.equal(
    pillFor(page, {
      texts: [
        'Несколько позже, независимо от архей и многократно в ходе эволюции.',
        ', задача которых заключается в поглощении света тех длин волн',
        'Эффективность бесхлорофилльного фотосинтеза сравнительно невелика.',
      ],
    }).shouldShowPill(),
    false,
    'a task word must be anchored to the start of a line, not matched mid-prose'
  );
  // ...while a genuinely task-shaped line, ordinal and all, still counts.
  assert.equal(
    pillFor(page, { texts: ['4. Решите уравнение 2x + 5 = 13 и запишите ответ.'] }).shouldShowPill(),
    true,
    'a printed exercise with no question mark must still offer a solve'
  );
  // (c) Site chrome full of checkboxes. ru.wikipedia.org ships eight visible
  //     ones — the menu, appearance, language and contents dropdown toggles.
  const wikiChrome = pillFor(page, {
    counts: { [SEL_CHOICE]: 8 },
    texts: ['Материал из Википедии — свободной энциклопедии'],
    furniture: true,
  });
  assert.equal(wikiChrome.shouldShowPill(), false,
    'dropdown/menu toggles are site chrome, not a multiple-choice question');
  // The differential: the identical control count OUTSIDE site chrome is a quiz.
  assert.equal(
    pillFor(page, {
      counts: { [SEL_CHOICE]: 8 },
      texts: ['Материал из Википедии — свободной энциклопедии'],
    }).shouldShowPill(),
    true,
    'the exclusion must be about WHERE the controls are, not how many'
  );

  // The explicit toolbar request outranks the heuristic.
  const missed = pillFor(page, { texts: ['Ничего похожего на задание'] });
  assert.equal(missed.shouldShowPill(), false);
  missed.show();
  assert.equal(missed.shouldShowPill(), true,
    'the popup must be able to force the pill onto a page the score missed');
}

{
  // Polling cost. On a granted all-sites install this score runs on every tab
  // forever, so a page that has already been judged a non-quiz several times
  // must stop being re-walked every couple of seconds.
  const clock = { now: 1_000_000 };
  const probe = { walks: 0 };
  const pill = pillFor('https://news.example/article', {
    texts: ['Обычная новостная статья без заданий'],
    clock,
    probe,
  });
  const scoreAt = (ms) => { clock.now += ms; return pill.shouldShowPill(); };

  for (let i = 0; i < 10; i++) assert.equal(scoreAt(3000), false);
  const settled = probe.walks;
  // Well past the fast TTL, still inside the idle one.
  for (let i = 0; i < 3; i++) scoreAt(1000);
  assert.equal(probe.walks, settled,
    'a page judged a non-quiz repeatedly must back off instead of re-walking every few seconds');
  // The idle window still expires, so an SPA that loads its quiz late is seen.
  scoreAt(20000);
  assert.ok(probe.walks > settled, 'the backoff must be a delay, not a permanent give-up');
}

{
  // On Mesh the generic score is never consulted — the documented МЭШ detection
  // is the only thing that decides, exactly as before.
  const meshPill = pillFor('https://school.mos.ru/dt/fundamental/maths/go?subcategory_id=1', {
    counts: { [SEL_CHOICE]: 0 },
  });
  assert.equal(meshPill.isMesh, true);
  // No web control counts at all, yet the Mesh route detection still shows it.
  assert.equal(meshPill.looksLikeWebQuestionPage(), false);
}

/* ================= 4b. Quiet: the scrape ================= */

{
  const readerSource = sectionOf(
    scraper,
    'const WEB_SKIP_TAGS = new Set([',
    '/**\n * Everything the worker sends to the model for a generic page.'
  );
  const context = {
    normalize: (value) => String(value || '').replace(/\s+/g, ' ').trim(),
    MAX_WEB_NODES: 20000,
    MAX_WEB_STYLE_READS: 800,
    MAX_WEB_DEPTH: 40,
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
    Set, Array, String, Number, Math, JSON,
  };
  vm.createContext(context);
  vm.runInContext(
    `${readerSource}\nthis.__blockText = webBlockText;\nthis.__furniture = webLooksLikeFurniture;`,
    context
  );

  const el = (tagName, children = [], attributes = {}) => ({
    nodeType: 1,
    tagName,
    childNodes: children,
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    hidden: false,
  });
  const text = (value) => ({ nodeType: 3, nodeValue: value });

  const page = el('BODY', [
    el('NAV', [text('Главная Каталог Контакты')]),
    el('DIV', [text('Согласие на использование cookie')], { class: 'cookie-banner' }),
    el('DIV', [
      el('H1', [text('Тест по биологии')]),
      el('P', [text('Вопрос 1. Что такое фотосинтез?')]),
      el('SCRIPT', [text('window.tracker = 1')]),
      el('P', [text('Ответ: '), el('INPUT', [], { type: 'text' })]),
    ], { class: 'quiz-body' }),
    el('FOOTER', [text('© 2026 Все права защищены')]),
    el('DIV', [text('Читайте также: 10 фактов о воде')], { class: 'related-posts' }),
  ]);

  const out = context.__blockText(page, 4000, new Set());
  assert.ok(out.includes('Тест по биологии') && out.includes('Что такое фотосинтез?'),
    'the actual question must survive the scrape');
  assert.ok(out.includes('[___]'),
    'an answer box must be marked inline so a fill-in-the-blank reads correctly');
  for (const noise of ['Главная Каталог', 'cookie', 'Все права защищены', 'Читайте также', 'tracker']) {
    assert.ok(!out.includes(noise), `site furniture must not be paid for: ${noise}`);
  }

  // ...unless the "furniture" actually contains the question. A class name must
  // never outrank a real answer control.
  const widget = el('DIV', [el('P', [text('Вопрос 2. Столица Франции?')])], { class: 'sidebar-box' });
  assert.equal(context.__furniture(widget), true, 'the class name alone reads as furniture');
  const guarded = context.__blockText(el('BODY', [widget]), 4000, new Set([widget]));
  assert.ok(guarded.includes('Столица Франции?'),
    'a protected subtree must survive the furniture heuristic');

  // Tokenisation, not substring matching: `subheader` is one word and stays.
  assert.equal(context.__furniture(el('DIV', [], { class: 'subheader-title' })), false);
  assert.equal(context.__furniture(el('DIV', [], { class: 'page-header' })), true);
  assert.equal(context.__furniture(el('DIV', [], { role: 'navigation' })), true);
  assert.equal(context.__furniture(el('SECTION', [], { class: 'question-list' })), false);

  // The budget is a hard cap: an arbitrary site can be arbitrarily large, and
  // every character of it is paid for on the model.
  const huge = el('BODY', Array.from({ length: 400 }, (_, i) =>
    el('P', [text(`Абзац номер ${i} ${'x'.repeat(200)}`)])));
  assert.ok(context.__blockText(huge, 1000, new Set()).length <= 1000,
    'the scrape must stay inside its character budget');

  // REPEATED lines must survive. A true/false quiz is five «Да» and five «Нет»;
  // collapsing them to one of each (to squeeze out echoed navigation) silently
  // shifts every option after the first and produces wrong answers.
  const trueFalse = el('BODY', [
    el('P', [text('1. Вода кипит при 100 °C')]), el('LABEL', [text('Да')]), el('LABEL', [text('Нет')]),
    el('P', [text('2. Солнце — планета')]), el('LABEL', [text('Да')]), el('LABEL', [text('Нет')]),
    el('P', [text('3. Кит — млекопитающее')]), el('LABEL', [text('Да')]), el('LABEL', [text('Нет')]),
  ]);
  const answers = context.__blockText(trueFalse, 4000, new Set());
  assert.equal((answers.match(/(^|\n)Да(\n|$)/g) || []).length, 3,
    'every repeated option must reach the model, once per question');
}

{
  // The whole reader, executed: root selection → furniture pruning → transcript
  // → control inventory. This is what actually reaches the model, so it is worth
  // asserting end to end rather than piece by piece.
  const readerSource = sectionOf(
    scraper,
    'const MAX_WEB_UNITS = 60;',
    '/* ---------- single-pass fill for generic pages ---------- */'
  );

  const el = (tagName, children = [], attributes = {}) => {
    const node = {
      nodeType: 1,
      tagName,
      childNodes: children,
      getAttribute: (name) => (name in attributes ? attributes[name] : null),
      hidden: false,
      parentElement: null,
      get textContent() {
        return children.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(' ');
      },
    };
    for (const child of children) if (child.nodeType === 1) child.parentElement = node;
    return node;
  };
  const text = (value) => ({ nodeType: 3, nodeValue: value });

  const optionA = el('LABEL', [text('Москва')]);
  const optionB = el('LABEL', [text('Париж')]);
  const radioA = el('INPUT', [], { type: 'radio' });
  const radioB = el('INPUT', [], { type: 'radio' });
  const quiz = el('DIV', [
    el('H2', [text('Столица России?')]),
    el('DIV', [radioA, optionA]),
    el('DIV', [radioB, optionB]),
  ], { class: 'quiz' });
  const body = el('BODY', [
    el('NAV', [text('Меню Каталог')]),
    quiz,
    el('FOOTER', [text('© 2026')]),
  ]);

  const labels = new Map([[radioA, 'Москва'], [radioB, 'Париж']]);
  const context = {
    document: { body, title: 'Викторина по географии', querySelectorAll: () => [] },
    location: { href: 'https://quiz.example/geo/capitals?session=abc' },
    URL,
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
    normalize: (value) => String(value || '').replace(/\s+/g, ' ').trim(),
    collectUnits: () => [{ type: 'radio', inputs: [radioA, radioB], anchor: radioA, number: null }],
    collectInteractiveUnits: () => [],
    collectQuestionMarkers: () => [],
    controlLabelText: (input) => labels.get(input) || '',
    fieldLabel: () => '',
    precedingFieldText: () => '',
    domOrderCompare: () => 0,
    commonAncestor: () => quiz,
    Set, Map, Array, String, Number, Math, JSON, Boolean,
  };
  vm.createContext(context);
  vm.runInContext(`${readerSource}\nthis.__read = readWebPageContent;`, context);

  const read = context.__read(4000);
  assert.equal(read.unitCount, 1, 'the radio group must be inventoried as one answerable unit');

  // Site chrome must never become an answer box. Measured on ru.wikipedia.org:
  // eight visible menu-toggle checkboxes, which collectUnits() cannot tell from
  // a multiple-choice question — an autofill would have flipped the site's own
  // menus and the model would have been asked to "answer" them.
  {
    const menuToggle = el('INPUT', [], { type: 'checkbox' });
    const chrome = el('HEADER', [el('NAV', [el('DIV', [menuToggle], { class: 'dropdown' })])]);
    const withChrome = el('BODY', [chrome, quiz]);
    for (const child of withChrome.childNodes) child.parentElement = withChrome;
    context.document.body = withChrome;
    context.collectUnits = () => [
      { type: 'checkbox', inputs: [menuToggle], anchor: menuToggle, number: null },
      { type: 'radio', inputs: [radioA, radioB], anchor: radioA, number: null },
    ];
    const guarded = context.__read(4000);
    assert.equal(guarded.unitCount, 1,
      'a checkbox inside the site header is a menu toggle, not an answer box');
    assert.ok(guarded.text.includes('№1 · один вариант из списка'),
      'the real question must keep number 1 after the chrome control is dropped');
    // Restore for anything after this block.
    context.document.body = body;
    context.collectUnits = () => [{ type: 'radio', inputs: [radioA, radioB], anchor: radioA, number: null }];
  }
  // bodyChars counts only the transcript. The worker's "can I read this page at
  // all?" guard runs on it, so it must NOT include the always-present
  // title/URL header — otherwise the guard can never fire.
  assert.ok(read.bodyChars > 0 && read.bodyChars < read.chars,
    'bodyChars must measure the transcript alone');
  assert.ok(!String(read.bodyChars).includes('NaN'));
  assert.ok(read.text.includes('Заголовок страницы: Викторина по географии'));
  assert.ok(read.text.includes('Адрес: https://quiz.example/geo/capitals'));
  assert.ok(!read.text.includes('session=abc'),
    'the query string must not be sent — it can carry session material and adds nothing');
  assert.ok(read.text.includes('Столица России?'), 'the question must survive');
  assert.ok(!read.text.includes('Меню Каталог') && !read.text.includes('© 2026'),
    'site furniture must not reach the model');
  assert.ok(
    read.text.includes('=== Поля для ответа на странице ===') &&
    read.text.includes('№1 · один вариант из списка · варианты: 1) Москва  2) Париж'),
    'the model must be told the exact number, kind and options of every answer box'
  );

  // A single answer field often follows a long reading-comprehension passage.
  // Root selection must climb far enough to include that stem instead of
  // returning the input element itself and sending only an empty field inventory.
  {
    const longInput = el('INPUT', [], { type: 'text' });
    const longStem = `Read the passage and answer the final question. ${'context '.repeat(230)}What caused the change?`;
    const longQuiz = el('SECTION', [el('P', [text(longStem)]), longInput], { class: 'exercise' });
    context.document.body = el('BODY', [longQuiz]);
    context.collectUnits = () => [
      { type: 'text', inputs: [longInput], anchor: longInput, number: null },
    ];
    context.commonAncestor = (anchors) => anchors[0] || null;
    const longRead = context.__read(4000);
    assert.ok(longRead.bodyChars > 1500 && longRead.text.includes('What caused the change?'),
      'a long stem immediately above one answer box must reach the model');
  }
}

{
  // Numbering. The model is shown these ids and the fill resolves the SAME ids,
  // so a half-numbered page must collapse to plain 1..N rather than mixing the
  // two — mixing is how an answer lands on its neighbour's control.
  const idsSource = sectionOf(scraper, 'function webUnitIds(units) {', '\nconst WEB_UNIT_KIND_TEXT');
  const context = { Set, String };
  vm.createContext(context);
  vm.runInContext(`${idsSource}\nthis.__ids = webUnitIds;`, context);
  // Values cross a vm realm boundary, so copy them into host objects before
  // comparing structurally.
  const idsFor = (numbers) => {
    const result = context.__ids(numbers.map((number) => ({ unit: { number } })));
    return { ids: [...result.ids], numbered: result.numbered };
  };

  assert.deepEqual(idsFor([1, 2, 3]), { ids: ['1', '2', '3'], numbered: true });
  assert.deepEqual(idsFor([5, 7]), { ids: ['5', '7'], numbered: true },
    'on-screen numbers are trusted verbatim, gaps and all');
  assert.deepEqual(
    idsFor([1, null, 3]),
    { ids: ['1', '2', '3'], numbered: false },
    'a partially numbered page must fall back to pure position'
  );
  assert.deepEqual(
    idsFor([2, 2]),
    { ids: ['1', '2'], numbered: false },
    'repeated on-screen numbers are ambiguous and must not be trusted'
  );
  assert.deepEqual(idsFor([]), { ids: [], numbered: false });
}

{
  // The fill must apply the same absolute-trust rule the Mesh filler does: a
  // numbered control may only receive the answer carrying its own number.
  const fillSource = sectionOf(scraper, 'async function fillWebAnswers(', '\nwindow.__smeshHasVisualMedia');
  assert.ok(
    fillSource.includes('(!numbered || ids[index] === String(id))'),
    'a numbered control must never be filled positionally by another question'
  );
  assert.ok(
    fillSource.includes('if (!interactiveGuardCurrent(guard)) return { ...summary, stale: true };'),
    'the fill must re-check the page signature before every write, like the Mesh one'
  );
  assert.ok(
    !/submit|form\.submit|requestSubmit/.test(fillSource),
    'the generic fill must never submit a form'
  );
}

/* ================= 5. Worker wiring ================= */

{
  // The generic path must not be able to reach the pagination machinery: on an
  // arbitrary site a "next" control can be a checkout step.
  const webSolve = sectionOf(worker, 'async function webSolveOnePage(', '\n/**\n * Keep the generic pill');
  for (const forbidden of ['testNextPage', 'advancePillPage', 'pillSolveAllPages']) {
    assert.ok(!webSolve.includes(forbidden),
      `the generic solve must never touch ${forbidden}`);
  }
  assert.ok(webSolve.includes('withMatchingTestCapture(capture, readTestCaptureContext'),
    'the generic solve must revalidate its capture before mutating the page');

  // The capture reader picks the mode from the tab URL and gates the web mode on
  // a real permission grant.
  const reader = sectionOf(worker, 'async function readTestCaptureContext(tabId) {', '\n// Pagination is deliberately');
  assert.ok(reader.includes('if (!isWebSolvableUrl(before?.url)) requireMeshTestTab(before);'),
    'an ineligible tab must still get the Mesh guidance message');
  assert.ok(reader.includes('await hasWebSolvePermission(before.url)'),
    'a generic capture must require the optional host permission');
  const webCapturePage = sectionOf(worker, 'async function capturePageForWeb(', 'async function solveWebPage(');
  assert.ok(
    webCapturePage.includes('!unitCount && bodyChars < MIN_WEB_PAGE_CHARS'),
    'the unreadable-page guard must measure the transcript, not the prompt header ' +
    '(which is always present and would make the guard unreachable)'
  );
  assert.ok(reader.includes('isMeshTestTab(before) ?'),
    'a Mesh tab must always produce a Mesh capture');

  // Registration follows the grant in both directions.
  const registration = sectionOf(worker, 'async function syncWebPillRegistration() {', '\ntry {\n  chrome.permissions.onAdded');
  assert.ok(registration.includes('unregisterContentScripts'),
    'revoking every grant must unregister the pill');
  assert.ok(registration.includes('excludeMatches: webPillExcludeMatches()'),
    'an all-sites grant must still exclude Mesh and our own hosts');
  assert.ok(
    worker.includes('chrome.permissions.onRemoved.addListener(() => { void syncWebPillRegistration(); });'),
    'a revoked permission must immediately unregister the pill'
  );
}

console.log('web-solve regression passed');

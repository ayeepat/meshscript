/**
 * Answer-reuse regression — the extension must not buy the same completion
 * twice.
 *
 *  1. LESSONS. Reopening a homework row that was already solved on this device
 *     replays the stored conversation instead of calling the provider. The
 *     identity that makes that safe is lib/lesson-key.js: scan-independent
 *     (rowToken is minted fresh every scan), student-scoped, and sensitive to
 *     the task text so a re-worded assignment is solved again.
 *  2. TESTS. A test page whose capture signature is already cached is filled
 *     from that cache. The signature covers the questions AND their order, so a
 *     re-rolled МЭШ variant misses and is solved normally; and a text-only
 *     cached answer is never served to a request that can show the model the
 *     page image.
 *
 * Reuse must never cost the student something they asked for, so this file also
 * pins the three ways it could:
 *  - a file just attached to a row is an explicit ask to solve WITH it, and a
 *    stored answer predates it, so a launch carrying files never replays;
 *  - two children on one device get separate cache slots on both paths;
 *  - a lookup is a read, not a whole-history rewrite.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const store = {};
const sessionStore = {};

function readStore(area, keys) {
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, area[key]]));
  if (typeof keys === 'string') return { [keys]: area[keys] };
  if (keys && typeof keys === 'object') {
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, area[key] ?? fallback]));
  }
  return { ...area };
}

function removeStore(area, keys) {
  for (const key of Array.isArray(keys) ? keys : [keys]) delete area[key];
}

let failNextLocalGet = false;
let localWrites = 0;

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (failNextLocalGet) { failNextLocalGet = false; throw new Error('simulated storage failure'); }
        return readStore(store, keys);
      },
      async set(data) { localWrites += 1; Object.assign(store, data); },
      async remove(keys) { removeStore(store, keys); }
    },
    session: {
      async get(keys) { return readStore(sessionStore, keys); },
      async set(data) { Object.assign(sessionStore, data); },
      async remove(keys) { removeStore(sessionStore, keys); }
    }
  }
};

const { lessonKeyFor } = await import('../src/lib/lesson-key.js');
const {
  TEST_ANSWER_CACHE_KEY,
  patchCachedTestAnswer,
  readCachedTestAnswers,
  testAnswerCacheKey,
  writeCachedTestAnswers: writeCompletePage,
} = await import('../src/lib/test-answer-cache.js');
// These fixtures represent complete provider responses with a known DOM inventory.
const writeCachedTestAnswers = (capture, questions, options = {}) => writeCompletePage(capture, questions, {
  raw: JSON.stringify({ answers: questions.map((q) => ({ n: q.index, a: q.answer })) }),
  expectedIds: questions.map((q) => String(q.index)),
  ...options,
});
const { appendSolveTurn, cleanupLocalData, findLessonSession } = await import('../src/lib/history.js');

const source = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const workerSource = source('../src/background/service-worker.js');
const dashboardSource = source('../src/dashboard/dashboard.js');
const historySource = source('../src/lib/history.js');

function sourceSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section missing: ${startMarker}`);
  return text.slice(start, end);
}

/* ---------------- 1. Lesson identity survives a new scan ---------------- */
{
  const row = {
    principal: 'student-a',
    day: 'Понедельник, 8 сентября',
    subject: 'Алгебра',
    task: 'Упр. 25, стр. 14',
    homeworkId: '901',
    homeworkItemId: '55501',
  };
  // rowToken is deliberately not an input: it is a fresh UUID per scan, so a
  // key built from it could never recognise the same lesson in a later tab.
  assert.equal(lessonKeyFor(row), lessonKeyFor({ ...row }),
    'the same homework row must produce the same key in a later scan');
  assert.equal(lessonKeyFor(row), lessonKeyFor({ ...row, task: '  упр. 25,\n стр. 14 ' }),
    'whitespace and case in the task text must not split one lesson into two');

  assert.notEqual(lessonKeyFor(row), lessonKeyFor({ ...row, task: 'Упр. 26, стр. 14' }),
    'a re-worded assignment must be solved again, not answered from the old text');
  assert.notEqual(lessonKeyFor(row), lessonKeyFor({ ...row, principal: 'student-b' }),
    'a second child on this device must never replay the first one session');
  assert.notEqual(lessonKeyFor(row), lessonKeyFor({ ...row, day: 'Вторник, 9 сентября' }),
    'the same exercise set on two days is two lessons');
  assert.notEqual(lessonKeyFor(row), lessonKeyFor({ ...row, homeworkItemId: '55502' }),
    'two Mesh rows must not share one stored answer');

  assert.equal(lessonKeyFor({ ...row, subject: '' }), '',
    'a row with no subject carries too little identity to be reused');
  assert.equal(lessonKeyFor({ subject: 'Алгебра', day: 'Понедельник' }), '',
    'subject + day alone would merge every assignment of one lesson');
}

/* ---------------- 2. History stores and finds the lesson ---------------- */
{
  const lessonKey = lessonKeyFor({
    principal: 'student-a', day: 'Понедельник', subject: 'Алгебра',
    task: 'Упр. 25', homeworkItemId: '55501',
  });
  assert.ok(lessonKey, 'fixture must produce a usable key');

  assert.equal(await findLessonSession(lessonKey), null, 'nothing solved yet');
  assert.equal(await findLessonSession(''), null, 'an empty key must never match');

  const first = await appendSolveTurn({
    subject: 'Алгебра', taskText: 'Упр. 25',
    userContent: 'Упр. 25', assistantContent: 'x = 4', lessonKey,
  });
  const found = await findLessonSession(lessonKey);
  assert.equal(found.sessionId, first.sessionId, 'the stored session must be findable by its lesson key');
  assert.deepEqual(found.messages, [
    { role: 'user', content: 'Упр. 25' },
    { role: 'assistant', content: 'x = 4' },
  ], 'the whole conversation is replayed, in order');

  // A follow-up continues the SAME session, exactly as an unbroken tab would.
  await appendSolveTurn({
    sessionId: first.sessionId, subject: 'Алгебра', taskText: 'Упр. 25',
    userContent: 'объясни второй шаг', assistantContent: 'делим обе части на 3', lessonKey,
  });
  const withFollowup = await findLessonSession(lessonKey);
  assert.equal(withFollowup.sessionId, first.sessionId);
  assert.equal(withFollowup.messages.length, 4, 'follow-ups are part of the replayed lesson');

  // «Решить заново» starts a new session under the same key; the newest wins.
  const second = await appendSolveTurn({
    subject: 'Алгебра', taskText: 'Упр. 25',
    userContent: 'Упр. 25', assistantContent: 'x = 4 (заново)', lessonKey,
  });
  assert.notEqual(second.sessionId, first.sessionId);
  const newest = await findLessonSession(lessonKey);
  assert.equal(newest.sessionId, second.sessionId,
    'a deliberate re-solve must supersede the answer it replaced');

  // A different lesson never borrows this one.
  assert.equal(await findLessonSession(lessonKeyFor({
    principal: 'student-a', day: 'Понедельник', subject: 'Алгебра',
    task: 'Упр. 26', homeworkItemId: '55501',
  })), null);

  // Sessions written by older builds carry no key and stay invisible to reuse.
  store.meshHistory.sessions.push({
    id: 'legacy', subject: 'Алгебра', task_text: 'Упр. 25',
    created_at: new Date().toISOString(),
  });
  store.meshHistory.messages.legacy = [
    { id: 'm1', session_id: 'legacy', role: 'assistant', content: 'старый ответ', created_at: new Date().toISOString() },
  ];
  assert.equal((await findLessonSession(lessonKey)).sessionId, second.sessionId);

  // Looking a lesson up is a READ. Routing it through the mutation queue
  // rewrote the whole history object and minted a new generation on every
  // dashboard lesson open, which both churns the store and invalidates a
  // concurrent writer sitting in its generation recheck.
  localWrites = 0;
  await findLessonSession(lessonKey);
  await findLessonSession('l1.nothing-here');
  assert.equal(localWrites, 0, 'a lesson lookup must not write the history store');

  // An expired lesson is pruned on read: reuse never outlives the history the
  // student can actually see in Settings.
  const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  for (const session of store.meshHistory.sessions) session.created_at = stale;
  assert.equal(await findLessonSession(lessonKey), null, 'a lesson older than the 7-day TTL is gone');
}

/* ---------------- 3. Test pages: identity and reuse rules ---------------- */
const capture = (...signatures) => captureAs(null, ...signatures);

// scraper.js currentPrincipalIdentity(): ['v2', account, subject, student,
// state, session]. `session` hashes the xAPI registration and is re-minted per
// attempt; everything before it identifies the account/child.
const principalOf = (account, student, session) =>
  JSON.stringify(['v2', account, '', student, 'selected', session]);

function captureAs(principal, ...signatures) {
  return {
    tabId: 7,
    url: 'https://uchebnik.mos.ru/exam/challenge/1',
    documentId: 'doc-0',
    signature: signatures.map((s, i) => `${i}:${s}`).join('||'),
    documents: signatures.map((signature, frameId) => ({
      frameId, signature, ...(principal == null ? {} : { principal })
    })),
  };
}

{
  // school.mos.ru/<course>/cwork: frame 0 is the МЭШ shell, frame 1 the test.
  const page = capture('shell:120', 'questions:900');
  assert.ok(testAnswerCacheKey(page), 'a fully captured page has a reuse key');
  assert.equal(testAnswerCacheKey(page), testAnswerCacheKey(capture('shell:120', 'questions:900')),
    'the same questions in the same order key the same page');

  // THE case this cache exists for: МЭШ mints a fresh xAPI launch per attempt,
  // and the shell's signature hashes the player iframe's src. Reopening the
  // same test must still hit, so the shell frame is not part of the key.
  assert.equal(testAnswerCacheKey(page), testAnswerCacheKey(capture('shell:RELAUNCHED:131', 'questions:900')),
    'a new launch id in the shell frame must not defeat the reuse key');

  // pageSignature() hashes the question text and control semantics, so a
  // different МЭШ variant or a reshuffled order arrives here as a different
  // signature — and must not read the previous attempt's answers.
  assert.notEqual(testAnswerCacheKey(page), testAnswerCacheKey(capture('shell:120', 'variant-b:915')));
  assert.notEqual(testAnswerCacheKey(page), testAnswerCacheKey(capture('shell:120', 'questions:900', 'more:400')));

  // uchebnik.mos.ru/exam/challenge and the inline /dt task views: the test IS
  // the top frame, so there it is the top frame that identifies the page.
  assert.ok(testAnswerCacheKey(capture('questions:900')));
  assert.notEqual(testAnswerCacheKey(capture('questions:900')), testAnswerCacheKey(capture('other:900')));
  // The same player opened standalone and embedded therefore shares one slot.
  // That is the intent, not a collision: an identical page signature means
  // identical question text, controls and resources — the same test.
  assert.equal(testAnswerCacheKey(capture('questions:900')), testAnswerCacheKey(page));

  // A document whose signature could not be computed (tainted canvas) must not
  // share a slot with anything.
  assert.equal(testAnswerCacheKey(capture('shell:120', '')), '');
  assert.equal(testAnswerCacheKey(capture('')), '');
  assert.equal(testAnswerCacheKey({ documents: [] }), '');
}

/* ------ 3b. Two children on one device do not share a test slot ------ */
{
  // The lesson key has scoped on the student from the start; this key did not,
  // and on the cwork layout the ONE frame that knows which child is selected is
  // the shell — the frame the signature deliberately drops. So a second child
  // taking the same test read the first one's answers for free.
  const childA = captureAs(principalOf('acct-A', 'stud-A', 'reg-111'), 'shell:reg-111', 'questions:900');
  const childB = captureAs(principalOf('acct-B', 'stud-B', 'reg-222'), 'shell:reg-222', 'questions:900');
  assert.notEqual(testAnswerCacheKey(childA), testAnswerCacheKey(childB),
    'a second child on this device must not fill the first one answers');

  // …without giving up the case the cache exists for. МЭШ re-mints the xAPI
  // registration per attempt, and the principal carries it in its trailing
  // session field, so ONLY the stable account half may reach the key.
  const childAgain = captureAs(principalOf('acct-A', 'stud-A', 'reg-999'), 'shell:reg-999', 'questions:900');
  assert.equal(testAnswerCacheKey(childA), testAnswerCacheKey(childAgain),
    'a new launch id for the same child must still hit');

  // Same child, re-rolled variant: still a miss.
  assert.notEqual(
    testAnswerCacheKey(childA),
    testAnswerCacheKey(captureAs(principalOf('acct-A', 'stud-A', 'reg-111'), 'shell:reg-111', 'variant-b:915')),
    'a different variant is solved fresh whoever is taking it'
  );

  // A page that exposes no account signal at all, and a principal this build
  // cannot parse, both still key — they are simply no more separated than
  // before. Failing closed here would break reuse on every such page.
  assert.ok(testAnswerCacheKey(captureAs(principalOf('', '', 'reg-1'), 'questions:900')),
    'an unidentifiable page still keys, it just carries no account scope');
  assert.ok(testAnswerCacheKey(captureAs('not-json', 'questions:900')),
    'an unparseable principal must not break the cache');
  assert.notEqual(
    testAnswerCacheKey(captureAs(principalOf('acct-A', 'stud-A', 'r'), 'questions:900')),
    testAnswerCacheKey(captureAs('not-json', 'questions:900')),
    'a known child and an unreadable one are not the same slot'
  );
}

{
  const page = capture('sig-a:10', 'sig-b:20');
  const questions = [
    { index: 1, text: '', answer: '42' },
    { index: '2', text: '', answer: 'Пушкин', choice: 'б' },
    { index: 3, text: '', answer: 'x=1; y=2', parts: [{ label: 'x', value: '1' }, { label: 'y', value: '2' }] },
  ];
  assert.equal(await readCachedTestAnswers(page), null, 'nothing solved yet');

  assert.equal(await writeCachedTestAnswers(page, questions), true);
  const reused = await readCachedTestAnswers(page);
  assert.deepEqual(reused.questions, questions, 'every field the form fill needs survives the round trip');
  assert.equal(reused.image, false);

  // A different page (one changed question) is a miss, not a wrong fill.
  assert.equal(await readCachedTestAnswers(capture('sig-a:10', 'sig-CHANGED:20')), null);

  // The screenshot route exists for pages the DOM text cannot carry, so it must
  // never be answered from a text-only solve.
  assert.equal(await readCachedTestAnswers(page, { image: true }), null);
  await writeCachedTestAnswers(page, questions, { image: true });
  assert.equal((await readCachedTestAnswers(page, { image: true })).image, true);
  assert.ok(await readCachedTestAnswers(page), 'an image-backed answer still serves a text-only request');

  // «перерешать» folds its correction back in, so the next visit fills the
  // answer the student kept rather than the one they rejected.
  assert.equal(await patchCachedTestAnswer(page, '2', { answer: 'Лермонтов' }), true);
  const patched = await readCachedTestAnswers(page);
  assert.equal(patched.questions[1].answer, 'Лермонтов');
  assert.equal(patched.questions[1].choice, undefined, 'a correction without option indices clears the rejected hint');
  assert.equal(patched.questions[0].answer, '42', 'other questions are untouched');
  assert.equal(await patchCachedTestAnswer(page, '99', { answer: 'нет такого' }), false,
    'an unknown question number must not drop the rest of the page');

  // The «перерешать» above ran on a panel with no screenshot (the pill can never
  // take one), so the entry must stop claiming to be image-backed. Otherwise a
  // later screenshot request would be served an answer produced from text alone
  // — exactly what the image guard exists to prevent, one answer at a time.
  assert.equal(await readCachedTestAnswers(page, { image: true }), null,
    'a text-only correction downgrades the entry it patched');
  await writeCachedTestAnswers(page, questions, { image: true });
  assert.equal(await patchCachedTestAnswer(page, '2', { answer: 'Лермонтов', image: true }), true);
  assert.equal((await readCachedTestAnswers(page, { image: true })).image, true,
    'a correction that DID see the screenshot keeps the entry image-backed');

  // A half-written or hand-edited entry fails closed rather than reaching the
  // student page.
  store[TEST_ANSWER_CACHE_KEY][testAnswerCacheKey(page)].v.questions = [{ index: 1 }];
  assert.equal(await readCachedTestAnswers(page), null);

  // Expiry and a storage failure both degrade to "solve it again".
  await writeCachedTestAnswers(page, questions);
  store[TEST_ANSWER_CACHE_KEY][testAnswerCacheKey(page)].at =
    Date.now() - 8 * 24 * 60 * 60 * 1000;
  assert.equal(await readCachedTestAnswers(page), null);
  await writeCachedTestAnswers(page, questions);
  failNextLocalGet = true;
  assert.equal(await readCachedTestAnswers(page), null);

  // The retention sweep owns the cache too — an abandoned install must not keep
  // solved test pages forever.
  store[TEST_ANSWER_CACHE_KEY].stale = { v: { questions, image: false }, at: Date.now() - 8 * 24 * 60 * 60 * 1000 };
  await cleanupLocalData();
  assert.equal(store[TEST_ANSWER_CACHE_KEY]?.stale, undefined, 'stale test pages are swept');
  assert.ok(historySource.includes("'smeshTranscriptCache', TEST_ANSWER_CACHE_KEY"),
    'the settings «Удалить все локальные данные» wipe must include the test cache');
}

/* ---------------- 4. The pill skips the paid call on a hit ---------------- */
{
  const pillSource = sourceSection(
    workerSource,
    'async function pillSolveOnePage(',
    '\n// Poll the page signature'
  );
  const pageCapture = capture('pill-a:33');

  function runPill({ cached, licensed = true, consented = true }) {
    const calls = {
      solveTest: 0, written: [], filled: 0, panel: 0, licence: 0, consent: 0, traced: []
    };
    const context = {
      Error,
      capturedText: 'вопрос 1 …',
      CONSENT_REQUIRED_MESSAGE: 'нет согласия',
      async ensureLicensed() {
        calls.licence += 1;
        if (!licensed) throw new Error('Лицензия не активирована.');
      },
      async hasConsent() { calls.consent += 1; return consented; },
      throwIfPillCancelled() {},
      async capturePageForPill() {
        return { pageText: 'вопрос 1 …', capture: pageCapture, hasVisualMedia: false };
      },
      async readTestAnswerIds() { return ['1']; },
      async readCachedTestAnswers() { return cached; },
      async solveTest() {
        calls.solveTest += 1;
        return '{"answers":[{"n":1,"a":"свежий"}]}';
      },
      parseTestAnswers: (raw) => JSON.parse(raw).answers.map((a) => ({ index: a.n, text: '', answer: a.a })),
      async writeCachedTestAnswers(_capture, questions) { calls.written.push(questions); return true; },
      async withMatchingTestCapture(_capture, _read, fn) { return fn(); },
      readTestCaptureContext() {},
      async showAnswersInTab() { calls.panel += 1; },
      async fillAllFrames(_tabId, questions) {
        calls.filled = questions.length;
        return { filled: questions.map((q) => q.index), skipped: [] };
      },
      // Owner-only diagnostics (lib/dev-trace.js). A no-op on every student
      // install; stubbed here so the reuse path can be checked for the trace it
      // must still leave behind — a cache hit that logged nothing would look
      // like "no solve happened" in exactly the log used to debug wrong answers.
      recordDevTrace(trace) { calls.traced.push(trace); return Promise.resolve(true); },
      serializeTestAnswers: (questions) => JSON.stringify({ answers: questions }),
    };
    vm.createContext(context);
    vm.runInContext(`${pillSource}\nvar __run = pillSolveOnePage(7, 'deepseek', null);`, context);
    return context.__run.then((result) => ({ result, calls }));
  }

  const miss = await runPill({ cached: null });
  assert.equal(miss.calls.solveTest, 1, 'an unseen page is solved for real');
  assert.deepEqual(miss.calls.written, [[{ index: 1, text: '', answer: 'свежий' }]],
    'a fresh solve is remembered before the form is touched');
  assert.equal(miss.result.cached, false);
  assert.equal(miss.calls.filled, 1);

  const cachedPage = { questions: [{ index: 1, text: '', answer: 'из истории' }], image: false };
  const hit = await runPill({ cached: cachedPage });
  assert.equal(hit.calls.solveTest, 0, 'a page already solved must NOT call the provider again');
  assert.deepEqual(hit.calls.written, [], 'a reused page is not rewritten');
  assert.equal(hit.result.cached, true, 'the pill is told so it can label the result honestly');
  assert.equal(hit.calls.panel, 1, 'the answer panel still appears');
  assert.equal(hit.calls.filled, 1, 'the form is still filled');
  assert.equal(hit.result.questions[0].answer, 'из истории');

  // A reused page never calls the model, so the diagnostics log would otherwise
  // have a hole exactly where a stale cache hit hides. The scraped text is
  // recorded either way, which is what makes a wrong cache hit distinguishable
  // from a wrong answer.
  assert.equal(hit.calls.traced.length, 1, 'a reused page must still leave a trace');
  assert.equal(hit.calls.traced[0].kind, 'cache');
  assert.equal(hit.calls.traced[0].cached, true);
  assert.equal(hit.calls.traced[0].pageText, 'вопрос 1 …',
    'the trace must carry the text the cache key was derived from');
  assert.deepEqual(miss.calls.traced, [],
    'a fresh solve is traced inside solveTest, not a second time here');

  // Skipping solveTest must not skip solveTest's gates: filling a test is the
  // licensed action whether or not this page costs a completion.
  assert.equal(hit.calls.licence, 1, 'the licence is still checked on a reused page');
  assert.equal(hit.calls.consent, 1, 'a withdrawn consent is still honoured');
  await assert.rejects(runPill({ cached: cachedPage, licensed: false }), /Лицензия/);
  await assert.rejects(runPill({ cached: cachedPage, consented: false }), /нет согласия/);
}

/* ---------------- 5. The dashboard replays instead of solving ------------ */
{
  const startLessonSource = sourceSection(
    dashboardSource,
    'async function startLesson(chat, { reuse = true } = {}) {',
    '\nasync function activateLesson('
  );

  function runStartLesson({ stored, reuse = true, launchFiles = [] }) {
    const calls = { gdz: 0, sent: 0, rendered: 0, sentFiles: null, lookups: 0 };
    const chat = {
      key: 'k', subject: 'Алгебра', task: 'Упр. 25', lessonKey: 'l1.abc',
      sessionId: null, history: [], started: false, pending: false,
      pendingOwner: null, thinkingOwner: null, restoredCount: 0,
    };
    const context = {
      chat,
      activeKey: 'k',
      initialFiles: launchFiles,
      launchPayload: {},
      Symbol,
      async storedLesson() { calls.lookups += 1; return stored; },
      beginChatOperation(target, owner) { target.pendingOwner = owner; target.pending = true; return true; },
      ownsChatOperation: (target, owner) => target.pendingOwner === owner,
      releaseChatOperation(target, owner) {
        if (target.pendingOwner !== owner) return false;
        target.pendingOwner = null;
        target.pending = false;
        return true;
      },
      stopThinking() {},
      thinkingBubble: () => ({}),
      // The launch owns this row, so any files it carries belong to this chat.
      sameMeshRow: () => true,
      renderChat() { calls.rendered += 1; },
      renderSidebar() {},
      async maybeShowGdz() { calls.gdz += 1; return false; },
      async sendToChat(_chat, _task, files) { calls.sent += 1; calls.sentFiles = files; return true; },
    };
    vm.createContext(context);
    vm.runInContext(`${startLessonSource}\nvar __run = startLesson(chat, { reuse: ${reuse} });`, context);
    return context.__run.then((ok) => ({ ok, chat, calls, leftoverFiles: context.initialFiles }));
  }

  const replayed = await runStartLesson({
    stored: {
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'Упр. 25' }, { role: 'assistant', content: 'x = 4' }],
    },
  });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.calls.sent, 0, 'a lesson already solved must NOT call the provider again');
  assert.equal(replayed.calls.gdz, 0, 'and must not re-run the GDZ lookup either');
  assert.equal(replayed.chat.sessionId, 'sess-1',
    'the replayed chat keeps its session so follow-ups continue the same conversation');
  // Compared as JSON: objects built inside the vm realm have their own
  // Object.prototype, which deepStrictEqual treats as a difference.
  assert.equal(JSON.stringify(replayed.chat.history), JSON.stringify([
    { role: 'user', content: 'Упр. 25' },
    { role: 'assistant', content: 'x = 4' },
  ]));
  assert.equal(replayed.chat.restoredCount, 2, 'the replay marker drives the «Решить заново» affordance');
  assert.equal(replayed.chat.pending, false, 'the chat is released, not left spinning');
  assert.ok(replayed.calls.rendered >= 1);

  const fresh = await runStartLesson({ stored: null });
  assert.equal(fresh.calls.sent, 1, 'an unseen lesson is solved normally');
  assert.equal(fresh.chat.restoredCount, 0);

  const forced = await runStartLesson({
    stored: { sessionId: 'sess-1', messages: [{ role: 'assistant', content: 'x = 4' }] },
    reuse: false,
  });
  assert.equal(forced.calls.sent, 1, '«Решить заново» must bypass the stored answer');
  assert.equal(forced.chat.restoredCount, 0);

  // The one way reuse could cost the student something they asked for. The
  // lesson key is built from the task text, so it cannot see that the student
  // photographed the page since the stored answer was written — the launch
  // files are the signal, and they mean "solve it with THIS".
  const withAttachment = await runStartLesson({
    stored: {
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'Упр. 25' }, { role: 'assistant', content: 'x = 4' }],
    },
    launchFiles: [{ name: 'page14.jpg', mime: 'image/jpeg', dataBase64: 'AAAA' }],
  });
  assert.equal(withAttachment.calls.sent, 1,
    'a file attached to this row must be solved, not answered from an older text reply');
  assert.equal(withAttachment.calls.sentFiles?.length, 1,
    'and the file must actually reach the solve');
  assert.equal(withAttachment.calls.lookups, 0,
    'the history is not even consulted — the attachment already decided this');
  assert.equal(withAttachment.chat.restoredCount, 0, 'nothing was replayed, so no replay bar');
  assert.equal(withAttachment.leftoverFiles.length, 0,
    'the one-time launch files are consumed, not stranded for the next lesson');
}

/* ---------------- 6. The privileged boundary carries the key ------------- */
{
  assert.match(
    sourceSection(workerSource, '  SOLVE: (msg) =>', '  SOLVE_TEST:'),
    /isOptionalString\(msg\.payload\.lessonKey, 128\)/,
    'the SOLVE schema must bound the lesson key it now accepts'
  );
  assert.match(workerSource, /'LESSON_HISTORY', 'LIST_SESSIONS'/,
    'LESSON_HISTORY must be reachable only from extension pages');
  assert.match(workerSource, /LESSON_HISTORY: \(msg\) => payloadRecord\(msg, \['lessonKey'\]\)/,
    'LESSON_HISTORY needs its own payload schema');
  assert.match(workerSource, /assistantContent: answer,\n      lessonKey,/,
    'a solved lesson must be stored under its reuse key');
  assert.match(dashboardSource, /engine: solveEngine, lessonKey: chat\.lessonKey \|\| ''/,
    'the dashboard must send the key with every solve, including follow-ups');
  // The panel the pill opens holds no screenshot, so the re-solve it triggers is
  // text-only. The worker has to say so, or the entry keeps claiming to be
  // image-backed and the guard stops meaning anything for that answer.
  assert.match(workerSource, /image: !!context\.screenshot,/,
    'a «перерешать» must tell the cache whether it could see the page image');
}

console.log('answer reuse regression passed');

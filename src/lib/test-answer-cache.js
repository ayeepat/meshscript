/**
 * Local reuse cache for solved МЭШ test pages, so reopening a test the student
 * already solved fills the same answers instead of paying for the same
 * completion again.
 *
 * IDENTITY — the cache key is the page's own capture signature, not its URL.
 * scraper.js `pageSignature()` hashes the question text, the control semantics
 * and the visual resources of every captured document, and deliberately leaves
 * out everything volatile (countdown timers, transient overlays, and the
 * student's own typed/checked answers). That is exactly the identity this cache
 * needs:
 *  - a different variant, a reshuffled question order, or one changed question
 *    produces a different signature, so the page is solved fresh;
 *  - an xAPI relaunch with a new registration id, or answers already filled in
 *    from last time, does NOT change it, so the common case still hits.
 * The URL is intentionally excluded: МЭШ mints a fresh registration/launch id
 * per attempt, which would miss every time while proving nothing the signature
 * does not already prove.
 *
 * WHOSE — the key is also scoped to the account the page was captured under, so
 * two children sharing one device never fill each other's answers. Only the
 * STABLE half of the capture principal participates: the account/profile/student
 * ids. The principal's trailing session field hashes the xAPI `registration` and
 * friends (scraper.js currentTestSessionIdentity), which МЭШ re-mints per
 * attempt — putting that in the key would miss on exactly the reopen this cache
 * exists for. A page that exposes no account signal at all contributes an empty
 * identity, i.e. it is no more separated than it was before; that is an honest
 * degradation rather than a false promise.
 *
 * MATERIAL — an entry records whether the solve that produced it could see a
 * screenshot. A text-only answer is never served to a request that has one,
 * because the screenshot route exists precisely for pages whose DOM text is not
 * enough to answer from. A «перерешать» that could NOT see the screenshot
 * downgrades the entry it patches, so the guard keeps holding per answer.
 *
 * Trusted-only storage.local (content scripts can read storage.session), a
 * 7-day TTL matching solve history, and an entry cap. Wiped by the settings
 * «Удалить все локальные данные» button and swept by the retention alarm.
 */

export const TEST_ANSWER_CACHE_KEY = 'testAnswerCache';
export const TEST_ANSWER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 60;

function digest(value) {
  const text = String(value ?? '');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${text.length.toString(36)}`;
}

/**
 * The documents that actually carry the questions.
 *
 * On `school.mos.ru/<course>/cwork` the test runs inside a uchebnik iframe:
 * frame 0 is the МЭШ shell, and readTestCaptureContext only keeps a child frame
 * that identified itself as a test document. That shell must stay OUT of the
 * key. Its signature includes the iframe's own src (scraper.js hashes
 * `iframe[src]` as a resource), and МЭШ mints a fresh xAPI launch — new
 * `registration`, new `activityId` — for every attempt, so keying on the shell
 * would miss on exactly the reopen this cache exists for.
 *
 * When the test IS the top frame (`uchebnik.mos.ru/exam/challenge`, the inline
 * `/dt/…/go` task views) there is no child document and the top frame is the
 * question-bearing one. A document's own URL is never part of its signature, so
 * that case is unaffected by the launch id.
 */
function questionDocuments(documents) {
  const children = documents.filter((document) => document?.frameId !== 0);
  return children.length ? children : documents;
}

/**
 * The account half of a capture principal: ['v2', account, subject, student,
 * state, session] minus the two trailing fields. `session` is re-minted per
 * attempt and `state` can follow it, so neither may reach the key — but the
 * account/profile/student ids are exactly the "which child is this" signal the
 * lesson cache already scopes on (see lib/lesson-key.js).
 */
function stableAccountIdentity(documents) {
  const identities = new Set();
  for (const document of documents) {
    let parts = null;
    try { parts = JSON.parse(String(document?.principal ?? '')); } catch { parts = null; }
    // An unrecognised shape contributes nothing rather than smuggling the
    // volatile session in verbatim; a future principal version is a miss on
    // isolation, never a stale answer served to the wrong child.
    if (!Array.isArray(parts) || parts[0] !== 'v2') continue;
    const stable = [parts[1], parts[2], parts[3]].map((value) => String(value ?? '')).join('~');
    if (stable !== '~~') identities.add(stable);
  }
  return [...identities].sort().join('&');
}

/**
 * @returns {string} the reuse key for this capture, or '' when it carries no
 *   usable signature — an unidentifiable page must never share a cache slot.
 */
export function testAnswerCacheKey(capture) {
  const documents = Array.isArray(capture?.documents) ? capture.documents : [];
  if (!documents.length) return '';
  // Every frame in the tab, not just the question-bearing ones: on the cwork
  // layout the МЭШ shell is the frame that knows which child is selected, and
  // its account fields are stable even though its signature is not.
  const signatures = [];
  // Ordered by frame id, not keyed on it: reloading a page gives its child
  // frames new ids, while their relative creation order is preserved.
  for (const document of questionDocuments([...documents].sort((a, b) => (a?.frameId || 0) - (b?.frameId || 0)))) {
    const signature = typeof document?.signature === 'string' ? document.signature : '';
    if (!signature) return '';
    signatures.push(signature);
  }
  if (!signatures.length) return '';
  // t2: the key gained its account scope. Entries written under t1 simply stop
  // matching and age out with the 7-day sweep — a miss costs one solve, while
  // reading them would be the cross-account reuse this version exists to end.
  return `t2.${digest([stableAccountIdentity(documents), ...signatures].join('||'))}`;
}

// One read-modify-write queue per worker. Two tabs can finish a page at the
// same moment; the per-tab solve lock does not serialize them, and a lost
// update would silently drop a page the student already paid for.
let cacheQueue = Promise.resolve();
function mutateCache(mutator) {
  const run = cacheQueue.then(async () => {
    const { [TEST_ANSWER_CACHE_KEY]: stored } = await chrome.storage.local.get(TEST_ANSWER_CACHE_KEY);
    const cache = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
    const result = await mutator(cache);
    if (result === false) return false;
    await chrome.storage.local.set({ [TEST_ANSWER_CACHE_KEY]: cache });
    return true;
  });
  cacheQueue = run.catch(() => {});
  return run;
}

// Cached answers are replayed straight into the student's page (panel + form
// fill), so a half-written or hand-edited entry must fail as "not cached"
// rather than travel any further. Mirrors the worker's validQuestion contract
// on the two fields every consumer actually reads.
function usableQuestion(question) {
  return !!question && typeof question === 'object' && !Array.isArray(question) &&
    (typeof question.index === 'number' || typeof question.index === 'string') &&
    typeof question.answer === 'string';
}

function liveEntry(cache, key) {
  const entry = cache?.[key];
  if (!entry || typeof entry !== 'object') return null;
  if (!Number.isFinite(entry.at) || Date.now() - entry.at > TEST_ANSWER_CACHE_TTL_MS) return null;
  const questions = Array.isArray(entry.v?.questions) ? entry.v.questions : null;
  if (!questions?.length || !questions.every(usableQuestion)) return null;
  return entry;
}

/**
 * @param {object} capture the exact capture the answers would be filled into
 * @param {{image?: boolean}} options whether this request can see a screenshot
 * @returns {Promise<{questions: object[], image: boolean}|null>}
 */
export async function readCachedTestAnswers(capture, { image = false } = {}) {
  const key = testAnswerCacheKey(capture);
  if (!key) return null;
  let cache;
  try {
    ({ [TEST_ANSWER_CACHE_KEY]: cache } = await chrome.storage.local.get(TEST_ANSWER_CACHE_KEY));
  } catch { return null; } // a storage hiccup costs one solve, never an error
  const entry = liveEntry(cache, key);
  if (!entry) return null;
  if (image === true && entry.v.image !== true) return null;
  return { questions: entry.v.questions, image: entry.v.image === true };
}

/** Remember one solved page. Best-effort: a failed write only costs a re-solve. */
export function writeCachedTestAnswers(capture, questions, { image = false } = {}) {
  const key = testAnswerCacheKey(capture);
  if (!key || !Array.isArray(questions) || !questions.length) return Promise.resolve(false);
  return mutateCache((cache) => {
    cache[key] = { v: { questions, image: image === true }, at: Date.now() };
    const keys = Object.keys(cache);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => (cache[a]?.at || 0) - (cache[b]?.at || 0));
      for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[stale];
    }
    return true;
  }).catch(() => false);
}

/**
 * Fold a single re-solved question («перерешать») back into the cached page, so
 * the next visit fills the corrected answer instead of the one the student
 * already rejected. A missing entry or an unknown question number is a no-op:
 * the alternative — dropping the whole page — would re-charge the student for
 * every other question because they doubted one.
 *
 * `image` is whether THIS correction could see the page image. A panel opened by
 * the pill holds no screenshot, so a re-solve there is text-only even on a page
 * whose entry was originally written from one — and the entry must stop claiming
 * to be image-backed, or that text answer would later be served to a screenshot
 * request the guard exists to protect.
 */
export function patchCachedTestAnswer(capture, index, { answer, parts, image = false } = {}) {
  const key = testAnswerCacheKey(capture);
  if (!key || typeof answer !== 'string' || !answer.trim()) return Promise.resolve(false);
  return mutateCache((cache) => {
    const entry = liveEntry(cache, key);
    if (!entry) return false;
    const wanted = String(index ?? '').trim();
    let matched = false;
    const questions = entry.v.questions.map((question) => {
      if (String(question?.index ?? '').trim() !== wanted) return question;
      matched = true;
      const patched = { ...question, answer };
      if (Array.isArray(parts) && parts.length) patched.parts = parts;
      else delete patched.parts;
      return patched;
    });
    if (!matched) return false;
    cache[key] = {
      v: { ...entry.v, questions, image: entry.v.image === true && image === true },
      at: entry.at
    };
    return true;
  }).catch(() => false);
}

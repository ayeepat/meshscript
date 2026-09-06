/**
 * Background service worker (MV3, type: module).
 * Orchestrates the AI provider call and local solve-history persistence.
 * All API keys live here / in storage, never in content scripts.
 */
import { askAI, normalizeAIProvider } from '../lib/ai.js';
import { buildSystemPrompt, categoryForSubject } from '../lib/subject-router.js';
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../lib/prompts.js';
import {
  appendSolveTurn,
  findLessonSession,
  listSessions,
  listMessages,
  cleanupLocalData,
  deleteAllLocalData,
  getDeviceId,
} from '../lib/history.js';
import {
  patchCachedTestAnswer,
  readCachedTestAnswers,
  writeCachedTestAnswers,
} from '../lib/test-answer-cache.js';
import { ensureLicensed, setLicenseKey, deactivateCurrentLicense } from '../lib/license.js';
import { getMyReferralCode } from '../lib/referral.js';
import { DEFAULT_PROVIDER, REFERRALS_ENABLED } from '../lib/config.js';
import { claimTour, releaseTourClaim } from '../lib/onboarding.js';
import { hasConsent, CONSENT_REQUIRED_MESSAGE } from '../lib/consent.js';
import { getRuntimeConfig } from '../lib/remote-config.js';
import { isBareTextbookRef, classifyTask, needsAudio, isEasyTask, isChatty, isLightFollowup, testPageEffort } from '../lib/task-classifier.js';
import { isReadableFile, isAudioFile, isPdfFile, isImageFile } from '../lib/file-kinds.js';
import { track, heartbeat, usageFields, errorCode } from '../lib/telemetry.js';
import { EMPTY_ANSWER } from '../lib/http.js';
import {
  getCatalog,
  searchBooks,
  resolveForTask,
  fetchTaskImage,
  fetchCoverImage,
  normalizeGdzApiUrl,
} from '../lib/gdz-api.js';
import { isGdzCoverUrl } from '../lib/gdz-hosts.js';
import { mapSubjectToId } from '../lib/gdz-match.js';
import { prepareFiles } from '../lib/extract.js';
import { compressImageFiles } from '../lib/image-compress.js';
import {
  storeDashboardLaunch,
  consumeDashboardLaunch,
  cleanupDashboardLaunches
} from '../lib/dashboard-launch.js';
import { addGdzBook, removeGdzBook } from '../lib/gdz-books.js';
import { capturePillDomText, captureTestVisualMedia, captureWebDomText } from '../lib/pill-dom-capture.js';
import { createReasoningCollector, recordDevTrace } from '../lib/dev-trace.js';
import { isDevModeActive } from '../lib/dev-mode.js';
import { reconcileAnswer } from '../lib/test-answer-arithmetic.js';
import {
  CAPTURE_MODE_WEB,
  executeScriptInCapturedDocuments,
  isTestCaptureContext,
  isWebCapture,
  TEST_CAPTURE_CHANGED,
  testCaptureChangedError,
  withMatchingTestCapture,
} from '../lib/test-capture-context.js';
import {
  expectedWebPrincipal,
  isWebSolvableUrl,
  webOriginPattern,
  webPillExcludeMatches,
  webPillMatchPatterns,
  WEB_PILL_FILES,
  WEB_PILL_SCRIPT_ID,
  WEB_SOLVE_EFFORT,
  WEB_SOLVE_PROVIDER,
  WEB_SOLVE_TIER,
} from '../lib/web-solve.js';
import { classifyAutopilotFill, resolvePaginationTarget } from '../lib/test-autopilot.js';
import { isHomeworkScanId, principalBindingMatches } from '../lib/principal-binding.js';
import {
  MAX_STANDARD_UPLOAD_BYTES,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_REQUEST_FILE_BYTES,
  deduplicateRequestFiles,
  validateRequestFileBudget
} from '../lib/upload-limits.js';

// Diagnostic logging. OFF in shipped builds — flip to true to trace attachment
// downloads and the cross-frame test fill in the service-worker console.
const DEBUG = false;
const dbg = (...a) => { if (DEBUG) { try { console.log(...a); } catch { /* no console */ } } };
const ATTACHMENT_FETCH_TIMEOUT_MS = 30 * 1000;
// The answer panel retains the screenshot its answers came from so «перерешать»
// is as well-informed as the original solve (see resolveOneQuestion). Bound it
// so one panel context cannot pin an oversized capture in the worker for the
// tab's lifetime; the ceiling matches the upload budget the image already
// cleared, expressed in base64 characters.
const MAX_PANEL_SCREENSHOT_CHARS = Math.ceil(MAX_STANDARD_UPLOAD_BYTES * 4 / 3);
const REFERRAL_POINTER_SYNC_KEY = 'referralPointerSyncPending';
const REFERRAL_POINTER_SYNC_ALARM = 'smesh-referral-pointer-sync';
let referralPointerStateQueue = Promise.resolve();
const referralPointerSyncFlights = new Map();
let referralPointerRecoveryFlight = null;

function mutateReferralPointerState(operation) {
  const run = referralPointerStateQueue.then(operation);
  referralPointerStateQueue = run.catch(() => {});
  return run;
}

function scheduleReferralPointerRetry(attempts = 0) {
  const delayInMinutes = Math.min(60, Math.max(1, 2 ** Math.min(6, attempts)));
  try {
    // Chrome 106-110 returns void; Chrome 111+ returns a Promise. Handle both
    // without making successful license activation wait for alarm persistence.
    chrome.alarms.create(REFERRAL_POINTER_SYNC_ALARM, { delayInMinutes })
      ?.catch?.(() => { /* a later worker startup reconstructs it from storage */ });
  }
  catch { /* startup/manual sync will retry the persisted intent */ }
}

function referralPointerIntent() {
  return {
    id: crypto.randomUUID(),
    requestedAt: Date.now(),
    attempts: 0
  };
}

async function storeReferralPointerIntent(intent) {
  await mutateReferralPointerState(() => chrome.storage.local.set({
    [REFERRAL_POINTER_SYNC_KEY]: intent
  }));
  scheduleReferralPointerRetry(0);
}

async function loadReferralPointerIntent() {
  return mutateReferralPointerState(async () => {
    const { [REFERRAL_POINTER_SYNC_KEY]: value } =
      await chrome.storage.local.get(REFERRAL_POINTER_SYNC_KEY);
    if (!value || typeof value !== 'object' ||
        typeof value.id !== 'string' || !value.id) return null;
    return {
      id: value.id,
      requestedAt: Number(value.requestedAt) || 0,
      attempts: Math.max(0, Number(value.attempts) || 0)
    };
  });
}

async function clearReferralPointerIntent(intentId) {
  await mutateReferralPointerState(async () => {
    const { [REFERRAL_POINTER_SYNC_KEY]: current } =
      await chrome.storage.local.get(REFERRAL_POINTER_SYNC_KEY);
    // A newer license save may have replaced this intent while its request was
    // in flight. Never let an older completion erase that newer durable work.
    if (current?.id === intentId) {
      await chrome.storage.local.remove(REFERRAL_POINTER_SYNC_KEY);
      try { await chrome.alarms.clear(REFERRAL_POINTER_SYNC_ALARM); }
      catch { /* a stray alarm observes no pending intent and exits */ }
    }
  });
}

async function recordReferralPointerFailure(intentId) {
  let attempts = 0;
  await mutateReferralPointerState(async () => {
    const { [REFERRAL_POINTER_SYNC_KEY]: current } =
      await chrome.storage.local.get(REFERRAL_POINTER_SYNC_KEY);
    if (current?.id !== intentId) return;
    attempts = Math.min(30, Math.max(0, Number(current.attempts) || 0) + 1);
    await chrome.storage.local.set({
      [REFERRAL_POINTER_SYNC_KEY]: { ...current, attempts }
    });
  });
  if (attempts) scheduleReferralPointerRetry(attempts);
}

async function performReferralPointerSyncOnce(intent) {
  try {
    const code = await getMyReferralCode({ sync: true });
    await clearReferralPointerIntent(intent.id);
    return code;
  } catch (error) {
    await recordReferralPointerFailure(intent.id);
    throw error;
  }
}

function performReferralPointerSync(intent) {
  const existing = referralPointerSyncFlights.get(intent.id);
  if (existing) return existing;
  // Publish ownership before the one-shot starts. A cold alarm wake evaluates
  // this module's recovery and then dispatches onAlarm; both callers must join
  // one POST and one failure/backoff mutation for this durable intent.
  const run = Promise.resolve().then(() => performReferralPointerSyncOnce(intent));
  referralPointerSyncFlights.set(intent.id, run);
  const release = () => {
    if (referralPointerSyncFlights.get(intent.id) === run) {
      referralPointerSyncFlights.delete(intent.id);
    }
  };
  run.then(release, release);
  return run;
}

async function queueReferralPointerSync() {
  // Coalesce toward the latest license state. The request itself reads the
  // authoritative cached license when its turn reaches referral.js's queue.
  const intent = referralPointerIntent();
  await storeReferralPointerIntent(intent);
  void performReferralPointerSync(intent).catch(() => {});
  return intent;
}

async function retryPendingReferralPointer(knownIntent = null) {
  const intent = knownIntent || await loadReferralPointerIntent();
  if (intent) await performReferralPointerSync(intent);
}

function restorePendingReferralPointerRetry() {
  if (referralPointerRecoveryFlight) return referralPointerRecoveryFlight;
  // Recreate the one-shot alarm before touching the network. Older supported
  // Chrome releases do not guarantee alarm persistence across browser restarts;
  // this safety alarm survives a worker killed during the retry itself.
  const run = (async () => {
    const intent = await loadReferralPointerIntent();
    if (!intent) return;
    // An install that activated a license under an earlier build can still be
    // carrying a durable intent. With the programme off the backend refuses
    // /referral/code, so retrying it would only rebuild the alarm forever on a
    // request that can never succeed. Drop the intent and its alarm instead.
    if (!REFERRALS_ENABLED) return clearReferralPointerIntent(intent.id);
    scheduleReferralPointerRetry(intent.attempts);
    return retryPendingReferralPointer(intent);
  })();
  referralPointerRecoveryFlight = run;
  const release = () => {
    if (referralPointerRecoveryFlight === run) referralPointerRecoveryFlight = null;
  };
  run.then(release, release);
  return run;
}

async function syncReferralPointer() {
  const intent = referralPointerIntent();
  await storeReferralPointerIntent(intent);
  return performReferralPointerSync(intent);
}

async function setLicenseKeyAndSyncReferral(key) {
  const status = await setLicenseKey(key);
  // The pointer only exists so a future referral reward lands on the license
  // this device just activated. While the programme is off there is no reward
  // to aim, so activation stays a purely local, network-free step.
  if (status?.ok && REFERRALS_ENABLED) {
    // Persist the intent before replying, then detach the unreliable network
    // hop. The named alarm plus startup reconstruction retries until the backend
    // confirms; a 15-second referral outage no longer stalls activation.
    await queueReferralPointerSync();
  }
  return status;
}

// Follow-ups re-send prior context. Cap how many MESSAGES we replay: full
// worked solutions are long, and on a paid provider every re-sent message is
// money. 8 messages ≈ 4 back-and-forth turns — enough recent context to follow
// up without re-sending the whole chat. (Bump to 16 for ~8 full turns.)
const MAX_HISTORY_MESSAGES = 8;

// Storage trust split. storage.LOCAL holds the secrets (API keys, license) —
// lock it to trusted contexts so a compromised mos.ru renderer can't read them
// through our content scripts. storage.SESSION is the deliberately
// UNTRUSTED-readable area: it must only ever hold UI state (panel positions)
// plus the non-sensitive `theme`/`aiProvider` mirror below — never a secret.
//
// setAccessLevel was extended to local/sync storage only in July 2025
// (Chromium a8f1f33) — Chrome 102 added it for SESSION storage alone. Below
// Chrome 139 and below may leave storage.local readable by this extension's own content
// scripts and the isolation invariant does not hold at all, so
// manifest.json now requires 140 and the store will not install below it.
// This branch is therefore a should-never-happen guard rather than a supported
// degraded mode; it stays loud because silently continuing is how the gap went
// unnoticed. Keep STORAGE_ISOLATION_MIN_CHROME and the manifest in step.
const STORAGE_ISOLATION_MIN_CHROME = 140;

try {
  if (typeof chrome.storage.local.setAccessLevel !== 'function') {
    console.error(
      'storage.local.setAccessLevel unavailable — secrets remain readable by this ' +
      `extension's content scripts; Chrome ${STORAGE_ISOLATION_MIN_CHROME}+ is required`
    );
  } else {
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
      ?.catch?.((error) => console.error('failed to restrict local storage access', errorCode(error)));
  }
} catch (error) { console.error('failed to restrict local storage access', errorCode(error)); }
try {
  chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch { /* old Chrome — content script falls back to defaults each time */ }

// The pill/answer panel read only `theme` and `aiProvider`. With storage.local
// now trusted-only they can't read (or receive onChanged events for) the
// originals, so the worker mirrors just these two keys into storage.session.
async function mirrorUiPrefsToSession() {
  try {
    const { theme = null, aiProvider = null } = await chrome.storage.local.get(['theme', 'aiProvider']);
    await chrome.storage.session.set({ theme, aiProvider });
  } catch { /* session unavailable — pill falls back to defaults */ }
}
mirrorUiPrefsToSession();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.theme || changes.aiProvider)) mirrorUiPrefsToSession();
});

// Retention sweep: history (7 d), weekHomework (24 h), legacy pendingUpload
// handoffs (1 h), taskClassCache + gdzTaskCache lookup caches (30 d). Alarm
// survives SW teardown; the startup call covers the gap after a browser
// restart before the alarm first fires.
try {
  chrome.alarms.create('smesh-retention', { periodInMinutes: 6 * 60 });
  chrome.alarms.create('smesh-launch-retention', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'smesh-retention') void cleanupLocalData();
    if (alarm.name === 'smesh-launch-retention') void cleanupDashboardLaunches();
    if (alarm.name === REFERRAL_POINTER_SYNC_ALARM) {
      void restorePendingReferralPointerRetry().catch(() => {});
    }
  });
} catch { /* alarms unavailable — startup sweep below still runs */ }
// Alarm persistence was not controllable on the oldest supported Chrome
// releases. Register synchronously so a profile restart wakes this worker and
// reconstructs any named retry from the durable intent.
try {
  chrome.runtime.onStartup.addListener(() => {
    void restorePendingReferralPointerRetry().catch(() => {});
  });
} catch { /* runtime startup events unavailable in a test harness */ }
void cleanupLocalData();
void cleanupDashboardLaunches();
void restorePendingReferralPointerRetry().catch(() => {});

// Warm the remote runtime config on every SW spin-up (cheap: a single cached
// fetch at most once per TTL). Fire-and-forget — a failure is a silent no-op and
// the extension uses its built-in defaults. See lib/remote-config.js.
getRuntimeConfig().catch(() => { /* offline / not hosted — defaults apply */ });

// Daily-active signal for the admin dashboard. Self-throttled to one ping per
// 6h (see telemetry.heartbeat), so frequent SW spin-ups don't spam the backend.
heartbeat();

// A Chrome toolbar popup cannot open itself after installation, and the tour is
// a full-screen page by design — it never squeezes into the 380px popup. Open
// it as a first-party tab instead.
//
// It opens ONCE PER DEVICE, forever, and the guard is lib/onboarding.js: the
// record is written BEFORE the tab exists, so nothing here — a rejected tab, a
// closed window, a second event — can produce a second showing. Two entry
// points feed it and both go through the same claim:
//   • install — the new student;
//   • update  — the one-time backfill for everyone who installed before the
//     tour existed. They only qualify because their device has no record at
//     all; every later update finds one and stays silent.
const WELCOME_PAGE = 'src/welcome/welcome.html';

async function openOnboardingTour(source) {
  const claim = await claimTour(source);
  if (!claim) return false; // this device has already been shown the tour
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE) });
    return true;
  } catch {
    // The tab never existed, so the showing never happened. Give the claim back
    // rather than burning the student's single onboarding on a Chrome hiccup.
    await releaseTourClaim(claim).catch(() => { /* stays claimed; fail closed */ });
    return false;
  }
}

function handleExtensionInstalled(details) {
  if (details?.reason === 'install') {
    track('install');
    openOnboardingTour('install').catch(() => { /* the toolbar remains the fallback */ });
  } else if (details?.reason === 'update') {
    track('update', { meta: { from: details.previousVersion || null } });
    migrateNararouter().catch(() => { /* best-effort */ });
    openOnboardingTour('update').catch(() => { /* the toolbar remains the fallback */ });
  }
}

chrome.runtime.onInstalled.addListener(handleExtensionInstalled);

// Remove provider secrets from legacy builds. Current builds send all AI
// content through the licensed gateway and never need user-supplied vendor
// credentials. Keeping them would create an undocumented dormant egress path.
async function migrateNararouter() {
  const { aiProvider } = await chrome.storage.local.get('aiProvider');
  if (!['qwen', 'deepseek'].includes(aiProvider)) {
    await chrome.storage.local.set({ aiProvider: DEFAULT_PROVIDER });
  }
  await chrome.storage.local.remove([
    'nararouterApiKey', 'nararouterModelsCache',
    'openrouterApiKey', 'groqApiKey', 'qwenApiKey'
  ]);
}

// Open the full-window dashboard when the popup asks to "Solve". Encrypted
// metadata lives in short-lived storage.session; attachment bodies stay in
// trusted local storage under the same one-time launch id. The dashboard can
// consume the pair only through the serialized worker handler below.
async function openDashboard(payload) {
  // The scan capability alone binds storage, not the live diary. Reconfirm the
  // exact account/child + row in the original tab immediately before minting a
  // dashboard launch, so an old attachment continuation cannot cross profiles.
  await verifyHomeworkDownloadBinding(payload);
  const id = await storeDashboardLaunch(payload);
  const url = chrome.runtime.getURL(`src/dashboard/dashboard.html?launch=${encodeURIComponent(id)}`);
  await chrome.tabs.create({ url });
}

// NOTE: an earlier version attempted a GDZ (reshebnik) lookup before the AI
// call. GDZ sits behind Cloudflare's JS challenge, the fetch always failed,
// and its result was discarded — it only added latency to every solve. The
// AI provider is the solver.

/**
 * Decide whether we MUST refuse before calling the model, returning the
 * Russian message to show, or null to proceed. This is the structural backstop
 * for the fabrication problem: a model handed only a task reference (and no
 * actual file/page) will otherwise invent plausible-but-wrong answers and even
 * claim it "read" material it never got.
 *
 *  - audio: automatic transcription is available only to a grandfathered BYO
 *    install with its stored transcription key. Otherwise ask for text.
 *  - attachment: task points at a file/variant/worksheet but nothing readable
 *    is attached -> ask for it (Office files like .docx don't count: unreadable).
 *  - textbook ref: bare «Упр. 25 / §3» with no page photo -> ask for the photo.
 *
 * "Readable" = image, PDF or plain text (see file-kinds). An attached .docx or
 * an empty file does not satisfy the requirement.
 */
function missingInputGate(category, task, files, { canTranscribe = false } = {}) {
  const hasReadable = files.some(isReadableFile);
  const cls = classifyTask(task);
  const audio = needsAudio(task);

  // An audio file IS attached but still isn't readable — a successful
  // No licensed transcription processor is configured, so point at the usable
  // fallback instead of telling the user to attach a file they already did.
  if (files.some(isAudioFile) && !hasReadable) {
    // NOTE: transcription runs on a BYO Groq key only (lib/transcribe.js). With
    // the provider UI hidden there is no licensed Whisper path, so a licensed
    // user cannot fix this — don't send them hunting for a setting that isn't
    // there. Say what to do instead.
    return 'Не удалось расшифровать аудиозапись. Пришлите готовую расшифровку (текст) записи ' +
      'или скриншот задания с текстом — и я всё решу.';
  }

  if (cls.kind === 'attachment' && !hasReadable) {
    let msg = 'Не могу решить это задание без самого материала. ' +
      'Пришлите файл варианта/задания (PDF, фото или скриншот страницы), и я всё решу.';
    if (audio) {
      msg += canTranscribe
        ? '\n\nДля аудирования прикрепите сам аудиофайл (mp3, m4a, wav…) — я его ' +
          'расшифрую и решу эту часть. Либо пришлите готовую расшифровку (текст) записи.'
        : '\n\nДля аудирования пришлите готовую расшифровку записи (текст) или ' +
          'скриншот задания с текстом.';
    }
    return msg;
  }

  if (audio && !hasReadable) {
    return canTranscribe
      ? 'В этом задании нужно аудирование. Прикрепите аудиофайл записи (mp3, m4a, wav…) — ' +
        'я расшифрую его и решу. Либо пришлите готовую расшифровку (текст) или фото/скан заданий.'
      : 'В этом задании нужно аудирование. Пришлите готовую расшифровку записи (текст) ' +
        'или фото/скан задания с текстом.';
  }

  if ((category === PROMPT_CATEGORIES.RUSSIAN_FULL || cls.kind === 'textbook') &&
      isBareTextbookRef(task) && !hasReadable) {
    return 'Чтобы решить это упражнение без ошибок, загрузите, пожалуйста, ' +
      'фото страницы учебника с этим заданием.';
  }

  return null;
}

/**
 * Last-ditch material fetch for the missing-material gate. When a homework is
 * about to be refused because its source material isn't attached (a bare «Упр.
 * 25 / §3 / с. 112», or a "do the attached file" with nothing readable), try the
 * GDZ (reshebnik) book(s) the user configured for this subject: resolve the
 * task's number(s) and return the answer image(s) as inline files, so the model
 * can solve FROM the worked answer instead of telling the student to photograph
 * the page. Reuses the same plumbing as the GDZ_FOR_TASK handler.
 *
 * Bounded (each GDZ call self-times-out) and silent on any miss — returns [] so
 * the original refusal still applies. Only attaches up to a few images to keep
 * the provider payload (and cost) sane.
 */
async function fetchGdzMaterial(subject, task) {
  const MAX_MATERIAL_IMAGES = 6;
  try {
    const sid = mapSubjectToId(subject);
    if (sid == null) return [];
    const { gdzBooks = {} } = await chrome.storage.local.get('gdzBooks');
    const raw = gdzBooks[sid];
    const books = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    if (!books.length) return [];
    const images = [];
    for (const book of books) {
      const res = await resolveForTask(book, task || '');
      for (const a of res.answers) {
        if (!a.found || !Array.isArray(a.images) || !a.images.length) continue;
        const settled = await Promise.all(
          a.images.slice(0, MAX_MATERIAL_IMAGES - images.length)
            .map((u) => fetchTaskImage(u).catch(() => null))
        );
        for (const img of settled) if (img) images.push(img);
        if (images.length >= MAX_MATERIAL_IMAGES) break;
      }
      if (images.length >= MAX_MATERIAL_IMAGES) break;
    }
    return images;
  } catch { return []; }
}

/**
 * Solve a task with the AI provider + chat history. Persist to local history.
 * @param {object} p
 * @param {string} [p.mode] answer mode (brief/explain) — see subject-router
 * @param {string} [p.engine] dashboard engine toggle (auto/think) — picks the model
 * @param {string} [p.lessonKey] stable lesson identity (lib/lesson-key.js) stored
 *   on the session so reopening this exact homework row replays it for free
 * @param {(chunk:string)=>void} [onDelta] stream callback (token-by-token)
 */
async function solve(
  { subject, task, files = [], sessionId = null, history = [], mode, engine, lessonKey = '' },
  onDelta,
  signal
) {
  // License gate. No-op until the configured launch instant (preorder window).
  // Throws a Russian-language error the catch path surfaces verbatim.
  await ensureLicensed();
  // Privacy backstop: never send homework to a provider without consent. The
  // popup onboarding collects this up front, so this only fires for an edge
  // path (e.g. a stale dashboard tab). Surfaced as a normal assistant message.
  if (!(await hasConsent())) return { answer: CONSENT_REQUIRED_MESSAGE, needsConsent: true, sessionId };
  const category = categoryForSubject(subject);

  // Apply the replay cap before calculating the request-wide file budget: old
  // turns outside this window are not sent at all. Current files win duplicate
  // fingerprints, so an attachment repeated in history is shipped only once.
  // Treat client-supplied history flags as part of the trust boundary. An
  // interrupted stream is useful to show locally, but its truncated assistant
  // text is not a completed answer and must never steer a later provider call.
  history = history.filter((message) => message?.error !== true)
    .slice(-MAX_HISTORY_MESSAGES);
  const deduped = deduplicateRequestFiles(files, history);
  files = deduped.files;
  history = deduped.history;
  const fileBudget = validateRequestFileBudget(deduped.allFiles);
  if (!fileBudget.ok) throw new Error(fileBudget.error);

  // Extract Office files (.docx/.pptx/.xlsx) to inline text RIGHT HERE, locally
  // and for free — no API call. This both lets the model actually solve from
  // them and lets the gate below see them as readable material.
  files = await prepareFiles(files);

  // Audio is not sent to an undeclared direct transcription provider. Until a
  // licensed transcription processor is added to the gateway registry, the
  // deterministic input gate below asks for a transcript.

  // Hard refusal gate — runs in CODE, before any model call, only on the first
  // turn (later turns may carry a clarification or a just-attached file). A soft
  // prompt guard alone doesn't reliably stop a model inventing answers to
  // material it never received, so when a required input is genuinely missing we
  // refuse deterministically instead of guessing. See missingInputGate.
  //
  // Before refusing, make ONE last attempt to supply the material ourselves: if
  // the user pinned a GDZ (reshebnik) book for this subject, fetch the answer
  // image(s) for the task's number(s) and attach them, then proceed instead of
  // asking the student to photograph the page. Audio gaps can't be filled this
  // way (a reshebnik has no listening answers), so we skip GDZ for those.
  let gdzAttached = 0;
  if (history.length === 0) {
    const gate = missingInputGate(category, task, files, { canTranscribe: false });
    if (gate) {
      const audioGap = needsAudio(task) && !files.some(isReadableFile);
      const gdzFiles = audioGap ? [] : await fetchGdzMaterial(subject, task);
      if (gdzFiles.length) { files = files.concat(gdzFiles); gdzAttached = gdzFiles.length; }
      else return { answer: gate, needsUpload: true, sessionId };
    }
  }

  // Shrink big images (phone photos, GDZ page scans) LAST, after every source
  // that can add one: a multi-MB image inside the single /ai/start POST body
  // is exactly what dies on the RU DPI clamp (and blows the proxy's data-URI
  // cap). History needs the FULL current-file pipeline first: the dashboard
  // replays each turn's ORIGINAL attachments, so a raw Office/audio file would
  // otherwise reach the provider adapter on every follow-up and become an
  // unreadable-file note instead of the extracted text/transcript the first
  // turn saw. Every step is fail-open and preserves the original on failure.
  files = await compressImageFiles(files);
  const preparedHistory = [];
  for (const m of history) {
    if (!m?.files?.length) {
      preparedHistory.push(m);
      continue;
    }
    const historyFiles = await prepareFiles(m.files);
    // Image decoding is intentionally sequential across history messages too:
    // parallel 25-megapixel bitmaps can multiply peak memory and kill the MV3
    // worker before the request is sent.
    preparedHistory.push({ ...m, files: await compressImageFiles(historyFiles) });
  }
  history = preparedHistory;
  const finalAttachments = deduplicateRequestFiles(files, history);
  files = finalAttachments.files;
  history = finalAttachments.history;
  const finalBudget = validateRequestFileBudget(finalAttachments.allFiles);
  if (!finalBudget.ok) throw new Error(finalBudget.error);

  const systemPrompt = await buildSystemPrompt(subject, mode);
  // Dashboard engine toggle («Авто» / «Думать») selects a stable proxy route:
  // auto → legacy wire id `deepseek`, currently Qwen 3.7 Plus via live model
  // control; think → Qwen. Absent/unknown values keep the stored provider.
  const engineProvider = engine === 'think' ? 'qwen' : engine === 'auto' ? 'deepseek' : null;
  const provider = engineProvider || undefined;
  // When we auto-attached GDZ answer images above, tell the model what they are
  // so it transcribes/adapts the worked solution rather than treating them as a
  // fresh problem photo (and ignores any image whose number doesn't match).
  let userTask = task || '(см. вложение)';
  if (gdzAttached) {
    userTask += `\n\n(К заданию приложены ${gdzAttached} изображени${gdzAttached === 1 ? 'е' : 'я'} с готовым ` +
      'решением из решебника (ГДЗ) по этим номерам. Используй их как опорный материал: перепиши и адаптируй ' +
      'решение под нужный формат ответа, исправляя очевидные ошибки распознавания. Если на изображении ' +
      'явно не тот номер — не используй его.)';
  }
  let usage = null, usedProvider = null;
  // LOW reasoning effort for turns that don't need model thinking (pure time-
  // to-first-answer AND billed thinking tokens). The live Auto route is never
  // downgraded here: its actual model is owner-controlled, and the VPS applies
  // model-specific reasoning safely (Qwen 3.7 Plus thinks by default and is
  // sent no effort at all; GLM-5.3-Flash is forced to max).
  //  - 'easy':    first-turn recall/lookup/choice (isEasyTask);
  //  - 'chatty':  first-turn greetings / "что ты умеешь" — nothing to solve;
  //  - 'followup': clarification of an already-solved task («объясни, я не
  //    понял») — the thinking model's worked answer is replayed in history, so
  //    re-explaining it is rewording, not solving. Requires a real prior
  //    assistant answer to lean on (not an errored or gate-refusal turn), and
  //    isLightFollowup keeps ANY dispute («неправильно», «ты уверен?»), new
  //    task or fresh math at full effort — doubting the answer means re-solve.
  // Anything not clearly light keeps the default effort; the answer is one
  // «спросить ещё раз» away regardless.
  const askOpts = { onDelta, provider, signal, onUsage: (u, prov) => { usage = u; usedProvider = prov; } };
  let lowEffortReason = null;
  if (engineProvider === 'deepseek') {
    // Auto quality is controlled by the model-aware VPS policy.
  } else if (engineProvider === 'qwen') {
    // «Думать» is an explicit ask for full reasoning — never downgrade it,
    // even for turns the heuristics below would call light.
  } else if (!files.length) {
    if (history.length === 0) {
      if (isEasyTask(task)) lowEffortReason = 'easy';
      else if (isChatty(task)) lowEffortReason = 'chatty';
    } else if (
      history.some((m) => m?.role === 'assistant' && !m.error && !m.needsUpload &&
        typeof m.content === 'string' && m.content.trim()) &&
      isLightFollowup(task)
    ) {
      lowEffortReason = 'followup';
    }
  }
  if (lowEffortReason) askOpts.reasoning = { effort: 'low' };
  const answer = await askAI(systemPrompt, userTask, files, history, askOpts);

  // An empty completion (no content deltas at all) is a failure, not an answer.
  // Throw so the caller surfaces a retryable error instead of persisting the
  // «(пустой ответ)» sentinel and showing it as a real reply with no retry.
  if (!answer || answer.trim() === '' || answer.trim() === EMPTY_ANSWER) {
    throw new Error('Пустой ответ от ИИ. Попробуйте ещё раз.');
  }

  // Usage telemetry: one content-free 'solve' event with tokens/cost, subject
  // and attachment counts. Fire-and-forget — never blocks or fails the answer.
  track('solve', {
    subject,
    ...usageFields(usedProvider, usage),
    files_pdf: files.filter(isPdfFile).length,
    files_img: files.filter(isImageFile).length,
    meta: {
      mode: mode || 'brief',
      ...(engineProvider ? { engine } : {}),
      followup: history.length > 0 ? 1 : 0,
      gdz_auto: gdzAttached || 0,
      category,
      // Content-free markers of the low-effort routing, so the false-easy rate
      // of each route (easy / chatty / followup) is observable in the dashboard
      // instead of guessed.
      ...(lowEffortReason ? { effort: 'low', effort_reason: lowEffortReason } : {})
    }
  });

  // Persist to local history (non-fatal if storage write fails).
  try {
    const committed = await appendSolveTurn({
      sessionId,
      subject,
      taskText: task,
      userContent: task || '(файл)',
      assistantContent: answer,
      lessonKey,
    });
    return { answer, sessionId: committed.sessionId };
  } catch (e) {
    return { answer, sessionId, storageError: String(e) };
  }
}

/**
 * Solve an in-app Mesh test from extracted page text and an optional screenshot.
 * Answers are concise («№N: ответ») and never enter the solve history the
 * dashboard and Settings show.
 *
 * They ARE remembered by the local reuse cache its callers own (see
 * lib/test-answer-cache.js): 7 days, this device only, keyed on the page's own
 * capture signature, so reopening the same questions fills them without buying
 * the same completion twice. This function neither reads nor writes that cache —
 * SOLVE_TEST and pillSolveOnePage do, on either side of the call.
 */
async function solveTest({ text, screenshot, hasVisualMedia = false, provider, signal = null, pageUrl = null } = {}) {
  await ensureLicensed();
  // Same privacy backstop as solve(): no consent → no provider call. Thrown so
  // the popup's requestSolve surfaces it as a clear error instead of a "result".
  if (!(await hasConsent())) throw new Error(CONSENT_REQUIRED_MESSAGE);
  const systemPrompt = DEFAULT_PROMPTS[PROMPT_CATEGORIES.TEST_ANSWER];
  const userText = 'Текст страницы теста (может содержать навигационный мусор — игнорируй его):\n\n' +
    (text || '(текст не извлечён, смотри скриншот)');
  // JSON mode: the model returns {answers:[{n,a}]} — no fragile marker parsing.
  // `reasoning` turns on Gemini's NATIVE thinking channel: it reasons through
  // every question fully (privately), but the visible content stays a tiny
  // answers-only JSON. That reasoning streams on delta.reasoning, which
  // postStream drops — so the user only ever sees the answers, never the steps,
  // and the answers array can no longer be truncated by a long reasoning blob.
  //
  // Effort is MEDIUM, not high, on the bulk solve: 'high' lets Gemini think
  // unbounded, and on a full page of hard problems (6 algebra tasks at once) that
  // routinely ran past the pill's time cap → the whole solve timed out and the
  // student got NOTHING. Medium reasons through school-level math reliably and
  // finishes in roughly half the time. The per-question «перерешать» (↻) re-solves
  // a single doubtful question at 'high' (see resolveOneQuestion), so max accuracy
  // is still one click away without holding the whole page hostage.
  let usage = null, usedProvider = null;
  const providerOverride = normalizeAIProvider(provider, null);
  // A page with ENOUGH text and NO math/physics/proof/analysis markers
  // (vocabulary, dates, matching, multiple-choice) is answered at LOW effort
  // instead of medium — faster and cheaper on the effort-honoring paths. But a
  // screenshot-only page whose text extraction failed ('' / short placeholder)
  // must NOT default to low (it could be a hard math page we simply couldn't
  // read), so testPageEffort keeps medium when there's too little text to judge.
  // High is still one «перерешать» click away per question.
  const testEffort = testPageEffort(text);
  const askOpts = {
    responseFormat: 'json_object',
    reasoning: { effort: testEffort },
    // A positive, page-bound DOM media signal lets the licensed Auto route
    // receive the screenshot. Only hidden BYO DeepSeek is upgraded to Qwen.
    visionPreferred: hasVisualMedia === true,
    // Every provider (groq/qwen/deepseek/openrouter and the СМЭШ proxy) already
    // honours opts.signal — it just was not being handed down. Without it a
    // cancelled pill stopped the FILLING and navigation but the paid provider
    // call kept running to completion and kept spending.
    signal,
    onUsage: (u, prov) => { usage = u; usedProvider = prov; }
  };
  if (providerOverride) askOpts.provider = providerOverride;
  // Shrink the capture before it's sent: a full-page JPEG is still hundreds of
  // KB, and on the proxy (RU) path that becomes a chunked upload — fewer, faster
  // chunks the smaller it is. Fail-open (compressImageFiles returns it as-is).
  const shot = hasVisualMedia === true && screenshot
    ? (await compressImageFiles([screenshot]))[0]
    : null;
  // Owner-only diagnostics (lib/dev-trace.js). Subscribing to the reasoning
  // channel is what makes the model's thinking recordable at all, so only
  // attach the collector when a trace will actually be written — on every other
  // install this stays null and the sink drops the deltas as it always has.
  const tracing = await isDevModeActive();
  const reasoning = tracing ? createReasoningCollector() : null;
  if (reasoning) askOpts.onReasoning = (chunk) => reasoning.push(chunk);
  const startedAt = Date.now();
  // Recording the INPUT is the whole point: a wrong answer is either a bad
  // model or bad scraping, and only the verbatim page text tells them apart.
  const trace = tracing ? {
    kind: 'test',
    url: pageUrl,
    systemPrompt,
    userText,
    pageText: text || '',
    pageTextChars: String(text || '').length,
    effort: testEffort,
    hasVisualMedia: hasVisualMedia === true,
    screenshot: !!shot,
  } : null;
  let answer;
  try {
    answer = await askAI(systemPrompt, userText, shot ? [shot] : [], [], askOpts);
  } catch (e) {
    // A failed solve is exactly the run worth inspecting, so trace it too.
    if (trace) {
      void recordDevTrace({
        ...trace,
        ok: false,
        error: String(e?.message || e),
        durationMs: Date.now() - startedAt,
        reasoning: reasoning.value(),
        provider: usedProvider,
        model: usage?.model || null,
      });
    }
    throw e;
  }
  // An empty completion is a retryable provider failure, not a solved test.
  const empty = !answer || answer.trim() === '' || answer.trim() === EMPTY_ANSWER;
  if (trace) {
    // Re-parsing here is deliberate: parseTestAnswers is pure, so the
    // corrections it reports are exactly the ones the real parse downstream
    // will apply. Surfacing them is what lets a wrong-number regression be
    // spotted again instead of silently absorbed.
    const checks = [];
    const questions = empty ? [] : parseTestAnswers(answer, {
      onCheck: (check) => checks.push(check),
    });
    const corrections = checks.filter((check) => check.status === 'fixed');
    void recordDevTrace({
      ...trace,
      ok: !empty,
      error: empty ? 'Пустой ответ от ИИ.' : null,
      durationMs: Date.now() - startedAt,
      reasoning: reasoning.value(),
      rawAnswer: answer,
      questionCount: questions.length,
      corrections,
      checks,
      provider: usedProvider,
      model: usage?.model || null,
      usage,
    });
  }
  if (empty) throw new Error('Пустой ответ от ИИ. Попробуйте ещё раз.');
  track('test_solve', {
    ...usageFields(usedProvider, usage),
    files_img: shot ? 1 : 0,
    // Same observability as solve(): which effort testPageEffort() picked, so
    // low-effort mistakes on test pages show up in the dashboard, not in reviews.
    meta: { effort: testEffort }
  });
  return answer;
}

/**
 * Re-solve a SINGLE question on the current test page (the answer panel's
 * «перерешать» button) and ask the model for just that one question, optionally
 * telling it the previous answer so it can confirm or correct.
 *
 * A page click never confers activeTab, so this path can never take a FRESH
 * screenshot. When the panel was opened from the popup (which could), that
 * capture is passed back in and reused — otherwise a re-solve would answer from
 * strictly less material than the answer it is replacing, which is the opposite
 * of what «перерешать» promises. Reuse is safe because withMatchingTestCapture
 * below proves the page is still the exact one the image was taken of; on any
 * change the whole re-solve fails closed instead.
 *
 * Same licence/consent gate as solveTest. Returns the fresh answer string
 * ('' if nothing parseable came back).
 */
async function resolveOneQuestion(
  tabId,
  { index, prevAnswer, questionText } = {},
  panelCapture,
  panelScreenshot = null,
) {
  await ensureLicensed();
  if (!(await hasConsent())) throw new Error(CONSENT_REQUIRED_MESSAGE);
  // A retained screenshot carries the question on its own, so a page whose DOM
  // exposes almost no readable text (canvas/image questions — exactly where the
  // screenshot matters most) must not be refused outright.
  const { pageText, capture, hasVisualMedia } = await capturePageForPill(
    tabId,
    { allowThinText: !!panelScreenshot },
  );
  await withMatchingTestCapture(panelCapture, async () => capture, async () => undefined);
  // Off Mesh this re-solve obeys the same cost rule as the first answer: cheap
  // chain, low effort (see lib/web-solve.js). Mesh keeps 'high' — that is what
  // makes «перерешать» worth pressing on a graded test.
  const web = isWebCapture(capture);
  const systemPrompt = DEFAULT_PROMPTS[
    web ? PROMPT_CATEGORIES.WEB_ANSWER : PROMPT_CATEGORIES.TEST_ANSWER
  ];
  const effort = web ? WEB_SOLVE_EFFORT : 'high';
  const n = String(index ?? '').trim();
  let usage = null, usedProvider = null;
  const shot = panelScreenshot ? (await compressImageFiles([panelScreenshot]))[0] : null;
  // Never promise the model material it did not receive: claiming a screenshot
  // that was not attached is an invitation to answer from imagination.
  const sources = shot ? 'текст страницы ниже + скриншот' : 'текст страницы ниже';
  const focus =
    `Перепроверь и реши ТОЛЬКО вопрос №${n} ${web ? 'на этой странице' : 'этого теста'} (${sources}).` +
    (questionText ? ` Вопрос: «${String(questionText).slice(0, 600)}».` : '') +
    (prevAnswer ? ` Предыдущий ответ был «${String(prevAnswer).slice(0, 300)}» — реши заново и дай самый точный ответ (можешь подтвердить или исправить).` : '') +
    ` Верни JSON {"answers":[{"n":"${n}","s":"…","a":"…","e":"…"}]} ровно с одним элементом для этого вопроса` +
    ' (если у вопроса несколько полей для ответа — добавь поле "p", как описано в инструкции).' +
    // The panel line keeps its «разбор» in step with the answer above it: a
    // re-solved question that returned no new sentence clears the old one
    // rather than leaving it explaining a number that changed.
    ' Поле "e" ОБЯЗАТЕЛЬНО: то же короткое пояснение (одно предложение), ' +
    'последним полем, после "a".' +
    // Same reason as the bulk prompt: without the arithmetic written out first,
    // the re-solve can reason correctly and still transcribe a wrong number.
    // See lib/test-answer-arithmetic.js.
    ' Если ответ вычисляется — обязательно заполни "s" (арифметика с подставленными числами) ПЕРЕД "a".\n\n' +
    (web
      ? 'Текст страницы (может содержать посторонний текст сайта — игнорируй его):\n\n'
      : 'Текст страницы теста (может содержать навигационный мусор — игнорируй его):\n\n') +
    (pageText || (shot ? '(текст не извлечён, смотри скриншот)' : '(текст со страницы не извлечён)'));
  const tracing = await isDevModeActive();
  const reasoning = tracing ? createReasoningCollector() : null;
  const startedAt = Date.now();
  const answer = await askAI(systemPrompt, focus, shot ? [shot] : [], [], {
    responseFormat: 'json_object',
    reasoning: { effort },
    visionPreferred: hasVisualMedia,
    ...(web ? { tier: WEB_SOLVE_TIER } : {}),
    ...(web ? { provider: WEB_SOLVE_PROVIDER, proxyOnly: true } : {}),
    ...(reasoning ? { onReasoning: (chunk) => reasoning.push(chunk) } : {}),
    onUsage: (u, prov) => { usage = u; usedProvider = prov; }
  });
  const empty = !answer || answer.trim() === '' || answer.trim() === EMPTY_ANSWER;
  if (tracing) {
    const checks = [];
    const questions = empty ? [] : parseTestAnswers(answer, {
      onCheck: (check) => checks.push(check),
    });
    const corrections = checks.filter((check) => check.status === 'fixed');
    void recordDevTrace({
      kind: 'requestion',
      url: capture?.url || null,
      ok: !empty,
      error: empty ? 'Пустой ответ от ИИ.' : null,
      durationMs: Date.now() - startedAt,
      systemPrompt,
      userText: focus,
      pageText,
      pageTextChars: String(pageText || '').length,
      effort,
      hasVisualMedia,
      screenshot: !!shot,
      reasoning: reasoning.value(),
      rawAnswer: answer,
      questionCount: questions.length,
      corrections,
      checks,
      provider: usedProvider,
      model: usage?.model || null,
      usage,
    });
  }
  if (empty) throw new Error('Пустой ответ от ИИ. Попробуйте ещё раз.');
  track('test_requestion', {
    ...usageFields(usedProvider, usage),
    files_img: shot ? 1 : 0,
    meta: { effort, ...(web ? { web: 1 } : {}) },
  });
  const parsed = parseTestAnswers(answer);
  const match = parsed.find((q) => String(q.index) === n) || parsed[0];
  // Return parts too so a re-solved multi-field question (x & y, x₁ & x₂) still
  // fills every box, not just the first — and the fresh «разбор», so the panel
  // line's explanation belongs to the answer printed above it.
  const resolved = match
    ? { answer: match.answer, parts: match.parts || null, explain: match.explain || '' }
    : { answer: '', parts: null, explain: '' };
  return withMatchingTestCapture(capture, readTestCaptureContext, async () => resolved);
}

/**
 * Normalise the model's optional per-field `p` array into [{label, value}].
 * Accepts {l,v} (the prompt's shape), {label,value}, or a bare string. Used for
 * questions that need several separate values typed into separate boxes. Junk
 * (non-array, empty entries) collapses to [] so callers can treat it as absent.
 */
function normalizeParts(p) {
  if (!Array.isArray(p)) return [];
  const out = [];
  for (const it of p) {
    if (it == null) continue;
    if (typeof it === 'string') {
      const v = it.trim();
      if (v) out.push({ label: '', value: v });
      continue;
    }
    if (typeof it !== 'object') continue;
    const label = String(it.l ?? it.label ?? '').trim();
    const value = String(it.v ?? it.value ?? it.a ?? '').trim();
    if (value !== '' || label !== '') out.push({ label, value });
  }
  return out;
}

// The model is asked for one short sentence per question (see the "e" field in
// lib/prompts.js). This bounds what a model that ignored the cap can put on a
// panel line — and keeps the field well inside the privileged-message limit
// that validQuestion enforces on the way back in.
const MAX_EXPLANATION_CHARS = 240;

/**
 * Map the model's {answers:[{n,s,a,e}]} reply to the panel's
 * {index, text, answer, explain} shape.
 * Tiered like the popup's formatter so a truncated reply still surfaces
 * what arrived: whole JSON → embedded JSON → loose "n"/"a" pair regex.
 * The TEST_ANSWER prompt doesn't return per-question text, so `text` is "".
 *
 * This is also where the model's shown arithmetic ("s") is re-computed and, on
 * a mismatch, allowed to correct "a" — see lib/test-answer-arithmetic.js for
 * the bug that made that necessary. Doing it HERE and nowhere else matters:
 * every consumer (popup, in-page panel, autofill, the reuse cache, the
 * per-question «перерешать») funnels through this one function, so a corrected
 * answer is the only answer that exists downstream. "s" itself is dropped —
 * it is scaffolding for generation, not something any consumer should see.
 *
 * @param {string} raw the model's reply
 * @param {{onCheck?: (check: object) => void}} [options] observer receiving one
 *   record per answer ('verified' | 'fixed' | 'unchecked') for the owner-only
 *   diagnostics trace; never affects the returned questions.
 */
function parseTestAnswers(raw, { onCheck = null } = {}) {
  if (!raw || typeof raw !== 'string') return [];
  const make = (n, a, c, p, s, e) => {
    const stated = String(a ?? '').trim();
    const { answer, ...check } = reconcileAnswer(stated, s);
    if (onCheck) {
      try {
        onCheck({ ...check, index: typeof n === 'number' ? n : String(n ?? '').trim() });
      } catch { /* an observer must never break a solve */ }
    }
    const q = {
      index: typeof n === 'number' ? n : (String(n).trim() || ''),
      text: '',
      answer
    };
    // Optional option letter/number for choice questions — a fill-only hint the
    // matcher (scraper.js) uses to break ties when option text is ambiguous.
    // Absent in the legacy {n,a} shape; panel/copy never read it.
    if (c != null && String(c).trim() !== '') q.choice = String(c).trim();
    // Optional per-field values for a question with SEVERAL answer boxes (a
    // system's x & y, a quadratic's x₁ & x₂, several blanks). The model returns
    // `p:[{l,v}]`; scraper.js spreads them across the boxes. `answer` still
    // carries the combined human-readable string for the panel/copy.
    const parts = normalizeParts(p);
    if (parts.length) q.parts = parts;
    // The one-sentence «разбор» the answer panel reveals behind its chevron.
    // Dropped outright when the checker OVERTURNED the answer: that sentence
    // explains the number the model wrote, not the corrected one the student
    // now sees, and a confident explanation of a replaced value is worse than
    // no explanation at all.
    const explain = check.status === 'fixed'
      ? ''
      : String(e ?? '').trim().slice(0, MAX_EXPLANATION_CHARS);
    if (explain) q.explain = explain;
    return q;
  };
  const fromObj = (obj) => {
    if (!obj || !Array.isArray(obj.answers)) return null;
    const out = obj.answers
      .filter((x) => x && x.a != null && x.n != null)
      .map((x) => make(x.n, x.a, x.c, x.p, x.s, x.e));
    return out.length ? out : null;
  };
  try { const r = fromObj(JSON.parse(raw)); if (r) return r; } catch { /* not pure JSON */ }
  const embedded = raw.match(/\{[\s\S]*\}/);
  if (embedded) {
    try { const r = fromObj(JSON.parse(embedded[0])); if (r) return r; } catch { /* embedded failed */ }
  }
  const out = [];
  // Last-resort salvage for a reply that never closed its JSON. The optional
  // "s" group is NOT cosmetic: the prompt now puts "s" between "n" and "a", so
  // without it this tier would match nothing on exactly the truncated replies
  // it exists to rescue. "e" is deliberately NOT rescued here — it trails "a"
  // behind the optional "c"/"p", and a pattern loose enough to skip those is
  // loose enough to pick up the neighbouring answer's. A truncated reply
  // surfaces its answers without the «разбор»; the answers are the point.
  const re = /"n"\s*:\s*(?:"([^"]*)"|([^\s,}]+))\s*,\s*(?:"s"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*)?"a"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const n = (m[1] ?? m[2] ?? '').trim();
    const s = m[3];
    let a = m[4];
    try { a = JSON.parse('"' + a + '"'); } catch { /* keep raw escapes */ }
    out.push(make(n, a, null, null, s));
  }
  return out;
}

/**
 * Inverse of parseTestAnswers: rebuild the model's own {answers:[{n,a,c,p}]}
 * wire shape from stored questions. Used when a test page is answered from the
 * reuse cache instead of the provider — the popup formatter and every other
 * consumer then keep the single code path they already have, and a round trip
 * through parseTestAnswers returns the identical question objects.
 */
function serializeTestAnswers(questions) {
  return JSON.stringify({
    answers: (questions || []).map((question) => {
      const wire = { n: question.index, a: question.answer };
      if (question.choice != null && String(question.choice).trim() !== '') wire.c = question.choice;
      if (Array.isArray(question.parts) && question.parts.length) {
        wire.p = question.parts.map((part) => ({ l: part.label, v: part.value }));
      }
      // Last, exactly as the prompt orders it — a cached page must round-trip
      // to the identical question objects, «разбор» included, or reopening a
      // solved test would silently lose the explanations it was solved with.
      if (question.explain != null && String(question.explain).trim() !== '') {
        wire.e = question.explain;
      }
      return wire;
    })
  });
}

/**
 * Render the parsed answers as a floating panel on the test tab. The popup
 * still shows them too — the panel just outlives the popup so the user can
 * keep reading while they fill the form. Best-effort: a restricted page or
 * an in-flight navigation just means no panel; the popup is the fallback.
 */
const answerPanelContexts = new Map();
const PANEL_NONCE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPanelNonce(value) {
  return typeof value === 'string' && PANEL_NONCE_RE.test(value);
}

function matchingAnswerPanelContext(tabId, panelNonce, { requireReady = true } = {}) {
  const context = answerPanelContexts.get(tabId);
  if (!context || context.panelNonce !== panelNonce || (requireReady && !context.ready)) {
    throw testCaptureChangedError();
  }
  return context;
}

function deleteAnswerPanelContext(tabId, panelNonce) {
  if (answerPanelContexts.get(tabId)?.panelNonce === panelNonce) {
    answerPanelContexts.delete(tabId);
  }
}

async function showAnswersInTab(tabId, questions, capture, screenshot = null) {
  if (!tabId || !questions.length) return;
  const capturedTop = capture.documents.find((document) => document.documentId === capture.documentId);
  if (!capturedTop) throw testCaptureChangedError();
  // Mint a worker-only panel generation before the first await. This
  // immediately revokes every older panel in the tab, including an old click
  // already waiting to request its action token. The context becomes usable
  // only after SHOW_ANSWERS succeeds and the exact capture is revalidated.
  const panelNonce = crypto.randomUUID();
  const retainedScreenshot =
    screenshot && typeof screenshot.dataBase64 === 'string' &&
    screenshot.dataBase64.length <= MAX_PANEL_SCREENSHOT_CHARS
      ? screenshot
      : null;
  answerPanelContexts.set(tabId, {
    capture, panelNonce, ready: false, screenshot: retainedScreenshot
  });
  try {
    await executeScriptInCapturedDocuments(capture, {
      documentIds: [capture.documentId],
      files: ['src/content/answer-panel.js', 'src/content/scraper.js']
    });
  } catch { /* manifest may already have injected, or the page disallows scripting */ }
  try {
    await withMatchingTestCapture(capture, readTestCaptureContext, async () => {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'SHOW_ANSWERS',
        payload: {
          questions,
          panelNonce,
          capture: {
            url: capture.url,
            pageId: capturedTop.pageId,
            signature: capturedTop.signature,
            principal: capturedTop.principal,
          },
        },
      }, { documentId: capture.documentId });
      if (!response?.ok) throw new Error(response?.error || 'answer panel unavailable');
      await withMatchingTestCapture(capture, readTestCaptureContext, async () => {
        const current = matchingAnswerPanelContext(tabId, panelNonce, { requireReady: false });
        current.ready = true;
      });
    });
  } catch (error) {
    deleteAnswerPanelContext(tabId, panelNonce);
    // A late failure from panel A must not hide panel B. The content-side hide
    // also checks this nonce before removing anything.
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'HIDE_ANSWERS',
        payload: { panelNonce },
      }, { documentId: capture.documentId });
    } catch { /* navigated or content script unavailable */ }
    if (error?.code === TEST_CAPTURE_CHANGED) throw error;
    // No receiver — content script blocked on this page. The popup remains the
    // fallback, and the pending capability was revoked above.
  }
}

/* ---------- Attachment downloads (cross-origin, host_permissions) ---------- */
// The content script discovers the file URLs (same-origin API call), but the
// download must run HERE: only the service worker gets the extension's
// host_permissions for cross-origin hosts like uchebnik.mos.ru. There is no
// FileReader in a service worker, so base64 is encoded from the bounded stream.

function abToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000; // chunk so String.fromCharCode args don't overflow the stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function nameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'attachment'; }
  catch { return 'attachment'; }
}

// Mesh frequently serves attachments as application/octet-stream. Downstream
// (openrouter/groq) routes PDFs and images by mime, so recover the real type
// from the filename extension whenever the server's content-type is generic.
const EXT_MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf', md: 'text/markdown',
  mp3: 'audio/mpeg', mpga: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', aac: 'audio/aac',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function inferMime(name, contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  const ext = (name.split('.').pop() || '').toLowerCase();
  // A known extension is the most reliable signal for Mesh attachments: the
  // store serves a generic content-type often, and a mislabeled one sometimes
  // (e.g. text/plain or application/download for a real .pdf). Downstream
  // routing keys on the exact mime, so trust the extension whenever we know it
  // and only fall back to a specific content-type for unrecognized extensions.
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (ct && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') return ct;
  return 'application/octet-stream';
}

// Attachment discovery only has two concrete Mesh origins in this codebase:
// family-web files under school.mos.ru and digital-textbook files under
// uchebnik.mos.ru. Paths containing generic words like /files/ or /storage/
// are NOT a reason to turn an arbitrary host into a privileged fetch target.
const ATTACHMENT_HOSTS = new Set(['school.mos.ru', 'uchebnik.mos.ru']);
const ATTACHMENT_REDIRECT_LIMIT = 3;

function isIpLiteralHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (host.includes(':')) return true; // URL.hostname keeps IPv6 brackets in Chrome
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function parseAttachmentUrl(raw, base) {
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (isIpLiteralHost(host) || !ATTACHMENT_HOSTS.has(host)) return null;
    return url;
  } catch { return null; }
}

function isAllowedAttachmentUrl(raw) {
  return !!parseAttachmentUrl(raw);
}

async function readBoundedBody(response, maxBytes, controller) {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length.trim()) && Number(length) > maxBytes) {
    controller.abort();
    return null;
  }
  if (!response.body?.getReader) {
    controller.abort();
    return null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('attachment too large'); } catch { /* already closed */ }
        controller.abort();
        return null;
      }
      chunks.push(value);
    }
  } catch (e) {
    if (!controller.signal.aborted) throw e;
    return null;
  }
  // `null` means "refused" (over the cap, unreadable, aborted). A zero-length
  // body is a legitimate read of an empty file and comes back as empty bytes so
  // callers can report the two apart instead of logging a size failure.
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function downloadFile(rawUrl, headers, maxBytesCap = Infinity) {
  const original = parseAttachmentUrl(rawUrl);
  if (!original) { dbg('[СМЭШ AI] rejected attachment URL'); return null; }
  let current = original;
  const ctrl = new AbortController();
  // One deadline covers every redirect, response headers and the full streamed
  // body. A timer cleared immediately after fetch() would still let read() hang.
  const timer = setTimeout(() => ctrl.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= ATTACHMENT_REDIRECT_LIMIT; redirects++) {
      const sameOriginalOrigin = current.origin === original.origin;
      // Redirects are never delegated to fetch(): that would make validation of
      // intermediate targets impossible. Mesh credentials exist only on the
      // original origin; an allowlisted cross-origin hop gets an empty header
      // set and no ambient cookies.
      const res = await fetch(current.href, {
        redirect: 'manual',
        headers: sameOriginalOrigin ? headers : {},
        credentials: sameOriginalOrigin ? 'include' : 'omit',
        signal: ctrl.signal
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        let next;
        try {
          if (redirects >= ATTACHMENT_REDIRECT_LIMIT) return null;
          next = parseAttachmentUrl(res.headers.get('location'), current);
          if (!next) return null;
        } finally {
          try { await res.body?.cancel('redirect response discarded'); } catch { /* already closed */ }
        }
        current = next;
        continue;
      }
      if (!res.ok) {
        dbg('[СМЭШ AI] download http', res.status);
        try { await res.body?.cancel('error response discarded'); } catch { /* already closed */ }
        return null;
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html') || ct.includes('text/xml')) {
        dbg('[СМЭШ AI] download got HTML (auth redirect?)');
        try { await res.body?.cancel('non-file response discarded'); } catch { /* already closed */ }
        return null;
      }
      const name = nameFromUrl(current.href);
      const mimeType = inferMime(name, ct);
      const typeMaxBytes = isAudioFile({ name, mimeType })
        ? MAX_AUDIO_UPLOAD_BYTES
        : MAX_STANDARD_UPLOAD_BYTES;
      const maxBytes = Math.min(typeMaxBytes, maxBytesCap);
      const bytes = await readBoundedBody(res, maxBytes, ctrl);
      if (!bytes) { dbg('[СМЭШ AI] download size limit skip'); return null; }
      if (!bytes.byteLength) { dbg('[СМЭШ AI] download empty file skip'); return null; }
      dbg('[СМЭШ AI] attachment downloaded', bytes.byteLength + 'b');
      return { mimeType, dataBase64: abToBase64(bytes), name, byteLength: bytes.byteLength };
    }
  } catch (e) {
    dbg('[СМЭШ AI] download exception', e?.name || 'Error');
    return null;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return null;
}

// Reconstruct the fixed MESH header set from the one-time token. Arbitrary
// caller-controlled headers are never accepted at this privileged boundary.
function meshHeadersFromToken(token) {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-mes-subsystem': 'familyweb',
    'X-Mes-Role': 'student',
    'X-Mes-RoleId': '1',
    Authorization: 'Bearer ' + token
  };
}

async function verifyHomeworkDownloadBinding({
  tabId,
  scanId,
  principal,
  principalError,
  rowToken,
} = {}) {
  const { weekHomework } = await chrome.storage.local.get('weekHomework');
  if (!principalBindingMatches({
    cacheScanId: weekHomework?.scanId,
    launchScanId: scanId,
    cachePrincipal: weekHomework?.principal,
    launchPrincipal: principal,
    cacheError: weekHomework?.principalError,
    launchError: principalError,
  })) {
    throw new Error(
      'Скан домашних заданий или профиль дневника изменился. Обновите список и повторите.'
    );
  }
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: 'MESH_VERIFY_HOMEWORK_CONTEXT',
      principal,
      principalError,
      rowToken,
    });
  } catch { /* navigated, renderer gone, or content script unavailable */ }
  if (!response?.ok || response.matches !== true) {
    throw new Error(
      'Страница, аккаунт или ученик изменился. Обновите список и повторите.'
    );
  }
}

// Only the MESH content script can call this. The token is used in memory for
// this bounded download and is never returned, persisted or logged.
async function downloadFiles(payload = {}) {
  const { urls = [], token = null } = payload;
  const hdrs = meshHeadersFromToken(token);
  const files = [];
  let totalBytes = 0;
  await verifyHomeworkDownloadBinding(payload);
  // Automatic Mesh downloads keep the standard 6 MiB local-allocation cap.
  // Manually selected audio has its own pre-read 25 MiB guard and is separately
  // budgeted by validateRequestFileBudget before Whisper transcription.
  for (const url of urls.slice(0, 5)) {
    await verifyHomeworkDownloadBinding(payload);
    const remainingBytes = MAX_REQUEST_FILE_BYTES - totalBytes;
    if (remainingBytes <= 0) break;
    if (!isAllowedAttachmentUrl(url)) continue;
    const f = await downloadFile(url, hdrs, remainingBytes);
    // A profile/scan switch while bytes were in flight invalidates the result.
    // Recheck before retaining even one byte in the response.
    await verifyHomeworkDownloadBinding(payload);
    if (f) {
      totalBytes += f.byteLength;
      const { byteLength, ...file } = f;
      files.push(file);
    }
  }
  await verifyHomeworkDownloadBinding(payload);
  return files;
}

/**
 * MAIN-world MathQuill filler. Mesh renders fraction / coordinate answer boxes
 * (the «x₁ =» roots, the «( ; )» pairs — task ids like 95651) as MathQuill
 * fields: an editable <span class="mq-editable-field" id="i-mathquill-input-…">
 * plus a hidden <input name="input_answer__…"> the form actually submits.
 * Setting the underlying textarea does nothing (MathQuill parses keystrokes), so
 * the ONLY clean way is the MathQuill API: `MQ(field).latex(value)` updates the
 * display + model, then we mirror the result into the hidden input for submit.
 *
 * This runs in the page's MAIN world (it needs window.MQ / window.MathQuill,
 * which the isolated content-script world can't see). It is fully self-contained
 * — executeScript serialises it, so it must reference nothing outside. Returns
 * the list of question ids whose fields were filled. NEVER submits.
 */
async function fillMathQuillMain(questions, expectedDocuments) {
  try {
    var root = document.documentElement;
    var capturePage = root && root.getAttribute('data-smesh-capture-page');
    var expectedDocument = capturePage && expectedDocuments && expectedDocuments[capturePage];
    var expectedSignature = expectedDocument && expectedDocument.signature;
    var expectedPrincipal = expectedDocument && expectedDocument.principal;
    var captureStillMatches = function () {
      return !!expectedSignature && root &&
        root.getAttribute('data-smesh-capture-page') === capturePage &&
        root.getAttribute('data-smesh-capture-signature') === expectedSignature &&
        root.getAttribute('data-smesh-capture-principal') === expectedPrincipal;
    };
    if (!captureStillMatches()) return { ok: false, stale: true, filled: [] };
    // Resolve the MathQuill v2 interface (Mesh exposes window.MQ).
    var MQ = (typeof window.MQ === 'function') ? window.MQ : null;
    if (!MQ && window.MathQuill) {
      if (typeof window.MathQuill.getInterface === 'function') MQ = window.MathQuill.getInterface(2);
      else if (typeof window.MathQuill === 'function') MQ = window.MathQuill;
    }
    var fields = Array.prototype.slice.call(document.querySelectorAll('.mq-editable-field'));
    if (typeof MQ !== 'function' || !fields.length) {
      return { ok: false, filled: [], reason: (typeof MQ !== 'function') ? 'no-mathquill' : 'no-fields' };
    }

    // Number each field by the nearest preceding «ЗАДАНИЕ №N» heading (document
    // order) — the SAME association the content script uses for plain inputs.
    // This intentionally mirrors scraper.js collectQuestionMarkers (text-node
    // walk; accept when the heading is short OR leads its text, plus the
    // split-span «ЗАДАНИЕ»|«№1» case) so a formula question (№1/№5) is numbered
    // identically to its plain-input neighbours. The earlier element-scan used a
    // stricter length cap and no split-span handling, so a heading rendered
    // inline with a long prompt would be missed and the formula box left unfilled.
    var QRE = /(?:вопрос|задани[ея])\s*[№#]?\s*(\d{1,3})/i;
    var QALL = /(?:вопрос|задани[ея])\s*[№#]?\s*\d{1,3}/gi;
    var QINSTRUCTIONPREFIX = /^(?:выполните|решите|ответьте(?:\s+на)?|выберите|укажите|заполните|сопоставьте|прочитайте|рассмотрите|определите|найдите|вычислите)$/i;
    var QTECHPREFIX = /^(?:id|task)\s*[#№-]?\s*\d+$/i;
    var QREFSUFFIX = /^(?:(?:в|по)\s+(?:учебник\p{L}*|тетрад\p{L}*|параграф\p{L}*|глав\p{L}*|раздел\p{L}*)|из\s+(?:учебник\p{L}*|параграф\p{L}*|глав\p{L}*|раздел\p{L}*|упражнен\p{L}*|задани\p{L}*)|на\s+(?:страниц\p{L}*|стр(?:аниц\p{L}*|\.)?|сайт\p{L}*|портал\p{L}*))(?=\s|[.,;:!?…)}\]»"'—–-]|$)/iu;
    var QSEPARATOR = /^[.:—–-]/;
    var QSCOPE = /^(?:H[1-6]|P|LI|LEGEND|DT|DD|DIV)$/;
    var isHeadingNode = function (node) {
      var element = node && node.nodeType === 1 ? node : node && node.parentElement;
      for (var depth = 0; depth < 4 && element; depth++, element = element.parentElement) {
        var tag = String(element.tagName || '').toUpperCase();
        var role = '';
        try { role = String(element.getAttribute && element.getAttribute('role') || '').toLowerCase(); } catch (eRole) { role = ''; }
        if (/^H[1-6]$/.test(tag) || tag === 'LEGEND' || role.split(/\s+/).indexOf('heading') !== -1) return true;
      }
      return false;
    };
    var markerTextScope = function (textNode) {
      var element = textNode && textNode.parentElement;
      var fallback = element;
      for (var depth = 0; depth < 4 && element; depth++, element = element.parentElement) {
        fallback = element;
        var tag = String(element.tagName || '').toUpperCase();
        var role = '';
        try { role = String(element.getAttribute && element.getAttribute('role') || '').toLowerCase(); } catch (eRole) { role = ''; }
        if (QSCOPE.test(tag) || role.split(/\s+/).indexOf('heading') !== -1) return element;
      }
      return fallback;
    };
    var boundedMarkerText = function (scope, maxChars) {
      maxChars = maxChars || 160;
      var walker;
      try { walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null); }
      catch (eWalker) { return ''; }
      var text = '';
      var node;
      while ((node = walker.nextNode())) {
        var part = String(node.nodeValue || '');
        if (text.length + part.length + 1 > maxChars) return '';
        text += ' ' + part;
      }
      return text.replace(/\s+/g, ' ').trim();
    };
    var isAuthoritativeMarker = function (text, match, node) {
      var prefix = text.slice(0, match.index).trim().replace(/[.:—–-]+$/, '').trim();
      var instructionPrefix = QINSTRUCTIONPREFIX.test(prefix);
      var technicalPrefix = QTECHPREFIX.test(prefix);
      if (prefix && !instructionPrefix && !technicalPrefix) return false;
      var suffix = text.slice(match.index + match[0].length).trim();
      var semanticSuffix = suffix.replace(/^[.,;:—–-]+\s*/, '');
      if (QREFSUFFIX.test(semanticSuffix)) return false;
      if (!suffix || match.index === 0 || technicalPrefix) return true;
      return isHeadingNode(node) || QSEPARATOR.test(suffix);
    };
    var markers = [];
    var qRoot = document.body || document.documentElement;
    if (qRoot) {
      var qWalker = document.createTreeWalker(qRoot, NodeFilter.SHOW_TEXT, null);
      var checkedScopes = new Set();
      var tn;
      while ((tn = qWalker.nextNode())) {
        var raw = tn.nodeValue;
        if (!raw || !/задани|вопрос/i.test(raw)) continue;
        var s = raw.replace(/\s+/g, ' ').trim();
        var mm = s.match(QRE);
        var markerNode = tn.parentElement || tn;
        var scope = markerTextScope(tn);
        if (scope) {
          var ps = boundedMarkerText(scope, 160);
          var scopedMarkers = ps ? ps.match(QALL) : null;
          var pm = scopedMarkers && scopedMarkers.length === 1 ? ps.match(QRE) : null;
          if (pm) {
            if (checkedScopes.has(scope)) continue;
            checkedScopes.add(scope);
            s = ps;
            mm = pm;
            markerNode = scope;
          }
        }
        // A real heading is short OR leads its text (a task-id badge may sit just
        // before it); a deep mention inside prose is not a heading.
        if (mm && isAuthoritativeMarker(s, mm, markerNode) &&
            (s.length <= 60 || mm.index <= 20 || isHeadingNode(markerNode))) {
          markers.push({ n: parseInt(mm[1], 10), node: markerNode });
        }
      }
    }
    var numFor = function (node) {
      var num = null;
      for (var j = 0; j < markers.length; j++) {
        var pos = markers[j].node.compareDocumentPosition(node);
        if (pos & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY)) num = markers[j].n;
        else if (pos & Node.DOCUMENT_POSITION_PRECEDING) break;
      }
      return num;
    };
    var byNum = {};
    for (var k = 0; k < fields.length; k++) {
      var n = numFor(fields[k]);
      if (n == null) continue;
      (byNum[n] = byNum[n] || []).push(fields[k]);
    }

    // A plain value → LaTeX. Simple signed fractions «-8/3» become \frac so they
    // render and check the way a typed answer would; everything else passes through.
    var toLatex = function (v) {
      v = String(v == null ? '' : v).trim();
      var fm = v.match(/^(-?)(\d+)\s*\/\s*(\d+)$/);
      if (fm) return fm[1] + '\\frac{' + fm[2] + '}{' + fm[3] + '}';
      return v;
    };
    // MathQuill may normalize harmless presentation details, but a merely
    // non-empty readback is not evidence that it accepted THIS answer: a
    // rejected setter can leave an older wrong value in place. Canonicalize
    // only known representation-only differences and otherwise require an
    // exact semantic token sequence.
    var canonicalLatex = function (value) {
      var text = String(value == null ? '' : value).trim()
        .replace(/^\$+|\$+$/g, '')
        .replace(/\u2212/g, '-')
        .replace(/\\(?:left|right)/g, '')
        .replace(/\\(?:dfrac|tfrac)/g, '\\frac')
        .replace(/\\[,;:! ]/g, '')
        .replace(/\s+/g, '');
      var changed = true;
      while (changed && text.length >= 2 && text[0] === '{' && text[text.length - 1] === '}') {
        changed = false;
        var depth = 0;
        for (var ci = 0; ci < text.length; ci++) {
          if (text[ci] === '{') depth++;
          else if (text[ci] === '}') depth--;
          if (depth === 0 && ci < text.length - 1) break;
        }
        if (depth === 0 && ci === text.length) {
          text = text.slice(1, -1);
          changed = true;
        }
      }
      // Treat only simple numeric fractions as equivalent across MathQuill's
      // common sign placement (`-\\frac{8}{3}` vs `\\frac{-8}{3}`).
      var fraction = text.match(/^(-?)\\frac\{([+-]?\d+(?:[.,]\d+)?)\}\{([+-]?\d+(?:[.,]\d+)?)\}$/);
      if (fraction) {
        var numerator = fraction[2].replace(',', '.');
        if (fraction[1] === '-' && numerator[0] === '-') numerator = numerator.slice(1);
        else if (fraction[1] === '-' && numerator[0] !== '-') numerator = '-' + numerator;
        return numerator + '/' + fraction[3].replace(',', '.');
      }
      var plainFraction = text.match(/^([+-]?\d+(?:[.,]\d+)?)\/([+-]?\d+(?:[.,]\d+)?)$/);
      if (plainFraction) {
        return plainFraction[1].replace(',', '.') + '/' + plainFraction[2].replace(',', '.');
      }
      return text;
    };
    // Per-field values for a question: prefer the model's structured parts, else
    // pull signed numbers / fractions out of the answer in order (handles a
    // coordinate answer like «(2; 3) и (2; -3)» → 2, 3, 2, -3).
    var valuesFor = function (q) {
      if (q.parts && q.parts.length) return q.parts.map(function (p) { return p.value; });
      var a = String(q.answer || '').trim();
      return a.match(/-?\d+(?:\/\d+)?(?:[.,]\d+)?/g) || [];
    };

    var filled = [];
    for (var qi = 0; qi < questions.length; qi++) {
      var q = questions[qi];
      var id = (q.index != null && String(q.index).trim() !== '') ? q.index : (qi + 1);
      var flds = byNum[id];
      if (!flds || !flds.length) continue;
      var vals = valuesFor(q);
      // A numbered MathQuill unit may contain several answer fields. Pagination
      // is destructive, so one successful field must not certify the whole
      // question while another field stayed empty or rejected its value.
      var complete = flds.length > 0;
      for (var f = 0; f < flds.length; f++) {
        if (!captureStillMatches()) return { ok: false, stale: true, filled: filled };
        var val = (vals[f] != null) ? vals[f] : (vals.length === 1 ? vals[0] : '');
        if (val === '' || val == null) { complete = false; continue; }
        try {
          // MQ(el) returns the EXISTING field; fall back to (re)wrapping it as a
          // MathField if the interface entry point differs. We still mirror the
          // hidden input below, so even a re-wrap (which could drop Mesh's own
          // edit handler) submits correctly.
          var field = MQ(flds[f]);
          if (!field || typeof field.latex !== 'function') {
            if (typeof MQ.MathField === 'function') { try { field = MQ.MathField(flds[f]); } catch (e0) { field = null; } }
          }
          if (!field || typeof field.latex !== 'function') { complete = false; continue; }
          var intendedLatex = toLatex(val);
          var intendedCanonical = canonicalLatex(intendedLatex);
          if (!intendedCanonical) { complete = false; continue; }
          field.latex(intendedLatex);
          // MathQuill and its page handlers may synchronously replace the SPA
          // question while reusing a field node. Yield to the isolated-world
          // capture observer, then stop before read-back or hidden-input writes
          // if the question/account signature changed.
          await new Promise(function (resolve) { setTimeout(resolve, 0); });
          if (!captureStillMatches() || !document.documentElement.contains(flds[f])) {
            return { ok: false, stale: true, filled: filled };
          }
          // Honest read-back: MathQuill can silently ignore LaTeX and retain an
          // older, non-empty answer. Require the value we intended, allowing
          // only the representation-only normalizations above.
          var after = '';
          try { var got = field.latex(); after = String(got == null ? '' : got).trim(); } catch (eR) { after = ''; }
          if (!after || canonicalLatex(after) !== intendedCanonical) {
            complete = false;
            continue;
          }
          // Mirror the accepted LaTeX into the hidden input the form submits
          // (same id, "input"→"hidden-input").
          var hid = flds[f].id ? document.getElementById(flds[f].id.replace('i-mathquill-input-', 'i-mathquill-hidden-input-')) : null;
          if (hid) {
            hid.value = after;
            try { hid.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) { /* */ }
            await new Promise(function (resolve) { setTimeout(resolve, 0); });
            if (!captureStillMatches() || !document.documentElement.contains(flds[f])) {
              return { ok: false, stale: true, filled: filled };
            }
            try { hid.dispatchEvent(new Event('change', { bubbles: true })); } catch (e3) { /* */ }
            await new Promise(function (resolve) { setTimeout(resolve, 0); });
            if (!captureStillMatches() || !document.documentElement.contains(flds[f])) {
              return { ok: false, stale: true, filled: filled };
            }
          }
          // Controlled fields sometimes accept synchronously and then restore
          // their prior model value. Verify both the visible MathQuill model and
          // the hidden submission value after that delayed reconciliation.
          await new Promise(function (resolve) { setTimeout(resolve, 80); });
          if (!captureStillMatches() || !document.documentElement.contains(flds[f])) {
            return { ok: false, stale: true, filled: filled };
          }
          var settled = '';
          try {
            var settledValue = field.latex();
            settled = String(settledValue == null ? '' : settledValue).trim();
          } catch (eS) { settled = ''; }
          if (canonicalLatex(settled) !== intendedCanonical ||
              (hid && canonicalLatex(hid.value) !== intendedCanonical)) {
            complete = false;
            continue;
          }
        } catch (e) { complete = false; /* this field failed; others still try */ }
      }
      if (complete) filled.push(String(id));
    }
    return { ok: true, filled: filled };
  } catch (e) {
    return { ok: false, filled: [], reason: String(e) };
  }
}

/**
 * Capture a bounded, read-only inventory of fillable question units from every
 * exact document that produced the AI input. The page helper reports no prompt
 * text or values, only mechanism/type/number/ordinal. Any missing document,
 * malformed result, duplicate injection result, or oversized page marks the
 * inventory inexact; autofill may still make useful progress, but autopilot is
 * then forbidden from leaving the page.
 */
const MAX_AUTOPILOT_INVENTORY_UNITS = 512;
async function readAutopilotCoverage(capture, expectedDocuments) {
  let results;
  try {
    results = await executeScriptInCapturedDocuments(capture, {
      func: (expected) => {
        try {
          const pageId = window.__smeshCaptureDocumentId;
          const expectedDocument = pageId && expected[pageId];
          const currentSignature = (typeof window.__smeshPageSig === 'function')
            ? window.__smeshPageSig() : '';
          const currentPrincipal = (typeof window.__smeshCurrentPrincipal === 'function')
            ? window.__smeshCurrentPrincipal() : '';
          if (!expectedDocument || expectedDocument.signature !== currentSignature ||
              expectedDocument.principal !== currentPrincipal) return { stale: true };
          const inventory = (typeof window.__smeshQuestionInventory === 'function')
            ? window.__smeshQuestionInventory() : null;
          return { inventory };
        } catch { return { inventory: null }; }
      },
      args: [expectedDocuments]
    });
  } catch {
    throw testCaptureChangedError();
  }

  if ((results || []).some((entry) => entry?.result?.stale)) {
    throw testCaptureChangedError();
  }
  const expectedIds = new Set(capture.documents.map((document) => document.documentId));
  const seen = new Set();
  const units = [];
  let exact = Array.isArray(results) && results.length === expectedIds.size;
  for (const entry of (results || [])) {
    if (!expectedIds.has(entry?.documentId) || seen.has(entry.documentId)) {
      exact = false;
      continue;
    }
    seen.add(entry.documentId);
    const inventory = entry?.result?.inventory;
    if (inventory?.ok !== true || !Array.isArray(inventory.units) ||
        inventory.units.length > MAX_AUTOPILOT_INVENTORY_UNITS) {
      exact = false;
      continue;
    }
    for (const unit of inventory.units) {
      const valid = unit && typeof unit === 'object' &&
        (unit.source === 'native' || unit.source === 'interactive' || unit.source === 'mathquill') &&
        typeof unit.type === 'string' && unit.type.length > 0 && unit.type.length <= 32 &&
        (unit.id == null || (typeof unit.id === 'string' && /^\d{1,3}$/.test(unit.id))) &&
        Number.isInteger(unit.ordinal) && unit.ordinal >= 0 &&
        unit.ordinal < MAX_AUTOPILOT_INVENTORY_UNITS;
      if (!valid) { exact = false; continue; }
      if (units.length >= MAX_AUTOPILOT_INVENTORY_UNITS) {
        exact = false;
        continue;
      }
      units.push({
        documentId: entry.documentId,
        source: unit.source,
        type: unit.type,
        id: unit.id == null ? null : unit.id,
        ordinal: unit.ordinal,
      });
    }
  }
  if (seen.size !== expectedIds.size || units.length > MAX_AUTOPILOT_INVENTORY_UNITS) exact = false;
  return { exact, units: exact ? units : [] };
}

/**
 * Fill the test form across EVERY frame of the tab. The Mesh test player is
 * sometimes embedded in an iframe on the exact uchebnik.mos.ru origin, so a fill that
 * only touches the top frame finds no controls and skips everything. We inject
 * the fill logic into all accessible frames, run it in each, then merge: a
 * question counts as filled if ANY frame filled it. Frames the extension can't
 * script (foreign-origin embeds) are skipped silently. Never submits the form.
 */
async function fillAllFrames(tabId, questions, capture) {
  if (!tabId || !Array.isArray(questions) || !questions.length) {
    return { filled: [], skipped: [], coverage: { exact: false, units: [] } };
  }
  // A generic page is one document and one merged control list, so it takes the
  // single-pass filler instead of the Mesh cross-frame passes. Routing it here
  // is what makes the answer panel's «Заполнить» work off Mesh too.
  if (isWebCapture(capture)) return fillWebAnswersInTab(capture, questions);
  const idFor = (q, i) =>
    (q && q.index != null && String(q.index).trim() !== '') ? q.index : i + 1;
  const expectedDocuments = Object.fromEntries(
    capture.documents.map((document) => [document.pageId, {
      signature: document.signature,
      principal: document.principal,
    }])
  );

  // Make sure the fill logic exists only in the documents that produced the AI
  // input. A tabId/allFrames target can silently jump to a replacement page.
  try {
    await executeScriptInCapturedDocuments(capture, {
      files: ['src/content/scraper.js']
    });
  } catch {
    throw testCaptureChangedError();
  }

  // The file injection above is read-only. Revalidate after it and immediately
  // before the first form mutation, so a solve from a previous URL, document,
  // or question cannot reach the current page.
  await withMatchingTestCapture(capture, readTestCaptureContext, async () => undefined);
  const coverage = await readAutopilotCoverage(capture, expectedDocuments);

  let results = [];
  try {
    results = await executeScriptInCapturedDocuments(capture, {
      func: (qs, expected) => {
        try {
          const pageId = window.__smeshCaptureDocumentId;
          const expectedDocument = pageId && expected[pageId];
          const currentSignature = (typeof window.__smeshPageSig === 'function') ? window.__smeshPageSig() : '';
          const currentPrincipal = (typeof window.__smeshCurrentPrincipal === 'function')
            ? window.__smeshCurrentPrincipal() : '';
          if (!expectedDocument || expectedDocument.signature !== currentSignature ||
              expectedDocument.principal !== currentPrincipal) return { stale: true };
          return (typeof window.__smeshFill === 'function')
            ? window.__smeshFill(qs, currentSignature, currentPrincipal) : null;
        }
        catch { return null; }
      },
      args: [questions, expectedDocuments]
    });
  } catch (e) {
    return { filled: [], skipped: questions.map(idFor), coverage, error: String(e) };
  }

  if (results.some((entry) => entry?.result?.stale)) throw testCaptureChangedError();

  const filled = new Set();
  for (const r of (results || [])) {
    const s = r && r.result;
    if (s && Array.isArray(s.filled)) s.filled.forEach((id) => filled.add(String(id)));
    // Cheap per-frame box diagnostic, logged from the WORKER console (one place,
    // no iframe-console hunting). NOTE: the heavy cross-frame __smeshDumpBoxes
    // scan was removed from this hot path — it ran on every fill across every
    // iframe and contributed to the fill hanging. It stays available as an
    // on-demand global (__smeshDumpBoxes) for deliberate diagnosis only.
    if (s && s.diag) dbg('[СМЭШ AI fill][frame diag]', JSON.stringify(s.diag));
  }

  // Second pass: fill MathQuill formula boxes via their API in the page's MAIN
  // world (the isolated content-script world can't reach window.MQ). Runs in
  // every frame; merge any question it filled into the same set. Best-effort —
  // a page without MathQuill just returns nothing and the standard fill stands.
  await withMatchingTestCapture(capture, readTestCaptureContext, async () => undefined);
  try {
    const mqResults = await executeScriptInCapturedDocuments(capture, {
      world: 'MAIN',
      func: fillMathQuillMain,
      args: [questions, expectedDocuments]
    });
    if (mqResults.some((entry) => entry?.result?.stale)) throw testCaptureChangedError();
    for (const r of (mqResults || [])) {
      const res = r && r.result;
      if (res && Array.isArray(res.filled)) res.filled.forEach((id) => filled.add(String(id)));
    }
  } catch (error) {
    if (error?.code === TEST_CAPTURE_CHANGED) throw error;
    /* main-world injection blocked on this page — standard fill stands */
  }

  // Third pass: custom/ARIA widgets the native + MathQuill passes can't reach —
  // dropdowns (incl. matching done as one dropdown per item), ARIA radio groups,
  // MUI toggle groups. It's ASYNC (opens a popper, waits, clicks the option), so
  // it runs last and is told which questions are already filled, so it never
  // re-opens or toggles one back off. Best-effort: a page with no such widgets
  // returns nothing and everything above stands.
  await withMatchingTestCapture(capture, readTestCaptureContext, async () => undefined);
  try {
    const already = [...filled];
    const interactiveFilled = await fillInteractiveAllFrames(capture, questions, already);
    interactiveFilled.forEach((id) => filled.add(String(id)));
  } catch (error) {
    if (error?.code === TEST_CAPTURE_CHANGED) throw error;
    /* interactive pass is best-effort */
  }

  const filledIds = [];
  const skipped = [];
  questions.forEach((q, i) => {
    const id = idFor(q, i);
    (filled.has(String(id)) ? filledIds : skipped).push(id);
  });
  return { filled: filledIds, skipped, coverage };
}

/**
 * Run the async interactive-control pass (scraper.js __smeshFillInteractive) in
 * every frame and merge the ids it filled. Separate from fillAllFrames' sync
 * step because it has to await each dropdown's popper; the injected function
 * returns a Promise, which chrome.scripting awaits for us. `alreadyFilled` are
 * the ids the native + MathQuill passes already handled — passed through so the
 * page-side pass skips them (never toggles a set control back off). Frames that
 * disallow scripting are skipped silently; never throws.
 */
async function fillInteractiveAllFrames(capture, questions, alreadyFilled = []) {
  if (!capture?.tabId || !Array.isArray(questions) || !questions.length) return [];
  const expectedDocuments = Object.fromEntries(
    capture.documents.map((document) => [document.pageId, {
      signature: document.signature,
      principal: document.principal,
    }])
  );
  let results = [];
  try {
    results = await executeScriptInCapturedDocuments(capture, {
      func: (qs, done, expected) => {
        try {
          const pageId = window.__smeshCaptureDocumentId;
          const expectedDocument = pageId && expected[pageId];
          const currentSignature = (typeof window.__smeshPageSig === 'function') ? window.__smeshPageSig() : '';
          const currentPrincipal = (typeof window.__smeshCurrentPrincipal === 'function')
            ? window.__smeshCurrentPrincipal() : '';
          if (!expectedDocument || expectedDocument.signature !== currentSignature ||
              expectedDocument.principal !== currentPrincipal) return { stale: true };
          return (typeof window.__smeshFillInteractive === 'function')
            ? window.__smeshFillInteractive(qs, done, currentSignature, currentPrincipal) : null;
        }
        catch { return null; }
      },
      args: [questions, alreadyFilled, expectedDocuments]
    });
  } catch { return []; }
  if (results.some((entry) => entry?.result?.stale)) throw testCaptureChangedError();
  const filled = [];
  for (const r of (results || [])) {
    const s = r && r.result;
    if (s && Array.isArray(s.filled)) s.filled.forEach((id) => filled.push(String(id)));
  }
  return filled;
}

/* ---------- Multi-page test pagination ---------- */
// Invoke a pagination discovery helper only in the browser documents captured
// for this page and return each frame's live question signature alongside its
// result. The signature closes the same-document SPA gap; documentIds close
// normal navigation/reload races.
async function runInCapturedDocumentsWithIds(capture, fnName) {
  try {
    await executeScriptInCapturedDocuments(capture, { files: ['src/content/scraper.js'] });
  } catch { /* it is normally already injected; the exact call below is authoritative */ }
  let results;
  try {
    results = await executeScriptInCapturedDocuments(capture, {
      func: (name) => {
        try {
          const liveSignature = typeof window.__smeshPageSig === 'function'
            ? window.__smeshPageSig() : '';
          const livePrincipal = typeof window.__smeshCurrentPrincipal === 'function'
            ? window.__smeshCurrentPrincipal() : '';
          const result = typeof window[name] === 'function' ? window[name]() : null;
          return { liveSignature, livePrincipal, result };
        } catch { return null; }
      },
      args: [fnName]
    });
  } catch {
    throw testCaptureChangedError();
  }
  const expected = new Map(capture.documents.map((document) => [document.documentId, document]));
  const seen = new Set();
  const normalized = (results || []).filter((entry) => {
    const expectedDocument = expected.get(entry?.documentId);
    if (!expectedDocument || entry?.result?.liveSignature !== expectedDocument.signature ||
        entry?.result?.livePrincipal !== expectedDocument.principal) return false;
    seen.add(entry.documentId);
    return entry.result.result != null;
  }).map((entry) => ({
    frameId: entry.frameId,
    documentId: entry.documentId,
    result: entry.result.result,
  }));
  if (seen.size !== capture.documents.length) throw testCaptureChangedError();
  return normalized;
}

// Combined signature of the visible test page across all frames — lets the
// popup detect whether clicking «Далее» actually advanced the page.
async function testPageSig(tabId) {
  if (!tabId) return '';
  const documents = await captureTestDocuments(tabId);
  return documents.map((document) => `${document.frameId}:${document.signature}`).join('||');
}

/**
 * @param {number} tabId
 * @param {{mode?: string}} [options] 'mesh' (default) captures every frame that
 *   identifies itself as a Mesh assessment document; 'web' captures ONLY the
 *   top document of an eligible generic page (see lib/web-solve.js). The web
 *   mode never descends into child frames on purpose: off Mesh an iframe is an
 *   ad or a widget, and neither may feed a prompt or receive an autofill.
 */
async function captureTestDocuments(tabId, { mode = 'mesh' } = {}) {
  const web = mode === CAPTURE_MODE_WEB;
  const target = web ? { tabId, frameIds: [0] } : { tabId, allFrames: true };
  try {
    await chrome.scripting.executeScript({ target, files: ['src/content/scraper.js'] });
  } catch { /* inaccessible frames are absent from the capture */ }
  try {
    const results = await chrome.scripting.executeScript({
      target,
      func: () => {
        const key = '__smeshCaptureDocumentId';
        const observerKey = '__smeshCaptureObserver';
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!uuid.test(window[key] || '')) window[key] = crypto.randomUUID();
        const root = document.documentElement;
        const refreshMarker = () => {
          const signature = (typeof window.__smeshPageSig === 'function') ? window.__smeshPageSig() : '';
          const principal = (typeof window.__smeshCurrentPrincipal === 'function')
            ? window.__smeshCurrentPrincipal() : '';
          root?.setAttribute('data-smesh-capture-page', window[key]);
          root?.setAttribute('data-smesh-capture-signature', signature);
          root?.setAttribute('data-smesh-capture-principal', principal);
          return { signature, principal };
        };
        const { signature, principal } = refreshMarker();
        try { window[observerKey]?.disconnect(); } catch { /* first capture */ }
        try {
          window[observerKey] = new MutationObserver((records) => {
            if (records.every((record) => record.type === 'attributes' &&
              String(record.attributeName || '').startsWith('data-smesh-capture-'))) return;
            refreshMarker();
          });
          window[observerKey].observe(root, {
            subtree: true, childList: true, characterData: true, attributes: true,
          });
        } catch { /* the real documentId target still protects normal navigation */ }
        const url = String(location.href || '').slice(0, 4096);
        const isTestDocument = typeof window.__smeshIsTestDocument === 'function' &&
          window.__smeshIsTestDocument() === true;
        const isWebDocument = typeof window.__smeshIsWebDocument === 'function' &&
          window.__smeshIsWebDocument() === true;
        return { pageId: window[key], signature, principal, url, isTestDocument, isWebDocument };
      },
    });
    const eligible = web
      // The document must agree it is a generic page, its URL must pass the
      // same rule the tab URL did, and its principal must be the origin-scoped
      // web identity — so a Mesh document can never enter a web capture even if
      // the tab URL check were somehow bypassed.
      ? (entry) => entry.frameId === 0 &&
        isWebSolvableUrl(entry.result?.url) &&
        entry.result?.isWebDocument === true &&
        entry.result?.principal === expectedWebPrincipal(entry.result?.url)
      : (entry) => isMeshContentUrl(entry.result?.url) &&
        (entry.frameId === 0 || entry.result?.isTestDocument === true);
    return (results || [])
      .filter((entry) => Number.isInteger(entry?.frameId) && entry.documentId &&
        entry.result?.pageId && entry.result?.signature && entry.result?.principal &&
        eligible(entry))
      .map((entry) => ({
        frameId: entry.frameId,
        documentId: entry.documentId,
        pageId: entry.result.pageId,
        signature: entry.result.signature,
        principal: entry.result.principal,
        url: entry.result.url,
        isTestDocument: entry.frameId === 0 || entry.result.isTestDocument === true,
      }))
      .sort((a, b) => a.frameId - b.frameId);
  } catch {
    return [];
  }
}

/**
 * Does the user's own permission grant currently cover this page?
 *
 * Generic solving is gated on an OPTIONAL host permission the student granted
 * per site (see lib/web-solve.js). Chrome would refuse the injection anyway,
 * but asking first turns an opaque scripting error into an actionable sentence
 * and keeps the "never touch a site nobody approved" rule visible in one place.
 */
async function hasWebSolvePermission(url) {
  const origins = webOriginPattern(url);
  if (!origins) return false;
  try {
    return await chrome.permissions.contains({ origins: [origins] });
  } catch {
    return false;
  }
}

// A solve target is the exact tab URL + top-level document + question/control
// signature. URL catches normal navigation, documentId catches reloads and
// leave-then-return races, and signature catches same-document/SPAs.
//
// The MODE is decided by the tab URL and by nothing else: a Mesh tab always
// produces a Mesh capture, a granted generic tab always produces a web capture,
// and sameTestCaptureContext() refuses to match one against the other. That is
// what lets every existing revalidation site keep calling this one function.
async function readTestCaptureContext(tabId) {
  const before = await chrome.tabs.get(tabId);
  const mode = isMeshTestTab(before) ? 'mesh' : CAPTURE_MODE_WEB;
  if (mode === CAPTURE_MODE_WEB) {
    if (!isWebSolvableUrl(before?.url)) requireMeshTestTab(before);
    if (!(await hasWebSolvePermission(before.url))) throw webPermissionRequiredError();
  }
  const documents = await captureTestDocuments(tabId, { mode });
  const after = await chrome.tabs.get(tabId);
  const top = documents.find((document) => document.frameId === 0);
  const signature = documents.map((document) => `${document.frameId}:${document.signature}`).join('||');
  const capture = {
    tabId,
    url: after?.url || '',
    documentId: top?.documentId || '',
    signature,
    documents,
    // Mesh captures keep exactly the shape they always had; only the new path
    // carries the discriminator.
    ...(mode === CAPTURE_MODE_WEB ? { mode: CAPTURE_MODE_WEB } : {}),
  };
  if (before?.url !== after?.url || !isTestCaptureContext(capture)) {
    throw testCaptureChangedError();
  }
  return capture;
}

// Pagination is deliberately two-phase. Discovery runs in every frame and is
// read-only; only after one unambiguous frame is selected do we inject a click
// into that exact frame. The old allFrames click raced duplicate «Далее» buttons
// and could skip multiple pages at once.
async function testNextPage(capture, { click = true } = {}) {
  if (!isTestCaptureContext(capture)) throw testCaptureChangedError();
  await withMatchingTestCapture(capture, readTestCaptureContext, async () => undefined);
  const discovery = await runInCapturedDocumentsWithIds(capture, '__smeshNextDiscovery');
  const { outcome, documentId } = resolvePaginationTarget(discovery);
  if (outcome !== 'next') return outcome;
  // The page-cap check needs to distinguish "page 30 is the final page" from
  // "there is a page 31" without clicking anything. Discovery above is pure;
  // return its result before the click injection when requested.
  if (!click) return 'next';
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: capture.tabId, documentIds: [documentId] },
      func: (expectedSignature, expectedPrincipal) => {
        try {
          const live = typeof window.__smeshPageSig === 'function' ? window.__smeshPageSig() : '';
          const principal = typeof window.__smeshCurrentPrincipal === 'function'
            ? window.__smeshCurrentPrincipal() : '';
          if (!expectedSignature || live !== expectedSignature || principal !== expectedPrincipal) {
            return { status: 'stale' };
          }
          return (typeof window.__smeshNextClick === 'function')
            ? window.__smeshNextClick(expectedSignature, expectedPrincipal) : null;
        }
        catch { return null; }
      },
      args: [
        capture.documents.find((document) => document.documentId === documentId)?.signature || '',
        capture.documents.find((document) => document.documentId === documentId)?.principal || '',
      ]
    });
    if (result?.status === 'stale') throw testCaptureChangedError();
    return result?.status === 'clicked' ? 'clicked' : 'none';
  } catch (error) {
    if (error?.code === TEST_CAPTURE_CHANGED) throw error;
    return 'none';
  }
}

/* ---------- Floating "Solve" pill (page-triggered test solving) ---------- */
// The pill (src/content/test-pill.js) is a content script, so it cannot call
// chrome.scripting. The worker reads bounded DOM text from the exact captured
// documents, then solves + autofills (+ the multi-page advance loop). These
// handlers lift the orchestration that used to live only in the popup
// (solveTestOnScreen / solveAllPages) into the worker so it can be driven from
// the page instead of the toolbar. Screen capture remains popup-only because a
// page click does not grant activeTab and the extension deliberately avoids the
// broad <all_urls> permission.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PILL_MAX_PAGES = 30; // same cap as the popup's solveAllPages

/**
 * Cancellable pill operations.
 *
 * Closing the pill (×, Esc, SPA route change, page teardown) used to remove
 * only local UI state: the worker kept solving, filling, navigating and
 * SPENDING for up to 30 pages against a page the student thought they had
 * stopped, and the hidden answer panel could reappear mid-run. The pill now
 * names each run with an operation id and sends PILL_CANCEL on every teardown
 * path; the worker aborts that exact run.
 *
 * Keyed by tab and matched on the operation id so a cancel for a finished run
 * can never kill the next one.
 */
const pillOperations = new Map(); // tabId -> { opId, controller }

/**
 * Operation ids cancelled BEFORE their solve message arrived.
 *
 * PILL_CANCEL and the solve request are two independent messages, so a pill
 * torn down while its solve was still in flight can have its cancel delivered
 * first. Without this, that cancel found nothing to stop and the solve then
 * started normally — the exact case the pill's own pre-await ownership check
 * cannot cover, because the message had already left.
 */
const preCancelledPillOps = new Set();
const MAX_PRE_CANCELLED_OPS = 200;

function beginPillOperation(tabId, opId) {
  const id = String(opId || '');
  if (id && preCancelledPillOps.delete(id)) return null; // cancelled before it began
  cancelPillOperation(tabId); // one solve per tab; withTabSolveLock enforces it too
  const controller = new AbortController();
  pillOperations.set(tabId, { opId: id, controller });
  return controller.signal;
}

function endPillOperation(tabId, signal) {
  const current = pillOperations.get(tabId);
  if (current && current.controller.signal === signal) pillOperations.delete(tabId);
}

// opId omitted (tab closed/navigated) cancels whatever is running on the tab.
function cancelPillOperation(tabId, opId = null) {
  const current = pillOperations.get(tabId);
  if (!current || (opId != null && current.opId !== String(opId))) {
    // Nothing running under that id yet. Remember the cancellation so a solve
    // message still in flight is refused when it lands.
    if (opId != null) {
      if (preCancelledPillOps.size >= MAX_PRE_CANCELLED_OPS) {
        preCancelledPillOps.delete(preCancelledPillOps.values().next().value);
      }
      preCancelledPillOps.add(String(opId));
    }
    return false;
  }
  pillOperations.delete(tabId);
  try { current.controller.abort(); } catch { /* already settled */ }
  return true;
}

const PILL_CANCELLED = 'PILL_CANCELLED';

// Called before every awaited step and before every page effect (AI call,
// panel write, autofill, navigation click). Cancellation between two of those
// is exactly the window that let a closed pill keep mutating the page.
function throwIfPillCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error('Решение отменено.');
    error.name = PILL_CANCELLED;
    throw error;
  }
}

const isPillCancellation = (error) => error?.name === PILL_CANCELLED;

// Abortable sleep: a cancel during a settle/poll delay must not have to wait
// out the full timer before the run stops.
function cancellableSleep(ms, signal) {
  throwIfPillCancelled(signal);
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('Решение отменено.');
      error.name = PILL_CANCELLED;
      reject(error);
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// A closed tab can never consume the result, and its page effects are moot.
try {
  chrome.tabs.onRemoved.addListener((tabId) => cancelPillOperation(tabId));
} catch { /* tabs events unavailable in this context */ }

function isMeshTestTab(tab) {
  try {
    const url = new URL(tab?.url || '');
    return url.protocol === 'https:' &&
      (url.hostname === 'school.mos.ru' || url.hostname === 'uchebnik.mos.ru');
  } catch {
    return false;
  }
}

function requireMeshTestTab(tab) {
  if (!isMeshTestTab(tab)) {
    throw new Error('Для решения теста откройте его в электронном журнале. Другие вкладки расширение не снимает и не отправляет ИИ.');
  }
}

/**
 * Read the visible test DOM across every captured frame. Unlike the popup path,
 * an in-page click does not confer activeTab, so this path intentionally never
 * calls captureVisibleTab. Pages that expose too little readable DOM fail with
 * a truthful popup instruction instead of asking for a permission the manifest
 * does not request — unless the caller already holds a screenshot of this exact
 * page (see resolveOneQuestion), in which case thin DOM text is not a dead end.
 */
async function capturePageForPill(tabId, { allowThinText = false } = {}) {
  const captured = await readTestCaptureContext(tabId);
  // Off Mesh the same call has to read the page through the generic reader —
  // otherwise the panel's «перерешать» would re-solve from raw body innerText,
  // i.e. from strictly worse material than the answer it is replacing.
  if (isWebCapture(captured)) {
    const { pageText, capture, unitCount } = await capturePageForWeb(tabId, { allowThinText, captured });
    return { pageText, capture, hasVisualMedia: false, unitCount, web: true };
  }
  const [pageText, hasVisualMedia] = await Promise.all([
    capturePillDomText(captured),
    captureTestVisualMedia(captured),
  ]);
  if (!allowThinText && pageText.trim().length < 20) {
    throw new Error(
      'Не удалось прочитать условие теста со страницы. Откройте значок СМЭШ AI на панели браузера, ' +
      'перейдите на вкладку «Тест» и нажмите «Решить тест» — там доступен снимок экрана.'
    );
  }
  const capture = await withMatchingTestCapture(
    captured,
    readTestCaptureContext,
    async (current) => current,
  );
  return { pageText, capture, hasVisualMedia };
}

/**
 * Solve ONE captured page: run the existing solve path, drop the answers into
 * the in-page panel (showAnswersInTab) and autofill the form across every frame
 * (fillAllFrames). Returns the parsed questions + fill summary.
 *
 * A page whose capture signature is already in the local reuse cache skips the
 * paid call entirely and goes straight to panel + autofill. The signature only
 * matches when the questions AND their order are the same (see
 * lib/test-answer-cache.js), so a re-rolled variant is solved fresh.
 */
async function pillSolveOnePage(tabId, provider, signal = null) {
  // No screenshot on this path by construction: a page click grants no
  // activeTab, so the pill solves from the captured DOM text alone.
  throwIfPillCancelled(signal);
  const { pageText, capture, hasVisualMedia } = await capturePageForPill(tabId);
  const reused = await readCachedTestAnswers(capture);
  // Reuse skips solveTest, and with it solveTest's own gates. Filling a test is
  // the licensed action whether or not this particular page costs a completion,
  // and a withdrawn consent must stop the extension answering — so the reuse
  // path repeats exactly the two checks the paid path would have run.
  if (reused) {
    await ensureLicensed();
    if (!(await hasConsent())) throw new Error(CONSENT_REQUIRED_MESSAGE);
  }
  throwIfPillCancelled(signal);
  let questions;
  if (reused) {
    questions = reused.questions;
    // A reused page never calls the model, so without this the diagnostics log
    // would show a gap exactly where a stale cached answer would hide. The
    // scraped text is still recorded — it is what the cache key was derived
    // from, and comparing it against the fresh solve above is how you tell a
    // wrong cache hit from a wrong answer.
    void recordDevTrace({
      kind: 'cache',
      url: capture.url,
      ok: true,
      pageText,
      pageTextChars: pageText.length,
      hasVisualMedia,
      cached: true,
      questionCount: questions.length,
      rawAnswer: serializeTestAnswers(questions),
    });
  } else {
    // Last gate before the PAID call.
    throwIfPillCancelled(signal);
    const answer = await solveTest({
      text: pageText, hasVisualMedia, provider, signal, pageUrl: capture.url
    });
    questions = parseTestAnswers(answer);
    // Remember the page BEFORE filling it: the fill mutates the student's form,
    // and only the answers themselves are worth another attempt's money.
    if (questions.length) await writeCachedTestAnswers(capture, questions);
  }
  throwIfPillCancelled(signal);
  return withMatchingTestCapture(capture, readTestCaptureContext, async () => {
    if (!questions.length) return { questions, cached: false, summary: { filled: [], skipped: [] } };
    // Each of these mutates the student's page; re-check between them so a
    // cancel cannot be overtaken by a panel that reappears or a late autofill.
    throwIfPillCancelled(signal);
    await showAnswersInTab(tabId, questions, capture);
    throwIfPillCancelled(signal);
    const summary = await fillAllFrames(tabId, questions, capture);
    return { questions, cached: !!reused, summary };
  });
}

// Poll the page signature until it differs from `beforeSig` (page advanced) or
// the budget runs out. Mirrors popup.js waitForChange.
async function waitForPillPageChange(tabId, beforeSig, timeout, signal = null) {
  const start = Date.now();
  await cancellableSleep(600, signal);
  while (Date.now() - start < timeout) {
    const sig = await testPageSig(tabId);
    if (sig && sig !== beforeSig) return true;
    await cancellableSleep(500, signal);
  }
  return false;
}

// Try to advance to the next page. Mirrors popup.js advancePage: 'ok' |
// 'finish' | 'blocked' | 'none' | 'stuck'. NEVER clicks a submit/finish control
// (testNextPage refuses).
async function advancePillPage(capture, signal = null) {
  const tabId = capture.tabId;
  const beforeSig = capture.signature;
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfPillCancelled(signal); // testNextPage clicks the page
    const status = await testNextPage(capture);
    if (status === 'finish') return 'finish';
    if (status === 'blocked') return 'blocked';
    if (status === 'ambiguous') return 'none';
    if (status === 'none') return attempt === 0 ? 'none' : 'stuck';
    if (await waitForPillPageChange(tabId, beforeSig, attempt === 0 ? 8000 : 4000, signal)) return 'ok';
  }
  return 'stuck';
}

// Fire-and-forget live-status ping to the pill (page number / phase). Reading
// lastError in the callback swallows the "no receiver" noise if the pill is gone.
function notifyPill(tabId, payload) {
  try {
    chrome.tabs.sendMessage(tabId, { type: 'PILL_PROGRESS', payload }, () => void chrome.runtime.lastError);
  } catch { /* tab closed mid-run */ }
}

/**
 * Multi-page autopilot: for each page — solve, fill, then advance — until the
 * end. NEVER submits; mirrors popup.js solveAllPages exactly. Returns
 * { outcome, solved, partial, unrecognized } so the pill can render the same
 * fail-closed summary as the popup.
 */
async function pillSolveAllPages(tabId, provider, signal = null) {
  let solved = 0;
  let cached = 0;
  let partial = 0;
  let unrecognized = 0;
  let outcome = 'done';
  for (let page = 1; page <= PILL_MAX_PAGES; page++) {
    throwIfPillCancelled(signal);
    notifyPill(tabId, { phase: 'solve', page });
    const { questions, summary, cached: fromCache } = await pillSolveOnePage(tabId, provider, signal);
    const fillState = classifyAutopilotFill(questions, summary);
    if (fillState === 'unrecognized') {
      unrecognized++;
      outcome = 'unrecognized';
      break;
    }
    if (fillState === 'partial') {
      partial++;
      outcome = 'partial';
      break;
    }
    solved++;
    if (fromCache) cached++;
    // Let the fill's React re-render settle so the signature reflects the filled
    // state — otherwise a late repaint could look like a navigation.
    await cancellableSleep(700, signal);
    const navigationCapture = await readTestCaptureContext(tabId);
    if (page === PILL_MAX_PAGES) {
      const finalState = await testNextPage(navigationCapture, { click: false });
      outcome = finalState === 'finish' ? 'finish' : 'max';
      break;
    }
    // The next step CLICKS through to another page. Never do that for a run
    // the student has already stopped.
    throwIfPillCancelled(signal);
    notifyPill(tabId, { phase: 'next', page });
    const nav = await advancePillPage(navigationCapture, signal);
    if (nav === 'finish') { outcome = 'finish'; break; }
    if (nav === 'blocked') { outcome = 'blocked'; break; }
    if (nav === 'none') { outcome = 'none'; break; }
    if (nav === 'stuck') { outcome = 'stuck'; break; }
    await cancellableSleep(500, signal);
  }
  return { outcome, solved, cached, partial, unrecognized };
}

// One screen-solve operation per tab: the pill and popup drive capture →
// solve → autofill → pagination loops that mutate the page, so two running
// interleaved on one tab click and fill against each other's state.
const tabSolveOps = new Set();
async function withTabSolveLock(tabId, fn) {
  if (tabSolveOps.has(tabId)) {
    throw new Error('Решение уже выполняется на этой вкладке. Дождитесь завершения текущего.');
  }
  tabSolveOps.add(tabId);
  try {
    return await fn();
  } finally {
    tabSolveOps.delete(tabId);
  }
}

try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabSolveOps.delete(tabId);
    answerPanelContexts.delete(tabId);
  });
} catch { /* tabs events unavailable in a test harness */ }

/* ---------- Generic web pages (any site the user granted) ---------- */
/**
 * The "solve a question on any web page" flow.
 *
 * It reuses the primitives that were already site-agnostic — pageSignature for
 * capture identity, the answer panel, parseTestAnswers (with its arithmetic
 * check), the reuse cache — and adds only what a non-Mesh page needs: a reader
 * that strips site furniture, a merged single-pass fill, and the cheap model
 * route. What it deliberately does NOT reuse is the multi-page autopilot: on an
 * arbitrary site a "Далее" button can be a checkout step, so this path solves
 * exactly the page in front of the student and clicks nothing.
 *
 * Cost: every request here is pinned to the standard chain at low effort (see
 * lib/web-solve.js). Mesh keeps the frontier route and its own effort policy.
 */

const WEB_PERMISSION_REQUIRED = 'WEB_PERMISSION_REQUIRED';
const MAX_WEB_PROMPT_CHARS = 10000;
const MIN_WEB_PAGE_CHARS = 40;

function webPermissionRequiredError() {
  const error = new Error(
    'Этот сайт ещё не разрешён. Нажмите на значок СМЭШ AI на панели браузера и выберите ' +
    '«Разрешить на этом сайте» — после этого я смогу прочитать страницу.'
  );
  error.code = WEB_PERMISSION_REQUIRED;
  return error;
}

function webUnreadableError() {
  return new Error(
    'Не удалось прочитать текст задания на этой странице. Прокрутите к заданию, дождитесь ' +
    'загрузки и попробуйте ещё раз.'
  );
}

/**
 * Read a generic page and prove the capture still describes it.
 * `captured` lets a caller that already read the context reuse it instead of
 * paying for a second cross-document round trip.
 */
async function capturePageForWeb(tabId, { allowThinText = false, captured = null } = {}) {
  if (!captured) captured = await readTestCaptureContext(tabId);
  // Belt and braces: readTestCaptureContext picks the mode from the tab URL, so
  // a Mesh tab can never land here — but this path must never run against a
  // Mesh capture, so say so rather than assume it.
  if (!isWebCapture(captured)) throw testCaptureChangedError();
  const { text, unitCount, bodyChars } = await captureWebDomText(captured);
  // Measured on the TRANSCRIPT, not on the assembled prompt: the title/URL
  // header is always present, so checking `text` would clear this guard on a
  // page with nothing readable at all. A page that exposes answer controls is
  // still worth solving even when its prose is thin — the control inventory
  // carries the question there.
  if (!allowThinText && !unitCount && bodyChars < MIN_WEB_PAGE_CHARS) throw webUnreadableError();
  const capture = await withMatchingTestCapture(
    captured,
    readTestCaptureContext,
    async (current) => current,
  );
  return { pageText: text.slice(0, MAX_WEB_PROMPT_CHARS), capture, unitCount };
}

/**
 * Ask the model to answer a generic page. Same JSON contract as the Mesh test
 * solve (so parseTestAnswers and its arithmetic check apply unchanged), same
 * licence/consent gates, but pinned to the cheap route.
 */
async function solveWebPage({ text, signal = null, pageUrl = null } = {}) {
  await ensureLicensed();
  if (!(await hasConsent())) throw new Error(CONSENT_REQUIRED_MESSAGE);
  const systemPrompt = DEFAULT_PROMPTS[PROMPT_CATEGORIES.WEB_ANSWER];
  const userText = 'Страница с заданием:\n\n' + (text || '(текст страницы не извлечён)');
  let usage = null, usedProvider = null;
  const askOpts = {
    responseFormat: 'json_object',
    reasoning: { effort: WEB_SOLVE_EFFORT },
    // Downgrade-only hint: the proxy may refuse to honour it, never upgrade on it.
    tier: WEB_SOLVE_TIER,
    // Generic pages always use the licensed proxy. In particular, an old
    // stored Groq/OpenRouter selection or hidden Alibaba key must not bypass
    // the GLM-5.3-Flash route promised for this feature.
    provider: WEB_SOLVE_PROVIDER,
    proxyOnly: true,
    signal,
    onUsage: (u, prov) => { usage = u; usedProvider = prov; },
  };
  const tracing = await isDevModeActive();
  const reasoning = tracing ? createReasoningCollector() : null;
  if (reasoning) askOpts.onReasoning = (chunk) => reasoning.push(chunk);
  const startedAt = Date.now();
  const trace = tracing ? {
    kind: 'web',
    url: pageUrl,
    systemPrompt,
    userText,
    pageText: text || '',
    pageTextChars: String(text || '').length,
    effort: WEB_SOLVE_EFFORT,
    hasVisualMedia: false,
    screenshot: false,
  } : null;
  let answer;
  try {
    answer = await askAI(systemPrompt, userText, [], [], askOpts);
  } catch (e) {
    if (trace) {
      void recordDevTrace({
        ...trace,
        ok: false,
        error: String(e?.message || e),
        durationMs: Date.now() - startedAt,
        reasoning: reasoning.value(),
        provider: usedProvider,
        model: usage?.model || null,
      });
    }
    throw e;
  }
  const empty = !answer || answer.trim() === '' || answer.trim() === EMPTY_ANSWER;
  if (trace) {
    const checks = [];
    const questions = empty ? [] : parseTestAnswers(answer, { onCheck: (check) => checks.push(check) });
    void recordDevTrace({
      ...trace,
      ok: !empty,
      error: empty ? 'Пустой ответ от ИИ.' : null,
      durationMs: Date.now() - startedAt,
      reasoning: reasoning.value(),
      rawAnswer: answer,
      questionCount: questions.length,
      corrections: checks.filter((check) => check.status === 'fixed'),
      checks,
      provider: usedProvider,
      model: usage?.model || null,
      usage,
    });
  }
  if (empty) throw new Error('Пустой ответ от ИИ. Попробуйте ещё раз.');
  // Reported as a test solve with a `web` marker: the dashboard's usage and cost
  // rollups already treat test_solve as real usage, and a brand-new event type
  // would be dropped by the ingest allowlist until the backend ships.
  track('test_solve', {
    ...usageFields(usedProvider, usage),
    files_img: 0,
    meta: { effort: WEB_SOLVE_EFFORT, web: 1 },
  });
  return answer;
}

/**
 * Fill a generic page. ONE pass over the merged native+custom control list in
 * the single captured document — see scraper.js fillWebAnswers for why the
 * Mesh two-pass design is not reused off Mesh.
 */
async function fillWebAnswersInTab(capture, questions) {
  const idFor = (q, i) =>
    (q && q.index != null && String(q.index).trim() !== '') ? q.index : i + 1;
  const emptyCoverage = { exact: false, units: [] };
  if (!Array.isArray(questions) || !questions.length) {
    return { filled: [], skipped: [], coverage: emptyCoverage };
  }
  const document0 = capture.documents[0];
  if (!document0) throw testCaptureChangedError();
  const expected = { signature: document0.signature, principal: document0.principal };

  try {
    await executeScriptInCapturedDocuments(capture, { files: ['src/content/scraper.js'] });
  } catch {
    throw testCaptureChangedError();
  }
  // The injection above is read-only; revalidate immediately before the first
  // mutation of the student's form.
  await withMatchingTestCapture(capture, readTestCaptureContext, async () => undefined);

  let results = [];
  try {
    results = await executeScriptInCapturedDocuments(capture, {
      func: (qs, expectedDocument) => {
        try {
          const signature = (typeof window.__smeshPageSig === 'function') ? window.__smeshPageSig() : '';
          const principal = (typeof window.__smeshCurrentPrincipal === 'function')
            ? window.__smeshCurrentPrincipal() : '';
          if (expectedDocument.signature !== signature || expectedDocument.principal !== principal) {
            return { stale: true };
          }
          return (typeof window.__smeshWebFill === 'function')
            ? window.__smeshWebFill(qs, signature, principal)
            : null;
        } catch {
          return null;
        }
      },
      args: [questions, expected],
    });
  } catch (e) {
    return {
      filled: [],
      skipped: questions.map(idFor),
      coverage: emptyCoverage,
      error: String(e),
    };
  }
  if (results.some((entry) => entry?.result?.stale)) throw testCaptureChangedError();
  const summary = results[0]?.result || null;
  const filled = new Set((summary?.filled || []).map(String));
  const filledIds = [];
  const skipped = [];
  questions.forEach((question, index) => {
    const id = idFor(question, index);
    (filled.has(String(id)) ? filledIds : skipped).push(id);
  });
  return { filled: filledIds, skipped, coverage: emptyCoverage };
}

/**
 * Solve the page in front of the student: capture → (cache or model) → panel →
 * autofill. Mirrors pillSolveOnePage, minus the screenshot and the pagination.
 */
async function webSolveOnePage(tabId, provider, signal = null) {
  throwIfPillCancelled(signal);
  const { pageText, capture, unitCount } = await capturePageForWeb(tabId);
  const reused = await readCachedTestAnswers(capture);
  // Reuse skips solveWebPage's gates; run them here for the same reason the
  // Mesh path does — filling is the licensed action whether or not this
  // particular page costs a completion.
  if (reused) {
    await ensureLicensed();
    if (!(await hasConsent())) throw new Error(CONSENT_REQUIRED_MESSAGE);
  }
  throwIfPillCancelled(signal);
  let questions;
  if (reused) {
    questions = reused.questions;
    void recordDevTrace({
      kind: 'cache',
      url: capture.url,
      ok: true,
      pageText,
      pageTextChars: pageText.length,
      hasVisualMedia: false,
      cached: true,
      questionCount: questions.length,
      rawAnswer: serializeTestAnswers(questions),
    });
  } else {
    throwIfPillCancelled(signal); // last gate before the PAID call
    const answer = await solveWebPage({
      text: pageText, signal, pageUrl: capture.url,
    });
    questions = parseTestAnswers(answer);
    if (questions.length) await writeCachedTestAnswers(capture, questions);
  }
  throwIfPillCancelled(signal);
  return withMatchingTestCapture(capture, readTestCaptureContext, async () => {
    if (!questions.length) {
      return { questions, cached: false, unitCount, summary: { filled: [], skipped: [] } };
    }
    throwIfPillCancelled(signal);
    await showAnswersInTab(tabId, questions, capture);
    throwIfPillCancelled(signal);
    // A page with no answer boxes (an exercise printed as prose) is answered in
    // the panel and nothing is written to the page.
    const summary = unitCount
      ? await fillAllFrames(tabId, questions, capture)
      : { filled: [], skipped: [], coverage: { exact: false, units: [] } };
    return { questions, cached: !!reused, unitCount, summary };
  });
}

/**
 * Keep the generic pill registered for exactly the origins the user granted.
 *
 * The manifest ships no broad host permission, so this is the ONLY way the pill
 * reaches a non-Mesh site — grant an origin and it appears there, revoke it and
 * it stops loading. `permissions.getAll()` also returns the manifest's required
 * hosts, which webPillMatchPatterns() drops so Mesh keeps its static script and
 * our own site never gets a pill.
 */
async function syncWebPillRegistration() {
  let granted = null;
  try { granted = await chrome.permissions.getAll(); } catch { return; }
  const matches = webPillMatchPatterns(granted?.origins);
  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts({ ids: [WEB_PILL_SCRIPT_ID] });
  } catch { existing = []; }
  if (!matches.length) {
    if (existing.length) {
      try { await chrome.scripting.unregisterContentScripts({ ids: [WEB_PILL_SCRIPT_ID] }); }
      catch { /* already gone */ }
    }
    return;
  }
  const script = {
    id: WEB_PILL_SCRIPT_ID,
    matches,
    excludeMatches: webPillExcludeMatches(),
    js: [...WEB_PILL_FILES],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  };
  try {
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  } catch (e) {
    // A pattern Chrome refuses must not leave a half-registered script behind.
    dbg('[СМЭШ AI] web pill registration failed', String(e));
    try { await chrome.scripting.unregisterContentScripts({ ids: [WEB_PILL_SCRIPT_ID] }); }
    catch { /* nothing registered */ }
  }
}

try {
  chrome.permissions.onAdded.addListener(() => { void syncWebPillRegistration(); });
  chrome.permissions.onRemoved.addListener(() => { void syncWebPillRegistration(); });
} catch { /* permissions events unavailable in a test harness */ }

// Reconcile the registration with the permissions actually held, on every
// worker spin-up. registerContentScripts is persistent, so this is normally a
// no-op — it exists so a permission revoked while the worker was asleep (or a
// registration lost to a profile repair) cannot leave the pill on a site nobody
// approved, or off one they did.
void syncWebPillRegistration();

/* ---------- Runtime message trust boundary ---------- */

const EXTENSION_PAGE_PREFIX = `chrome-extension://${chrome.runtime.id}/`;
const ACTION_TOKEN_TTL_MS = 30000;
const MAX_TEXT_CHARS = 200 * 1024;
const MAX_URL_CHARS = 4096;
const MAX_ARRAY_ITEMS = 100;
const MAX_BASE64_CHARS = 40 * 1024 * 1024;
const MAX_FILES_TOTAL_CHARS = 100 * 1024 * 1024;

// Every action that costs money or mutates a page, and therefore needs a
// single-use capability token. Which SENDER may ask for which of them is
// decided by SENDER_MESSAGE_TYPES below, not by membership here.
const CONTENT_ACTIONS = new Set([
  'FILL_ANSWERS_ALL',
  'PILL_SOLVE_PAGE',
  'PILL_SOLVE_ALL',
  'RESOLVE_QUESTION',
  'WEB_SOLVE_PAGE',
  'DOWNLOAD_FILES'
]);
const PANEL_ACTIONS = new Set(['FILL_ANSWERS_ALL', 'RESOLVE_QUESTION']);

// This is intentionally exhaustive. Adding a switch case without assigning it
// to a sender class leaves it unreachable instead of silently widening access.
const SENDER_MESSAGE_TYPES = {
  // PILL_CANCEL is deliberately outside CONTENT_ACTIONS: it only stops the
  // sender tab's own run, so it must not require an action token.
  content: new Set([
    'GET_ACTION_TOKEN', 'GET_RUNTIME_CONFIG', 'PILL_CANCEL',
    'FILL_ANSWERS_ALL', 'PILL_SOLVE_PAGE', 'PILL_SOLVE_ALL', 'RESOLVE_QUESTION',
    'DOWNLOAD_FILES'
  ]),
  // A granted generic page (lib/web-solve.js). Strictly narrower than Mesh: it
  // may solve the one page in front of it, fill it and re-solve one question —
  // and can never reach the multi-page autopilot, which clicks through a test.
  web: new Set([
    'GET_ACTION_TOKEN', 'PILL_CANCEL',
    'WEB_SOLVE_PAGE', 'FILL_ANSWERS_ALL', 'RESOLVE_QUESTION'
  ]),
  extension: new Set([
    'OPEN_DASHBOARD', 'SOLVE', 'SOLVE_TEST', 'FILL_ANSWERS_TAB',
    'TEST_PAGE_SIG', 'TEST_NEXT_PAGE', 'GET_RUNTIME_CONFIG',
    'GET_DEVICE_ID', 'SET_LICENSE_KEY', 'DEACTIVATE_LICENSE', 'SYNC_REFERRAL_POINTER', 'DELETE_LOCAL_DATA',
    'LESSON_HISTORY', 'LIST_SESSIONS', 'LIST_MESSAGES',
    'GDZ_SEARCH', 'GDZ_FOR_TASK', 'GDZ_COVER', 'GDZ_BOOK_ADD', 'GDZ_BOOK_REMOVE',
    'CONSUME_DASH_LAUNCH', 'OPEN_ONBOARDING',
    'ACTIVATE_WEB_SITE'
  ])
};

const actionTokens = new Map();
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isString = (v, max = MAX_TEXT_CHARS) => typeof v === 'string' && v.length <= max;
const isOptionalString = (v, max = MAX_TEXT_CHARS) => v == null || isString(v, max);
const isSafeId = (v) => Number.isSafeInteger(v) && v >= 0;
const isOpaqueId = (v) => v == null || isSafeId(v) || isString(v, 512);
const isBoolean = (v) => typeof v === 'boolean';
const isOptionalBoolean = (v) => v == null || isBoolean(v);
const hasOnlyKeys = (obj, allowed) => isRecord(obj) && Object.keys(obj).every((k) => allowed.includes(k));
const validArray = (v, check) => Array.isArray(v) && v.length <= MAX_ARRAY_ITEMS && v.every(check);

function validFile(file) {
  return hasOnlyKeys(file, ['mimeType', 'dataBase64', 'name']) &&
    isString(file.mimeType, 256) &&
    isString(file.name, MAX_URL_CHARS) &&
    isString(file.dataBase64, MAX_BASE64_CHARS);
}

function validFiles(files) {
  if (!validArray(files, validFile)) return false;
  return files.reduce((n, file) => n + file.dataBase64.length, 0) <= MAX_FILES_TOTAL_CHARS;
}

function validPart(part) {
  return hasOnlyKeys(part, ['label', 'value']) &&
    isOptionalString(part.label) && isOptionalString(part.value);
}

function validQuestion(q) {
  // `explain` rides along because the panel hands whole question objects back
  // for filling. Bounded well above MAX_EXPLANATION_CHARS so the worker's own
  // trim, not this schema, is what a long sentence hits.
  return hasOnlyKeys(q, ['index', 'text', 'answer', 'choice', 'parts', 'explain']) &&
    (q.index == null || isSafeId(q.index) || isString(q.index, 512)) &&
    isOptionalString(q.text) && isOptionalString(q.answer) &&
    isOptionalString(q.choice, 512) && isOptionalString(q.explain, 1024) &&
    (q.parts == null || validArray(q.parts, validPart));
}

const validQuestions = (v) => validArray(v, validQuestion);

function validTestCapture(capture, tabId) {
  return hasOnlyKeys(capture, ['tabId', 'url', 'documentId', 'signature', 'documents', 'mode']) &&
    isTestCaptureContext(capture) && capture.tabId === tabId &&
    (isWebCapture(capture) ? isWebSolvableUrl(capture.url) : isMeshContentUrl(capture.url));
}

const GDZ_BOOK_KEYS = [
  'url', 'title', 'breadcrumb', 'year', 'authors', 'study_level', 'subtype',
  'cover_url', 'classes', 'is_paid', 'subjectId', 'subject_id'
];
const isGdzSubjectId = (value) => {
  const text = String(value ?? '');
  const number = text.length <= 32 && /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(number) && number >= 0;
};
function validGdzBook(book) {
  return hasOnlyKeys(book, GDZ_BOOK_KEYS) && isString(book.url, MAX_URL_CHARS) &&
    !!normalizeGdzApiUrl(book.url) &&
    isGdzSubjectId(book.subject_id) &&
    isOptionalString(book.title, 2048) && isOptionalString(book.breadcrumb, 4096) &&
    (book.year == null || isSafeId(book.year) || isString(book.year, 32)) &&
    (book.authors == null || validArray(book.authors, (author) => isString(author, 1024))) &&
    isOptionalString(book.study_level, 512) && isOptionalString(book.subtype, 512) &&
    isOptionalString(book.cover_url, MAX_URL_CHARS) &&
    (book.classes == null || validArray(book.classes, (grade) => isSafeId(Number(grade)))) &&
    (book.is_paid == null || isBoolean(book.is_paid)) &&
    (book.subjectId == null || isGdzSubjectId(book.subjectId));
}

function validHistoryMessage(item) {
  return hasOnlyKeys(item, ['role', 'content', 'files', 'needsUpload', 'error']) &&
    isString(item.role, 32) && isString(item.content) &&
    (item.files == null || validFiles(item.files)) &&
    isOptionalBoolean(item.needsUpload) && isOptionalBoolean(item.error);
}

const noPayload = (msg) => msg.payload == null;
const payloadRecord = (msg, keys) => hasOnlyKeys(msg.payload, keys);

// Each handler validates only what it consumes, but rejects unknown payload keys
// so an ignored field cannot be used to smuggle an unbounded object through the
// privileged boundary.
const MESSAGE_SCHEMAS = {
  GET_ACTION_TOKEN: (msg) => noPayload(msg) && CONTENT_ACTIONS.has(msg.action) &&
    (PANEL_ACTIONS.has(msg.action) ? isPanelNonce(msg.panelNonce) : msg.panelNonce == null),
  GET_DEVICE_ID: noPayload,
  OPEN_ONBOARDING: noPayload,
  SET_LICENSE_KEY: (msg) => payloadRecord(msg, ['key']) && isString(msg.payload.key, 512),
  DEACTIVATE_LICENSE: noPayload,
  SYNC_REFERRAL_POINTER: noPayload,
  DELETE_LOCAL_DATA: noPayload,
  OPEN_DASHBOARD: (msg) => payloadRecord(msg, ['subject', 'task', 'day', 'homeworkId', 'homeworkItemId', 'rowToken', 'tabId', 'scanId', 'principal', 'principalError', 'files']) &&
    isString(msg.payload.subject, 1024) && isOptionalString(msg.payload.task) &&
    isOptionalString(msg.payload.day, 1024) && isOpaqueId(msg.payload.homeworkId) &&
    isOpaqueId(msg.payload.homeworkItemId) && isHomeworkScanId(msg.payload.rowToken) &&
    isSafeId(msg.payload.tabId) &&
    isHomeworkScanId(msg.payload.scanId) &&
    isOptionalString(msg.payload.principal, 512) &&
    isOptionalString(msg.payload.principalError, 1024) &&
    (msg.payload.files == null || validFiles(msg.payload.files)),
  SOLVE: (msg) => payloadRecord(msg, ['subject', 'task', 'files', 'sessionId', 'history', 'mode', 'engine', 'lessonKey']) &&
    isString(msg.payload.subject, 1024) && isOptionalString(msg.payload.task) &&
    (msg.payload.files == null || validFiles(msg.payload.files)) &&
    isOptionalString(msg.payload.sessionId, 512) &&
    (msg.payload.history == null || validArray(msg.payload.history, validHistoryMessage)) &&
    isOptionalString(msg.payload.mode, 64) &&
    isOptionalString(msg.payload.engine, 16) &&
    isOptionalString(msg.payload.lessonKey, 128),
  SOLVE_TEST: (msg) => payloadRecord(msg, ['text', 'screenshot', 'hasVisualMedia', 'tabId', 'provider', 'capture']) &&
    isOptionalString(msg.payload.text) && (msg.payload.screenshot == null || validFile(msg.payload.screenshot)) &&
    isOptionalBoolean(msg.payload.hasVisualMedia) &&
    isSafeId(msg.payload.tabId) && isOptionalString(msg.payload.provider, 64) &&
    validTestCapture(msg.payload.capture, msg.payload.tabId),
  FILL_ANSWERS_ALL: (msg) => payloadRecord(msg, ['questions', 'panelNonce']) &&
    validQuestions(msg.payload.questions) && isPanelNonce(msg.payload.panelNonce),
  FILL_ANSWERS_TAB: (msg) => payloadRecord(msg, ['tabId', 'questions', 'capture']) &&
    isSafeId(msg.payload.tabId) && validQuestions(msg.payload.questions) &&
    validTestCapture(msg.payload.capture, msg.payload.tabId),
  TEST_PAGE_SIG: (msg) => payloadRecord(msg, ['tabId']) && isSafeId(msg.payload.tabId),
  TEST_NEXT_PAGE: (msg) => payloadRecord(msg, ['tabId', 'capture', 'inspectOnly']) &&
    isSafeId(msg.payload.tabId) && validTestCapture(msg.payload.capture, msg.payload.tabId) &&
    isOptionalBoolean(msg.payload.inspectOnly),
  PILL_SOLVE_PAGE: (msg) => payloadRecord(msg, ['provider', 'opId']) &&
    isOptionalString(msg.payload.provider, 64) && isOptionalString(msg.payload.opId, 128),
  PILL_SOLVE_ALL: (msg) => payloadRecord(msg, ['provider', 'opId']) &&
    isOptionalString(msg.payload.provider, 64) && isOptionalString(msg.payload.opId, 128),
  PILL_CANCEL: (msg) => payloadRecord(msg, ['opId']) && isOptionalString(msg.payload.opId, 128),
  WEB_SOLVE_PAGE: (msg) => payloadRecord(msg, ['provider', 'opId']) &&
    isOptionalString(msg.payload.provider, 64) && isOptionalString(msg.payload.opId, 128),
  ACTIVATE_WEB_SITE: (msg) => payloadRecord(msg, ['tabId']) && isSafeId(msg.payload.tabId),
  RESOLVE_QUESTION: (msg) => payloadRecord(msg, ['index', 'prevAnswer', 'questionText', 'panelNonce']) &&
    (isSafeId(msg.payload.index) || isString(msg.payload.index, 512)) &&
    isOptionalString(msg.payload.prevAnswer) && isOptionalString(msg.payload.questionText) &&
    isPanelNonce(msg.payload.panelNonce),
  GET_RUNTIME_CONFIG: (msg) => noPayload(msg) ||
    (payloadRecord(msg, ['force']) && isOptionalBoolean(msg.payload.force)),
  CONSUME_DASH_LAUNCH: (msg) => payloadRecord(msg, ['id']) &&
    isString(msg.payload.id, 128) && /^[0-9a-f-]{36}$/i.test(msg.payload.id),
  DOWNLOAD_FILES: (msg) => payloadRecord(msg, [
    'urls', 'token', 'scanId', 'principal',
    'principalError', 'rowToken'
  ]) &&
    validArray(msg.payload.urls, isAllowedAttachmentUrl) &&
    isString(msg.payload.token, 8192) &&
    isHomeworkScanId(msg.payload.scanId) &&
    isString(msg.payload.principal, 512) &&
    isOptionalString(msg.payload.principalError, 1024) &&
    isHomeworkScanId(msg.payload.rowToken),
  LESSON_HISTORY: (msg) => payloadRecord(msg, ['lessonKey']) &&
    isString(msg.payload.lessonKey, 128),
  LIST_SESSIONS: noPayload,
  LIST_MESSAGES: (msg) => noPayload(msg) && isString(msg.sessionId, 512),
  GDZ_SEARCH: (msg) => payloadRecord(msg, ['grade', 'subjectId', 'subtype', 'query']) &&
    (msg.payload.grade == null || isSafeId(msg.payload.grade) || isString(msg.payload.grade, 32)) &&
    (msg.payload.subjectId == null || isSafeId(msg.payload.subjectId) || isString(msg.payload.subjectId, 32)) &&
    isOptionalString(msg.payload.subtype, 256) && isOptionalString(msg.payload.query),
  GDZ_FOR_TASK: (msg) => payloadRecord(msg, ['subject', 'task']) &&
    isString(msg.payload.subject, 1024) && isOptionalString(msg.payload.task),
  GDZ_BOOK_ADD: (msg) => payloadRecord(msg, ['book']) && validGdzBook(msg.payload.book),
  GDZ_BOOK_REMOVE: (msg) => payloadRecord(msg, ['subjectId', 'url']) &&
    isGdzSubjectId(msg.payload.subjectId) &&
    isString(msg.payload.url, MAX_URL_CHARS) &&
    !!normalizeGdzApiUrl(msg.payload.url),
  // Book covers live on either GDZ host, so this one accepts the wider cover
  // allowlist rather than the API-only one the other GDZ messages use.
  GDZ_COVER: (msg) => payloadRecord(msg, ['url']) &&
    isString(msg.payload.url, MAX_URL_CHARS) && isGdzCoverUrl(msg.payload.url)
};

function isMeshContentUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'school.mos.ru' || parsed.hostname === 'uchebnik.mos.ru');
  } catch {
    return false;
  }
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

function classifyMessageSender(sender) {
  if (sender?.id !== chrome.runtime.id) return null;
  // Dashboard pages have sender.tab too, so the extension origin must win first.
  if (typeof sender.url === 'string' && sender.url.startsWith(EXTENSION_PAGE_PREFIX)) return 'extension';
  // tab.url is only the top-level page. Also validate sender.url so an injected
  // foreign-origin iframe inside a Mesh tab cannot inherit the top frame's
  // authority and request content-script capabilities.
  if (sender.tab && isSafeId(sender.tab.id) &&
      isMeshContentUrl(sender.tab.url) && isMeshContentUrl(sender.url)) return 'content';
  // A granted generic page. Only the TOP frame speaks for it: off Mesh a
  // subframe is a third party, and the whole point of the single-document web
  // capture is that no such frame can read the page or write into it.
  if (sender.tab && isSafeId(sender.tab.id) && sender.frameId === 0 &&
      isWebSolvableUrl(sender.tab.url) && isWebSolvableUrl(sender.url) &&
      sameOrigin(sender.tab.url, sender.url)) return 'web';
  return null;
}

function validateMessage(senderClass, msg) {
  if (!isRecord(msg)) return 'Некорректное сообщение.';
  if (!isString(msg.type, 64) || !msg.type) return 'Некорректный тип сообщения.';
  if (!SENDER_MESSAGE_TYPES[senderClass]?.has(msg.type)) return 'Действие недоступно для этого источника.';
  const allowedTopKeys = msg.type === 'GET_ACTION_TOKEN'
    ? ['type', 'action', 'panelNonce']
    : (msg.type === 'LIST_MESSAGES' ? ['type', 'sessionId'] : ['type', 'payload', 'token']);
  if (!hasOnlyKeys(msg, allowedTopKeys)) return 'Некорректная структура сообщения.';
  if (msg.token != null && !isString(msg.token, 128)) return 'Некорректный токен действия.';
  const schema = MESSAGE_SCHEMAS[msg.type];
  if (!schema || !schema(msg)) return 'Некорректные параметры сообщения.';
  if (msg.type === 'SOLVE') {
    const deduped = deduplicateRequestFiles(msg.payload?.files || [], msg.payload?.history || []);
    const budget = validateRequestFileBudget(deduped.allFiles);
    if (!budget.ok) return budget.error;
  }
  if (msg.type === 'OPEN_DASHBOARD') {
    const budget = validateRequestFileBudget(msg.payload?.files || []);
    if (!budget.ok) return budget.error;
  }
  return null;
}

function blockedFeature(msg, config) {
  const features = config?.features || {};
  if (msg.type === 'DOWNLOAD_FILES' && features.mesh_attachments === false) return 'Вложения из дневника временно отключены.';
  // The pill/web commands perform their own fill internally, so they belong
  // to the autofill switch too. Otherwise disabling direct FILL_* messages
  // would leave the one-click/autopilot paths able to mutate the page.
  if (['FILL_ANSWERS_ALL', 'FILL_ANSWERS_TAB', 'TEST_NEXT_PAGE',
    'PILL_SOLVE_PAGE', 'PILL_SOLVE_ALL', 'WEB_SOLVE_PAGE'].includes(msg.type) &&
      features.autofill === false) return 'Автозаполнение временно отключено.';
  if (['WEB_SOLVE_PAGE', 'ACTIVATE_WEB_SITE'].includes(msg.type) &&
      features.other_sites === false) return 'Работа на других сайтах временно отключена.';
  if (msg.type.startsWith('GDZ_') && features.gdz === false) return 'ГДЗ временно отключено.';
  if (['SOLVE', 'SOLVE_TEST', 'PILL_SOLVE_PAGE', 'PILL_SOLVE_ALL', 'RESOLVE_QUESTION', 'WEB_SOLVE_PAGE']
      .includes(msg.type) && features.ai_text === false) return 'Ответы ИИ временно отключены.';
  const files = msg.type === 'SOLVE' ? (msg.payload?.files || []) : [];
  if ((msg.type === 'SOLVE_TEST' && msg.payload?.screenshot) || files.some(isImageFile)) {
    if (features.ai_images === false) return 'Обработка изображений временно отключена.';
  }
  if (files.some(isPdfFile) && features.ai_documents === false) {
    return 'Обработка документов временно отключена.';
  }
  return null;
}

function clearExpiredActionTokens(now = Date.now()) {
  for (const [token, grant] of actionTokens) if (grant.expiresAt <= now) actionTokens.delete(token);
}

function issueActionToken(tabId, action, panelNonce = null) {
  const now = Date.now();
  clearExpiredActionTokens(now);
  const token = crypto.randomUUID();
  const expiresAt = now + ACTION_TOKEN_TTL_MS;
  actionTokens.set(token, { tabId, action, panelNonce, expiresAt });
  return { token, expiresAt };
}

function consumeActionToken(token, tabId, action, panelNonce = null) {
  const grant = actionTokens.get(token);
  // Any presentation burns the capability, including a mismatched one. That
  // keeps it single-use and prevents repeated probing of its binding.
  if (grant) actionTokens.delete(token);
  if (!grant || grant.expiresAt <= Date.now() || grant.tabId !== tabId ||
      grant.action !== action || grant.panelNonce !== panelNonce) {
    return false;
  }
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const senderClass = classifyMessageSender(sender);
  if (!senderClass) {
    sendResponse({ ok: false, error: 'Недоверенный источник сообщения.' });
    return false;
  }
  const validationError = validateMessage(senderClass, msg);
  if (validationError) {
    sendResponse({ ok: false, error: validationError });
    return false;
  }
  if (msg.type === 'GET_ACTION_TOKEN') {
    // A token may only be minted for an action this sender class is allowed to
    // send. Without this, the schema's CONTENT_ACTIONS check alone would let a
    // Mesh page mint a WEB_SOLVE_PAGE capability (and vice versa) — refused
    // later by the capture reader, but refused here is where it belongs.
    if (!SENDER_MESSAGE_TYPES[senderClass]?.has(msg.action)) {
      sendResponse({ ok: false, error: 'Действие недоступно для этого источника.' });
      return false;
    }
    if (PANEL_ACTIONS.has(msg.action)) {
      try {
        matchingAnswerPanelContext(sender.tab.id, msg.panelNonce);
      } catch {
        sendResponse({ ok: false, error: 'Панель ответов устарела.' });
        return false;
      }
    }
    const grant = issueActionToken(sender.tab.id, msg.action, msg.panelNonce ?? null);
    sendResponse({ ok: true, ...grant });
    return false;
  }
  if ((senderClass === 'content' || senderClass === 'web') && CONTENT_ACTIONS.has(msg.type) &&
      !consumeActionToken(
        msg.token,
        sender.tab.id,
        msg.type,
        PANEL_ACTIONS.has(msg.type) ? msg.payload?.panelNonce : null,
      )) {
    sendResponse({ ok: false, error: 'Токен действия недействителен или истёк.' });
    return false;
  }
  (async () => {
    try {
      const featureError = blockedFeature(msg, await getRuntimeConfig());
      if (featureError) {
        sendResponse({ ok: false, error: featureError });
        return;
      }
      switch (msg?.type) {
        case 'GET_DEVICE_ID':
          sendResponse({ ok: true, deviceId: await getDeviceId() });
          break;
        // The popup's fallback hand-off. It cannot open the tour itself: every
        // claim has to run through this one worker so two entry points can
        // never race into two tabs.
        case 'OPEN_ONBOARDING':
          sendResponse({ ok: true, opened: await openOnboardingTour('popup') });
          break;
        case 'SET_LICENSE_KEY':
          sendResponse({ ok: true, status: await setLicenseKeyAndSyncReferral(msg.payload.key) });
          break;
        case 'DEACTIVATE_LICENSE':
          sendResponse({ ok: true, status: await deactivateCurrentLicense() });
          break;
        case 'SYNC_REFERRAL_POINTER':
          sendResponse(REFERRALS_ENABLED
            ? { ok: true, code: await syncReferralPointer() }
            : { ok: false, error: 'referrals_disabled' });
          break;
        case 'DELETE_LOCAL_DATA':
          await deleteAllLocalData();
          sendResponse({ ok: true });
          break;
        case 'OPEN_DASHBOARD':
          await openDashboard(msg.payload);
          sendResponse({ ok: true });
          break;
        case 'SOLVE':
          // Non-streaming fallback (popup / callers that don't open a port).
          sendResponse({ ok: true, result: await withKeepAlive(() => solve(msg.payload)) });
          break;
        case 'SOLVE_TEST': {
          const { tabId, capture } = msg.payload;
          // Whether THIS request can actually show the model the page image.
          // A text-only cached answer is not reused here (see readCached...):
          // the screenshot route exists for pages the DOM text can't carry.
          const withImage = msg.payload.hasVisualMedia === true && !!msg.payload.screenshot;
          const { answer, questions, cached } = await withTabSolveLock(tabId, () => withKeepAlive(async () => {
            const reused = await readCachedTestAnswers(capture, { image: withImage });
            // Reuse skips solveTest's licence/consent gates — run them here, so
            // an expired key or a withdrawn consent stops this path too.
            if (reused) {
              await ensureLicensed();
              if (!(await hasConsent())) throw new Error(CONSENT_REQUIRED_MESSAGE);
            }
            // Parse once: the panel needs it now, and the popup's «Решить все
            // страницы» loop needs the structured questions to auto-fill. On a
            // fresh solve the RAW reply still goes back to the popup — its
            // formatter has salvage tiers for truncated and free-text replies
            // that a re-serialised answer list would throw away.
            const solved = reused ? '' : await solveTest({ ...msg.payload, pageUrl: capture?.url });
            const parsed = reused ? reused.questions : parseTestAnswers(solved);
            // See pillSolveOnePage: keep the owner's diagnostics log gapless so
            // a stale cache hit is visible rather than looking like no solve.
            if (reused) {
              void recordDevTrace({
                kind: 'cache',
                url: capture?.url || null,
                ok: true,
                pageText: msg.payload.text || '',
                pageTextChars: String(msg.payload.text || '').length,
                hasVisualMedia: msg.payload.hasVisualMedia === true,
                screenshot: withImage,
                cached: true,
                questionCount: parsed.length,
                rawAnswer: serializeTestAnswers(parsed),
              });
            }
            if (!reused && parsed.length) {
              await writeCachedTestAnswers(capture, parsed, { image: withImage });
            }
            await withMatchingTestCapture(capture, readTestCaptureContext, async () => {
              // Hand the screenshot to the panel: the popup can take one, the
              // panel's «перерешать» cannot, so this is the only way a re-solve
              // sees the same material the first answer did.
              if (parsed.length) await showAnswersInTab(tabId, parsed, capture, msg.payload.screenshot);
            });
            return {
              answer: reused ? serializeTestAnswers(parsed) : solved,
              questions: parsed,
              cached: !!reused,
            };
          }));
          sendResponse({ ok: true, answer, questions, cached });
          break;
        }
        case 'FILL_ANSWERS_ALL': {
          // The in-page panel's «Заполнить» button routes here so the fill can
          // reach forms inside iframes (the panel's own frame can't). sender.tab
          // is the tab the panel lives in.
          const tabId = sender?.tab?.id;
          const questions = msg.payload?.questions || [];
          const panelNonce = msg.payload?.panelNonce;
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const summary = await withTabSolveLock(tabId, async () => {
            const context = matchingAnswerPanelContext(tabId, panelNonce);
            return withMatchingTestCapture(context.capture, readTestCaptureContext, async () => {
              // Match again inside the mutation lock. A pending replacement
              // invalidates the old nonce before any asynchronous setup runs.
              matchingAnswerPanelContext(tabId, panelNonce);
              return fillAllFrames(tabId, questions, context.capture);
            });
          });
          sendResponse({ ok: true, summary });
          break;
        }
        case 'FILL_ANSWERS_TAB': {
          // Same fill, but driven by the POPUP (no sender.tab) for the multi-page
          // loop — the tab id is passed explicitly. It mutates the form, so it
          // takes the same per-tab lock as every other screen-solve step: the
          // in-page pill's autopilot can be mid-run on this very tab.
          const { tabId, questions, capture } = msg.payload || {};
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          sendResponse({
            ok: true,
            summary: await withTabSolveLock(tabId, () => fillAllFrames(tabId, questions || [], capture)),
          });
          break;
        }
        case 'TEST_PAGE_SIG': {
          const { tabId } = msg.payload || {};
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const capture = await readTestCaptureContext(tabId);
          sendResponse({ ok: true, sig: capture.signature, capture });
          break;
        }
        case 'TEST_NEXT_PAGE': {
          // Navigating the tab is the most destructive step in the loop, so it
          // holds the per-tab lock too — except for the read-only inspection the
          // page-cap check makes, which must stay callable while nothing runs.
          const { tabId, capture } = msg.payload || {};
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const click = !msg.payload?.inspectOnly;
          const status = click
            ? await withTabSolveLock(tabId, () => testNextPage(capture, { click }))
            : await testNextPage(capture, { click });
          sendResponse({ ok: true, status });
          break;
        }
        case 'PILL_SOLVE_PAGE': {
          // The in-page pill's primary action. sender.tab is the test tab — the
          // pill (a content script) can't screenshot/script, so the worker does
          // it all: capture → solve → panel → autofill the visible page.
          const tabId = sender?.tab?.id;
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const signal = beginPillOperation(tabId, msg.payload?.opId);
          // The pill was torn down while this message was in flight.
          if (!signal) { sendResponse({ ok: false, cancelled: true, error: 'отменено' }); break; }
          try {
            const { questions, summary, cached } = await withTabSolveLock(tabId, () =>
              withKeepAlive(() => pillSolveOnePage(tabId, msg.payload?.provider, signal)));
            sendResponse({ ok: true, count: questions.length, summary, cached: !!cached });
          } catch (e) {
            if (!isPillCancellation(e)) throw e;
            sendResponse({ ok: false, cancelled: true, error: e.message });
          } finally {
            endPillOperation(tabId, signal);
          }
          break;
        }
        case 'PILL_SOLVE_ALL': {
          // The pill's «все страницы» autopilot: solve+fill every page, advancing
          // with «Далее», stopping before any submit/finish control.
          const tabId = sender?.tab?.id;
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const signal = beginPillOperation(tabId, msg.payload?.opId);
          // The pill was torn down while this message was in flight.
          if (!signal) { sendResponse({ ok: false, cancelled: true, error: 'отменено' }); break; }
          try {
            const { outcome, solved, cached, partial, unrecognized } = await withTabSolveLock(tabId, () =>
              withKeepAlive(() => pillSolveAllPages(tabId, msg.payload?.provider, signal)));
            sendResponse({ ok: true, outcome, solved, cached, partial, unrecognized });
          } catch (e) {
            if (!isPillCancellation(e)) throw e;
            sendResponse({ ok: false, cancelled: true, error: e.message });
          } finally {
            endPillOperation(tabId, signal);
          }
          break;
        }
        case 'WEB_SOLVE_PAGE': {
          // The generic pill's only action: solve, show and fill THIS page on a
          // site the user granted. No screenshot (a page click confers no
          // activeTab) and no pagination — see the section header.
          const tabId = sender?.tab?.id;
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const signal = beginPillOperation(tabId, msg.payload?.opId);
          if (!signal) { sendResponse({ ok: false, cancelled: true, error: 'отменено' }); break; }
          try {
            const { questions, summary, cached, unitCount } = await withTabSolveLock(tabId, () =>
              withKeepAlive(() => webSolveOnePage(tabId, msg.payload?.provider, signal)));
            sendResponse({
              ok: true,
              count: questions.length,
              summary,
              cached: !!cached,
              fillable: unitCount > 0,
            });
          } catch (e) {
            if (!isPillCancellation(e)) throw e;
            sendResponse({ ok: false, cancelled: true, error: e.message });
          } finally {
            endPillOperation(tabId, signal);
          }
          break;
        }
        case 'ACTIVATE_WEB_SITE': {
          // The popup has just obtained the optional host permission for this
          // tab's origin. Registration covers future page loads; the tab the
          // student is looking at needs the pill injected now.
          const { tabId } = msg.payload || {};
          await syncWebPillRegistration();
          const tab = await chrome.tabs.get(tabId);
          if (!isWebSolvableUrl(tab?.url) || !(await hasWebSolvePermission(tab.url))) {
            sendResponse({ ok: false, error: 'Сайт не разрешён.' });
            break;
          }
          try {
            await chrome.scripting.executeScript({
              target: { tabId, frameIds: [0] },
              files: [...WEB_PILL_FILES],
            });
          } catch {
            // Already injected, or the page forbids scripting. The registration
            // above still covers the next load, so this is not a failure.
          }
          sendResponse({ ok: true });
          break;
        }
        case 'PILL_CANCEL': {
          // De-escalation only: it can stop the sender tab's own run and
          // nothing else, so unlike the solve actions it needs no capability
          // token — requiring one would make cancelling fail exactly when the
          // worker was recycled and the student most needs it to stop.
          const tabId = sender?.tab?.id;
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          sendResponse({ ok: true, cancelled: cancelPillOperation(tabId, msg.payload?.opId) });
          break;
        }
        case 'RESOLVE_QUESTION': {
          // The answer panel's per-line «перерешать» button: re-solve ONE
          // question on the panel's tab. sender.tab is that (test) tab.
          const tabId = sender?.tab?.id;
          const panelNonce = msg.payload?.panelNonce;
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const resolved = await withTabSolveLock(tabId, () =>
            withKeepAlive(async () => {
              const context = matchingAnswerPanelContext(tabId, panelNonce);
              return withMatchingTestCapture(
                context.capture,
                readTestCaptureContext,
                async () => {
                  matchingAnswerPanelContext(tabId, panelNonce);
                  const answer = await resolveOneQuestion(
                    tabId,
                    msg.payload || {},
                    context.capture,
                    context.screenshot,
                  );
                  // Do not release an old AI result to content after a panel
                  // replacement, even when both captures happen to look alike.
                  matchingAnswerPanelContext(tabId, panelNonce);
                  // Fold the correction into the reuse cache so the next visit
                  // fills the answer the student kept, not the one they redid.
                  // A panel opened by the pill carries no screenshot, so say so:
                  // the entry must not keep claiming to be image-backed once one
                  // of its answers was re-solved from text alone.
                  await patchCachedTestAnswer(context.capture, msg.payload?.index, {
                    ...answer,
                    image: !!context.screenshot,
                  });
                  return answer;
                },
              );
            }));
          sendResponse({
            ok: true,
            answer: resolved.answer,
            parts: resolved.parts,
            explain: resolved.explain,
          });
          break;
        }
        case 'GET_RUNTIME_CONFIG':
          // Remote hot-fix config (scrape selectors / vocabulary / update notice)
          // with built-in fallback. Never throws; cached for RUNTIME_CONFIG_TTL_MS.
          sendResponse({ ok: true, config: await getRuntimeConfig({ force: !!msg.payload?.force }) });
          break;
        case 'CONSUME_DASH_LAUNCH': {
          const dashboardUrl = chrome.runtime.getURL('src/dashboard/dashboard.html');
          if (sender?.id !== chrome.runtime.id || sender?.url?.split('?')[0] !== dashboardUrl) {
            sendResponse({ ok: false, error: 'dashboard context required' });
            break;
          }
          sendResponse({ ok: true, payload: await consumeDashboardLaunch(msg.payload?.id) });
          break;
        }
        case 'DOWNLOAD_FILES':
          sendResponse({
            ok: true,
            files: await downloadFiles({ ...msg.payload, tabId: sender.tab.id })
          });
          break;
        case 'LESSON_HISTORY':
          // The dashboard asks this before opening a lesson: if this exact
          // homework row was already solved, it replays the stored conversation
          // instead of buying the same answer twice.
          sendResponse({ ok: true, session: await findLessonSession(msg.payload?.lessonKey) });
          break;
        case 'LIST_SESSIONS':
          sendResponse({ ok: true, sessions: await listSessions() });
          break;
        case 'LIST_MESSAGES':
          sendResponse({ ok: true, messages: await listMessages(msg.sessionId) });
          break;
        // ---------- GDZ ----------
        case 'GDZ_SEARCH': {
          const catalog = await getCatalog();
          sendResponse({ ok: true, books: searchBooks(catalog, msg.payload || {}) });
          break;
        }
        case 'GDZ_FOR_TASK': {
          // payload: { subject, task } — the dashboard's per-lesson lookup.
          const { subject, task } = msg.payload || {};
          const sid = mapSubjectToId(subject);
          const { gdzBooks = {} } = await chrome.storage.local.get('gdzBooks');
          // A subject may hold several books (textbook + workbook). Normalise the
          // legacy single-object shape to an array so both resolve.
          const raw = sid != null ? gdzBooks[sid] : null;
          const books = Array.isArray(raw) ? raw : (raw ? [raw] : []);
          if (!books.length) { sendResponse({ ok: true, configured: false }); break; }

          // Resolve every configured book and merge. Each answer carries its own
          // book + mode so a page-structured workbook and an exercise-structured
          // textbook are labelled correctly side by side in the same card.
          const answers = [];
          let primaryMode = null, primaryBook = null;
          for (const book of books) {
            const res = await resolveForTask(book, task || '');
            const bookMeta = { title: book.title, breadcrumb: book.breadcrumb, year: book.year, study_level: book.study_level };
            if (!primaryBook && res.answers.some((a) => a.found)) { primaryMode = res.mode; primaryBook = bookMeta; }
            for (const a of res.answers) {
              a.mode = res.mode;
              a.book = bookMeta;
              if (!a.found) continue;
              // Parallel image fetches (independent network calls), source order kept.
              const settled = await Promise.all(
                (a.images || []).map((u) => fetchTaskImage(u).catch(() => null))
              );
              a.inlined = settled.filter(Boolean);
            }
            answers.push(...res.answers);
          }
          const fallback = { title: books[0].title, breadcrumb: books[0].breadcrumb, year: books[0].year, study_level: books[0].study_level };
          // GDZ pull telemetry: count it only when we actually surfaced answer
          // image(s), not on an empty lookup. Content-free (subject + counts).
          const gdzImages = answers.reduce((s, a) => s + (a.found ? (a.inlined?.length || 0) : 0), 0);
          if (gdzImages > 0) {
            track('gdz_pull', { subject, meta: { source: 'lesson', books: books.length, images: gdzImages } });
          }
          sendResponse({
            ok: true, configured: true,
            mode: primaryMode || 'exercise',
            book: primaryBook || fallback,
            answers
          });
          break;
        }
        case 'GDZ_BOOK_ADD':
          sendResponse({
            ok: true,
            gdzBooks: await addGdzBook({
              ...msg.payload.book,
              url: normalizeGdzApiUrl(msg.payload.book.url),
            }),
          });
          break;
        // Settings renders book covers. They used to be direct <img src> loads,
        // which only worked because the DNR rule rewrote the User-Agent on the
        // page's own image requests; with the permission gone they have to come
        // through the proxy like every other GDZ byte.
        case 'GDZ_COVER':
          sendResponse({ ok: true, image: await fetchCoverImage(msg.payload.url) });
          break;
        case 'GDZ_BOOK_REMOVE':
          sendResponse({
            ok: true,
            gdzBooks: await removeGdzBook(
              msg.payload.subjectId,
              normalizeGdzApiUrl(msg.payload.url),
            ),
          });
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e) {
      // Surface the clean message (e.g. the friendly Russian "Ключ … не задан")
      // WITHOUT the "Error: " class prefix that String(e) prepends — same as the
      // streaming port below. The prefix would otherwise leak into the popup's
      // "Ошибка: …" line and defeat the pill errText's Cyrillic-passthrough.
      const emsg = String(e?.message || e);
      // Content-free error signal for the dashboard: a fixed code from the
      // errorCode() vocabulary — raw message text (which can echo provider
      // output or file names) never leaves the device.
      track('error', { meta: { code: errorCode(e), op: msg?.type || null } });
      sendResponse({ ok: false, error: emsg, code: e?.code || undefined });
    }
  })();
  return true; // async
});

// MV3 keepalive. A service worker is killed after ~30s in which it makes no
// qualifying chrome.* API call — and crucially, `fetch()` does NOT count, nor
// does posting over a port. The СМЭШ proxy answer is now delivered by a loop of
// short poll fetches (lib/smesh-proxy.js — long-lived connections to our SNI
// are throttled by RU DPI), so a long answer makes no qualifying call for tens
// of seconds and Chrome tears the worker down mid-stream (observed: dead at
// ~17s, port dropped → "соединение прервано"). Pinging a trivial chrome API on
// an interval resets the idle timer. Ref-counted so overlapping solves share
// one timer and it stops the moment the last one ends.
let keepAliveTimer = null;
let keepAliveHolders = 0;
function pingAlive() {
  try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch { /* no-op */ }
}
function acquireKeepAlive() {
  keepAliveHolders += 1;
  if (!keepAliveTimer) {
    pingAlive(); // reset the idle timer NOW — the worker may already be aged
    keepAliveTimer = setInterval(pingAlive, 10000);
  }
}
function releaseKeepAlive() {
  keepAliveHolders = Math.max(0, keepAliveHolders - 1);
  if (keepAliveHolders === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// Long AI work behind a chrome.runtime MESSAGE (popup / pill flows) needs the
// same keepalive as the port-based solve below: a chunked upload plus the
// poll loop can run for minutes making no qualifying chrome.* call, and the
// worker would otherwise be recycled mid-solve. Hoisted declaration — used by
// the onMessage listener defined above.
async function withKeepAlive(fn) {
  acquireKeepAlive();
  try { return await fn(); } finally { releaseKeepAlive(); }
}

// Streaming solve over a long-lived port. The dashboard connects with
// name 'solve', sends one { type:'SOLVE', payload }, and receives a series of
// { type:'delta', text } messages followed by { type:'done', result } or
// { type:'error', error }. An open port also keeps the service worker alive
// for the duration of the (possibly long) streamed answer.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'solve') return;
  const dashboardUrl = chrome.runtime.getURL('src/dashboard/dashboard.html');
  if (port.sender?.id !== chrome.runtime.id ||
      typeof port.sender?.url !== 'string' ||
      !port.sender.url.startsWith(dashboardUrl)) {
    try { port.disconnect(); } catch { /* already closed */ }
    return;
  }
  // Abort the in-flight provider call if the dashboard tab is closed/reloaded
  // mid-stream. Without this the upstream fetch keeps streaming (and getting
  // charged) until the 60-s idle timeout, even though no UI is listening.
  let activeCtrl = null;
  port.onDisconnect.addListener(() => {
    console.log('[solve] port disconnected');
    try { activeCtrl?.abort(); } catch { /* already aborted */ }
    activeCtrl = null;
  });
  port.onMessage.addListener(async (msg) => {
    const safePost = (m) => { try { port.postMessage(m); } catch { /* port closed */ } };
    // Check the per-port lock before parsing another SOLVE payload: even a bad
    // overlapping request must not disconnect the port and thereby abort the
    // legitimate solve that already owns it.
    if (activeCtrl && msg?.type === 'SOLVE') {
      safePost({ type: 'error', error: 'Решение уже выполняется. Дождитесь текущего ответа.' });
      return;
    }
    const validationError = msg?.type === 'SOLVE' ? validateMessage('extension', msg) : 'Недопустимый тип сообщения.';
    if (validationError) {
      safePost({ type: 'error', error: validationError });
      // Only tear the port down when nothing is running on it. Disconnecting
      // fires onDisconnect → activeCtrl.abort(), so a stray/invalid message must
      // NOT disconnect while a legitimate solve is streaming on this same port.
      if (!activeCtrl) { try { port.disconnect(); } catch { /* already closed */ } }
      return;
    }
    const ctrl = new AbortController();
    activeCtrl = ctrl;
    const t0 = Date.now();
    acquireKeepAlive();
    console.log('[solve] SOLVE received');
    try {
      const result = await solve(msg.payload, (text) => safePost({ type: 'delta', text }), ctrl.signal);
      console.log('[solve] done +' + (Date.now() - t0) + 'ms');
      safePost({ type: 'done', result });
    } catch (e) {
      // Provider errors may quote upstream response text, file names, or other
      // task-derived material. Keep operational console output content-free;
      // the caller still receives the user-facing message below.
      console.log('[solve] failed +' + (Date.now() - t0) + 'ms:', errorCode(e), 'aborted=' + ctrl.signal.aborted);
      // Caller-initiated abort: the port is already gone, no point posting.
      if (e?.name !== 'AbortError' && !ctrl.signal.aborted) {
        track('error', { meta: { code: errorCode(e), op: 'solve_stream' } });
        safePost({ type: 'error', error: String(e?.message || e) });
      }
    } finally {
      releaseKeepAlive();
      if (activeCtrl === ctrl) activeCtrl = null;
    }
  });
});

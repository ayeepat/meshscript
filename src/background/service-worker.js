/**
 * Background service worker (MV3, type: module).
 * Orchestrates the AI provider call and local solve-history persistence.
 * All API keys live here / in storage, never in content scripts.
 */
import { askAI, normalizeAIProvider } from '../lib/ai.js';
import { getByoKey } from '../lib/qwen.js';
import { fetchOpenRouterCredits, getSpendHistory } from '../lib/openrouter.js';
import { buildSystemPrompt, categoryForSubject } from '../lib/subject-router.js';
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../lib/prompts.js';
import { createSession, addMessage, listSessions, listMessages, cleanupLocalData } from '../lib/history.js';
import { ensureLicensed } from '../lib/license.js';
import { hasConsent, CONSENT_REQUIRED_MESSAGE } from '../lib/consent.js';
import { getRuntimeConfig } from '../lib/remote-config.js';
import { isBareTextbookRef, classifyTask, needsAudio } from '../lib/task-classifier.js';
import { classifyTasksAI } from '../lib/classify-ai.js';
import { isReadableFile, hasPdf, isAudioFile, isPdfFile, isImageFile } from '../lib/file-kinds.js';
import { track, heartbeat, usageFields, errorCode } from '../lib/telemetry.js';
import { getCatalog, searchBooks, resolveTask, resolveForTask, fetchTaskImage } from '../lib/gdz-api.js';
import { mapSubjectToId } from '../lib/gdz-match.js';
import { prepareFiles } from '../lib/extract.js';
import { transcribeAudioFiles } from '../lib/transcribe.js';
import { compressImageFiles } from '../lib/image-compress.js';
import {
  storeDashboardLaunch,
  consumeDashboardLaunch,
  cleanupDashboardLaunches
} from '../lib/dashboard-launch.js';
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

// Follow-ups re-send prior context. Cap how many MESSAGES we replay: full
// worked solutions are long, and on a paid provider every re-sent message is
// money. 8 messages ≈ 4 back-and-forth turns — enough recent context to follow
// up without re-sending the whole chat. (Bump to 16 for ~8 full turns.)
const MAX_HISTORY_MESSAGES = 8;

// Storage trust split. storage.LOCAL holds the secrets (API keys, license) —
// lock it to trusted contexts so a compromised mos.ru renderer can't read them
// through our content scripts (supported since Chrome 130; older builds throw
// and keep the historical behaviour). storage.SESSION is the deliberately
// UNTRUSTED-readable area: it must only ever hold UI state (panel positions)
// plus the non-sensitive `theme`/`aiProvider` mirror below — never a secret.
try {
  chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
    ?.catch?.(() => { /* pre-130 Chrome — accepted residual risk */ });
} catch { /* pre-130 Chrome */ }
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

// Retention sweep: history (7 d), weekHomework (24 h), pendingUpload (1 h,
// base64-heavy), taskClassCache + gdzTaskCache lookup caches (30 d). Alarm
// survives SW teardown; the startup call covers the gap after a browser
// restart before the alarm first fires.
try {
  chrome.alarms.create('smesh-retention', { periodInMinutes: 6 * 60 });
  chrome.alarms.create('smesh-launch-retention', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'smesh-retention') void cleanupLocalData();
    if (alarm.name === 'smesh-launch-retention') void cleanupDashboardLaunches();
  });
} catch { /* alarms unavailable — startup sweep below still runs */ }
void cleanupLocalData();
void cleanupDashboardLaunches();

// Warm the remote runtime config on every SW spin-up (cheap: a single cached
// fetch at most once per TTL). Fire-and-forget — a failure is a silent no-op and
// the extension uses its built-in defaults. See lib/remote-config.js.
getRuntimeConfig().catch(() => { /* offline / not hosted — defaults apply */ });

// Daily-active signal for the admin dashboard. Self-throttled to one ping per
// 6h (see telemetry.heartbeat), so frequent SW spin-ups don't spam the backend.
heartbeat();

// First install / version upgrade — a one-shot funnel signal. Fire-and-forget.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') track('install');
  else if (details.reason === 'update') {
    track('update', { meta: { from: details.previousVersion || null } });
    migrateNararouter().catch(() => { /* best-effort */ });
  }
});

// NaraRouter was removed (replaced by Qwen/DeepSeek). An install that still has
// it selected would fall through to the dispatcher's OpenRouter default and
// dead-end on "ключ не задан" — instead, move the selection to a provider the
// user actually has a key for, and drop the orphaned key from storage.
async function migrateNararouter() {
  const { aiProvider, nararouterApiKey, openrouterApiKey } =
    await chrome.storage.local.get(['aiProvider', 'nararouterApiKey', 'openrouterApiKey']);
  if (aiProvider === 'nararouter') {
    // Prefer OpenRouter if its key exists, else Groq. If neither key exists the
    // popup's isReadyToSolve() gate reopens onboarding — the right recovery path.
    await chrome.storage.local.set({ aiProvider: openrouterApiKey ? 'openrouter' : 'groq' });
  }
  if (nararouterApiKey !== undefined) {
    await chrome.storage.local.remove(['nararouterApiKey', 'nararouterModelsCache']);
  }
}

// Open the full-window dashboard when the popup asks to "Solve". The payload
// itself lives in short-lived storage.session and can only be consumed once by
// the dashboard through the serialized worker handler below.
async function openDashboard(payload) {
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
 *  - audio: this tool can NEVER process sound. If the task needs listening and
 *    no readable text/file is attached (a transcript can't arrive as audio),
 *    refuse the audio outright.
 *  - attachment: task points at a file/variant/worksheet but nothing readable
 *    is attached -> ask for it (Office files like .docx don't count: unreadable).
 *  - textbook ref: bare «Упр. 25 / §3» with no page photo -> ask for the photo.
 *
 * "Readable" = image, PDF or plain text (see file-kinds). An attached .docx or
 * an empty file does not satisfy the requirement.
 */
function missingInputGate(category, task, files) {
  const hasReadable = files.some(isReadableFile);
  const cls = classifyTask(task);
  const audio = needsAudio(task);

  // An audio file IS attached but still isn't readable — a successful
  // transcription would have replaced it with a text/plain file (see
  // transcribeAudioFiles). So it's here means Whisper didn't run or returned
  // nothing. Point at the likely cause instead of telling the user to attach a
  // file they already attached.
  if (files.some(isAudioFile) && !hasReadable) {
    return 'Не удалось расшифровать аудиозапись. Проверьте, что в настройках указан ключ Groq ' +
      '(бесплатный — он нужен для распознавания речи) и не исчерпан его дневной лимит, ' +
      'затем попробуйте ещё раз. Либо пришлите готовую расшифровку (текст) записи.';
  }

  if (cls.kind === 'attachment' && !hasReadable) {
    let msg = 'Не могу решить это задание без самого материала. ' +
      'Пришлите файл варианта/задания (PDF, фото или скриншот страницы), и я всё решу.';
    if (audio) {
      msg += '\n\nДля аудирования прикрепите сам аудиофайл (mp3, m4a, wav…) — я его ' +
        'расшифрую и решу эту часть. Либо пришлите готовую расшифровку (текст) записи.';
    }
    return msg;
  }

  if (audio && !hasReadable) {
    return 'В этом задании нужно аудирование. Прикрепите аудиофайл записи (mp3, m4a, wav…) — ' +
      'я расшифрую его и решу. Либо пришлите готовую расшифровку (текст) или фото/скан заданий.';
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
        const settled = await Promise.all(a.images.map((u) => fetchTaskImage(u).catch(() => null)));
        for (const img of settled) if (img && images.length < 6) images.push(img);
        if (images.length >= 6) break;
      }
      if (images.length >= 6) break;
    }
    return images;
  } catch { return []; }
}

/**
 * Solve a task with the AI provider + chat history. Persist to local history.
 * @param {object} p
 * @param {string} [p.mode] answer mode (brief/explain) — see subject-router
 * @param {(chunk:string)=>void} [onDelta] stream callback (token-by-token)
 */
async function solve({ subject, task, files = [], sessionId = null, history = [], mode }, onDelta, signal) {
  // License gate. No-op while LICENSE_ENFORCED is off (preorder window).
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
  history = history.slice(-MAX_HISTORY_MESSAGES);
  const deduped = deduplicateRequestFiles(files, history);
  files = deduped.files;
  history = deduped.history;
  const fileBudget = validateRequestFileBudget(deduped.allFiles);
  if (!fileBudget.ok) throw new Error(fileBudget.error);

  // Extract Office files (.docx/.pptx/.xlsx) to inline text RIGHT HERE, locally
  // and for free — no API call. This both lets the model actually solve from
  // them and lets the gate below see them as readable material.
  files = await prepareFiles(files);

  // Listening (аудирование) clips can't be read by the solver model, so
  // transcribe any attached audio to text via Groq Whisper FIRST. After this an
  // audio attachment counts as readable material, so the gate below stops
  // refusing it and the normal solve path answers the listening task. On any
  // failure (no Groq key, daily cap, bad codec) the audio passes through
  // unchanged and the gate's "send a transcript" refusal still applies.
  files = await transcribeAudioFiles(files);

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
    const gate = missingInputGate(category, task, files);
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
  // cap). History too — the dashboard replays a turn's ORIGINAL files on
  // follow-ups, so without this a follow-up re-ships the uncompressed photo.
  // Fail-open — an image that can't be recompressed ships as-is.
  files = await compressImageFiles(files);
  history = await Promise.all(history.map(async (m) =>
    m?.files?.length ? { ...m, files: await compressImageFiles(m.files) } : m));
  const finalAttachments = deduplicateRequestFiles(files, history);
  files = finalAttachments.files;
  history = finalAttachments.history;
  const finalBudget = validateRequestFileBudget(finalAttachments.allFiles);
  if (!finalBudget.ok) throw new Error(finalBudget.error);

  const systemPrompt = await buildSystemPrompt(subject, mode);
  // PDFs require a PDF-capable backend. The СМЭШ proxy (Qwen/DeepSeek without
  // a BYO Alibaba key) handles them itself — it re-routes a PDF-carrying job
  // to its Gemini chain server-side — so those requests pass through
  // untouched. Everyone else (Groq, OpenRouter, BYO DashScope) is forced to
  // OpenRouter, whose Gemini reads PDFs natively.
  let provider;
  const requestHasPdf = hasPdf(files) || history.some((m) => m?.files?.some(isPdfFile));
  if (requestHasPdf) {
    const { aiProvider } = await chrome.storage.local.get('aiProvider');
    const chosen = normalizeAIProvider(aiProvider);
    const proxyReadsPdf = (chosen === 'qwen' || chosen === 'deepseek') && !(await getByoKey());
    if (!proxyReadsPdf) {
      provider = 'openrouter';
      // Explain WHY a key is suddenly needed (the user may have deliberately
      // picked free Groq, which can't read PDFs) instead of a bare "key not
      // set" error — and point at the keyless licensed path first.
      const { openrouterApiKey } = await chrome.storage.local.get('openrouterApiKey');
      if (!openrouterApiKey) {
        return {
          answer: 'В задании есть PDF. Его умеют читать Qwen и DeepSeek (по лицензии СМЭШ, ключи не нужны) — ' +
            'переключитесь на один из них в настройках расширения. Либо добавьте ключ OpenRouter (модель Gemini), ' +
            'либо пришлите это задание фотографиями страниц / текстом.',
          sessionId
        };
      }
    }
  }
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
  const answer = await askAI(
    systemPrompt, userTask, files,
    history,
    { onDelta, provider, signal, onUsage: (u, prov) => { usage = u; usedProvider = prov; } }
  );

  // Usage telemetry: one content-free 'solve' event with tokens/cost, subject
  // and attachment counts. Fire-and-forget — never blocks or fails the answer.
  track('solve', {
    subject,
    ...usageFields(usedProvider, usage),
    files_pdf: files.filter(isPdfFile).length,
    files_img: files.filter(isImageFile).length,
    meta: {
      mode: mode || 'brief',
      followup: history.length > 0 ? 1 : 0,
      gdz_auto: gdzAttached || 0,
      category
    }
  });

  // Persist to local history (non-fatal if storage write fails).
  try {
    let sid = sessionId;
    if (!sid) {
      const session = await createSession(subject, task);
      sid = session.id;
    }
    await addMessage(sid, 'user', task || '(файл)');
    await addMessage(sid, 'assistant', answer);
    return { answer, sessionId: sid };
  } catch (e) {
    return { answer, sessionId, storageError: String(e) };
  }
}

/**
 * Solve an in-app Mesh test from a screenshot + extracted page text.
 * Answers are concise («№N: ответ») and intentionally NOT persisted.
 */
async function solveTest({ text, screenshot, provider } = {}) {
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
  const askOpts = {
    responseFormat: 'json_object',
    reasoning: { effort: 'medium' },
    onUsage: (u, prov) => { usage = u; usedProvider = prov; }
  };
  if (providerOverride) askOpts.provider = providerOverride;
  // Shrink the capture before it's sent: a full-page JPEG is still hundreds of
  // KB, and on the proxy (RU) path that becomes a chunked upload — fewer, faster
  // chunks the smaller it is. Fail-open (compressImageFiles returns it as-is).
  const shot = screenshot ? (await compressImageFiles([screenshot]))[0] : null;
  const answer = await askAI(systemPrompt, userText, shot ? [shot] : [], [], askOpts);
  track('test_solve', {
    ...usageFields(usedProvider, usage),
    files_img: screenshot ? 1 : 0
  });
  return answer;
}

/**
 * Re-solve a SINGLE question on the current test page (the answer panel's
 * «перерешать» button). Re-captures the visible page (the page on screen is the
 * source of truth — the original screenshot isn't kept) and asks the model for
 * just that one question, optionally telling it the previous answer so it can
 * confirm or correct. Same licence/consent gate as solveTest. Returns the fresh
 * answer string ('' if nothing parseable came back).
 */
async function resolveOneQuestion(tabId, windowId, tabUrl, { index, prevAnswer, questionText } = {}) {
  await ensureLicensed();
  if (!(await hasConsent())) throw new Error(CONSENT_REQUIRED_MESSAGE);
  const { pageText, screenshot } = await capturePageForPill(tabId, windowId, tabUrl);
  const systemPrompt = DEFAULT_PROMPTS[PROMPT_CATEGORIES.TEST_ANSWER];
  const n = String(index ?? '').trim();
  const focus =
    `Перепроверь и реши ТОЛЬКО вопрос №${n} этого теста (текст страницы ниже + скриншот).` +
    (questionText ? ` Вопрос: «${String(questionText).slice(0, 600)}».` : '') +
    (prevAnswer ? ` Предыдущий ответ был «${String(prevAnswer).slice(0, 300)}» — реши заново и дай самый точный ответ (можешь подтвердить или исправить).` : '') +
    ` Верни JSON {"answers":[{"n":"${n}","a":"…"}]} ровно с одним элементом для этого вопроса` +
    ' (если у вопроса несколько полей для ответа — добавь поле "p", как описано в инструкции).\n\n' +
    'Текст страницы теста (может содержать навигационный мусор — игнорируй его):\n\n' +
    (pageText || '(текст не извлечён, смотри скриншот)');
  let usage = null, usedProvider = null;
  const shot = screenshot ? (await compressImageFiles([screenshot]))[0] : null;
  const answer = await askAI(systemPrompt, focus, shot ? [shot] : [], [], {
    responseFormat: 'json_object',
    reasoning: { effort: 'high' },
    onUsage: (u, prov) => { usage = u; usedProvider = prov; }
  });
  track('test_requestion', { ...usageFields(usedProvider, usage), files_img: screenshot ? 1 : 0 });
  const parsed = parseTestAnswers(answer);
  const match = parsed.find((q) => String(q.index) === n) || parsed[0];
  // Return parts too so a re-solved multi-field question (x & y, x₁ & x₂) still
  // fills every box, not just the first.
  return match ? { answer: match.answer, parts: match.parts || null } : { answer: '', parts: null };
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

/**
 * Map the model's {answers:[{n,a}]} reply to the panel's {index, text, answer}
 * shape. Tiered like the popup's formatter so a truncated reply still surfaces
 * what arrived: whole JSON → embedded JSON → loose "n"/"a" pair regex.
 * The TEST_ANSWER prompt doesn't return per-question text, so `text` is "".
 */
function parseTestAnswers(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const make = (n, a, c, p) => {
    const q = {
      index: typeof n === 'number' ? n : (String(n).trim() || ''),
      text: '',
      answer: String(a ?? '').trim()
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
    return q;
  };
  const fromObj = (obj) => {
    if (!obj || !Array.isArray(obj.answers)) return null;
    const out = obj.answers
      .filter((x) => x && x.a != null && x.n != null)
      .map((x) => make(x.n, x.a, x.c, x.p));
    return out.length ? out : null;
  };
  try { const r = fromObj(JSON.parse(raw)); if (r) return r; } catch { /* not pure JSON */ }
  const embedded = raw.match(/\{[\s\S]*\}/);
  if (embedded) {
    try { const r = fromObj(JSON.parse(embedded[0])); if (r) return r; } catch { /* embedded failed */ }
  }
  const out = [];
  const re = /"n"\s*:\s*(?:"([^"]*)"|([^\s,}]+))\s*,\s*"a"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const n = (m[1] ?? m[2] ?? '').trim();
    let a = m[3];
    try { a = JSON.parse('"' + a + '"'); } catch { /* keep raw escapes */ }
    out.push(make(n, a));
  }
  return out;
}

/**
 * Render the parsed answers as a floating panel on the test tab. The popup
 * still shows them too — the panel just outlives the popup so the user can
 * keep reading while they fill the form. Best-effort: a restricted page or
 * an in-flight navigation just means no panel; the popup is the fallback.
 */
async function showAnswersInTab(tabId, questions) {
  if (!tabId || !questions.length) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/answer-panel.js', 'src/content/scraper.js']
    });
  } catch { /* manifest may already have injected, or the page disallows scripting */ }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_ANSWERS', payload: { questions } });
  } catch { /* no receiver — content script blocked on this page */ }
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
  if (!total) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function downloadFile(rawUrl, headers, maxBytesCap = Infinity) {
  const original = parseAttachmentUrl(rawUrl);
  if (!original) { dbg('[СМЭШ AI] rejected attachment URL', rawUrl); return null; }
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
        if (redirects >= ATTACHMENT_REDIRECT_LIMIT) return null;
        const next = parseAttachmentUrl(res.headers.get('location'), current);
        if (!next) return null;
        try { await res.body?.cancel('following validated redirect'); } catch { /* already closed */ }
        current = next;
        continue;
      }
      if (!res.ok) { dbg('[СМЭШ AI] download http', res.status, current.href); return null; }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html') || ct.includes('text/xml')) {
        dbg('[СМЭШ AI] download got HTML (auth redirect?)', current.href);
        return null;
      }
      const name = nameFromUrl(current.href);
      const mimeType = inferMime(name, ct);
      const typeMaxBytes = isAudioFile({ name, mimeType })
        ? MAX_AUDIO_UPLOAD_BYTES
        : MAX_STANDARD_UPLOAD_BYTES;
      const maxBytes = Math.min(typeMaxBytes, maxBytesCap);
      const bytes = await readBoundedBody(res, maxBytes, ctrl);
      if (!bytes) { dbg('[СМЭШ AI] download size/empty skip', current.href); return null; }
      dbg('[СМЭШ AI] downloaded', name, mimeType, bytes.byteLength + 'b');
      return { mimeType, dataBase64: abToBase64(bytes), name, byteLength: bytes.byteLength };
    }
  } catch (e) {
    dbg('[СМЭШ AI] download exception', String(e), current.href);
    return null;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return null;
}

// Reconstruct Mesh's required family-web headers from a bare token. Mirrors the
// content script's meshHeaders() so the backward-compat (token-only) download
// path still carries the X-mes-* set the API and file store expect — Authorization
// alone gets bounced to the auth page on some endpoints.
function meshHeadersFromToken(token) {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-mes-subsystem': 'familyweb',
    'X-Mes-Role': 'student',
    'X-Mes-RoleId': '1',
    Authorization: 'Bearer ' + token
  };
}

function attachmentHeaders(headers) {
  const allowed = new Set(['accept', 'authorization', 'x-mes-subsystem', 'x-mes-role', 'x-mes-roleid']);
  return Object.fromEntries(Object.entries(headers || {}).filter(([key, value]) =>
    allowed.has(key.toLowerCase()) && typeof value === 'string'));
}

// `headers` come straight from the content script's discovery (Bearer token +
// Mesh's X-mes-* set). A bare `token` is still accepted for backward-compat.
async function downloadFiles({ urls = [], headers = null, token = null }) {
  const hdrs = attachmentHeaders(headers || (token ? meshHeadersFromToken(token) : {}));
  const files = [];
  let totalBytes = 0;
  // Mirror validateRequestFileBudget here so local decoded allocation cannot
  // exceed the provider request-wide budget the downloaded files must fit.
  for (const url of urls.slice(0, 5)) {
    const remainingBytes = MAX_REQUEST_FILE_BYTES - totalBytes;
    if (remainingBytes <= 0) break;
    if (!isAllowedAttachmentUrl(url)) continue;
    const f = await downloadFile(url, hdrs, remainingBytes);
    if (f) {
      totalBytes += f.byteLength;
      const { byteLength, ...file } = f;
      files.push(file);
    }
  }
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
function fillMathQuillMain(questions) {
  try {
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
    var markers = [];
    var qRoot = document.body || document.documentElement;
    if (qRoot) {
      var qWalker = document.createTreeWalker(qRoot, NodeFilter.SHOW_TEXT, null);
      var checkedParents = new Set();
      var tn;
      while ((tn = qWalker.nextNode())) {
        var raw = tn.nodeValue;
        if (!raw || !/задани|вопрос/i.test(raw)) continue;
        var s = raw.replace(/\s+/g, ' ').trim();
        var mm = s.match(QRE);
        // A real heading is short OR leads its text (a task-id badge may sit just
        // before it); a deep mention inside prose is not a heading.
        if (mm && (s.length <= 60 || mm.index <= 20)) {
          markers.push({ n: parseInt(mm[1], 10), node: tn.parentElement || tn });
          continue;
        }
        // The heading may be split across spans («ЗАДАНИЕ» | «№1»): the digit
        // lives in a sibling node. Check the SHORT parent's combined text once.
        var pp = tn.parentElement;
        if (pp && !checkedParents.has(pp)) {
          checkedParents.add(pp);
          var ps = (pp.textContent || '').replace(/\s+/g, ' ').trim();
          if (ps.length <= 40) {
            mm = ps.match(QRE);
            if (mm) markers.push({ n: parseInt(mm[1], 10), node: pp });
          }
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
      var any = false;
      for (var f = 0; f < flds.length; f++) {
        var val = (vals[f] != null) ? vals[f] : (vals.length === 1 ? vals[0] : '');
        if (val === '' || val == null) continue;
        try {
          // MQ(el) returns the EXISTING field; fall back to (re)wrapping it as a
          // MathField if the interface entry point differs. We still mirror the
          // hidden input below, so even a re-wrap (which could drop Mesh's own
          // edit handler) submits correctly.
          var field = MQ(flds[f]);
          if (!field || typeof field.latex !== 'function') {
            if (typeof MQ.MathField === 'function') { try { field = MQ.MathField(flds[f]); } catch (e0) { field = null; } }
          }
          if (!field || typeof field.latex !== 'function') continue;
          field.latex(toLatex(val));
          // Honest read-back: MathQuill silently ignores LaTeX it can't parse,
          // leaving the field empty. Confirm it ended non-empty before counting
          // the question as filled — otherwise the panel would show a false ✓ on
          // an empty formula box (the very thing the plain-input path guards via
          // valueTook). Lenient on the exact text, so a field that reformats the
          // value (e.g. -8/3 → \frac) still counts.
          var after = '';
          try { var got = field.latex(); after = String(got == null ? '' : got).trim(); } catch (eR) { after = ''; }
          if (!after) continue;
          // Mirror the accepted LaTeX into the hidden input the form submits
          // (same id, "input"→"hidden-input").
          var hid = flds[f].id ? document.getElementById(flds[f].id.replace('i-mathquill-input-', 'i-mathquill-hidden-input-')) : null;
          if (hid) {
            hid.value = after;
            try { hid.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) { /* */ }
            try { hid.dispatchEvent(new Event('change', { bubbles: true })); } catch (e3) { /* */ }
          }
          any = true;
        } catch (e) { /* this field failed; others still try */ }
      }
      if (any) filled.push(String(id));
    }
    return { ok: true, filled: filled };
  } catch (e) {
    return { ok: false, filled: [], reason: String(e) };
  }
}

/**
 * Fill the test form across EVERY frame of the tab. The Mesh test player is
 * sometimes embedded in an iframe (a different *.mos.ru origin), so a fill that
 * only touches the top frame finds no controls and skips everything. We inject
 * the fill logic into all accessible frames, run it in each, then merge: a
 * question counts as filled if ANY frame filled it. Frames the extension can't
 * script (foreign-origin embeds) are skipped silently. Never submits the form.
 */
async function fillAllFrames(tabId, questions) {
  if (!tabId || !Array.isArray(questions) || !questions.length) {
    return { filled: [], skipped: [] };
  }
  const idFor = (q, i) =>
    (q && q.index != null && String(q.index).trim() !== '') ? q.index : i + 1;

  // Make sure the fill logic (window.__smeshFill) exists in every frame.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/content/scraper.js']
    });
  } catch { /* some frames disallow injection; the ones that allow it still run */ }

  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (qs) => {
        try { return (typeof window.__smeshFill === 'function') ? window.__smeshFill(qs) : null; }
        catch { return null; }
      },
      args: [questions]
    });
  } catch (e) {
    return { filled: [], skipped: questions.map(idFor), error: String(e) };
  }

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
  try {
    const mqResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: fillMathQuillMain,
      args: [questions]
    });
    for (const r of (mqResults || [])) {
      const res = r && r.result;
      if (res && Array.isArray(res.filled)) res.filled.forEach((id) => filled.add(String(id)));
    }
  } catch { /* main-world injection blocked on this page — standard fill stands */ }

  // Third pass: custom/ARIA widgets the native + MathQuill passes can't reach —
  // dropdowns (incl. matching done as one dropdown per item), ARIA radio groups,
  // MUI toggle groups. It's ASYNC (opens a popper, waits, clicks the option), so
  // it runs last and is told which questions are already filled, so it never
  // re-opens or toggles one back off. Best-effort: a page with no such widgets
  // returns nothing and everything above stands.
  try {
    const already = [...filled];
    const interactiveFilled = await fillInteractiveAllFrames(tabId, questions, already);
    interactiveFilled.forEach((id) => filled.add(String(id)));
  } catch { /* interactive pass is best-effort */ }

  const filledIds = [];
  const skipped = [];
  questions.forEach((q, i) => {
    const id = idFor(q, i);
    (filled.has(String(id)) ? filledIds : skipped).push(id);
  });
  return { filled: filledIds, skipped };
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
async function fillInteractiveAllFrames(tabId, questions, alreadyFilled = []) {
  if (!tabId || !Array.isArray(questions) || !questions.length) return [];
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (qs, done) => {
        try { return (typeof window.__smeshFillInteractive === 'function') ? window.__smeshFillInteractive(qs, done) : null; }
        catch { return null; }
      },
      args: [questions, alreadyFilled]
    });
  } catch { return []; }
  const filled = [];
  for (const r of (results || [])) {
    const s = r && r.result;
    if (s && Array.isArray(s.filled)) s.filled.forEach((id) => filled.push(String(id)));
  }
  return filled;
}

/* ---------- Multi-page test pagination ---------- */
// Drive a read-only scraper.js global (currently __smeshPageSig) in EVERY frame
// and collect the non-null results. Mirrors fillAllFrames: the test player is
// often inside an iframe, so per-frame is the only thing that reaches it. Frames
// that disallow scripting are skipped silently.
async function runInAllFrames(tabId, fnName, arg = null) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/content/scraper.js'] });
  } catch { /* some frames disallow injection; the rest still run */ }
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (name, a) => {
        try { return (typeof window[name] === 'function') ? window[name](a) : null; }
        catch { return null; }
      },
      args: [fnName, arg]
    });
  } catch { return []; }
  return (results || []).map((r) => r && r.result).filter((v) => v != null);
}

async function runInAllFramesWithIds(tabId, fnName) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/content/scraper.js'] });
  } catch { /* inaccessible frames are simply absent from discovery */ }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (name) => {
        try { return (typeof window[name] === 'function') ? window[name]() : null; }
        catch { return null; }
      },
      args: [fnName]
    });
    return (results || [])
      .filter((entry) => entry?.result != null && Number.isInteger(entry.frameId))
      .map((entry) => ({ frameId: entry.frameId, result: entry.result }));
  } catch { return []; }
}

// Combined signature of the visible test page across all frames — lets the
// popup detect whether clicking «Далее» actually advanced the page.
async function testPageSig(tabId) {
  if (!tabId) return '';
  const sigs = await runInAllFrames(tabId, '__smeshPageSig');
  return sigs.join('||');
}

// Pagination is deliberately two-phase. Discovery runs in every frame and is
// read-only; only after one unambiguous frame is selected do we inject a click
// into that exact frame. The old allFrames click raced duplicate «Далее» buttons
// and could skip multiple pages at once.
async function testNextPage(tabId) {
  if (!tabId) return 'none';
  const discovery = await runInAllFramesWithIds(tabId, '__smeshNextDiscovery');
  const exact = discovery.filter(({ result }) => result?.enabledCount === 1);
  const withSignature = exact.filter(({ result }) => !!result?.signature);
  const eligible = withSignature.length ? withSignature : exact;
  if (eligible.length !== 1) {
    const enabledTotal = discovery.reduce((sum, entry) => sum + (entry.result?.enabledCount || 0), 0);
    const candidateTotal = discovery.reduce((sum, entry) => sum + (entry.result?.candidateCount || 0), 0);
    const finishTotal = discovery.reduce((sum, entry) => sum + (entry.result?.finishCount || 0), 0);
    if (!candidateTotal && finishTotal) return 'finish';
    return enabledTotal || candidateTotal ? 'ambiguous' : 'none';
  }
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [eligible[0].frameId] },
      func: () => {
        try { return (typeof window.__smeshNextClick === 'function') ? window.__smeshNextClick() : null; }
        catch { return null; }
      }
    });
    return result?.status === 'clicked' ? 'clicked' : 'none';
  } catch { return 'none'; }
}

/* ---------- Floating "Solve" pill (page-triggered test solving) ---------- */
// The pill (src/content/test-pill.js) is a content script, so it CANNOT call
// chrome.tabs.captureVisibleTab or chrome.scripting — the screenshot capture +
// solve + autofill (+ the multi-page advance loop) all have to run HERE. These
// handlers lift the orchestration that used to live only in the popup
// (solveTestOnScreen / solveAllPages) into the worker so it can be driven from
// the page instead of the toolbar. The popup's own flow is untouched.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PILL_MAX_PAGES = 30; // same cap as the popup's solveAllPages
const CAPTURE_TARGET_CHANGED = 'Переключилась вкладка — попробуйте ещё раз.';

function captureTargetMatches(tab, tabId, tabUrl) {
  return tab?.id === tabId && tab?.url === tabUrl;
}

// captureVisibleTab has no tabId argument: it always photographs whichever tab
// is active at that instant. Pin both sides of the call to the tab selected when
// the solve began; the second check makes a raced capture unusable rather than
// accidentally sending a different page to the model.
async function requireActiveCaptureTarget(tabId, windowId, tabUrl) {
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (!captureTargetMatches(active, tabId, tabUrl)) throw new Error(CAPTURE_TARGET_CHANGED);
}

/**
 * Capture the visible test page: top-frame text + a JPEG screenshot. Mirrors
 * popup.js capturePage, but runs in the worker (the pill can't reach these APIs).
 * windowId pins captureVisibleTab to the pill's own window.
 */
async function capturePageForPill(tabId, windowId, tabUrl) {
  const textPromise = chrome.scripting
    .executeScript({ target: { tabId }, func: () => document.body.innerText.slice(0, 15000) })
    .then(([inj]) => inj?.result || '')
    .catch(() => '');
  // captureVisibleTab needs ACTIVE host access to the tab. Triggered from the
  // in-page pill there is no toolbar click, so `activeTab` isn't armed and Chrome
  // relies on the *.mos.ru host permission — which only counts while the
  // extension's site access is actually enabled. After a permissions change +
  // reload Chrome can quietly reset that to "On click", and capture then fails
  // with a raw English "Either '<all_urls>' or 'activeTab' permission is
  // required". Map that to a clear, actionable Russian instruction (the pill's
  // errText passes Cyrillic through verbatim).
  // JPEG, not PNG: a retina PNG of a test page is 1.5–4 MB of base64 and the
  // whole thing rides ONE /ai/start POST — too slow for the RU DPI clamp
  // window (see smesh-proxy.js). q90 JPEG is 5–10× smaller and test text /
  // formulas stay perfectly readable for the vision model.
  const shotPromise = (async () => {
    try {
      await requireActiveCaptureTarget(tabId, windowId, tabUrl);
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 90 });
      await requireActiveCaptureTarget(tabId, windowId, tabUrl);
      return dataUrl;
    } catch (e) {
      const m = String(e?.message || e);
      if (/all_urls|activeTab|permission|cannot be captured/i.test(m)) {
        throw new Error(
          'Нет доступа к снимку экрана. Сейчас решите через значок расширения СМЭШ AI на панели ' +
          'браузера → вкладка «Тест» → «Решить тест» (этот способ работает всегда). Чтобы заработала ' +
          'кнопка прямо на странице: chrome://extensions → СМЭШ AI → «Доступ к сайтам» → «На всех сайтах», ' +
          'затем перезагрузите расширение и обновите страницу.'
        );
      }
      throw e;
    }
  })();
  const [pageText, dataUrl] = await Promise.all([textPromise, shotPromise]);
  const b64 = (dataUrl || '').split(',')[1];
  if (!b64) throw new Error('Не удалось снять скриншот страницы. Откройте тест МЭШ на активной вкладке и попробуйте снова.');
  return { pageText, screenshot: { mimeType: 'image/jpeg', dataBase64: b64, name: 'screen.jpg' } };
}

/**
 * Solve ONE captured page: run the existing solve path, drop the answers into
 * the in-page panel (showAnswersInTab) and autofill the form across every frame
 * (fillAllFrames). Returns the parsed questions + fill summary.
 */
async function pillSolveOnePage(tabId, windowId, tabUrl, provider) {
  const { pageText, screenshot } = await capturePageForPill(tabId, windowId, tabUrl);
  const answer = await solveTest({ text: pageText, screenshot, provider });
  const questions = parseTestAnswers(answer);
  if (!questions.length) return { questions, summary: { filled: [], skipped: [] } };
  await showAnswersInTab(tabId, questions);
  const summary = await fillAllFrames(tabId, questions);
  return { questions, summary };
}

// Poll the page signature until it differs from `beforeSig` (page advanced) or
// the budget runs out. Mirrors popup.js waitForChange.
async function waitForPillPageChange(tabId, beforeSig, timeout) {
  const start = Date.now();
  await sleep(600);
  while (Date.now() - start < timeout) {
    const sig = await testPageSig(tabId);
    if (sig && sig !== beforeSig) return true;
    await sleep(500);
  }
  return false;
}

// Try to advance to the next page. Mirrors popup.js advancePage: 'ok' | 'finish'
// | 'none' | 'stuck'. NEVER clicks a submit/finish control (testNextPage refuses).
async function advancePillPage(tabId, beforeSig) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const status = await testNextPage(tabId);
    if (status === 'finish') return 'finish';
    if (status === 'ambiguous') return 'none';
    if (status === 'none') return attempt === 0 ? 'none' : 'stuck';
    if (await waitForPillPageChange(tabId, beforeSig, attempt === 0 ? 8000 : 4000)) return 'ok';
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
 * { outcome, solved } so the pill can render the same Russian summary.
 */
async function pillSolveAllPages(tabId, windowId, tabUrl, provider) {
  let solved = 0;
  let outcome = 'done';
  for (let page = 1; page <= PILL_MAX_PAGES; page++) {
    notifyPill(tabId, { phase: 'solve', page });
    const { questions } = await pillSolveOnePage(tabId, windowId, tabUrl, provider);
    if (questions.length) solved++;
    // Let the fill's React re-render settle so the signature reflects the filled
    // state — otherwise a late repaint could look like a navigation.
    await sleep(700);
    notifyPill(tabId, { phase: 'next', page });
    const beforeSig = await testPageSig(tabId);
    const nav = await advancePillPage(tabId, beforeSig);
    if (nav === 'finish') { outcome = 'finish'; break; }
    if (nav === 'none') { outcome = 'none'; break; }
    if (nav === 'stuck') { outcome = 'stuck'; break; }
    if (page === PILL_MAX_PAGES) { outcome = 'max'; break; }
    await sleep(500);
  }
  return { outcome, solved };
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

/* ---------- Runtime message trust boundary ---------- */

const EXTENSION_PAGE_PREFIX = `chrome-extension://${chrome.runtime.id}/`;
const ACTION_TOKEN_TTL_MS = 30000;
const MAX_TEXT_CHARS = 200 * 1024;
const MAX_URL_CHARS = 4096;
const MAX_ARRAY_ITEMS = 100;
const MAX_BASE64_CHARS = 40 * 1024 * 1024;
const MAX_FILES_TOTAL_CHARS = 100 * 1024 * 1024;

const CONTENT_ACTIONS = new Set([
  'FILL_ANSWERS_ALL',
  'PILL_SOLVE_PAGE',
  'PILL_SOLVE_ALL',
  'RESOLVE_QUESTION'
]);

// This is intentionally exhaustive. Adding a switch case without assigning it
// to a sender class leaves it unreachable instead of silently widening access.
const SENDER_MESSAGE_TYPES = {
  content: new Set(['GET_ACTION_TOKEN', ...CONTENT_ACTIONS]),
  extension: new Set([
    'OPEN_DASHBOARD', 'SOLVE', 'SOLVE_TEST', 'FILL_ANSWERS_TAB',
    'TEST_PAGE_SIG', 'TEST_NEXT_PAGE', 'GET_RUNTIME_CONFIG', 'CLASSIFY_TASKS',
    'OPENROUTER_CREDITS', 'DOWNLOAD_FILES', 'LIST_SESSIONS', 'LIST_MESSAGES',
    'GDZ_CATALOG', 'GDZ_SEARCH', 'GDZ_RESOLVE', 'GDZ_FOR_TASK', 'GDZ_SELFTEST',
    'CONSUME_DASH_LAUNCH'
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

function isHttpUrl(v) {
  if (!isString(v, MAX_URL_CHARS)) return false;
  try { return ['http:', 'https:'].includes(new URL(v).protocol); }
  catch { return false; }
}

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
  return hasOnlyKeys(q, ['index', 'text', 'answer', 'choice', 'parts']) &&
    (q.index == null || isSafeId(q.index) || isString(q.index, 512)) &&
    isOptionalString(q.text) && isOptionalString(q.answer) &&
    isOptionalString(q.choice, 512) &&
    (q.parts == null || validArray(q.parts, validPart));
}

const validQuestions = (v) => validArray(v, validQuestion);

function validHistoryMessage(item) {
  return hasOnlyKeys(item, ['role', 'content', 'files', 'needsUpload', 'error']) &&
    isString(item.role, 32) && isString(item.content) &&
    (item.files == null || validFiles(item.files)) &&
    isOptionalBoolean(item.needsUpload) && isOptionalBoolean(item.error);
}

function validHeaders(headers) {
  return headers == null || (isRecord(headers) && Object.keys(headers).length <= 50 &&
    Object.entries(headers).every(([k, v]) => isString(k, 256) && isString(v, 8192)));
}

const noPayload = (msg) => msg.payload == null;
const payloadRecord = (msg, keys) => hasOnlyKeys(msg.payload, keys);

// Each handler validates only what it consumes, but rejects unknown payload keys
// so an ignored field cannot be used to smuggle an unbounded object through the
// privileged boundary.
const MESSAGE_SCHEMAS = {
  GET_ACTION_TOKEN: (msg) => noPayload(msg) && CONTENT_ACTIONS.has(msg.action),
  OPEN_DASHBOARD: (msg) => payloadRecord(msg, ['subject', 'task', 'day', 'homeworkId', 'homeworkItemId', 'rowToken']) &&
    isString(msg.payload.subject, 1024) && isOptionalString(msg.payload.task) &&
    isOptionalString(msg.payload.day, 1024) && isOpaqueId(msg.payload.homeworkId) &&
    isOpaqueId(msg.payload.homeworkItemId) && isOptionalString(msg.payload.rowToken, 128),
  SOLVE: (msg) => payloadRecord(msg, ['subject', 'task', 'files', 'sessionId', 'history', 'mode']) &&
    isString(msg.payload.subject, 1024) && isOptionalString(msg.payload.task) &&
    (msg.payload.files == null || validFiles(msg.payload.files)) &&
    isOptionalString(msg.payload.sessionId, 512) &&
    (msg.payload.history == null || validArray(msg.payload.history, validHistoryMessage)) &&
    isOptionalString(msg.payload.mode, 64),
  SOLVE_TEST: (msg) => payloadRecord(msg, ['text', 'screenshot', 'tabId', 'provider']) &&
    isOptionalString(msg.payload.text) && (msg.payload.screenshot == null || validFile(msg.payload.screenshot)) &&
    isSafeId(msg.payload.tabId) && isOptionalString(msg.payload.provider, 64),
  FILL_ANSWERS_ALL: (msg) => payloadRecord(msg, ['questions']) && validQuestions(msg.payload.questions),
  FILL_ANSWERS_TAB: (msg) => payloadRecord(msg, ['tabId', 'questions']) &&
    isSafeId(msg.payload.tabId) && validQuestions(msg.payload.questions),
  TEST_PAGE_SIG: (msg) => payloadRecord(msg, ['tabId']) && isSafeId(msg.payload.tabId),
  TEST_NEXT_PAGE: (msg) => payloadRecord(msg, ['tabId']) && isSafeId(msg.payload.tabId),
  PILL_SOLVE_PAGE: (msg) => payloadRecord(msg, ['provider']) && isOptionalString(msg.payload.provider, 64),
  PILL_SOLVE_ALL: (msg) => payloadRecord(msg, ['provider']) && isOptionalString(msg.payload.provider, 64),
  RESOLVE_QUESTION: (msg) => payloadRecord(msg, ['index', 'prevAnswer', 'questionText']) &&
    (isSafeId(msg.payload.index) || isString(msg.payload.index, 512)) &&
    isOptionalString(msg.payload.prevAnswer) && isOptionalString(msg.payload.questionText),
  GET_RUNTIME_CONFIG: (msg) => noPayload(msg) ||
    (payloadRecord(msg, ['force']) && isOptionalBoolean(msg.payload.force)),
  CONSUME_DASH_LAUNCH: (msg) => payloadRecord(msg, ['id']) &&
    isString(msg.payload.id, 128) && /^[0-9a-f-]{36}$/i.test(msg.payload.id),
  CLASSIFY_TASKS: (msg) => payloadRecord(msg, ['tasks']) &&
    validArray(msg.payload.tasks, (task) => isString(task)),
  OPENROUTER_CREDITS: noPayload,
  DOWNLOAD_FILES: (msg) => payloadRecord(msg, ['urls', 'headers', 'token']) &&
    validArray(msg.payload.urls, isAllowedAttachmentUrl) && validHeaders(msg.payload.headers) &&
    isOptionalString(msg.payload.token, 8192),
  LIST_SESSIONS: noPayload,
  LIST_MESSAGES: (msg) => noPayload(msg) && isString(msg.sessionId, 512),
  GDZ_CATALOG: (msg) => noPayload(msg) ||
    (payloadRecord(msg, ['force']) && isOptionalBoolean(msg.payload.force)),
  GDZ_SEARCH: (msg) => payloadRecord(msg, ['grade', 'subjectId', 'subtype', 'query']) &&
    (msg.payload.grade == null || isSafeId(msg.payload.grade) || isString(msg.payload.grade, 32)) &&
    (msg.payload.subjectId == null || isSafeId(msg.payload.subjectId) || isString(msg.payload.subjectId, 32)) &&
    isOptionalString(msg.payload.subtype, 256) && isOptionalString(msg.payload.query),
  GDZ_RESOLVE: (msg) => payloadRecord(msg, ['bookUrl', 'number']) &&
    isHttpUrl(msg.payload.bookUrl) && (isSafeId(msg.payload.number) || isString(msg.payload.number, 512)),
  GDZ_FOR_TASK: (msg) => payloadRecord(msg, ['subject', 'task']) &&
    isString(msg.payload.subject, 1024) && isOptionalString(msg.payload.task),
  GDZ_SELFTEST: noPayload
};

function isMeshContentUrl(url) {
  return typeof url === 'string' &&
    (url.startsWith('https://school.mos.ru/') || url.startsWith('https://uchebnik.mos.ru/'));
}

function classifyMessageSender(sender) {
  if (sender?.id !== chrome.runtime.id) return null;
  // Dashboard pages have sender.tab too, so the extension origin must win first.
  if (typeof sender.url === 'string' && sender.url.startsWith(EXTENSION_PAGE_PREFIX)) return 'extension';
  if (sender.tab && isSafeId(sender.tab.id) && isMeshContentUrl(sender.tab.url)) return 'content';
  return null;
}

function validateMessage(senderClass, msg) {
  if (!isRecord(msg)) return 'Некорректное сообщение.';
  if (!isString(msg.type, 64) || !msg.type) return 'Некорректный тип сообщения.';
  if (!SENDER_MESSAGE_TYPES[senderClass]?.has(msg.type)) return 'Действие недоступно для этого источника.';
  const allowedTopKeys = msg.type === 'GET_ACTION_TOKEN'
    ? ['type', 'action']
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
  return null;
}

function clearExpiredActionTokens(now = Date.now()) {
  for (const [token, grant] of actionTokens) if (grant.expiresAt <= now) actionTokens.delete(token);
}

function issueActionToken(tabId, action) {
  const now = Date.now();
  clearExpiredActionTokens(now);
  const token = crypto.randomUUID();
  const expiresAt = now + ACTION_TOKEN_TTL_MS;
  actionTokens.set(token, { tabId, action, expiresAt });
  return { token, expiresAt };
}

function consumeActionToken(token, tabId, action) {
  const grant = actionTokens.get(token);
  // Any presentation burns the capability, including a mismatched one. That
  // keeps it single-use and prevents repeated probing of its binding.
  if (grant) actionTokens.delete(token);
  if (!grant || grant.expiresAt <= Date.now() || grant.tabId !== tabId || grant.action !== action) {
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
    const grant = issueActionToken(sender.tab.id, msg.action);
    sendResponse({ ok: true, ...grant });
    return false;
  }
  if (senderClass === 'content' && CONTENT_ACTIONS.has(msg.type) &&
      !consumeActionToken(msg.token, sender.tab.id, msg.type)) {
    sendResponse({ ok: false, error: 'Токен действия недействителен или истёк.' });
    return false;
  }
  (async () => {
    try {
      switch (msg?.type) {
        case 'OPEN_DASHBOARD':
          await openDashboard(msg.payload);
          sendResponse({ ok: true });
          break;
        case 'SOLVE':
          // Non-streaming fallback (popup / callers that don't open a port).
          sendResponse({ ok: true, result: await withKeepAlive(() => solve(msg.payload)) });
          break;
        case 'SOLVE_TEST': {
          const tabId = msg.payload?.tabId;
          const answer = await (tabId
            ? withTabSolveLock(tabId, () => withKeepAlive(() => solveTest(msg.payload)))
            : withKeepAlive(() => solveTest(msg.payload)));
          // Parse once: the panel needs it now, and the popup's «Решить все
          // страницы» loop needs the structured questions to auto-fill the page.
          const questions = parseTestAnswers(answer);
          // Fire-and-forget: surfacing the panel must NOT delay the popup reply.
          // The popup is also where errors get rendered, so a panel failure has
          // no user-visible impact beyond "no on-page panel this time".
          if (tabId && questions.length) showAnswersInTab(tabId, questions);
          sendResponse({ ok: true, answer, questions });
          break;
        }
        case 'FILL_ANSWERS_ALL': {
          // The in-page panel's «Заполнить» button routes here so the fill can
          // reach forms inside iframes (the panel's own frame can't). sender.tab
          // is the tab the panel lives in.
          const tabId = sender?.tab?.id;
          const questions = msg.payload?.questions || [];
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          sendResponse({ ok: true, summary: await fillAllFrames(tabId, questions) });
          break;
        }
        case 'FILL_ANSWERS_TAB': {
          // Same fill, but driven by the POPUP (no sender.tab) for the multi-page
          // loop — the tab id is passed explicitly.
          const { tabId, questions } = msg.payload || {};
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          sendResponse({ ok: true, summary: await fillAllFrames(tabId, questions || []) });
          break;
        }
        case 'TEST_PAGE_SIG': {
          const { tabId } = msg.payload || {};
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          sendResponse({ ok: true, sig: await testPageSig(tabId) });
          break;
        }
        case 'TEST_NEXT_PAGE': {
          const { tabId } = msg.payload || {};
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          sendResponse({ ok: true, status: await testNextPage(tabId) });
          break;
        }
        case 'PILL_SOLVE_PAGE': {
          // The in-page pill's primary action. sender.tab is the test tab — the
          // pill (a content script) can't screenshot/script, so the worker does
          // it all: capture → solve → panel → autofill the visible page.
          const tabId = sender?.tab?.id;
          const windowId = sender?.tab?.windowId;
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const { questions, summary } = await withTabSolveLock(tabId, () =>
            withKeepAlive(() => pillSolveOnePage(tabId, windowId, sender.tab.url, msg.payload?.provider)));
          sendResponse({ ok: true, count: questions.length, summary });
          break;
        }
        case 'PILL_SOLVE_ALL': {
          // The pill's «все страницы» autopilot: solve+fill every page, advancing
          // with «Далее», stopping before any submit/finish control.
          const tabId = sender?.tab?.id;
          const windowId = sender?.tab?.windowId;
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const { outcome, solved } = await withTabSolveLock(tabId, () =>
            withKeepAlive(() => pillSolveAllPages(tabId, windowId, sender.tab.url, msg.payload?.provider)));
          sendResponse({ ok: true, outcome, solved });
          break;
        }
        case 'RESOLVE_QUESTION': {
          // The answer panel's per-line «перерешать» button: re-solve ONE
          // question on the panel's tab. sender.tab is that (test) tab.
          const tabId = sender?.tab?.id;
          const windowId = sender?.tab?.windowId;
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const resolved = await withTabSolveLock(tabId, () =>
            withKeepAlive(() => resolveOneQuestion(tabId, windowId, sender.tab.url, msg.payload || {})));
          sendResponse({ ok: true, answer: resolved.answer, parts: resolved.parts });
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
        case 'CLASSIFY_TASKS':
          // Remote classification ships homework text to an AI provider — the
          // same consent gate as a solve, not a free pass because it's "meta".
          if (!(await hasConsent())) { sendResponse({ ok: false, error: CONSENT_REQUIRED_MESSAGE }); break; }
          sendResponse({ ok: true, kinds: await classifyTasksAI(msg.payload?.tasks || []) });
          break;
        case 'OPENROUTER_CREDITS': {
          // Settings usage dashboard: OpenRouter balance (+ a daily spend
          // snapshot recorded as a side effect) and the derived spend history.
          const credits = await fetchOpenRouterCredits();
          const spendHistory = await getSpendHistory();
          sendResponse({ ...credits, spendHistory });
          break;
        }
        case 'DOWNLOAD_FILES':
          sendResponse({ ok: true, files: await downloadFiles(msg.payload || {}) });
          break;
        case 'LIST_SESSIONS':
          sendResponse({ ok: true, sessions: await listSessions() });
          break;
        case 'LIST_MESSAGES':
          sendResponse({ ok: true, messages: await listMessages(msg.sessionId) });
          break;
        // ---------- GDZ ----------
        case 'GDZ_CATALOG': {
          const catalog = await getCatalog({ force: !!msg.payload?.force });
          // Return only what the picker needs in one shot; books are already trimmed.
          sendResponse({ ok: true, catalog });
          break;
        }
        case 'GDZ_SEARCH': {
          const catalog = await getCatalog();
          sendResponse({ ok: true, books: searchBooks(catalog, msg.payload || {}) });
          break;
        }
        case 'GDZ_RESOLVE': {
          // payload: { bookUrl, number }
          const { bookUrl, number } = msg.payload || {};
          if (!bookUrl || number == null) { sendResponse({ ok: false, error: 'bookUrl + number required' }); break; }
          const result = await resolveTask(bookUrl, number);
          if (!result) { sendResponse({ ok: false, error: 'not found' }); break; }
          // Inline EVERY answer image as base64 — multi-page answers have more
          // than one — so the chat can render them directly. Fetch them in
          // parallel (independent network calls) and drop any that fail, keeping
          // source order.
          const settled = await Promise.all(
            result.images.map((url) => fetchTaskImage(url).catch(() => null))
          );
          const inlined = settled.filter(Boolean);
          if (!inlined.length) { sendResponse({ ok: false, error: 'images unavailable' }); break; }
          track('gdz_pull', { meta: { source: 'manual', images: inlined.length } });
          sendResponse({ ok: true, result: { ...result, inlined } });
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
        case 'GDZ_SELFTEST': {
          // End-to-end smoke test from the popup/devtools: search → resolve →
          // image. If this returns ok:true, the DNR UA rule is firing and the
          // whole chain works from inside the extension.
          const catalog = await getCatalog();
          const hits = searchBooks(catalog, { grade: 9, subjectId: 4, query: 'макарычев углубл' });
          if (!hits.length) { sendResponse({ ok: false, error: 'catalog: book not found' }); break; }
          const r = await resolveTask(hits[0].url, '25');
          if (!r) { sendResponse({ ok: false, error: 'resolve: task not found' }); break; }
          const img = await fetchTaskImage(r.images[0]);
          sendResponse({
            ok: true,
            book: hits[0].title,
            taskLink: r.link,
            imageBytes: Math.round((img.dataBase64.length * 3) / 4),
            mimeType: img.mimeType
          });
          break;
        }
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
      sendResponse({ ok: false, error: emsg });
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
      try { port.disconnect(); } catch { /* already closed */ }
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
      console.log('[solve] threw +' + (Date.now() - t0) + 'ms:', e?.name, String(e?.message || e), 'aborted=' + ctrl.signal.aborted);
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

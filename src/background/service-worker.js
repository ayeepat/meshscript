/**
 * Background service worker (MV3, type: module).
 * Orchestrates the AI provider call and local solve-history persistence.
 * All API keys live here / in storage, never in content scripts.
 */
import { askAI } from '../lib/ai.js';
import { fetchOpenRouterCredits, getSpendHistory } from '../lib/openrouter.js';
import { buildSystemPrompt, categoryForSubject } from '../lib/subject-router.js';
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../lib/prompts.js';
import { createSession, addMessage, listSessions, listMessages } from '../lib/history.js';
import { ensureLicensed } from '../lib/license.js';
import { hasConsent, CONSENT_REQUIRED_MESSAGE } from '../lib/consent.js';
import { getRuntimeConfig } from '../lib/remote-config.js';
import { isBareTextbookRef, classifyTask, needsAudio } from '../lib/task-classifier.js';
import { classifyTasksAI } from '../lib/classify-ai.js';
import { isReadableFile, hasPdf, isAudioFile } from '../lib/file-kinds.js';
import { getCatalog, searchBooks, resolveTask, resolveForTask, fetchTaskImage } from '../lib/gdz-api.js';
import { mapSubjectToId } from '../lib/gdz-match.js';
import { prepareFiles } from '../lib/extract.js';
import { transcribeAudioFiles } from '../lib/transcribe.js';

// Follow-ups re-send prior context. Cap how many MESSAGES we replay: full
// worked solutions are long, and on a paid provider every re-sent message is
// money. 8 messages ≈ 4 back-and-forth turns — enough recent context to follow
// up without re-sending the whole chat. (Bump to 16 for ~8 full turns.)
const MAX_HISTORY_MESSAGES = 8;

// chrome.storage.session defaults to extension-only access; the floating
// answer panel (content-script context) needs to remember its position and
// minimized state across page interactions. Opening the access level is reset
// on every SW restart, so we re-apply it at module top — cheap and idempotent.
try {
  chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch { /* old Chrome — content script falls back to defaults each time */ }

// Warm the remote runtime config on every SW spin-up (cheap: a single cached
// fetch at most once per TTL). Fire-and-forget — a failure is a silent no-op and
// the extension uses its built-in defaults. See lib/remote-config.js.
getRuntimeConfig().catch(() => { /* offline / not hosted — defaults apply */ });

// Open the full-window dashboard when the popup asks to "Solve".
async function openDashboard(payload) {
  const url = chrome.runtime.getURL(
    `src/dashboard/dashboard.html?subject=${encodeURIComponent(payload.subject)}` +
    `&task=${encodeURIComponent(payload.task || '')}` +
    `&day=${encodeURIComponent(payload.day || '')}`
  );
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
  if (history.length === 0) {
    const gate = missingInputGate(category, task, files);
    if (gate) return { answer: gate, needsUpload: true, sessionId };
  }

  const systemPrompt = await buildSystemPrompt(subject, mode);
  // PDFs require a PDF-capable backend; force OpenRouter (Gemini reads PDFs
  // natively) even if the user picked Groq, which cannot read them at all.
  const provider = hasPdf(files) ? 'openrouter' : undefined;
  // If a PDF forced OpenRouter but no OpenRouter key is set, explain WHY a key
  // is suddenly needed (the user may have deliberately picked free Groq, which
  // can't read PDFs) instead of surfacing a bare "key not set" error.
  if (provider === 'openrouter') {
    const { openrouterApiKey } = await chrome.storage.local.get('openrouterApiKey');
    if (!openrouterApiKey) {
      return {
        answer: 'В задании есть PDF, а его умеет читать только OpenRouter (модель Gemini). ' +
          'Groq не читает PDF-файлы. Добавьте ключ OpenRouter в настройках расширения — ' +
          'или пришлите это задание фотографиями страниц / текстом, и я решу через Groq.',
        sessionId
      };
    }
  }
  const answer = await askAI(
    systemPrompt, task || '(см. вложение)', files,
    history.slice(-MAX_HISTORY_MESSAGES), { onDelta, provider, signal }
  );

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
async function solveTest({ text, screenshot }) {
  await ensureLicensed();
  // Same privacy backstop as solve(): no consent → no provider call. Thrown so
  // the popup's requestSolve surfaces it as a clear error instead of a "result".
  if (!(await hasConsent())) throw new Error(CONSENT_REQUIRED_MESSAGE);
  const { promptOverrides = {} } = await chrome.storage.local.get('promptOverrides');
  const systemPrompt =
    promptOverrides[PROMPT_CATEGORIES.TEST_ANSWER] || DEFAULT_PROMPTS[PROMPT_CATEGORIES.TEST_ANSWER];
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
  return askAI(systemPrompt, userText, screenshot ? [screenshot] : [], [], {
    responseFormat: 'json_object',
    reasoning: { effort: 'medium' }
  });
}

/**
 * Re-solve a SINGLE question on the current test page (the answer panel's
 * «перерешать» button). Re-captures the visible page (the page on screen is the
 * source of truth — the original screenshot isn't kept) and asks the model for
 * just that one question, optionally telling it the previous answer so it can
 * confirm or correct. Same licence/consent gate as solveTest. Returns the fresh
 * answer string ('' if nothing parseable came back).
 */
async function resolveOneQuestion(tabId, windowId, { index, prevAnswer, questionText } = {}) {
  await ensureLicensed();
  if (!(await hasConsent())) throw new Error(CONSENT_REQUIRED_MESSAGE);
  const { pageText, screenshot } = await capturePageForPill(tabId, windowId);
  const { promptOverrides = {} } = await chrome.storage.local.get('promptOverrides');
  const systemPrompt =
    promptOverrides[PROMPT_CATEGORIES.TEST_ANSWER] || DEFAULT_PROMPTS[PROMPT_CATEGORIES.TEST_ANSWER];
  const n = String(index ?? '').trim();
  const focus =
    `Перепроверь и реши ТОЛЬКО вопрос №${n} этого теста (текст страницы ниже + скриншот).` +
    (questionText ? ` Вопрос: «${String(questionText).slice(0, 600)}».` : '') +
    (prevAnswer ? ` Предыдущий ответ был «${String(prevAnswer).slice(0, 300)}» — реши заново и дай самый точный ответ (можешь подтвердить или исправить).` : '') +
    ` Верни JSON {"answers":[{"n":"${n}","a":"…"}]} ровно с одним элементом для этого вопроса` +
    ' (если у вопроса несколько полей для ответа — добавь поле "p", как описано в инструкции).\n\n' +
    'Текст страницы теста (может содержать навигационный мусор — игнорируй его):\n\n' +
    (pageText || '(текст не извлечён, смотри скриншот)');
  const answer = await askAI(systemPrompt, focus, screenshot ? [screenshot] : [], [], {
    responseFormat: 'json_object',
    reasoning: { effort: 'high' }
  });
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
// FileReader in a service worker, so base64 is encoded from an ArrayBuffer.

function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
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

async function downloadFile(url, headers) {
  try {
    const res = await fetch(url, { credentials: 'include', headers });
    if (!res.ok) { console.log('[СМЭШ AI] download http', res.status, url); return null; }
    // An HTML response is an auth/login redirect, not the attachment — reject it
    // so we never hand the model (or the chat chip) a fake "file".
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html') || ct.includes('text/xml')) {
      console.log('[СМЭШ AI] download got HTML (auth redirect?)', url);
      return null;
    }
    const buf = await res.arrayBuffer();
    const name = nameFromUrl(url);
    const mimeType = inferMime(name, res.headers.get('content-type'));
    // Audio (listening clips) gets a higher cap — Whisper accepts up to ~25 MB —
    // while other attachments stay at 12 MB to bound memory / storage.
    const maxBytes = isAudioFile({ name, mimeType }) ? 25 * 1024 * 1024 : 12 * 1024 * 1024;
    if (!buf.byteLength || buf.byteLength > maxBytes) {
      console.log('[СМЭШ AI] download size skip', buf.byteLength, url);
      return null;
    }
    console.log('[СМЭШ AI] downloaded', name, mimeType, buf.byteLength + 'b');
    return { mimeType, dataBase64: abToBase64(buf), name };
  } catch (e) { console.log('[СМЭШ AI] download exception', String(e), url); return null; }
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

// The Mesh auth set (Bearer token + X-mes-*) is sensitive — it's the user's
// live session credential. It may ride along ONLY to a *.mos.ru host. A
// homework page is Mesh-controlled, but a stray non-Mesh link in its DOM (a
// teacher's comment, an embed) would otherwise have the user's Mesh token
// fetched straight to a third-party server. Gate the header set on the host.
function isMeshHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'mos.ru' || h.endsWith('.mos.ru');
  } catch { return false; }
}

// `headers` come straight from the content script's discovery (Bearer token +
// Mesh's X-mes-* set). A bare `token` is still accepted for backward-compat.
async function downloadFiles({ urls = [], headers = null, token = null }) {
  const hdrs = headers || (token ? meshHeadersFromToken(token) : {});
  const files = [];
  for (const url of urls.slice(0, 5)) {
    // Never hand the Mesh credential to a non-Mesh host (see isMeshHost).
    const f = await downloadFile(url, isMeshHost(url) ? hdrs : {});
    if (f) files.push(f);
  }
  return files;
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
  }
  const filledIds = [];
  const skipped = [];
  questions.forEach((q, i) => {
    const id = idFor(q, i);
    (filled.has(String(id)) ? filledIds : skipped).push(id);
  });
  return { filled: filledIds, skipped };
}

/* ---------- Multi-page test pagination ---------- */
// Drive a scraper.js global (e.g. __smeshPageSig / __smeshNext) in EVERY frame
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

// Combined signature of the visible test page across all frames — lets the
// popup detect whether clicking «Далее» actually advanced the page.
async function testPageSig(tabId) {
  if (!tabId) return '';
  const sigs = await runInAllFrames(tabId, '__smeshPageSig');
  return sigs.join('||');
}

// Click the forward control wherever it lives (top frame or an iframe) and merge
// the per-frame results: any frame that advanced wins; else any frame that saw
// ONLY a finish/submit control reports 'finish' (so the popup stops without ever
// submitting the test); else 'none'.
async function testNextPage(tabId) {
  if (!tabId) return 'none';
  const res = await runInAllFrames(tabId, '__smeshNext');
  let clicked = false, finish = false;
  for (const r of res) {
    if (r?.status === 'clicked') clicked = true;
    else if (r?.status === 'finish') finish = true;
  }
  return clicked ? 'clicked' : (finish ? 'finish' : 'none');
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

/**
 * Capture the visible test page: top-frame text + a PNG screenshot. Mirrors
 * popup.js capturePage, but runs in the worker (the pill can't reach these APIs).
 * windowId pins captureVisibleTab to the pill's own window.
 */
async function capturePageForPill(tabId, windowId) {
  const [pageText, dataUrl] = await Promise.all([
    chrome.scripting
      .executeScript({ target: { tabId }, func: () => document.body.innerText.slice(0, 15000) })
      .then(([inj]) => inj?.result || '')
      .catch(() => ''),
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
  ]);
  const b64 = (dataUrl || '').split(',')[1];
  if (!b64) throw new Error('Не удалось снять скриншот страницы. Откройте тест МЭШ на активной вкладке и попробуйте снова.');
  return { pageText, screenshot: { mimeType: 'image/png', dataBase64: b64, name: 'screen.png' } };
}

/**
 * Solve ONE captured page: run the existing solve path, drop the answers into
 * the in-page panel (showAnswersInTab) and autofill the form across every frame
 * (fillAllFrames). Returns the parsed questions + fill summary.
 */
async function pillSolveOnePage(tabId, windowId) {
  const { pageText, screenshot } = await capturePageForPill(tabId, windowId);
  const answer = await solveTest({ text: pageText, screenshot });
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
async function pillSolveAllPages(tabId, windowId) {
  let solved = 0;
  let outcome = 'done';
  for (let page = 1; page <= PILL_MAX_PAGES; page++) {
    notifyPill(tabId, { phase: 'solve', page });
    const { questions } = await pillSolveOnePage(tabId, windowId);
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'OPEN_DASHBOARD':
          await openDashboard(msg.payload);
          sendResponse({ ok: true });
          break;
        case 'SOLVE':
          // Non-streaming fallback (popup / callers that don't open a port).
          sendResponse({ ok: true, result: await solve(msg.payload) });
          break;
        case 'SOLVE_TEST': {
          const answer = await solveTest(msg.payload);
          // Parse once: the panel needs it now, and the popup's «Решить все
          // страницы» loop needs the structured questions to auto-fill the page.
          const questions = parseTestAnswers(answer);
          // Fire-and-forget: surfacing the panel must NOT delay the popup reply.
          // The popup is also where errors get rendered, so a panel failure has
          // no user-visible impact beyond "no on-page panel this time".
          const tabId = msg.payload?.tabId;
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
          const { questions, summary } = await pillSolveOnePage(tabId, windowId);
          sendResponse({ ok: true, count: questions.length, summary });
          break;
        }
        case 'PILL_SOLVE_ALL': {
          // The pill's «все страницы» autopilot: solve+fill every page, advancing
          // with «Далее», stopping before any submit/finish control.
          const tabId = sender?.tab?.id;
          const windowId = sender?.tab?.windowId;
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const { outcome, solved } = await pillSolveAllPages(tabId, windowId);
          sendResponse({ ok: true, outcome, solved });
          break;
        }
        case 'RESOLVE_QUESTION': {
          // The answer panel's per-line «перерешать» button: re-solve ONE
          // question on the panel's tab. sender.tab is that (test) tab.
          const tabId = sender?.tab?.id;
          const windowId = sender?.tab?.windowId;
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          const resolved = await resolveOneQuestion(tabId, windowId, msg.payload || {});
          sendResponse({ ok: true, answer: resolved.answer, parts: resolved.parts });
          break;
        }
        case 'GET_RUNTIME_CONFIG':
          // Remote hot-fix config (scrape selectors / vocabulary / update notice)
          // with built-in fallback. Never throws; cached for RUNTIME_CONFIG_TTL_MS.
          sendResponse({ ok: true, config: await getRuntimeConfig({ force: !!msg.payload?.force }) });
          break;
        case 'CLASSIFY_TASKS':
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
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async
});

// Streaming solve over a long-lived port. The dashboard connects with
// name 'solve', sends one { type:'SOLVE', payload }, and receives a series of
// { type:'delta', text } messages followed by { type:'done', result } or
// { type:'error', error }. An open port also keeps the service worker alive
// for the duration of the (possibly long) streamed answer.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'solve') return;
  // Abort the in-flight provider call if the dashboard tab is closed/reloaded
  // mid-stream. Without this the upstream fetch keeps streaming (and getting
  // charged) until the 60-s idle timeout, even though no UI is listening.
  let activeCtrl = null;
  port.onDisconnect.addListener(() => {
    try { activeCtrl?.abort(); } catch { /* already aborted */ }
    activeCtrl = null;
  });
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'SOLVE') return;
    const ctrl = new AbortController();
    activeCtrl = ctrl;
    const safePost = (m) => { try { port.postMessage(m); } catch { /* port closed */ } };
    try {
      const result = await solve(msg.payload, (text) => safePost({ type: 'delta', text }), ctrl.signal);
      safePost({ type: 'done', result });
    } catch (e) {
      // Caller-initiated abort: the port is already gone, no point posting.
      if (e?.name !== 'AbortError' && !ctrl.signal.aborted) {
        safePost({ type: 'error', error: String(e?.message || e) });
      }
    } finally {
      if (activeCtrl === ctrl) activeCtrl = null;
    }
  });
});

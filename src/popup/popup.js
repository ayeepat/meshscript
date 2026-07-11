/**
 * Popup: two tabs.
 *  - Домашка: scans the Mesh diary tab, renders the week, uploads + Solve.
 *  - Тест: screenshots the active tab + extracts its text, sends both to the
 *    AI and shows ONLY question numbers + answers (in-app Mesh tests).
 */
import { initTheme } from '../common/theme.js';
import { extractMath, restoreMath } from '../common/tex.js';
import { classifyTask, needsAudio } from '../lib/task-classifier.js';
import { iconSvg } from '../common/icons.js';
import { startThinking } from '../common/thinking.js';
import { mountProviderBadge, PROVIDER_ABBR } from '../common/provider-badge.js';
import { hasConsent, setConsent } from '../lib/consent.js';
import { getLicenseStatus, setLicenseKey, reasonMessage } from '../lib/license.js';
import { isVersionBelow } from '../lib/remote-config.js';
import { SUPPORT_BOT_URL } from '../lib/config.js';
import { assertUploadAllowed } from '../lib/upload-limits.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AI_NOTICE_URL = 'https://smeshai.xyz/ai';

initTheme();

// Point the «Поддержка» link at the support bot (single source of truth in config.js).
const supportLink = document.getElementById('supportLink');
if (supportLink) supportLink.href = SUPPORT_BOT_URL;

// Remote hot-fix config (scrape selectors / vocabulary / update notice), pulled
// once per popup open from the service worker. Null until loaded; every consumer
// tolerates null and falls back to the values built into this release.
let runtimeConfig = null;

const uploads = {}; // per-card upload key -> [{mimeType, dataBase64, name}, ...]
const autoFetched = new Set(); // upKeys we've already auto-pulled from Mesh
const autoFetchFailures = new Map(); // upKey -> visible Russian reason

// Upload buttons of the current render, in card order, so the async Groq
// classification can refine their labels after the instant regex pass.
let cardDrops = [];
let weekSavePromise = Promise.resolve();

// Only the caption span is touched so the hidden <input> inside the label
// survives relabeling.
function setDropKind(drop, kind) {
  if (drop.classList.contains('has')) return; // a file is already attached
  drop.classList.toggle('need', kind === 'attachment' || kind === 'textbook');
  const icon = kind === 'textbook' ? 'camera' : 'paperclip';
  const caption =
    kind === 'attachment' ? 'Прикрепите файл' :
    kind === 'textbook' ? 'Фото страницы' :
    'Файл';
  drop.querySelector('.dropicon').innerHTML = iconSvg(icon, 13);
  drop.querySelector('.droplabel').textContent = caption;
}

function setDropLoading(drop, label) {
  drop.classList.add('need');
  drop.querySelector('.dropicon').innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  drop.querySelector('.droplabel').textContent = label;
}

function setDropAttached(drop, files) {
  drop.classList.remove('need');
  drop.classList.add('has');
  drop.querySelector('.dropicon').innerHTML = iconSvg('check', 13);
  drop.querySelector('.droplabel').textContent =
    files.length === 1 ? files[0].name : `${files.length} файла из МЭШ`;
}

// Scanning the week is a passive act: no homework text leaves the device and
// no files are pulled until the user explicitly acts on a specific row. Card
// badges therefore come ONLY from the local regex classifier
// (task-classifier.js); the remote CLASSIFY_TASKS refinement and the Mesh
// attachment auto-fetch both moved into the per-row «Решить» click.

function fileToInline(file) {
  assertUploadAllowed(file);
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const b64 = String(r.result).split(',')[1];
      resolve({ mimeType: file.type || 'application/octet-stream', dataBase64: b64, name: file.name });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// The Test tab sends a screenshot and page text to an AI provider. It is a
// Mesh-only feature, so never capture an arbitrary active tab (mail, banking,
// private documents) just because the popup happened to stay open after a tab
// switch. Keep this deliberately narrower than the manifest's host permission.
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
  if (!tab?.id) throw new Error('Не удалось определить активную вкладку.');
  if (!isMeshTestTab(tab)) {
    throw new Error('Для решения теста откройте тест МЭШ на school.mos.ru или uchebnik.mos.ru. Другие вкладки расширение не снимает и не отправляет ИИ.');
  }
}

function sendToContent(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

function sendToBackground(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

/**
 * Pull files attached to a homework straight from the logged-in Mesh session.
 * Two steps, split for MV3 reasons (see scraper listMaterialUrls):
 *  1. the content script discovers the file URLs (same-origin API call);
 *  2. the service worker downloads them (cross-origin, host_permissions).
 * On success the drop shows the file as already attached, so the user never
 * leaves the page to download it.
 */
async function tryAutoFetch(card, { quiet = false } = {}) {
  const { homeworkId, homeworkItemId, upKey, drop } = card;
  if (uploads[upKey]?.length) return true;
  if (!homeworkId) {
    autoFetchFailures.set(upKey, 'нет id задания');
    if (!quiet) showStoredAutoFetchFailure(card);
    return false;
  }
  if (autoFetched.has(upKey)) {
    if (!quiet) showStoredAutoFetchFailure(card);
    return false;
  }
  autoFetched.add(upKey);
  const tab = await getActiveTab();
  if (!tab?.id) {
    autoFetchFailures.set(upKey, 'нет вкладки МЭШ');
    if (!quiet) showStoredAutoFetchFailure(card);
    return false;
  }
  if (!quiet) setDropLoading(drop, 'Ищу файл в МЭШ…');

  const found = await sendToContent(tab.id, {
    type: 'MESH_LIST_MATERIALS',
    homeworkId,
    homeworkItemId,
    rowToken: card.rowToken,
    task: card.task
  });
  card.candidates = Array.isArray(found?.candidates) ? found.candidates : [];
  card.candidateAuth = { headers: found?.headers || null, token: found?.token || null };
  // Same-origin attachments are already downloaded by the content script; any
  // cross-origin URLs come back for the service worker to fetch.
  let files = found?.files || [];
  if (found?.urls?.length) {
    const dl = await sendToBackground({
      type: 'DOWNLOAD_FILES',
      payload: { urls: found.urls, headers: found.headers, token: found.token }
    });
    if (dl?.ok && dl.files?.length) files = files.concat(dl.files);
  }

  if (files.length) {
    if (uploads[upKey]?.length) return true;
    autoFetchFailures.delete(upKey);
    uploads[upKey] = files;
    setDropAttached(drop, files);
    return true;
  }

  if (card.candidates.length) {
    autoFetchFailures.set(upKey, `найдено ${card.candidates.length} — требуется выбор`);
    if (!quiet) showStoredAutoFetchFailure(card);
    return false;
  }

  // Nothing usable — surface WHY so it's debuggable, then fall back to manual
  // upload (which always works). Stages come from listMaterialUrls.
  const why = {
    no_lesson_id: 'нет id задания',
    no_token: 'нет входа в МЭШ',
    no_student_id: 'не нашёл student_id',
    ambiguous_student: 'не выбран активный ученик',
    api_error: 'МЭШ API ' + (found?.status || ''),
    no_urls: 'файла нет в задании',
    auth_redirect: 'нужна авторизация',
    download_failed: 'не скачалось',
    exception: 'ошибка запроса'
  }[found?.stage] || 'не найдено';
  autoFetchFailures.set(upKey, why);
  if (!quiet) showStoredAutoFetchFailure(card);
  return false;
}

// Ambiguous DOM/API links are never downloaded automatically. Ask at the
// moment the user presses «Решить», when the action is explicit and the popup
// can bind the chosen URL to this exact row token.
async function chooseCandidateForCard(card) {
  if (uploads[card.upKey]?.length || !card.candidates?.length) return;
  const labels = card.candidates.map((candidate, i) =>
    `${i + 1}. ${candidate.name || 'Файл'}`);
  let index = -1;
  if (labels.length === 1) {
    const name = card.candidates[0].name || 'Файл';
    if (window.confirm(`МЭШ нашёл файл «${name}», но не смог однозначно подтвердить его строку. Прикрепить его к этому заданию?`)) index = 0;
  } else {
    const answer = window.prompt(
      'МЭШ нашёл несколько файлов, но их принадлежность строке неоднозначна. Введите номер нужного файла:\n\n' + labels.join('\n')
    );
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= labels.length) index = n - 1;
  }
  if (index < 0) return;
  setDropLoading(card.drop, 'Скачиваю выбранный файл…');
  const dl = await sendToBackground({
    type: 'DOWNLOAD_FILES',
    payload: {
      urls: [card.candidates[index].url],
      headers: card.candidateAuth?.headers,
      token: card.candidateAuth?.token
    }
  });
  if (dl?.ok && dl.files?.length) {
    uploads[card.upKey] = dl.files;
    setDropAttached(card.drop, dl.files);
  } else {
    autoFetchFailures.set(card.upKey, 'выбранный файл не скачался');
    showStoredAutoFetchFailure(card);
  }
}

function startAutoFetch(card, opts = {}) {
  return tryAutoFetch(card, opts).catch(() => {
    autoFetchFailures.set(card.upKey, 'ошибка запроса');
    if (!opts.quiet) showStoredAutoFetchFailure(card);
    return false;
  });
}

function showStoredAutoFetchFailure(card) {
  if (uploads[card.upKey]?.length) return;
  setDropAttachFallback(card.drop, autoFetchFailures.get(card.upKey) || 'не найдено');
}

// Restore the manual upload prompt, but append the auto-fetch failure reason so
// the user (and we) can see why МЭШ didn't hand the file over automatically.
function setDropAttachFallback(drop, why) {
  setDropKind(drop, 'attachment');
  if (why) drop.querySelector('.droplabel').textContent = `Прикрепите файл (${why})`;
}

function showMessage(html) {
  document.getElementById('list').innerHTML = html;
}

/**
 * One-click diagnostic: run the file auto-fetch against EVERY scanned homework
 * (so a specific one like the OGE variant is always covered, not just the first
 * card) and dump the results into a copyable box. Saves digging through DevTools.
 */
async function runFetchDiag(btn) {
  const out = document.getElementById('diagOut');
  out.hidden = false;
  out.value = 'Запускаю диагностику…';
  const tab = await getActiveTab();
  if (!tab?.id) { out.value = 'Не удалось определить вкладку. Откройте страницу МЭШ.'; return; }

  const seen = new Set();
  const results = [];
  for (const c of cardDrops) {
    const diagKey = `${c.homeworkId || ''}:${c.homeworkItemId || (c.task || '').slice(0, 60)}`;
    if (!c.homeworkId || seen.has(diagKey)) continue;
    seen.add(diagKey);
    const resp = await sendToContent(tab.id, { type: 'MESH_DEBUG_FETCH', homeworkId: c.homeworkId });
    results.push({
      subject: c.subject,
      task: (c.task || '').slice(0, 90),
      info: resp?.ok ? resp.info : { error: resp?.error || 'нет ответа от страницы' }
    });
  }
  if (!results.length) {
    const resp = await sendToContent(tab.id, { type: 'MESH_DEBUG_FETCH' });
    results.push({ info: resp?.ok ? resp.info : { error: resp?.error || 'нет карточек с id' } });
  }

  out.value = JSON.stringify(results, null, 2);
  btn.textContent = 'Скопировать результат';
  btn.onclick = async () => {
    try { await navigator.clipboard.writeText(out.value); btn.textContent = 'Скопировано'; }
    catch { out.select(); }
  };
}

/**
 * Try to message an already-present content script. If that fails (script not
 * injected yet on this tab), programmatically inject it, then retry once.
 */
function sendScan(tabId) {
  // Pass the remote hot-fix config along so the scraper can apply any overridden
  // subject vocabulary / homework selector for this scan (best-effort, nullable).
  const scanMsg = { type: 'MESH_SCAN', config: runtimeConfig };
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, scanMsg, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        // Not injected yet -> inject and retry.
        chrome.scripting.executeScript(
          { target: { tabId }, files: ['src/content/scraper.js'] },
          () => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            chrome.tabs.sendMessage(tabId, scanMsg, (resp2) => {
              if (chrome.runtime.lastError || !resp2) {
                resolve({ ok: false, error: chrome.runtime.lastError?.message || 'no response' });
              } else {
                resolve(resp2);
              }
            });
          }
        );
      } else {
        resolve(resp);
      }
    });
  });
}

function buildCard(day, item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="subject"></div>
    <div class="task"></div>
    <div class="row"></div>`;
  card.querySelector('.subject').textContent = item.subject;
  card.querySelector('.task').textContent = item.task;
  const row = card.querySelector('.row');

  // Listening needs real audio or a transcript. Attached audio can be
  // transcribed by the solver; bare Google Drive links still need the user to
  // send the clip/transcript because we cannot reliably fetch private Drive.
  if (needsAudio(item.task)) {
    const note = document.createElement('div');
    note.className = 'audionote';
    note.innerHTML = iconSvg('headphones', 14);
    note.append('Для аудирования нужен аудиофайл или расшифровка. Если файл приложен в МЭШ, попробую подтянуть его сам.');
    card.querySelector('.task').after(note);
  }

  // upKey MUST be unique per card: one subject can have several homeworks on the
  // same day (e.g. «Пересказ» + «Вариант 10 ОГЭ»). Keying on day+subject alone
  // made them share/overwrite each other's uploads — the source of the
  // "sometimes the file is there, sometimes not" bug. Add the homework id (or
  // task) so every card owns its own attachment slot.
  const rowKey = item.rowToken || item.homeworkItemId ||
    `${item.homeworkId || 'noid'}:${(item.task || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`;
  const upKey = `${day || '?'}||${item.subject}||${rowKey}`;

  const solveBtn = document.createElement('button');
  solveBtn.className = 'solve';
  solveBtn.textContent = 'Решить';
  solveBtn.onclick = async () => {
    // The explicit per-row action is what authorizes pulling this row's files
    // from Mesh — nothing was pre-downloaded during the passive week scan.
    if (!cardObj.fetchPromise && item.homeworkId && !uploads[upKey]?.length) {
      setDropLoading(drop, 'Ищу файл в МЭШ…');
      cardObj.fetchPromise = startAutoFetch(cardObj, { quiet: firstKind !== 'attachment' });
    }
    // Wait for the in-flight fetch so a quick click doesn't open the solve
    // with no file attached (the other half of the intermittency).
    if (cardObj.fetchPromise) { try { await cardObj.fetchPromise; } catch { /* manual fallback */ } }
    await chooseCandidateForCard(cardObj);
    await weekSavePromise;
    // Hand any attached files (manual or auto-fetched) to the dashboard. Include
    // the task so the dashboard matches THIS homework, not another same-subject
    // one. `ts` feeds the retention sweep: an unconsumed handoff dies in 1 h.
    if (uploads[upKey]?.length) {
      await chrome.storage.local.set({
        pendingUpload: {
          ts: Date.now(),
          day,
          subject: item.subject,
          task: item.task,
          homeworkId: item.homeworkId,
          homeworkItemId: item.homeworkItemId,
          rowToken: item.rowToken,
          files: uploads[upKey]
        }
      });
    } else {
      await chrome.storage.local.remove('pendingUpload'); // drop stale leftovers
    }
    chrome.runtime.sendMessage({
      type: 'OPEN_DASHBOARD',
      payload: {
        subject: item.subject,
        task: item.task,
        day,
        homeworkId: item.homeworkId,
        homeworkItemId: item.homeworkItemId,
        rowToken: item.rowToken
      }
    });
  };
  row.appendChild(solveBtn);

  // Upload is ALWAYS available — no vocabulary covers every phrasing a
  // teacher uses. Classification only decides how loudly to suggest it:
  // regex gives an instant label, the batched Groq call refines it.
  const drop = document.createElement('label');
  drop.className = 'drop';
  drop.innerHTML = '<span class="dropicon"></span><span class="droplabel"></span>';
  const firstKind = classifyTask(item.task).kind;
  setDropKind(drop, firstKind);
  const cardObj = {
    task: item.task,
    subject: item.subject,
    drop,
    homeworkId: item.homeworkId,
    homeworkItemId: item.homeworkItemId,
    rowToken: item.rowToken,
    upKey,
    fetchPromise: null,
    candidates: [],
    candidateAuth: null
  };
  cardDrops.push(cardObj);
  // No auto-fetch here: pulling files from Mesh for every scanned row would
  // download attachments the user never asked about. The fetch starts inside
  // the row's «Решить» click (see solveBtn.onclick above) — same coverage for
  // rows the user actually opens, nothing for rows they don't.
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv,.rtf,.md,image/*,audio/*,.mp3,.m4a,.wav,.ogg,.opus,.flac,.aac';
  input.style.display = 'none';
  const setFile = async (file) => {
    try {
      uploads[upKey] = [await fileToInline(file)];
      drop.querySelector('.dropicon').innerHTML = iconSvg('check', 13);
      drop.querySelector('.droplabel').textContent = file.name;
      drop.classList.remove('need');
      drop.classList.add('has');
    } catch (e) {
      delete uploads[upKey];
      setDropAttachFallback(drop, e?.message || 'не удалось прочитать файл');
    }
  };
  input.onchange = () => { if (input.files[0]) setFile(input.files[0]); };
  drop.appendChild(input);
  drop.ondragover = (e) => { e.preventDefault(); };
  drop.ondrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  };
  row.appendChild(drop);
  return card;
}

function render(data) {
  const dayEl = document.getElementById('day');
  const listEl = document.getElementById('list');
  const days = (data.days || []).filter((d) => d.subjects?.length);
  listEl.innerHTML = '';
  cardDrops = [];

  if (!days.length) {
    dayEl.textContent = 'Ближайший день не найден';
    listEl.innerHTML = '<p class="muted">Домашние задания не найдены на этой странице. Откройте страницу с домашними заданиями (можно прошлую дату) и нажмите на иконку снова.</p>';
    return;
  }

  dayEl.textContent = 'Домашние задания на неделю';
  // Save the week scan so the dashboard sidebar can show it.
  weekSavePromise = chrome.storage.local.set({ weekHomework: { days, scannedAt: Date.now() } });

  days.forEach((group, idx) => {
    const details = document.createElement('details');
    details.className = 'daygroup';
    if (idx === 0) details.open = true; // nearest day starts expanded
    const summary = document.createElement('summary');
    const dname = document.createElement('span');
    dname.className = 'dname';
    dname.textContent = group.day || 'Без даты';
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = group.subjects.length;
    summary.append(dname, count);
    details.appendChild(summary);
    for (const item of group.subjects) {
      details.appendChild(buildCard(group.day, item));
    }
    listEl.appendChild(details);
  });
}

/* ---------- Тест tab: screenshot + page text -> «№N: ответ» ---------- */

function setStatus(el, text) {
  el.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  el.append(text);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function aiNoticeHtml() {
  return '<div class="ai-notice">' +
    iconSvg('info', 13) +
    '<span>Это ИИ: ответы могут быть неточными. Проверяйте источники.</span>' +
    `<a href="${AI_NOTICE_URL}" target="_blank" rel="noopener noreferrer">Подробнее</a>` +
    '</div>';
}

/**
 * Last-resort rescue for a FREE-TEXT reply (no JSON at all) — the TEST_ANSWER
 * prompt mandates JSON, so this only runs when the model ignored it entirely.
 *  1. Scan for «№N: …» / «N) …» / «N. …» lines anywhere — the model almost
 *     always lists answers in that shape, and we can pluck them out.
 *  2. Otherwise return the last non-empty line (the model's final conclusion)
 *     so the user still sees something useful — never a raw JSON blob.
 */
function extractFinalAnswers(raw) {
  // (1) numbered answer lines
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const numbered = lines.filter((l) => /^(?:№|#)?\s*\d+\s*[.):]/.test(l));
  if (numbered.length) return numbered.join('\n');
  // (2) last non-empty line — but NEVER hand back a raw JSON blob (that is the
  // exact symptom we guard against: a truncated «{"reasoning":...» leaking to
  // the user). Prefer the last readable, non-JSON-looking line instead.
  const last = lines[lines.length - 1] || raw.trim();
  if (/^[{}[\]"]/.test(last)) {
    const readable = [...lines].reverse().find((l) => !/^[{}[\]"]/.test(l));
    return readable || 'Не удалось разобрать ответ модели. Попробуйте решить ещё раз.';
  }
  return last;
}

/** Decode a JSON string literal's inner text (escapes -> chars). Falls back to
 *  the raw slice if it isn't well-formed (e.g. a value truncated mid-escape). */
function decodeJsonStr(inner) {
  try { return JSON.parse('"' + inner + '"'); } catch { return inner; }
}

/**
 * Pull {"n":…,"a":"…"} pairs straight out of the text. This rescues answers
 * from JSON that JSON.parse rejects — most often a reply truncated by the
 * model's token limit before the closing brace, where the whole-object parse
 * fails but the answers that did arrive are still perfectly usable.
 */
function answersFromPartial(raw) {
  const out = [];
  let m;
  const re = /"n"\s*:\s*(?:"([^"]*)"|([^\s,}]+))\s*,\s*"a"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  while ((m = re.exec(raw)) !== null) {
    const n = (m[1] ?? m[2] ?? '').trim();
    out.push(`№${n}: ${decodeJsonStr(m[3])}`);
  }
  if (out.length) return out.join('\n');
  // Fallback: some replies emit the keys in the other order ("a" before "n").
  const re2 = /"a"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"n"\s*:\s*(?:"([^"]*)"|([^\s,}]+))/g;
  while ((m = re2.exec(raw)) !== null) {
    const n = (m[2] ?? m[3] ?? '').trim();
    out.push(`№${n}: ${decodeJsonStr(m[1])}`);
  }
  return out.length ? out.join('\n') : null;
}

/**
 * Reasoning-only rescue: when the model spent its whole token budget on the
 * "reasoning" field and never reached "answers", show the decoded reasoning
 * text rather than dumping «{"reasoning":"…» braces at the user. The closing
 * quote is optional so a truncated reply still yields something readable.
 */
function reasoningFromPartial(raw) {
  const m = raw.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return null;
  const text = decodeJsonStr(m[1]).trim();
  return text || null;
}

/**
 * Format the model's reply into «№N: ответ» lines. The test prompt asks for
 * JSON ({reasoning, answers:[{n,a}]}), so the happy path is a clean parse. The
 * later tiers salvage partial/truncated replies so a cut-off response never
 * surfaces as raw JSON to the user.
 */
function formatTestAnswers(raw) {
  const fromObj = (obj) => {
    if (!obj || !Array.isArray(obj.answers)) return null;
    const lines = obj.answers
      .filter((x) => x && (x.a != null))
      .map((x) => `№${x.n}: ${x.a}`);
    return lines.length ? lines.join('\n') : null;
  };
  // (1) Whole JSON — the happy path when the reply came back intact.
  try { const r = fromObj(JSON.parse(raw)); if (r) return r; } catch { /* not pure JSON */ }
  // (2) JSON embedded in prose / code fences.
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { const r = fromObj(JSON.parse(m[0])); if (r) return r; } catch { /* ignore */ } }
  // (3) Partial/truncated JSON: salvage whatever answer pairs did arrive.
  const partial = answersFromPartial(raw);
  if (partial) return partial;
  // (4) Reasoning-only reply: show the reasoning text, never the raw braces.
  const reasoning = reasoningFromPartial(raw);
  if (reasoning) return reasoning;
  // (5) Free-text reply (no JSON at all): numbered-line / last-line scan.
  return extractFinalAnswers(raw);
}

/** Minimal render: bold, line breaks, and LaTeX via tex.js. Returns the plain
 *  final-answers text so the caller can offer a one-tap copy. */
function renderAnswer(el, raw) {
  const plain = formatTestAnswers(raw);
  const { text, chunks } = extractMath(plain);
  const html = escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  el.innerHTML = restoreMath(html, chunks) + aiNoticeHtml();
  return plain;
}

/**
 * Hard safety net so the test solver can NEVER spin on «Решаю…» forever.
 * Races a promise against a timer: if the underlying step (screenshot, or the
 * background round-trip) doesn't settle in time — e.g. the MV3 service worker
 * was recycled mid-request and its reply was dropped, or the network stalled —
 * we reject with a clear, actionable Russian message instead of hanging. The
 * background work may still finish (and the on-page answer panel may appear);
 * this just guarantees the popup always gives the user feedback.
 */
function withTimeout(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const CAPTURE_TARGET_CHANGED = 'Переключилась вкладка — попробуйте ещё раз.';

function captureTargetMatches(active, target) {
  return active?.id === target?.id && active?.url === target?.url;
}

async function requireActiveCaptureTarget(target) {
  const [active] = await chrome.tabs.query({ active: true, windowId: target.windowId });
  if (!captureTargetMatches(active, target)) throw new Error(CAPTURE_TARGET_CHANGED);
}

// captureVisibleTab targets the active tab, not the tab whose id we pass to the
// text extractor. Re-check immediately on both sides and discard any image raced
// by a tab switch, so the solve can never pair Mesh text with another page.
async function captureVisibleTarget(target) {
  await requireActiveCaptureTarget(target);
  const dataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: 'jpeg', quality: 90 });
  await requireActiveCaptureTarget(target);
  return dataUrl;
}

/**
 * Capture the visible test page: top-frame text + a JPEG screenshot. Page text
 * is best-effort (some pages/iframes forbid injection). JPEG (q90), not PNG: a
 * retina PNG is 1.5–4 MB of base64 and the whole capture rides ONE /ai/start
 * POST, which is too slow for the RU DPI per-connection clamp window (see
 * lib/smesh-proxy.js); q90 keeps test text and formulas perfectly readable.
 * @returns {Promise<{pageText:string, screenshot:object}>}
 */
async function capturePage(tab) {
  const [pageText, dataUrl] = await withTimeout(
    Promise.all([
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, func: () => document.body.innerText.slice(0, 15000) })
        .then(([inj]) => inj?.result || '')
        .catch(() => ''),
      captureVisibleTarget(tab)
    ]),
    20000,
    'Не удалось снять скриншот страницы. Откройте тест МЭШ на активной вкладке и попробуйте снова.'
  );
  // Guard against a missing/empty capture so we surface a clear message instead
  // of throwing on dataUrl.split (which read as a cryptic error).
  const b64 = (dataUrl || '').split(',')[1];
  if (!b64) throw new Error('Не удалось снять скриншот страницы. Откройте тест МЭШ на активной вкладке и попробуйте снова.');
  return { pageText, screenshot: { mimeType: 'image/jpeg', dataBase64: b64, name: 'screen.jpg' } };
}

/**
 * Ask the service worker to solve one captured page. tabId lets it also drop the
 * answers into the in-page floating panel. The 120-s cap guarantees the popup
 * never spins forever with a provider-neutral, actionable message.
 * @returns {Promise<{ok:boolean, answer?:string, questions?:object[], error?:string}>}
 */
function timeoutMessage(provider) {
  const name = {
    openrouter: 'OpenRouter',
    groq: 'Groq',
    qwen: 'Qwen',
    deepseek: 'DeepSeek'
  }[provider] || 'выбранного ИИ-сервиса';
  return `Не удалось получить ответ за 2 минуты. Проверьте интернет и настройки ${name}, затем попробуйте ещё раз.`;
}

async function requestSolve(tabId, screenshot, pageText) {
  const { aiProvider } = await chrome.storage.local.get('aiProvider');
  const provider = PROVIDER_ABBR[aiProvider] ? aiProvider : undefined;
  return withTimeout(
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'SOLVE_TEST', payload: { text: pageText, screenshot, tabId, provider } }, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r || { ok: false, error: 'нет ответа' });
      });
    }),
    120000,
    timeoutMessage(provider)
  );
}

async function solveTestOnScreen() {
  const btn = document.getElementById('solveTest');
  const allBtn = document.getElementById('solveAllPages');
  const box = document.getElementById('testAnswer');
  const copyBtn = document.getElementById('copyTest');
  btn.disabled = true;
  if (allBtn) allBtn.disabled = true;
  copyBtn.hidden = true;
  box.hidden = false;
  setStatus(box, 'Читаю страницу…');
  let ticker = null;
  try {
    const tab = await getActiveTab();
    requireMeshTestTab(tab);

    const { pageText, screenshot } = await capturePage(tab);

    // Live status: a shifting verb + elapsed seconds so a long reasoning pass
    // never looks frozen. Stopped the moment the answer lands or an error fires.
    ticker = startThinking(box);
    const resp = await requestSolve(tab.id, screenshot, pageText);
    ticker.stop();
    ticker = null;
    if (!resp.ok) throw new Error(resp.error || 'нет ответа');
    const plain = renderAnswer(box, resp.answer);
    const copyLabel = document.getElementById('copyTestLabel');
    copyBtn.hidden = false;
    copyLabel.textContent = 'Скопировать ответы';
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(plain);
        copyLabel.textContent = 'Скопировано';
        setTimeout(() => (copyLabel.textContent = 'Скопировать ответы'), 1500);
      } catch (_e) { /* clipboard blocked — ignore */ }
    };
  } catch (e) {
    // ALWAYS render a clear message instead of a stuck spinner.
    box.textContent = 'Ошибка: ' + (e?.message || e);
  } finally {
    if (ticker) ticker.stop();
    btn.disabled = false;
    if (allBtn) allBtn.disabled = false;
  }
}

/* ---------- Тест tab: multi-page auto-pagination ---------- */

// Signature of the current page (across all frames) so we can tell whether a
// «Далее» click actually advanced it. Empty string on failure.
async function pageSignature(tabId) {
  const r = await sendToBackground({ type: 'TEST_PAGE_SIG', payload: { tabId } });
  return r?.sig || '';
}

// Poll the page signature until it differs from `beforeSig` (page changed) or
// the budget runs out. A short initial settle gives the new page time to render.
async function waitForChange(tabId, beforeSig, timeout) {
  const start = Date.now();
  await sleep(600);
  while (Date.now() - start < timeout) {
    const sig = await pageSignature(tabId);
    if (sig && sig !== beforeSig) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Try to advance to the next page. Clicks «Далее», then waits for the content to
 * actually change. One short retry if the first click doesn't take. Returns:
 *   'ok'     — advanced to a new page
 *   'finish' — only a submit/finish control remains (NOT clicked — user's call)
 *   'none'   — no forward control found at all
 *   'stuck'  — clicked but the page never changed
 */
async function advancePage(tabId, beforeSig) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await sendToBackground({ type: 'TEST_NEXT_PAGE', payload: { tabId } });
    const status = r?.status || 'none';
    if (status === 'finish') return 'finish';
    if (status === 'ambiguous') return 'ambiguous';
    if (status === 'none') return attempt === 0 ? 'none' : 'stuck';
    // status === 'clicked': wait for the new page. Be generous on the first try
    // (slow loads), then re-click once before giving up.
    if (await waitForChange(tabId, beforeSig, attempt === 0 ? 8000 : 4000)) return 'ok';
  }
  return 'stuck';
}

function renderPaginationSummary(box, outcome, solved) {
  const pages = `Решено страниц: ${solved}.`;
  let msg;
  switch (outcome) {
    case 'finish':
      msg = `${pages} Дошёл до конца теста — отправку не нажимаю, проверь и отправь сам.`;
      break;
    case 'none':
      msg = `${pages} Не нашёл кнопку «Дальше» — похоже, это последняя страница. Проверь и отправь сам.`;
      break;
    case 'stuck':
      msg = `${pages} Страница не сменилась после нажатия «Дальше» — остановился. Проверь оставшиеся вопросы вручную.`;
      break;
    case 'ambiguous':
      msg = `${pages} Нашёл несколько неоднозначных кнопок «Дальше» — ничего не нажал. Продолжите вручную.`;
      break;
    case 'max':
      msg = `${pages} Достигнут предел в 30 страниц — остановился. Проверь и отправь сам.`;
      break;
    default:
      msg = `Готово. ${pages}`;
  }
  box.textContent = msg;
}

const MAX_PAGES = 30;

/**
 * Solve a multi-page test: for each page — solve, fill, then click «Далее» and
 * wait for the next page — repeating until the end. NEVER clicks a submit/finish
 * control: at the end it stops and tells the user to submit themselves. Fully
 * optional; the single-page «Решить тест» flow is unchanged.
 */
async function solveAllPages() {
  const btn = document.getElementById('solveTest');
  const allBtn = document.getElementById('solveAllPages');
  const box = document.getElementById('testAnswer');
  const copyBtn = document.getElementById('copyTest');
  btn.disabled = true;
  allBtn.disabled = true;
  copyBtn.hidden = true;
  box.hidden = false;
  setStatus(box, 'Запускаю…');
  let ticker = null;
  let solved = 0;
  let outcome = 'done';
  try {
    const tab = await getActiveTab();
    requireMeshTestTab(tab);

    for (let page = 1; page <= MAX_PAGES; page++) {
      // Solve the visible page. Progress reads «Страница N · Решаю… 12s».
      ticker = startThinking(box, { prefix: `Страница ${page}` });
      const { pageText, screenshot } = await capturePage(tab);
      const resp = await requestSolve(tab.id, screenshot, pageText);
      if (!resp.ok) throw new Error(resp.error || 'нет ответа');
      ticker.stop();
      ticker = null;

      // Fill this page's answers into the form (across all frames).
      const questions = resp.questions || [];
      if (questions.length) {
        await sendToBackground({ type: 'FILL_ANSWERS_TAB', payload: { tabId: tab.id, questions } });
        solved++;
      }
      // Let the fill's React re-render settle so the page signature captures the
      // current (filled) state — otherwise a late repaint could look like a
      // navigation and fool the change detector below.
      await sleep(700);

      // Advance to the next page.
      setStatus(box, `Страница ${page} готова. Открываю следующую…`);
      const beforeSig = await pageSignature(tab.id);
      const nav = await advancePage(tab.id, beforeSig);
      if (nav === 'finish') { outcome = 'finish'; break; }
      if (nav === 'none') { outcome = 'none'; break; }
      if (nav === 'ambiguous') { outcome = 'ambiguous'; break; }
      if (nav === 'stuck') { outcome = 'stuck'; break; }
      if (page === MAX_PAGES) { outcome = 'max'; break; }
      await sleep(500); // small settle before solving the new page
    }
  } catch (e) {
    if (ticker) { ticker.stop(); ticker = null; }
    box.textContent = 'Ошибка: ' + (e?.message || e);
    btn.disabled = false;
    allBtn.disabled = false;
    return;
  } finally {
    if (ticker) ticker.stop();
  }
  renderPaginationSummary(box, outcome, solved);
  btn.disabled = false;
  allBtn.disabled = false;
}

/* ---------- Tabs + init ---------- */

function showTab(which) {
  const isTest = which === 'test';
  document.getElementById('hwView').hidden = isTest;
  document.getElementById('testView').hidden = !isTest;
  document.getElementById('tabHw').classList.toggle('active', !isTest);
  document.getElementById('tabTest').classList.toggle('active', isTest);
  // Shrink the popup on the test tab so it covers less of the page underneath.
  document.body.classList.toggle('compact', isTest);
}

async function scanHomework() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    showMessage('<p class="muted">Не удалось определить активную вкладку.</p>');
    return;
  }
  if (!/^https:\/\/school\.mos\.ru\/diary\//.test(tab.url || '')) {
    showMessage('<p class="muted">Откройте страницу дневника Mesh (school.mos.ru/diary/...) и нажмите на иконку снова. Для теста МЭШ откройте вкладку «Тест».</p>');
    return;
  }
  const resp = await sendScan(tab.id);
  if (!resp.ok) {
    showMessage('<p class="muted">Не удалось сканировать страницу. Перезагрузите страницу Mesh (F5) и попробуйте снова.<br><small>' + escapeHtml(resp.error || '') + '</small></p>');
    return;
  }
  render(resp.data);
}

/* ---------- First-run onboarding (consent + a working AI key) ---------- */

const OB_PROVIDERS = ['groq', 'openrouter', 'qwen', 'deepseek'];
// Qwen/DeepSeek deliberately have NO key field: they run through the СМЭШ
// proxy, and the LICENSE key is the credential (lib/smesh-proxy.js). The
// student never sees the words "API key" for them.
const PROVIDER_KEY_FIELD = { groq: 'groqApiKey', openrouter: 'openrouterApiKey' };
const LICENSE_LINK = { url: 'https://www.smeshai.xyz/', label: 'Купить лицензию СМЭШ →', placeholder: 'SMESH-XXXX-XXXX-XXXX' };
const PROVIDER_KEY_LINK = {
  groq: { url: 'https://console.groq.com/keys', label: 'Получить бесплатный ключ →', placeholder: 'gsk_…' },
  openrouter: { url: 'https://openrouter.ai/keys', label: 'Получить ключ OpenRouter →', placeholder: 'sk-or-v1-…' },
  qwen: LICENSE_LINK,
  deepseek: LICENSE_LINK
};
let obProvider = 'groq';

function setObProvider(p) {
  obProvider = OB_PROVIDERS.includes(p) ? p : 'groq';
  const meta = PROVIDER_KEY_LINK[obProvider];
  for (const b of document.querySelectorAll('#obProvider button')) {
    b.classList.toggle('active', b.dataset.p === obProvider);
  }
  const link = document.getElementById('obKeyLink');
  link.href = meta.url;
  link.textContent = meta.label;
  document.getElementById('obKey').placeholder = meta.placeholder;
}

function showObError(text) {
  const err = document.getElementById('obError');
  err.textContent = text;
  err.hidden = !text;
}

// Toggle the onboarding view vs. the normal tabbed UI.
function showOnboarding(show) {
  document.getElementById('onboardView').hidden = !show;
  document.querySelector('nav.tabs').hidden = show;
  if (show) {
    document.getElementById('hwView').hidden = true;
    document.getElementById('testView').hidden = true;
  } else {
    showTab('hw');
  }
}

async function finishOnboarding() {
  const consent = document.getElementById('obConsent').checked;
  const typed = document.getElementById('obKey').value.trim();
  if (!consent) { showObError('Поставьте галочку согласия, чтобы продолжить.'); return; }
  const field = PROVIDER_KEY_FIELD[obProvider];
  if (field) {
    // Re-pasting isn't required if a key for the chosen provider is already stored
    // (e.g. set earlier in Settings) — consent alone is enough to proceed then.
    const { [field]: existing } = await chrome.storage.local.get(field);
    if (!typed && !existing) { showObError('Вставьте API-ключ выбранного сервиса.'); return; }
  } else {
    // Qwen/DeepSeek: the typed value is the СМЭШ license key. Verify it right
    // here so the very first «Решить» can't fail on a bad license. An already
    // active license (entered earlier in Settings) passes without retyping.
    if (typed) {
      const r = await setLicenseKey(typed);
      if (!r.ok) { showObError(reasonMessage(r.reason)); return; }
    } else {
      const status = await getLicenseStatus();
      if (!status?.ok) { showObError('Введите ключ лицензии СМЭШ (SMESH-…) или купите её на сайте.'); return; }
    }
  }
  showObError('');
  const data = { aiProvider: obProvider };
  if (field && typed) data[field] = typed;
  await chrome.storage.local.set(data);
  await setConsent(true);
  showOnboarding(false);
  scanHomework();
}

function wireOnboarding() {
  document.getElementById('obProvider').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setObProvider(b.dataset.p);
  });
  document.getElementById('obStart').onclick = finishOnboarding;
  document.getElementById('obSettings').onclick = () => chrome.runtime.openOptionsPage();
}

// Ready = consent given AND the selected provider has a WORKING credential (an
// API key, or for Qwen/DeepSeek a valid license / hidden BYO key). Otherwise
// show onboarding so the very first "Решить" can never dead-end on a bare
// credential error.
async function isReadyToSolve() {
  if (!(await hasConsent())) return false;
  const stored = await chrome.storage.local.get(
    ['aiProvider', 'licenseStatus', 'qwenApiKey', ...Object.values(PROVIDER_KEY_FIELD)]
  );
  const provider = stored.aiProvider || 'openrouter';
  if (provider === 'qwen' || provider === 'deepseek') {
    // Hidden BYO Model Studio key bypasses the license entirely.
    if (stored.qwenApiKey) return true;
    // Otherwise the license must be USABLE, not merely entered: a confirmed-bad
    // verdict (expired / revoked / not_found / device_limit) has no working
    // credential, so send the user to onboarding — where the error and a fix
    // field are shown — instead of letting every «Решить» dead-end on the proxy.
    // A network-only failure is ambiguous (the key may be fine, the verify just
    // didn't reach the server), so we DON'T bounce on it — mirroring license.js's
    // keep-last-good policy and askViaProxy's deliberate leniency.
    const lic = stored.licenseStatus;
    return !!lic?.key && (lic.ok === true || lic.reason === 'network');
  }
  // Fall back to OpenRouter's key field for any unknown/legacy provider value.
  const field = PROVIDER_KEY_FIELD[provider] || 'openrouterApiKey';
  return !!stored[field];
}

/* ---------- Runtime-config notice (update required / operator message) ---------- */

async function loadRuntimeConfig() {
  const r = await sendToBackground({ type: 'GET_RUNTIME_CONFIG' });
  runtimeConfig = r?.ok ? r.config : null;
  return runtimeConfig;
}

function renderNotice(config) {
  const el = document.getElementById('notice');
  if (!config) { el.hidden = true; return; }
  const version = chrome.runtime.getManifest().version;
  let text = '';
  let url = null;
  if (config.minExtensionVersion && isVersionBelow(version, config.minExtensionVersion)) {
    text = 'Вышло важное обновление расширения — обновите его, чтобы всё работало корректно.';
    url = config.notice?.url || null;
  } else if (config.notice?.text) {
    text = config.notice.text;
    url = config.notice.url || null;
  }
  if (!text) { el.hidden = true; return; }
  el.innerHTML = escapeHtml(text) +
    (url ? ` <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Подробнее →</a>` : '');
  el.hidden = false;
}

async function init() {
  document.getElementById('settingsBtn').onclick = () => chrome.runtime.openOptionsPage();
  document.getElementById('tabHw').onclick = () => showTab('hw');
  document.getElementById('tabTest').onclick = () => showTab('test');
  document.getElementById('solveTest').onclick = solveTestOnScreen;
  document.getElementById('solveAllPages').onclick = solveAllPages;
  document.getElementById('diagBtn').onclick = (e) => runFetchDiag(e.currentTarget);
  mountProviderBadge('provBadge'); // tiny "which AI" tag on the test tab
  wireOnboarding();

  // Runtime config first (drives both the update banner and the scrape overrides),
  // then decide between onboarding and the normal flow.
  renderNotice(await loadRuntimeConfig());

  if (await isReadyToSolve()) {
    scanHomework();
  } else {
    const { aiProvider } = await chrome.storage.local.get('aiProvider');
    setObProvider(aiProvider || 'groq'); // prefer free Groq for brand-new users
    showOnboarding(true);
  }
}

init();

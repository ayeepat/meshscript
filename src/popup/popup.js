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

initTheme();

const uploads = {}; // `${day}||${subject}` -> [{mimeType, dataBase64, name}, ...]
const autoFetched = new Set(); // upKeys we've already auto-pulled from Mesh

// Upload buttons of the current render, in card order, so the async Groq
// classification can refine their labels after the instant regex pass.
let cardDrops = [];

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

/**
 * Ask the background to classify all scanned tasks in one batched call to
 * Groq (free tier; cached). Falls back silently — the regex-based labels
 * already on screen are a fine answer when Groq isn't configured.
 */
function refineDropLabels() {
  if (!cardDrops.length) return;
  const drops = cardDrops; // snapshot: a re-render replaces the array
  chrome.runtime.sendMessage(
    { type: 'CLASSIFY_TASKS', payload: { tasks: drops.map((c) => c.task) } },
    (resp) => {
      if (chrome.runtime.lastError || !resp?.ok || drops !== cardDrops) return;
      resp.kinds.forEach((kind, i) => {
        const card = drops[i];
        if (!card) return;
        setDropKind(card.drop, kind);
        if (kind === 'attachment') tryAutoFetch(card);
      });
    }
  );
}

function fileToInline(file) {
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
async function tryAutoFetch(card) {
  const { homeworkId, upKey, drop } = card;
  if (!homeworkId || autoFetched.has(upKey) || uploads[upKey]?.length) return;
  autoFetched.add(upKey);
  const tab = await getActiveTab();
  if (!tab?.id) return;
  setDropLoading(drop, 'Ищу файл в МЭШ…');

  const found = await sendToContent(tab.id, { type: 'MESH_LIST_MATERIALS', homeworkId });
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
    uploads[upKey] = files;
    setDropAttached(drop, files);
    return;
  }

  // Nothing usable — surface WHY so it's debuggable, then fall back to manual
  // upload (which always works). Stages come from listMaterialUrls.
  const why = {
    no_lesson_id: 'нет id задания',
    no_token: 'нет входа в МЭШ',
    api_error: 'МЭШ API ' + (found?.status || ''),
    no_urls: 'файла нет в задании',
    auth_redirect: 'нужна авторизация',
    download_failed: 'не скачалось',
    exception: 'ошибка запроса'
  }[found?.stage] || 'не найдено';
  setDropAttachFallback(drop, why);
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
 * One-click diagnostic: run the full file auto-fetch against the first card that
 * has a Mesh homework id and dump the raw result into a copyable box. Saves the
 * user from digging through DevTools — they just copy this and send it over.
 */
async function runFetchDiag(btn) {
  const card = cardDrops.find((c) => c.homeworkId) || cardDrops[0];
  const out = document.getElementById('diagOut');
  out.hidden = false;
  out.value = 'Запускаю диагностику…';
  const tab = await getActiveTab();
  if (!tab?.id) { out.value = 'Не удалось определить вкладку. Откройте страницу МЭШ.'; return; }
  const resp = await sendToContent(tab.id, { type: 'MESH_DEBUG_FETCH', homeworkId: card?.homeworkId });
  const info = resp?.ok ? resp.info : { error: resp?.error || 'нет ответа от страницы' };
  out.value = JSON.stringify(info, null, 2);
  btn.textContent = 'Скопировать результат';
  btn.onclick = async () => {
    try { await navigator.clipboard.writeText(out.value); btn.textContent = 'Скопировано ✓'; }
    catch { out.select(); }
  };
}

/**
 * Try to message an already-present content script. If that fails (script not
 * injected yet on this tab), programmatically inject it, then retry once.
 */
function sendScan(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'MESH_SCAN' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        // Not injected yet -> inject and retry.
        chrome.scripting.executeScript(
          { target: { tabId }, files: ['src/content/scraper.js'] },
          () => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            chrome.tabs.sendMessage(tabId, { type: 'MESH_SCAN' }, (resp2) => {
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

  // Audio can NEVER be solved by this tool (no transcription). Warn up front so
  // the student doesn't trust an invented listening answer — the solver guard
  // refuses it too, this is just the visible heads-up.
  if (needsAudio(item.task)) {
    const note = document.createElement('div');
    note.className = 'audionote';
    note.textContent = '🎧 Аудирование не решается — пришлите текст/расшифровку записи. Остальное решу.';
    card.querySelector('.task').after(note);
  }

  const upKey = `${day || '?'}||${item.subject}`;

  const solveBtn = document.createElement('button');
  solveBtn.className = 'solve';
  solveBtn.textContent = 'Решить';
  solveBtn.onclick = async () => {
    // Hand any attached files (manual or auto-fetched) to the dashboard.
    if (uploads[upKey]?.length) {
      await chrome.storage.local.set({ pendingUpload: { day, subject: item.subject, files: uploads[upKey] } });
    } else {
      await chrome.storage.local.remove('pendingUpload'); // drop stale leftovers
    }
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', payload: { subject: item.subject, task: item.task, day } });
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
  const cardObj = { task: item.task, drop, homeworkId: item.homeworkId, upKey };
  cardDrops.push(cardObj);
  // Attachment tasks: try to pull the file straight from Mesh right away.
  if (firstKind === 'attachment') tryAutoFetch(cardObj);
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv,.rtf,.md,image/*';
  input.style.display = 'none';
  const setFile = async (file) => {
    uploads[upKey] = [await fileToInline(file)];
    drop.querySelector('.dropicon').innerHTML = iconSvg('check', 13);
    drop.querySelector('.droplabel').textContent = file.name;
    drop.classList.remove('need');
    drop.classList.add('has');
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
  chrome.storage.local.set({ weekHomework: { days, scannedAt: Date.now() } });

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

  refineDropLabels();
}

/* ---------- Тест tab: screenshot + page text -> «№N: ответ» ---------- */

function setStatus(el, text) {
  el.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  el.append(text);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Pull out only the final answers the model emits after solving with full
 * reasoning. Three-tier strategy because Flash skips formatting rules ~10%
 * of the time:
 *  1. Trust the `===ОТВЕТЫ===` separator the prompt mandates.
 *  2. If absent, scan for «№N: …» / «N) …» / «N. …» lines anywhere — the
 *     model almost always lists answers in that shape even when it ignores
 *     the marker, and we can pluck them out.
 *  3. As a last resort, return the last non-empty line (the model's final
 *     conclusion) so the user still sees something useful.
 */
function extractFinalAnswers(raw) {
  // (1) marker
  const parts = raw.split(/={2,}\s*ОТВЕТЫ\s*={2,}/i);
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1].trim();
    if (tail) return tail;
  }
  // (2) numbered answer lines
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const numbered = lines.filter((l) => /^(?:№|#)?\s*\d+\s*[.):]/.test(l));
  if (numbered.length) return numbered.join('\n');
  // (3) last non-empty line
  return lines[lines.length - 1] || raw.trim();
}

/**
 * Format the model's reply into «№N: ответ» lines. The test prompt now asks
 * for JSON ({reasoning, answers:[{n,a}]}), so parsing is deterministic; the
 * old text-scan stays only as a fallback if JSON ever comes back malformed.
 */
function formatTestAnswers(raw) {
  const fromObj = (obj) => {
    if (!obj || !Array.isArray(obj.answers)) return null;
    const lines = obj.answers
      .filter((x) => x && (x.a != null))
      .map((x) => `№${x.n}: ${x.a}`);
    return lines.length ? lines.join('\n') : null;
  };
  try { const r = fromObj(JSON.parse(raw)); if (r) return r; } catch { /* not pure JSON */ }
  const m = raw.match(/\{[\s\S]*\}/); // JSON embedded in prose
  if (m) { try { const r = fromObj(JSON.parse(m[0])); if (r) return r; } catch { /* ignore */ } }
  return extractFinalAnswers(raw); // legacy fallback
}

/** Minimal render: bold, line breaks, and LaTeX via tex.js. Returns the plain
 *  final-answers text so the caller can offer a one-tap copy. */
function renderAnswer(el, raw) {
  const plain = formatTestAnswers(raw);
  const { text, chunks } = extractMath(plain);
  const html = escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  el.innerHTML = restoreMath(html, chunks);
  return plain;
}

async function solveTestOnScreen() {
  const btn = document.getElementById('solveTest');
  const box = document.getElementById('testAnswer');
  const copyBtn = document.getElementById('copyTest');
  btn.disabled = true;
  copyBtn.hidden = true;
  box.hidden = false;
  setStatus(box, 'Читаю страницу…');
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('Не удалось определить активную вкладку.');

    // Text extraction and screenshot are independent — run them together so
    // the user waits for the slower of the two, not their sum. Page text is
    // best-effort: some pages forbid injection — the screenshot (PNG, lossless
    // so small numbers/formulas stay crisp) is usually enough on its own.
    const [pageText, dataUrl] = await Promise.all([
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, func: () => document.body.innerText.slice(0, 15000) })
        .then(([inj]) => inj?.result || '')
        .catch(() => ''),
      chrome.tabs.captureVisibleTab(undefined, { format: 'png' })
    ]);
    const screenshot = { mimeType: 'image/png', dataBase64: dataUrl.split(',')[1], name: 'screen.png' };

    setStatus(box, 'Решаю…');
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'SOLVE_TEST', payload: { text: pageText, screenshot } }, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r || { ok: false, error: 'нет ответа' });
      });
    });
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
    box.textContent = 'Ошибка: ' + (e?.message || e);
  } finally {
    btn.disabled = false;
  }
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

function init() {
  document.getElementById('settingsBtn').onclick = () => chrome.runtime.openOptionsPage();
  document.getElementById('tabHw').onclick = () => showTab('hw');
  document.getElementById('tabTest').onclick = () => showTab('test');
  document.getElementById('solveTest').onclick = solveTestOnScreen;
  document.getElementById('diagBtn').onclick = (e) => runFetchDiag(e.currentTarget);
  scanHomework();
}

init();

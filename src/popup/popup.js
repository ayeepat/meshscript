/**
 * Popup: two tabs.
 *  - Домашка: scans the Mesh diary tab, renders the week, uploads + Solve.
 *  - Тест: screenshots the active tab + extracts its text, sends both to the
 *    AI and shows ONLY question numbers + answers (in-app Mesh tests).
 */
import { initTheme } from '../common/theme.js';
import { extractMath, restoreMath } from '../common/tex.js';

initTheme();

const FILE_KEYWORDS = ['pdf file', 'прикреплённые задания', 'файл', 'тест мэш', 'доделать упр'];
const uploads = {}; // `${day}||${subject}` -> {mimeType, dataBase64, name}

function needsFile(task) {
  const t = (task || '').toLowerCase();
  return FILE_KEYWORDS.some((k) => t.includes(k));
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

function showMessage(html) {
  document.getElementById('list').innerHTML = html;
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

  const upKey = `${day || '?'}||${item.subject}`;

  const solveBtn = document.createElement('button');
  solveBtn.className = 'solve';
  solveBtn.textContent = 'Solve';
  solveBtn.onclick = async () => {
    // Hand the attached file (if any) to the dashboard via storage.
    if (uploads[upKey]) {
      await chrome.storage.local.set({ pendingUpload: { day, subject: item.subject, file: uploads[upKey] } });
    } else {
      await chrome.storage.local.remove('pendingUpload'); // drop stale leftovers
    }
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', payload: { subject: item.subject, task: item.task, day } });
  };
  row.appendChild(solveBtn);

  if (needsFile(item.task)) {
    const drop = document.createElement('label');
    drop.className = 'drop';
    drop.textContent = '📎 Загрузить файл';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.doc,.docx,image/*';
    input.style.display = 'none';
    const setFile = async (file) => {
      uploads[upKey] = await fileToInline(file);
      drop.textContent = '✓ ' + uploads[upKey].name;
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
  }
  return card;
}

function render(data) {
  const dayEl = document.getElementById('day');
  const listEl = document.getElementById('list');
  const days = (data.days || []).filter((d) => d.subjects?.length);
  listEl.innerHTML = '';

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
}

/* ---------- Тест tab: screenshot + page text -> «№N: ответ» ---------- */

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

/** Minimal render: bold, line breaks, and LaTeX via tex.js. */
function renderAnswer(el, raw) {
  const { text, chunks } = extractMath(extractFinalAnswers(raw));
  const html = escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  el.innerHTML = restoreMath(html, chunks);
}

async function solveTestOnScreen() {
  const btn = document.getElementById('solveTest');
  const box = document.getElementById('testAnswer');
  btn.disabled = true;
  box.hidden = false;
  box.textContent = '👀 Смотрю…';
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('Не удалось определить активную вкладку.');

    // Page text is best-effort: some pages forbid injection — the screenshot
    // alone is usually enough for the vision model.
    let pageText = '';
    try {
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body.innerText.slice(0, 15000)
      });
      pageText = inj?.result || '';
    } catch (_e) { /* keep going with just the screenshot */ }

    // PNG is lossless — small numbers and formulas stay crisp, which matters
    // more than file size since the screenshot is sent once and discarded.
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
    const screenshot = { mimeType: 'image/png', dataBase64: dataUrl.split(',')[1], name: 'screen.png' };

    box.textContent = '🧠 Решаю…';
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'SOLVE_TEST', payload: { text: pageText, screenshot } }, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r || { ok: false, error: 'нет ответа' });
      });
    });
    if (!resp.ok) throw new Error(resp.error || 'нет ответа');
    renderAnswer(box, resp.answer);
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
  scanHomework();
}

init();

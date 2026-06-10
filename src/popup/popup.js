/** Popup: scans active Mesh tab, renders subjects, handles uploads + Solve. */
import { initTheme } from '../common/theme.js';

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

async function init() {
  document.getElementById('settingsBtn').onclick = () => chrome.runtime.openOptionsPage();

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    showMessage('<p class="muted">Не удалось определить активную вкладку.</p>');
    return;
  }
  if (!/^https:\/\/school\.mos\.ru\/diary\//.test(tab.url || '')) {
    showMessage('<p class="muted">Откройте страницу дневника Mesh (school.mos.ru/diary/...) и нажмите на иконку снова.</p>');
    return;
  }

  const resp = await sendScan(tab.id);
  if (!resp.ok) {
    showMessage('<p class="muted">Не удалось сканировать страницу. Перезагрузите страницу Mesh (F5) и попробуйте снова.<br><small>' + (resp.error || '') + '</small></p>');
    return;
  }
  render(resp.data);
}

init();

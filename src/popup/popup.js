/** Popup: scans active Mesh tab, renders subjects, handles uploads + Solve. */

const FILE_KEYWORDS = ['pdf file', 'прикреплённые задания', 'файл', 'тест мэш', 'доделать упр'];
const uploads = {}; // subject -> {mimeType, dataBase64, name}

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

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function render(data) {
  const dayEl = document.getElementById('day');
  const listEl = document.getElementById('list');
  dayEl.textContent = data.day || 'Ближайший день не найден';
  listEl.innerHTML = '';
  if (!data.subjects?.length) {
    listEl.innerHTML = '<p class="muted">Домашние задания не найдены. Откройте страницу домашних заданий Mesh.</p>';
    return;
  }
  for (const item of data.subjects) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="subject"></div>
      <div class="task"></div>
      <div class="row"></div>`;
    card.querySelector('.subject').textContent = item.subject;
    card.querySelector('.task').textContent = item.task;
    const row = card.querySelector('.row');

    const solveBtn = document.createElement('button');
    solveBtn.className = 'solve';
    solveBtn.textContent = 'Solve';
    solveBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', payload: { subject: item.subject, task: item.task } });
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
      input.onchange = async () => {
        if (input.files[0]) {
          uploads[item.subject] = await fileToInline(input.files[0]);
          drop.textContent = '✓ ' + uploads[item.subject].name;
          drop.classList.add('has');
        }
      };
      drop.appendChild(input);
      drop.ondragover = (e) => { e.preventDefault(); };
      drop.ondrop = async (e) => {
        e.preventDefault();
        if (e.dataTransfer.files[0]) {
          uploads[item.subject] = await fileToInline(e.dataTransfer.files[0]);
          drop.textContent = '✓ ' + uploads[item.subject].name;
          drop.classList.add('has');
        }
      };
      row.appendChild(drop);
    }
    listEl.appendChild(card);
  }
}

async function init() {
  document.getElementById('settingsBtn').onclick = () => chrome.runtime.openOptionsPage();
  const tabId = await getActiveTabId();
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'MESH_SCAN' }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) {
      document.getElementById('list').innerHTML =
        '<p class="muted">Не удалось сканировать. Откройте school.mos.ru/diary/homeworks/homeworks и перезагрузите страницу.</p>';
      return;
    }
    render(resp.data);
  });
}

init();

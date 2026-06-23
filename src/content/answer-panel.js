/**
 * Floating answer panel for in-page test answers.
 *
 * Lives in the content-script isolated world. Renders inside an open Shadow DOM
 * so the host page's CSS can never touch it. Idempotent: re-injecting the
 * script (e.g. service worker calls executeScript every solve) is a no-op.
 *
 * Persists {x, y, minimized} to chrome.storage.session so a soft refresh
 * inside the same browser session restores the same panel position.
 */
(() => {
  if (window.__smeshPanel) return;

  const STORAGE_KEY = 'smeshAnswerPanel';
  const HOST_ID = '__smesh-answer-panel-host';
  const DEFAULT_W = 400;

  let hostEl = null;
  let shadow = null;
  let lastPayload = null;
  let state = { x: null, y: null, minimized: false };

  // Theme follows the user's extension preference ('system' | 'light' | 'dark'),
  // stored in chrome.storage.local by src/common/theme.js. The panel lives in a
  // Shadow DOM on the host page, so it can't inherit the extension's CSS tokens —
  // we resolve the theme here and paint the panel to match.
  let themePref = 'system';
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const resolveTheme = () =>
    themePref === 'light' || themePref === 'dark'
      ? themePref
      : (darkMedia.matches ? 'dark' : 'light');

  function loadTheme() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('theme', (v) => {
          if (!chrome.runtime.lastError && v?.theme) themePref = v.theme;
          resolve();
        });
      } catch { resolve(); }
    });
  }

  function applyTheme() {
    if (!shadow) return;
    const panel = shadow.querySelector('.panel');
    if (panel) panel.dataset.theme = resolveTheme();
  }

  function loadState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get(STORAGE_KEY, (v) => {
          if (!chrome.runtime.lastError && v?.[STORAGE_KEY]) {
            state = { ...state, ...v[STORAGE_KEY] };
          }
          resolve();
        });
      } catch { resolve(); }
    });
  }

  function saveState() {
    try { chrome.storage.session.set({ [STORAGE_KEY]: state }); } catch { /* session storage blocked */ }
  }

  function ensureHost() {
    if (hostEl && document.documentElement.contains(hostEl)) return;
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    // The host is a 0×0 anchor; the panel inside positions itself fixed.
    hostEl.style.cssText =
      'all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; ' +
      'z-index: 2147483647; pointer-events: none;';
    shadow = hostEl.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(hostEl);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // The id must match what scraper.js's fillTestAnswers reports back in its
  // {filled, skipped} summary, so the ✓ / ⚠ markers land on the right line.
  function questionId(q, i) {
    return (q.index != null && String(q.index).trim() !== '') ? q.index : i + 1;
  }

  function questionLine(q, i) {
    const num = q.index != null ? q.index : i + 1;
    const qid = escapeHtml(questionId(q, i));
    const text = (q.text || '').trim();
    const ans = escapeHtml(q.answer ?? '');
    if (text) {
      return `<li data-qid="${qid}"><span class="num">${escapeHtml(num)}.</span> <span class="q">${escapeHtml(text)}</span><span class="a">${ans}</span></li>`;
    }
    return `<li data-qid="${qid}"><span class="num">№${escapeHtml(num)}</span><span class="a">${ans}</span></li>`;
  }

  function buildPanel(payload) {
    const questions = Array.isArray(payload?.questions) ? payload.questions : [];
    lastPayload = { questions };

    shadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }

        /* Theme tokens — toggled live via .panel[data-theme]. Defaults to dark
           so the panel never flashes unstyled before the preference resolves. */
        .panel[data-theme="dark"] {
          --p-bg: rgba(22, 24, 30, 0.94);
          --p-text: #f3f4f8;
          --p-border: rgba(255, 255, 255, 0.08);
          --p-shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
          --p-titlebar: rgba(255, 255, 255, 0.04);
          --p-muted: #8a92a3;
          --p-btn-border: rgba(255, 255, 255, 0.14);
          --p-btn-hover: rgba(255, 255, 255, 0.10);
          --p-btn-active: rgba(255, 255, 255, 0.16);
          --p-li-border: rgba(255, 255, 255, 0.05);
          --p-q: #cbd0d8;
          --p-answer: #82e2b6;
          --p-arrow: #6c7280;
        }
        .panel[data-theme="light"] {
          --p-bg: rgba(255, 255, 255, 0.96);
          --p-text: #0d0d0d;
          --p-border: rgba(0, 0, 0, 0.10);
          --p-shadow: 0 14px 40px rgba(0, 0, 0, 0.16);
          --p-titlebar: rgba(0, 0, 0, 0.035);
          --p-muted: #6b6b73;
          --p-btn-border: rgba(0, 0, 0, 0.16);
          --p-btn-hover: rgba(0, 0, 0, 0.05);
          --p-btn-active: rgba(0, 0, 0, 0.09);
          --p-li-border: rgba(0, 0, 0, 0.06);
          --p-q: #3a3a42;
          --p-answer: #1a7f37;
          --p-arrow: #9b9ba4;
        }

        .panel {
          position: fixed;
          width: ${DEFAULT_W}px;
          max-height: 70vh;
          background: var(--p-bg);
          color: var(--p-text);
          border: 1px solid var(--p-border);
          border-radius: 12px;
          box-shadow: var(--p-shadow);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          display: flex;
          flex-direction: column;
          pointer-events: auto;
          overflow: hidden;
        }
        .titlebar {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 10px;
          cursor: grab;
          background: var(--p-titlebar);
          user-select: none;
        }
        .titlebar.dragging { cursor: grabbing; }
        .title { flex: 1; font-weight: 600; font-size: 12px; letter-spacing: 0.2px; }
        .count { color: var(--p-muted); font-weight: 500; margin-left: 4px; }
        button {
          background: transparent;
          color: inherit;
          border: 1px solid var(--p-btn-border);
          border-radius: 6px;
          padding: 3px 7px;
          font-size: 12px;
          line-height: 1;
          cursor: pointer;
          font-family: inherit;
          min-width: 24px;
        }
        button:hover { background: var(--p-btn-hover); }
        button:active { background: var(--p-btn-active); }
        .btn-copy { font-weight: 600; }
        .body {
          overflow-y: auto;
          padding: 8px 12px 12px;
        }
        ol {
          margin: 0;
          padding: 0;
          list-style: none;
        }
        li {
          padding: 6px 0;
          line-height: 1.45;
          border-bottom: 1px solid var(--p-li-border);
        }
        li:last-child { border-bottom: none; }
        .num { color: var(--p-muted); margin-right: 6px; font-variant-numeric: tabular-nums; }
        .q { color: var(--p-q); }
        .a {
          color: var(--p-answer);
          font-weight: 600;
          margin-left: 6px;
          word-break: break-word;
        }
        li .q + .a::before { content: " → "; color: var(--p-arrow); font-weight: normal; margin-right: 4px; }
        .empty { color: var(--p-muted); font-style: italic; padding: 6px 0; }
        .panel.minimized .body { display: none; }
        .panel.minimized { max-height: none; }
        .copied { color: var(--p-answer); border-color: var(--p-answer); }
        .failed { color: #e5534b; border-color: #e5534b; }
        .btn-fill { font-weight: 600; }
        /* Per-line fill markers, set after "Заполнить" runs. */
        .mark { font-variant-numeric: tabular-nums; margin-right: 4px; }
        .mark.ok { color: var(--p-answer); }
        .mark.warn { color: #d9a300; }
      </style>
      <div class="panel${state.minimized ? ' minimized' : ''}" data-theme="${resolveTheme()}">
        <div class="titlebar" data-drag>
          <div class="title">Ответы на тест<span class="count"> · ${questions.length}</span></div>
          <button class="btn-fill" title="Заполнить форму теста ответами" aria-label="Заполнить">Заполнить</button>
          <button class="btn-copy" title="Скопировать все ответы" aria-label="Скопировать">Copy</button>
          <button class="btn-toggle" title="Свернуть / развернуть" aria-label="Свернуть">${state.minimized ? '▢' : '–'}</button>
          <button class="btn-close" title="Закрыть" aria-label="Закрыть">×</button>
        </div>
        <div class="body">
          ${questions.length
            ? `<ol>${questions.map(questionLine).join('')}</ol>`
            : '<div class="empty">Ответы не распознаны.</div>'}
        </div>
      </div>
    `;

    const panel = shadow.querySelector('.panel');
    positionPanel(panel);
    wireDrag(panel);
    wireButtons(panel, questions);
  }

  function positionPanel(panel) {
    if (state.x != null && state.y != null) {
      panel.style.left = clamp(state.x, 0, Math.max(0, innerWidth - 80)) + 'px';
      panel.style.top = clamp(state.y, 0, Math.max(0, innerHeight - 50)) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    } else {
      panel.style.right = '20px';
      panel.style.bottom = '20px';
    }
  }

  function wireDrag(panel) {
    const bar = panel.querySelector('[data-drag]');
    let startX = 0, startY = 0, panelX = 0, panelY = 0;

    // The global mousemove/mouseup listeners exist ONLY for the duration of an
    // active drag, then remove themselves. Earlier they were attached to window
    // on every wireDrag() call and never removed — each panel rebuild (every
    // test solve, every page of a multi-page run) leaked another pair, piling up
    // dozens of dead listeners that pinned detached panel DOM in memory.
    const onMove = (e) => {
      const w = panel.offsetWidth;
      const x = clamp(panelX + (e.clientX - startX), 0, Math.max(0, innerWidth - w));
      const y = clamp(panelY + (e.clientY - startY), 0, Math.max(0, innerHeight - 40));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      bar.classList.remove('dragging');
      state.x = parseFloat(panel.style.left) || 0;
      state.y = parseFloat(panel.style.top) || 0;
      saveState();
    };

    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panelX = rect.left;
      panelY = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      bar.classList.add('dragging');
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      e.preventDefault();
    });
  }

  // Paint the ✓ / ⚠ markers from a fill summary onto the matching lines.
  function markFillResults(summary) {
    if (!shadow) return;
    const filled = new Set((summary?.filled || []).map(String));
    const skipped = new Set((summary?.skipped || []).map(String));
    shadow.querySelectorAll('li[data-qid]').forEach((li) => {
      const id = li.getAttribute('data-qid');
      let mark = li.querySelector('.mark');
      if (!mark) {
        mark = document.createElement('span');
        mark.className = 'mark';
        li.insertBefore(mark, li.firstChild);
      }
      if (filled.has(id)) { mark.className = 'mark ok'; mark.textContent = '✓ '; }
      else if (skipped.has(id)) { mark.className = 'mark warn'; mark.textContent = '⚠ '; }
      else { mark.className = 'mark'; mark.textContent = ''; }
    });
  }

  // Fill just THIS frame's form via scraper.js (same isolated world). Used as a
  // fallback when the service worker can't be reached.
  function localFill(qs) {
    try {
      return (typeof window.__smeshFill === 'function') ? window.__smeshFill(qs) : null;
    } catch { return null; }
  }

  // Fill the test form. The form often lives inside an iframe (Mesh embeds some
  // test players), which the panel's own frame can't reach — so ask the service
  // worker to run the fill in EVERY frame of the tab and merge the result. If
  // the worker is unreachable, fall back to filling this frame directly.
  function requestFill(qs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (s) => { if (!settled) { settled = true; resolve(s); } };
      // Safety net: never let the button hang if no reply ever comes.
      const t = setTimeout(() => finish(localFill(qs)), 8000);
      try {
        chrome.runtime.sendMessage({ type: 'FILL_ANSWERS_ALL', payload: { questions: qs } }, (resp) => {
          clearTimeout(t);
          if (chrome.runtime.lastError || !resp || !resp.ok || !resp.summary) {
            // Worker error / no receiver → fill this frame only.
            const local = localFill(qs);
            finish(local || (resp && resp.summary) || null);
          } else {
            finish(resp.summary);
          }
        });
      } catch {
        clearTimeout(t);
        finish(localFill(qs));
      }
    });
  }

  function wireButtons(panel, questions) {
    const closeBtn = panel.querySelector('.btn-close');
    const toggleBtn = panel.querySelector('.btn-toggle');
    const copyBtn = panel.querySelector('.btn-copy');
    const fillBtn = panel.querySelector('.btn-fill');

    closeBtn.addEventListener('click', hide);

    fillBtn.addEventListener('click', async () => {
      const qs = (lastPayload && lastPayload.questions) || questions || [];
      const orig = fillBtn.textContent;
      fillBtn.disabled = true;
      let summary = null;
      try {
        summary = await requestFill(qs);
      } catch { summary = null; }
      fillBtn.disabled = false;
      if (!summary) {
        fillBtn.textContent = 'Ошибка';
        fillBtn.classList.add('failed');
        setTimeout(() => { fillBtn.textContent = orig; fillBtn.classList.remove('failed'); }, 1600);
        return;
      }
      markFillResults(summary);
      const n = (summary.filled || []).length;
      fillBtn.textContent = `✓ ${n}`;
      fillBtn.classList.add('copied');
      setTimeout(() => { fillBtn.textContent = orig; fillBtn.classList.remove('copied'); }, 1600);
    });

    toggleBtn.addEventListener('click', () => {
      state.minimized = !state.minimized;
      panel.classList.toggle('minimized', state.minimized);
      toggleBtn.textContent = state.minimized ? '▢' : '–';
      saveState();
    });

    copyBtn.addEventListener('click', async () => {
      const txt = questions.map((q, i) => {
        const n = q.index != null ? q.index : i + 1;
        const t = (q.text || '').trim();
        return t ? `${n}. ${t} → ${q.answer ?? ''}` : `№${n}: ${q.answer ?? ''}`;
      }).join('\n');
      try {
        await navigator.clipboard.writeText(txt);
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.textContent = orig; copyBtn.classList.remove('copied'); }, 1200);
      } catch { /* clipboard blocked; nothing graceful to do here */ }
    });
  }

  async function show(payload) {
    await Promise.all([loadState(), loadTheme()]);
    ensureHost();
    buildPanel(payload);
  }

  function hide() {
    if (hostEl) { hostEl.remove(); hostEl = null; shadow = null; }
  }

  window.__smeshPanel = { show, hide };

  // Re-clamp into viewport on resize so a saved position from a wider window
  // doesn't strand the panel off-screen.
  window.addEventListener('resize', () => {
    if (!shadow) return;
    const panel = shadow.querySelector('.panel');
    if (panel && state.x != null && state.y != null) positionPanel(panel);
  });

  // Live-sync with the user's theme choice from any extension page (settings,
  // dashboard, popup). An open panel repaints instantly, no re-solve needed.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.theme) {
        themePref = changes.theme.newValue || 'system';
        applyTheme();
      }
    });
  } catch { /* storage events unavailable in this context */ }

  // When the preference is 'system', follow the OS scheme as it flips.
  darkMedia.addEventListener('change', () => { if (themePref === 'system') applyTheme(); });

  // Tear down on full navigation (SPA route changes won't fire — user closes manually).
  window.addEventListener('pagehide', hide);
})();


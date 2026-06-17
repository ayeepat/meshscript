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

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

  function questionLine(q, i) {
    const num = q.index != null ? q.index : i + 1;
    const text = (q.text || '').trim();
    const ans = escapeHtml(q.answer ?? '');
    if (text) {
      return `<li><span class="num">${escapeHtml(num)}.</span> <span class="q">${escapeHtml(text)}</span><span class="a">${ans}</span></li>`;
    }
    return `<li><span class="num">№${escapeHtml(num)}</span><span class="a">${ans}</span></li>`;
  }

  function buildPanel(payload) {
    const questions = Array.isArray(payload?.questions) ? payload.questions : [];
    lastPayload = { questions };

    shadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }
        .panel {
          position: fixed;
          width: ${DEFAULT_W}px;
          max-height: 70vh;
          background: rgba(22, 24, 30, 0.94);
          color: #f3f4f8;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          box-shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
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
          background: rgba(255, 255, 255, 0.04);
          user-select: none;
        }
        .titlebar.dragging { cursor: grabbing; }
        .title { flex: 1; font-weight: 600; font-size: 12px; letter-spacing: 0.2px; }
        .count { color: #8a92a3; font-weight: 500; margin-left: 4px; }
        button {
          background: transparent;
          color: inherit;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 6px;
          padding: 3px 7px;
          font-size: 12px;
          line-height: 1;
          cursor: pointer;
          font-family: inherit;
          min-width: 24px;
        }
        button:hover { background: rgba(255, 255, 255, 0.1); }
        button:active { background: rgba(255, 255, 255, 0.16); }
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
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        li:last-child { border-bottom: none; }
        .num { color: #8a92a3; margin-right: 6px; font-variant-numeric: tabular-nums; }
        .q { color: #cbd0d8; }
        .a {
          color: #82e2b6;
          font-weight: 600;
          margin-left: 6px;
          word-break: break-word;
        }
        li .q + .a::before { content: " → "; color: #6c7280; font-weight: normal; margin-right: 4px; }
        .empty { color: #8a92a3; font-style: italic; padding: 6px 0; }
        .panel.minimized .body { display: none; }
        .panel.minimized { max-height: none; }
        .copied { color: #82e2b6; border-color: #82e2b6; }
      </style>
      <div class="panel${state.minimized ? ' minimized' : ''}">
        <div class="titlebar" data-drag>
          <div class="title">Ответы на тест<span class="count"> · ${questions.length}</span></div>
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
    let dragging = false;
    let startX = 0, startY = 0, panelX = 0, panelY = 0;

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
      dragging = true;
      bar.classList.add('dragging');
      e.preventDefault();
    });

    const onMove = (e) => {
      if (!dragging) return;
      const w = panel.offsetWidth;
      const x = clamp(panelX + (e.clientX - startX), 0, Math.max(0, innerWidth - w));
      const y = clamp(panelY + (e.clientY - startY), 0, Math.max(0, innerHeight - 40));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('dragging');
      state.x = parseFloat(panel.style.left) || 0;
      state.y = parseFloat(panel.style.top) || 0;
      saveState();
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }

  function wireButtons(panel, questions) {
    const closeBtn = panel.querySelector('.btn-close');
    const toggleBtn = panel.querySelector('.btn-toggle');
    const copyBtn = panel.querySelector('.btn-copy');

    closeBtn.addEventListener('click', hide);

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
    await loadState();
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

  // Tear down on full navigation (SPA route changes won't fire — user closes manually).
  window.addEventListener('pagehide', hide);
})();

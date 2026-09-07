/**
 * Floating answer panel for in-page test answers.
 *
 * Lives in the content-script isolated world. Renders inside a closed Shadow DOM
 * so the host page's CSS and scripts cannot reach it. Idempotent: re-injecting the
 * script (e.g. service worker calls executeScript every solve) is a no-op.
 *
 * Persists {x, y, minimized, explain} to chrome.storage.session so a soft
 * refresh inside the same browser session restores the same panel position and
 * whether the per-question «разбор» was unfolded.
 */
(() => {
  if (window.__smeshPanel) return;

  const STORAGE_KEY = 'smeshAnswerPanel';
  const DEFAULT_W = 400;
  const AI_NOTICE_URL = 'https://smeshai.xyz/ai';
  const LONG_THINKING_NOTICE = 'Thinking longer for a more accurate response.';
  const MISSING_EXPLANATION = 'Пояснение для этого ответа не получено.';
  // The worker's fill runs three passes across every frame — native inputs, the
  // MathQuill main-world pass, then the ASYNC interactive pass that opens each
  // custom dropdown (~0.7s per dropdown). A matching question with several
  // dropdowns can push a single fill well past 8s, so an 8s cap here would time
  // out and paint a false «Ошибка» / wrong ⚠ over a page the worker did fill.
  const FILL_TIMEOUT_MS = 45000;

  // Brand fonts, served from the extension bundle (web_accessible_resources).
  // Injected into the Shadow DOM so the panel matches every other surface:
  // Unbounded for the title, Manrope for the body. Falls back to the system
  // stack if the resource can't be resolved (e.g. on an unexpected host).
  function fontFaceCss() {
    let url;
    try { url = (p) => chrome.runtime.getURL('assets/fonts/' + p); }
    catch { return ''; }
    return `
      @font-face {
        font-family: "SmeshManrope"; font-style: normal; font-weight: 200 800; font-display: swap;
        src: url("${url('manrope-cyrillic.woff2')}") format("woff2");
        unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
      }
      @font-face {
        font-family: "SmeshManrope"; font-style: normal; font-weight: 200 800; font-display: swap;
        src: url("${url('manrope-latin.woff2')}") format("woff2");
        unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+2122, U+2212, U+FEFF, U+FFFD;
      }
      @font-face {
        font-family: "SmeshUnbounded"; font-style: normal; font-weight: 600 800; font-display: swap;
        src: url("${url('unbounded-cyrillic.woff2')}") format("woff2");
        unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
      }
      @font-face {
        font-family: "SmeshUnbounded"; font-style: normal; font-weight: 600 800; font-display: swap;
        src: url("${url('unbounded-latin.woff2')}") format("woff2");
        unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+2122, U+2212, U+FEFF, U+FFFD;
      }`;
  }

  /* ---------- Extension context liveness ---------- */
  // Same trap the pill guards against (see content/test-pill.js): this script
  // keeps running after СМЭШ is reloaded or updated, holding a dead
  // chrome.runtime that fails only when a button is pressed. Without the probe
  // the panel reports a transient «Ошибка» and restores the button, inviting a
  // retry that can never succeed.
  //
  // The panel is deliberately NOT torn down. Its answers are plain text by now
  // and remain perfectly usable — the student can read and copy them. Only the
  // two controls that need the worker («Заполнить» and per-line «перерешать»)
  // are retired, with a visible reason. Copy and «Разбор» are pure DOM and keep
  // working.
  function contextAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }
  const CONTEXT_LOST_NOTE =
    'Расширение обновилось. Обновите страницу (F5), чтобы снова заполнять и перерешать. ' +
    'Ответы выше остаются в силе — их можно списать или скопировать.';
  let contextLost = false;

  let hostEl = null;
  let shadow = null;
  let lastPayload = null;
  let panelGeneration = 0;
  let activePanelNonce = '';
  let captureCheckTimer = null;
  // A drag owns capture listeners on `window`, so replacing/removing the Shadow
  // DOM alone is not a teardown. Keep the one active cleanup reachable from
  // show(), hide() and pagehide; a cancelled old gesture must never persist its
  // detached coordinates over the replacement panel's state.
  let activeDragCleanup = null;
  // `explain` is the «разбор» chevron: collapsed by default (the panel's job is
  // the answers), and remembered like the position and the minimised state so a
  // student who wants the reasoning gets it on every solve without re-clicking.
  let state = { x: null, y: null, minimized: false, explain: false };

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
    // storage.session, not local: local is trusted-contexts-only (it holds the
    // API keys), so the worker mirrors just `theme` into session for us.
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get('theme', (v) => {
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
    // The module keeps the only root reference; the page gets no stable id and a
    // closed root cannot be traversed to synthesize action-button clicks.
    shadow = hostEl.attachShadow({ mode: 'closed' });
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

  function explanationText(q) {
    const text = typeof q?.explain === 'string' ? q.explain.trim() : '';
    return text || MISSING_EXPLANATION;
  }

  function questionLine(q, i) {
    const num = q.index != null ? q.index : i + 1;
    const qid = escapeHtml(questionId(q, i));
    const text = (q.text || '').trim();
    const ans = escapeHtml(q.answer ?? '');
    const inner = text
      ? `<span class="num">${escapeHtml(num)}.</span> <span class="q">${escapeHtml(text)}</span><span class="a">${ans}</span>`
      : `<span class="num">№${escapeHtml(num)}</span><span class="a">${ans}</span>`;
    // Always reserve a truthful row. Old cache entries and malformed/probabilistic
    // model replies may lack `e`; a short fallback keeps the control stable and
    // avoids fabricating reasoning or spending tokens on an automatic retry.
    const why = `<span class="why">${escapeHtml(explanationText(q))}</span>`;
    // The «↻» re-asks just THIS question (re-captures the page + solves one),
    // so a single doubtful answer doesn't need a full-page re-solve. data-qi
    // carries the array index back to the handler.
    return `<li data-qid="${qid}">` +
      `<span class="qline">${inner}<span class="long-think-note" role="status" aria-live="polite" hidden>${LONG_THINKING_NOTICE}</span>${why}</span>` +
      `<button class="btn-resolve" type="button" data-qi="${i}" title="Перерешать этот вопрос" aria-label="Перерешать этот вопрос">↻</button>` +
      `</li>`;
  }

  // Wording for the «разбор» chevron, shared by the initial render and the click
  // handler so a panel rebuilt with the toggle already on never ships the
  // collapsed label.
  const whyTitle = (expanded) => (expanded ? 'Скрыть разбор' : 'Показать разбор по каждому вопросу');
  const whyLabel = (expanded) => (expanded ? 'Скрыть разбор' : 'Показать разбор');

  function isPanelCurrent(generation, panelNonce, panel = null) {
    return generation === panelGeneration && panelNonce === activePanelNonce &&
      (!panel || panel.isConnected);
  }

  function buildPanel(payload, generation, panelNonce) {
    cancelActiveDrag();
    const questions = Array.isArray(payload?.questions) ? payload.questions : [];
    // Keep the exact page identity beside the answers. Per-question re-solves
    // cross an AI/network await, so their reply must be checked against this
    // capture again before it can replace any visible answer text.
    lastPayload = {
      questions,
      capture: payload?.capture || null,
      panelNonce,
      generation,
    };
    shadow.innerHTML = `
      <style>
        ${fontFaceCss()}
        /* The host is a 0×0 anchor; the panel inside positions itself fixed. */
        :host {
          all: initial;
          position: fixed;
          inset: 0 auto auto 0;
          width: 0;
          height: 0;
          z-index: 2147483647;
          pointer-events: none;
        }
        :host, * { box-sizing: border-box; }

        /* Brand tokens — mirror src/common/theme.css, toggled live via
           .panel[data-theme]. Defaults to dark so the panel never flashes
           unstyled before the preference resolves. */
        .panel[data-theme="dark"] {
          --p-bg: rgba(36, 51, 49, 0.97);
          --p-text: #e8e4d8;
          --p-border: rgba(255, 255, 255, 0.10);
          --p-shadow: 0 18px 50px -12px rgba(0, 0, 0, 0.75);
          --p-titlebar: #1b2827;
          --p-muted: #8a948f;
          --p-accent: #4fd1c5;
          --p-btn-border: rgba(255, 255, 255, 0.18);
          --p-btn-hover: rgba(255, 255, 255, 0.06);
          --p-btn-active: rgba(255, 255, 255, 0.12);
          --p-li-border: rgba(255, 255, 255, 0.09);
          --p-q: #a6b0ad;
          --p-answer: #5bd07a;
          --p-arrow: #8a948f;
          --p-warn: #e8b05a;
          --p-danger: #ff6b5e;
        }
        .panel[data-theme="light"] {
          --p-bg: rgba(255, 255, 255, 0.97);
          --p-text: #2a2620;
          --p-border: rgba(42, 38, 32, 0.12);
          --p-shadow: 0 12px 40px -8px rgba(40, 33, 20, 0.22);
          --p-titlebar: #efece3;
          --p-muted: #756d5e;
          --p-accent: #1f8f8b;
          --p-btn-border: rgba(42, 38, 32, 0.18);
          --p-btn-hover: rgba(42, 38, 32, 0.05);
          --p-btn-active: rgba(42, 38, 32, 0.09);
          --p-li-border: rgba(42, 38, 32, 0.10);
          --p-q: #6b6354;
          --p-answer: #198049;
          --p-arrow: #9a917f;
          --p-warn: #b5751a;
          --p-danger: #c7382e;
        }

        .panel {
          position: fixed;
          width: min(${DEFAULT_W}px, calc(100vw - 24px));
          max-height: 70vh;
          background: var(--p-bg);
          color: var(--p-text);
          /* Single shadow stack carries both the hairline edge and the
             elevation — no separate 1px border (avoids the ghost-card pair). */
          border: none;
          border-radius: 16px;
          box-shadow: 0 0 0 1px var(--p-border), var(--p-shadow);
          font-family: "SmeshManrope", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          display: flex;
          flex-direction: column;
          pointer-events: auto;
          overflow: hidden;
        }
        .titlebar {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 9px 10px 9px 13px;
          cursor: grab;
          background: var(--p-titlebar);
          border-bottom: 1px solid var(--p-li-border);
          user-select: none;
        }
        .titlebar.dragging { cursor: grabbing; }
        .title {
          flex: 1;
          /* The titlebar now carries five controls; the title yields first
             rather than pushing the chevron off the edge on a narrow zoom. */
          min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-family: "SmeshUnbounded", "SmeshManrope", -apple-system, sans-serif;
          font-weight: 700; font-size: 12.5px; letter-spacing: -0.2px;
          color: var(--p-text);
        }
        .count { color: var(--p-muted); font-weight: 500; font-family: "SmeshManrope", sans-serif; margin-left: 4px; }
        button {
          background: transparent;
          color: inherit;
          border: 1px solid var(--p-btn-border);
          border-radius: 8px;
          padding: 4px 8px;
          font-family: "SmeshManrope", -apple-system, sans-serif;
          font-size: 12px;
          font-weight: 600;
          line-height: 1;
          cursor: pointer;
          min-width: 26px;
          transition: background 0.15s cubic-bezier(0.22, 0.61, 0.36, 1), border-color 0.15s ease, color 0.15s ease;
        }
        /* :not(:disabled) rather than a later override, so a down control keeps
           its own colour instead of flickering to the hover border. */
        button:hover:not(:disabled) { background: var(--p-btn-hover); border-color: var(--p-arrow); }
        button:active:not(:disabled) { background: var(--p-btn-active); }
        /* Permanently retired by context loss — distinct from the ordinary
           disabled state a fill sets for its own duration, which should keep looking
           like the button you just pressed. Matches the pill's button[disabled]
           treatment. Pointer events stay on, so the title still explains why. */
        button.retired { opacity: 0.5; cursor: default; }
        button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--p-accent); }
        /* Primary action: fill the form. Tinted to the brand accent. */
        .btn-fill { color: var(--p-accent); border-color: var(--p-accent); }
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
          display: flex;
          align-items: baseline;
          gap: 8px;
          padding: 6px 0;
          line-height: 1.45;
          border-bottom: 1px solid var(--p-li-border);
        }
        li:last-child { border-bottom: none; }
        /* Holds num + question + answer; the re-solve button sits to its right. */
        .qline { flex: 1; min-width: 0; }
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

        /* «Разбор» — the model's one-sentence reason for each answer, folded
           away behind the titlebar chevron. Indented to 26px so it hangs under
           the question text rather than the number, matching .long-think-note.
           Quiet by construction: secondary colour and smaller than the answer. */
        .why {
          display: none;
          margin: 5px 0 1px 26px;
          /* --p-q, not --p-muted: this is prose meant to be read, and the muted
             token lands at ~4.2:1 on the dark card at this size. The question
             colour is the panel's existing secondary-text token and clears AA
             in both themes. */
          color: var(--p-q);
          font-size: 11.5px;
          line-height: 1.45;
        }
        .panel.explain .why { display: block; }
        /* While its answer is being re-solved the sentence still argues for the
           old one, so it fades with the «…» rather than reading as current. */
        .a.resolving ~ .why { opacity: 0.4; }
        /* The chevron itself: quiet like the other titlebar buttons, tinted to
           the accent while open so the expanded state is readable at a glance. */
        .btn-why {
          display: inline-flex; align-items: center; justify-content: center;
          padding: 5px 7px;
        }
        .btn-why svg { display: block; transition: transform 0.18s cubic-bezier(0.22, 0.61, 0.36, 1); }
        .panel.explain .btn-why { color: var(--p-accent); border-color: var(--p-accent); }
        .panel.explain .btn-why svg { transform: rotate(180deg); }
        .ai-note {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
          margin-top: 8px;
          padding-top: 9px;
          border-top: 1px solid var(--p-li-border);
          color: var(--p-muted);
          font-size: 11.5px;
          line-height: 1.35;
        }
        .ai-note .dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--p-accent);
          opacity: 0.85;
          flex: none;
        }
        .ai-note a {
          color: #2563eb;
          text-decoration: none;
          font-weight: 700;
        }
        .panel[data-theme="dark"] .ai-note a { color: #60a5fa; }
        .ai-note a:hover { text-decoration: underline; }
        /* Why «Заполнить» and «перерешать» went dead: the extension was replaced
           under this page and only a reload can reconnect them. */
        .ctx-note { color: var(--p-warn); }
        .panel.minimized .body { display: none; }
        .panel.minimized { max-height: none; }
        .copied { color: var(--p-answer); border-color: var(--p-answer); }
        .failed { color: var(--p-danger); border-color: var(--p-danger); }
        .btn-fill { font-weight: 600; }
        /* Per-line fill markers, set after "Заполнить" runs. */
        .mark { font-variant-numeric: tabular-nums; margin-right: 4px; }
        .mark.ok { color: var(--p-answer); }
        .mark.warn { color: var(--p-warn); }
        /* Per-line «перерешать» (↻). Quiet by default, lights up on row hover. */
        .btn-resolve {
          flex: none;
          min-width: 0;
          padding: 2px 6px;
          font-size: 13px;
          border-color: transparent;
          color: var(--p-muted);
          opacity: 0.45;
          transition: opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.4s ease;
        }
        li:hover .btn-resolve { opacity: 0.9; }
        /* Not while disabled: a ↻ that lights up teal under the cursor reads as
           ready, whether it is mid-resolve or retired for good. */
        .btn-resolve:hover:not(:disabled) { color: var(--p-accent); border-color: var(--p-accent); opacity: 1; }
        .btn-resolve:disabled { cursor: default; }
        .btn-resolve.spinning { opacity: 1; color: var(--p-accent); animation: smesh-resolve-spin 0.7s linear infinite; }
        .btn-resolve.failed { color: var(--p-danger); border-color: var(--p-danger); opacity: 1; }
        /* The answer slot while its question is being re-solved. */
        .a.resolving { color: var(--p-muted); font-style: italic; }
        .long-think-note {
          display: inline-flex; align-items: center; gap: 5px;
          max-width: 100%; margin: 6px 0 0 26px; padding: 4px 7px;
          color: var(--p-accent); background: var(--p-btn-hover);
          border: 1px solid var(--p-btn-border); border-radius: 999px;
          font-size: 10.5px; font-weight: 650; line-height: 1.3;
        }
        .long-think-note[hidden] { display: none; }
        .long-think-note::before {
          content: ''; flex: none; width: 4px; height: 4px;
          border-radius: 50%; background: currentColor; opacity: 0.8;
        }
        @keyframes smesh-resolve-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          button { transition: none; }
          .btn-why svg { transition: none; }
          .btn-resolve.spinning { animation-duration: 1.6s; }
        }
        @media (pointer: coarse) {
          .titlebar button, .btn-resolve { min-width: 44px; min-height: 44px; }
          .btn-resolve { opacity: 0.75; }
        }
        @media (max-width: 380px) {
          .title { display: none; }
          .titlebar { gap: 4px; padding: 6px; }
          .btn-fill { flex: 1; }
        }
      </style>
      <div class="panel${state.minimized ? ' minimized' : ''}${questions.length && state.explain ? ' explain' : ''}" data-theme="${resolveTheme()}">
        <div class="titlebar" data-drag>
          <div class="title">Ответы на тест<span class="count"> · ${questions.length}</span></div>
          <button class="btn-fill" title="Заполнить форму теста ответами" aria-label="Заполнить">Заполнить</button>
          <button class="btn-copy" title="Скопировать все ответы" aria-label="Скопировать">Copy</button>
          ${questions.length
            ? `<button class="btn-why" type="button" title="${whyTitle(state.explain)}"` +
              ` aria-label="${whyLabel(state.explain)}" aria-expanded="${state.explain ? 'true' : 'false'}"` +
              ' aria-controls="smesh-answer-list">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
              'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<polyline points="6 9 12 15 18 9"/></svg></button>'
            : ''}
          <button class="btn-toggle" title="Свернуть / развернуть" aria-label="Свернуть">${state.minimized ? '▢' : '–'}</button>
          <button class="btn-close" title="Закрыть" aria-label="Закрыть">×</button>
        </div>
        <div class="body">
          ${questions.length
            ? `<ol id="smesh-answer-list">${questions.map(questionLine).join('')}</ol>`
            : '<div class="empty">Ответы не распознаны.</div>'}
          <div class="ai-note">
            <span class="dot" aria-hidden="true"></span>
            <span>Это ИИ: ответы могут быть неточными. Проверяйте источники.</span>
            <a href="${AI_NOTICE_URL}" target="_blank" rel="noopener noreferrer">Подробнее</a>
          </div>
        </div>
      </div>
    `;

    const panel = shadow.querySelector('.panel');
    positionPanel(panel);
    wireDrag(panel);
    wireButtons(panel, questions, generation, panelNonce);
  }

  function positionPanel(panel) {
    if (state.x != null && state.y != null) {
      const panelWidth = panel.offsetWidth || Math.min(DEFAULT_W, Math.max(0, innerWidth - 24));
      panel.style.left = clamp(state.x, 0, Math.max(0, innerWidth - panelWidth)) + 'px';
      panel.style.top = clamp(state.y, 0, Math.max(0, innerHeight - 50)) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    } else {
      panel.style.right = '12px';
      panel.style.bottom = '12px';
    }
  }

  function wireDrag(panel) {
    const bar = panel.querySelector('[data-drag]');
    let startX = 0, startY = 0, panelX = 0, panelY = 0;
    let dragging = false;

    // The global mousemove/mouseup listeners exist ONLY for the duration of an
    // active drag, then remove themselves. Earlier they were attached to window
    // on every wireDrag() call and never removed — each panel rebuild (every
    // test solve, every page of a multi-page run) leaked another pair, piling up
    // dozens of dead listeners that pinned detached panel DOM in memory.
    const onMove = (e) => {
      if (!dragging || !panel.isConnected) {
        cleanup(false);
        return;
      }
      const w = panel.offsetWidth;
      const x = clamp(panelX + (e.clientX - startX), 0, Math.max(0, innerWidth - w));
      const y = clamp(panelY + (e.clientY - startY), 0, Math.max(0, innerHeight - 40));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    };
    const cleanup = (persist = false) => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('blur', onBlur, true);
      bar.classList.remove('dragging');
      if (activeDragCleanup === cleanup) activeDragCleanup = null;
      if (persist && panel.isConnected) {
        state.x = parseFloat(panel.style.left) || 0;
        state.y = parseFloat(panel.style.top) || 0;
        saveState();
      }
    };
    const onUp = () => cleanup(true);
    // Mouseup may be lost when the pointer leaves the browser. Window blur ends
    // the gesture and safely preserves only a still-connected current panel.
    const onBlur = () => cleanup(true);

    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;
      if (activeDragCleanup) activeDragCleanup(false);
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
      activeDragCleanup = cleanup;
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('blur', onBlur, true);
      e.preventDefault();
    });
  }

  function cancelActiveDrag() {
    if (activeDragCleanup) activeDragCleanup(false);
  }

  // Paint the ✓ / ⚠ markers from a fill summary onto the matching lines.
  function markFillResults(summary, generation, panelNonce) {
    if (!shadow || !isPanelCurrent(generation, panelNonce)) return;
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

  // Set the ✓ / ⚠ marker on ONE line only (after a single-question re-fill),
  // without touching the other lines' markers the way markFillResults would.
  function markOneLine(qid, kind, generation, panelNonce) {
    if (!shadow || !isPanelCurrent(generation, panelNonce)) return;
    const li = [...shadow.querySelectorAll('li[data-qid]')]
      .find((el) => el.getAttribute('data-qid') === String(qid));
    if (!li) return;
    let mark = li.querySelector('.mark');
    if (!mark) {
      mark = document.createElement('span');
      mark.className = 'mark';
      li.insertBefore(mark, li.firstChild);
    }
    if (kind === 'ok') { mark.className = 'mark ok'; mark.textContent = '✓ '; }
    else if (kind === 'warn') { mark.className = 'mark warn'; mark.textContent = '⚠ '; }
  }

  /**
   * Retire the worker-backed controls after the extension went away, and say
   * why. Idempotent, and safe to call on a panel that has since been replaced.
   *
   * The reason goes in a note row of its own rather than into the existing
   * «Это ИИ» disclaimer: that line is a standing notice, not a status area, and
   * overwriting it would quietly drop it for the rest of the session.
   */
  function noteContextLoss() {
    if (contextLost) return;
    contextLost = true;
    if (!shadow) return;
    const fill = shadow.querySelector('.btn-fill');
    if (fill) {
      fill.disabled = true;
      fill.classList.remove('copied', 'failed');
      fill.classList.add('retired');
      // Shorter than «Заполнить», so no titlebar can be pushed out of shape.
      fill.textContent = 'Обновите';
      fill.title = CONTEXT_LOST_NOTE;
    }
    shadow.querySelectorAll('.btn-resolve').forEach((b) => {
      b.disabled = true;
      b.classList.remove('spinning', 'failed');
      b.classList.add('retired');
      b.title = CONTEXT_LOST_NOTE;
    });
    const body = shadow.querySelector('.body');
    if (!body) return;
    const note = document.createElement('div');
    note.className = 'ai-note ctx-note';
    note.textContent = CONTEXT_LOST_NOTE;
    body.appendChild(note);
  }

  // Fill the test form. The form often lives inside an iframe (Mesh embeds some
  // test players), which the panel's own frame can't reach — so ask the service
  // worker to run the fill in EVERY frame of the tab and merge the result. Do
  // not fall back to a local fill: only the worker can revalidate that these
  // answers still belong to the captured URL/document/question signature.
  async function requestFill(qs, panelNonce) {
    const resp = await sendMsg(
      'FILL_ANSWERS_ALL',
      { questions: qs, panelNonce },
      FILL_TIMEOUT_MS,
      panelNonce,
    );
    return (resp?.ok && resp.summary) ? resp.summary : null;
  }

  // The trusted click is checked at the handler. The worker separately requires
  // a short-lived, single-use capability tied to this tab and exact action.
  function requestActionToken(action, panelNonce) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const t = setTimeout(() => finish({ ok: false, error: 'timeout' }), 5000);
      try {
        chrome.runtime.sendMessage({ type: 'GET_ACTION_TOKEN', action, panelNonce }, (r) => {
          clearTimeout(t);
          if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
          else finish(r || { ok: false, error: 'no response' });
        });
      } catch (e) { clearTimeout(t); finish({ ok: false, error: String(e) }); }
    });
  }

  // Promise-wrapped privileged sendMessage with a hard timeout so a recycled
  // service worker (dropped reply) never leaves a line spinning forever.
  async function sendMsg(type, payload, timeoutMs, panelNonce) {
    const grant = await requestActionToken(type, panelNonce);
    if (!grant?.ok || !grant.token) return grant || { ok: false, error: 'no action token' };
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const t = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
      try {
        chrome.runtime.sendMessage({ type, token: grant.token, payload }, (r) => {
          clearTimeout(t);
          if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
          else finish(r || { ok: false, error: 'no response' });
        });
      } catch (e) { clearTimeout(t); finish({ ok: false, error: String(e) }); }
    });
  }

  // «Перерешать этот вопрос»: re-ask one question, drop the fresh answer into
  // the line, then push just that answer into the form and re-mark the line.
  // The page is the source of truth, so the worker re-captures it server-side.
  async function resolveOne(btn, generation, panelNonce) {
    if (btn.disabled || !isPanelCurrent(generation, panelNonce)) return;
    const li = btn.closest('li');
    const aEl = li && li.querySelector('.a');
    const qid = li && li.getAttribute('data-qid');
    const i = Number(btn.dataset.qi);
    const qs = (lastPayload && lastPayload.generation === generation &&
      lastPayload.panelNonce === panelNonce && lastPayload.questions) || [];
    const q = qs[i];
    if (!q || !aEl) return;
    const expectedCapture = lastPayload?.capture || null;
    if (!captureStillMatches(expectedCapture)) {
      hide(panelNonce, generation);
      return;
    }

    const prev = q.answer ?? '';
    btn.disabled = true;
    btn.classList.add('spinning');
    btn.classList.remove('failed');
    aEl.classList.add('resolving');
    const prevText = aEl.textContent;
    aEl.textContent = '…';

    const longNotice = li.querySelector('.long-think-note');
    if (longNotice) longNotice.hidden = true;
    const longNoticeTimer = globalThis.setTimeout?.(() => {
      if (longNotice && isPanelCurrent(generation, panelNonce, li) && li.isConnected) {
        longNotice.hidden = false;
      }
    }, 30000);

    const r = await sendMsg('RESOLVE_QUESTION', {
      index: q.index != null ? q.index : i + 1,
      prevAnswer: prev,
      questionText: q.text || '',
      panelNonce,
    }, 130000, panelNonce);
    if (longNoticeTimer != null) globalThis.clearTimeout?.(longNoticeTimer);
    if (longNotice) longNotice.hidden = true;

    // The worker validates after AI completion, but the same-document player
    // can switch question/account between that read and message delivery. Do
    // not even restore/update the stale line: remove the obsolete panel and let
    // the user solve the newly captured page explicitly.
    if (!isPanelCurrent(generation, panelNonce, btn) ||
        !captureStillMatches(expectedCapture)) {
      hide(panelNonce, generation);
      return;
    }

    if (!r || !r.ok || !r.answer) {
      btn.classList.remove('spinning');
      btn.disabled = false;
      aEl.classList.remove('resolving');
      aEl.textContent = prevText; // restore the prior answer
      // Same rule as the fill button: an extension that is gone will not come
      // back for a retry, so retire the control instead of flashing it red.
      if (!contextAlive()) { noteContextLoss(); return; }
      btn.classList.add('failed');
      setTimeout(() => {
        if (isPanelCurrent(generation, panelNonce, btn)) btn.classList.remove('failed');
      }, 1500);
      return;
    }

    // Carry fresh per-field values for a multi-box question (x & y, x₁ & x₂) so
    // the re-fill below spreads them across every box, not just the first. The
    // worker returns null `parts` for single-box questions — clear stale ones then.
    const nextQuestion = { ...q, answer: r.answer };
    if ('parts' in r) nextQuestion.parts = r.parts || undefined;
    // Same rule for the «разбор»: the sentence must belong to the answer above
    // it, so a re-solve that returned none clears the one that explained the
    // answer the student just rejected.
    if ('explain' in r) {
      if (r.explain) nextQuestion.explain = r.explain;
      else delete nextQuestion.explain;
    }
    // Best-effort: push only this answer into the form and re-mark the line.
    // Pin `index` to the line's qid so scraper.js targets this exact question
    // by number/position — identical to the full-page fill — even when the
    // model returned no number of its own (qid then falls back to i+1).
    let summary = null;
    try {
      summary = await requestFill([{ ...nextQuestion, index: qid }], panelNonce);
    } catch { /* the capture check below still owns the post-await boundary */ }
    if (!isPanelCurrent(generation, panelNonce, btn)) return;
    // The worker validates immediately around the form mutation, but the
    // same-document player can switch again while its reply crosses back to
    // this content script. Revalidate even when requestFill rejects: otherwise
    // a transport failure could skip this guard and leave the old answer
    // readable on the replacement page.
    if (!captureStillMatches(expectedCapture)) {
      hide(panelNonce, generation);
      return;
    }
    // Publish the fresh answer only after the refill await and final capture
    // check. Until here the line remains «…», so an account/question switch
    // during a slow fill never gets a window in which it can display old-page
    // answer text before teardown.
    q.answer = nextQuestion.answer;
    if ('parts' in r) q.parts = nextQuestion.parts;
    if ('explain' in r) {
      if (nextQuestion.explain) q.explain = nextQuestion.explain;
      else delete q.explain;
      const whyEl = li.querySelector('.why');
      if (whyEl) whyEl.textContent = explanationText(nextQuestion);
    }
    aEl.textContent = nextQuestion.answer;
    aEl.classList.remove('resolving');
    btn.classList.remove('spinning');
    btn.disabled = false;
    const filled = new Set((summary?.filled || []).map(String));
    markOneLine(
      qid,
      filled.has(String(qid)) ? 'ok' : 'warn',
      generation,
      panelNonce,
    );
  }

  function wireButtons(panel, questions, generation, panelNonce) {
    const closeBtn = panel.querySelector('.btn-close');
    const toggleBtn = panel.querySelector('.btn-toggle');
    const copyBtn = panel.querySelector('.btn-copy');
    const fillBtn = panel.querySelector('.btn-fill');

    panel.querySelectorAll('.btn-resolve').forEach((b) => {
      b.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        resolveOne(b, generation, panelNonce);
      });
    });

    closeBtn.addEventListener('click', () => hide(panelNonce, generation));

    fillBtn.addEventListener('click', async (event) => {
      if (!event.isTrusted || !isPanelCurrent(generation, panelNonce, panel)) return;
      const payload = lastPayload && lastPayload.generation === generation &&
        lastPayload.panelNonce === panelNonce ? lastPayload : null;
      const qs = payload?.questions || questions || [];
      const expectedCapture = payload?.capture || null;
      const orig = fillBtn.textContent;
      fillBtn.disabled = true;
      let summary = null;
      try {
        summary = await requestFill(qs, panelNonce);
      } catch { summary = null; }
      if (!isPanelCurrent(generation, panelNonce, panel)) return;
      if (!captureStillMatches(expectedCapture)) {
        hide(panelNonce, generation);
        return;
      }
      fillBtn.disabled = false;
      if (!summary) {
        // A dead extension context is not a transient error: restoring the
        // button after 1.6s would only invite the identical failure again.
        if (!contextAlive()) { noteContextLoss(); return; }
        fillBtn.textContent = 'Ошибка';
        fillBtn.classList.add('failed');
        setTimeout(() => {
          if (!isPanelCurrent(generation, panelNonce, panel)) return;
          fillBtn.textContent = orig;
          fillBtn.classList.remove('failed');
        }, 1600);
        return;
      }
      markFillResults(summary, generation, panelNonce);
      const n = (summary.filled || []).length;
      fillBtn.textContent = `✓ ${n}`;
      fillBtn.classList.add('copied');
      setTimeout(() => {
        if (!isPanelCurrent(generation, panelNonce, panel)) return;
        fillBtn.textContent = orig;
        fillBtn.classList.remove('copied');
      }, 1600);
    });

    // «Разбор»: one chevron unfolds every question's explanation at once. Pure
    // presentation — the sentences are already here, so this costs no call and
    // needs no capture revalidation beyond the usual panel-currency check.
    const whyBtn = panel.querySelector('.btn-why');
    if (whyBtn) {
      whyBtn.addEventListener('click', () => {
        if (!isPanelCurrent(generation, panelNonce, panel)) return;
        state.explain = !state.explain;
        panel.classList.toggle('explain', state.explain);
        whyBtn.setAttribute('aria-expanded', state.explain ? 'true' : 'false');
        whyBtn.title = whyTitle(state.explain);
        whyBtn.setAttribute('aria-label', whyLabel(state.explain));
        saveState();
      });
    }

    toggleBtn.addEventListener('click', () => {
      if (!isPanelCurrent(generation, panelNonce, panel)) return;
      state.minimized = !state.minimized;
      panel.classList.toggle('minimized', state.minimized);
      toggleBtn.textContent = state.minimized ? '▢' : '–';
      saveState();
    });

    copyBtn.addEventListener('click', async () => {
      if (!isPanelCurrent(generation, panelNonce, panel)) return;
      const payload = lastPayload && lastPayload.generation === generation &&
        lastPayload.panelNonce === panelNonce ? lastPayload : null;
      const expectedCapture = payload?.capture || null;
      if (!captureStillMatches(expectedCapture)) {
        hide(panelNonce, generation);
        return;
      }
      const txt = questions.map((q, i) => {
        const n = q.index != null ? q.index : i + 1;
        const t = (q.text || '').trim();
        return t ? `${n}. ${t} → ${q.answer ?? ''}` : `№${n}: ${q.answer ?? ''}`;
      }).join('\n');
      try {
        await navigator.clipboard.writeText(txt);
        if (!isPanelCurrent(generation, panelNonce, panel)) return;
        if (!captureStillMatches(expectedCapture)) {
          hide(panelNonce, generation);
          return;
        }
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          if (!isPanelCurrent(generation, panelNonce, panel)) return;
          copyBtn.textContent = orig;
          copyBtn.classList.remove('copied');
        }, 1200);
      } catch { /* clipboard blocked; nothing graceful to do here */ }
    });
  }

  function captureStillMatches(expected) {
    if (!expected || typeof expected !== 'object') return false;
    const currentUrl = typeof window.location?.href === 'string' ? window.location.href : '';
    const pageId = window.__smeshCaptureDocumentId;
    const signature = typeof window.__smeshPageSig === 'function' ? window.__smeshPageSig() : '';
    const principal = typeof window.__smeshCurrentPrincipal === 'function'
      ? window.__smeshCurrentPrincipal() : '';
    return currentUrl === expected.url && pageId === expected.pageId &&
      signature === expected.signature && principal === expected.principal;
  }

  function validateActivePanelCapture() {
    const payload = lastPayload;
    if (!hostEl || !payload?.capture) return;
    const generation = payload.generation;
    const panelNonce = payload.panelNonce;
    if (!isPanelCurrent(generation, panelNonce) || captureStillMatches(payload.capture)) return;
    hide(panelNonce, generation);
  }

  function scheduleActivePanelCaptureCheck() {
    if (!hostEl || !lastPayload || captureCheckTimer != null) return;
    // Throttle noisy framework mutation bursts while still checking throughout
    // continuous SPA rendering instead of postponing forever on every change.
    captureCheckTimer = setTimeout(() => {
      captureCheckTimer = null;
      validateActivePanelCapture();
    }, 100);
  }

  async function show(payload) {
    const panelNonce = payload?.panelNonce;
    if (typeof panelNonce !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(panelNonce)) {
      throw new Error('invalid answer-panel capability');
    }
    // Invalidate every handler and continuation belonging to the previous
    // panel before the first asynchronous storage read. Remove its presentation
    // at the same boundary: action capabilities alone do not stop old answer
    // text being readable while loadState()/loadTheme() is stalled.
    cancelActiveDrag();
    const generation = ++panelGeneration;
    activePanelNonce = panelNonce;
    lastPayload = null;
    if (hostEl) { hostEl.remove(); hostEl = null; shadow = null; }
    const expected = payload?.capture;
    if (!captureStillMatches(expected)) throw new Error('captured test page changed');
    await Promise.all([loadState(), loadTheme()]);
    if (!isPanelCurrent(generation, panelNonce) || !captureStillMatches(expected)) {
      throw new Error('captured test page changed');
    }
    ensureHost();
    if (!isPanelCurrent(generation, panelNonce)) throw new Error('answer panel replaced');
    buildPanel(payload, generation, panelNonce);
  }

  function hide(expectedNonce = null, expectedGeneration = null) {
    if (expectedNonce != null && expectedNonce !== activePanelNonce) return false;
    if (expectedGeneration != null && expectedGeneration !== panelGeneration) return false;
    cancelActiveDrag();
    if (captureCheckTimer != null) clearTimeout(captureCheckTimer);
    captureCheckTimer = null;
    panelGeneration += 1;
    activePanelNonce = '';
    lastPayload = null;
    if (hostEl) { hostEl.remove(); hostEl = null; shadow = null; }
    return true;
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
      if (area === 'session' && changes.theme) {
        themePref = changes.theme.newValue || 'system';
        applyTheme();
      }
    });
  } catch { /* storage events unavailable in this context */ }

  // When the preference is 'system', follow the OS scheme as it flips.
  darkMedia.addEventListener('change', () => { if (themePref === 'system') applyTheme(); });

  // Same-document Mesh navigation does not fire pagehide. Observe question and
  // account DOM changes, route events, and a low-frequency fallback for
  // identity changes sourced only from storage/cookies. All paths validate the
  // exact generation/capture before removing anything.
  let captureObserver = null;
  let capturePoll = null;
  let captureWatchersArmed = false;

  function armActivePanelCaptureWatchers() {
    if (captureWatchersArmed) return;
    captureWatchersArmed = true;
    try {
      if (!captureObserver) captureObserver = new MutationObserver(scheduleActivePanelCaptureCheck);
      captureObserver.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      // A failed observer must be constructible again on a later pageshow. The
      // interval remains an independent fallback in environments without one.
      captureObserver = null;
    }
    if (capturePoll == null) capturePoll = setInterval(scheduleActivePanelCaptureCheck, 1000);
  }

  function disarmActivePanelCaptureWatchers() {
    if (!captureWatchersArmed && capturePoll == null) return;
    captureWatchersArmed = false;
    try { captureObserver?.disconnect(); } catch { /* already detached */ }
    if (capturePoll != null) clearInterval(capturePoll);
    capturePoll = null;
  }

  armActivePanelCaptureWatchers();
  window.addEventListener('popstate', scheduleActivePanelCaptureCheck);
  window.addEventListener('hashchange', scheduleActivePanelCaptureCheck);

  window.addEventListener('pagehide', () => {
    disarmActivePanelCaptureWatchers();
    hide();
  });
  // A page restored from the back-forward cache reuses this exact isolated
  // world. Re-arm once; repeated pageshow events must not duplicate observers
  // or polling intervals.
  window.addEventListener('pageshow', armActivePanelCaptureWatchers);
})();

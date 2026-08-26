/**
 * Floating "Solve" pill for МЭШ TEST pages.
 *
 * A small, discreet, draggable pill injected directly onto a test page so the
 * student can solve without opening the toolbar popup. It reproduces BOTH of the
 * popup's «Тест» actions — «Решить» (this page) and «все страницы» (multi-page
 * autopilot) — but triggers them from the page.
 *
 * Architecture (this matters): the pill is a content script, so it CANNOT
 * screenshot the tab or call chrome.scripting. It just sends ONE message to the
 * service worker (PILL_SOLVE_PAGE / PILL_SOLVE_ALL) and shows a live status; the
 * worker runs the whole capture → solve → fill (+ pagination) loop and renders
 * the results through the existing floating answer panel (answer-panel.js).
 *
 * Modeled on answer-panel.js: closed Shadow DOM (CSS + DOM isolation), draggable,
 * position persisted to chrome.storage.session, live theme sync, idempotent
 * injection, z-index 2147483647, brand fonts + tokens.
 *
 * INJECTION SCOPE — declared as a content script in manifest.json. Tests live on
 * two hosts, so the match list there covers both (top frame only):
 *   • https://uchebnik.mos.ru/exam/challenge/…   (the test IS the top frame)
 *   • https://school.mos.ru/<course>/cwork?…     (test runs in a uchebnik iframe)
 *   • https://school.mos.ru/dt/<block>/<subj>/go?subcategory_id=…  («Цифровой
 *     учитель» / Фундаментальные науки — the task renders INLINE, no xAPI iframe,
 *     so only the route identifies it)
 * The first two carry an xAPI launch signature (activityId + lrs endpoint +
 * registration); the /dt tasks are detected by route alone.
 * The user picked "show only on detected tests", so looksLikeTest() below gates
 * whether the pill actually appears. The manifest match list already covers
 * school.mos.ru/* (minus /diary), so a new test URL shape usually needs only a
 * looksLikeTest() edit — touch the manifest too if it lands on a new host.
 */
(() => {
  if (window.__smeshPill) return;

  // Namespaced diagnostics — same prefix style as scraper.js. Lets us confirm
  // the script injected and see WHY detection did/didn't fire from the page
  // console (filter on "СМЭШ AI pill"). OFF in shipped builds — flip to true to
  // trace test detection on a live МЭШ page.
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) { try { console.debug('[СМЭШ AI pill]', ...a); } catch { /* */ } } };

  /* ---------- Test-page detection (single source of truth) ---------- */
  // The manifest matches both МЭШ hosts broadly (uchebnik.mos.ru + school.mos.ru
  // minus /diary). This decides whether the CURRENT page is actually a test
  // before we show anything (stealth-first). The signals are TIERED on purpose:
  //   • STRONG (any one is enough): the documented xAPI launch signature
  //     (activityId / cwork_id / registration / scorm_id / endpoint=...lrs),
  //     a known МЭШ test route family (/exam, /challenge, /cwork,
  //     /control-work, /01math/maths/test, or a «Цифровой учитель» /dt/…/go
  //     task view), or an iframe whose src itself carries a test-player marker
  //     (activityId, /lrs, /exam, /launch, cwork).
  //   • WEAK (need TWO distinct weak hits if no strong one fired): lesson_id,
  //     generic words like /test or /training in the path, or a bare
  //     uchebnik.mos.ru iframe with no stronger marker in its src.
  // WHY the split exists: lesson_id and generic "test"/"training" words show
  // up on ordinary МЭШ lesson/library surfaces too, so the old "any one weak
  // hint shows the pill" logic produced false positives outside real tests.
  function iframeSignal() {
    try {
      let weak = false;
      for (const frame of document.querySelectorAll('iframe[src]')) {
        const src = frame.getAttribute('src') || '';
        if (!src) continue;
        if (/[?&]activityId=/i.test(src) || /\/(lrs|exam|launch)(\/|$|\?)/i.test(src) || /cwork/i.test(src)) {
          return 'strong';
        }
        if (/uchebnik\.mos\.ru/i.test(src)) weak = true;
      }
      if (weak) return 'weak';
    } catch { /* no iframe access / malformed DOM — treat as absent */ }
    return '';
  }
  function looksLikeTest() {
    const { pathname, search } = location;
    const iframe = iframeSignal();
    const strongQuery = /[?&](activityId|cwork_id|registration|scorm_id)=/i.test(search) || /[?&]endpoint=[^&]*lrs/i.test(search);
    // «Цифровой учитель» task views render the task INLINE (no xAPI iframe), so
    // only the route identifies them. Two shapes seen in the wild:
    //   /01math/maths/test?subcategory_id=…            (older)
    //   /dt/<block>/<subject>/go?subcategory_id=…      (Фундаментальные науки, 2026)
    // Require a /go task segment OR a subcategory_id so the /dt catalog/landing
    // pages (which carry neither) stay quiet — same false-positive discipline as
    // the weak tier below.
    const dtTaskRoute = /^\/dt(?:\/|$)/i.test(pathname) &&
      (/\/go(?:\/|$)/i.test(pathname) || /[?&]subcategory_id=/i.test(search));
    const strongPath = /\/(exam|challenge|cwork|control[-_]?work)(\/|$|\?)/i.test(pathname) ||
      /^\/01math\/maths\/test(?:\/|$)/i.test(pathname) ||
      dtTaskRoute;
    if (strongQuery || strongPath || iframe === 'strong') {
      log('test detect strong', { pathname, search, iframe });
      return true;
    }

    let weakHits = 0;
    if (/[?&]lesson_id=/i.test(search)) weakHits += 1;
    if (/\/(test|testing|training|diagnostic|quiz)(\/|$|\?)/i.test(pathname)) weakHits += 1;
    if (iframe === 'weak') weakHits += 1;
    log('test detect weak', { pathname, search, iframe, weakHits });
    return weakHits >= 2;
  }

  const STORAGE_KEY = 'smeshTestPill2'; // bumped: reset stale positions to the new top-right default
  // Mark loaded immediately so a re-inject is a no-op even if the page isn't a
  // test yet (SPA route may turn into one — see the URL watcher at the bottom).
  let built = false;
  let dismissed = false; // user pressed Esc / × — don't auto-rebuild on the same page
  let hostEl = null;
  let shadow = null;
  let state = { x: null, y: null };
  let busy = false;
  let runGen = 0;
  let thinker = null;
  let activeDragCleanup = null;

  let themePref = 'system';
  // Active AI provider. The tiny GRQ/OPR/QWN/DSK tag it used to paint on the
  // pill is switched off — SHOW_PROVIDER_UI mirrors lib/config.js, which a
  // classic content script can't import; keep the two in sync. providerId is
  // still tracked either way: it rides the SOLVE payload as `provider`.
  const SHOW_PROVIDER_UI = false;
  let providerId = 'deepseek'; // mirrors config.DEFAULT_PROVIDER
  let providerAbbr = 'DSK';
  // Initial storage reads race live storage.onChanged delivery (and a completed
  // drag can race a route-triggered rebuild). Each revision makes the newest
  // local/event state authoritative over an older callback snapshot.
  let stateRevision = 0;
  let themeRevision = 0;
  let providerRevision = 0;
  const PROV_ABBR = { groq: 'GRQ', openrouter: 'OPR', qwen: 'QWN', deepseek: 'DSK' };
  function setProvider(p) {
    providerId = PROV_ABBR[p] ? p : 'deepseek';
    providerAbbr = PROV_ABBR[providerId];
  }
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const resolveTheme = () =>
    themePref === 'light' || themePref === 'dark'
      ? themePref
      : (darkMedia.matches ? 'dark' : 'light');

  // Brand fonts from the extension bundle (web_accessible_resources). Same set as
  // the answer panel so the two surfaces match.
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

  // Register the brand fonts at DOCUMENT scope. Critical: Chrome ignores
  // @font-face declared inside a shadow root (Blink bug 336876), so the shadow
  // <style> above never actually loads Unbounded/Manrope — the pill silently
  // falls back to a system sans. Fonts added to document.fonts ARE visible
  // inside the shadow DOM, so this is what makes "Решить"/"все страницы" render
  // in Unbounded. FontFace API (not an injected <style>) keeps us clear of the
  // page's CSP style-src. Idempotent + harmless if FontFace is unavailable.
  function loadBrandFonts() {
    if (window.__smeshPillFonts) return;
    let url;
    try { url = (p) => chrome.runtime.getURL('assets/fonts/' + p); }
    catch { return; }
    if (typeof FontFace === 'undefined' || !document.fonts) return;
    window.__smeshPillFonts = true;
    const CYR = 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116';
    const LAT = 'U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+2122, U+2212, U+FEFF, U+FFFD';
    const faces = [
      ['SmeshManrope', 'manrope-cyrillic.woff2', CYR, '200 800'],
      ['SmeshManrope', 'manrope-latin.woff2', LAT, '200 800'],
      ['SmeshUnbounded', 'unbounded-cyrillic.woff2', CYR, '600 800'],
      ['SmeshUnbounded', 'unbounded-latin.woff2', LAT, '600 800'],
    ];
    for (const [family, file, range, weight] of faces) {
      try {
        const ff = new FontFace(family, `url("${url(file)}") format("woff2")`,
          { weight, unicodeRange: range, display: 'swap' });
        ff.load()
          .then((loaded) => { try { document.fonts.add(loaded); } catch { /* */ } })
          .catch(() => { /* offline / blocked — fall back to the system stack */ });
      } catch { /* bad descriptor on an old engine */ }
    }
  }

  function logoUrl() {
    try { return chrome.runtime.getURL('assets/icons/logo-mark.png'); } catch { return ''; }
  }

  /* ---------- Live "thinking" status (mirrors common/thinking.js) ---------- */
  // thinking.js is an ES module (can't be imported into a classic content
  // script), so its pattern is inlined: a shifting verb + elapsed seconds, with
  // an updatable prefix so the multi-page loop can show «Страница N».
  const THINK_WORDS = [
    'Думаю', 'Решаю', 'Считаю', 'Разбираю', 'Анализирую',
    'Соображаю', 'Вникаю', 'Размышляю', 'Сверяю', 'Проверяю',
    'Читаю условие', 'Выстраиваю ход решения', 'Слежу за условием задачи',
    'Иду по шагам', 'Прикидываю план решения', 'Ищу подходящий способ',
    'Прохожу задание по порядку', 'Складываю картину', 'Уточняю детали',
    'Сверяюсь с заданием', 'Прикидываю варианты', 'Формулирую ответ'
  ];
  function startThinking(el, opts = {}) {
    const startedAt = Date.now();
    let wi = Math.floor(Math.random() * THINK_WORDS.length);
    let prefix = opts.prefix ? opts.prefix + ' · ' : '';
    let secTimer = null, wordTimer = null;
    const paint = () => {
      if (!el.isConnected) { stop(); return; }
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      el.textContent = `${prefix}${THINK_WORDS[wi]}… ${secs}s`;
    };
    const stop = () => {
      if (secTimer) clearInterval(secTimer);
      if (wordTimer) clearInterval(wordTimer);
      secTimer = wordTimer = null;
    };
    paint();
    secTimer = setInterval(paint, 1000);
    wordTimer = setInterval(() => { wi = (wi + 1) % THINK_WORDS.length; paint(); }, 2400);
    return { stop, setPrefix: (p) => { prefix = p ? p + ' · ' : ''; paint(); } };
  }

  /* ---------- State / theme persistence (chrome.storage) ---------- */
  function loadState(expectedRunGen = runGen) {
    const expectedRevision = stateRevision;
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get(STORAGE_KEY, (v) => {
          if (expectedRunGen === runGen && expectedRevision === stateRevision &&
              !chrome.runtime.lastError && v?.[STORAGE_KEY]) {
            state = { ...state, ...v[STORAGE_KEY] };
          }
          resolve();
        });
      } catch { resolve(); }
    });
  }
  function saveState() {
    stateRevision++;
    try { chrome.storage.session.set({ [STORAGE_KEY]: state }); } catch { /* session blocked */ }
  }
  function loadTheme(expectedRunGen = runGen) {
    const expectedRevision = themeRevision;
    // storage.session, not local: local is trusted-contexts-only (it holds the
    // API keys), so the worker mirrors just `theme`/`aiProvider` into session.
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get('theme', (v) => {
          if (expectedRunGen === runGen && expectedRevision === themeRevision &&
              !chrome.runtime.lastError) {
            themePref = v?.theme || 'system';
          }
          resolve();
        });
      } catch { resolve(); }
    });
  }
  function applyTheme() {
    const pill = shadow && shadow.querySelector('.pill');
    if (pill) pill.dataset.theme = resolveTheme();
  }
  function loadProvider(expectedRunGen = runGen) {
    const expectedRevision = providerRevision;
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get('aiProvider', (v) => {
          if (expectedRunGen === runGen && expectedRevision === providerRevision &&
              !chrome.runtime.lastError) {
            setProvider(v?.aiProvider);
          }
          resolve();
        });
      } catch { resolve(); }
    });
  }
  function applyProvider() {
    const el = shadow && shadow.querySelector('.prov');
    if (el) el.textContent = providerAbbr;
  }

  /* ---------- DOM ---------- */
  function ensureHost() {
    if (hostEl && document.documentElement.contains(hostEl)) return;
    hostEl = document.createElement('div');
    // No stable id and no open root: page scripts should have neither a selector
    // nor a DOM handle they can use to reach the privileged action buttons.
    shadow = hostEl.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(hostEl);
  }

  function render() {
    shadow.innerHTML = `
      <style>
        ${fontFaceCss()}
        :host {
          all: initial !important;
          position: fixed !important;
          inset: 0 auto auto 0 !important;
          width: 0 !important;
          height: 0 !important;
          z-index: 2147483647 !important;
          pointer-events: none !important;
          opacity: 1 !important;
          visibility: visible !important;
          transform: none !important;
          filter: none !important;
          clip: auto !important;
          clip-path: none !important;
        }
        :host, * { box-sizing: border-box; }

        /* Brand tokens — mirror theme.css surfaces (card + pop shadow + accent),
           toggled live via .pill[data-theme]. Default dark so it never flashes
           unstyled. Aligned 1:1 with the extension popup so the two surfaces feel
           like one product. */
        .pill[data-theme="dark"] {
          --p-bg: rgba(36, 51, 49, 0.92);
          --p-text: #e8e4d8;
          --p-border: rgba(255, 255, 255, 0.09);
          --p-shadow: 0 18px 50px -12px rgba(0, 0, 0, 0.75);
          --p-muted: #8a948f;
          --p-accent: #4fd1c5;
          --p-accent-hover: #6bdcd1;
          --p-accent-shadow: 0 2px 12px -3px rgba(79, 209, 197, 0.5);
          --p-on-accent: #0e1716;
          --p-card: #243331;
          --p-btn-border: rgba(255, 255, 255, 0.16);
          --p-btn-hover: rgba(255, 255, 255, 0.06);
          --p-danger: #ff6b5e;
          --p-sep: rgba(255, 255, 255, 0.09);
        }
        .pill[data-theme="light"] {
          --p-bg: rgba(255, 255, 255, 0.92);
          --p-text: #2a2620;
          --p-border: rgba(42, 38, 32, 0.10);
          --p-shadow: 0 12px 40px -8px rgba(40, 33, 20, 0.20);
          --p-muted: #756d5e;
          --p-accent: #1f8f8b;
          --p-accent-hover: #1a7c78;
          --p-accent-shadow: 0 2px 10px -3px rgba(31, 143, 139, 0.36);
          --p-on-accent: #fcfaf3;
          --p-card: #ffffff;
          --p-btn-border: rgba(42, 38, 32, 0.16);
          --p-btn-hover: rgba(42, 38, 32, 0.045);
          --p-danger: #c7382e;
          --p-sep: rgba(42, 38, 32, 0.10);
        }

        .pill {
          position: fixed;
          display: flex;
          align-items: center;
          gap: 9px;
          max-width: 380px;
          padding: 7px 9px 7px 11px;
          background: var(--p-bg);
          color: var(--p-text);
          /* Hairline border + soft pop shadow — the extension's card language,
             not a heavy ring. The solid teal action + logomark carry the brand. */
          border: 1px solid var(--p-border);
          border-radius: 999px;
          box-shadow: var(--p-shadow);
          font-family: "SmeshUnbounded", "SmeshManrope", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          backdrop-filter: blur(10px) saturate(1.2);
          -webkit-backdrop-filter: blur(10px) saturate(1.2);
          pointer-events: auto;
          user-select: none;
          /* The whole pill is a drag handle now (buttons opt out in wireDrag). */
          cursor: grab;
        }
        .pill.dragging { cursor: grabbing; }

        /* The brand logomark — visual anchor; the whole pill drags. */
        .grip {
          display: flex; align-items: center; justify-content: center;
          flex: none; width: 26px; height: 26px;
          border-radius: 50%;
        }
        .grip img { width: 25px; height: 25px; object-fit: contain; -webkit-user-drag: none; pointer-events: none; }
        /* Fallback "С" mark if the PNG can't be resolved on this host. */
        .grip .mark-fallback {
          width: 25px; height: 25px; border-radius: 50%;
          display: none; align-items: center; justify-content: center;
          font-family: "SmeshUnbounded", sans-serif; font-weight: 800; font-size: 13px;
          color: var(--p-on-accent); background: var(--p-accent);
        }
        .grip img.broken { display: none; }
        .grip img.broken + .mark-fallback { display: flex; }

        button {
          /* Unbounded display face on the actions — the extension's heading type,
             so the pill reads as part of the same product. */
          font-family: "SmeshUnbounded", "SmeshManrope", -apple-system, sans-serif;
          display: inline-flex; align-items: center; gap: 6px;
          background: transparent;
          color: inherit;
          border: 1px solid var(--p-btn-border);
          border-radius: 999px;
          padding: 8px 15px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: -0.01em;
          line-height: 1;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.15s var(--ease, ease), border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease, transform 0.15s ease, box-shadow 0.2s ease;
        }
        button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--p-accent); }
        button[disabled] { opacity: 0.5; cursor: default; transform: none; }
        .i { flex: none; display: block; }
        .act-page .i { width: 15px; height: 15px; }
        .act-all .i { width: 13px; height: 13px; }

        /* Primary action — SOLID teal with the accent glow, exactly like the
           popup's «Решить тест» button. */
        .act-page {
          color: var(--p-on-accent);
          background: var(--p-accent);
          border-color: var(--p-accent);
          box-shadow: var(--p-accent-shadow);
        }
        .act-page:hover:not([disabled]) { background: var(--p-accent-hover); border-color: var(--p-accent-hover); transform: translateY(-1px); }
        .act-page:active:not([disabled]) { transform: scale(0.97); }
        /* Secondary — quiet card surface with teal text, mirrors «.secbtn». */
        .act-all {
          color: var(--p-accent);
          background: var(--p-card);
          border-color: var(--p-border);
          font-size: 11px; padding: 8px 12px;
        }
        .act-all:hover:not([disabled]) { background: var(--p-btn-hover); border-color: var(--p-btn-border); }
        .act-all:active:not([disabled]) { transform: scale(0.97); }

        .close {
          flex: none; width: 26px; height: 26px; padding: 0;
          border: none; border-radius: 50%;
          color: var(--p-muted); font-size: 17px; line-height: 1;
          justify-content: center;
        }
        .close:hover { color: var(--p-danger); background: var(--p-btn-hover); }

        .actions { display: flex; align-items: center; gap: 6px; }

        /* Tiny read-only "which AI" tag (GRQ/OPR/QWN/DSK). Discreet, never clickable. */
        .prov {
          flex: none;
          font-family: "SmeshManrope", -apple-system, sans-serif;
          font-size: 9px; font-weight: 700; letter-spacing: 0.06em; line-height: 1;
          color: var(--p-muted);
          border: 1px solid var(--p-border);
          border-radius: 5px;
          padding: 3px 4px;
          pointer-events: none; user-select: none;
        }

        /* Status area replaces the actions while solving. */
        .status { display: none; align-items: center; gap: 8px; padding-right: 4px; min-width: 164px; }
        .status .stext {
          font-family: "SmeshManrope", -apple-system, sans-serif;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          color: var(--p-text);
          max-width: 240px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .status .stext.err { color: var(--p-danger); white-space: normal; }
        .pill.busy .actions { display: none; }
        .pill.busy .status { display: flex; }
        .pill.result .actions { display: none; }
        .pill.result .status { display: flex; }
        .pill.result .status .stext { color: var(--p-muted); white-space: normal; }

        .spinner {
          display: inline-block; flex: none;
          width: 14px; height: 14px;
          border: 2px solid var(--p-sep); border-top-color: var(--p-accent);
          border-radius: 50%;
          animation: smesh-pill-spin 0.7s linear infinite;
        }
        @keyframes smesh-pill-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .spinner { animation-duration: 1.6s; }
          button, .pill { transition: none; }
        }
      </style>
      <div class="pill" data-theme="${resolveTheme()}" role="group" aria-label="СМЭШ AI — решить тест" title="Перетащите за любую точку">
        <span class="grip">
          <img alt="СМЭШ AI" src="${logoUrl()}">
          <span class="mark-fallback">С</span>
        </span>
        <div class="actions">
          <button class="act-page" title="Решить и заполнить эту страницу">
            <svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 14.5l.8 2.2L22 17.5l-2.2.8L19 20.5l-.8-2.2L16 17.5l2.2-.8z"/></svg>
            <span>Решить</span>
          </button>
          <button class="act-all" title="Решить каждую страницу по очереди и переходить «Далее». Отправку не нажимаю.">
            <svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
            <span>все страницы</span>
          </button>
        </div>
        ${SHOW_PROVIDER_UI ? `<span class="prov" title="Активный ИИ-сервис">${providerAbbr}</span>` : ''}
        <div class="status" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <span class="stext"></span>
        </div>
        <button class="close" title="Скрыть (Esc)" aria-label="Скрыть">×</button>
      </div>
    `;

    const pill = shadow.querySelector('.pill');
    const img = shadow.querySelector('.grip img');
    if (img) {
      const markBroken = () => img.classList.add('broken');
      img.addEventListener('error', markBroken);
      // The error event may have already fired before this listener attached
      // (sync cache miss / empty src) — catch that case too.
      if (img.complete && img.naturalWidth === 0) markBroken();
    }
    positionPill(pill);
    wireDrag(pill);
    wireButtons(pill);
  }

  function positionPill(pill) {
    if (state.x != null && state.y != null) {
      pill.style.left = clamp(state.x, 0, Math.max(0, innerWidth - 60)) + 'px';
      pill.style.top = clamp(state.y, 0, Math.max(0, innerHeight - 40)) + 'px';
      pill.style.right = 'auto';
      pill.style.bottom = 'auto';
    } else {
      // Default to the TOP-RIGHT corner.
      pill.style.top = '16px';
      pill.style.right = '16px';
      pill.style.left = 'auto';
      pill.style.bottom = 'auto';
    }
  }

  // Drag from ANY point on the pill — not just the logomark. Buttons opt out
  // (mousedown on them is ignored) so «Решить» / «все страницы» / × still click
  // normally; everything else (logo, background, status text) grabs the pill.
  function wireDrag(pill) {
    let startX = 0, startY = 0, pillX = 0, pillY = 0, moved = false;
    const onMove = (e) => {
      moved = true;
      const w = pill.offsetWidth, h = pill.offsetHeight;
      const x = clamp(pillX + (e.clientX - startX), 0, Math.max(0, innerWidth - w));
      const y = clamp(pillY + (e.clientY - startY), 0, Math.max(0, innerHeight - h));
      pill.style.left = x + 'px';
      pill.style.top = y + 'px';
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      pill.classList.remove('dragging');
      if (activeDragCleanup === cleanup) activeDragCleanup = null;
    };
    const onUp = () => {
      cleanup();
      // A route/detection teardown can remove the pill during an active drag.
      // That cancelled gesture must not write detached coordinates back over a
      // newer build's storage snapshot.
      if (!pill.isConnected) return;
      if (moved) {
        state.x = parseFloat(pill.style.left) || 0;
        state.y = parseFloat(pill.style.top) || 0;
        saveState();
      }
    };
    pill.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;              // primary button only
      if (e.target.closest('button')) return;  // let the action buttons handle their click
      const rect = pill.getBoundingClientRect();
      pill.style.left = rect.left + 'px';
      pill.style.top = rect.top + 'px';
      pill.style.right = 'auto';
      pill.style.bottom = 'auto';
      pillX = rect.left; pillY = rect.top;
      startX = e.clientX; startY = e.clientY; moved = false;
      if (activeDragCleanup) activeDragCleanup();
      pill.classList.add('dragging');
      activeDragCleanup = cleanup;
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      e.preventDefault();
    });
  }

  /* ---------- Status helpers ---------- */
  // All guard on `shadow`: a panic-hide (Esc) mid-solve nulls it, but the
  // in-flight worker reply still resolves and calls back in here.
  function showThinking(prefix) {
    // A prior run's auto-idle callback must not re-enable this run's controls.
    clearTimeout(showResult._t);
    if (!shadow) return;
    const pill = shadow.querySelector('.pill');
    const stext = shadow.querySelector('.stext');
    stext.classList.remove('err');
    pill.classList.remove('result');
    pill.classList.add('busy');
    if (thinker) thinker.stop();
    thinker = startThinking(stext, { prefix });
  }
  function showResult(text, isError) {
    if (thinker) { thinker.stop(); thinker = null; }
    if (!shadow) return;
    const pill = shadow.querySelector('.pill');
    const stext = shadow.querySelector('.stext');
    pill.classList.remove('busy');
    pill.classList.add('result');
    stext.classList.toggle('err', !!isError);
    stext.textContent = text;
    // Auto-return to idle so the pill goes back to its discreet state. Errors
    // linger a little longer so they're readable.
    clearTimeout(showResult._t);
    showResult._t = setTimeout(toIdle, isError ? 7000 : 3500);
  }
  function toIdle() {
    if (!shadow) return;
    const pill = shadow.querySelector('.pill');
    pill.classList.remove('busy', 'result');
    setButtonsDisabled(false);
  }
  function setButtonsDisabled(d) {
    if (!shadow) return;
    shadow.querySelectorAll('.actions button').forEach((b) => { b.disabled = d; });
  }

  // Mirror popup.js renderPaginationSummary so the autopilot ends with the same
  // wording the toolbar flow uses.
  function paginationSummary(outcome, solved) {
    const pages = `Решено страниц: ${solved}.`;
    switch (outcome) {
      case 'finish': return `${pages} Дошёл до конца — отправку не нажимаю, проверь и отправь сам.`;
      case 'blocked': return `${pages} «Дальше» есть, но сам её не нажимаю — можно случайно отправить тест. Перейди дальше вручную и нажми «Решить».`;
      case 'none': return `${pages} Не нашёл «Дальше» — похоже, последняя страница. Проверь и отправь сам.`;
      case 'stuck': return `${pages} Страница не сменилась — остановился. Проверь оставшиеся вопросы.`;
      case 'partial': return `${pages} Текущая страница заполнена не полностью — остановился до «Дальше». Проверь её вручную.`;
      case 'unrecognized': return `${pages} Вопросы на текущей странице не распознаны — остановился до «Дальше». Проверь её вручную.`;
      case 'max': return `${pages} Достигнут предел в 30 страниц — остановился. Проверь и отправь сам.`;
      default: return `Готово. ${pages}`;
    }
  }

  /* ---------- Actions ---------- */
  // A page click proves intent locally; the worker also requires a fresh,
  // single-use capability bound to this tab + exact action. Keeping the token
  // request separate means a recycled MV3 worker simply makes us ask again.
  function requestActionToken(action) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const t = setTimeout(() => finish({ ok: false, error: 'timeout' }), 5000);
      try {
        chrome.runtime.sendMessage({ type: 'GET_ACTION_TOKEN', action }, (r) => {
          clearTimeout(t);
          if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
          else finish(r || { ok: false, error: 'нет ответа' });
        });
      } catch (e) { clearTimeout(t); finish({ ok: false, error: String(e) }); }
    });
  }

  // The operation currently running in the worker, or ''. Removing local UI is
  // NOT cancellation: the worker keeps solving, filling, navigating and
  // spending for up to 30 pages, and the hidden answer panel can reappear. Every
  // teardown path must name this run and tell the worker to abort it.
  let activeOpId = '';

  function cancelActiveOperation() {
    const opId = activeOpId;
    if (!opId) return;
    activeOpId = '';
    try {
      chrome.runtime.sendMessage(
        { type: 'PILL_CANCEL', payload: { opId } },
        () => void chrome.runtime.lastError // the worker may already be gone
      );
    } catch { /* extension context torn down */ }
  }

  // One long-lived privileged message to the worker. A generous guard so a
  // recycled service worker (dropped reply) never leaves the pill spinning.
  async function send(type, timeoutMs) {
    // Allocate and PUBLISH the operation id before the first await. The token
    // request is a round trip to the worker, and a ×/Esc/route change/pagehide
    // during it used to find activeOpId still empty: no cancel was sent, and
    // once the token resolved the operation started anyway — invisible and
    // uncancellable.
    const opId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    activeOpId = opId;
    const grant = await requestActionToken(type);
    // Ownership can have been revoked while we waited. Re-check after EVERY
    // await, not just at entry.
    if (activeOpId !== opId) return { ok: false, cancelled: true, error: 'отменено' };
    if (!grant?.ok || !grant.token) {
      activeOpId = '';
      return grant || { ok: false, error: 'нет токена действия' };
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        if (activeOpId === opId) activeOpId = '';
        resolve(r);
      };
      // A local timeout is not cancellation either — the worker is still
      // running. Stop it explicitly before giving up on the reply.
      const t = setTimeout(() => {
        cancelActiveOperation();
        finish({ ok: false, error: 'timeout' });
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(
          { type, token: grant.token, payload: { provider: providerId, opId } },
          (r) => {
            clearTimeout(t);
            if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
            else finish(r || { ok: false, error: 'нет ответа' });
          }
        );
      } catch (e) { clearTimeout(t); finish({ ok: false, error: String(e) }); }
    });
  }

  async function solvePage() {
    if (busy) return;
    const gen = ++runGen;
    busy = true;
    setButtonsDisabled(true);
    showThinking('');
    // Generous cap: a full page of hard problems can take a couple of minutes to
    // solve + fill. The worker keeps the SW alive via the streaming call, so this
    // only bounds a genuinely stuck run, not a slow-but-progressing one.
    const r = await send('PILL_SOLVE_PAGE', 240000);
    if (gen !== runGen || !shadow) return;
    busy = false;
    if (!r.ok) { showResult(errText(r.error), true); return; }
    if (!r.count) { showResult('Вопросы не распознаны. Проверьте, что тест на экране.', true); return; }
    const filled = (r.summary && r.summary.filled ? r.summary.filled.length : 0);
    showResult(`Готово · заполнено ${filled} из ${r.count}`);
  }

  async function solveAll() {
    if (busy) return;
    const gen = ++runGen;
    busy = true;
    setButtonsDisabled(true);
    showThinking('Страница 1');
    // 30 pages × (solve + advance) — give it room, but always settle eventually.
    const r = await send('PILL_SOLVE_ALL', 30 * 60000);
    if (gen !== runGen || !shadow) return;
    busy = false;
    if (!r.ok) { showResult(errText(r.error), true); return; }
    showResult(paginationSummary(r.outcome, r.solved));
  }

  // Turn a raw worker error into something readable. The worker's own errors
  // (no key / no consent / no credits) are already actionable Russian sentences
  // ending in "Откройте настройки расширения", so we surface them as-is.
  function errText(err) {
    const e = String(err || 'ошибка');
    if (e === 'timeout') return 'Долго нет ответа. Проверьте интернет и ключ ИИ в настройках, попробуйте снова.';
    // Service worker recycled / extension reloaded mid-run → English runtime
    // error. Don't leak it; ask the user to retry (the page keeps any fills).
    if (/message port closed|context invalidated|Receiving end|establish connection/i.test(e)) {
      return 'Соединение с расширением прервалось. Попробуйте ещё раз.';
    }
    if (/^[А-ЯЁ]/.test(e)) return e; // worker's own guiding Russian sentence
    return 'Ошибка: ' + e;
  }

  function wireButtons(pill) {
    pill.querySelector('.act-page').addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      solvePage();
    });
    pill.querySelector('.act-all').addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      solveAll();
    });
    pill.querySelector('.close').addEventListener('click', () => panicHide());
  }

  /* ---------- Show / hide ---------- */
  async function build() {
    if (built) return;
    built = true;
    const gen = runGen;
    wireGlobalsOnce();
    loadBrandFonts(); // document-scope, so Unbounded actually renders in the shadow DOM
    await Promise.all([loadState(gen), loadTheme(gen), loadProvider(gen)]);
    // A boolean alone is insufficient here: the SPA can leave and re-enter a
    // test while this build is awaiting storage, making `built` true again for
    // a NEW build. Only this exact lifecycle generation may mount/render.
    if (gen !== runGen || !built || dismissed || !looksLikeTest()) return;
    ensureHost();
    render();
  }

  // Pill-lifecycle listeners (theme/resize/Esc/progress). Wired lazily on the
  // first build and only ONCE — so a non-test uchebnik/school page (the common
  // case) pays nothing for them, and a rebuild after a panic-hide doesn't stack
  // duplicates. They all no-op while the pill is hidden (guard on `shadow`).
  let globalsWired = false;
  function wireGlobalsOnce() {
    if (globalsWired) return;
    globalsWired = true;

    // Live status pushed from the worker during the multi-page autopilot.
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === 'PILL_PROGRESS' && thinker && msg.payload?.page) {
          thinker.setPrefix(`Страница ${msg.payload.page}`);
        }
        return false; // fire-and-forget: never sendResponse, never hold the channel
      });
    } catch { /* messaging unavailable */ }

    // Live theme sync from any extension page (settings/dashboard/popup) —
    // via the worker's storage.session mirror; local is trusted-only now.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'session') return;
        if (changes[STORAGE_KEY]) {
          stateRevision++;
          const next = changes[STORAGE_KEY].newValue;
          state = next && typeof next === 'object'
            ? { ...state, ...next }
            : { x: null, y: null };
          const pill = shadow && shadow.querySelector('.pill');
          if (pill) positionPill(pill);
        }
        if (changes.theme) {
          themeRevision++;
          themePref = changes.theme.newValue || 'system';
          applyTheme();
        }
        if (changes.aiProvider) {
          providerRevision++;
          setProvider(changes.aiProvider.newValue);
          applyProvider();
        }
      });
    } catch { /* storage events unavailable */ }
    darkMedia.addEventListener('change', () => { if (themePref === 'system') applyTheme(); });

    // Re-clamp on resize so a saved position from a wider window isn't stranded.
    window.addEventListener('resize', () => {
      const pill = shadow && shadow.querySelector('.pill');
      if (pill && state.x != null && state.y != null) positionPill(pill);
    });

    // Esc = panic key. Purely additive (no preventDefault), so the test player's
    // own Esc handling is untouched; we just tear our overlay down fast.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && hostEl) panicHide();
    }, true);

    window.addEventListener('pagehide', () => invalidatePillLifecycle({ hidePanel: true }));
  }

  /**
   * Tear down one exact pill lifecycle. Incrementing runGen invalidates BOTH a
   * pending build and a pending solve continuation. This is shared by explicit
   * panic-hide, SPA route/detection loss and full page teardown so none of those
   * paths leaves a busy overlay or detached drag listeners behind.
   */
  function invalidatePillLifecycle({ dismiss = false, hidePanel = false } = {}) {
    runGen++;
    // Local teardown alone left the worker solving and spending against a page
    // the student had closed the pill on. Stop the run in the worker too.
    cancelActiveOperation();
    busy = false;
    clearTimeout(showResult._t);
    showResult._t = null;
    if (thinker) { thinker.stop(); thinker = null; }
    if (activeDragCleanup) activeDragCleanup();
    if (dismiss) dismissed = true;
    if (hostEl) hostEl.remove();
    hostEl = null;
    shadow = null;
    built = false;
    if (hidePanel) {
      try { window.__smeshPanel?.hide(); } catch { /* panel not present */ }
    }
  }

  // Panic / quick-hide: instantly remove the pill AND the answer panel, and stay
  // hidden on THIS page (the poll must not rebuild it a second later). A reload
  // or a navigation to another test URL clears the dismissal and brings it back.
  function panicHide() {
    invalidatePillLifecycle({ dismiss: true, hidePanel: true });
  }

  window.__smeshPill = { build, hide: panicHide, looksLikeTest, evaluate };

  /* ---------- Detection watcher (poll-based; survives SPA navigation) ---------- */
  // A content script lives in an ISOLATED world, so it CANNOT hook the page's
  // history.pushState — the МЭШ React app routes into a test client-side, which
  // fires no event we can hear. So we poll location.href (cheap string compare)
  // and re-evaluate. This also catches the test player loading its iframe a beat
  // after navigation. The poll is gentle and only runs on МЭШ hosts.
  let lastHref = location.href;
  function evaluate() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      dismissed = false; // a new route may show the pill again
      invalidatePillLifecycle({ hidePanel: true });
    }
    if (dismissed) return;
    if (!looksLikeTest()) {
      // Detection can disappear while storage is loading or a solve is pending.
      // Both states belong to the old page and must be invalidated immediately;
      // waiting for `busy` to clear kept the pill alive on unrelated SPA pages.
      if (built || hostEl || busy || thinker) {
        invalidatePillLifecycle({ hidePanel: true });
      }
      return;
    }
    if (!built) { log('test detected → showing pill', location.href); build(); return; }
    // Already built: if a heavy SPA re-render detached our host, re-attach it.
    if (hostEl && !document.documentElement.contains(hostEl)) {
      document.documentElement.appendChild(hostEl);
    }
  }

  log('loaded', location.href, '· isTest=' + looksLikeTest());
  evaluate();
  setInterval(evaluate, 1200);
  window.addEventListener('popstate', evaluate);
  window.addEventListener('hashchange', evaluate);
})();

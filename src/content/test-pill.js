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
 * Modeled on answer-panel.js: open Shadow DOM (CSS isolation), draggable,
 * position persisted to chrome.storage.session, live theme sync, idempotent
 * injection, z-index 2147483647, brand fonts + tokens.
 *
 * INJECTION SCOPE — declared as a content script in manifest.json. Tests live on
 * two hosts, so the match list there covers both (top frame only):
 *   • https://uchebnik.mos.ru/exam/challenge/…   (the test IS the top frame)
 *   • https://school.mos.ru/<course>/cwork?…     (test runs in a uchebnik iframe)
 * Both carry an xAPI launch signature (activityId + lrs endpoint + registration).
 * The user picked "show only on detected tests", so looksLikeTest() below gates
 * whether the pill actually appears. Edit BOTH the manifest match list and
 * looksLikeTest() when МЭШ ships a new test URL shape.
 */
(() => {
  if (window.__smeshPill) return;

  // Namespaced diagnostics — same prefix style as scraper.js. Lets us confirm
  // the script injected and see WHY detection did/didn't fire from the page
  // console (filter on "СМЭШ AI pill"). Flip to false before a store release.
  const DEBUG = true;
  const log = (...a) => { if (DEBUG) { try { console.debug('[СМЭШ AI pill]', ...a); } catch { /* */ } } };

  /* ---------- Test-page detection (single source of truth) ---------- */
  // The manifest matches both МЭШ hosts broadly (uchebnik.mos.ru + school.mos.ru
  // minus /diary). This decides whether the CURRENT page is actually a test
  // before we show anything (stealth-first). Tests appear as:
  //   • a launch URL carrying xAPI params (activityId / cwork_id / registration),
  //   • a path under /exam, /challenge, /cwork, /test, …, OR
  //   • a host page that embeds the uchebnik test player in an <iframe>
  //     (Библиотека МЭШ / Цифровой учитель shell the player this way).
  // Any one signal is enough — designed to err toward showing on a real test.
  function hasTestIframe() {
    try {
      return !!document.querySelector(
        'iframe[src*="uchebnik.mos.ru"], iframe[src*="/lrs"], iframe[src*="/exam"], ' +
        'iframe[src*="/launch"], iframe[src*="activityId"], iframe[src*="cwork"]'
      );
    } catch { return false; }
  }
  function looksLikeTest() {
    const { pathname, search } = location;
    // xAPI launch params — the strongest signal; any one is decisive.
    if (/[?&](activityId|cwork_id|registration|lesson_id|scorm_id)=/i.test(search)) return true;
    if (/[?&]endpoint=[^&]*lrs/i.test(search)) return true;
    // Path markers across МЭШ test surfaces.
    if (/\/(exam|challenge|cwork|control[-_]?work|test|testing|training|diagnostic|quiz)(\/|$|\?)/i.test(pathname)) return true;
    // A page that embeds the test player as an iframe.
    if (hasTestIframe()) return true;
    return false;
  }

  const STORAGE_KEY = 'smeshTestPill2'; // bumped: reset stale positions to the new top-right default
  const HOST_ID = '__smesh-test-pill-host';

  // Mark loaded immediately so a re-inject is a no-op even if the page isn't a
  // test yet (SPA route may turn into one — see the URL watcher at the bottom).
  let built = false;
  let dismissed = false; // user pressed Esc / × — don't auto-rebuild on the same page
  let hostEl = null;
  let shadow = null;
  let state = { x: null, y: null };
  let busy = false;
  let thinker = null;

  let themePref = 'system';
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

  function logoUrl() {
    try { return chrome.runtime.getURL('assets/icons/logo-mark.png'); } catch { return ''; }
  }

  /* ---------- Live "thinking" status (mirrors common/thinking.js) ---------- */
  // thinking.js is an ES module (can't be imported into a classic content
  // script), so its pattern is inlined: a shifting verb + elapsed seconds, with
  // an updatable prefix so the multi-page loop can show «Страница N».
  const THINK_WORDS = [
    'Думаю', 'Решаю', 'Считаю', 'Разбираю', 'Анализирую',
    'Соображаю', 'Вникаю', 'Размышляю', 'Сверяю', 'Проверяю'
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
  function loadState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.session.get(STORAGE_KEY, (v) => {
          if (!chrome.runtime.lastError && v?.[STORAGE_KEY]) state = { ...state, ...v[STORAGE_KEY] };
          resolve();
        });
      } catch { resolve(); }
    });
  }
  function saveState() {
    try { chrome.storage.session.set({ [STORAGE_KEY]: state }); } catch { /* session blocked */ }
  }
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
    const pill = shadow && shadow.querySelector('.pill');
    if (pill) pill.dataset.theme = resolveTheme();
  }

  /* ---------- DOM ---------- */
  function ensureHost() {
    if (hostEl && document.documentElement.contains(hostEl)) return;
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText =
      'all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; ' +
      'z-index: 2147483647; pointer-events: none;';
    shadow = hostEl.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(hostEl);
  }

  function render() {
    shadow.innerHTML = `
      <style>
        ${fontFaceCss()}
        :host, * { box-sizing: border-box; }

        /* Brand tokens — mirror answer-panel.js / theme.css, toggled live via
           .pill[data-theme]. Default dark so it never flashes unstyled. */
        .pill[data-theme="dark"] {
          --p-bg: rgba(27, 40, 39, 0.86);
          --p-text: #e8e4d8;
          --p-border: rgba(255, 255, 255, 0.10);
          --p-shadow: 0 8px 28px -10px rgba(0, 0, 0, 0.7);
          --p-muted: #8a948f;
          --p-accent: #4fd1c5;
          --p-on-accent: #08110f;
          --p-btn-border: rgba(255, 255, 255, 0.16);
          --p-btn-hover: rgba(255, 255, 255, 0.07);
          --p-danger: #ff6b5e;
          --p-sep: rgba(255, 255, 255, 0.12);
        }
        .pill[data-theme="light"] {
          --p-bg: rgba(255, 255, 255, 0.88);
          --p-text: #2a2620;
          --p-border: rgba(42, 38, 32, 0.12);
          --p-shadow: 0 8px 26px -10px rgba(40, 33, 20, 0.28);
          --p-muted: #756d5e;
          --p-accent: #1f8f8b;
          --p-on-accent: #ffffff;
          --p-btn-border: rgba(42, 38, 32, 0.16);
          --p-btn-hover: rgba(42, 38, 32, 0.06);
          --p-danger: #c7382e;
          --p-sep: rgba(42, 38, 32, 0.12);
        }

        .pill {
          position: fixed;
          display: flex;
          align-items: center;
          gap: 7px;
          max-width: 320px;
          padding: 5px 7px 5px 8px;
          background: var(--p-bg);
          color: var(--p-text);
          border: none;
          border-radius: 999px;
          /* Teal ring so the pill reads as branded and is easy to spot. */
          box-shadow: 0 0 0 1.5px var(--p-accent), var(--p-shadow);
          font-family: "SmeshUnbounded", "SmeshManrope", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 12px;
          backdrop-filter: blur(7px);
          -webkit-backdrop-filter: blur(7px);
          pointer-events: auto;
          user-select: none;
        }

        /* Drag handle: the brand logomark. */
        .grip {
          display: flex; align-items: center; justify-content: center;
          flex: none; width: 22px; height: 22px;
          cursor: grab; border-radius: 50%;
        }
        .grip.dragging { cursor: grabbing; }
        .grip img { width: 20px; height: 20px; object-fit: contain; -webkit-user-drag: none; pointer-events: none; }
        /* Fallback "С" mark if the PNG can't be resolved on this host. */
        .grip .mark-fallback {
          width: 20px; height: 20px; border-radius: 50%;
          display: none; align-items: center; justify-content: center;
          font-family: "SmeshUnbounded", sans-serif; font-weight: 800; font-size: 12px;
          color: #0b1413; background: var(--p-accent);
        }
        .grip img.broken { display: none; }
        .grip img.broken + .mark-fallback { display: flex; }

        button {
          font-family: "SmeshUnbounded", "SmeshManrope", -apple-system, sans-serif;
          background: transparent;
          color: inherit;
          border: 1px solid var(--p-btn-border);
          border-radius: 999px;
          padding: 5px 12px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: -0.02em;
          line-height: 1;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease, filter 0.15s ease;
        }
        button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--p-accent); }
        button[disabled] { opacity: 0.5; cursor: default; }

        /* Primary action — SOLID teal so it's unmistakable. */
        .act-page {
          color: var(--p-on-accent);
          background: var(--p-accent);
          border-color: var(--p-accent);
        }
        .act-page:hover { filter: brightness(1.08); }
        /* Secondary — teal text, quieter, reads as the optional autopilot. */
        .act-all { color: var(--p-accent); border-color: transparent; font-size: 10px; padding: 5px 9px; }
        .act-all:hover { background: var(--p-btn-hover); }

        .close {
          flex: none; width: 22px; height: 22px; padding: 0;
          border: none; border-radius: 50%;
          color: var(--p-muted); font-size: 16px; line-height: 1;
        }
        .close:hover { color: var(--p-danger); background: var(--p-btn-hover); }

        .actions { display: flex; align-items: center; gap: 6px; }

        /* Status area replaces the actions while solving. */
        .status { display: none; align-items: center; gap: 7px; padding-right: 4px; min-width: 150px; }
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
          width: 13px; height: 13px;
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
      <div class="pill" data-theme="${resolveTheme()}" role="group" aria-label="СМЭШ AI — решить тест">
        <span class="grip" data-drag title="Перетащить">
          <img alt="СМЭШ AI" src="${logoUrl()}">
          <span class="mark-fallback">С</span>
        </span>
        <div class="actions">
          <button class="act-page" title="Решить и заполнить эту страницу">Решить</button>
          <button class="act-all" title="Решить каждую страницу по очереди и переходить «Далее». Отправку не нажимаю.">все страницы</button>
        </div>
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

  function wireDrag(pill) {
    const grip = pill.querySelector('[data-drag]');
    let startX = 0, startY = 0, pillX = 0, pillY = 0, moved = false;
    const onMove = (e) => {
      moved = true;
      const w = pill.offsetWidth, h = pill.offsetHeight;
      const x = clamp(pillX + (e.clientX - startX), 0, Math.max(0, innerWidth - w));
      const y = clamp(pillY + (e.clientY - startY), 0, Math.max(0, innerHeight - h));
      pill.style.left = x + 'px';
      pill.style.top = y + 'px';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      grip.classList.remove('dragging');
      if (moved) {
        state.x = parseFloat(pill.style.left) || 0;
        state.y = parseFloat(pill.style.top) || 0;
        saveState();
      }
    };
    grip.addEventListener('mousedown', (e) => {
      const rect = pill.getBoundingClientRect();
      pill.style.left = rect.left + 'px';
      pill.style.top = rect.top + 'px';
      pill.style.right = 'auto';
      pill.style.bottom = 'auto';
      pillX = rect.left; pillY = rect.top;
      startX = e.clientX; startY = e.clientY; moved = false;
      grip.classList.add('dragging');
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      e.preventDefault();
    });
  }

  /* ---------- Status helpers ---------- */
  // All guard on `shadow`: a panic-hide (Esc) mid-solve nulls it, but the
  // in-flight worker reply still resolves and calls back in here.
  function showThinking(prefix) {
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
      case 'none': return `${pages} Не нашёл «Дальше» — похоже, последняя страница. Проверь и отправь сам.`;
      case 'stuck': return `${pages} Страница не сменилась — остановился. Проверь оставшиеся вопросы.`;
      case 'max': return `${pages} Достигнут предел в 30 страниц — остановился. Проверь и отправь сам.`;
      default: return `Готово. ${pages}`;
    }
  }

  /* ---------- Actions ---------- */
  // One long-lived message to the worker. A generous guard so a recycled service
  // worker (dropped reply) never leaves the pill spinning forever.
  function send(type, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const t = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
      try {
        chrome.runtime.sendMessage({ type }, (r) => {
          clearTimeout(t);
          if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
          else finish(r || { ok: false, error: 'нет ответа' });
        });
      } catch (e) { clearTimeout(t); finish({ ok: false, error: String(e) }); }
    });
  }

  async function solvePage() {
    if (busy) return;
    busy = true;
    setButtonsDisabled(true);
    showThinking('');
    const r = await send('PILL_SOLVE_PAGE', 130000);
    busy = false;
    if (!r.ok) { showResult(errText(r.error), true); return; }
    if (!r.count) { showResult('Вопросы не распознаны. Проверьте, что тест на экране.', true); return; }
    const filled = (r.summary && r.summary.filled ? r.summary.filled.length : 0);
    showResult(`Готово · заполнено ${filled} из ${r.count}`);
  }

  async function solveAll() {
    if (busy) return;
    busy = true;
    setButtonsDisabled(true);
    showThinking('Страница 1');
    // 30 pages × (solve + advance) — give it room, but always settle eventually.
    const r = await send('PILL_SOLVE_ALL', 30 * 60000);
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
    pill.querySelector('.act-page').addEventListener('click', solvePage);
    pill.querySelector('.act-all').addEventListener('click', solveAll);
    pill.querySelector('.close').addEventListener('click', () => panicHide());
  }

  /* ---------- Show / hide ---------- */
  async function build() {
    if (built) return;
    built = true;
    wireGlobalsOnce();
    await Promise.all([loadState(), loadTheme()]);
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

    // Live theme sync from any extension page (settings/dashboard/popup).
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.theme) {
          themePref = changes.theme.newValue || 'system';
          applyTheme();
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

    window.addEventListener('pagehide', () => {
      if (thinker) { thinker.stop(); thinker = null; }
    });
  }

  // Panic / quick-hide: instantly remove the pill AND the answer panel, and stay
  // hidden on THIS page (the poll must not rebuild it a second later). A reload
  // or a navigation to another test URL clears the dismissal and brings it back.
  function panicHide() {
    if (thinker) { thinker.stop(); thinker = null; }
    busy = false; // a stale in-flight solve must not block a rebuilt pill
    dismissed = true;
    if (hostEl) { hostEl.remove(); hostEl = null; shadow = null; built = false; }
    try { window.__smeshPanel?.hide(); } catch { /* panel not present */ }
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
    if (location.href !== lastHref) { lastHref = location.href; dismissed = false; } // new route → pill allowed again
    if (dismissed) return;
    if (!looksLikeTest()) return;
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

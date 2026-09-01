import {
  executeScriptInCapturedDocuments,
  testCaptureChangedError,
} from './test-capture-context.js';

const MAX_PILL_TEXT_CHARS = 15000;
// Generic pages get a much smaller budget than МЭШ. They are answered on the
// cheap chain, the reader already strips site furniture, and an arbitrary site
// can be arbitrarily large — an unbounded scrape is how "works on any page"
// turns into "costs the same as a textbook".
const MAX_WEB_BODY_CHARS = 6000;
const MAX_WEB_TEXT_CHARS = 10000;

function expectedCaptureDocuments(capture) {
  return Object.fromEntries(
    capture.documents.map((document) => [document.pageId, {
      signature: document.signature,
      principal: document.principal,
      url: document.url,
      requireTestDocument: document.frameId !== 0,
    }])
  );
}

/** Read bounded, accessible DOM text from the exact documents captured. */
export async function capturePillDomText(capture, scripting = chrome.scripting) {
  const expectedDocuments = expectedCaptureDocuments(capture);
  let results;
  try {
    results = await executeScriptInCapturedDocuments(capture, {
      func: (expected, maxChars) => {
        try {
          const pageId = window.__smeshCaptureDocumentId;
          const expectedDocument = pageId && expected[pageId];
          const signature = (typeof window.__smeshPageSig === 'function') ? window.__smeshPageSig() : '';
          const principal = (typeof window.__smeshCurrentPrincipal === 'function')
            ? window.__smeshCurrentPrincipal() : '';
          if (!expectedDocument || expectedDocument.signature !== signature ||
              expectedDocument.principal !== principal ||
              expectedDocument.url !== String(location.href || '') ||
              (expectedDocument.requireTestDocument &&
                !(typeof window.__smeshIsTestDocument === 'function' && window.__smeshIsTestDocument() === true))) {
            return { stale: true, text: '' };
          }
          const body = document.body?.innerText || '';
          const accessible = Array.from(document.querySelectorAll('img[alt], [aria-label]'))
            .slice(0, 200)
            .map((element) => element.getAttribute('alt') || element.getAttribute('aria-label') || '')
            .filter(Boolean)
            .join('\n');
          return { stale: false, text: `${body}\n${accessible}`.slice(0, maxChars) };
        } catch {
          return { stale: false, text: '' };
        }
      },
      args: [expectedDocuments, MAX_PILL_TEXT_CHARS],
    }, scripting);
  } catch {
    throw testCaptureChangedError();
  }
  if (results.some((entry) => entry?.result?.stale)) throw testCaptureChangedError();

  let pageText = '';
  for (const entry of [...results].sort((a, b) => (a.frameId || 0) - (b.frameId || 0))) {
    const chunk = String(entry?.result?.text || '').trim();
    if (!chunk || pageText.includes(chunk)) continue;
    // The separator costs budget too. Charging it kept the result within the
    // cap (it could previously reach MAX + 2) and stops a frame appending a
    // bare "\n\n" once nothing else fits.
    const separator = pageText ? '\n\n' : '';
    const room = MAX_PILL_TEXT_CHARS - pageText.length - separator.length;
    if (room <= 0) break;
    pageText += separator + chunk.slice(0, room);
    if (pageText.length >= MAX_PILL_TEXT_CHARS) break;
  }
  return pageText;
}

/**
 * Read a GENERIC page (any site the user granted) through scraper.js's web
 * reader: main content only, site furniture stripped, plus an inventory of the
 * answer controls so the model can address them by number.
 *
 * Bound to the exact captured document the same way the Mesh reader is, so a
 * navigation between capture and read fails closed instead of scraping a page
 * nobody asked about.
 *
 * @returns {Promise<{text: string, unitCount: number}>}
 */
export async function captureWebDomText(capture, scripting = chrome.scripting) {
  const expectedDocuments = expectedCaptureDocuments(capture);
  let results;
  try {
    results = await executeScriptInCapturedDocuments(capture, {
      func: (expected, bodyChars, totalChars) => {
        try {
          const pageId = window.__smeshCaptureDocumentId;
          const expectedDocument = pageId && expected[pageId];
          const signature = (typeof window.__smeshPageSig === 'function') ? window.__smeshPageSig() : '';
          const principal = (typeof window.__smeshCurrentPrincipal === 'function')
            ? window.__smeshCurrentPrincipal() : '';
          if (!expectedDocument || expectedDocument.signature !== signature ||
              expectedDocument.principal !== principal ||
              expectedDocument.url !== String(location.href || '')) {
            return { stale: true, text: '', unitCount: 0 };
          }
          if (typeof window.__smeshWebContent !== 'function') {
            return { stale: false, text: '', unitCount: 0, bodyChars: 0 };
          }
          const content = window.__smeshWebContent(bodyChars);
          return {
            stale: false,
            text: String(content?.text || '').slice(0, totalChars),
            unitCount: Number(content?.unitCount) || 0,
            bodyChars: Number(content?.bodyChars) || 0,
          };
        } catch {
          return { stale: false, text: '', unitCount: 0, bodyChars: 0 };
        }
      },
      args: [expectedDocuments, MAX_WEB_BODY_CHARS, MAX_WEB_TEXT_CHARS],
    }, scripting);
  } catch {
    throw testCaptureChangedError();
  }
  if (results.some((entry) => entry?.result?.stale)) throw testCaptureChangedError();
  const result = results[0]?.result;
  return {
    text: String(result?.text || '').slice(0, MAX_WEB_TEXT_CHARS),
    unitCount: Number(result?.unitCount) || 0,
    bodyChars: Number(result?.bodyChars) || 0,
  };
}

/**
 * Detect visible, substantial visual/media material in the exact captured test
 * documents. scraper.js owns the DOM heuristic so popup and pill routing cannot
 * drift apart; this wrapper supplies the same document/signature/principal
 * binding as the text capture before trusting its boolean.
 */
export async function captureTestVisualMedia(capture, scripting = chrome.scripting) {
  const expectedDocuments = expectedCaptureDocuments(capture);
  try {
    await executeScriptInCapturedDocuments(capture, { files: ['src/content/scraper.js'] }, scripting);
  } catch { /* normally already injected; the bound read below is authoritative */ }

  let results;
  try {
    results = await executeScriptInCapturedDocuments(capture, {
      func: (expected) => {
        try {
          const pageId = window.__smeshCaptureDocumentId;
          const expectedDocument = pageId && expected[pageId];
          const signature = (typeof window.__smeshPageSig === 'function') ? window.__smeshPageSig() : '';
          const principal = (typeof window.__smeshCurrentPrincipal === 'function')
            ? window.__smeshCurrentPrincipal() : '';
          if (!expectedDocument || expectedDocument.signature !== signature ||
              expectedDocument.principal !== principal ||
              expectedDocument.url !== String(location.href || '') ||
              (expectedDocument.requireTestDocument &&
                !(typeof window.__smeshIsTestDocument === 'function' && window.__smeshIsTestDocument() === true))) {
            return { stale: true, visualMedia: false };
          }
          return {
            stale: false,
            visualMedia: typeof window.__smeshHasVisualMedia === 'function' &&
              window.__smeshHasVisualMedia() === true,
          };
        } catch {
          return { stale: false, visualMedia: false };
        }
      },
      args: [expectedDocuments],
    }, scripting);
  } catch {
    throw testCaptureChangedError();
  }
  if (results.some((entry) => entry?.result?.stale)) throw testCaptureChangedError();
  return results.some((entry) => entry?.result?.visualMedia === true);
}

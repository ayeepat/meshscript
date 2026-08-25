import {
  executeScriptInCapturedDocuments,
  testCaptureChangedError,
} from './test-capture-context.js';

const MAX_PILL_TEXT_CHARS = 15000;

/** Read bounded, accessible DOM text from the exact documents captured. */
export async function capturePillDomText(capture, scripting = chrome.scripting) {
  const expectedDocuments = Object.fromEntries(
    capture.documents.map((document) => [document.pageId, {
      signature: document.signature,
      principal: document.principal,
      url: document.url,
      requireTestDocument: document.frameId !== 0,
    }])
  );
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

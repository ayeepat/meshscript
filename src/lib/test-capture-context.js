export const TEST_CAPTURE_CHANGED = 'TEST_CAPTURE_CHANGED';

const MAX_CAPTURE_DOCUMENTS = 128;
const MAX_CAPTURE_PRINCIPAL_LENGTH = 512;

function isOpaqueDocumentId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\x00-\x1f\x7f]/.test(value);
}

function isBoundedPrincipal(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CAPTURE_PRINCIPAL_LENGTH
    && !/[\x00-\x1f\x7f]/.test(value);
}

function principalCarriesIdentity(value) {
  try {
    const parts = JSON.parse(value);
    if (!Array.isArray(parts) || (parts[0] !== 'v1' && parts[0] !== 'v2')) return false;
    const account = typeof parts[1] === 'string' ? parts[1] : '';
    const subject = typeof parts[2] === 'string' ? parts[2] : '';
    const student = typeof parts[3] === 'string' ? parts[3] : '';
    const state = typeof parts[4] === 'string' ? parts[4] : '';
    const session = parts[0] === 'v2' && typeof parts[5] === 'string' ? parts[5] : '';
    // An attempt/session identity is sufficient for cross-origin Uchebnik
    // frames. Without it, an explicitly ambiguous child selection is not made
    // safe merely because the family account itself is known.
    if (session) return true;
    if (state === 'ambiguous' || state === 'unbound') return false;
    return Boolean(account || subject || student);
  } catch {
    return false;
  }
}

function isCaptureDocument(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).every((key) => [
        'frameId', 'documentId', 'pageId', 'signature', 'principal', 'url', 'isTestDocument'
      ].includes(key))
      && Number.isInteger(value.frameId)
      && value.frameId >= 0
      && isOpaqueDocumentId(value.documentId)
      && typeof value.pageId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.pageId)
      && typeof value.signature === 'string'
      && value.signature.length > 0
      && value.signature.length <= 65536
      && isBoundedPrincipal(value.principal)
      && isHttpUrl(value.url)
      && value.isTestDocument === true,
  );
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Capture modes.
 *
 * 'mesh' (the default, and what an absent field means) is the МЭШ assessment
 * flow: many frames, an xAPI/child principal, pagination. 'web' is the generic
 * any-site flow (see lib/web-solve.js) and is deliberately far narrower — ONE
 * top-level document, no child frames, no pagination — because on an arbitrary
 * page a third-party iframe is an ad or a widget, never part of the question.
 */
export const CAPTURE_MODE_MESH = 'mesh';
export const CAPTURE_MODE_WEB = 'web';

export function captureMode(value) {
  return value?.mode === CAPTURE_MODE_WEB ? CAPTURE_MODE_WEB : CAPTURE_MODE_MESH;
}

export function isWebCapture(value) {
  return captureMode(value) === CAPTURE_MODE_WEB;
}

/**
 * A generic capture's principal must be the origin-scoped web identity that
 * scraper.js mints off Mesh. Checking the SHAPE here (not just "some identity
 * exists") is what stops a Mesh document whose account signals happened to be
 * unreadable from being laundered into a web capture, and vice versa.
 */
function isWebPrincipal(value) {
  try {
    const parts = JSON.parse(value);
    return Array.isArray(parts) && parts[0] === 'v2' && parts[4] === 'web' &&
      typeof parts[1] === 'string' && parts[1].length > 0;
  } catch {
    return false;
  }
}

export function isTestCaptureContext(value) {
  if (value?.mode != null && value.mode !== CAPTURE_MODE_MESH && value.mode !== CAPTURE_MODE_WEB) {
    return false;
  }
  if (!value
      || !Number.isInteger(value.tabId)
      || value.tabId < 0
      || !isHttpUrl(value.url)
      || !isOpaqueDocumentId(value.documentId)
      || typeof value.signature !== 'string'
      || value.signature.length === 0
      || value.signature.length > 65536
      || !Array.isArray(value.documents)
      || value.documents.length === 0
      || value.documents.length > MAX_CAPTURE_DOCUMENTS
      || !value.documents.every(isCaptureDocument)) return false;

  const frameIds = new Set();
  const documentIds = new Set();
  const pageIds = new Set();
  for (const document of value.documents) {
    if (frameIds.has(document.frameId)
        || documentIds.has(document.documentId)
        || pageIds.has(document.pageId)) return false;
    frameIds.add(document.frameId);
    documentIds.add(document.documentId);
    pageIds.add(document.pageId);
  }
  const top = value.documents.find((document) => document.frameId === 0);
  if (!top || top.documentId !== value.documentId) return false;

  if (isWebCapture(value)) {
    // Exactly the visible top document of an eligible generic page, identified
    // by its origin. No child frames means no ad iframe can contribute text to
    // a prompt or receive an autofill.
    return value.documents.length === 1 && top.url === value.url && isWebPrincipal(top.principal);
  }

  // Individual cross-origin frames may have no local identity signals. The
  // capture remains usable when at least one captured document (normally the
  // top Mesh wrapper or the XAPI iframe) supplies an account/child/attempt
  // binding; an all-unknown capture fails closed instead of treating
  // unknown-account A as equal to unknown-account B.
  return value.documents.some((document) => principalCarriesIdentity(document.principal));
}

function sameCapturedDocuments(expected, current) {
  if (expected.length !== current.length) return false;
  return expected.every((document, index) => {
    const other = current[index];
    return document.frameId === other.frameId
      && document.documentId === other.documentId
      && document.pageId === other.pageId
      && document.signature === other.signature
      && document.principal === other.principal
      && document.url === other.url
      && document.isTestDocument === other.isTestDocument;
  });
}

export function sameTestCaptureContext(expected, current) {
  return isTestCaptureContext(expected)
    && isTestCaptureContext(current)
    // A Mesh capture and a web capture of the same tab are never the same
    // target, even if every other field lined up.
    && captureMode(expected) === captureMode(current)
    && expected.tabId === current.tabId
    && expected.url === current.url
    && expected.documentId === current.documentId
    && expected.signature === current.signature
    && sameCapturedDocuments(expected.documents, current.documents);
}

export function testCaptureChangedError() {
  const error = new Error('Страница теста изменилась. Запустите решение ещё раз.');
  error.code = TEST_CAPTURE_CHANGED;
  return error;
}

/**
 * Build a Chrome scripting target that is hard-bound to the documents captured
 * before the AI request. A tabId/allFrames target can silently land in a new
 * document after navigation; documentIds make Chrome reject that race instead.
 */
export function capturedDocumentTarget(capture, documentIds = null) {
  if (!isTestCaptureContext(capture)) throw testCaptureChangedError();
  const allowed = new Set(capture.documents.map((document) => document.documentId));
  const ids = documentIds == null ? [...allowed] : [...documentIds];
  if (!ids.length || ids.some((id) => !allowed.has(id))) throw testCaptureChangedError();
  return { tabId: capture.tabId, documentIds: ids };
}

export async function executeScriptInCapturedDocuments(capture, injection, scripting = chrome.scripting) {
  const { documentIds = null, ...details } = injection || {};
  return scripting.executeScript({
    ...details,
    target: capturedDocumentTarget(capture, documentIds),
  });
}

export async function withMatchingTestCapture(expected, readCurrent, action) {
  if (!isTestCaptureContext(expected)) throw testCaptureChangedError();
  const current = await readCurrent(expected.tabId);
  if (!sameTestCaptureContext(expected, current)) throw testCaptureChangedError();
  return action(current);
}

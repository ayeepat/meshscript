/**
 * "Any website" solving — the rules that decide WHERE the extension may read a
 * page outside МЭШ, and how such a page is identified.
 *
 * WHY THIS IS A SEPARATE PATH. Everything about the МЭШ test flow assumes a
 * Mesh page: the capture principal is the signed-in child, the frame filter
 * demands a Mesh URL, and pagination may click «Далее» inside a graded attempt.
 * None of that is true (or safe) on an arbitrary site, so the generic flow gets
 * its own capture reader, its own single-pass fill and its own solve handler.
 * The Mesh path is deliberately untouched — it is the product, this is the
 * bonus — and the two only share the primitives that were already generic
 * (pageSignature, the DOM fill engine, the answer panel, parseTestAnswers).
 *
 * PERMISSION MODEL. The extension ships with NO broad host permission. Generic
 * solving lives behind `optional_host_permissions`, granted per site (or, if the
 * user insists, for all sites) from the popup/settings with a real Chrome
 * prompt. Granting an origin is what registers the in-page pill there; revoking
 * it unregisters. A site the user never approved is never read, never scripted
 * and never sent to a model.
 *
 * COST. Generic pages are answered on the cheap standard chain at low effort
 * (see WEB_SOLVE_TIER / WEB_SOLVE_EFFORT below and the `tier` hint in
 * lib/smesh-proxy.js). Mesh keeps the frontier route.
 */

/** Hosts that own the МЭШ flow. They are matched statically in the manifest. */
export const MESH_HOSTS = Object.freeze(['school.mos.ru', 'uchebnik.mos.ru']);

/** The extension's own backends/site. Never a "page with questions". */
export const SMESH_SERVICE_HOSTS = Object.freeze([
  'smeshai.xyz',
  'smeshapi.site',
  'ai.smeshapi.site',
]);

/**
 * Cheap route + effort for every non-Mesh solve. The proxy treats `tier` as a
 * DOWNGRADE-ONLY hint, so the worst case if a server predates this build is an
 * ordinary Auto solve — never a silent upgrade of a page the user did not pay
 * frontier quota for.
 */
export const WEB_SOLVE_TIER = 'standard';
export const WEB_SOLVE_EFFORT = 'low';
// The legacy wire id for the licensed Auto proxy. Generic-page solves pin this
// route instead of inheriting an old per-user BYO provider selection.
export const WEB_SOLVE_PROVIDER = 'deepseek';

/** Id of the dynamically registered generic pill script. */
export const WEB_PILL_SCRIPT_ID = 'smesh-web-pill';
export const WEB_PILL_FILES = Object.freeze(['src/content/test-pill.js']);

export function isMeshHostname(hostname) {
  return MESH_HOSTS.includes(String(hostname || '').toLowerCase());
}

function isServiceHostname(hostname) {
  return SMESH_SERVICE_HOSTS.includes(String(hostname || '').toLowerCase());
}

/**
 * May this URL be solved through the generic path?
 *
 * Mesh is excluded because it has its own (stricter) path — a Mesh page must
 * never be downgraded onto the generic reader by, say, a stray optional grant.
 * The extension's own hosts are excluded because they are already in
 * `host_permissions`, so they show up in `permissions.getAll()` and would
 * otherwise get a pill on the pricing page.
 */
export function isWebSolvableUrl(url) {
  if (typeof url !== 'string' || !url || url.length > 4096) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return !isMeshHostname(parsed.hostname) && !isServiceHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * The origin match pattern to request for a tab, e.g.
 * `https://example.com/*`. Returns '' when the tab is not eligible, so callers
 * fail closed instead of asking Chrome for something unusable.
 */
export function webOriginPattern(url) {
  if (!isWebSolvableUrl(url)) return '';
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/*`;
  } catch {
    return '';
  }
}

/**
 * Stable identity for a captured generic page.
 *
 * The Mesh principal answers "which child is this?"; on an arbitrary site there
 * is no such notion, and the only isolation unit that means anything is the
 * ORIGIN. It rides in the same ['v2', account, …] shape the rest of the capture
 * machinery already understands, so lib/test-answer-cache.js scopes reuse per
 * site for free and lib/test-capture-context.js sees an identity-bearing
 * principal without a special case.
 *
 * ⚠️ Mirrored verbatim by scraper.js (a classic content script cannot import
 * this module). tests/web-solve-regression.mjs fails if the two ever drift.
 */
export function webCapturePrincipal(origin) {
  return JSON.stringify(['v2', String(origin || '').slice(0, 128), '', '', 'web', '']);
}

/** The principal a capture of `url` must carry, or '' when `url` is ineligible. */
export function expectedWebPrincipal(url) {
  if (!isWebSolvableUrl(url)) return '';
  try {
    return webCapturePrincipal(new URL(url).origin);
  } catch {
    return '';
  }
}

/**
 * Chrome match patterns the generic pill may be registered for, derived from
 * what the user has actually granted.
 *
 * `permissions.getAll().origins` also contains the manifest's REQUIRED hosts,
 * so an unfiltered list would inject the pill into Mesh (which already has the
 * static script) and into our own site. Host-specific patterns for those are
 * dropped here; a broad `*://*​/*` grant is kept but neutralised by
 * webPillExcludeMatches() below.
 */
export function webPillMatchPatterns(origins) {
  const out = [];
  for (const raw of Array.isArray(origins) ? origins : []) {
    const pattern = typeof raw === 'string' ? raw.trim() : '';
    const parsed = parseMatchPattern(pattern);
    if (!parsed) continue;
    if (parsed.host !== '*' && (isMeshHostname(parsed.host) || isServiceHostname(parsed.host))) continue;
    if (!out.includes(pattern)) out.push(pattern);
  }
  return out;
}

/**
 * Hosts the generic pill must never load on, expressed as match patterns. Used
 * as `excludeMatches` so an all-sites grant still keeps its hands off Mesh.
 */
export function webPillExcludeMatches() {
  return [...MESH_HOSTS, ...SMESH_SERVICE_HOSTS].map((host) => `*://${host}/*`);
}

/**
 * Minimal match-pattern reader: enough to tell an http(s) host pattern from
 * everything else Chrome may hand back (`file:///*`, `chrome://*`, …).
 * Returns null for anything we will not register a content script for.
 */
function parseMatchPattern(pattern) {
  const match = /^(\*|https?):\/\/([^/]+)\/(.*)$/.exec(pattern || '');
  if (!match) return null;
  const host = match[2].toLowerCase();
  // `*.example.com` covers example.com too; keep the leading wildcard label out
  // of the host comparison so the Mesh/service filter still recognises it.
  const bare = host.startsWith('*.') ? host.slice(2) : host;
  return { scheme: match[1], host: bare };
}

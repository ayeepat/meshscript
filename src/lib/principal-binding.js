function cleanPrincipal(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

const HOMEWORK_SCAN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isHomeworkScanId(value) {
  return typeof value === 'string' && HOMEWORK_SCAN_ID_RE.test(value);
}

/**
 * A task launch may consume the week cache only when identity is verifiable:
 * it must carry the capability minted by that exact scan, and then both
 * explicit principals must match (or both must be genuinely unavailable).
 * A known identity on only one side is asymmetric and therefore unsafe.
 */
export function principalBindingMatches({
  cacheScanId = null,
  launchScanId = null,
  cachePrincipal = null,
  launchPrincipal = null,
  cacheError = null,
  launchError = null,
} = {}) {
  if (!isHomeworkScanId(cacheScanId) || cacheScanId !== launchScanId) return false;
  if (cleanPrincipal(cacheError) || cleanPrincipal(launchError)) return false;
  const cached = cleanPrincipal(cachePrincipal);
  const launched = cleanPrincipal(launchPrincipal);
  if (cached == null || launched == null) return cached == null && launched == null;
  return cached === launched;
}

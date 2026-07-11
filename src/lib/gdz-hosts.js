/**
 * GDZ host allowlists shared by the background worker and renderer pages.
 *
 * WHY this is a separate pure module: the background fetch path, Settings
 * cover renderer and dashboard card all need the SAME URL trust decision, and
 * security logic that depends on chrome.* is painful to unit-test. Keep the
 * rules here side-effect-free so tests can pin the exact host policy.
 *
 * Policy:
 *   - only HTTPS;
 *   - only the exact registrable host or a real subdomain label under it
 *     (`img.gdz-ru.com` yes, `evilgdz-ru.com` / `gdz-ru.com.evil.com` no);
 *   - no embedded credentials (`https://user:pass@host/`) because the browser
 *     would visually hide the true target and the extension never needs them;
 *   - no explicit non-default ports. The mobile API / human site are expected
 *     on the normal HTTPS port only, so `:8443` is a different origin.
 *
 * Invalid / weird input must fail CLOSED (false), never throw.
 */

function hasAllowedHost(hostname, baseHost) {
  return hostname === baseHost || hostname.endsWith(`.${baseHost}`);
}

function isAllowedHttpsUrl(url, baseHost) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      hasAllowedHost(parsed.hostname, baseHost);
  } catch {
    return false;
  }
}

export function isGdzApiUrl(url) {
  return isAllowedHttpsUrl(url, 'gdz-ru.com');
}

export function isGdzHumanUrl(url) {
  return isAllowedHttpsUrl(url, 'gdz.ru');
}

export function isGdzCoverUrl(url) {
  return isGdzApiUrl(url) || isGdzHumanUrl(url);
}

/**
 * Build-time feature flags for the extension client.
 *
 * Kept tiny on purpose — anything that has to change without a re-publish
 * lives in chrome.storage.local instead. This file is for things only the
 * developer toggles between releases.
 */

// Which AI vendor answers is an internal routing detail, not a student-facing
// choice: the license buys "СМЭШ answers your homework", and naming Groq /
// OpenRouter / Qwen / DeepSeek in the UI only invites support questions we
// don't want and pins us to vendors we may swap. Flipping this back to true
// restores the Settings picker, the BYO key fields, the per-provider limits,
// the usage chart switcher and the GRQ/OPR/QWN/DSK badge — every code path
// behind them is intact and still tested.
//
// This hides the vendor NAMES from the product surface only. The consent
// screen still discloses that homework content goes to third-party AI
// services, and docs/STORE-REVIEW.md plus the site's privacy policy still name
// them. Hiding a picker must not turn into hiding the actual data recipients,
// especially when the audience is schoolchildren.
export const SHOW_PROVIDER_UI = false;

// What actually answers while the picker is hidden. DeepSeek is the cheapest
// per text solve; askAI() auto-upgrades to Qwen the moment a request carries an
// image or PDF (both ride the same Model Studio key through the proxy), so
// screenshots and textbook photos keep full vision quality. Must stay one of
// the licensed providers — a BYO one would need a key the user can no longer
// enter.
export const DEFAULT_PROVIDER = 'deepseek';

// Base URL of the license backend (Cloudflare Worker). Hit `/verify` here.
// This is a dedicated custom domain bound to the `smesh-licenses` Worker via
// Cloudflare Custom Domains, registered specifically for this purpose and
// separate from the smeshai.xyz brand domain. If this hostname changes again,
// update manifest.json `host_permissions` to match or extension fetches are
// blocked.
export const BACKEND_URL = 'https://smeshapi.site';

// Base URL of the AI proxy (plain AWS box, NOT the Cloudflare worker). Only
// /ai/start, /ai/poll and /ai/cancel live here (see lib/smesh-proxy.js for
// why polling: RU DPI clamps long-lived connections to this SNI, so the AI
// answer is fetched as a series of sub-second requests). Everything else —
// license verify, payments, support — stays on BACKEND_URL. If this hostname
// changes, update manifest.json `host_permissions` to match.
export const AI_BACKEND_URL = 'https://ai.smeshapi.site';

// Support bot deep link. The «Поддержка» buttons (popup + settings) open this.
// ⚠️ REPLACE `smesh_support_bot` with YOUR bot's @username from @BotFather
// (without the @). The `?start=support` part makes the bot greet the user.
export const SUPPORT_BOT_URL = 'https://t.me/smeshaibot?start=support';

// Preorder testers remain unblocked until launch; enforcement turns on
// automatically at the same instant the backend stops marking new purchases
// as preorders. This cannot be forgotten in an unpublished source-code toggle.
export const LICENSE_ENFORCED_FROM = Date.parse('2026-07-25T00:00:00Z');
export function isLicenseEnforced(now = Date.now()) {
  return Number(now) >= LICENSE_ENFORCED_FROM;
}

// Re-verify cached licenses at most this often. The verify endpoint is cheap
// (single KV read on Cloudflare's edge) but 24h is the right cadence — long
// enough to absorb backend hiccups, short enough that revocations propagate
// within a day.
export const VERIFY_CACHE_MS = 24 * 60 * 60 * 1000;

// Absolute offline grace: an entitlement confirmed by the server within this
// window survives an outage; after it expires the license gate fails closed.
export const LICENSE_OFFLINE_GRACE_MS = 48 * 60 * 60 * 1000;

// Remote runtime config (see lib/remote-config.js). A small JSON file you host
// yourself, fetched + cached so you can hot-fix a Mesh DOM change (the subject
// vocabulary, the homework-anchor selector) or push an "update required" notice
// WITHOUT shipping a new build through store review. Everything has a built-in
// fallback, so a 404 / unreachable host changes nothing. Point this at a static
// file on your site; the expected shape is documented in remote-config.js.
export const RUNTIME_CONFIG_URL = 'https://www.smeshai.xyz/extension-config.json';

// Refresh the cached runtime config at most this often (6h). Long enough to be
// nearly free, short enough that a hot-fix reaches users the same day.
export const RUNTIME_CONFIG_TTL_MS = 6 * 60 * 60 * 1000;

// P-256 verification key for signed runtime-config envelopes. The matching
// private key is deployment-only and is ignored under .secrets/; never copy it
// into extension source or the hosted config directory.
export const RUNTIME_CONFIG_PUBLIC_KEY_JWK = Object.freeze({
  kty: 'EC',
  crv: 'P-256',
  x: '5dbL_3E1XGPyPiVDRrls-W-FIiEbEkKdhO5Z3Xezu2U',
  y: '0LNIwC5bqMAJa-wljhC4CeyjuQhfds0EJge2HkvSDQU'
});

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
// the usage chart switcher and the GRQ/OPR/QWN/DSK badge in a separate
// developer build. Release builds neither hydrate nor persist those fields and
// the AI dispatcher accepts only the licensed qwen/deepseek route ids.
//
// This hides the vendor NAMES from the product surface only. The consent
// screen still discloses that homework content goes to third-party AI
// services, and docs/STORE-REVIEW.md plus the site's privacy policy still name
// them. Hiding a picker must not turn into hiding the actual data recipients,
// especially when the audience is schoolchildren.
//
// ⚠️ FLIPPING THIS BACK TO true ALSO REQUIRES a separate privacy/security
// review and restoring the BYO provider host
// permissions in manifest.json (`https://openrouter.ai/*`,
// `https://api.groq.com/*`, `https://dashscope-intl.aliyuncs.com/*`). They were
// dropped for the Chrome Web Store release because no shipped UI path could
// reach them, and an unreachable host permission is a review risk. Without them
// every legacy direct request fails at the browser boundary.
// tests/byo-provider-surface-regression.mjs fails the build if the flag and the
// manifest ever disagree.
export const SHOW_PROVIDER_UI = false;

// «Пригласи друга» is not live yet. While this is false the Settings card
// stays visible but inert — it shows a «Скоро» pill and answers a click with
// "coming soon" instead of a code — and every referral network call is skipped:
// the stats fetch, the code minting, and the pointer sync the service worker
// otherwise queues after each license activation (that durable intent is
// cleared instead of retried, so no install keeps hammering a switched-off
// endpoint). Every path behind the flag is intact and still tested.
//
// Must flip together with the backend's own switch (the REFERRALS_ENABLED var
// in backend/wrangler.toml, read by referralsEnabled() in worker.js), which
// refuses /referral/* and drops the checkout bonus. A card in front of a
// switched-off backend can only show «нет связи»; a live backend behind a
// hidden card promises days nobody can find.
export const REFERRALS_ENABLED = false;

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

// Signed runtime policy published by the same VPS configuration that the owner
// controls from the dashboard. A missing/unreachable policy leaves the local
// safe defaults in place; an invalid signature is ignored.
export const RUNTIME_CONFIG_URL = 'https://ai.smeshapi.site/public/runtime-config';

// Feature switches are an operational safety control, so a dashboard change
// must reach an online extension promptly. A five-minute refresh remains tiny
// traffic while bounding normal propagation delay.
export const RUNTIME_CONFIG_TTL_MS = 5 * 60 * 1000;

// P-256 verification key for signed runtime-config envelopes. The matching
// private key is deployment-only and is ignored under .secrets/; never copy it
// into extension source or the hosted config directory.
export const RUNTIME_CONFIG_PUBLIC_KEY_JWK = Object.freeze({
  kty: 'EC',
  crv: 'P-256',
  x: '5dbL_3E1XGPyPiVDRrls-W-FIiEbEkKdhO5Z3Xezu2U',
  y: '0LNIwC5bqMAJa-wljhC4CeyjuQhfds0EJge2HkvSDQU'
});

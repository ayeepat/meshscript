/**
 * Build-time feature flags for the extension client.
 *
 * Kept tiny on purpose — anything that has to change without a re-publish
 * lives in chrome.storage.local instead. This file is for things only the
 * developer toggles between releases.
 */

// Base URL of the license backend (Cloudflare Worker). Hit `/verify` here.
// This is the worker's live workers.dev URL (account subdomain "smeshai",
// worker name "smesh-licenses" — see backend/wrangler.toml). It must also be
// listed in manifest.json `host_permissions`, or the verify fetch is blocked.
// If you later bind a custom domain (e.g. https://api.smesh.app) in the
// Cloudflare dashboard, update BOTH this line and the host permission.
export const BACKEND_URL = 'https://smesh-licenses.smeshai.workers.dev';

// Support bot deep link. The «Поддержка» buttons (popup + settings) open this.
// ⚠️ REPLACE `smesh_support_bot` with YOUR bot's @username from @BotFather
// (without the @). The `?start=support` part makes the bot greet the user.
export const SUPPORT_BOT_URL = 'https://t.me/smeshaibot?start=support';

// When false, the extension still verifies and shows status in Settings but
// NEVER blocks AI calls. Flip to true on launch day after preorders ship.
// Keep false during preorder window so testers without keys aren't locked out.
export const LICENSE_ENFORCED = false;

// Re-verify cached licenses at most this often. The verify endpoint is cheap
// (single KV read on Cloudflare's edge) but 24h is the right cadence — long
// enough to absorb backend hiccups, short enough that revocations propagate
// within a day.
export const VERIFY_CACHE_MS = 24 * 60 * 60 * 1000;

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

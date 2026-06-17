/**
 * Build-time feature flags for the extension client.
 *
 * Kept tiny on purpose — anything that has to change without a re-publish
 * lives in chrome.storage.local instead. This file is for things only the
 * developer toggles between releases.
 */

// Base URL of the license backend (Cloudflare Worker). Hit `/verify` here.
// Update this to your custom domain once it's pointed at the worker.
export const BACKEND_URL = 'https://api.smesh.app';

// When false, the extension still verifies and shows status in Settings but
// NEVER blocks AI calls. Flip to true on launch day after preorders ship.
// Keep false during preorder window so testers without keys aren't locked out.
export const LICENSE_ENFORCED = false;

// Re-verify cached licenses at most this often. The verify endpoint is cheap
// (single KV read on Cloudflare's edge) but 24h is the right cadence — long
// enough to absorb backend hiccups, short enough that revocations propagate
// within a day.
export const VERIFY_CACHE_MS = 24 * 60 * 60 * 1000;

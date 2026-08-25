// Delivery providers are external side effects. Every attempt must finish well
// inside the D1 outbox lease; an unbounded fetch could otherwise be lapped by a
// later cron sweep and send the same bearer key twice.
export const DELIVERY_FETCH_TIMEOUT_MS = 20_000;

export async function fetchDelivery(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('delivery_timeout')),
    DELIVERY_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

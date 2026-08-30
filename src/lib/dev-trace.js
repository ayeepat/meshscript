/**
 * Developer solve traces — a local ring buffer of what each test solve actually
 * sent and received.
 *
 * Purpose: when a test comes back with wrong answers, the question is always
 * "did the model fail, or did we feed it garbage?". A trace answers it directly
 * because it stores the INPUT (the scraped page text, verbatim, exactly as
 * askAI received it) next to the model's private reasoning and its raw reply.
 *
 * PRIVACY / COST. Every entry point is a no-op unless isDevModeActive() — no
 * student install ever writes a byte here, so this adds no storage and no
 * privacy surface. The cost on a normal install is one chrome.storage.local
 * read per solve (the server-issued owner-marker check), which is not worth caching against a
 * call that then waits ten to sixty seconds on a provider. Traces stay on the
 * device: nothing
 * uploads them, and «Удалить все локальные данные» removes them with everything
 * else (they live under the same chrome.storage.local this project already
 * wipes). Recording is best-effort throughout: a failed trace write must never
 * turn a solved test into an error.
 */

import { isDevModeActive } from './dev-mode.js';

export const DEV_TRACE_KEY = 'devTraces';

// Twelve pages of history is enough to compare a bad run against the last good
// one without turning storage.local into a log file. Each entry is bounded
// below, so the worst case is roughly 12 × 60 KB.
export const MAX_DEV_TRACES = 12;

// Page text is already capped at 15 000 chars upstream (pill-dom-capture.js).
// Reasoning is the unbounded one — a medium-effort pass over six algebra tasks
// can run very long, and the tail is the part that reaches the answer, so keep
// the tail rather than the head when trimming.
const MAX_FIELD_CHARS = {
  systemPrompt: 4000,
  userText: 20000,
  pageText: 20000,
  reasoning: 40000,
  rawAnswer: 20000,
  error: 2000,
};

function clipHead(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[обрезано ${text.length - limit} симв.]`;
}

function clipTail(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `…[начало обрезано, ${text.length - limit} симв.]\n${text.slice(text.length - limit)}`;
}

/** Bound every free-text field and drop anything the UI does not render. */
function normalizeTrace(trace) {
  const entry = {
    id: crypto.randomUUID(),
    at: Date.now(),
    kind: String(trace?.kind || 'test'),
    ok: trace?.ok !== false,
    durationMs: Number.isFinite(trace?.durationMs) ? Math.round(trace.durationMs) : null,
    provider: trace?.provider ? String(trace.provider).slice(0, 40) : null,
    model: trace?.model ? String(trace.model).slice(0, 120) : null,
    effort: trace?.effort ? String(trace.effort).slice(0, 20) : null,
    url: typeof trace?.url === 'string' ? trace.url.slice(0, 400) : null,
    hasVisualMedia: trace?.hasVisualMedia === true,
    screenshot: trace?.screenshot === true,
    cached: trace?.cached === true,
    questionCount: Number.isInteger(trace?.questionCount) ? trace.questionCount : null,
    pageTextChars: Number.isInteger(trace?.pageTextChars) ? trace.pageTextChars : null,
    // Answers the checker rewrote (lib/test-answer-arithmetic.js). A non-empty
    // list means the model showed correct working and then wrote something
    // different — the exact failure that checker exists for, and worth seeing
    // rather than silently absorbing.
    corrections: Array.isArray(trace?.corrections)
      ? trace.corrections.slice(0, 40).map((correction) => ({
        index: String(correction?.index ?? '').slice(0, 40),
        from: String(correction?.from ?? '').slice(0, 200),
        to: String(correction?.to ?? '').slice(0, 200),
        work: String(correction?.work ?? '').slice(0, 200),
      }))
      : [],
    // One record per answer, including the ones nothing could check. Without
    // this, "no corrections" reads as "everything verified" when it can equally
    // mean "nothing was checkable" — the difference matters when you are
    // deciding whether to trust a test.
    checks: Array.isArray(trace?.checks)
      ? trace.checks.slice(0, 60).map((check) => ({
        index: String(check?.index ?? '').slice(0, 40),
        status: ['verified', 'fixed', 'unchecked'].includes(check?.status)
          ? check.status : 'unchecked',
        reason: String(check?.reason ?? '').slice(0, 120),
      }))
      : [],
    usage: trace?.usage && typeof trace.usage === 'object' && !Array.isArray(trace.usage)
      ? {
        prompt: Number(trace.usage.prompt_tokens) || null,
        completion: Number(trace.usage.completion_tokens) || null,
        total: Number(trace.usage.total_tokens) || null,
      }
      : null,
  };
  for (const [field, limit] of Object.entries(MAX_FIELD_CHARS)) {
    if (trace?.[field] == null) continue;
    // Reasoning is the one field whose END matters most; everything else reads
    // from the top.
    entry[field] = field === 'reasoning'
      ? clipTail(trace[field], limit)
      : clipHead(trace[field], limit);
  }
  return entry;
}

// One read-modify-write queue: solveTest and a parallel pill page can settle in
// the same tick, and a lost update would silently drop the trace you are
// looking for. Mirrors lib/test-answer-cache.js.
let traceQueue = Promise.resolve();

/**
 * Append one trace. No-op (and never throws) unless dev mode is on.
 * @returns {Promise<boolean>} whether an entry was actually stored.
 */
export function recordDevTrace(trace) {
  const run = traceQueue.then(async () => {
    if (!(await isDevModeActive())) return false;
    const entry = normalizeTrace(trace);
    const { [DEV_TRACE_KEY]: stored } = await chrome.storage.local.get(DEV_TRACE_KEY);
    const traces = Array.isArray(stored) ? stored : [];
    // Newest first: the UI renders in order and the tail is what ages out.
    const next = [entry, ...traces].slice(0, MAX_DEV_TRACES);
    await chrome.storage.local.set({ [DEV_TRACE_KEY]: next });
    return true;
  });
  traceQueue = run.catch(() => {});
  return run.catch(() => false);
}

/** @returns {Promise<object[]>} newest first; [] when off or unreadable. */
export async function readDevTraces() {
  try {
    if (!(await isDevModeActive())) return [];
    const { [DEV_TRACE_KEY]: stored } = await chrome.storage.local.get(DEV_TRACE_KEY);
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

export async function clearDevTraces() {
  try {
    await chrome.storage.local.remove(DEV_TRACE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect a provider's reasoning deltas into one bounded string.
 *
 * Bounded HERE rather than at write time because the deltas arrive during the
 * request: an unbounded accumulator on a runaway reasoning pass would grow in
 * memory for the whole call, and the service worker has far less headroom than
 * a page. Keeps the TAIL, matching normalizeTrace.
 */
export function createReasoningCollector(limit = MAX_FIELD_CHARS.reasoning) {
  let text = '';
  let dropped = 0;
  return {
    push(chunk) {
      text += String(chunk ?? '');
      if (text.length > limit) {
        dropped += text.length - limit;
        text = text.slice(text.length - limit);
      }
    },
    value() {
      if (!text) return '';
      return dropped ? `…[начало обрезано, ${dropped} симв.]\n${text}` : text;
    },
  };
}

/**
 * Usage analytics: ingest + admin aggregation queries (D1).
 *
 * Ingest (`POST /t`) accepts only a short-lived capability issued by a
 * successful `/verify` for the same device. The extension fires small,
 * CONTENT-FREE batches (no task text or answers). Token/cost accounting is
 * accepted only from the authenticated server-to-server `/t/ai` path.
 * Everything else here is admin-only aggregation for the dashboard
 * (ayeepat.github.io/smeshaidashboard), guarded in worker.js.
 *
 * Days are MOSCOW calendar days (UTC+3): the audience is Russian students,
 * so "today" must be their today. All aggregates key on events.day, which is
 * computed server-side from the (clamped) event timestamp.
 *
 * KV stays the source of truth for licenses; `purchases` is a queryable
 * mirror (see mirrorLicense + backfillLicenses).
 */

import { getLicense, markMaterialized } from './licenses.js';
import { cleanDeviceId, cleanPublicDeviceId } from './referrals.js';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_INGEST_BODY_BYTES = 64 * 1024;
const MAX_DELETE_BODY_BYTES = 4 * 1024;
const INGEST_IP_DAILY_LIMIT = 500;
const INGEST_DEVICE_DAILY_LIMIT = 300;

export function mskDay(ts = Date.now()) {
  return new Date(ts + MSK_OFFSET_MS).toISOString().slice(0, 10);
}
const daysBack = (n) => mskDay(Date.now() - n * DAY_MS);

// Full inclusive day list from `from` (YYYY-MM-DD) through today — the chart
// x-axis, so days with zero rows still render as zero instead of vanishing.
function dayRange(from) {
  const out = [];
  let t = Date.parse(from + 'T00:00:00Z');
  const end = Date.parse(mskDay() + 'T00:00:00Z');
  for (; t <= end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* ------------------------------ ingest ------------------------------- */

const EVENT_TYPES = new Set([
  'install', 'update', 'heartbeat',
  'solve', 'test_solve', 'test_requestion', 'gdz_pull', 'error'
]);
const BROWSERS = new Set(['chrome', 'yandex', 'opera', 'edge', 'firefox', 'other']);
const PROVIDERS = new Set(['openrouter', 'groq', 'qwen', 'deepseek']);
const LICENSE_TYPES = new Set(['lifetime', 'subscription', 'none']);
const MODELS = new Set([
  'google/gemini-2.5-flash',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen3.7-plus',
  'qwen-vl-plus',
  'qwen-plus',
  'deepseek-v4-flash'
]);
// "Real usage" = a student actually used a feature (heartbeats/installs/errors
// mark activity but are not usage).
const USE_TYPES = "('solve','test_solve','test_requestion','gdz_pull')";

const clampInt = (v, max) => Math.max(0, Math.min(max, Math.round(num(v))));

// "Content-free" is enforced at this boundary, not assumed of clients: a
// buggy or malicious sender must not be able to persist task text, answers,
// filenames, or credential-like strings through `meta` or `subject`.
//
// String meta values are limited to the exact short vocabulary the extension
// and the VPS proxy actually emit (see service-worker.js track() call sites
// and backend-vps jobTimings). Numeric/boolean metrics also require an exact
// key and per-key type/range, so content cannot be encoded in arbitrary keys.
const META_STRING_VALUES = {
  mode: new Set(['brief', 'explain']),
  engine: new Set(['auto', 'think']),
  category: new Set([
    'worked_solution', 'direct_answer', 'paragraph_summary',
    'russian_full', 'literature', 'test_answer'
  ]),
  effort: new Set(['low', 'medium', 'high']),
  effort_reason: new Set(['engine_auto', 'easy', 'chatty', 'followup']),
  source: new Set(['manual', 'lesson']),
  src: new Set(['vps']),
  code: new Set([
    'consent_required', 'license_invalid', 'key_missing', 'capture_failed',
    'rate_limited', 'provider_timeout', 'provider_http', 'network', 'other'
  ]),
  op: new Set([
    'GET_ACTION_TOKEN', 'OPEN_DASHBOARD', 'SOLVE', 'SOLVE_TEST',
    'FILL_ANSWERS_ALL', 'FILL_ANSWERS_TAB', 'TEST_PAGE_SIG',
    'TEST_NEXT_PAGE', 'PILL_SOLVE_PAGE', 'PILL_SOLVE_ALL',
    'RESOLVE_QUESTION', 'GET_RUNTIME_CONFIG', 'CONSUME_DASH_LAUNCH',
    'CLASSIFY_TASKS', 'OPENROUTER_CREDITS', 'DOWNLOAD_FILES',
    'LIST_SESSIONS', 'LIST_MESSAGES', 'GDZ_CATALOG', 'GDZ_SEARCH',
    'GDZ_RESOLVE', 'GDZ_FOR_TASK', 'GDZ_BOOK_ADD', 'GDZ_BOOK_REMOVE',
    'GDZ_SELFTEST', 'solve_stream'
  ])
};
const META_BOOLEAN_KEYS = new Set(['ok', 'est_rates']);
const META_NUMBER_FIELDS = {
  followup: { min: 0, max: 1, integer: true },
  gdz_auto: { min: 0, max: 100, integer: true },
  images: { min: 0, max: 100, integer: true },
  books: { min: 0, max: 100, integer: true },
  connect_ms: { min: 0, max: 3_600_000, integer: true },
  resp_ms: { min: 0, max: 3_600_000, integer: true },
  ttft_ms: { min: 0, max: 3_600_000, integer: true },
  stream_ms: { min: 0, max: 3_600_000, integer: true },
  total_ms: { min: 0, max: 3_600_000, integer: true },
  tok_per_s: { min: 0, max: 10_000, integer: false }
};
const META_MAX_ENTRIES = 12;

function sanitizeVersion(value) {
  if (!/^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(value)) return null;
  return value.split('.').every((part) => Number(part) <= 65535) ? value : null;
}

// Every meta lookup below resolves OWN properties only. A bare
// META_STRING_VALUES[key] also returns Object.prototype members, so a caller
// key of "constructor" produced `Object` — truthy, so `?.` did not guard — and
// `Object.has(...)` is not a function, which turned one ingest field into an
// uncaught TypeError and a 500 that dropped the whole event batch.
const metaStringVocabulary = (key) =>
  (typeof key === 'string' && Object.hasOwn(META_STRING_VALUES, key)) ? META_STRING_VALUES[key] : null;
const metaNumberField = (key) =>
  (typeof key === 'string' && Object.hasOwn(META_NUMBER_FIELDS, key)) ? META_NUMBER_FIELDS[key] : null;

function sanitizeMetaString(key, value) {
  if (typeof value !== 'string') return null;
  if (key === 'from') return sanitizeVersion(value);
  return metaStringVocabulary(key)?.has(value) ? value : null;
}

function sanitizeMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = Object.create(null);
  let entries = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (entries >= META_MAX_ENTRIES) break;
    if (META_BOOLEAN_KEYS.has(key) && typeof value === 'boolean') {
      out[key] = value;
      entries++;
      continue;
    }
    const numberField = metaNumberField(key);
    if (numberField && typeof value === 'number' && Number.isFinite(value)) {
      const bounded = Math.max(numberField.min, Math.min(numberField.max, value));
      out[key] = numberField.integer ? Math.round(bounded) : bounded;
      entries++;
      continue;
    }
    if (key === 'from' || metaStringVocabulary(key)) {
      const safe = sanitizeMetaString(key, value);
      if (safe != null) { out[key] = safe; entries++; }
    }
  }
  if (!entries) return null;
  try { return JSON.stringify({ ...out }).slice(0, 400); } catch { return null; }
}

const SUBJECT_VOCABULARY = [
  [/русск[^\n]*язык/, 'Русский язык'],
  [/родн[^\n]*литератур/, 'Родная литература'],
  [/родн[^\n]*язык/, 'Родной язык'],
  [/литератур/, 'Литература'],
  [/англ/, 'Английский язык'],
  [/немец/, 'Немецкий язык'],
  [/француз/, 'Французский язык'],
  [/испан/, 'Испанский язык'],
  [/китай/, 'Китайский язык'],
  [/иностран/, 'Иностранный язык'],
  [/вероятн|статистик/, 'Вероятность и статистика'],
  [/алгебр/, 'Алгебра'],
  [/геометр/, 'Геометрия'],
  [/математ/, 'Математика'],
  [/физическ[^\n]*культур|физкультур/, 'Физическая культура'],
  [/физик/, 'Физика'],
  [/хими/, 'Химия'],
  [/информат/, 'Информатика'],
  [/астроном/, 'Астрономия'],
  [/истори/, 'История'],
  [/обществ/, 'Обществознание'],
  [/географ/, 'География'],
  [/биолог/, 'Биология'],
  [/обж|безопасност/, 'ОБЖ'],
  [/технолог/, 'Технология'],
  [/музык/, 'Музыка'],
  [/изобраз|\bизо\b/, 'ИЗО'],
  [/мхк|искусств/, 'Искусство'],
  [/экономик/, 'Экономика'],
  [/право/, 'Право'],
  [/окружающ[^\n]*мир/, 'Окружающий мир'],
  [/естествознан/, 'Естествознание']
];

// Subject is an aggregate dimension, not a free-text field. Recognize known
// school-course stems and store only the fixed canonical label; unknown input
// becomes NULL, so task text/answers/credentials cannot ride through it.
function sanitizeSubject(raw) {
  if (typeof raw !== 'string') return null;
  const normalized = raw.slice(0, 160).toLowerCase().replace(/ё/g, 'е');
  for (const [pattern, canonical] of SUBJECT_VOCABULARY) {
    if (pattern.test(normalized)) return canonical;
  }
  return null;
}

const sanitizeProvider = (raw) => typeof raw === 'string' && PROVIDERS.has(raw) ? raw : null;
const sanitizeModel = (raw) => typeof raw === 'string' && MODELS.has(raw) ? raw : null;
const sanitizeLicenseType = (raw) =>
  typeof raw === 'string' && LICENSE_TYPES.has(raw) ? raw : null;

// /t/delete tombstones: an ingest admitted before a deletion must not be able
// to recreate the erased device afterwards. Both ingest paths embed this
// freshness check INSIDE their insert statements (D1 serializes writers, so
// the check cannot race the delete batch). After the TTL a still-opted-in
// install may legitimately report again.
const TOMBSTONE_TTL_MS = 15 * 60 * 1000;
const tombstoneCutoff = () => Date.now() - TOMBSTONE_TTL_MS;

async function readJsonBounded(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'too_large', status: 413 };
  }
  if (typeof request.body?.getReader !== 'function') {
    return { ok: false, reason: 'bad_body', status: 400 };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('request body too large'); } catch { /* already closed */ }
        return { ok: false, reason: 'too_large', status: 413 };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: 'bad_json', status: 400 };
  }
}

/* ---------------- shared atomic daily budgets (D1) ---------------- */
// Admission counters live in D1, not KV. The UPSERT is one authoritative,
// atomic increment, so synchronized requests cannot all observe the same old
// value and overwrite one another.
//
// The limiter must also protect the resource it meters: without the
// per-isolate cache below, every request REJECTED for being over budget would
// still cost a D1 write, so sustained abuse keeps consuming the database
// forever. Once this isolate has seen D1 declare a key over its limit for the
// current window, later hits short-circuit in memory. The cache only replays
// verdicts D1 already made — admissions always go through the shared counter.
const blockedBudgets = new Map(); // `${scope}|${key}` -> window (day) seen over-limit
let blockedBudgetWindow = null;

function enterBudgetWindow(day) {
  // Do not retain yesterday's raw IP/device keys in a long-lived isolate. The
  // cache is only an optimization for one daily window; clearing it cannot
  // admit anything incorrectly because D1 remains the authoritative counter.
  if (blockedBudgetWindow !== day) {
    blockedBudgets.clear();
    blockedBudgetWindow = day;
  }
}

export function budgetBlockedToday(day, scope, key) {
  enterBudgetWindow(day);
  return blockedBudgets.get(`${scope}|${key}`) === day;
}

export function markBudgetBlocked(day, scope, key) {
  enterBudgetWindow(day);
  // Crude size bound; a cleared cache simply repopulates from D1 verdicts.
  if (blockedBudgets.size > 10_000) blockedBudgets.clear();
  blockedBudgets.set(`${scope}|${key}`, day);
}

export async function bumpDailyBudget(env, day, scope, key, amount, limit) {
  if (limit > 0 && budgetBlockedToday(day, scope, key)) return limit + amount;
  const boundedAmount = Math.max(1, Math.trunc(Number(amount) || 1));
  let rawCount;
  if (limit > 0) {
    // Saturate at limit+1 and then stop mutating the row. This is shared D1
    // state, so it protects the database even when abuse fans out across
    // isolates whose in-memory blocked caches do not overlap.
    rawCount = await env.DB.prepare(
      `INSERT INTO telemetry_budget (day, scope, budget_key, count)
       VALUES (?1, ?2, ?3, MIN(?4, ?5))
       ON CONFLICT(day, scope, budget_key) DO UPDATE SET
         count = MIN(telemetry_budget.count + excluded.count, ?5)
       WHERE telemetry_budget.count <= ?6
       RETURNING count`
    ).bind(day, scope, key, boundedAmount, limit + 1, limit).first('count');
  } else {
    rawCount = await env.DB.prepare(
      `INSERT INTO telemetry_budget (day, scope, budget_key, count) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(day, scope, budget_key) DO UPDATE SET count = count + excluded.count
       RETURNING count`
    ).bind(day, scope, key, boundedAmount).first('count');
  }
  // A saturated row deliberately performs no UPDATE and therefore returns no
  // row. Treat it as blocked without reopening a write path.
  const count = rawCount == null ? limit + boundedAmount : Number(rawCount) || 0;
  if (limit > 0 && count > limit) markBudgetBlocked(day, scope, key);
  return count;
}

// Reserve one unit before an expensive operation whose final verdict decides
// whether the unit should remain charged. Unlike bumpDailyBudget(), this does
// not use the day-long blocked cache: a later successful operation can refund
// a reservation, so a permanent per-isolate negative cache would incorrectly
// keep rejecting after the authoritative D1 count fell below the limit.
export async function reserveDailyBudget(env, day, scope, key, amount, limit) {
  const boundedAmount = Math.max(1, Math.trunc(Number(amount) || 1));
  const rawCount = await env.DB.prepare(
    `INSERT INTO telemetry_budget (day, scope, budget_key, count)
     SELECT ?1, ?2, ?3, ?4
     WHERE ?4 <= ?5
     ON CONFLICT(day, scope, budget_key) DO UPDATE SET
       count = telemetry_budget.count + excluded.count
     WHERE telemetry_budget.count + excluded.count <= ?5
     RETURNING count`
  ).bind(day, scope, key, boundedAmount, limit).first('count');
  // A reservation that would cross the limit deliberately performs no INSERT
  // or UPDATE and therefore returns no row. Report an over-limit sentinel to
  // the caller without persisting it: only admitted work may later be
  // refunded, so a rejected concurrent reservation must never leave a +1
  // balance that falsely keeps the shared source blocked.
  return rawCount == null ? limit + boundedAmount : Number(rawCount) || 0;
}

// Refund a reservation after the expensive operation proved non-anonymous
// (valid, expired, revoked, unavailable, etc.). The atomic decrement composes
// with concurrent reservations; a missing/pruned row is already equivalent to
// zero. Rows remain at zero so no delete-vs-insert race can lose an increment.
export async function releaseDailyBudget(env, day, scope, key, amount = 1) {
  const boundedAmount = Math.max(1, Math.trunc(Number(amount) || 1));
  const rawCount = await env.DB.prepare(
    `UPDATE telemetry_budget
     SET count = MAX(0, count - ?4)
     WHERE day = ?1 AND scope = ?2 AND budget_key = ?3
     RETURNING count`
  ).bind(day, scope, key, boundedAmount).first('count');
  return rawCount == null ? 0 : Number(rawCount) || 0;
}

// IP limits bound device-id rotation; device limits keep one install from
// consuming the whole shared IP allowance.
async function chargeIngestBudget(env, ip, device, n) {
  const day = mskDay();
  const ipUsed = await bumpDailyBudget(env, day, 'ip', ip || 'unknown', n, INGEST_IP_DAILY_LIMIT);
  if (ipUsed > INGEST_IP_DAILY_LIMIT) return 'rate_limited';
  if (budgetBlockedToday(day, 'device', device)) return 'rate_limited';
  // The conditional insert and tombstone test are one SQLite statement. If a
  // deletion linearized first, an in-flight ingest may still consume its IP
  // abuse budget but cannot recreate the erased device-scoped identifier row.
  const rawDeviceUsed = await env.DB.prepare(
    `INSERT INTO telemetry_budget (day, scope, budget_key, count)
     SELECT ?1, 'device', ?2, MIN(?3, ?5)
     WHERE NOT EXISTS (
       SELECT 1 FROM device_tombstones WHERE device_id = ?2 AND deleted_at > ?4
     )
     ON CONFLICT(day, scope, budget_key) DO UPDATE SET
       count = MIN(telemetry_budget.count + excluded.count, ?5)
     WHERE telemetry_budget.count <= ?6
     RETURNING count`
  ).bind(
    day, device, n, tombstoneCutoff(),
    INGEST_DEVICE_DAILY_LIMIT + 1, INGEST_DEVICE_DAILY_LIMIT
  ).first('count');
  // No returned row means either a fresh deletion tombstone suppressed the
  // insert or a saturated shared row suppressed another rejected write. Both
  // cases stop before persistence. A locally known saturation keeps the
  // explicit 429; the indistinguishable cross-isolate/tombstone case is a
  // successful no-op so an erasure does not create a retry loop.
  if (rawDeviceUsed == null) {
    return budgetBlockedToday(day, 'device', device) ? 'rate_limited' : 'suppressed';
  }
  const deviceUsed = Number(rawDeviceUsed) || 0;
  if (deviceUsed > INGEST_DEVICE_DAILY_LIMIT) markBudgetBlocked(day, 'device', device);
  return deviceUsed <= INGEST_DEVICE_DAILY_LIMIT ? 'allowed' : 'rate_limited';
}

/**
 * POST /t — body:
 * { device_id, browser, version, provider, license_type,
 *   events: [{ ts, type, subject, provider, model, tokens_in, tokens_out,
 *              cost_usd, files_pdf, files_img, meta }] }
 * (legacy clients may still send license_key/ua — both are discarded)
 * Returns {ok:true, accepted:N}. Never throws on bad fields — they're clamped
 * or dropped, because a telemetry write must never break the extension.
 */
export async function handleIngest(request, env, attestedDeviceId) {
  const parsed = await readJsonBounded(request, MAX_INGEST_BODY_BYTES);
  if (!parsed.ok) return parsed;
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'bad_json', status: 400 };
  }

  const device = cleanPublicDeviceId(body.device_id);
  if (!device) return { ok: false, reason: 'bad_device', status: 400 };
  if (!attestedDeviceId || device !== cleanPublicDeviceId(attestedDeviceId)) {
    return { ok: false, reason: 'device_mismatch', status: 403 };
  }

  const rawEvents = Array.isArray(body.events) ? body.events.slice(0, 25) : [];
  const now = Date.now();
  const events = [];
  for (const e of rawEvents) {
    if (!e || !EVENT_TYPES.has(e.type)) continue;
    // Clamp the client clock: at most 7 days late (an offline buffer), never
    // from the future.
    let ts = num(e.ts) || now;
    if (ts > now + 5 * 60 * 1000 || ts < now - 7 * DAY_MS) ts = now;
    events.push({
      ts,
      day: mskDay(ts),
      type: e.type,
      subject: sanitizeSubject(e.subject),
      provider: sanitizeProvider(e.provider),
      model: sanitizeModel(e.model),
      // Browser telemetry is attested to a paid device but remains
      // self-reported. Never turn those caller-chosen numbers into
      // financial-looking dashboard totals. Provider-observed token/cost
      // truth arrives separately through the INGEST_KEY-gated /t/ai path.
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      files_pdf: clampInt(e.files_pdf, 20),
      files_img: clampInt(e.files_img, 40),
      meta: sanitizeMeta(e.meta)
    });
  }

  const ip = request.headers.get('cf-connecting-ip') || '';
  const admission = await chargeIngestBudget(env, ip, device, Math.max(1, events.length));
  if (admission === 'rate_limited') {
    return { ok: false, reason: 'rate_limited', status: 429 };
  }
  if (admission === 'suppressed') return { ok: true, accepted: 0 };

  const browser = BROWSERS.has(body.browser) ? body.browser : 'other';
  const cutoff = tombstoneCutoff();
  // Data minimization: raw UA/license credentials from legacy clients are
  // ignored completely. Browser family + declared license type are sufficient
  // for product analytics and cannot be redeemed as bearer credentials.
  // Every insert is gated on the tombstone freshness check INSIDE the
  // statement so an ingest admitted before a /t/delete cannot recreate the
  // erased device afterwards.
  const stmts = [
    env.DB.prepare(
      `INSERT INTO devices (device_id, first_seen, last_seen, browser, ua, version, provider, license_key, license_type)
       SELECT ?1, ?2, ?2, ?3, NULL, ?4, ?5, NULL, ?6
       WHERE NOT EXISTS (
         SELECT 1 FROM device_tombstones WHERE device_id = ?1 AND deleted_at > ?7
       )
       ON CONFLICT(device_id) DO UPDATE SET
         last_seen   = excluded.last_seen,
         browser     = excluded.browser,
         ua          = NULL,
         license_key = NULL,
         version     = excluded.version,
         provider    = COALESCE(excluded.provider, devices.provider),
         license_type= COALESCE(excluded.license_type, devices.license_type)`
    ).bind(
      device, now, browser,
      typeof body.version === 'string' ? sanitizeVersion(body.version) : null,
      sanitizeProvider(body.provider), sanitizeLicenseType(body.license_type), cutoff
    )
  ];
  for (const e of events) {
    stmts.push(env.DB.prepare(
      `INSERT INTO events (ts, day, device_id, type, subject, provider, model,
                           tokens_in, tokens_out, cost_usd, files_pdf, files_img, meta)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
       WHERE NOT EXISTS (
         SELECT 1 FROM device_tombstones WHERE device_id = ?3 AND deleted_at > ?14
       )`
    ).bind(
      e.ts, e.day, device, e.type, e.subject, e.provider, e.model,
      e.tokens_in, e.tokens_out, e.cost_usd, e.files_pdf, e.files_img, e.meta,
      cutoff
    ));
  }
  await env.DB.batch(stmts);
  return { ok: true, accepted: events.length };
}

/**
 * POST /t/delete — erase every analytics row for the device authenticated by
 * the Worker's deletion-only erasure capability. The request body is parsed
 * only for a bounded JSON contract; any caller-supplied device id is ignored.
 */
export async function handleDeleteDevice(request, env, attestedDeviceId = '') {
  const parsed = await readJsonBounded(request, MAX_DELETE_BODY_BYTES);
  if (!parsed.ok) return parsed;
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'bad_json', status: 400 };
  }
  const device = cleanPublicDeviceId(attestedDeviceId);
  if (!device) return { ok: false, reason: 'bad_device', status: 400 };
  const known = await env.DB.prepare(
    `SELECT (
       EXISTS(SELECT 1 FROM devices WHERE device_id = ?1) OR
       EXISTS(SELECT 1 FROM events WHERE device_id = ?1) OR
       EXISTS(SELECT 1 FROM telemetry_budget WHERE scope = 'device' AND budget_key = ?1)
     ) AS known`
  ).bind(device).first('known');
  // Do not let authenticated-but-empty devices churn tombstones. The delete is
  // still idempotently successful from the user's perspective.
  if (Number(known) !== 1) return { ok: true, deleted: false };
  // Tombstone FIRST, in the same atomic batch as the deletes: any ingest
  // write lands either entirely before this batch (its rows are deleted
  // below) or entirely after (its inserts see the tombstone and no-op), so
  // "deleted" can no longer be silently undone by an in-flight request.
  // Admission budgets keyed by this device id are personal identifiers too
  // and must not survive the user's erasure.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO device_tombstones (device_id, deleted_at) VALUES (?1, ?2)
       ON CONFLICT(device_id) DO UPDATE SET deleted_at = excluded.deleted_at`
    ).bind(device, Date.now()),
    env.DB.prepare('DELETE FROM events  WHERE device_id = ?').bind(device),
    env.DB.prepare('DELETE FROM devices WHERE device_id = ?').bind(device),
    env.DB.prepare(
      "DELETE FROM telemetry_budget WHERE scope = 'device' AND budget_key = ?"
    ).bind(device)
  ]);
  blockedBudgets.delete(`device|${device}`);
  return { ok: true, deleted: true };
}

/* ----------------------- retention enforcement ------------------------ */

const BUDGET_RETENTION_DAYS = 7;
const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ANALYTICS_RETENTION_DAYS = 90;
const MIN_ANALYTICS_RETENTION_DAYS = 30;
const MAX_ANALYTICS_RETENTION_DAYS = 365;

function analyticsRetentionDays(env) {
  const configured = Number(env?.ANALYTICS_RETENTION_DAYS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_ANALYTICS_RETENTION_DAYS;
  }
  return Math.max(
    MIN_ANALYTICS_RETENTION_DAYS,
    Math.min(MAX_ANALYTICS_RETENTION_DAYS, Math.trunc(configured))
  );
}

/**
 * Cron-driven lifecycle enforcement for the identifier-bearing bookkeeping
 * tables. Budget rows carry raw IPs, device ids, and Telegram uids for abuse
 * control; they are operationally dead after a few days and must not
 * accumulate into a permanent identifier log. proxy_quota rows for past days
 * are dead weight by contract (schema.sql), and tombstones only need to
 * outlive their 15-minute TTL. Pseudonymous product events and inactive
 * device rows also have a finite lifecycle (90 days by default, configurable
 * from 30–365 days) in addition to immediate per-device erasure via /t/delete.
 * Deletes are cheap no-ops when nothing is due (day is the PK prefix).
 */
export async function pruneExpiredAnalytics(env) {
  if (!env.DB) return { pruned: false };
  const now = Date.now();
  // Keep exactly seven Moscow calendar buckets: today plus the previous six.
  // Subtracting seven days and deleting `< cutoff` retained an eighth bucket
  // (the day exactly seven days ago).
  const dayCutoff = mskDay(now - (BUDGET_RETENTION_DAYS - 1) * DAY_MS);
  const analyticsDays = analyticsRetentionDays(env);
  const analyticsCutoffMs = now - analyticsDays * DAY_MS;
  const analyticsDayCutoff = mskDay(analyticsCutoffMs);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM telemetry_budget WHERE day < ?1').bind(dayCutoff),
    env.DB.prepare('DELETE FROM proxy_quota WHERE day < ?1').bind(dayCutoff),
    env.DB.prepare('DELETE FROM device_tombstones WHERE deleted_at < ?1')
      .bind(now - TOMBSTONE_RETENTION_MS),
    env.DB.prepare('DELETE FROM events WHERE ts < ?1').bind(analyticsCutoffMs),
    // Keep a device if any retained event contradicts a stale last_seen value.
    // This is defensive against historic/imported rows whose mirror timestamp
    // was incomplete; the event is more useful than the denormalized field.
    env.DB.prepare(
      `DELETE FROM devices
       WHERE last_seen < ?1
         AND NOT EXISTS (
           SELECT 1 FROM events
           WHERE events.device_id = devices.device_id AND events.ts >= ?1
         )`
    ).bind(analyticsCutoffMs)
  ]);
  return {
    pruned: true,
    budget_before_day: dayCutoff,
    analytics_before_day: analyticsDayCutoff,
    analytics_retention_days: analyticsDays
  };
}

/* --------------------------- server ingest ---------------------------- */

/**
 * POST /t/ai — opted-in SERVER-observed AI calls from the VPS proxy
 * (INGEST_KEY-gated in worker.js; never reachable from a browser). The proxy
 * emits these only when the request carries the extension's strict telemetry
 * opt-in. Stored under their own type ('ai_call') — which the open
 * /t endpoint refuses (EVENT_TYPES), so clients cannot forge server rows —
 * and aggregated separately from client-reported stats (see usageRollup).
 * Content-free like /t: device id, provider, model, token counts, estimated
 * cost. No license key, no task text.
 *
 * Body: { events: [{ device_id, ts, provider, model, tokens_in, tokens_out,
 *                    cost_usd, meta }] } → { ok:true, accepted:N }
 */
const MAX_SERVER_EVENTS = 50;

export async function handleServerIngest(request, env) {
  const parsed = await readJsonBounded(request, MAX_INGEST_BODY_BYTES);
  if (!parsed.ok) return parsed;
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'bad_json', status: 400 };
  }
  const rawEvents = Array.isArray(body.events) ? body.events.slice(0, MAX_SERVER_EVENTS) : [];
  const now = Date.now();
  const stmts = [];
  let accepted = 0;
  for (const e of rawEvents) {
    const device = cleanPublicDeviceId(e?.device_id);
    if (!device) continue;
    let ts = num(e.ts) || now;
    if (ts > now + 5 * 60 * 1000 || ts < now - 7 * DAY_MS) ts = now;
    // The device row may not exist yet — server events arrive even for
    // installs that never opted into client telemetry. Create a minimal row
    // so per-user drilldowns and the users table can join; never move
    // first_seen forward or clobber client-reported fields. Same tombstone
    // gate and meta minimization as the open /t path: the VPS is trusted,
    // but the stored shape stays uniformly content-free.
    const cutoff = tombstoneCutoff();
    stmts.push(env.DB.prepare(
      `INSERT INTO devices (device_id, first_seen, last_seen)
       SELECT ?1, ?2, ?2
       WHERE NOT EXISTS (
         SELECT 1 FROM device_tombstones WHERE device_id = ?1 AND deleted_at > ?3
       )
       ON CONFLICT(device_id) DO UPDATE SET
         last_seen = MAX(devices.last_seen, excluded.last_seen)`
    ).bind(device, ts, cutoff));
    stmts.push(env.DB.prepare(
      `INSERT INTO events (ts, day, device_id, type, subject, provider, model,
                           tokens_in, tokens_out, cost_usd, files_pdf, files_img, meta)
       SELECT ?1, ?2, ?3, 'ai_call', NULL, ?4, ?5, ?6, ?7, ?8, 0, 0, ?9
       WHERE NOT EXISTS (
         SELECT 1 FROM device_tombstones WHERE device_id = ?3 AND deleted_at > ?10
       )`
    ).bind(
      ts, mskDay(ts), device,
      sanitizeProvider(e.provider), sanitizeModel(e.model),
      clampInt(e.tokens_in, 5_000_000), clampInt(e.tokens_out, 5_000_000),
      Math.max(0, Math.min(50, num(e.cost_usd))),
      sanitizeMeta(e.meta), cutoff
    ));
    accepted++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, accepted };
}

/* ------------------------- license mirroring -------------------------- */

/**
 * Mirror one KV license row into `purchases`. Best-effort by contract: a D1
 * hiccup must NEVER fail a payment webhook or a /verify device add, so the
 * caller (putLicense) swallows rejections.
 */
export async function mirrorLicense(env, license) {
  if (!env.DB || !license?.key) return;
  let amountKopecks = license.amount_kopecks;
  if (amountKopecks == null && license.amount_rub != null) {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(license.amount_rub));
    amountKopecks = match
      ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'))
      : null;
  }
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) amountKopecks = null;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO purchases
       (license_key, gateway, payment_id, type, status, amount_rub, amount_kopecks,
        email, telegram_user_id, issued_at, expires_at, is_preorder, note, device_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    license.key,
    license.gateway || null,
    license.payment_id || null,
    license.type || null,
    license.status || null,
    amountKopecks == null ? null : amountKopecks / 100,
    amountKopecks,
    license.email || null,
    license.telegram_user_id == null ? null : String(license.telegram_user_id),
    license.issued_at ? Date.parse(license.issued_at) || null : null,
    license.expires_at ? Date.parse(license.expires_at) || null : null,
    license.is_preorder ? 1 : 0,
    license.note || null,
    JSON.stringify(license.device_ids || [])
  ).run();
}

/** Re-sync every KV license into D1. Returns {imported}. */
export async function backfillLicenses(env) {
  let cursor, imported = 0;
  do {
    const page = await env.LICENSES.list({ prefix: 'SMESH-', cursor, limit: 1000 });
    for (const k of page.keys) {
      const raw = await env.LICENSES.get(k.name);
      if (!raw) continue;
      let license;
      try { license = JSON.parse(raw); } catch { continue; }
      if (!license?.key) continue;
      await mirrorLicense(env, license);
      // Seed the write-once materialization flag for rows created before the
      // kv_materializations table existed: a listed row provably exists, so a
      // payment-webhook replay must never rewrite its issue-time snapshot.
      await markMaterialized(env, `license:${license.key}`);
      imported++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  // Same protection for referral records that predate the flag table: their
  // counters/reward pointers must never be reset by a claim recovery either.
  let refCursor, refsFlagged = 0;
  do {
    const page = await env.LICENSES.list({ prefix: 'ref:', cursor: refCursor, limit: 1000 });
    for (const k of page.keys) {
      await markMaterialized(env, k.name);
      refsFlagged++;
    }
    refCursor = page.list_complete ? null : page.cursor;
  } while (refCursor);
  return { imported, refs_flagged: refsFlagged };
}

/** Purge legacy identifiers across both pre- and post-license_ref schemas. */
export async function purgeLegacyIdentifiers(env) {
  try {
    const result = await env.DB.prepare(
      `UPDATE devices SET ua = NULL, license_key = NULL, license_ref = NULL
       WHERE ua IS NOT NULL OR license_key IS NOT NULL OR license_ref IS NOT NULL`
    ).run();
    return { rows: Number(result?.meta?.changes) || 0, pseudonym_column: true };
  } catch {
    // Older databases never received license_ref; the raw columns still exist
    // and must be purged without making that optional migration a dependency.
    const result = await env.DB.prepare(
      `UPDATE devices SET ua = NULL, license_key = NULL
       WHERE ua IS NOT NULL OR license_key IS NOT NULL`
    ).run();
    return { rows: Number(result?.meta?.changes) || 0, pseudonym_column: false };
  }
}

/* ----------------------------- aggregates ---------------------------- */

// Shared usage rollup over an events window (day >= from, or all time).
// Two disjoint series live in `events`: client-reported telemetry (opt-in;
// solve/test/gdz/…) and SERVER-observed 'ai_call' rows from the VPS proxy.
// A student with telemetry ON produces BOTH a 'solve' and an 'ai_call' for
// the same request, so token/cost sums must never mix the two: the classic
// fields stay client-only, and the server truth comes back as api_*.
async function usageRollup(env, from, to = null) {
  const where = from
    ? (to ? 'WHERE day >= ?1 AND day < ?2' : 'WHERE day >= ?1')
    : '';
  const binds = from ? (to ? [from, to] : [from]) : [];
  const row = await env.DB.prepare(
    `SELECT
       SUM(type != 'ai_call')                          AS events,
       SUM(type IN ${USE_TYPES})                       AS uses,
       SUM(type = 'solve')                             AS solves,
       SUM(type = 'test_solve')                        AS tests,
       SUM(type = 'test_requestion')                   AS requestions,
       SUM(type = 'gdz_pull')                          AS gdz,
       SUM(CASE WHEN files_pdf > 0 THEN 1 ELSE 0 END)  AS pdf_solves,
       SUM(files_pdf)                                  AS pdf_files,
       SUM(CASE WHEN files_img > 0 THEN 1 ELSE 0 END)  AS img_solves,
       SUM(files_img)                                  AS img_files,
       SUM(type = 'error')                             AS errors,
       SUM(CASE WHEN type != 'ai_call' THEN tokens_in  ELSE 0 END) AS tokens_in,
       SUM(CASE WHEN type != 'ai_call' THEN tokens_out ELSE 0 END) AS tokens_out,
       SUM(CASE WHEN type != 'ai_call' THEN cost_usd   ELSE 0 END) AS cost_usd,
       COUNT(DISTINCT CASE WHEN type != 'ai_call' THEN device_id END)              AS active_devices,
       COUNT(DISTINCT CASE WHEN type != 'ai_call' THEN device_id || ':' || day END) AS device_days,
       SUM(type = 'ai_call')                           AS api_calls,
       SUM(CASE WHEN type = 'ai_call' THEN tokens_in  ELSE 0 END) AS api_tokens_in,
       SUM(CASE WHEN type = 'ai_call' THEN tokens_out ELSE 0 END) AS api_tokens_out,
       SUM(CASE WHEN type = 'ai_call' THEN cost_usd   ELSE 0 END) AS api_cost_usd,
       COUNT(DISTINCT CASE WHEN type = 'ai_call' THEN device_id END) AS api_devices
     FROM events ${where}`
  ).bind(...binds).first();
  const out = {};
  for (const k of Object.keys(row || {})) out[k] = num(row[k]);
  return out;
}

async function revenueRollup(env, fromTs, toTs = null) {
  const where = fromTs
    ? (toTs ? 'WHERE issued_at >= ?1 AND issued_at < ?2' : 'WHERE issued_at >= ?1')
    : '';
  const binds = fromTs ? (toTs ? [fromTs, toTs] : [fromTs]) : [];
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*)                                            AS licenses,
       SUM(CASE WHEN amount_kopecks > 0 THEN 1 ELSE 0 END) AS paid,
       SUM(COALESCE(amount_kopecks, 0))                    AS revenue_kopecks,
       AVG(CASE WHEN amount_kopecks > 0 THEN amount_kopecks END) AS avg_check_kopecks,
       SUM(type = 'subscription')                          AS subscriptions,
       SUM(type = 'lifetime')                              AS lifetimes,
       SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked,
       SUM(COALESCE(is_preorder, 0))                       AS preorders,
       SUM(CASE WHEN gateway = 'referral' THEN 1 ELSE 0 END) AS referral_rewards
     FROM purchases ${where}`
  ).bind(...binds).first();
  const out = {};
  for (const k of Object.keys(row || {})) out[k] = num(row[k]);
  out.revenue_rub = out.revenue_kopecks / 100;
  out.avg_check_rub = out.avg_check_kopecks / 100;
  return out;
}

/** GET /admin/stats/overview?days=N (0/absent = all time) */
export async function statsOverview(env, days) {
  const from = days > 0 ? daysBack(days - 1) : null;
  const prevFrom = days > 0 ? daysBack(2 * days - 1) : null;
  const fromTs = days > 0 ? Date.now() - days * DAY_MS : null;
  const prevFromTs = days > 0 ? Date.now() - 2 * days * DAY_MS : null;

  const [usage, usagePrev, revenue, revenuePrev, revenueAll, devTotals, browsers, licenseTypes, activity] =
    await Promise.all([
      usageRollup(env, from),
      days > 0 ? usageRollup(env, prevFrom, from) : Promise.resolve(null),
      revenueRollup(env, fromTs),
      days > 0 ? revenueRollup(env, prevFromTs, fromTs) : Promise.resolve(null),
      revenueRollup(env, null),
      env.DB.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN first_seen >= ?1 THEN 1 ELSE 0 END) AS new_in_window
         FROM devices`
      ).bind(fromTs || 0).first(),
      env.DB.prepare(
        `SELECT COALESCE(browser,'other') AS browser, COUNT(*) AS n
         FROM devices GROUP BY 1 ORDER BY n DESC`
      ).all(),
      env.DB.prepare(
        `SELECT COALESCE(license_type,'none') AS type, COUNT(*) AS n
         FROM devices GROUP BY 1 ORDER BY n DESC`
      ).all(),
      env.DB.prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN day = ?1 THEN device_id END) AS dau,
           COUNT(DISTINCT CASE WHEN day >= ?2 THEN device_id END) AS wau,
           COUNT(DISTINCT CASE WHEN day >= ?3 THEN device_id END) AS mau
         FROM events`
      ).bind(mskDay(), daysBack(6), daysBack(29)).first()
    ]);

  // "What does a user cost me": exact-window figure plus per-day/week/month
  // projections from cost per active device-day.
  const perDeviceDay = usage.device_days ? usage.cost_usd / usage.device_days : 0;
  return {
    ok: true,
    days: days || 0,
    devices: {
      total: num(devTotals?.total),
      new_in_window: num(devTotals?.new_in_window),
      dau: num(activity?.dau),
      wau: num(activity?.wau),
      mau: num(activity?.mau),
      browsers: (browsers?.results || []).map((r) => ({ browser: r.browser, n: num(r.n) })),
      license_types: (licenseTypes?.results || []).map((r) => ({ type: r.type, n: num(r.n) }))
    },
    usage,
    usage_prev: usagePrev,
    cost: {
      window_usd: usage.cost_usd,
      prev_usd: usagePrev ? usagePrev.cost_usd : null,
      per_active_user_usd: usage.active_devices ? usage.cost_usd / usage.active_devices : 0,
      per_user_day_usd: perDeviceDay,
      per_user_week_usd: perDeviceDay * 7,
      per_user_month_usd: perDeviceDay * 30
    },
    revenue,
    revenue_prev: revenuePrev,
    revenue_all: revenueAll
  };
}

/** GET /admin/stats/timeseries?days=N — zero-filled per-day rows. */
export async function statsTimeseries(env, days) {
  const n = Math.max(1, Math.min(365, days || 30));
  const from = daysBack(n - 1);
  // Start of `from` as a real timestamp (MSK midnight), NOT a rolling
  // now-minus-N-days cutoff: devices/purchases landing between the rolling
  // cutoff and the first charted day would otherwise be silently dropped
  // (their computed day key predates the chart's first row).
  const fromTs = Date.parse(from + 'T00:00:00Z') - MSK_OFFSET_MS;

  const [ev, dev, pur] = await Promise.all([
    env.DB.prepare(
      `SELECT day,
              COUNT(DISTINCT device_id)              AS active,
              SUM(type IN ${USE_TYPES})              AS uses,
              SUM(type = 'solve')                    AS solves,
              SUM(type = 'test_solve')               AS tests,
              SUM(type = 'gdz_pull')                 AS gdz,
              SUM(CASE WHEN files_pdf > 0 THEN 1 ELSE 0 END) AS pdf,
              SUM(type = 'error')                    AS errors,
              SUM(CASE WHEN type != 'ai_call' THEN tokens_in  ELSE 0 END) AS tokens_in,
              SUM(CASE WHEN type != 'ai_call' THEN tokens_out ELSE 0 END) AS tokens_out,
              SUM(CASE WHEN type != 'ai_call' THEN cost_usd   ELSE 0 END) AS cost_usd,
              SUM(type = 'ai_call')                  AS api_calls,
              SUM(CASE WHEN type = 'ai_call' THEN cost_usd ELSE 0 END) AS api_cost_usd
       FROM events WHERE day >= ? GROUP BY day`
    ).bind(from).all(),
    env.DB.prepare(
      `SELECT date(first_seen / 1000 + 10800, 'unixepoch') AS day, COUNT(*) AS n
       FROM devices WHERE first_seen >= ? GROUP BY 1`
    ).bind(fromTs).all(),
    env.DB.prepare(
      `SELECT date(issued_at / 1000 + 10800, 'unixepoch') AS day,
              COUNT(*) AS purchases,
              SUM(COALESCE(amount_kopecks, 0)) AS revenue_kopecks
       FROM purchases WHERE issued_at >= ? GROUP BY 1`
    ).bind(fromTs).all()
  ]);

  const byDay = {};
  for (const d of dayRange(from)) {
    byDay[d] = {
      day: d, active: 0, uses: 0, solves: 0, tests: 0, gdz: 0, pdf: 0, errors: 0,
      tokens_in: 0, tokens_out: 0, cost_usd: 0, api_calls: 0, api_cost_usd: 0,
      new_devices: 0, purchases: 0, revenue_rub: 0
    };
  }
  for (const r of ev?.results || []) {
    const row = byDay[r.day];
    if (!row) continue;
    // `active` deliberately counts devices across BOTH series — a device whose
    // only trace that day is a server-observed ai_call was still really active.
    for (const k of ['active', 'uses', 'solves', 'tests', 'gdz', 'pdf', 'errors',
                     'tokens_in', 'tokens_out', 'cost_usd', 'api_calls', 'api_cost_usd']) {
      row[k] = num(r[k]);
    }
  }
  for (const r of dev?.results || []) if (byDay[r.day]) byDay[r.day].new_devices = num(r.n);
  for (const r of pur?.results || []) {
    if (!byDay[r.day]) continue;
    byDay[r.day].purchases = num(r.purchases);
    byDay[r.day].revenue_rub = num(r.revenue_kopecks) / 100;
  }
  return { ok: true, days: n, rows: Object.values(byDay) };
}

const USER_SORTS = {
  cost: 'cost_usd DESC',
  events: 'uses DESC',
  tokens: 'tokens DESC',
  recent: 'last_seen DESC',
  new: 'first_seen DESC'
};

/**
 * GET /admin/stats/users?days=&sort=&browser=&license=&q=&limit=&offset=
 * Every device, with usage aggregates inside the window. sort=cost (default)
 * = "top users by my API spend".
 */
export async function statsUsers(env, p) {
  const days = num(p.days);
  const from = days > 0 ? daysBack(days - 1) : '0000-00-00';
  // `sort`, `limit` and `offset` are the only fragments spliced into the SQL
  // text below, so each must be reduced to a value this module chose. Own-
  // property lookup keeps `?sort=constructor` from interpolating a function
  // into ORDER BY, and truncation keeps a fractional `?limit=5.5` from
  // reaching SQLite, which rejects a non-integer LIMIT outright.
  const sort = (Object.hasOwn(USER_SORTS, p.sort) ? USER_SORTS[p.sort] : null) || USER_SORTS.cost;
  const limit = Math.max(1, Math.min(200, Math.trunc(num(p.limit)) || 50));
  const offset = Math.max(0, Math.trunc(num(p.offset)));

  // Filters bind ONLY to the outer WHERE (they exist in both the page query and
  // the count query). The window `from` binds only to the JOIN subquery, which
  // the count query doesn't have — so keep the two bind sets separate. Anonymous
  // `?` params bind in SQL-text order: in the page query the subquery's `day >= ?`
  // comes first, then the filter placeholders, hence bind(from, ...filterBinds).
  const filters = [];
  const filterBinds = [];
  if (p.browser && BROWSERS.has(p.browser)) { filters.push('d.browser = ?'); filterBinds.push(p.browser); }
  if (p.license === 'paid') filters.push(`d.license_type IN ('subscription','lifetime')`);
  if (p.license === 'none') filters.push(`(d.license_type IS NULL OR d.license_type = 'none')`);
  if (p.q) {
    // The search term is bound, but LIKE still reads `%` and `_` in the VALUE
    // as wildcards — an unescaped `%` matches every device instead of the
    // literal the operator typed. Escape them and declare the escape char.
    const like = `%${String(p.q).slice(0, 40).replace(/[\\%_]/g, '\\$&')}%`;
    filters.push(`(d.device_id LIKE ? ESCAPE '\\' OR d.license_key LIKE ? ESCAPE '\\')`);
    filterBinds.push(like, like);
  }
  const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

  const sql =
    `SELECT d.device_id, d.first_seen, d.last_seen, d.browser, d.version, d.provider,
            d.license_key, d.license_type,
            COALESCE(a.uses, 0)        AS uses,
            COALESCE(a.solves, 0)      AS solves,
            COALESCE(a.tests, 0)       AS tests,
            COALESCE(a.gdz, 0)         AS gdz,
            COALESCE(a.pdf, 0)         AS pdf,
            COALESCE(a.tokens, 0)      AS tokens,
            COALESCE(a.cost_usd, 0)    AS cost_usd,
            COALESCE(a.api_calls, 0)   AS api_calls,
            COALESCE(a.api_cost_usd, 0) AS api_cost_usd,
            COALESCE(a.active_days, 0) AS active_days
     FROM devices d
     LEFT JOIN (
       SELECT device_id,
              SUM(type IN ${USE_TYPES})     AS uses,
              SUM(type = 'solve')           AS solves,
              SUM(type IN ('test_solve','test_requestion')) AS tests,
              SUM(type = 'gdz_pull')        AS gdz,
              SUM(CASE WHEN files_pdf > 0 THEN 1 ELSE 0 END) AS pdf,
              SUM(CASE WHEN type != 'ai_call' THEN tokens_in + tokens_out ELSE 0 END) AS tokens,
              SUM(CASE WHEN type != 'ai_call' THEN cost_usd ELSE 0 END)               AS cost_usd,
              SUM(type = 'ai_call')                                                   AS api_calls,
              SUM(CASE WHEN type = 'ai_call' THEN cost_usd ELSE 0 END)                AS api_cost_usd,
              COUNT(DISTINCT day)           AS active_days
       FROM events WHERE day >= ? GROUP BY device_id
     ) a ON a.device_id = d.device_id
     ${where}
     ORDER BY ${sort}, d.last_seen DESC
     LIMIT ${limit} OFFSET ${offset}`;

  const [rows, total] = await Promise.all([
    env.DB.prepare(sql).bind(from, ...filterBinds).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM devices d ${where}`)
      .bind(...filterBinds).first()
  ]);
  return {
    ok: true,
    total: num(total?.n),
    limit,
    offset,
    users: (rows?.results || []).map((r) => ({ ...r, cost_usd: num(r.cost_usd) }))
  };
}

/** GET /admin/stats/user?device_id= — one device, drilled all the way down. */
export async function statsUserDetail(env, deviceId) {
  const device = cleanDeviceId(deviceId);
  if (!device) return { ok: false, reason: 'bad_device', status: 400 };
  const row = await env.DB.prepare('SELECT * FROM devices WHERE device_id = ?').bind(device).first();
  if (!row) return { ok: false, reason: 'not_found', status: 404 };

  const [daily, subjects, recent, lifetime] = await Promise.all([
    env.DB.prepare(
      `SELECT day,
              SUM(type IN ${USE_TYPES}) AS uses,
              SUM(CASE WHEN type != 'ai_call' THEN cost_usd ELSE 0 END) AS cost_usd
       FROM events WHERE device_id = ?1 AND day >= ?2 GROUP BY day ORDER BY day`
    ).bind(device, daysBack(59)).all(),
    env.DB.prepare(
      `SELECT subject, COUNT(*) AS n, SUM(cost_usd) AS cost_usd
       FROM events WHERE device_id = ? AND subject IS NOT NULL
       GROUP BY subject ORDER BY n DESC LIMIT 15`
    ).bind(device).all(),
    env.DB.prepare(
      `SELECT ts, type, subject, provider, model, tokens_in, tokens_out,
              cost_usd, files_pdf, files_img, meta
       FROM events WHERE device_id = ? ORDER BY ts DESC LIMIT 60`
    ).bind(device).all(),
    env.DB.prepare(
      `SELECT SUM(type != 'ai_call') AS events, SUM(type IN ${USE_TYPES}) AS uses,
              SUM(CASE WHEN type != 'ai_call' THEN tokens_in + tokens_out ELSE 0 END) AS tokens,
              SUM(CASE WHEN type != 'ai_call' THEN cost_usd ELSE 0 END) AS cost_usd,
              SUM(type = 'ai_call') AS api_calls,
              SUM(CASE WHEN type = 'ai_call' THEN tokens_in + tokens_out ELSE 0 END) AS api_tokens,
              SUM(CASE WHEN type = 'ai_call' THEN cost_usd ELSE 0 END) AS api_cost_usd,
              COUNT(DISTINCT day) AS active_days
       FROM events WHERE device_id = ?`
    ).bind(device).first()
  ]);

  // The full license row lives in KV (device caps, revoke reason, …).
  let license = null;
  if (row.license_key) {
    try { license = await getLicense(env, row.license_key); } catch { /* KV hiccup — skip */ }
  }
  let referral_code = null;
  try { referral_code = await env.LICENSES.get(`refowner:${device}`); } catch { /* optional */ }

  const lt = {};
  for (const k of Object.keys(lifetime || {})) lt[k] = num(lifetime[k]);
  return {
    ok: true,
    device: row,
    lifetime: lt,
    daily: daily?.results || [],
    subjects: subjects?.results || [],
    recent: recent?.results || [],
    license,
    referral_code
  };
}

/** GET /admin/stats/subjects?days=N */
export async function statsSubjects(env, days) {
  const from = days > 0 ? daysBack(days - 1) : '0000-00-00';
  const rows = await env.DB.prepare(
    `SELECT subject,
            COUNT(*)                   AS n,
            SUM(type = 'solve')        AS solves,
            SUM(type = 'gdz_pull')     AS gdz,
            COUNT(DISTINCT device_id)  AS devices,
            SUM(cost_usd)              AS cost_usd,
            SUM(tokens_in + tokens_out) AS tokens
     FROM events
     WHERE day >= ? AND subject IS NOT NULL AND subject != ''
     GROUP BY subject ORDER BY n DESC LIMIT 40`
  ).bind(from).all();
  return { ok: true, subjects: rows?.results || [] };
}

/** GET /admin/stats/purchases?days=N&limit=N&cursor=... — money-tab pages. */
const PURCHASE_LIST_LIMIT = 500;
const PURCHASE_LIST_DEFAULT = 100;
const PURCHASE_OFFSET_MAX = 1_000_000;
const PURCHASE_CURSOR_MAX_CHARS = 512;

function purchaseCursor(row) {
  const payload = JSON.stringify([Number(row?.issued_at) || 0, String(row?.license_key || '')]);
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function parsePurchaseCursor(raw) {
  if (raw == null || raw === '') return { ok: true, value: null };
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > PURCHASE_CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return { ok: false };
  }
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - value.length % 4) % 4);
    const decoded = atob(padded);
    if (btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') !== value) {
      return { ok: false };
    }
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const issuedAt = Number(parsed?.[0]);
    const licenseKey = parsed?.[1];
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
        !Number.isSafeInteger(issuedAt) || issuedAt < 0 ||
        typeof licenseKey !== 'string' || !licenseKey || licenseKey.length > 128) {
      return { ok: false };
    }
    return { ok: true, value: { issued_at: issuedAt, license_key: licenseKey } };
  } catch {
    return { ok: false };
  }
}

function purchaseListOptions(raw) {
  const options = raw && typeof raw === 'object' ? raw : { days: raw };
  const days = Math.max(0, Math.min(3650, Math.trunc(Number(options.days) || 0)));
  const requestedLimit = Math.trunc(Number(options.limit) || PURCHASE_LIST_DEFAULT);
  const limit = Math.max(1, Math.min(PURCHASE_LIST_LIMIT, requestedLimit));
  const requestedOffset = Math.trunc(Number(options.offset) || 0);
  if (requestedOffset < 0 || requestedOffset > PURCHASE_OFFSET_MAX) {
    return { ok: false, reason: 'bad_offset', status: 400 };
  }
  const cursor = parsePurchaseCursor(options.cursor);
  if (!cursor.ok) return { ok: false, reason: 'bad_cursor', status: 400 };
  return { ok: true, days, limit, offset: requestedOffset, cursor: cursor.value };
}

export async function statsPurchases(env, rawOptions) {
  const options = purchaseListOptions(rawOptions);
  if (!options.ok) return options;
  const { days, limit, offset, cursor } = options;
  const fromTs = days > 0 ? Date.now() - days * DAY_MS : 0;
  const listStatement = cursor
    ? env.DB.prepare(
      `SELECT * FROM purchases
       WHERE COALESCE(issued_at, 0) >= ?
         AND (COALESCE(issued_at, 0) < ?
           OR (COALESCE(issued_at, 0) = ? AND license_key < ?))
       ORDER BY COALESCE(issued_at, 0) DESC, license_key DESC
       LIMIT ?`
    ).bind(fromTs, cursor.issued_at, cursor.issued_at, cursor.license_key, limit + 1)
    : env.DB.prepare(
      `SELECT * FROM purchases
       WHERE COALESCE(issued_at, 0) >= ?
       ORDER BY COALESCE(issued_at, 0) DESC, license_key DESC
       LIMIT ? OFFSET ?`
    ).bind(fromTs, limit + 1, offset);
  const [rows, gateways, summary] = await Promise.all([
    // Fetch one extra row so clients receive an explicit continuation signal.
    // license_key is the stable tie-breaker when payments share issued_at.
    listStatement.all(),
    env.DB.prepare(
      `SELECT COALESCE(gateway,'?') AS gateway, COUNT(*) AS n,
              SUM(COALESCE(amount_kopecks,0)) AS revenue_kopecks
       FROM purchases WHERE issued_at >= ? GROUP BY 1 ORDER BY revenue_kopecks DESC`
    ).bind(fromTs).all(),
    revenueRollup(env, fromTs || null)
  ]);
  const list = rows?.results || [];
  const hasMore = list.length > limit;
  const page = list.slice(0, limit);
  return {
    ok: true,
    limit,
    offset: cursor ? null : offset,
    truncated: hasMore,
    has_more: hasMore,
    // Offset remains for older dashboard builds, but an opaque keyset cursor is
    // the unbounded continuation mechanism. Never clamp an oversized offset
    // backward and repeat a page forever.
    next_offset: hasMore && !cursor && offset + limit <= PURCHASE_OFFSET_MAX
      ? offset + limit
      : null,
    next_cursor: hasMore && page.length ? purchaseCursor(page[page.length - 1]) : null,
    purchases: page,
    gateways: (gateways?.results || []).map((row) => ({
      ...row,
      revenue_rub: num(row.revenue_kopecks) / 100
    })),
    summary
  };
}

/**
 * GET /admin/stats/retention — classic D1/D7/D30 (exact-day, among devices old
 * enough to qualify) + 8 weekly cohorts × 8 weeks of "came back that week".
 * `truncated` makes the hard D1 scan bound explicit to API consumers.
 */
export async function statsRetention(env) {
  const [devices, activity] = await Promise.all([
    env.DB.prepare('SELECT device_id, first_seen FROM devices').all(),
    env.DB.prepare(
      `SELECT device_id, day FROM events WHERE day >= ? GROUP BY device_id, day LIMIT 100000`
    ).bind(daysBack(90)).all()
  ]);
  const activityRows = activity?.results || [];

  const firstDay = {};
  for (const d of devices?.results || []) firstDay[d.device_id] = mskDay(num(d.first_seen));
  const activeDays = {};
  for (const r of activityRows) (activeDays[r.device_id] ||= new Set()).add(r.day);

  const today = mskDay();
  const dayNum = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / DAY_MS);
  const todayNum = dayNum(today);

  // Exact-day D1/D7/D30 among devices whose first day is old enough to have
  // had that day happen.
  const classic = { d1: { n: 0, back: 0 }, d7: { n: 0, back: 0 }, d30: { n: 0, back: 0 } };
  // Weekly cohorts: week 0 = the device's first calendar week (Mon-based).
  const mondayNum = (dn) => dn - ((dn + 3) % 7); // 1970-01-01 was a Thursday
  const cohorts = new Map();

  for (const [dev, fd] of Object.entries(firstDay)) {
    const fdn = dayNum(fd);
    const days = activeDays[dev] || new Set();
    for (const [label, offset] of [['d1', 1], ['d7', 7], ['d30', 30]]) {
      if (todayNum - fdn >= offset) {
        classic[label].n++;
        const target = new Date((fdn + offset) * DAY_MS).toISOString().slice(0, 10);
        if (days.has(target)) classic[label].back++;
      }
    }
    const cohortMonday = mondayNum(fdn);
    const cohortKey = new Date(cohortMonday * DAY_MS).toISOString().slice(0, 10);
    if (todayNum - cohortMonday > 8 * 7 + 6) continue; // older than the 8-week board
    const c = cohorts.get(cohortKey) || { cohort: cohortKey, size: 0, weeks: new Array(8).fill(0) };
    c.size++;
    for (let w = 0; w < 8; w++) {
      const start = cohortMonday + w * 7;
      if (start > todayNum) { c.weeks[w] = null; continue; }
      let came = false;
      for (let i = 0; i < 7; i++) {
        const d = new Date((start + i) * DAY_MS).toISOString().slice(0, 10);
        if (days.has(d)) { came = true; break; }
      }
      if (came && c.weeks[w] != null) c.weeks[w]++;
    }
    cohorts.set(cohortKey, c);
  }

  return {
    ok: true,
    truncated: activityRows.length >= 100000,
    classic: Object.fromEntries(Object.entries(classic).map(([k, v]) => [
      k, { eligible: v.n, returned: v.back, rate: v.n ? v.back / v.n : null }
    ])),
    cohorts: [...cohorts.values()].sort((a, b) => a.cohort < b.cohort ? -1 : 1)
  };
}

/**
 * GET /admin/stats/referrals — rollup of the KV referral records. `truncated`
 * is true when another KV cursor remained after the 5000-record safety bound.
 */
export async function statsReferrals(env) {
  let cursor;
  const codes = [];
  do {
    const page = await env.LICENSES.list({ prefix: 'ref:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const raw = await env.LICENSES.get(k.name);
      if (!raw) continue;
      try {
        const r = JSON.parse(raw);
        codes.push({
          code: r.code,
          created_at: r.created_at,
          purchases: num(r.purchases),
          days_earned: num(r.days_earned),
          has_reward_key: !!r.reward_key
        });
      } catch { /* not JSON */ }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && codes.length < 5000);

  codes.sort((a, b) => b.purchases - a.purchases || b.days_earned - a.days_earned);
  return {
    ok: true,
    truncated: !!cursor,
    total_codes: codes.length,
    total_referred_purchases: codes.reduce((s, c) => s + c.purchases, 0),
    total_days_earned: codes.reduce((s, c) => s + c.days_earned, 0),
    top: codes.slice(0, 50)
  };
}

/**
 * GET /admin/stats/rate — official USD→RUB from the Central Bank of Russia
 * (cbr-xml-daily.ru, a keyless mirror of cbr.ru), cached in KV for 12h. No API
 * key, no quota, no activation — it's the authoritative rate for a RUB business
 * and the number RU accounting/tax actually uses. The CBR sets one rate per
 * business day; on weekends/holidays it holds the last published value.
 *
 *   { ok:true, rate:Number, fetched_at:ISO, stale:false, source:'cbr' }
 * On a fetch failure we return the last cached rate with stale:true; with no
 * cache and no reachable source we return ok:false so the dashboard flags it
 * 'unverified'.
 */
const FX_KEY = 'fx:usdrub';
const FX_TTL_MS = 12 * 60 * 60 * 1000;
const FX_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';

export async function statsRate(env, force = false) {
  let cached = null;
  try { cached = JSON.parse((await env.LICENSES.get(FX_KEY)) || 'null'); } catch { cached = null; }
  const fresh = cached && Number.isFinite(cached.rate) && (Date.now() - Date.parse(cached.fetched_at) < FX_TTL_MS);
  if (fresh && !force) return { ok: true, ...cached, stale: false, source: 'cbr' };

  try {
    const res = await fetch(FX_URL, {
      headers: { accept: 'application/json' },
      redirect: 'manual'
    });
    const parsed = await readJsonBounded(res, 64 * 1024);
    const data = parsed.ok ? parsed.value : null;
    const rate = Number(data?.Valute?.USD?.Value);
    if (!res.ok || !Number.isFinite(rate) || rate <= 0) {
      if (cached) return { ok: true, ...cached, stale: true, source: 'cache' };
      return { ok: false, reason: 'bad_response' };
    }
    const fresh_rec = { rate, fetched_at: new Date().toISOString() };
    await env.LICENSES.put(FX_KEY, JSON.stringify(fresh_rec));
    return { ok: true, ...fresh_rec, stale: false, source: 'cbr' };
  } catch (e) {
    if (cached) return { ok: true, ...cached, stale: true, source: 'cache' };
    return { ok: false, reason: 'network' };
  }
}

/** GET /admin/stats/errors?days=N — recent client errors, newest first. */
export async function statsErrors(env, days) {
  const from = days > 0 ? daysBack(days - 1) : daysBack(29);
  const rows = await env.DB.prepare(
    `SELECT ts, device_id, provider, meta FROM events
     WHERE type = 'error' AND day >= ? ORDER BY ts DESC LIMIT 200`
  ).bind(from).all();
  return { ok: true, errors: rows?.results || [] };
}

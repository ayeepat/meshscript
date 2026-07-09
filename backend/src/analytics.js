/**
 * Usage analytics: ingest + admin aggregation queries (D1).
 *
 * Ingest (`POST /t`) is open like /verify — the extension fires small,
 * CONTENT-FREE batches (no task text, no answers; only event types, subjects,
 * token counts, costs). Everything else here is admin-only aggregation for
 * the dashboard (ayeepat.github.io/smeshaidashboard), guarded in worker.js.
 *
 * Days are MOSCOW calendar days (UTC+3): the audience is Russian students,
 * so "today" must be their today. All aggregates key on events.day, which is
 * computed server-side from the (clamped) event timestamp.
 *
 * KV stays the source of truth for licenses; `purchases` is a queryable
 * mirror (see mirrorLicense + backfillLicenses).
 */

import { getLicense } from './licenses.js';
import { cleanDeviceId } from './referrals.js';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
// "Real usage" = a student actually used a feature (heartbeats/installs/errors
// mark activity but are not usage).
const USE_TYPES = "('solve','test_solve','test_requestion','gdz_pull')";

const clampStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const clampInt = (v, max) => Math.max(0, Math.min(max, Math.round(num(v))));

// Cheap per-IP daily budget (KV, approximate — same pattern as referrals).
// Only has to stop dumb flooding of an open endpoint; 3000 events/day is far
// beyond any real device.
async function bumpIngestBudget(env, ip, n) {
  if (!ip) return true;
  const key = `tstat:${ip}:${mskDay()}`;
  const used = num(await env.LICENSES.get(key));
  if (used >= 3000) return false;
  await env.LICENSES.put(key, String(used + n), { expirationTtl: 2 * 24 * 60 * 60 });
  return true;
}

/**
 * POST /t — body:
 * { device_id, browser, ua, version, provider, license_key, license_type,
 *   events: [{ ts, type, subject, provider, model, tokens_in, tokens_out,
 *              cost_usd, files_pdf, files_img, meta }] }
 * Returns {ok:true, accepted:N}. Never throws on bad fields — they're clamped
 * or dropped, because a telemetry write must never break the extension.
 */
export async function handleIngest(request, env) {
  let body;
  try { body = await request.json(); } catch { return { ok: false, reason: 'bad_json', status: 400 }; }

  const device = cleanDeviceId(body.device_id);
  if (!device) return { ok: false, reason: 'bad_device', status: 400 };

  const rawEvents = Array.isArray(body.events) ? body.events.slice(0, 25) : [];
  const now = Date.now();
  const events = [];
  for (const e of rawEvents) {
    if (!e || !EVENT_TYPES.has(e.type)) continue;
    // Clamp the client clock: at most 7 days late (an offline buffer), never
    // from the future.
    let ts = num(e.ts) || now;
    if (ts > now + 5 * 60 * 1000 || ts < now - 7 * DAY_MS) ts = now;
    let meta = null;
    if (e.meta != null) {
      try { meta = JSON.stringify(e.meta).slice(0, 400); } catch { meta = null; }
    }
    events.push({
      ts,
      day: mskDay(ts),
      type: e.type,
      subject: clampStr(e.subject, 80),
      provider: clampStr(e.provider, 24),
      model: clampStr(e.model, 80),
      tokens_in: clampInt(e.tokens_in, 5_000_000),
      tokens_out: clampInt(e.tokens_out, 5_000_000),
      cost_usd: Math.max(0, Math.min(50, num(e.cost_usd))),
      files_pdf: clampInt(e.files_pdf, 20),
      files_img: clampInt(e.files_img, 40),
      meta
    });
  }

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await bumpIngestBudget(env, ip, Math.max(1, events.length)))) {
    return { ok: false, reason: 'rate_limited', status: 429 };
  }

  const browser = BROWSERS.has(body.browser) ? body.browser : 'other';
  const stmts = [
    env.DB.prepare(
      `INSERT INTO devices (device_id, first_seen, last_seen, browser, ua, version, provider, license_key, license_type)
       VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(device_id) DO UPDATE SET
         last_seen   = excluded.last_seen,
         browser     = excluded.browser,
         ua          = excluded.ua,
         version     = excluded.version,
         provider    = COALESCE(excluded.provider, devices.provider),
         license_key = COALESCE(excluded.license_key, devices.license_key),
         license_type= COALESCE(excluded.license_type, devices.license_type)`
    ).bind(
      device, now, browser,
      clampStr(body.ua, 240), clampStr(body.version, 24), clampStr(body.provider, 24),
      clampStr(body.license_key, 40), clampStr(body.license_type, 16)
    )
  ];
  for (const e of events) {
    stmts.push(env.DB.prepare(
      `INSERT INTO events (ts, day, device_id, type, subject, provider, model,
                           tokens_in, tokens_out, cost_usd, files_pdf, files_img, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      e.ts, e.day, device, e.type, e.subject, e.provider, e.model,
      e.tokens_in, e.tokens_out, e.cost_usd, e.files_pdf, e.files_img, e.meta
    ));
  }
  await env.DB.batch(stmts);
  return { ok: true, accepted: events.length };
}

/* ------------------------- license mirroring -------------------------- */

/**
 * Mirror one KV license row into `purchases`. Best-effort by contract: a D1
 * hiccup must NEVER fail a payment webhook or a /verify device add, so the
 * caller (putLicense) swallows rejections.
 */
export async function mirrorLicense(env, license) {
  if (!env.DB || !license?.key) return;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO purchases
       (license_key, gateway, payment_id, type, status, amount_rub, email,
        telegram_user_id, issued_at, expires_at, is_preorder, note, device_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    license.key,
    license.gateway || null,
    license.payment_id || null,
    license.type || null,
    license.status || null,
    license.amount_rub == null ? null : num(license.amount_rub),
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
      imported++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { imported };
}

/* ----------------------------- aggregates ---------------------------- */

// Shared usage rollup over an events window (day >= from, or all time).
async function usageRollup(env, from, to = null) {
  const where = from
    ? (to ? 'WHERE day >= ?1 AND day < ?2' : 'WHERE day >= ?1')
    : '';
  const binds = from ? (to ? [from, to] : [from]) : [];
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*)                                        AS events,
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
       SUM(tokens_in)                                  AS tokens_in,
       SUM(tokens_out)                                 AS tokens_out,
       SUM(cost_usd)                                   AS cost_usd,
       COUNT(DISTINCT device_id)                       AS active_devices,
       COUNT(DISTINCT device_id || ':' || day)         AS device_days
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
       SUM(CASE WHEN amount_rub > 0 THEN 1 ELSE 0 END)     AS paid,
       SUM(COALESCE(amount_rub, 0))                        AS revenue_rub,
       AVG(CASE WHEN amount_rub > 0 THEN amount_rub END)   AS avg_check_rub,
       SUM(type = 'subscription')                          AS subscriptions,
       SUM(type = 'lifetime')                              AS lifetimes,
       SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked,
       SUM(COALESCE(is_preorder, 0))                       AS preorders,
       SUM(CASE WHEN gateway = 'referral' THEN 1 ELSE 0 END) AS referral_rewards
     FROM purchases ${where}`
  ).bind(...binds).first();
  const out = {};
  for (const k of Object.keys(row || {})) out[k] = num(row[k]);
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
  const fromTs = Date.now() - n * DAY_MS;

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
              SUM(tokens_in)                         AS tokens_in,
              SUM(tokens_out)                        AS tokens_out,
              SUM(cost_usd)                          AS cost_usd
       FROM events WHERE day >= ? GROUP BY day`
    ).bind(from).all(),
    env.DB.prepare(
      `SELECT date(first_seen / 1000 + 10800, 'unixepoch') AS day, COUNT(*) AS n
       FROM devices WHERE first_seen >= ? GROUP BY 1`
    ).bind(fromTs).all(),
    env.DB.prepare(
      `SELECT date(issued_at / 1000 + 10800, 'unixepoch') AS day,
              COUNT(*) AS purchases,
              SUM(COALESCE(amount_rub, 0)) AS revenue_rub
       FROM purchases WHERE issued_at >= ? GROUP BY 1`
    ).bind(fromTs).all()
  ]);

  const byDay = {};
  for (const d of dayRange(from)) {
    byDay[d] = {
      day: d, active: 0, uses: 0, solves: 0, tests: 0, gdz: 0, pdf: 0, errors: 0,
      tokens_in: 0, tokens_out: 0, cost_usd: 0, new_devices: 0, purchases: 0, revenue_rub: 0
    };
  }
  for (const r of ev?.results || []) {
    const row = byDay[r.day];
    if (!row) continue;
    for (const k of ['active', 'uses', 'solves', 'tests', 'gdz', 'pdf', 'errors', 'tokens_in', 'tokens_out', 'cost_usd']) {
      row[k] = num(r[k]);
    }
  }
  for (const r of dev?.results || []) if (byDay[r.day]) byDay[r.day].new_devices = num(r.n);
  for (const r of pur?.results || []) {
    if (!byDay[r.day]) continue;
    byDay[r.day].purchases = num(r.purchases);
    byDay[r.day].revenue_rub = num(r.revenue_rub);
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
  const sort = USER_SORTS[p.sort] || USER_SORTS.cost;
  const limit = Math.max(1, Math.min(200, num(p.limit) || 50));
  const offset = Math.max(0, num(p.offset));

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
    const like = `%${String(p.q).slice(0, 40)}%`;
    filters.push('(d.device_id LIKE ? OR d.license_key LIKE ?)');
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
            COALESCE(a.active_days, 0) AS active_days
     FROM devices d
     LEFT JOIN (
       SELECT device_id,
              SUM(type IN ${USE_TYPES})     AS uses,
              SUM(type = 'solve')           AS solves,
              SUM(type IN ('test_solve','test_requestion')) AS tests,
              SUM(type = 'gdz_pull')        AS gdz,
              SUM(CASE WHEN files_pdf > 0 THEN 1 ELSE 0 END) AS pdf,
              SUM(tokens_in + tokens_out)   AS tokens,
              SUM(cost_usd)                 AS cost_usd,
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
              SUM(cost_usd)             AS cost_usd
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
      `SELECT COUNT(*) AS events, SUM(type IN ${USE_TYPES}) AS uses,
              SUM(tokens_in + tokens_out) AS tokens, SUM(cost_usd) AS cost_usd,
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

/** GET /admin/stats/purchases?days=N — list + slices for the money tab. */
export async function statsPurchases(env, days) {
  const fromTs = days > 0 ? Date.now() - days * DAY_MS : 0;
  const [rows, gateways, summary] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM purchases WHERE issued_at >= ? ORDER BY issued_at DESC LIMIT 500`
    ).bind(fromTs).all(),
    env.DB.prepare(
      `SELECT COALESCE(gateway,'?') AS gateway, COUNT(*) AS n,
              SUM(COALESCE(amount_rub,0)) AS revenue_rub
       FROM purchases WHERE issued_at >= ? GROUP BY 1 ORDER BY revenue_rub DESC`
    ).bind(fromTs).all(),
    revenueRollup(env, fromTs || null)
  ]);
  return {
    ok: true,
    purchases: rows?.results || [],
    gateways: gateways?.results || [],
    summary
  };
}

/**
 * GET /admin/stats/retention — classic D1/D7/D30 (exact-day, among devices old
 * enough to qualify) + 8 weekly cohorts × 8 weeks of "came back that week".
 */
export async function statsRetention(env) {
  const [devices, activity] = await Promise.all([
    env.DB.prepare('SELECT device_id, first_seen FROM devices').all(),
    env.DB.prepare(
      `SELECT device_id, day FROM events WHERE day >= ? GROUP BY device_id, day LIMIT 100000`
    ).bind(daysBack(90)).all()
  ]);

  const firstDay = {};
  for (const d of devices?.results || []) firstDay[d.device_id] = mskDay(num(d.first_seen));
  const activeDays = {};
  for (const r of activity?.results || []) (activeDays[r.device_id] ||= new Set()).add(r.day);

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
    classic: Object.fromEntries(Object.entries(classic).map(([k, v]) => [
      k, { eligible: v.n, returned: v.back, rate: v.n ? v.back / v.n : null }
    ])),
    cohorts: [...cohorts.values()].sort((a, b) => a.cohort < b.cohort ? -1 : 1)
  };
}

/** GET /admin/stats/referrals — rollup of the KV referral records. */
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
    total_codes: codes.length,
    total_referred_purchases: codes.reduce((s, c) => s + c.purchases, 0),
    total_days_earned: codes.reduce((s, c) => s + c.days_earned, 0),
    top: codes.slice(0, 50)
  };
}

/**
 * GET /admin/stats/rate — live USD→RUB from exchangerate-api.com, cached in KV
 * for 12h so the free tier (1500 req/mo) is never stressed. The API key stays
 * a Cloudflare secret and never reaches the public dashboard.
 *
 *   { ok:true, rate:Number, fetched_at:ISO, stale:false, source:'exchangerate-api' }
 * On a fetch failure we return the last cached rate with stale:true; with no
 * cache and no key we return ok:false so the dashboard can flag it 'unverified'.
 */
const FX_KEY = 'fx:usdrub';
const FX_TTL_MS = 12 * 60 * 60 * 1000;

export async function statsRate(env, force = false) {
  let cached = null;
  try { cached = JSON.parse((await env.LICENSES.get(FX_KEY)) || 'null'); } catch { cached = null; }
  const fresh = cached && Number.isFinite(cached.rate) && (Date.now() - Date.parse(cached.fetched_at) < FX_TTL_MS);
  if (fresh && !force) return { ok: true, ...cached, stale: false, source: 'exchangerate-api' };

  if (!env.EXCHANGERATE_API_KEY) {
    if (cached) return { ok: true, ...cached, stale: true, source: 'cache' };
    return { ok: false, reason: 'no_key' };
  }
  try {
    const res = await fetch(`https://v6.exchangerate-api.com/v6/${env.EXCHANGERATE_API_KEY}/latest/USD`);
    const data = await res.json().catch(() => null);
    const rate = Number(data?.conversion_rates?.RUB);
    if (data?.result !== 'success' || !Number.isFinite(rate) || rate <= 0) {
      if (cached) return { ok: true, ...cached, stale: true, source: 'cache' };
      return { ok: false, reason: data?.['error-type'] || 'bad_response' };
    }
    const fresh_rec = { rate, fetched_at: new Date().toISOString() };
    await env.LICENSES.put(FX_KEY, JSON.stringify(fresh_rec));
    return { ok: true, ...fresh_rec, stale: false, source: 'exchangerate-api' };
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

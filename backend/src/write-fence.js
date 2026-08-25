// Durable runtime write fence used by the backup runbook.
//
// BACKUP_MAINTENANCE is an entry-point admission switch, but a Worker
// invocation keeps the environment from the deployment that started it. A
// request which began before maintenance can therefore outlive the deploy.
// Every actual D1/KV mutation is wrapped here and re-authorized against the
// latest primary D1 row immediately before the storage call. Incrementing the
// epoch permanently revokes old isolates, including after writes are enabled
// again for the replacement deployment.

const FENCE_SQL =
  'SELECT write_epoch, writes_enabled FROM runtime_write_fence WHERE singleton = 1';
const READ_ONLY_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo'
]);

export class RuntimeWriteFenceError extends Error {
  constructor(reason = 'write_fenced') {
    super(reason);
    this.name = 'RuntimeWriteFenceError';
    this.code = reason;
  }
}

export function isRuntimeWriteFenceError(value) {
  return value instanceof RuntimeWriteFenceError || value?.name === 'RuntimeWriteFenceError';
}

export function configuredWriteEpoch(env) {
  const raw = String(env?.RUNTIME_WRITE_EPOCH ?? '').trim();
  if (!/^\d{1,15}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function stripLeadingSqlComments(sql) {
  let value = String(sql || '');
  while (true) {
    const before = value;
    value = value.replace(/^\s+/, '');
    value = value.replace(/^--[^\r\n]*(?:\r?\n|$)/, '');
    value = value.replace(/^\/\*[\s\S]*?\*\//, '');
    if (value === before) return value;
  }
}

function splitSqlStatements(sql) {
  const value = String(sql || '');
  const statements = [];
  let start = 0;
  let state = 'normal';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') { state = 'normal'; index += 1; }
      continue;
    }
    if (state === 'single-quote') {
      if (char === "'") {
        if (next === "'") index += 1;
        else state = 'normal';
      }
      continue;
    }
    if (state === 'double-quote') {
      if (char === '"') {
        if (next === '"') index += 1;
        else state = 'normal';
      }
      continue;
    }
    if (state === 'backtick') {
      if (char === '`') {
        if (next === '`') index += 1;
        else state = 'normal';
      }
      continue;
    }
    if (state === 'bracket') {
      if (char === ']') state = 'normal';
      continue;
    }
    if (char === '-' && next === '-') { state = 'line-comment'; index += 1; continue; }
    if (char === '/' && next === '*') { state = 'block-comment'; index += 1; continue; }
    if (char === "'") { state = 'single-quote'; continue; }
    if (char === '"') { state = 'double-quote'; continue; }
    if (char === '`') { state = 'backtick'; continue; }
    if (char === '[') { state = 'bracket'; continue; }
    if (char === ';') {
      statements.push(value.slice(start, index));
      start = index + 1;
    }
  }
  statements.push(value.slice(start));
  return statements
    .map((statement) => stripLeadingSqlComments(statement).trim())
    .filter(Boolean);
}

// Treat unknown statement forms as writes. Only the schema-introspection
// PRAGMAs used by readiness are read-only; SQLite also has mutating PRAGMAs
// (for example user_version/writable_schema), so a generic PRAGMA exemption
// would be an alternate write path around maintenance.
export function sqlMayMutate(sql) {
  const statements = splitSqlStatements(sql);
  // Empty/unknown input fails closed. D1.exec accepts stacked statements, so
  // every statement must be classified rather than trusting only the first.
  if (!statements.length) return true;
  return statements.some((normalized) => {
  const first = normalized.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() || '';
  if (first === 'SELECT' || first === 'EXPLAIN') return false;
  if (first !== 'PRAGMA') return true;
  const pragma = normalized.match(/^PRAGMA\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)?.[1]?.toLowerCase();
  return !READ_ONLY_PRAGMAS.has(pragma);
  });
}

function primarySession(db) {
  if (typeof db?.withSession === 'function') {
    return db.withSession('first-primary');
  }
  return db;
}

export function createWriteFenceAuthorizer(env, rawDb = env?.DB) {
  return async function assertRuntimeWritesAllowed() {
    const expectedEpoch = configuredWriteEpoch(env);
    if (!rawDb || expectedEpoch == null) {
      throw new RuntimeWriteFenceError('write_fence_unavailable');
    }
    let row;
    try {
      // A fresh first-primary session prevents a read-replica lag from
      // extending write authority after the operator closes the fence.
      row = await primarySession(rawDb).prepare(FENCE_SQL).first();
    } catch {
      throw new RuntimeWriteFenceError('write_fence_unavailable');
    }
    const epoch = Number(row?.write_epoch);
    const enabled = Number(row?.writes_enabled);
    if (!Number.isSafeInteger(epoch) || epoch !== expectedEpoch || enabled !== 1) {
      throw new RuntimeWriteFenceError('write_fenced');
    }
  };
}

function wrapStatement(statement, sql, assertWritesAllowed, statementMeta) {
  const meta = { sql: String(sql || ''), mutates: sqlMayMutate(sql), raw: statement };
  const proxy = new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') {
        return (...args) => wrapStatement(
          target.bind(...args), meta.sql, assertWritesAllowed, statementMeta
        );
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (meta.mutates && ['run', 'first', 'all', 'raw'].includes(String(property))) {
        return async (...args) => {
          await assertWritesAllowed();
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    }
  });
  statementMeta.set(proxy, meta);
  return proxy;
}

function wrapD1(rawDb, assertWritesAllowed) {
  if (!rawDb) return rawDb;
  const statementMeta = new WeakMap();
  return new Proxy(rawDb, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => wrapStatement(target.prepare(sql), sql, assertWritesAllowed, statementMeta);
      }
      if (property === 'batch') {
        return async (statements) => {
          const entries = Array.from(statements || []);
          const metadata = entries.map((statement) => statementMeta.get(statement));
          // A statement not created through this wrapper is unclassified and
          // therefore treated as mutating rather than bypassing the fence.
          if (metadata.some((entry) => !entry || entry.mutates)) {
            await assertWritesAllowed();
          }
          return target.batch(entries.map((statement, index) => metadata[index]?.raw || statement));
        };
      }
      if (property === 'exec') {
        return async (sql, ...args) => {
          // D1.exec has its own multi-query grammar (including newline-separated
          // statements). Do not attempt to duplicate that parser: exec is an
          // administrative mutation primitive and is always re-authorized.
          await assertWritesAllowed();
          return target.exec(sql, ...args);
        };
      }
      if (property === 'withSession') {
        return (...args) => wrapD1(target.withSession(...args), assertWritesAllowed);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function wrapKv(rawKv, assertWritesAllowed) {
  if (!rawKv) return rawKv;
  return new Proxy(rawKv, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'put' || property === 'delete') {
        return async (...args) => {
          await assertWritesAllowed();
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    }
  });
}

// Most older regression fixtures predate the production fence binding. The
// Node-only shim opts those fixtures out explicitly; production runtimes have
// no such marker and fail closed when either the config or D1 row is missing.
export function enforceRuntimeWriteFence(env) {
  if (globalThis.__SMESH_TEST_ALLOW_LEGACY_FENCE_ENV__ === true &&
      configuredWriteEpoch(env) == null) {
    return env;
  }
  const rawDb = env?.DB;
  const assertWritesAllowed = createWriteFenceAuthorizer(env, rawDb);
  const guardedDb = wrapD1(rawDb, assertWritesAllowed);
  const guardedKv = wrapKv(env?.LICENSES, assertWritesAllowed);
  return new Proxy(env || {}, {
    get(target, property) {
      if (property === 'DB') return guardedDb;
      if (property === 'LICENSES') return guardedKv;
      return Reflect.get(target, property, target);
    }
  });
}

export const RUNTIME_WRITE_FENCE_SQL = FENCE_SQL;

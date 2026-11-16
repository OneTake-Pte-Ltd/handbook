// Small database interface used by every handler.
//
// Production wraps @bunny.net/database-client; the tests wrap node:sqlite.
// Both expose the same five methods, so handlers never know which one they use:
//
//   all(sql, ...args)    -> array of row objects
//   first(sql, ...args)  -> first row object, or null
//   value(sql, ...args)  -> first column of the first row, or null
//   run(sql, ...args)    -> { rowsAffected, lastInsertRowid }
//   batch([[sql, args], ...]) -> runs every statement in one transaction
//   many([[sql, args], ...])  -> runs several reads in ONE round trip, returns [rows, rows, ...]
//
// On Bunny each call is an HTTP request to the database, so the number of
// calls made one after the other is what makes a request slow. Group reads
// with many() whenever they don't depend on each other.

// Hrana (libSQL over HTTP) values, used by readPipeline below.
function encodeValue(value) {
  const v = toSqlValue(value);
  if (v === null) return { type: "null" };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  if (typeof v === "bigint") return { type: "integer", value: v.toString() };
  return { type: "text", value: String(v) };
}

function decodeValue(value) {
  if (!value || value.type === "null") return null;
  if (value.type === "integer") return Number(value.value);
  if (value.type === "float") return Number(value.value);
  if (value.type === "text") return value.value;
  return null;
}

// Several reads in one HTTP request to Bunny Database, as plain statements
// (no transaction): reads in a transaction always go to the primary region,
// while plain reads can be answered by a read replica close to the edge.
export async function readPipeline({ url, token, fetchImpl = fetch }, statements) {
  const endpoint = `${String(url).replace(/^libsql:\/\//, "https://").replace(/\/+$/, "")}/v2/pipeline`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requests: [...statements.map(([sql, args = []]) => ({ type: "execute", stmt: { sql, args: args.map(encodeValue) } })), { type: "close" }],
    }),
  });
  if (!response.ok) {
    const error = new Error(`Database request failed (HTTP ${response.status})`);
    error.name = "DatabaseError";
    error.code = response.status === 401 || response.status === 403 ? "UNAUTHORIZED" : `HTTP_${response.status}`;
    throw error;
  }
  const payload = await response.json();
  return statements.map((_, i) => {
    const result = payload.results[i];
    if (!result || result.type !== "ok") {
      const error = new Error((result && result.error && result.error.message) || "Database error");
      error.name = "DatabaseError";
      error.code = (result && result.error && result.error.code) || "SQLITE_ERROR";
      throw error;
    }
    const { cols, rows } = result.response.result;
    return rows.map((row) => Object.fromEntries(cols.map((c, j) => [c.name, decodeValue(row[j])])));
  });
}

// `getClient` returns the @bunny.net/database-client connection; `pipeline`
// ({ url, token }) enables one-request reads for many().
export function fromBunnyClient(getClient, pipeline = null) {
  const stmt = (sql, args) => {
    const prepared = getClient().prepare(sql);
    return args && args.length ? prepared.bind(...args.map(toSqlValue)) : prepared;
  };
  return {
    async all(sql, ...args) {
      return stmt(sql, args).all();
    },
    async first(sql, ...args) {
      return stmt(sql, args).first();
    },
    async value(sql, ...args) {
      const row = await stmt(sql, args).raw();
      return row.length ? row[0][0] : null;
    },
    async run(sql, ...args) {
      const result = await stmt(sql, args).run();
      return { rowsAffected: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
    },
    async many(statements) {
      if (!statements.length) return [];
      if (pipeline) {
        getClient(); // checks that the database secrets are set
        return readPipeline(pipeline(), statements);
      }
      return Promise.all(statements.map(([sql, args]) => stmt(sql, args || []).all()));
    },
    async batch(statements, { foreignKeys = true } = {}) {
      const prepared = statements.map(([sql, args]) => stmt(sql, args || []));
      const options = foreignKeys ? { mode: "immediate" } : { mode: "immediate", foreignKeys: false };
      const results = await getClient().batch(prepared, options);
      return results.map((r) => ({ rows: r.rows, rowsAffected: r.rowsAffected, lastInsertRowid: r.lastInsertRowid }));
    },
  };
}

// The Bunny client refuses undefined and booleans are stored as 1 or 0 anyway.
export function toSqlValue(value) {
  if (value === undefined) return null;
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}

export function nowIso() {
  return new Date().toISOString();
}

// Wraps a database to count calls and time spent, for the Server-Timing header.
export function measured(db) {
  const stats = { calls: 0, ms: 0 };
  const wrap = (fn) => async (...args) => {
    stats.calls++;
    const start = performance.now();
    try {
      return await fn(...args);
    } finally {
      stats.ms += performance.now() - start;
    }
  };
  const out = { stats };
  for (const key of ["all", "first", "value", "run", "batch", "many"]) out[key] = wrap(db[key].bind(db));
  return out;
}

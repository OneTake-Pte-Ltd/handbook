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

export function fromBunnyClient(client) {
  const stmt = (sql, args) => {
    const prepared = client.prepare(sql);
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
    async batch(statements, { foreignKeys = true } = {}) {
      const prepared = statements.map(([sql, args]) => stmt(sql, args || []));
      const options = foreignKeys ? { mode: "immediate" } : { mode: "immediate", foreignKeys: false };
      const results = await client.batch(prepared, options);
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

// The database interface of edge/src/lib/db.js, backed by node:sqlite
// (built into Node 22) instead of Bunny Database. Used by the tests and by
// the local dev server.

import { DatabaseSync } from "node:sqlite";
import { toSqlValue } from "../edge/src/lib/db.js";

const READS_ROWS = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

export function createSqliteDb(path) {
  const sqlite = new DatabaseSync(path);
  // Match Bunny Database: foreign keys are enforced by default.
  sqlite.exec("PRAGMA foreign_keys = ON");
  const plain = (row) => (row ? { ...row } : null);
  const prepare = (sql, args) => [sqlite.prepare(sql), args.map(toSqlValue)];

  return {
    sqlite,
    async all(sql, ...args) {
      const [stmt, values] = prepare(sql, args);
      return stmt.all(...values).map(plain);
    },
    async first(sql, ...args) {
      const [stmt, values] = prepare(sql, args);
      return plain(stmt.get(...values));
    },
    async value(sql, ...args) {
      const [stmt, values] = prepare(sql, args);
      const row = stmt.get(...values);
      return row ? Object.values(row)[0] : null;
    },
    async run(sql, ...args) {
      const [stmt, values] = prepare(sql, args);
      const result = stmt.run(...values);
      return { rowsAffected: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    // Like Bunny's batch: every statement in one transaction.
    async batch(statements, { foreignKeys = true } = {}) {
      if (!foreignKeys) sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(([sql, args = []]) => {
          const [stmt, values] = prepare(sql, args);
          if (READS_ROWS(sql)) return { rows: stmt.all(...values).map(plain), rowsAffected: 0, lastInsertRowid: null };
          const r = stmt.run(...values);
          return { rows: [], rowsAffected: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        if (!foreignKeys) sqlite.exec("PRAGMA foreign_keys = ON");
      }
    },
  };
}

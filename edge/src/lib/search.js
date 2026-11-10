// Full-text search index (steps_fts). Only published documents are indexed.
// Search queries arrive in milestone 6; this module keeps the index current.

// Statements that replace a document's rows in the index.
export function indexDocumentStatements(document, steps) {
  const statements = [["DELETE FROM steps_fts WHERE document_id = ?", [document.id]]];
  if (!document.is_published) return statements;
  for (const step of steps) {
    statements.push([
      "INSERT INTO steps_fts (step_id, document_id, doc_title, step_title, body) VALUES (?, ?, ?, ?, ?)",
      [step.id, document.id, document.title, step.title, step.content_text || ""],
    ]);
  }
  return statements;
}

export function unindexDocumentsStatement(documentIds) {
  if (!documentIds.length) return ["SELECT 1", []];
  return [`DELETE FROM steps_fts WHERE document_id IN (${documentIds.map(() => "?").join(",")})`, documentIds];
}

// ---- Queries (GET /api/search) and rebuilding (POST /api/search/rebuild)

// Snippet markers, turned into <mark> by the browser (never as HTML).
export const MARK_START = "\u0001";
export const MARK_END = "\u0002";

// Each word is quoted (so FTS5 syntax in the input can't do anything) and the
// last word gets prefix matching, so results appear while typing.
export function ftsQuery(input) {
  const words = String(input || "")
    .normalize("NFC")
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu);
  if (!words) return null;
  const quoted = words.slice(0, 12).map((w) => `"${w.replace(/"/g, "")}"`);
  quoted[quoted.length - 1] += "*";
  return quoted.join(" ");
}

// Runs one FTS query and keeps only documents the member can view.
// Returns [{ step_id, document_id, rank, snippet }], best first.
export async function searchSteps(db, access, query, limit = 50) {
  const match = ftsQuery(query);
  if (!match) return [];
  const rows = await db.all(
    `SELECT step_id, document_id, bm25(steps_fts, 0, 0, 10, 5, 1) AS rank,
            snippet(steps_fts, -1, ?, ?, '…', 14) AS snippet
       FROM steps_fts WHERE steps_fts MATCH ? ORDER BY rank LIMIT 300`,
    MARK_START,
    MARK_END,
    match,
  );
  return rows.filter((r) => access.level(Number(r.document_id)) !== "none").slice(0, limit).map((r) => ({ ...r, step_id: Number(r.step_id), document_id: Number(r.document_id) }));
}

export function rebuildStatements(documents, steps) {
  const byDoc = new Map();
  for (const s of steps) {
    if (!byDoc.has(s.document_id)) byDoc.set(s.document_id, []);
    byDoc.get(s.document_id).push(s);
  }
  const statements = [["DELETE FROM steps_fts", []]];
  for (const d of documents) {
    for (const s of byDoc.get(d.id) || []) {
      statements.push(["INSERT INTO steps_fts (step_id, document_id, doc_title, step_title, body) VALUES (?, ?, ?, ?, ?)", [s.id, d.id, d.title, s.title, s.content_text || ""]]);
    }
  }
  return statements;
}

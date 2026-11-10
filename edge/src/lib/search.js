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

// Reading progress and completion rates.
// A step completion is valid if it happened at or after the document's last
// major revision. A document is complete when every current step has a valid
// completion; its completion date is the latest of those dates.

import { loadAccessData, mandatoryByUser } from "./permissions.js";

// Progress of one user on every document: Map(docId -> { total, done, completed_at }).
// A completion is valid if it happened at or after the last major revision.
export async function progressFor(db, userId) {
  const rows = await db.all(
    `SELECT s.document_id AS document_id,
            COUNT(*) AS total,
            SUM(CASE WHEN c.completed_at IS NOT NULL
                      AND (d.last_major_revision_at IS NULL OR c.completed_at >= d.last_major_revision_at)
                     THEN 1 ELSE 0 END) AS done,
            MAX(CASE WHEN c.completed_at IS NOT NULL
                      AND (d.last_major_revision_at IS NULL OR c.completed_at >= d.last_major_revision_at)
                     THEN c.completed_at END) AS completed_at
       FROM steps s
       JOIN documents d ON d.id = s.document_id
       LEFT JOIN step_completions c ON c.step_id = s.id AND c.user_id = ?
      GROUP BY s.document_id`,
    userId,
  );
  return new Map(rows.map((r) => [r.document_id, { total: Number(r.total), done: Number(r.done || 0), completed_at: r.completed_at || null }]));
}

export function progressStatus(progress) {
  if (!progress || !progress.total) return { status: "not_started", done: 0, total: progress ? progress.total : 0, completed_at: null };
  const status = progress.done >= progress.total ? "completed" : progress.done > 0 ? "in_progress" : "not_started";
  return { status, done: progress.done, total: progress.total, completed_at: status === "completed" ? progress.completed_at : null };
}

// Completion rate for many users: Map(userId -> { completed, total }).
export async function completionRates(db, users) {
  if (!users.length) return new Map();
  const data = await loadAccessData(db);
  const mandatory = mandatoryByUser(data, users);
  const totals = new Map((await db.all("SELECT document_id, COUNT(*) AS n FROM steps GROUP BY document_id")).map((r) => [r.document_id, Number(r.n)]));
  const valid = await db.all(
    `SELECT c.user_id, s.document_id, COUNT(*) AS n
       FROM step_completions c
       JOIN steps s ON s.id = c.step_id
       JOIN documents d ON d.id = s.document_id
      WHERE d.is_published = 1 AND (d.last_major_revision_at IS NULL OR c.completed_at >= d.last_major_revision_at)
      GROUP BY c.user_id, s.document_id`,
  );
  const done = new Map(valid.map((r) => [`${r.user_id}:${r.document_id}`, Number(r.n)]));
  const result = new Map();
  for (const user of users) {
    const docs = mandatory.get(user.id);
    let completed = 0;
    for (const id of docs) {
      const total = totals.get(id) || 0;
      if (total && (done.get(`${user.id}:${id}`) || 0) >= total) completed++;
    }
    result.set(user.id, { completed, total: docs.size });
  }
  return result;
}

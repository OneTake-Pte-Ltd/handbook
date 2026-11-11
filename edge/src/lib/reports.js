// Reporting (admins and team leaders). Team leaders only see members of the
// departments they lead.
//   GET /api/reports/overview?department=ID
//   GET /api/reports/users/:id
//   GET /api/reports/documents/:id
//
// Status of a mandatory document for a member:
//   completed        every current step has a valid completion
//   in_progress      some valid completions
//   needs_rereading  no valid completion, but completions from before the last major revision
//   not_started      nothing

import { forbidden, json, notFound } from "./http.js";
import { accessFor, atLeast, loadAccessData, mandatoryByUser } from "./permissions.js";
import { peopleAccess } from "./people.js";

// The members the current user may report on.
async function scopeUsers(ctx) {
  const people = await peopleAccess(ctx);
  if (people.isAdmin) return ctx.db.all("SELECT * FROM users WHERE is_active = 1 ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE");
  if (!people.leads.size) throw forbidden("Reporting is for admins and team leaders.");
  const ids = [...people.leads];
  return ctx.db.all(
    `SELECT DISTINCT u.* FROM users u JOIN department_members m ON m.user_id = u.id
      WHERE u.is_active = 1 AND m.department_id IN (${ids.map(() => "?").join(",")})
      ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE`,
    ...ids,
  );
}

// Everything needed to compute statuses for many members at once.
async function completionData(db) {
  const [documents, totals, completions] = await Promise.all([
    db.all(
      `SELECT d.id, d.title, d.last_major_revision_at, c.name AS category_name, c.emoji AS category_emoji
         FROM documents d JOIN categories c ON c.id = d.category_id WHERE d.is_published = 1`,
    ),
    db.all("SELECT document_id, COUNT(*) AS n FROM steps GROUP BY document_id"),
    db.all("SELECT c.user_id, s.document_id, c.completed_at FROM step_completions c JOIN steps s ON s.id = c.step_id"),
  ]);
  const docs = new Map(documents.map((d) => [d.id, d]));
  const stepTotals = new Map(totals.map((t) => [t.document_id, Number(t.n)]));
  const cells = new Map(); // "user:doc" -> { valid, completedAt, old }
  for (const c of completions) {
    const doc = docs.get(c.document_id);
    if (!doc) continue;
    const key = `${c.user_id}:${c.document_id}`;
    if (!cells.has(key)) cells.set(key, { valid: 0, completedAt: null, old: 0 });
    const cell = cells.get(key);
    if (!doc.last_major_revision_at || c.completed_at >= doc.last_major_revision_at) {
      cell.valid++;
      if (!cell.completedAt || c.completed_at > cell.completedAt) cell.completedAt = c.completed_at;
    } else {
      cell.old++;
    }
  }
  function status(userId, docId) {
    const total = stepTotals.get(docId) || 0;
    const cell = cells.get(`${userId}:${docId}`) || { valid: 0, completedAt: null, old: 0 };
    let value = "not_started";
    if (total && cell.valid >= total) value = "completed";
    else if (cell.valid > 0) value = "in_progress";
    else if (cell.old > 0) value = "needs_rereading";
    return { status: value, done: Math.min(cell.valid, total), total, completed_at: value === "completed" ? cell.completedAt : null };
  }
  return { docs, status };
}

async function lastActivity(db, userIds) {
  if (!userIds.length) return new Map();
  const marks = userIds.map(() => "?").join(",");
  const rows = await db.all(
    `SELECT user_id, MAX(at) AS at FROM (
        SELECT user_id, last_viewed_at AS at FROM step_views WHERE user_id IN (${marks})
        UNION ALL SELECT user_id, completed_at AS at FROM step_completions WHERE user_id IN (${marks})
        UNION ALL SELECT id AS user_id, last_login_at AS at FROM users WHERE id IN (${marks}) AND last_login_at IS NOT NULL
      ) GROUP BY user_id`,
    ...userIds,
    ...userIds,
    ...userIds,
  );
  return new Map(rows.map((r) => [r.user_id, r.at]));
}

async function departmentsOf(db, userIds) {
  const map = new Map(userIds.map((id) => [id, []]));
  if (!userIds.length) return map;
  const rows = await db.all(
    `SELECT m.user_id, d.id, d.name FROM department_members m JOIN departments d ON d.id = m.department_id
      WHERE m.user_id IN (${userIds.map(() => "?").join(",")}) ORDER BY d.position, d.name`,
    ...userIds,
  );
  for (const r of rows) map.get(r.user_id)?.push({ id: r.id, name: r.name });
  return map;
}

const person = (u) => ({ id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email, avatar_url: u.avatar_url || "", role_title: u.role_title });

// GET /api/reports/overview?department=ID
export async function handleReportOverview(ctx) {
  let users = await scopeUsers(ctx);
  const department = Number(ctx.url.searchParams.get("department") || 0);
  if (department) {
    const system = await ctx.db.first("SELECT is_system FROM departments WHERE id = ?", department);
    if (!system) throw notFound("This department doesn't exist.");
    if (!system.is_system) {
      const members = new Set((await ctx.db.all("SELECT user_id FROM department_members WHERE department_id = ?", department)).map((r) => r.user_id));
      users = users.filter((u) => members.has(u.id));
    }
  }
  const ids = users.map((u) => u.id);
  const [data, completion, activity, departments] = await Promise.all([loadAccessData(ctx.db), completionData(ctx.db), lastActivity(ctx.db, ids), departmentsOf(ctx.db, ids)]);
  const mandatory = mandatoryByUser(data, users);
  const rows = users.map((u) => {
    const docs = [...mandatory.get(u.id)];
    const completed = docs.filter((id) => completion.status(u.id, id).status === "completed").length;
    return {
      user: person(u),
      departments: departments.get(u.id),
      assigned: docs.length,
      completed,
      rate: docs.length ? Math.round((completed / docs.length) * 100) : null,
      last_activity: activity.get(u.id) || null,
    };
  });
  return json({ rows });
}

// GET /api/reports/users/:id
export async function handleReportUser(ctx) {
  const users = await scopeUsers(ctx);
  const target = users.find((u) => u.id === Number(ctx.params.id));
  if (!target) throw notFound("This member doesn't exist, or isn't in a department you lead.");
  const [data, completion, viewerAccess] = await Promise.all([loadAccessData(ctx.db), completionData(ctx.db), accessFor(ctx)]);
  const mandatory = [...mandatoryByUser(data, [target]).get(target.id)];
  const documents = mandatory
    .map((id) => {
      const d = completion.docs.get(id);
      return { id, title: d.title, category: { name: d.category_name, emoji: d.category_emoji }, ...completion.status(target.id, id) };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  // Viewing history, limited to documents the viewer can see themself.
  const views = await ctx.db.all(
    `SELECT v.step_id, v.first_viewed_at, v.last_viewed_at, v.view_count, s.title AS step_title, d.id AS document_id, d.title AS document_title
       FROM step_views v JOIN steps s ON s.id = v.step_id JOIN documents d ON d.id = s.document_id
      WHERE v.user_id = ? ORDER BY v.last_viewed_at DESC LIMIT 500`,
    target.id,
  );
  const history = views.filter((v) => viewerAccess.isAdmin || atLeast(viewerAccess.level(v.document_id), "view"));
  const completed = documents.filter((d) => d.status === "completed").length;
  return json({
    user: person(target),
    completion: { completed, total: documents.length, rate: documents.length ? Math.round((completed / documents.length) * 100) : null },
    documents,
    history,
  });
}

// GET /api/reports/documents/:id
export async function handleReportDocument(ctx) {
  const users = await scopeUsers(ctx);
  const access = await accessFor(ctx);
  const document = await ctx.db.first(
    "SELECT d.id, d.title, d.is_published, d.last_major_revision_at, c.name AS category_name, c.emoji AS category_emoji FROM documents d JOIN categories c ON c.id = d.category_id WHERE d.id = ?",
    Number(ctx.params.id),
  );
  if (!document || (!access.isAdmin && !atLeast(access.level(document.id), "view"))) throw notFound("This document doesn't exist or you don't have access to it.");
  const [data, completion] = await Promise.all([loadAccessData(ctx.db), completionData(ctx.db)]);
  // Treat it as published so a report can be prepared before publication.
  data.documents = data.documents.map((d) => (d.id === document.id ? { ...d, is_published: 1 } : d));
  const mandatory = mandatoryByUser(data, users);
  const rows = users
    .filter((u) => mandatory.get(u.id).has(document.id))
    .map((u) => ({ user: person(u), ...(document.is_published ? completion.status(u.id, document.id) : { status: "not_started", done: 0, total: 0, completed_at: null }) }));
  const completed = rows.filter((r) => r.status === "completed").length;
  return json({
    document: { id: document.id, title: document.title, is_published: Boolean(document.is_published), last_major_revision_at: document.last_major_revision_at, category: { name: document.category_name, emoji: document.category_emoji } },
    summary: { members: rows.length, completed },
    rows,
  });
}

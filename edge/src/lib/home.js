// Search, home page and notifications endpoints.

import { badRequest, json, noContent, readJson } from "./http.js";
import { accessFor, atLeast } from "./permissions.js";
import { requireAdmin } from "./people.js";
import { progressFor, progressStatus } from "./progress.js";
import { draftsToReview } from "./drafts.js";
import { rebuildStatements, searchSteps } from "./search.js";

// GET /api/search?q=...&limit=5
export async function handleSearch(ctx) {
  const q = (ctx.url.searchParams.get("q") || "").trim();
  if (q.length > 200) throw badRequest("This search is too long.");
  const limit = Math.min(50, Math.max(1, Number(ctx.url.searchParams.get("limit")) || 20));
  const access = await accessFor(ctx);
  const hits = await searchSteps(ctx.db, access, q, limit);
  if (!hits.length) return json({ query: q, results: [] });
  const stepIds = hits.map((h) => h.step_id);
  const rows = await ctx.db.all(
    `SELECT s.id AS step_id, s.title AS step_title, d.id AS document_id, d.title AS document_title,
            c.name AS category_name, c.emoji AS category_emoji
       FROM steps s JOIN documents d ON d.id = s.document_id JOIN categories c ON c.id = d.category_id
      WHERE s.id IN (${stepIds.map(() => "?").join(",")}) AND d.is_published = 1`,
    ...stepIds,
  );
  const byStep = new Map(rows.map((r) => [r.step_id, r]));
  const results = hits
    .filter((h) => byStep.has(h.step_id))
    .map((h) => {
      const r = byStep.get(h.step_id);
      return {
        step_id: h.step_id,
        step_title: r.step_title,
        document_id: r.document_id,
        document_title: r.document_title,
        category: { name: r.category_name, emoji: r.category_emoji },
        snippet: h.snippet,
      };
    });
  return json({ query: q, results });
}

// POST /api/search/rebuild (admins)
export async function handleRebuildSearch(ctx) {
  requireAdmin(ctx);
  const documents = await ctx.db.all("SELECT id, title FROM documents WHERE is_published = 1");
  const steps = await ctx.db.all("SELECT s.id, s.document_id, s.title, s.content_text FROM steps s JOIN documents d ON d.id = s.document_id WHERE d.is_published = 1");
  await ctx.db.batch(rebuildStatements(documents, steps));
  return json({ ok: true, documents: documents.length, steps: steps.length });
}

function readingMinutes(words) {
  return Math.max(1, Math.round(words / 200));
}

// GET /api/home
export async function handleHome(ctx) {
  const access = await accessFor(ctx);
  const [documents, progress, wordRows] = await Promise.all([
    ctx.db.all(
      `SELECT d.id, d.title, d.description, d.updated_at, d.published_at, d.last_major_revision_at, c.name AS category_name, c.emoji AS category_emoji
         FROM documents d JOIN categories c ON c.id = d.category_id WHERE d.is_published = 1`,
    ),
    progressFor(ctx.db, ctx.user.id),
    ctx.db.all("SELECT document_id, COUNT(*) AS steps, SUM(LENGTH(content_text) - LENGTH(REPLACE(content_text, ' ', '')) + 1) AS words FROM steps GROUP BY document_id"),
  ]);
  const words = new Map(wordRows.map((r) => [r.document_id, { steps: Number(r.steps), words: Number(r.words || 0) }]));
  const visible = documents.filter((d) => atLeast(access.level(d.id), "view"));
  const card = (d) => ({
    id: d.id,
    title: d.title,
    description: d.description,
    category: { name: d.category_name, emoji: d.category_emoji },
    steps: words.get(d.id)?.steps || 0,
    minutes: readingMinutes(words.get(d.id)?.words || 0),
    progress: progressStatus(progress.get(d.id)),
    mandatory: access.mandatory(d.id),
    updated_at: d.updated_at,
    major_update: Boolean(d.last_major_revision_at && d.last_major_revision_at === d.updated_at),
  });

  const mandatory = visible.filter((d) => access.mandatory(d.id)).map(card);
  const completed = mandatory.filter((d) => d.progress.status === "completed").length;
  const recent = [...visible].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || "")).slice(0, 5).map(card);

  return json({
    requires_completion: mandatory.filter((d) => d.progress.status !== "completed"),
    completion: { completed, total: mandatory.length },
    recently_updated: recent,
    waiting_for_review: await draftsToReview(ctx),
  });
}

const DOCUMENT_TYPES = new Set(["review_requested", "draft_approved", "draft_rejected", "mandatory_assigned", "major_revision"]);

// GET /api/notifications
export async function handleNotifications(ctx) {
  const countOnly = ctx.url.searchParams.get("count") === "1";
  const unread = Number(await ctx.db.value("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL", ctx.user.id));
  if (countOnly) return json({ unread_count: unread });
  const rows = await ctx.db.all("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50", ctx.user.id);
  const [users, departments] = await Promise.all([
    ctx.db.all("SELECT id, first_name, last_name FROM users"),
    ctx.db.all("SELECT id, name FROM departments"),
  ]);
  const userName = new Map(users.map((u) => [u.id, `${u.first_name} ${u.last_name}`]));
  const departmentName = new Map(departments.map((d) => [d.id, d.name]));
  const access = await accessFor(ctx);
  const items = rows.map((n) => {
    let payload = {};
    try {
      payload = JSON.parse(n.payload_json);
    } catch {
      payload = {};
    }
    const item = {
      id: n.id,
      type: n.type,
      created_at: n.created_at,
      read: Boolean(n.read_at),
      actor: payload.by ? userName.get(payload.by) || null : null,
      title: payload.title || "",
      comment: payload.comment || "",
      department: payload.department_id ? departmentName.get(payload.department_id) || "a department" : "",
      link: "#/profile",
    };
    if (DOCUMENT_TYPES.has(n.type) && payload.document_id) {
      // Only link to documents the member can still open.
      item.link = access.level(payload.document_id) !== "none" ? `#/doc/${payload.document_id}` : null;
    }
    return item;
  });
  return json({ unread_count: unread, items });
}

// POST /api/notifications/read { ids: [...] } or { all: true }
export async function handleReadNotifications(ctx) {
  const body = await readJson(ctx.request);
  const now = new Date().toISOString();
  if (body.all) {
    await ctx.db.run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", now, ctx.user.id);
    return noContent();
  }
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger).slice(0, 100) : [];
  if (!ids.length) throw badRequest("Nothing to mark as read.");
  await ctx.db.run(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`, now, ctx.user.id, ...ids);
  return noContent();
}

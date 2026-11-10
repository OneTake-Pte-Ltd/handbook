// Spaces, categories, documents, steps, views and completions.
//
// Until drafts arrive in milestone 5, edits save directly:
// - unpublished documents can be edited with "Edit with review" or higher;
// - published documents need "Edit and publish" (so nobody bypasses review);
// - only "Edit and publish" can publish, unpublish and delete.

import { nowIso } from "./db.js";
import { HttpError, badRequest, forbidden, json, noContent, notFound, optionalString, readJson, requireString } from "./http.js";
import { accessFor, atLeast, canEditDocument, canView } from "./permissions.js";
import { notificationStatement, peopleAccess, requireAdmin } from "./people.js";
import { unindexDocumentsStatement } from "./search.js";
import { progressFor, progressStatus } from "./progress.js";

// Plain text (milestone 3 editor) to the Tiptap JSON stored in content_json.
// Blank lines separate paragraphs; single line breaks become hard breaks.
export function textToDoc(text) {
  const paragraphs = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    type: "doc",
    content: paragraphs.length
      ? paragraphs.map((p) => ({
          type: "paragraph",
          content: p.split("\n").flatMap((line, i) => [...(i ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]),
        }))
      : [{ type: "paragraph" }],
  };
}

// Loads a document the current user may see; otherwise 404 (not 403), so
// people can't learn which document IDs exist.
async function visibleDocument(ctx, id) {
  const document = await ctx.db.first("SELECT * FROM documents WHERE id = ?", Number(id));
  const access = await accessFor(ctx);
  if (!document || !canView(access, document)) throw notFound("This document doesn't exist or you don't have access to it.");
  return document;
}

async function stepWithDocument(ctx, stepId) {
  const step = await ctx.db.first("SELECT * FROM steps WHERE id = ?", Number(stepId));
  if (!step) throw notFound("This step doesn't exist.");
  return step;
}

async function nextPosition(db, table, column, parentId) {
  return Number(await db.value(`SELECT COALESCE(MAX(position), 0) + 1 FROM ${table} WHERE ${column} = ?`, parentId));
}

function touch(ctx, documentId) {
  return ["UPDATE documents SET updated_at = ?, updated_by = ? WHERE id = ?", [nowIso(), ctx.user.id, documentId]];
}

// GET /api/tree?mode=edit
export async function handleTree(ctx) {
  const access = await accessFor(ctx);
  const editMode = ctx.url.searchParams.get("mode") === "edit";
  const [spaces, categories, documents, progress, drafts] = await Promise.all([
    ctx.db.all("SELECT * FROM spaces ORDER BY position, id"),
    ctx.db.all("SELECT * FROM categories ORDER BY position, id"),
    ctx.db.all("SELECT id, category_id, title, description, position, is_published, published_at, last_major_revision_at, updated_at FROM documents ORDER BY position, id"),
    progressFor(ctx.db, ctx.user.id),
    editMode ? ctx.db.all("SELECT document_id, status FROM drafts") : [],
  ]);
  const draftStatus = new Map(drafts.map((d) => [d.document_id, d.status]));
  const docsByCategory = new Map();
  for (const d of documents) {
    const visible = editMode ? canView(access, d) : d.is_published && atLeast(access.level(d.id), "view");
    if (!visible) continue;
    if (!docsByCategory.has(d.category_id)) docsByCategory.set(d.category_id, []);
    docsByCategory.get(d.category_id).push({
      id: d.id,
      title: d.title,
      is_published: Boolean(d.is_published),
      level: access.level(d.id),
      can_edit: canEditDocument(access, d),
      draft_status: editMode && canEditDocument(access, d) ? draftStatus.get(d.id) || null : null,
      mandatory: access.mandatory(d.id),
      progress: progressStatus(progress.get(d.id)),
    });
  }
  const categoriesBySpace = new Map();
  for (const c of categories) {
    const docs = docsByCategory.get(c.id) || [];
    const canCreate = access.canCreateIn(c.id);
    if (!docs.length && !(editMode && canCreate)) continue;
    if (!categoriesBySpace.has(c.space_id)) categoriesBySpace.set(c.space_id, []);
    categoriesBySpace.get(c.space_id).push({ id: c.id, name: c.name, emoji: c.emoji, can_create: canCreate, documents: docs });
  }
  const tree = spaces
    .map((s) => ({ id: s.id, name: s.name, categories: categoriesBySpace.get(s.id) || [] }))
    .filter((s) => s.categories.length || (editMode && access.isAdmin));
  return json({ spaces: tree, can_manage: access.isAdmin, can_edit: access.canEditAnything });
}

// GET /api/documents/:id
export async function handleGetDocument(ctx) {
  const document = await visibleDocument(ctx, ctx.params.id);
  const access = await accessFor(ctx);
  const [category, steps, completions] = await Promise.all([
    ctx.db.first("SELECT c.id, c.name, c.emoji, s.id AS space_id, s.name AS space_name FROM categories c JOIN spaces s ON s.id = c.space_id WHERE c.id = ?", document.category_id),
    ctx.db.all("SELECT id, title, position, content_json, content_text, updated_at FROM steps WHERE document_id = ? ORDER BY position, id", document.id),
    ctx.db.all(
      "SELECT c.step_id, c.completed_at FROM step_completions c JOIN steps s ON s.id = c.step_id WHERE s.document_id = ? AND c.user_id = ?",
      document.id,
      ctx.user.id,
    ),
  ]);
  const completedAt = new Map(completions.map((c) => [c.step_id, c.completed_at]));
  const major = document.last_major_revision_at;
  const stepList = steps.map((s) => {
    const at = completedAt.get(s.id);
    const valid = Boolean(at && (!major || at >= major));
    return {
      id: s.id,
      title: s.title,
      content_json: s.content_json ? JSON.parse(s.content_json) : null,
      content_text: s.content_text,
      updated_at: s.updated_at,
      completed: valid,
      completed_at: valid ? at : null,
    };
  });
  const done = stepList.filter((s) => s.completed).length;
  const level = access.level(document.id);
  const draft = atLeast(level, "edit_review")
    ? await ctx.db.first(
        "SELECT d.status, d.updated_at, u.first_name, u.last_name FROM drafts d LEFT JOIN users u ON u.id = d.author_id WHERE d.document_id = ?",
        document.id,
      )
    : null;
  return json({
    draft: draft ? { status: draft.status, updated_at: draft.updated_at, author: draft.first_name ? `${draft.first_name} ${draft.last_name}` : null } : null,
    document: {
      id: document.id,
      title: document.title,
      description: document.description,
      is_published: Boolean(document.is_published),
      published_at: document.published_at,
      last_major_revision_at: document.last_major_revision_at,
      updated_at: document.updated_at,
    },
    category,
    steps: stepList,
    progress: progressStatus({ total: stepList.length, done, completed_at: stepList.reduce((m, s) => (s.completed_at && s.completed_at > (m || "") ? s.completed_at : m), null) }),
    mandatory: access.mandatory(document.id),
    permissions: {
      level,
      can_edit: canEditDocument(access, document),
      can_publish: atLeast(level, "edit_publish"),
      can_review: atLeast(level, "edit_publish") || access.isAdmin,
      can_delete: atLeast(level, "edit_publish"),
      can_manage_access: access.isAdmin || (await peopleAccess(ctx)).leads.size > 0,
    },
  });
}

function documentFields(body, { partial }) {
  const fields = {};
  if (!partial || "title" in body) fields.title = requireString(body, "title", "Title", { max: 200 });
  if (!partial || "description" in body) fields.description = optionalString(body, "description", "Description", { max: 1000 });
  return fields;
}

// POST /api/documents { category_id, title, description }
export async function handleCreateDocument(ctx) {
  const body = await readJson(ctx.request);
  const categoryId = Number(body.category_id);
  const category = await ctx.db.first("SELECT id FROM categories WHERE id = ?", categoryId);
  if (!category) throw notFound("This category doesn't exist.");
  const access = await accessFor(ctx);
  if (!access.canCreateIn(categoryId)) throw forbidden("You can't create documents in this category.");
  const fields = documentFields(body, { partial: false });
  const now = nowIso();
  const position = await nextPosition(ctx.db, "documents", "category_id", categoryId);
  const result = await ctx.db.run(
    `INSERT INTO documents (category_id, title, description, position, is_published, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    categoryId,
    fields.title,
    fields.description,
    position,
    now,
    ctx.user.id,
    now,
    ctx.user.id,
  );
  const id = result.lastInsertRowid;
  const step = await ctx.db.run(
    "INSERT INTO steps (document_id, title, position, content_json, content_text, updated_at) VALUES (?, ?, 1, ?, '', ?)",
    id,
    fields.title,
    JSON.stringify(textToDoc("")),
    now,
  );
  // New documents start with a draft, which readers never see.
  const snapshot = { title: fields.title, description: fields.description, steps: [{ id: step.lastInsertRowid, key: `s${step.lastInsertRowid}`, title: fields.title, content_json: textToDoc("") }] };
  await ctx.db.run(
    "INSERT INTO drafts (document_id, snapshot_json, status, author_id, created_at, updated_at) VALUES (?, ?, 'editing', ?, ?, ?)",
    id,
    JSON.stringify(snapshot),
    ctx.user.id,
    now,
    now,
  );
  return json({ document: { id, ...fields, is_published: false } }, 201);
}

// POST /api/documents/:id/unpublish (Edit and publish): readers stop seeing it.
export async function handleUnpublishDocument(ctx) {
  const document = await visibleDocument(ctx, ctx.params.id);
  const access = await accessFor(ctx);
  if (!atLeast(access.level(document.id), "edit_publish")) throw forbidden("Unpublishing needs Edit and publish.");
  await ctx.db.batch([["UPDATE documents SET is_published = 0 WHERE id = ?", [document.id]], unindexDocumentsStatement([document.id])]);
  return json({ ok: true });
}

// DELETE /api/documents/:id
export async function handleDeleteDocument(ctx) {
  const document = await visibleDocument(ctx, ctx.params.id);
  const access = await accessFor(ctx);
  if (!atLeast(access.level(document.id), "edit_publish")) throw forbidden("Deleting a document needs Edit and publish.");
  await ctx.db.batch([unindexDocumentsStatement([document.id]), ["DELETE FROM documents WHERE id = ?", [document.id]]]);
  return noContent();
}

// POST /api/documents/:id/move { category_id }
export async function handleMoveDocument(ctx) {
  const document = await visibleDocument(ctx, ctx.params.id);
  const access = await accessFor(ctx);
  const body = await readJson(ctx.request);
  const target = await ctx.db.first("SELECT id FROM categories WHERE id = ?", Number(body.category_id));
  if (!target) throw notFound("This category doesn't exist.");
  if (!atLeast(access.level(document.id), "edit_publish") || !access.canCreateIn(target.id)) {
    throw forbidden("Moving a document needs Edit and publish on it and edit access to the target category.");
  }
  const position = await nextPosition(ctx.db, "documents", "category_id", target.id);
  await ctx.db.batch([["UPDATE documents SET category_id = ?, position = ? WHERE id = ?", [target.id, position, document.id]], touch(ctx, document.id)]);
  return json({ ok: true });
}

async function readableStep(ctx, stepId) {
  const step = await stepWithDocument(ctx, stepId);
  const document = await visibleDocument(ctx, step.document_id);
  if (!document.is_published) throw badRequest("Unpublished documents can't be completed yet.");
  return step;
}

// POST /api/steps/:id/view
export async function handleViewStep(ctx) {
  const step = await stepWithDocument(ctx, ctx.params.id);
  await visibleDocument(ctx, step.document_id);
  const now = nowIso();
  await ctx.db.run(
    `INSERT INTO step_views (user_id, step_id, first_viewed_at, last_viewed_at, view_count) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(user_id, step_id) DO UPDATE SET last_viewed_at = excluded.last_viewed_at, view_count = view_count + 1`,
    ctx.user.id,
    step.id,
    now,
    now,
  );
  return noContent();
}

// POST /api/steps/:id/complete
export async function handleCompleteStep(ctx) {
  const step = await readableStep(ctx, ctx.params.id);
  const now = nowIso();
  await ctx.db.run(
    `INSERT INTO step_completions (user_id, step_id, completed_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, step_id) DO UPDATE SET completed_at = excluded.completed_at`,
    ctx.user.id,
    step.id,
    now,
  );
  return json({ ok: true, completed_at: now });
}

// DELETE /api/steps/:id/complete
export async function handleUncompleteStep(ctx) {
  const step = await readableStep(ctx, ctx.params.id);
  await ctx.db.run("DELETE FROM step_completions WHERE user_id = ? AND step_id = ?", ctx.user.id, step.id);
  return noContent();
}

// Spaces and categories (admins only).

export async function handleCreateSpace(ctx) {
  requireAdmin(ctx);
  const name = requireString(await readJson(ctx.request), "name", "Space name", { max: 120 });
  const position = Number(await ctx.db.value("SELECT COALESCE(MAX(position), 0) + 1 FROM spaces"));
  const result = await ctx.db.run("INSERT INTO spaces (name, position) VALUES (?, ?)", name, position);
  return json({ space: { id: result.lastInsertRowid, name } }, 201);
}

export async function handleUpdateSpace(ctx) {
  requireAdmin(ctx);
  const space = await ctx.db.first("SELECT id FROM spaces WHERE id = ?", Number(ctx.params.id));
  if (!space) throw notFound("This space doesn't exist.");
  const name = requireString(await readJson(ctx.request), "name", "Space name", { max: 120 });
  await ctx.db.run("UPDATE spaces SET name = ? WHERE id = ?", name, space.id);
  return json({ ok: true });
}

export async function handleDeleteSpace(ctx) {
  requireAdmin(ctx);
  const space = await ctx.db.first("SELECT id FROM spaces WHERE id = ?", Number(ctx.params.id));
  if (!space) throw notFound("This space doesn't exist.");
  const docs = await ctx.db.all("SELECT d.id FROM documents d JOIN categories c ON c.id = d.category_id WHERE c.space_id = ?", space.id);
  await ctx.db.batch([unindexDocumentsStatement(docs.map((d) => d.id)), ["DELETE FROM spaces WHERE id = ?", [space.id]]]);
  return noContent();
}

function categoryFields(body, { partial }) {
  const fields = {};
  if (!partial || "name" in body) fields.name = requireString(body, "name", "Category name", { max: 120 });
  if (!partial || "emoji" in body) {
    const emoji = optionalString(body, "emoji", "Emoji", { max: 16 });
    if ([...emoji].length > 4) throw badRequest("Please use a single emoji.");
    fields.emoji = emoji;
  }
  return fields;
}

export async function handleCreateCategory(ctx) {
  requireAdmin(ctx);
  const body = await readJson(ctx.request);
  const space = await ctx.db.first("SELECT id FROM spaces WHERE id = ?", Number(body.space_id));
  if (!space) throw notFound("This space doesn't exist.");
  const fields = categoryFields(body, { partial: false });
  const position = await nextPosition(ctx.db, "categories", "space_id", space.id);
  const result = await ctx.db.run("INSERT INTO categories (space_id, name, emoji, position) VALUES (?, ?, ?, ?)", space.id, fields.name, fields.emoji, position);
  return json({ category: { id: result.lastInsertRowid, ...fields } }, 201);
}

export async function handleUpdateCategory(ctx) {
  requireAdmin(ctx);
  const category = await ctx.db.first("SELECT * FROM categories WHERE id = ?", Number(ctx.params.id));
  if (!category) throw notFound("This category doesn't exist.");
  const body = await readJson(ctx.request);
  const fields = categoryFields(body, { partial: true });
  if ("space_id" in body) {
    const space = await ctx.db.first("SELECT id FROM spaces WHERE id = ?", Number(body.space_id));
    if (!space) throw notFound("This space doesn't exist.");
    if (space.id !== category.space_id) {
      fields.space_id = space.id;
      fields.position = await nextPosition(ctx.db, "categories", "space_id", space.id);
    }
  }
  const keys = Object.keys(fields);
  if (!keys.length) throw badRequest("Nothing to change.");
  await ctx.db.run(`UPDATE categories SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => fields[k]), category.id);
  return json({ ok: true });
}

export async function handleDeleteCategory(ctx) {
  requireAdmin(ctx);
  const category = await ctx.db.first("SELECT id FROM categories WHERE id = ?", Number(ctx.params.id));
  if (!category) throw notFound("This category doesn't exist.");
  const docs = await ctx.db.all("SELECT id FROM documents WHERE category_id = ?", category.id);
  await ctx.db.batch([unindexDocumentsStatement(docs.map((d) => d.id)), ["DELETE FROM categories WHERE id = ?", [category.id]]]);
  return noContent();
}

// POST /api/reorder { type: "space"|"category"|"document", ids: [...] } (steps are reordered in the draft)
// The ids are the new order of all the items of one parent.
export async function handleReorder(ctx) {
  const body = await readJson(ctx.request);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  if (!ids.length || ids.some((id) => !Number.isInteger(id)) || new Set(ids).size !== ids.length) throw badRequest("Please send the new order as a list of IDs.");
  const tables = { space: ["spaces", null], category: ["categories", "space_id"], document: ["documents", "category_id"] };
  if (!tables[body.type]) throw badRequest("Unknown item type.");
  const [table, parentColumn] = tables[body.type];
  const rows = await ctx.db.all(`SELECT id${parentColumn ? `, ${parentColumn} AS parent` : ""} FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
  if (rows.length !== ids.length) throw notFound("Some of these items don't exist.");
  const parents = new Set(rows.map((r) => r.parent));
  if (parentColumn && parents.size !== 1) throw badRequest("Items can only be reordered within the same parent.");
  const parent = [...parents][0];
  if (parentColumn) {
    const siblings = Number(await ctx.db.value(`SELECT COUNT(*) FROM ${table} WHERE ${parentColumn} = ?`, parent));
    if (siblings !== ids.length) throw new HttpError(409, "The list changed in the meantime. Please reload and try again.");
  }

  const access = await accessFor(ctx);
  if (body.type === "space" || body.type === "category") requireAdmin(ctx);
  if (body.type === "document" && !access.canCreateIn(parent)) throw forbidden("You can't reorder documents in this category.");
  await ctx.db.batch(ids.map((id, i) => [`UPDATE ${table} SET position = ? WHERE id = ?`, [i + 1, id]]));
  return json({ ok: true });
}

// Spaces, categories, documents, steps, views and completions.
//
// Until drafts arrive in milestone 5, edits save directly:
// - unpublished documents can be edited with "Edit with review" or higher;
// - published documents need "Edit and publish" (so nobody bypasses review);
// - only "Edit and publish" can publish, unpublish and delete.

import { nowIso } from "./db.js";
import { HttpError, badRequest, forbidden, json, noContent, notFound, optionalString, readJson, requireString } from "./http.js";
import { accessFor, atLeast, canEditDocument, canView, loadAccessData, mandatoryByUser } from "./permissions.js";
import { notificationStatement, peopleAccess, requireAdmin } from "./people.js";
import { indexDocumentStatements, unindexDocumentsStatement } from "./search.js";
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

async function getDocumentRow(db, id) {
  const document = await db.first("SELECT * FROM documents WHERE id = ?", Number(id));
  if (!document) throw notFound("This document doesn't exist.");
  return document;
}

// Loads a document the current user may see; otherwise 404 (not 403), so
// people can't learn which document IDs exist.
async function visibleDocument(ctx, id) {
  const document = await ctx.db.first("SELECT * FROM documents WHERE id = ?", Number(id));
  const access = await accessFor(ctx);
  if (!document || !canView(access, document)) throw notFound("This document doesn't exist or you don't have access to it.");
  return document;
}

async function editableDocument(ctx, id) {
  const document = await visibleDocument(ctx, id);
  const access = await accessFor(ctx);
  if (!canEditDocument(access, document)) {
    throw forbidden(document.is_published && atLeast(access.level(document.id), "edit_review")
      ? "Published documents can only be changed with Edit and publish for now. Review arrives with the editor."
      : "You can't edit this document.");
  }
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
  const [spaces, categories, documents, progress] = await Promise.all([
    ctx.db.all("SELECT * FROM spaces ORDER BY position, id"),
    ctx.db.all("SELECT * FROM categories ORDER BY position, id"),
    ctx.db.all("SELECT id, category_id, title, description, position, is_published, published_at, last_major_revision_at, updated_at FROM documents ORDER BY position, id"),
    progressFor(ctx.db, ctx.user.id),
  ]);
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
  return json({
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
  await ctx.db.run(
    "INSERT INTO steps (document_id, title, position, content_json, content_text, updated_at) VALUES (?, ?, 1, ?, '', ?)",
    id,
    fields.title,
    JSON.stringify(textToDoc("")),
    now,
  );
  return json({ document: { id, ...fields, is_published: false } }, 201);
}

// PATCH /api/documents/:id { title, description }
export async function handleUpdateDocument(ctx) {
  const document = await editableDocument(ctx, ctx.params.id);
  const fields = documentFields(await readJson(ctx.request), { partial: true });
  const keys = Object.keys(fields);
  if (!keys.length) throw badRequest("Nothing to change.");
  const statements = [[`UPDATE documents SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => fields[k]), document.id]], touch(ctx, document.id)];
  if (document.is_published) statements.push(...(await indexStatementsAfter(ctx, document.id, fields)));
  await ctx.db.batch(statements);
  return json({ ok: true });
}

// The search index must follow published documents. Builds the statements
// that re-index a document, given changes not yet written.
async function indexStatementsAfter(ctx, documentId, documentChanges = {}, stepChanges = null) {
  const document = { ...(await getDocumentRow(ctx.db, documentId)), ...documentChanges };
  let steps = await ctx.db.all("SELECT id, title, content_text FROM steps WHERE document_id = ? ORDER BY position, id", documentId);
  if (stepChanges) steps = stepChanges(steps);
  return indexDocumentStatements(document, steps);
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

// Users who must be told about a mandatory document (active, mandatory by grant).
async function mandatoryAudience(ctx, documentId, { onlyNewSince } = {}) {
  const users = await ctx.db.all("SELECT id, is_active, is_admin FROM users WHERE is_active = 1");
  const data = await loadAccessData(ctx.db);
  // Treat the document as published for this computation.
  data.documents = data.documents.map((d) => (d.id === documentId ? { ...d, is_published: 1 } : d));
  const mandatory = mandatoryByUser(data, users);
  return users.filter((u) => mandatory.get(u.id).has(documentId) && (!onlyNewSince || !onlyNewSince.has(u.id))).map((u) => u.id);
}

// POST /api/documents/:id/publish { publish: true|false, revision: "minor"|"major" }
// Temporary milestone 3 endpoint; drafts and review replace it in milestone 5.
export async function handlePublishDocument(ctx) {
  const document = await visibleDocument(ctx, ctx.params.id);
  const access = await accessFor(ctx);
  if (!atLeast(access.level(document.id), "edit_publish")) throw forbidden("Publishing needs Edit and publish.");
  const body = await readJson(ctx.request);
  const now = nowIso();

  if (body.publish === false) {
    await ctx.db.batch([["UPDATE documents SET is_published = 0 WHERE id = ?", [document.id]], unindexDocumentsStatement([document.id])]);
    return json({ ok: true, is_published: false });
  }

  const firstPublication = !document.is_published && !document.published_at;
  const major = body.revision === "major" && Boolean(document.published_at);
  const statements = [
    [
      `UPDATE documents SET is_published = 1, published_at = COALESCE(published_at, ?), updated_at = ?, updated_by = ?
         ${major ? ", last_major_revision_at = ?" : ""} WHERE id = ?`,
      major ? [now, now, ctx.user.id, now, document.id] : [now, now, ctx.user.id, document.id],
    ],
    ...(await indexStatementsAfter(ctx, document.id, { is_published: 1 })),
  ];
  if (firstPublication || major) {
    const audience = await mandatoryAudience(ctx, document.id);
    for (const userId of audience) {
      statements.push(notificationStatement(userId, major ? "major_revision" : "mandatory_assigned", { document_id: document.id, title: document.title }));
    }
  }
  await ctx.db.batch(statements);
  return json({ ok: true, is_published: true, revision: major ? "major" : "minor" });
}

// POST /api/documents/:id/steps { title, after_step_id }
export async function handleCreateStep(ctx) {
  const document = await editableDocument(ctx, ctx.params.id);
  const body = await readJson(ctx.request);
  const title = requireString(body, "title", "Step title", { max: 200 });
  const steps = await ctx.db.all("SELECT id FROM steps WHERE document_id = ? ORDER BY position, id", document.id);
  const afterIndex = body.after_step_id ? steps.findIndex((s) => s.id === Number(body.after_step_id)) : steps.length - 1;
  const now = nowIso();
  const result = await ctx.db.run(
    "INSERT INTO steps (document_id, title, position, content_json, content_text, updated_at) VALUES (?, ?, 0, ?, '', ?)",
    document.id,
    title,
    JSON.stringify(textToDoc("")),
    now,
  );
  const ids = steps.map((s) => s.id);
  ids.splice(afterIndex + 1, 0, result.lastInsertRowid);
  const statements = ids.map((id, i) => ["UPDATE steps SET position = ? WHERE id = ?", [i + 1, id]]);
  statements.push(touch(ctx, document.id));
  if (document.is_published) statements.push(...(await indexStatementsAfter(ctx, document.id)));
  await ctx.db.batch(statements);
  return json({ step: { id: result.lastInsertRowid, title } }, 201);
}

// PATCH /api/steps/:id { title, content_text }
export async function handleUpdateStep(ctx) {
  const step = await stepWithDocument(ctx, ctx.params.id);
  const document = await editableDocument(ctx, step.document_id);
  const body = await readJson(ctx.request, 2_000_000);
  const changes = {};
  if ("title" in body) changes.title = requireString(body, "title", "Step title", { max: 200 });
  if ("content_text" in body) {
    if (typeof body.content_text !== "string") throw badRequest("The content must be text.");
    if (body.content_text.length > 500_000) throw badRequest("This step is too long.");
    changes.content_text = body.content_text.replace(/\r\n?/g, "\n");
    changes.content_json = JSON.stringify(textToDoc(changes.content_text));
  }
  const keys = Object.keys(changes);
  if (!keys.length) throw badRequest("Nothing to change.");
  const now = nowIso();
  const statements = [
    [`UPDATE steps SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...keys.map((k) => changes[k]), now, step.id]],
    touch(ctx, document.id),
  ];
  if (document.is_published) {
    statements.push(...(await indexStatementsAfter(ctx, document.id, {}, (steps) => steps.map((s) => (s.id === step.id ? { ...s, ...changes } : s)))));
  }
  await ctx.db.batch(statements);
  return json({ ok: true, updated_at: now });
}

// DELETE /api/steps/:id
export async function handleDeleteStep(ctx) {
  const step = await stepWithDocument(ctx, ctx.params.id);
  const document = await editableDocument(ctx, step.document_id);
  const count = Number(await ctx.db.value("SELECT COUNT(*) FROM steps WHERE document_id = ?", document.id));
  if (count <= 1) throw badRequest("A document needs at least one step.");
  const statements = [["DELETE FROM steps WHERE id = ?", [step.id]], touch(ctx, document.id)];
  if (document.is_published) statements.push(...(await indexStatementsAfter(ctx, document.id, {}, (steps) => steps.filter((s) => s.id !== step.id))));
  await ctx.db.batch(statements);
  return noContent();
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

// POST /api/reorder { type: "space"|"category"|"document"|"step", ids: [...] }
// The ids are the new order of all the items of one parent.
export async function handleReorder(ctx) {
  const body = await readJson(ctx.request);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  if (!ids.length || ids.some((id) => !Number.isInteger(id)) || new Set(ids).size !== ids.length) throw badRequest("Please send the new order as a list of IDs.");
  const tables = { space: ["spaces", null], category: ["categories", "space_id"], document: ["documents", "category_id"], step: ["steps", "document_id"] };
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
  const statements = ids.map((id, i) => [`UPDATE ${table} SET position = ? WHERE id = ?`, [i + 1, id]]);
  if (body.type === "step") {
    const document = await editableDocument(ctx, parent);
    statements.push(touch(ctx, document.id));
  }
  await ctx.db.batch(statements);
  return json({ ok: true });
}

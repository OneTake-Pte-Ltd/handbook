// Drafts, publishing and review.
//
// Readers never see work in progress. Editing a document happens in its one
// draft, a snapshot of the title, description and ordered steps. Publishing
// copies the draft over the document and deletes the draft.
//
// - Edit and publish: publishes directly (minor or major revision).
// - Edit with review: submits for review; the draft is then read-only until
//   a reviewer approves (and publishes) or rejects it with a comment.
// - Reviewers: non-admin members with Edit and publish on the document; if
//   there are none, all admins. Admins can always review.

import { nowIso } from "./db.js";
import { HttpError, badRequest, forbidden, json, noContent, notFound, optionalString, readJson } from "./http.js";
import { accessFor, atLeast, canView, loadAccessData, mandatoryByUser, resolveAccess } from "./permissions.js";
import { notificationStatement } from "./people.js";
import { indexDocumentStatements } from "./search.js";
import { cleanDoc, docToText } from "./richtext.js";

const MAX_STEPS = 200;

async function documentFor(ctx, id) {
  const document = await ctx.db.first("SELECT * FROM documents WHERE id = ?", Number(id));
  const access = await accessFor(ctx);
  if (!document || !canView(access, document)) throw notFound("This document doesn't exist or you don't have access to it.");
  return { document, access, level: access.level(document.id) };
}

async function requireEditor(ctx, id) {
  const found = await documentFor(ctx, id);
  if (!atLeast(found.level, "edit_review")) throw forbidden("You can't edit this document.");
  return found;
}

async function publishedSnapshot(db, document) {
  const steps = await db.all("SELECT id, title, content_json FROM steps WHERE document_id = ? ORDER BY position, id", document.id);
  return {
    title: document.title,
    description: document.description || "",
    steps: steps.map((s) => ({ id: s.id, key: `s${s.id}`, title: s.title, content_json: s.content_json ? JSON.parse(s.content_json) : cleanDoc(null) })),
  };
}

async function userName(db, id) {
  if (!id) return null;
  const u = await db.first("SELECT id, first_name, last_name FROM users WHERE id = ?", id);
  return u ? { id: u.id, name: `${u.first_name} ${u.last_name}` } : null;
}

// Reviewers of a document: user ids.
export async function reviewersOf(db, documentId) {
  const users = await db.all("SELECT * FROM users WHERE is_active = 1");
  const data = await loadAccessData(db);
  const editors = users.filter((u) => !u.is_admin && resolveAccess(data, u).level(documentId) === "edit_publish");
  return (editors.length ? editors : users.filter((u) => u.is_admin)).map((u) => u.id);
}

async function draftView(ctx, document, draft, level) {
  const isAuthor = draft.author_id === ctx.user.id;
  const reviewers = draft.status === "submitted" ? await reviewersOf(ctx.db, document.id) : [];
  const canReview = draft.status === "submitted" && (ctx.user.is_admin || level === "edit_publish" || reviewers.includes(ctx.user.id));
  return {
    draft: {
      id: draft.id,
      status: draft.status,
      revision_type: draft.revision_type,
      submit_note: draft.submit_note,
      review_comment: draft.review_comment,
      author: await userName(ctx.db, draft.author_id),
      reviewer: await userName(ctx.db, draft.reviewer_id),
      submitted_at: draft.submitted_at,
      reviewed_at: draft.reviewed_at,
      created_at: draft.created_at,
      updated_at: draft.updated_at,
      snapshot: JSON.parse(draft.snapshot_json),
    },
    published: document.published_at ? await publishedSnapshot(ctx.db, document) : null,
    document: { id: document.id, is_published: Boolean(document.is_published), published_at: document.published_at },
    permissions: {
      level,
      can_edit: draft.status !== "submitted",
      can_publish: level === "edit_publish" && draft.status !== "submitted",
      can_submit: draft.status !== "submitted",
      can_review: canReview,
      can_discard: isAuthor || level === "edit_publish",
      is_author: isAuthor,
    },
  };
}

// GET /api/documents/:id/draft — opens (and if needed starts) the draft.
export async function handleGetDraft(ctx) {
  const { document, level } = await requireEditor(ctx, ctx.params.id);
  let draft = await ctx.db.first("SELECT * FROM drafts WHERE document_id = ?", document.id);
  let created = false;
  if (!draft) {
    const now = nowIso();
    const snapshot = await publishedSnapshot(ctx.db, document);
    await ctx.db.run(
      `INSERT INTO drafts (document_id, snapshot_json, status, author_id, created_at, updated_at)
       VALUES (?, ?, 'editing', ?, ?, ?) ON CONFLICT(document_id) DO NOTHING`,
      document.id,
      JSON.stringify(snapshot),
      ctx.user.id,
      now,
      now,
    );
    draft = await ctx.db.first("SELECT * FROM drafts WHERE document_id = ?", document.id);
    created = draft.author_id === ctx.user.id && draft.created_at === now;
  }
  return json({ ...(await draftView(ctx, document, draft, level)), created });
}

// Validates and cleans a snapshot sent by the editor.
function parseSnapshot(body, existingStepIds) {
  const s = body.snapshot;
  if (!s || typeof s !== "object") throw badRequest("The draft is missing.");
  const title = optionalString(s, "title", "Title", { max: 200 });
  if (!title) throw badRequest("The document needs a title.");
  const description = optionalString(s, "description", "Description", { max: 1000 });
  if (!Array.isArray(s.steps) || !s.steps.length) throw badRequest("A document needs at least one step.");
  if (s.steps.length > MAX_STEPS) throw badRequest(`A document can have at most ${MAX_STEPS} steps.`);
  const seen = new Set();
  const steps = s.steps.map((step, i) => {
    const stepTitle = optionalString(step, "title", "Step title", { max: 200 }) || `Step ${i + 1}`;
    let id = Number.isInteger(step.id) && existingStepIds.has(step.id) && !seen.has(step.id) ? step.id : null;
    if (id) seen.add(id);
    const key = typeof step.key === "string" && /^[\w-]{1,40}$/.test(step.key) ? step.key : id ? `s${id}` : `n${i}-${Date.now()}`;
    return { id, key, title: stepTitle, content_json: cleanDoc(step.content_json) };
  });
  return { title, description, steps };
}

// PUT /api/documents/:id/draft { snapshot, base_updated_at }
export async function handleSaveDraft(ctx) {
  const { document } = await requireEditor(ctx, ctx.params.id);
  const body = await readJson(ctx.request, 5_000_000);
  const draft = await ctx.db.first("SELECT * FROM drafts WHERE document_id = ?", document.id);
  if (!draft) throw notFound("This draft was discarded or published. Reload to start a new one.");
  if (draft.status === "submitted") throw forbidden("This draft is waiting for review and can't be changed.");
  if (body.base_updated_at !== draft.updated_at) {
    throw new HttpError(409, "Someone else saved this draft in the meantime. The latest version has been loaded.", { code: "draft_conflict" });
  }
  const stepIds = new Set((await ctx.db.all("SELECT id FROM steps WHERE document_id = ?", document.id)).map((s) => s.id));
  const snapshot = parseSnapshot(body, stepIds);
  const now = nowIso();
  const result = await ctx.db.run(
    "UPDATE drafts SET snapshot_json = ?, status = 'editing', updated_at = ? WHERE id = ? AND updated_at = ?",
    JSON.stringify(snapshot),
    now,
    draft.id,
    draft.updated_at,
  );
  if (!result.rowsAffected) throw new HttpError(409, "Someone else saved this draft in the meantime. The latest version has been loaded.", { code: "draft_conflict" });
  return json({ updated_at: now, snapshot });
}

// DELETE /api/documents/:id/draft
export async function handleDiscardDraft(ctx) {
  const { document, level } = await requireEditor(ctx, ctx.params.id);
  const draft = await ctx.db.first("SELECT * FROM drafts WHERE document_id = ?", document.id);
  if (!draft) return noContent();
  if (draft.author_id !== ctx.user.id && level !== "edit_publish") throw forbidden("Only the author or someone with Edit and publish can discard this draft.");
  await ctx.db.run("DELETE FROM drafts WHERE id = ?", draft.id);
  return noContent();
}

function revisionOf(body, fallback = "minor") {
  const value = body.revision_type || fallback;
  if (value !== "minor" && value !== "major") throw badRequest("Choose a minor or a major revision.");
  return value;
}

// POST /api/documents/:id/draft/submit { revision_type, note }
export async function handleSubmitDraft(ctx) {
  const { document } = await requireEditor(ctx, ctx.params.id);
  const body = await readJson(ctx.request);
  const draft = await ctx.db.first("SELECT * FROM drafts WHERE document_id = ?", document.id);
  if (!draft) throw notFound("There is no draft to submit.");
  if (draft.status === "submitted") throw badRequest("This draft is already waiting for review.");
  const revision = revisionOf(body);
  const note = optionalString(body, "note", "Note", { max: 2000 });
  const snapshot = JSON.parse(draft.snapshot_json);
  const now = nowIso();
  const statements = [
    [
      "UPDATE drafts SET status = 'submitted', revision_type = ?, submit_note = ?, author_id = ?, submitted_at = ?, reviewer_id = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ?",
      [revision, note, ctx.user.id, now, now, draft.id],
    ],
  ];
  for (const reviewer of await reviewersOf(ctx.db, document.id)) {
    if (reviewer === ctx.user.id) continue;
    statements.push(notificationStatement(reviewer, "review_requested", { document_id: document.id, title: snapshot.title, by: ctx.user.id }));
  }
  await ctx.db.batch(statements);
  return json({ ok: true });
}

// Users for whom the document is mandatory (to notify), as if published.
async function mandatoryAudience(db, documentId) {
  const users = await db.all("SELECT id, is_active, is_admin FROM users WHERE is_active = 1");
  const data = await loadAccessData(db);
  data.documents = data.documents.map((d) => (d.id === documentId ? { ...d, is_published: 1 } : d));
  const mandatory = mandatoryByUser(data, users);
  return users.filter((u) => mandatory.get(u.id).has(documentId)).map((u) => u.id);
}

// Copies a draft over its document, in one transaction.
async function applyDraft(ctx, document, draft, revision, extraStatements = []) {
  const snapshot = JSON.parse(draft.snapshot_json);
  const now = nowIso();
  const current = await ctx.db.all("SELECT id, title, content_json FROM steps WHERE document_id = ?", document.id);
  const currentById = new Map(current.map((s) => [s.id, s]));
  let nextId = Number((await ctx.db.value("SELECT MAX(id) FROM steps")) || 0);
  const firstPublication = !document.published_at;
  const major = revision === "major" && !firstPublication;

  const statements = [
    [
      `UPDATE documents SET title = ?, description = ?, is_published = 1, published_at = COALESCE(published_at, ?),
         updated_at = ?, updated_by = ?${major ? ", last_major_revision_at = ?" : ""} WHERE id = ?`,
      major ? [snapshot.title, snapshot.description, now, now, ctx.user.id, now, document.id] : [snapshot.title, snapshot.description, now, now, ctx.user.id, document.id],
    ],
  ];
  const kept = new Set();
  const finalSteps = [];
  snapshot.steps.forEach((step, index) => {
    const content = JSON.stringify(step.content_json);
    const text = docToText(step.content_json);
    const existing = step.id ? currentById.get(step.id) : null;
    if (existing) {
      kept.add(existing.id);
      const changed = existing.title !== step.title || existing.content_json !== content;
      statements.push([
        `UPDATE steps SET title = ?, position = ?, content_json = ?, content_text = ?${changed ? ", updated_at = ?" : ""} WHERE id = ?`,
        changed ? [step.title, index + 1, content, text, now, existing.id] : [step.title, index + 1, content, text, existing.id],
      ]);
      finalSteps.push({ id: existing.id, title: step.title, content_text: text });
    } else {
      const id = ++nextId;
      statements.push([
        "INSERT INTO steps (id, document_id, title, position, content_json, content_text, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, document.id, step.title, index + 1, content, text, now],
      ]);
      finalSteps.push({ id, title: step.title, content_text: text });
    }
  });
  for (const s of current) if (!kept.has(s.id)) statements.push(["DELETE FROM steps WHERE id = ?", [s.id]]);
  statements.push(...indexDocumentStatements({ id: document.id, title: snapshot.title, is_published: 1 }, finalSteps));
  statements.push(["DELETE FROM drafts WHERE id = ?", [draft.id]]);
  statements.push(...extraStatements);
  if (firstPublication || major) {
    for (const userId of await mandatoryAudience(ctx.db, document.id)) {
      statements.push(notificationStatement(userId, major ? "major_revision" : "mandatory_assigned", { document_id: document.id, title: snapshot.title }));
    }
  }
  await ctx.db.batch(statements);
  return { revision: firstPublication ? "first" : revision };
}

// POST /api/documents/:id/draft/publish { revision_type }
export async function handlePublishDraft(ctx) {
  const { document, level } = await requireEditor(ctx, ctx.params.id);
  if (level !== "edit_publish") throw forbidden("Publishing needs Edit and publish. Submit the draft for review instead.");
  const body = await readJson(ctx.request);
  const draft = await ctx.db.first("SELECT * FROM drafts WHERE document_id = ?", document.id);
  if (!draft) throw notFound("There is no draft to publish.");
  if (draft.status === "submitted") throw badRequest("This draft is waiting for review. Approve it instead.");
  const result = await applyDraft(ctx, document, draft, revisionOf(body));
  return json({ ok: true, ...result });
}

async function requireReviewer(ctx) {
  const { document, level } = await documentFor(ctx, ctx.params.id);
  const draft = await ctx.db.first("SELECT * FROM drafts WHERE document_id = ?", document.id);
  if (!draft || draft.status !== "submitted") throw badRequest("There is no draft waiting for review.");
  const reviewers = await reviewersOf(ctx.db, document.id);
  if (!ctx.user.is_admin && level !== "edit_publish" && !reviewers.includes(ctx.user.id)) throw forbidden("You can't review this document.");
  return { document, draft };
}

// POST /api/documents/:id/draft/approve { revision_type }
export async function handleApproveDraft(ctx) {
  const { document, draft } = await requireReviewer(ctx);
  const body = await readJson(ctx.request);
  const revision = revisionOf(body, draft.revision_type || "minor");
  const title = JSON.parse(draft.snapshot_json).title;
  const notify = draft.author_id && draft.author_id !== ctx.user.id ? [notificationStatement(draft.author_id, "draft_approved", { document_id: document.id, title, by: ctx.user.id })] : [];
  const result = await applyDraft(ctx, document, draft, revision, notify);
  return json({ ok: true, ...result });
}

// POST /api/documents/:id/draft/reject { comment }
export async function handleRejectDraft(ctx) {
  const { document, draft } = await requireReviewer(ctx);
  const body = await readJson(ctx.request);
  const comment = optionalString(body, "comment", "Comment", { max: 4000 });
  if (!comment) throw badRequest("Please explain what needs to change.");
  const now = nowIso();
  const title = JSON.parse(draft.snapshot_json).title;
  const statements = [["UPDATE drafts SET status = 'rejected', reviewer_id = ?, reviewed_at = ?, review_comment = ?, updated_at = ? WHERE id = ?", [ctx.user.id, now, comment, now, draft.id]]];
  if (draft.author_id && draft.author_id !== ctx.user.id) {
    statements.push(notificationStatement(draft.author_id, "draft_rejected", { document_id: document.id, title, by: ctx.user.id, comment }));
  }
  await ctx.db.batch(statements);
  return json({ ok: true });
}

// Drafts waiting for the current user's review (home page, milestone 6).
export async function draftsToReview(ctx) {
  const drafts = await ctx.db.all("SELECT d.document_id, d.snapshot_json, d.author_id, d.submitted_at FROM drafts d WHERE d.status = 'submitted'");
  const result = [];
  for (const d of drafts) {
    const reviewers = await reviewersOf(ctx.db, d.document_id);
    if (reviewers.includes(ctx.user.id)) result.push({ document_id: d.document_id, title: JSON.parse(d.snapshot_json).title, author: await userName(ctx.db, d.author_id), submitted_at: d.submitted_at });
  }
  return result;
}

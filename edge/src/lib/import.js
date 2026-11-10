// POST /api/import (admins only)
//
// Body: { structure: [{ line, space, category, ... }], access: [...], dry_run }
// The browser parses the CSV files; this checks every row again, matches
// names exactly (case-sensitive, after trimming) under the same parent, and
// either returns a preview (dry_run) or applies everything in one transaction.
//
// The import is additive and idempotent: existing items are reused, new ones
// are created, nothing is deleted or renamed, and grants for the same
// department and target are updated. New documents are created unpublished.

import { nowIso } from "./db.js";
import { HttpError, badRequest, json, readJson } from "./http.js";
import { requireAdmin, notificationStatement } from "./people.js";
import { loadAccessData, mandatoryByUser } from "./permissions.js";
import { textToDoc } from "./content.js";
import { indexDocumentStatements } from "./search.js";
import { ACCESS_COLUMNS, STRUCTURE_COLUMNS, keys, validateAccessRows, validateStructureRows } from "../../../web/js/lib/import-rules.js";

function asRows(list, columns, file) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw badRequest(`${file} must be a list of rows.`);
  return list.map((item, index) => {
    const values = {};
    for (const column of columns) values[column] = item && typeof item[column] === "string" ? item[column] : "";
    return { line: Number.isInteger(item && item.line) ? item.line : index + 2, values };
  });
}

async function maxId(db, table) {
  return Number((await db.value(`SELECT MAX(id) FROM ${table}`)) || 0);
}

export async function handleImport(ctx) {
  requireAdmin(ctx);
  const body = await readJson(ctx.request, 5_000_000);
  const dryRun = body.dry_run !== false;
  if (!Array.isArray(body.structure) || !body.structure.length) throw badRequest("structure.csv is required and must have at least one row.");
  if (body.structure.length > 5000 || (Array.isArray(body.access) && body.access.length > 5000)) throw badRequest("These files are too large (5,000 rows maximum each).");

  const structure = validateStructureRows(asRows(body.structure, STRUCTURE_COLUMNS, "structure.csv"));
  const access = validateAccessRows(asRows(body.access, ACCESS_COLUMNS, "access.csv"));
  const errors = [...structure.errors, ...access.errors];

  const db = ctx.db;
  const [spaces, categories, documents, steps, departments, grants] = await Promise.all([
    db.all("SELECT id, name, position FROM spaces ORDER BY position, id"),
    db.all("SELECT id, space_id, name, emoji, position FROM categories ORDER BY position, id"),
    db.all("SELECT * FROM documents ORDER BY position, id"),
    db.all("SELECT id, document_id, title, position, content_text FROM steps ORDER BY position, id"),
    db.all("SELECT id, name FROM departments"),
    db.all("SELECT * FROM grants"),
  ]);

  const now = nowIso();
  const statements = [];
  const ids = {
    space: await maxId(db, "spaces"),
    category: await maxId(db, "categories"),
    document: await maxId(db, "documents"),
    step: await maxId(db, "steps"),
    department: await maxId(db, "departments"),
    grant: await maxId(db, "grants"),
  };
  const counts = {
    spaces: { created: 0, existing: 0 },
    categories: { created: 0, existing: 0 },
    documents: { created: 0, existing: 0 },
    steps: { created: 0, existing: 0 },
    departments: { created: 0, existing: 0 },
    grants: { created: 0, updated: 0, unchanged: 0 },
  };

  // Existing items, matched by exact name under the same parent. If several
  // share a name, the first one in display order is used.
  const spaceByName = new Map();
  for (const s of spaces) if (!spaceByName.has(s.name)) spaceByName.set(s.name, { ...s, isNew: false, categories: new Map(), nextPosition: 0 });
  const spaceById = new Map([...spaceByName.values()].map((s) => [s.id, s]));
  let nextSpacePosition = Math.max(0, ...spaces.map((s) => s.position)) + 1;
  for (const c of categories) {
    const space = spaceById.get(c.space_id);
    if (space && !space.categories.has(c.name)) space.categories.set(c.name, { ...c, isNew: false, documents: new Map() });
  }
  const categoryById = new Map();
  for (const space of spaceById.values()) for (const c of space.categories.values()) categoryById.set(c.id, c);
  const positions = new Map(); // "category:5" -> next position
  const nextPosition = (kind, parentId, existing) => {
    const key = `${kind}:${parentId}`;
    if (!positions.has(key)) positions.set(key, Math.max(0, ...existing) + 1);
    const value = positions.get(key);
    positions.set(key, value + 1);
    return value;
  };
  for (const d of documents) {
    const category = categoryById.get(d.category_id);
    if (category && !category.documents.has(d.title)) category.documents.set(d.title, { ...d, isNew: false, steps: [] });
  }
  const documentById = new Map();
  for (const c of categoryById.values()) for (const d of c.documents.values()) documentById.set(d.id, d);
  for (const s of steps) documentById.get(s.document_id)?.steps.push({ ...s, isNew: false });

  // Preview, in CSV order.
  const preview = [];
  const previewSpace = new Map();
  const documentsInCsv = new Map(); // key -> { document, category, rows: [steps] }

  for (const row of structure.rows) {
    let space = spaceByName.get(row.space);
    if (!space) {
      space = { id: ++ids.space, name: row.space, isNew: true, categories: new Map() };
      spaceByName.set(row.space, space);
      statements.push(["INSERT INTO spaces (id, name, position) VALUES (?, ?, ?)", [space.id, space.name, nextSpacePosition++]]);
      counts.spaces.created++;
    } else if (!previewSpace.has(space.name)) {
      counts.spaces.existing++;
    }
    if (!previewSpace.has(space.name)) {
      const p = { name: space.name, status: space.isNew ? "new" : "existing", categories: [], byName: new Map() };
      previewSpace.set(space.name, p);
      preview.push(p);
    }
    const pSpace = previewSpace.get(space.name);

    let category = space.categories.get(row.category);
    if (!category) {
      category = { id: ++ids.category, space_id: space.id, name: row.category, emoji: row.category_emoji, isNew: true, documents: new Map() };
      space.categories.set(row.category, category);
      const position = nextPosition("space", space.id, categories.filter((c) => c.space_id === space.id).map((c) => c.position));
      statements.push(["INSERT INTO categories (id, space_id, name, emoji, position) VALUES (?, ?, ?, ?, ?)", [category.id, space.id, category.name, category.emoji, position]]);
      counts.categories.created++;
    }
    if (!pSpace.byName.has(category.name)) {
      if (!category.isNew) counts.categories.existing++;
      const p = { name: category.name, emoji: category.emoji, status: category.isNew ? "new" : "existing", documents: [], byName: new Map() };
      pSpace.byName.set(category.name, p);
      pSpace.categories.push(p);
    }
    const pCategory = pSpace.byName.get(category.name);

    let document = category.documents.get(row.document);
    if (!document) {
      document = { id: ++ids.document, category_id: category.id, title: row.document, description: row.document_description, is_published: 0, isNew: true, steps: [] };
      category.documents.set(row.document, document);
      const position = nextPosition("category", category.id, documents.filter((d) => d.category_id === category.id).map((d) => d.position));
      statements.push([
        `INSERT INTO documents (id, category_id, title, description, position, is_published, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [document.id, category.id, document.title, document.description, position, now, ctx.user.id, now, ctx.user.id],
      ]);
      counts.documents.created++;
    }
    const key = keys.document(space.name, category.name, document.title);
    if (!documentsInCsv.has(key)) {
      if (!document.isNew) counts.documents.existing++;
      const p = { title: document.title, status: document.isNew ? "new" : "existing", steps: [] };
      pCategory.documents.push(p);
      documentsInCsv.set(key, { document, preview: p, titles: [] });
    }
    if (row.step) documentsInCsv.get(key).titles.push(row.step);
  }

  // Steps: the CSV's steps for each document, or one step named after the
  // document when the CSV gives none and the document has no steps yet.
  const reindex = [];
  for (const { document, preview: p, titles } of documentsInCsv.values()) {
    // An empty step column means "one step named after the document". If the
    // document already has steps under other names, nothing is added.
    const wanted = titles.length
      ? [...new Set(titles)]
      : !document.steps.length || document.steps.some((s) => s.title === document.title)
        ? [document.title]
        : [];
    let position = Math.max(0, ...document.steps.map((s) => s.position)) + 1;
    let added = false;
    for (const title of wanted) {
      const existing = document.steps.find((s) => s.title === title);
      if (existing) {
        counts.steps.existing++;
        p.steps.push({ title, status: "existing" });
        continue;
      }
      const step = { id: ++ids.step, document_id: document.id, title, position: position++, content_text: "", isNew: true };
      document.steps.push(step);
      statements.push([
        "INSERT INTO steps (id, document_id, title, position, content_json, content_text, updated_at) VALUES (?, ?, ?, ?, ?, '', ?)",
        [step.id, document.id, title, step.position, JSON.stringify(textToDoc("")), now],
      ]);
      counts.steps.created++;
      p.steps.push({ title, status: "new" });
      added = true;
    }
    if (added && document.is_published) reindex.push(document);
  }
  for (const document of reindex) statements.push(...indexDocumentStatements(document, document.steps));

  // Access
  const departmentByName = new Map(departments.map((d) => [d.name, { ...d, isNew: false }]));
  const departmentLower = new Map(departments.map((d) => [d.name.toLowerCase(), d.name]));
  const grantIndex = new Map(grants.map((g) => [`${g.target_type}:${g.target_id}|${g.principal_type}:${g.principal_id}`, g]));
  const seenTargets = new Map();
  const grantPreview = [];
  const departmentsSeen = new Set();

  for (const row of access.rows) {
    let department = departmentByName.get(row.department);
    if (!department) {
      const clash = departmentLower.get(row.department.toLowerCase());
      if (clash) {
        errors.push({ file: "access.csv", line: row.line, message: `A department called "${clash}" already exists. Names must match exactly, including capital letters.` });
        continue;
      }
      department = { id: ++ids.department, name: row.department, isNew: true };
      departmentByName.set(row.department, department);
      departmentLower.set(row.department.toLowerCase(), row.department);
      statements.push(["INSERT INTO departments (id, name, position, is_system, created_at) VALUES (?, ?, ?, 0, ?)", [department.id, department.name, department.id, now]]);
      counts.departments.created++;
    } else if (!departmentsSeen.has(department.name)) {
      counts.departments.existing++;
    }
    departmentsSeen.add(department.name);

    const space = spaceByName.get(row.space);
    const category = space && space.categories.get(row.category);
    const document = row.document && category ? category.documents.get(row.document) : null;
    const where = row.document ? `${row.space} › ${row.category} › ${row.document}` : `${row.space} › ${row.category}`;
    if (!category || (row.document && !document)) {
      errors.push({ file: "access.csv", line: row.line, message: `${where} is not in structure.csv or in the workspace.` });
      continue;
    }
    const target = document ? { type: "document", id: document.id } : { type: "category", id: category.id };
    const indexKey = `${target.type}:${target.id}|department:${department.id}`;
    if (seenTargets.has(indexKey)) {
      errors.push({ file: "access.csv", line: row.line, message: `This department already has a row for ${where} (line ${seenTargets.get(indexKey)}).` });
      continue;
    }
    seenTargets.set(indexKey, row.line);

    const mandatory = row.permission === "none" ? false : row.mandatory;
    const existing = grantIndex.get(indexKey);
    let status;
    if (!existing) {
      statements.push([
        `INSERT INTO grants (id, target_type, target_id, principal_type, principal_id, level, mandatory, created_at, created_by)
         VALUES (?, ?, ?, 'department', ?, ?, ?, ?, ?)`,
        [++ids.grant, target.type, target.id, department.id, row.permission, mandatory ? 1 : 0, now, ctx.user.id],
      ]);
      counts.grants.created++;
      status = "new";
    } else if (existing.level !== row.permission || Boolean(existing.mandatory) !== mandatory) {
      statements.push(["UPDATE grants SET level = ?, mandatory = ? WHERE id = ?", [row.permission, mandatory ? 1 : 0, existing.id]]);
      counts.grants.updated++;
      status = "updated";
    } else {
      counts.grants.unchanged++;
      status = "unchanged";
    }
    grantPreview.push({ line: row.line, department: department.name, target: where, permission: row.permission, mandatory, status });
  }

  const strip = (list) =>
    list.map((s) => ({ name: s.name, status: s.status, categories: s.categories.map((c) => ({ name: c.name, emoji: c.emoji, status: c.status, documents: c.documents })) }));
  const result = { dry_run: dryRun, counts, preview: strip(preview), grants: grantPreview, errors: errors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line) };

  if (errors.length) return json(result, 422);
  if (dryRun) return json(result);

  // Apply, then tell members about published documents that became mandatory.
  const users = await db.all("SELECT id, is_active, is_admin FROM users WHERE is_active = 1");
  const before = mandatoryByUser(await loadAccessData(db), users);
  if (statements.length) {
    try {
      await db.batch(statements);
    } catch (error) {
      console.error(error);
      throw new HttpError(409, "The import could not be applied, and nothing was changed. If someone edited the handbook at the same time, check the files again and retry.");
    }
  }
  const after = mandatoryByUser(await loadAccessData(db), users);
  const titles = new Map((await db.all("SELECT id, title FROM documents WHERE is_published = 1")).map((d) => [d.id, d.title]));
  const notifications = [];
  for (const user of users) {
    for (const docId of after.get(user.id)) {
      if (!before.get(user.id).has(docId)) notifications.push(notificationStatement(user.id, "mandatory_assigned", { document_id: docId, title: titles.get(docId) }));
    }
  }
  if (notifications.length) await db.batch(notifications);
  return json(result);
}

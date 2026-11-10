// Grants: GET /api/grants, PUT /api/grants, DELETE /api/grants/:id.
//
// Admins manage every grant. Team leaders manage grants for the departments
// they lead and for those departments' members, with a level no higher than
// their own on that content. Nobody else manages access.

import { nowIso } from "./db.js";
import { badRequest, forbidden, json, noContent, notFound, readJson } from "./http.js";
import { LEVELS, accessFor, atLeast, loadAccessData, mandatoryByUser, rank, resolveAccess } from "./permissions.js";
import { notificationStatement, peopleAccess } from "./people.js";

function parseRef(value, types) {
  const match = /^([a-z]+):(\d+)$/.exec(String(value || ""));
  if (!match || !types.includes(match[1])) return null;
  return { type: match[1], id: Number(match[2]) };
}

async function principalExists(db, principal) {
  const table = principal.type === "user" ? "users" : "departments";
  return db.first(`SELECT * FROM ${table} WHERE id = ?`, principal.id);
}

async function targetExists(db, target) {
  const table = target.type === "category" ? "categories" : "documents";
  return db.first(`SELECT * FROM ${table} WHERE id = ?`, target.id);
}

// Is this principal inside the current user's scope (admin: everyone)?
async function principalInScope(ctx, principal) {
  const people = await peopleAccess(ctx);
  if (people.isAdmin) return true;
  if (!people.leads.size) return false;
  if (principal.type === "department") return people.leads.has(principal.id);
  const rows = await ctx.db.all("SELECT department_id FROM department_members WHERE user_id = ?", principal.id);
  return rows.some((r) => people.leads.has(r.department_id));
}

// The highest level the current user may hand out on a target.
async function ownLevel(ctx, target) {
  const access = await accessFor(ctx);
  if (access.isAdmin) return "edit_publish";
  return target.type === "category" ? access.categoryLevel(target.id) : access.level(target.id);
}

async function requireCanManage(ctx) {
  const people = await peopleAccess(ctx);
  if (!people.isAdmin && !people.leads.size) throw forbidden("Only admins and team leaders can manage access.");
  return people;
}

async function principalNames(db) {
  const [departments, users] = await Promise.all([
    db.all("SELECT id, name, is_system FROM departments"),
    db.all("SELECT id, first_name, last_name, email, is_active FROM users"),
  ]);
  return {
    department: new Map(departments.map((d) => [d.id, d.name])),
    user: new Map(users.map((u) => [u.id, `${u.first_name} ${u.last_name}`])),
  };
}

function grantView(g, names) {
  return {
    id: g.id,
    target_type: g.target_type,
    target_id: g.target_id,
    principal_type: g.principal_type,
    principal_id: g.principal_id,
    principal_name: names[g.principal_type].get(g.principal_id) || "Unknown",
    level: g.level,
    mandatory: Boolean(g.mandatory),
  };
}

// The content tree the current user may assign: everything for admins,
// otherwise what they can see.
async function assignableTree(ctx) {
  const access = await accessFor(ctx);
  const [spaces, categories, documents] = await Promise.all([
    ctx.db.all("SELECT id, name FROM spaces ORDER BY position, id"),
    ctx.db.all("SELECT id, space_id, name, emoji FROM categories ORDER BY position, id"),
    ctx.db.all("SELECT id, category_id, title, is_published FROM documents ORDER BY position, id"),
  ]);
  const docs = documents.filter((d) => access.isAdmin || atLeast(access.level(d.id), "view"));
  const cats = categories.filter((c) => access.isAdmin || atLeast(access.categoryLevel(c.id), "view") || docs.some((d) => d.category_id === c.id));
  return spaces
    .map((s) => ({
      id: s.id,
      name: s.name,
      categories: cats
        .filter((c) => c.space_id === s.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          emoji: c.emoji,
          max_level: access.isAdmin ? "edit_publish" : access.categoryLevel(c.id),
          documents: docs
            .filter((d) => d.category_id === c.id)
            .map((d) => ({ id: d.id, title: d.title, is_published: Boolean(d.is_published), max_level: access.level(d.id) })),
        })),
    }))
    .filter((s) => s.categories.length);
}

function sourceLabel(source, names) {
  if (!source) return "";
  if (source.admin) return "admin";
  if (source.principal_type === "user") return source.target_type === "document" ? "own grant on this document" : "own grant on the category";
  return `from ${names.department.get(source.principal_id) || "a department"}`;
}

// GET /api/grants?target=document:5 | category:2
// GET /api/grants?principal=department:3 | user:7
export async function handleListGrants(ctx) {
  await requireCanManage(ctx);
  const names = await principalNames(ctx.db);
  const params = ctx.url.searchParams;

  if (params.has("target")) {
    const target = parseRef(params.get("target"), ["category", "document"]);
    if (!target || !(await targetExists(ctx.db, target))) throw notFound("This content doesn't exist.");
    const rows = await ctx.db.all("SELECT * FROM grants WHERE target_type = ? AND target_id = ? ORDER BY principal_type, principal_id", target.type, target.id);
    const visible = [];
    for (const g of rows) if (await principalInScope(ctx, { type: g.principal_type, id: g.principal_id })) visible.push(grantView(g, names));
    return json({ grants: visible, max_level: await ownLevel(ctx, target) });
  }

  const principal = parseRef(params.get("principal"), ["department", "user"]);
  const record = principal && (await principalExists(ctx.db, principal));
  if (!record) throw notFound("This department or member doesn't exist.");
  if (!(await principalInScope(ctx, principal))) throw forbidden("You can't manage access for them.");

  const rows = await ctx.db.all("SELECT * FROM grants WHERE principal_type = ? AND principal_id = ?", principal.type, principal.id);
  const tree = await assignableTree(ctx);
  const grantMap = new Map(rows.map((g) => [`${g.target_type}:${g.target_id}`, grantView(g, names)]));

  // Effective access, shown next to each row.
  const effective = {};
  if (principal.type === "user") {
    const data = await loadAccessData(ctx.db);
    const resolved = resolveAccess(data, record);
    for (const space of tree) {
      for (const c of space.categories) {
        for (const d of c.documents) {
          const entry = resolved.docs.get(d.id);
          effective[`document:${d.id}`] = entry
            ? { level: entry.level, mandatory: entry.mandatory, source: sourceLabel(entry.source, names) }
            : { level: "none", mandatory: false, source: "" };
        }
      }
    }
  }
  for (const space of tree) {
    for (const c of space.categories) {
      const categoryGrant = grantMap.get(`category:${c.id}`);
      for (const d of c.documents) {
        const docGrant = grantMap.get(`document:${d.id}`);
        d.differs = Boolean(docGrant && (!categoryGrant || docGrant.level !== categoryGrant.level || docGrant.mandatory !== categoryGrant.mandatory));
        if (principal.type === "department") {
          const g = docGrant || categoryGrant;
          effective[`document:${d.id}`] = { level: g ? g.level : "none", mandatory: Boolean(g && g.mandatory && g.level !== "none"), source: g ? (docGrant ? "this document" : "the category") : "" };
        }
      }
    }
  }
  return json({ principal: { ...principal, name: names[principal.type].get(principal.id) }, tree, grants: Object.fromEntries(grantMap), effective });
}

// Users affected by a grant on this principal.
async function affectedUsers(db, principal) {
  if (principal.type === "user") return db.all("SELECT id, is_active, is_admin FROM users WHERE id = ? AND is_active = 1", principal.id);
  const department = await db.first("SELECT is_system FROM departments WHERE id = ?", principal.id);
  if (department && department.is_system) return db.all("SELECT id, is_active, is_admin FROM users WHERE is_active = 1");
  return db.all(
    "SELECT u.id, u.is_active, u.is_admin FROM users u JOIN department_members m ON m.user_id = u.id WHERE m.department_id = ? AND u.is_active = 1",
    principal.id,
  );
}

// Applies a grant change and notifies members for whom a published document
// becomes mandatory.
async function applyGrantChange(ctx, principal, statements) {
  const users = await affectedUsers(ctx.db, principal);
  const before = mandatoryByUser(await loadAccessData(ctx.db), users);
  await ctx.db.batch(statements);
  const afterData = await loadAccessData(ctx.db);
  const after = mandatoryByUser(afterData, users);
  const titles = new Map((await ctx.db.all("SELECT id, title FROM documents WHERE is_published = 1")).map((d) => [d.id, d.title]));
  const notifications = [];
  for (const user of users) {
    for (const docId of after.get(user.id)) {
      if (!before.get(user.id).has(docId)) notifications.push(notificationStatement(user.id, "mandatory_assigned", { document_id: docId, title: titles.get(docId) }));
    }
  }
  if (notifications.length) await ctx.db.batch(notifications);
  return notifications.length;
}

// PUT /api/grants { target_type, target_id, principal_type, principal_id, level, mandatory }
export async function handlePutGrant(ctx) {
  await requireCanManage(ctx);
  const body = await readJson(ctx.request);
  const target = parseRef(`${body.target_type}:${body.target_id}`, ["category", "document"]);
  const principal = parseRef(`${body.principal_type}:${body.principal_id}`, ["department", "user"]);
  if (!target || !principal) throw badRequest("Please choose what to give access to, and to whom.");
  if (!LEVELS.includes(body.level)) throw badRequest("Unknown permission level.");
  if (body.level === "none" && target.type !== "document") throw badRequest("None can only be used on a document, to exclude it from its category.");
  if (!(await targetExists(ctx.db, target))) throw notFound("This content doesn't exist.");
  if (!(await principalExists(ctx.db, principal))) throw notFound("This department or member doesn't exist.");
  if (!(await principalInScope(ctx, principal))) throw forbidden("You can only give access to your departments and their members.");
  const max = await ownLevel(ctx, target);
  if (rank(body.level) > rank(max)) throw forbidden("You can't give a higher permission than your own on this content.");
  const mandatory = Boolean(body.mandatory) && body.level !== "none";

  const notified = await applyGrantChange(ctx, principal, [
    [
      `INSERT INTO grants (target_type, target_id, principal_type, principal_id, level, mandatory, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(target_type, target_id, principal_type, principal_id)
       DO UPDATE SET level = excluded.level, mandatory = excluded.mandatory`,
      [target.type, target.id, principal.type, principal.id, body.level, mandatory ? 1 : 0, nowIso(), ctx.user.id],
    ],
  ]);
  const grant = await ctx.db.first(
    "SELECT * FROM grants WHERE target_type = ? AND target_id = ? AND principal_type = ? AND principal_id = ?",
    target.type,
    target.id,
    principal.type,
    principal.id,
  );
  return json({ grant: grantView(grant, await principalNames(ctx.db)), notified });
}

// DELETE /api/grants/:id
export async function handleDeleteGrant(ctx) {
  await requireCanManage(ctx);
  const grant = await ctx.db.first("SELECT * FROM grants WHERE id = ?", Number(ctx.params.id));
  if (!grant) throw notFound("This access rule doesn't exist.");
  const principal = { type: grant.principal_type, id: grant.principal_id };
  if (!(await principalInScope(ctx, principal))) throw forbidden("You can only change access for your departments and their members.");
  const max = await ownLevel(ctx, { type: grant.target_type, id: grant.target_id });
  if (rank(grant.level) > rank(max)) throw forbidden("This access is higher than your own, so only an admin can remove it.");
  await applyGrantChange(ctx, principal, [["DELETE FROM grants WHERE id = ?", [grant.id]]]);
  return noContent();
}

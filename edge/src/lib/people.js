// Members and departments.
//
// Who can do what:
// - Admins: everything.
// - Team leaders, for the departments they lead only: create members (added to
//   their department), add existing members, remove members who are not
//   leaders, reset passwords and edit names and role titles of their
//   department's members, unless that member is an admin.
// - Everyone: their own profile (names and photo).
// The "Everyone" department (is_system = 1) contains every active member
// implicitly. It has no stored memberships and no leaders.

import { nowIso } from "./db.js";
import { HttpError, badRequest, forbidden, json, noContent, normalizeEmail, notFound, optionalString, readJson, requireString } from "./http.js";
import { hashPassword, temporaryPassword } from "./crypto.js";
import { publicUser } from "./auth.js";
import { completionRates } from "./progress.js";

// Statements that create an in-app notification (shown from milestone 6).
export function notificationStatement(userId, type, payload) {
  return [
    "INSERT INTO notifications (user_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    [userId, type, JSON.stringify(payload), nowIso()],
  ];
}

// What the current user may do with people. Cached per request on ctx.
export async function peopleAccess(ctx) {
  if (!ctx.peopleAccess) {
    const rows = await ctx.db.all(
      "SELECT department_id FROM department_members WHERE user_id = ? AND is_leader = 1",
      ctx.user.id,
    );
    ctx.peopleAccess = { isAdmin: Boolean(ctx.user.is_admin), leads: new Set(rows.map((r) => r.department_id)) };
  }
  return ctx.peopleAccess;
}

export function requireAdmin(ctx) {
  if (!ctx.user.is_admin) throw forbidden("Only admins can do this.");
}

async function departmentIdsOf(db, userId) {
  const rows = await db.all("SELECT department_id FROM department_members WHERE user_id = ?", userId);
  return rows.map((r) => r.department_id);
}

// Can the current user manage this member (reset password, edit details)?
async function canManageMember(ctx, target) {
  const access = await peopleAccess(ctx);
  if (access.isAdmin) return true;
  if (target.is_admin) return false;
  const departments = await departmentIdsOf(ctx.db, target.id);
  return departments.some((id) => access.leads.has(id));
}

async function systemDepartmentId(db) {
  return db.value("SELECT id FROM departments WHERE is_system = 1");
}

async function getDepartment(db, id) {
  const department = await db.first("SELECT * FROM departments WHERE id = ?", Number(id));
  if (!department) throw notFound("This department doesn't exist.");
  return department;
}

async function getUser(db, id) {
  const user = await db.first("SELECT * FROM users WHERE id = ?", Number(id));
  if (!user) throw notFound("This member doesn't exist.");
  return user;
}

// Memberships of several users, as { userId: [{ id, name, is_leader }] }.
async function membershipsByUser(db, userIds) {
  const map = new Map(userIds.map((id) => [id, []]));
  if (!userIds.length) return map;
  const rows = await db.all(
    `SELECT m.user_id, d.id, d.name, m.is_leader
       FROM department_members m JOIN departments d ON d.id = m.department_id
      WHERE m.user_id IN (${userIds.map(() => "?").join(",")})
      ORDER BY d.position, d.name`,
    ...userIds,
  );
  for (const r of rows) map.get(r.user_id)?.push({ id: r.id, name: r.name, is_leader: Boolean(r.is_leader) });
  return map;
}

function memberSummary(user, departments) {
  return {
    ...publicUser(user),
    last_login_at: user.last_login_at || null,
    created_at: user.created_at,
    departments,
  };
}

async function activeAdminCount(db) {
  return Number(await db.value("SELECT COUNT(*) FROM users WHERE is_admin = 1 AND is_active = 1"));
}

// Body helper: [{ id, is_leader }] from either [3, 5] or [{ id: 3, is_leader: true }].
function parseDepartmentList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest("Departments must be a list.");
  return value.map((item) => {
    const id = Number(typeof item === "object" && item ? item.id : item);
    if (!Number.isInteger(id) || id < 1) throw badRequest("Unknown department.");
    return { id, is_leader: Boolean(typeof item === "object" && item && item.is_leader) };
  });
}

function nameFields(body, { partial }) {
  const fields = {};
  for (const [key, label] of [
    ["first_name", "First name"],
    ["last_name", "Last name"],
  ]) {
    if (!partial || key in body) fields[key] = requireString(body, key, label, { max: 100 });
  }
  if (!partial || "role_title" in body) fields.role_title = optionalString(body, "role_title", "Role title", { max: 120 });
  return fields;
}

// GET /api/users?q=&department=&status=active|deactivated|admins|all
export async function handleListUsers(ctx) {
  const access = await peopleAccess(ctx);
  if (!access.isAdmin && !access.leads.size) throw forbidden("Only admins and team leaders can see the members list.");
  const params = ctx.url.searchParams;
  const where = [];
  const args = [];

  if (!access.isAdmin) {
    where.push(`u.id IN (SELECT user_id FROM department_members WHERE department_id IN (${[...access.leads].map(() => "?").join(",")}))`);
    args.push(...access.leads);
  }
  const q = (params.get("q") || "").trim().toLowerCase();
  if (q) {
    where.push("(lower(u.first_name || ' ' || u.last_name) LIKE ? OR lower(u.email) LIKE ?)");
    args.push(`%${q}%`, `%${q}%`);
  }
  const department = Number(params.get("department") || 0);
  if (department) {
    const isSystem = department === Number(await systemDepartmentId(ctx.db));
    if (!isSystem) {
      where.push("u.id IN (SELECT user_id FROM department_members WHERE department_id = ?)");
      args.push(department);
    }
  }
  const status = params.get("status") || "active";
  if (status === "active") where.push("u.is_active = 1");
  else if (status === "deactivated") where.push("u.is_active = 0");
  else if (status === "admins") where.push("u.is_admin = 1 AND u.is_active = 1");

  const users = await ctx.db.all(
    `SELECT u.* FROM users u ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE`,
    ...args,
  );
  const memberships = await membershipsByUser(ctx.db, users.map((u) => u.id));
  const rates = await completionRates(ctx.db, users);
  return json({ users: users.map((u) => ({ ...memberSummary(u, memberships.get(u.id)), completion: rates.get(u.id) })) });
}

// GET /api/users/:id
export async function handleGetUser(ctx) {
  const target = await getUser(ctx.db, ctx.params.id);
  const access = await peopleAccess(ctx);
  const departments = (await membershipsByUser(ctx.db, [target.id])).get(target.id);
  const self = target.id === ctx.user.id;
  const leadsOne = departments.some((d) => access.leads.has(d.id));
  if (!access.isAdmin && !self && !leadsOne) throw forbidden("You can't see this member.");
  const manageable = await canManageMember(ctx, target);
  return json({
    user: memberSummary(target, departments),
    permissions: {
      can_edit_details: manageable,
      can_edit_email: access.isAdmin,
      can_reset_password: manageable && !self,
      can_change_status: access.isAdmin && !self,
      can_change_admin: access.isAdmin && !self,
      can_manage_departments: access.isAdmin,
      leads: [...access.leads],
    },
  });
}

async function createTemporaryPassword() {
  const password = temporaryPassword();
  return { password, ...(await hashPassword(password)) };
}

// POST /api/users
export async function handleCreateUser(ctx) {
  const access = await peopleAccess(ctx);
  if (!access.isAdmin && !access.leads.size) throw forbidden("Only admins and team leaders can add members.");
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  let departments = parseDepartmentList(body.departments);
  const systemId = Number(await systemDepartmentId(ctx.db));
  departments = departments.filter((d) => d.id !== systemId);

  if (!access.isAdmin) {
    if (!departments.length) throw badRequest("Please choose one of your departments.");
    for (const d of departments) {
      if (!access.leads.has(d.id)) throw forbidden("You can only add members to departments you lead.");
      if (d.is_leader) throw forbidden("Only admins can make someone a team leader.");
    }
    if (body.is_admin) throw forbidden("Only admins can make someone an admin.");
  }
  for (const d of departments) await getDepartment(ctx.db, d.id);

  const now = nowIso();
  const existing = await ctx.db.first("SELECT * FROM users WHERE email = ?", email);

  // An existing email: add the person to the chosen departments instead.
  if (existing) {
    if (!existing.is_active && !access.isAdmin) {
      throw new HttpError(409, "This person's account is deactivated. Only an admin can reactivate it.");
    }
    const current = new Set(await departmentIdsOf(ctx.db, existing.id));
    const statements = [];
    for (const d of departments) {
      if (current.has(d.id)) continue;
      statements.push([
        "INSERT INTO department_members (department_id, user_id, is_leader, added_at, added_by) VALUES (?, ?, ?, ?, ?)",
        [d.id, existing.id, d.is_leader ? 1 : 0, now, ctx.user.id],
      ]);
      statements.push(notificationStatement(existing.id, "department_added", { department_id: d.id, by: ctx.user.id, leader: d.is_leader }));
    }
    if (statements.length) await ctx.db.batch(statements);
    const memberships = (await membershipsByUser(ctx.db, [existing.id])).get(existing.id);
    return json({ existing: true, added: statements.length / 2, user: memberSummary(existing, memberships) });
  }

  const fields = nameFields(body, { partial: false });
  const temp = await createTemporaryPassword();
  const result = await ctx.db.run(
    `INSERT INTO users (email, first_name, last_name, role_title, password_hash, password_salt, password_iterations,
                        must_change_password, is_admin, is_active, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)`,
    email,
    fields.first_name,
    fields.last_name,
    fields.role_title,
    temp.hash,
    temp.salt,
    temp.iterations,
    access.isAdmin && body.is_admin ? 1 : 0,
    now,
    ctx.user.id,
  );
  const userId = result.lastInsertRowid;
  const statements = [];
  for (const d of departments) {
    statements.push([
      "INSERT INTO department_members (department_id, user_id, is_leader, added_at, added_by) VALUES (?, ?, ?, ?, ?)",
      [d.id, userId, d.is_leader ? 1 : 0, now, ctx.user.id],
    ]);
  }
  if (statements.length) await ctx.db.batch(statements);
  const user = await getUser(ctx.db, userId);
  const memberships = (await membershipsByUser(ctx.db, [userId])).get(userId);
  return json({ existing: false, user: memberSummary(user, memberships), temporary_password: temp.password }, 201);
}

// PATCH /api/users/:id
export async function handleUpdateUser(ctx) {
  const target = await getUser(ctx.db, ctx.params.id);
  const access = await peopleAccess(ctx);
  const self = target.id === ctx.user.id;
  const body = await readJson(ctx.request);
  const changes = {};
  const statements = [];

  if ("first_name" in body || "last_name" in body) {
    if (!self && !(await canManageMember(ctx, target))) throw forbidden("You can't edit this member.");
    Object.assign(changes, nameFields(body, { partial: true }));
    delete changes.role_title;
  }
  if ("role_title" in body) {
    if ((self && !access.isAdmin) || !(await canManageMember(ctx, target))) {
      throw forbidden("Only admins and team leaders can change role titles.");
    }
    changes.role_title = optionalString(body, "role_title", "Role title", { max: 120 });
  }
  if ("avatar_url" in body) {
    if (!self && !access.isAdmin) throw forbidden("You can only change your own photo.");
    const value = optionalString(body, "avatar_url", "Photo", { max: 1000 });
    // https only; http://localhost is accepted for the local dev server.
    if (value && !/^(https:\/\/|http:\/\/localhost[:/])/.test(value)) throw badRequest("The photo must be an https:// address.");
    changes.avatar_url = value || null;
  }
  if ("email" in body) {
    if (!access.isAdmin) throw forbidden("Only admins can change email addresses.");
    const email = normalizeEmail(body.email);
    const clash = await ctx.db.first("SELECT id FROM users WHERE email = ? AND id <> ?", email, target.id);
    if (clash) throw new HttpError(409, "Another member already uses this email address.");
    changes.email = email;
  }
  if ("is_admin" in body) {
    if (!access.isAdmin) throw forbidden("Only admins can change admin status.");
    if (self) throw forbidden("You can't change your own admin status.");
    const makeAdmin = Boolean(body.is_admin);
    if (!makeAdmin && target.is_admin && target.is_active && (await activeAdminCount(ctx.db)) <= 1) {
      throw forbidden("The workspace needs at least one active admin.");
    }
    changes.is_admin = makeAdmin ? 1 : 0;
  }
  if ("is_active" in body) {
    if (!access.isAdmin) throw forbidden("Only admins can deactivate or reactivate accounts.");
    if (self) throw forbidden("You can't deactivate your own account.");
    const active = Boolean(body.is_active);
    if (!active && target.is_admin && target.is_active && (await activeAdminCount(ctx.db)) <= 1) {
      throw forbidden("The workspace needs at least one active admin.");
    }
    changes.is_active = active ? 1 : 0;
    if (!active) statements.push(["DELETE FROM sessions WHERE user_id = ?", [target.id]]);
  }

  const keys = Object.keys(changes);
  if (!keys.length && !statements.length) throw badRequest("Nothing to change.");
  if (keys.length) {
    statements.unshift([`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => changes[k]), target.id]]);
  }
  await ctx.db.batch(statements);
  const updated = await getUser(ctx.db, target.id);
  const memberships = (await membershipsByUser(ctx.db, [target.id])).get(target.id);
  return json({ user: memberSummary(updated, memberships) });
}

// POST /api/users/:id/reset-password
export async function handleResetPassword(ctx) {
  const target = await getUser(ctx.db, ctx.params.id);
  if (target.id === ctx.user.id) throw badRequest("To change your own password, use My profile.");
  if (!(await canManageMember(ctx, target))) throw forbidden("You can't reset this member's password.");
  if (!target.is_active) throw badRequest("Reactivate this account before resetting its password.");
  const temp = await createTemporaryPassword();
  await ctx.db.batch([
    [
      "UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 1 WHERE id = ?",
      [temp.hash, temp.salt, temp.iterations, target.id],
    ],
    ["DELETE FROM sessions WHERE user_id = ?", [target.id]],
  ]);
  return json({ temporary_password: temp.password });
}

// GET /api/departments
export async function handleListDepartments(ctx) {
  const access = await peopleAccess(ctx);
  const activeUsers = Number(await ctx.db.value("SELECT COUNT(*) FROM users WHERE is_active = 1"));
  const rows = await ctx.db.all(
    `SELECT d.*,
            (SELECT COUNT(*) FROM department_members m JOIN users u ON u.id = m.user_id
              WHERE m.department_id = d.id AND u.is_active = 1) AS member_count,
            (SELECT COUNT(*) FROM department_members m WHERE m.department_id = d.id AND m.is_leader = 1) AS leader_count,
            EXISTS (SELECT 1 FROM department_members m WHERE m.department_id = d.id AND m.user_id = ?) AS is_mine
       FROM departments d
      ORDER BY d.is_system DESC, d.position, d.name COLLATE NOCASE`,
    ctx.user.id,
  );
  const visible = rows.filter((d) => access.isAdmin || d.is_system || d.is_mine || access.leads.has(d.id));
  return json({
    departments: visible.map((d) => ({
      id: d.id,
      name: d.name,
      is_system: Boolean(d.is_system),
      position: d.position,
      member_count: d.is_system ? activeUsers : d.member_count,
      leader_count: d.leader_count,
      i_lead: access.leads.has(d.id),
    })),
  });
}

// GET /api/departments/:id
export async function handleGetDepartment(ctx) {
  const department = await getDepartment(ctx.db, ctx.params.id);
  const access = await peopleAccess(ctx);
  if (!access.isAdmin && !access.leads.has(department.id)) throw forbidden("Only admins and this department's leaders can see it.");
  const users = department.is_system
    ? await ctx.db.all("SELECT u.*, 0 AS is_leader FROM users u WHERE u.is_active = 1 ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE")
    : await ctx.db.all(
        `SELECT u.*, m.is_leader FROM department_members m JOIN users u ON u.id = m.user_id
          WHERE m.department_id = ? ORDER BY m.is_leader DESC, u.is_active DESC, u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE`,
        department.id,
      );
  return json({
    department: { id: department.id, name: department.name, is_system: Boolean(department.is_system) },
    members: users.map((u) => ({ ...memberSummary(u, undefined), is_leader: Boolean(u.is_leader) })),
    permissions: {
      can_rename: access.isAdmin && !department.is_system,
      can_delete: access.isAdmin && !department.is_system,
      can_add_members: !department.is_system && (access.isAdmin || access.leads.has(department.id)),
      can_set_leaders: access.isAdmin && !department.is_system,
    },
  });
}

function departmentName(body) {
  return requireString(body, "name", "Department name", { max: 80 });
}

// POST /api/departments
export async function handleCreateDepartment(ctx) {
  requireAdmin(ctx);
  const name = departmentName(await readJson(ctx.request));
  if (await ctx.db.first("SELECT id FROM departments WHERE name = ?", name)) throw new HttpError(409, "A department with this name already exists.");
  const position = Number(await ctx.db.value("SELECT COALESCE(MAX(position), 0) + 1 FROM departments"));
  const result = await ctx.db.run("INSERT INTO departments (name, position, is_system, created_at) VALUES (?, ?, 0, ?)", name, position, nowIso());
  return json({ department: { id: result.lastInsertRowid, name, is_system: false, member_count: 0 } }, 201);
}

// PATCH /api/departments/:id
export async function handleUpdateDepartment(ctx) {
  requireAdmin(ctx);
  const department = await getDepartment(ctx.db, ctx.params.id);
  if (department.is_system) throw forbidden("The Everyone department can't be renamed.");
  const name = departmentName(await readJson(ctx.request));
  if (await ctx.db.first("SELECT id FROM departments WHERE name = ? AND id <> ?", name, department.id)) {
    throw new HttpError(409, "A department with this name already exists.");
  }
  await ctx.db.run("UPDATE departments SET name = ? WHERE id = ?", name, department.id);
  return json({ department: { id: department.id, name } });
}

// DELETE /api/departments/:id
export async function handleDeleteDepartment(ctx) {
  requireAdmin(ctx);
  const department = await getDepartment(ctx.db, ctx.params.id);
  if (department.is_system) throw forbidden("The Everyone department can't be deleted.");
  await ctx.db.run("DELETE FROM departments WHERE id = ?", department.id);
  return noContent();
}

// PUT /api/departments/:id/members/:userId  { is_leader }
export async function handlePutMember(ctx) {
  const department = await getDepartment(ctx.db, ctx.params.id);
  const target = await getUser(ctx.db, ctx.params.userId);
  const access = await peopleAccess(ctx);
  if (department.is_system) throw forbidden("Every active member is in Everyone automatically.");
  if (!access.isAdmin && !access.leads.has(department.id)) throw forbidden("Only admins and this department's leaders can add members.");
  const body = await readJson(ctx.request);
  const wantsLeader = Boolean(body.is_leader);
  const membership = await ctx.db.first("SELECT * FROM department_members WHERE department_id = ? AND user_id = ?", department.id, target.id);

  if (!access.isAdmin) {
    if (wantsLeader || (membership && membership.is_leader && "is_leader" in body && !wantsLeader)) {
      throw forbidden("Only admins can choose team leaders.");
    }
    if (!target.is_active) throw new HttpError(409, "This person's account is deactivated. Only an admin can reactivate it.");
  }

  const statements = [];
  if (!membership) {
    statements.push([
      "INSERT INTO department_members (department_id, user_id, is_leader, added_at, added_by) VALUES (?, ?, ?, ?, ?)",
      [department.id, target.id, wantsLeader ? 1 : 0, nowIso(), ctx.user.id],
    ]);
    statements.push(notificationStatement(target.id, "department_added", { department_id: department.id, by: ctx.user.id, leader: wantsLeader }));
  } else if ("is_leader" in body && Boolean(membership.is_leader) !== wantsLeader) {
    statements.push(["UPDATE department_members SET is_leader = ? WHERE department_id = ? AND user_id = ?", [wantsLeader ? 1 : 0, department.id, target.id]]);
    if (wantsLeader) statements.push(notificationStatement(target.id, "made_leader", { department_id: department.id, by: ctx.user.id }));
  }
  if (statements.length) await ctx.db.batch(statements);
  return json({ ok: true, added: !membership });
}

// DELETE /api/departments/:id/members/:userId
export async function handleRemoveMember(ctx) {
  const department = await getDepartment(ctx.db, ctx.params.id);
  const access = await peopleAccess(ctx);
  if (department.is_system) throw forbidden("Every active member is in Everyone automatically.");
  if (!access.isAdmin && !access.leads.has(department.id)) throw forbidden("Only admins and this department's leaders can remove members.");
  const membership = await ctx.db.first(
    "SELECT * FROM department_members WHERE department_id = ? AND user_id = ?",
    department.id,
    Number(ctx.params.userId),
  );
  if (!membership) throw notFound("This person is not in the department.");
  if (!access.isAdmin && membership.is_leader) throw forbidden("Only admins can remove a team leader.");
  await ctx.db.run("DELETE FROM department_members WHERE department_id = ? AND user_id = ?", department.id, membership.user_id);
  return noContent();
}

// Permission resolution: who can see and edit which document.
//
// For a member, the principals are the member themself plus each of their
// departments (including the automatic Everyone department while active).
// For each principal, its grant on the document wins over its grant on the
// document's category (upward or downward; a document grant can be 'none').
// The effective level is the highest across principals, so a user-level grant
// can only add access. A document is mandatory if any principal's applicable
// grant is mandatory and gives at least View. Admins have Edit and publish on
// everything, but content is mandatory for them only if granted as such.
//
// All data is loaded once per request (the corpus is small) and the
// resolution itself is a pure function, so it can run for many users at once.

export const LEVELS = ["none", "view", "edit_review", "edit_publish"];
export const LEVEL_LABELS = { none: "None", view: "View", edit_review: "Edit with review", edit_publish: "Edit and publish" };
export const rank = (level) => (level ? LEVELS.indexOf(level) : 0);
export const atLeast = (level, minimum) => rank(level) >= rank(minimum);

// Loads everything the resolution needs. Cache the result per request.
export async function loadAccessData(db) {
  const [documents, grants, memberships, system] = await Promise.all([
    db.all("SELECT id, category_id, is_published FROM documents"),
    db.all("SELECT * FROM grants"),
    db.all("SELECT department_id, user_id, is_leader FROM department_members"),
    db.value("SELECT id FROM departments WHERE is_system = 1"),
  ]);
  const grantIndex = new Map(); // "category:5|department:3" -> grant
  for (const g of grants) grantIndex.set(`${g.target_type}:${g.target_id}|${g.principal_type}:${g.principal_id}`, g);
  const departmentsByUser = new Map();
  for (const m of memberships) {
    if (!departmentsByUser.has(m.user_id)) departmentsByUser.set(m.user_id, []);
    departmentsByUser.get(m.user_id).push(m.department_id);
  }
  return { documents, grants, grantIndex, departmentsByUser, systemDepartmentId: system };
}

export function principalsOf(data, user) {
  const principals = [{ type: "user", id: user.id }];
  if (user.is_active && data.systemDepartmentId) principals.push({ type: "department", id: data.systemDepartmentId });
  for (const id of data.departmentsByUser.get(user.id) || []) principals.push({ type: "department", id });
  return principals;
}

// The grant that applies to one principal for one document, and where it comes from.
export function applicableGrant(data, principal, document) {
  const key = `|${principal.type}:${principal.id}`;
  return data.grantIndex.get(`document:${document.id}${key}`) || data.grantIndex.get(`category:${document.category_id}${key}`) || null;
}

// Resolves one user's access. Returns:
//   docs: Map(documentId -> { level, mandatory, source })   (only documents with level above 'none')
//   categoryEdit: Set(categoryId) where the user may create documents
//   categoryLevel(categoryId) -> highest category-level grant across principals
export function resolveAccess(data, user) {
  const principals = principalsOf(data, user);
  const docs = new Map();
  for (const document of data.documents) {
    let level = "none";
    let mandatory = false;
    let source = null;
    for (const principal of principals) {
      const grant = applicableGrant(data, principal, document);
      if (!grant) continue;
      if (rank(grant.level) > rank(level)) {
        level = grant.level;
        source = { principal_type: principal.type, principal_id: principal.id, target_type: grant.target_type };
      }
      if (grant.mandatory && atLeast(grant.level, "view")) mandatory = true;
    }
    if (user.is_admin) {
      level = "edit_publish";
      source = { admin: true };
    }
    if (level !== "none") docs.set(document.id, { level, mandatory, source });
  }

  const categoryLevels = new Map();
  for (const principal of principals) {
    for (const grant of data.grants) {
      if (grant.target_type !== "category" || grant.principal_type !== principal.type || grant.principal_id !== principal.id) continue;
      if (rank(grant.level) > rank(categoryLevels.get(grant.target_id))) categoryLevels.set(grant.target_id, grant.level);
    }
  }
  const categoryLevel = (categoryId) => (user.is_admin ? "edit_publish" : categoryLevels.get(categoryId) || "none");
  const categoryEdit = new Set([...categoryLevels].filter(([, level]) => atLeast(level, "edit_review")).map(([id]) => id));

  return {
    isAdmin: Boolean(user.is_admin),
    docs,
    level: (documentId) => docs.get(documentId)?.level || "none",
    mandatory: (documentId) => Boolean(docs.get(documentId)?.mandatory),
    canCreateIn: (categoryId) => Boolean(user.is_admin) || categoryEdit.has(categoryId),
    categoryLevel,
    canEditAnything: Boolean(user.is_admin) || categoryEdit.size > 0 || [...docs.values()].some((d) => atLeast(d.level, "edit_review")),
  };
}

// The access of the current user, cached on the request context.
export async function accessFor(ctx) {
  if (!ctx.access) {
    ctx.accessData = ctx.accessData || (await loadAccessData(ctx.db));
    ctx.access = resolveAccess(ctx.accessData, ctx.user);
  }
  return ctx.access;
}

// Can this user see this document right now? Readers only see published ones;
// editors also see unpublished documents they can edit.
export function canView(access, document) {
  const level = access.level(document.id);
  if (document.is_published) return atLeast(level, "view");
  return atLeast(level, "edit_review");
}

// Editing happens in the document's draft, so "Edit with review" is enough
// to edit; publishing needs "Edit and publish" (see drafts.js).
export function canEditDocument(access, document) {
  return atLeast(access.level(document.id), "edit_review");
}

// Mandatory published documents for many users at once: Map(userId -> Set(docId)).
export function mandatoryByUser(data, users) {
  const result = new Map();
  for (const user of users) {
    const access = resolveAccess(data, { ...user, is_admin: false });
    const set = new Set();
    for (const document of data.documents) {
      if (document.is_published && access.mandatory(document.id)) set.add(document.id);
    }
    result.set(user.id, set);
  }
  return result;
}

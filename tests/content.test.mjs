import { test } from "node:test";
import assert from "node:assert/strict";
import { workspace } from "./helpers.mjs";

// A workspace with one space, one category and two published documents.
async function handbook() {
  const w = await workspace();
  const { t, admin } = w;
  const call = (method, path, body, token = admin) => t.call(method, path, { token, body });
  const space = (await call("POST", "/api/spaces", { name: "The Academy" })).body.space;
  const category = (await call("POST", "/api/categories", { space_id: space.id, name: "How OneTake works", emoji: "📚" })).body.category;
  async function doc(title, { publish = true, steps = [] } = {}) {
    const created = await call("POST", "/api/documents", { category_id: category.id, title });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.document.id;
    for (const s of steps) await call("POST", `/api/documents/${id}/steps`, { title: s });
    if (publish) assert.equal((await call("POST", `/api/documents/${id}/publish`, { publish: true })).status, 200);
    return id;
  }
  const grant = (target_type, target_id, principal_type, principal_id, level, mandatory = false, token = admin) =>
    call("PUT", "/api/grants", { target_type, target_id, principal_type, principal_id, level, mandatory }, token);
  return { ...w, call, space, category, doc, grant };
}

const treeDocIds = (tree) => tree.spaces.flatMap((s) => s.categories.flatMap((c) => c.documents.map((d) => d.id)));

test("a member with no grants sees an empty handbook and can't fetch any document", async () => {
  const h = await handbook();
  const a = await h.doc("Company Information");
  const sam = await h.member("Sam", []);
  const tree = (await h.call("GET", "/api/tree", undefined, sam.token)).body;
  assert.deepEqual(tree.spaces, []);
  assert.equal(tree.can_edit, false);
  assert.equal((await h.call("GET", `/api/documents/${a}`, undefined, sam.token)).status, 404);
  const step = await h.t.db.value("SELECT id FROM steps WHERE document_id = ?", a);
  assert.equal((await h.call("POST", `/api/steps/${step}/complete`, undefined, sam.token)).status, 404);
});

test("Marketing (View on a category) and Product (Edit with review on one document) can edit only that document", async () => {
  const h = await handbook();
  const a = await h.doc("What our product does");
  const b = await h.doc("ICP", { publish: false });
  const c = await h.doc("Team communication", { publish: false });
  await h.grant("category", h.category.id, "department", h.dept.Marketing, "view");
  await h.grant("document", b, "department", h.dept.Product, "edit_review");
  const mia = await h.member("Mia", [h.dept.Marketing, h.dept.Product]);

  const tree = (await h.call("GET", "/api/tree", undefined, mia.token)).body;
  assert.deepEqual(treeDocIds(tree), [a], "view mode: published documents only");
  const editTree = (await h.call("GET", "/api/tree?mode=edit", undefined, mia.token)).body;
  assert.deepEqual(treeDocIds(editTree).sort(), [a, b].sort(), "edit mode adds the document Mia can edit");
  assert.equal(editTree.can_edit, true);

  assert.equal((await h.call("PATCH", `/api/documents/${b}`, { title: "ICP v2" }, mia.token)).status, 200);
  assert.equal((await h.call("PATCH", `/api/documents/${a}`, { title: "x" }, mia.token)).status, 403);
  assert.equal((await h.call("PATCH", `/api/documents/${c}`, { title: "x" }, mia.token)).status, 404, "unpublished and not editable: invisible");
  assert.equal((await h.call("POST", `/api/documents/${b}/publish`, { publish: true }, mia.token)).status, 403, "Edit with review can't publish");
  assert.equal((await h.call("POST", "/api/documents", { category_id: h.category.id, title: "New" }, mia.token)).status, 403, "creating needs a category-level edit grant");
});

test("a document-level None for Marketing hides it, unless another department or a user grant gives access", async () => {
  const h = await handbook();
  const a = await h.doc("Visible");
  const secret = await h.doc("Stock options");
  await h.grant("category", h.category.id, "department", h.dept.Marketing, "view");
  await h.grant("document", secret, "department", h.dept.Marketing, "none");
  const mia = await h.member("Mia", [h.dept.Marketing]);
  assert.deepEqual(treeDocIds((await h.call("GET", "/api/tree", undefined, mia.token)).body), [a]);
  assert.equal((await h.call("GET", `/api/documents/${secret}`, undefined, mia.token)).status, 404);

  await h.grant("document", secret, "user", mia.id, "view");
  assert.equal((await h.call("GET", `/api/documents/${secret}`, undefined, mia.token)).status, 200);

  const pat = await h.member("Pat", [h.dept.Marketing, h.dept.Product]);
  assert.equal((await h.call("GET", `/api/documents/${secret}`, undefined, pat.token)).status, 404);
  await h.grant("category", h.category.id, "department", h.dept.Product, "view");
  assert.equal((await h.call("GET", `/api/documents/${secret}`, undefined, pat.token)).status, 200, "Product gives it back");
});

test("'None' is refused on a category", async () => {
  const h = await handbook();
  assert.equal((await h.grant("category", h.category.id, "department", h.dept.Marketing, "none")).status, 400);
});

test("readers never see unpublished documents", async () => {
  const h = await handbook();
  const draft = await h.doc("Work in progress", { publish: false });
  await h.grant("category", h.category.id, "department", h.dept.Everyone, "view");
  const sam = await h.member("Sam", []);
  assert.deepEqual(treeDocIds((await h.call("GET", "/api/tree", undefined, sam.token)).body), []);
  assert.deepEqual(treeDocIds((await h.call("GET", "/api/tree?mode=edit", undefined, sam.token)).body), []);
  assert.equal((await h.call("GET", `/api/documents/${draft}`, undefined, sam.token)).status, 404);
  assert.equal(await h.t.db.value("SELECT COUNT(*) FROM steps_fts WHERE document_id = ?", draft), 0, "not in the search index");
});

test("completion: steps, document completion, and un-completing", async () => {
  const h = await handbook();
  const a = await h.doc("Onboarding", { steps: ["Part 2"] });
  await h.grant("category", h.category.id, "department", h.dept.Everyone, "view", true);
  const sam = await h.member("Sam", []);
  const doc = (await h.call("GET", `/api/documents/${a}`, undefined, sam.token)).body;
  assert.equal(doc.mandatory, true);
  assert.equal(doc.progress.status, "not_started");
  const [s1, s2] = doc.steps.map((s) => s.id);

  assert.equal((await h.call("POST", `/api/steps/${s1}/view`, undefined, sam.token)).status, 204);
  await h.call("POST", `/api/steps/${s1}/view`, undefined, sam.token);
  assert.equal(await h.t.db.value("SELECT view_count FROM step_views WHERE step_id = ?", s1), 2);

  await h.call("POST", `/api/steps/${s1}/complete`, undefined, sam.token);
  assert.equal((await h.call("GET", `/api/documents/${a}`, undefined, sam.token)).body.progress.status, "in_progress");
  await h.call("POST", `/api/steps/${s2}/complete`, undefined, sam.token);
  const done = (await h.call("GET", `/api/documents/${a}`, undefined, sam.token)).body.progress;
  assert.equal(done.status, "completed");
  assert.ok(done.completed_at);

  await h.call("DELETE", `/api/steps/${s2}/complete`, undefined, sam.token);
  assert.equal((await h.call("GET", `/api/documents/${a}`, undefined, sam.token)).body.progress.status, "in_progress");
});

test("a major revision drops the completion rate and notifies; a minor one does not", async () => {
  const h = await handbook();
  const a = await h.doc("Security policy");
  await h.grant("document", a, "department", h.dept.Everyone, "view", true);
  const sam = await h.member("Sam", []);
  const step = (await h.call("GET", `/api/documents/${a}`, undefined, sam.token)).body.steps[0].id;
  await h.call("POST", `/api/steps/${step}/complete`, undefined, sam.token);

  const rate = async () => (await h.call("GET", "/api/users", undefined, h.admin)).body.users.find((u) => u.id === sam.id).completion;
  assert.deepEqual(await rate(), { completed: 1, total: 1 });
  const notifications = () => h.t.db.all("SELECT type FROM notifications WHERE user_id = ? ORDER BY id", sam.id);
  const before = (await notifications()).length;

  await h.call("POST", `/api/documents/${a}/publish`, { publish: true, revision: "minor" });
  assert.deepEqual(await rate(), { completed: 1, total: 1 });
  assert.equal((await notifications()).length, before);

  await new Promise((r) => setTimeout(r, 5));
  await h.call("POST", `/api/documents/${a}/publish`, { publish: true, revision: "major" });
  assert.deepEqual(await rate(), { completed: 0, total: 1 });
  assert.equal((await notifications()).at(-1).type, "major_revision");
  const doc = (await h.call("GET", `/api/documents/${a}`, undefined, sam.token)).body;
  assert.equal(doc.progress.status, "not_started");
  assert.equal(await h.t.db.value("SELECT COUNT(*) FROM step_completions"), 1, "old completions are kept for history");
});

test("a minor revision that adds a step leaves only that step to complete", async () => {
  const h = await handbook();
  const a = await h.doc("Process");
  await h.grant("category", h.category.id, "department", h.dept.Everyone, "view");
  const sam = await h.member("Sam", []);
  const step = (await h.call("GET", `/api/documents/${a}`, undefined, sam.token)).body.steps[0].id;
  await h.call("POST", `/api/steps/${step}/complete`, undefined, sam.token);
  await h.call("POST", `/api/documents/${a}/steps`, { title: "New part" });
  const progress = (await h.call("GET", `/api/documents/${a}`, undefined, sam.token)).body.progress;
  assert.deepEqual([progress.status, progress.done, progress.total], ["in_progress", 1, 2]);
});

test("making a published document mandatory notifies the members concerned", async () => {
  const h = await handbook();
  const a = await h.doc("Code of conduct");
  const mia = await h.member("Mia", [h.dept.Marketing]);
  const pat = await h.member("Pat", [h.dept.Product]);
  const res = await h.grant("category", h.category.id, "department", h.dept.Marketing, "view", true);
  assert.equal(res.body.notified, 1);
  const types = async (id) => (await h.t.db.all("SELECT type FROM notifications WHERE user_id = ?", id)).map((n) => n.type);
  assert.ok((await types(mia.id)).includes("mandatory_assigned"));
  assert.ok(!(await types(pat.id)).includes("mandatory_assigned"));
  // Already mandatory: no second notification.
  assert.equal((await h.grant("document", a, "department", h.dept.Marketing, "view", true)).body.notified, 0);
});

test("team leaders assign access only to their department, and never above their own level", async () => {
  const h = await handbook();
  const a = await h.doc("Brand guide");
  await h.grant("category", h.category.id, "department", h.dept.Marketing, "edit_review");
  const lea = await h.member("Lea", [{ id: h.dept.Marketing, is_leader: true }]);
  const nina = await h.member("Nina", [h.dept.Marketing]);
  const pat = await h.member("Pat", [h.dept.Product]);

  assert.equal((await h.grant("document", a, "user", nina.id, "edit_review", true, lea.token)).status, 200);
  assert.equal((await h.grant("document", a, "user", nina.id, "edit_publish", false, lea.token)).status, 403, "above the leader's own level");
  assert.equal((await h.grant("document", a, "user", pat.id, "view", false, lea.token)).status, 403, "not in the leader's department");
  assert.equal((await h.grant("category", h.category.id, "department", h.dept.Product, "view", false, lea.token)).status, 403);
  assert.equal((await h.call("GET", `/api/grants?principal=department:${h.dept.Product}`, undefined, lea.token)).status, 403);

  const view = (await h.call("GET", `/api/grants?principal=user:${nina.id}`, undefined, lea.token)).body;
  assert.equal(view.effective[`document:${a}`].level, "edit_review");
  assert.match(view.effective[`document:${a}`].source, /Marketing|own grant/);

  // A plain member can't manage access at all.
  assert.equal((await h.grant("document", a, "user", nina.id, "view", false, nina.token)).status, 403);
});

test("the Access tree marks documents whose settings differ from their category", async () => {
  const h = await handbook();
  const a = await h.doc("Same");
  const b = await h.doc("Different");
  await h.grant("category", h.category.id, "department", h.dept.Marketing, "view", true);
  await h.grant("document", b, "department", h.dept.Marketing, "view", false);
  const res = (await h.call("GET", `/api/grants?principal=department:${h.dept.Marketing}`)).body;
  const docs = res.tree[0].categories[0].documents;
  assert.equal(docs.find((d) => d.id === a).differs, false);
  assert.equal(docs.find((d) => d.id === b).differs, true);
  assert.equal(res.effective[`document:${a}`].mandatory, true);
  assert.equal(res.effective[`document:${b}`].mandatory, false);
});

test("publishing indexes the document for search; unpublishing and deleting remove it", async () => {
  const h = await handbook();
  const a = await h.doc("Refund policy", { publish: false });
  const step = await h.t.db.value("SELECT id FROM steps WHERE document_id = ?", a);
  await h.call("PATCH", `/api/steps/${step}`, { content_text: "Customers can ask for a refund within 30 days." });
  await h.call("POST", `/api/documents/${a}/publish`, { publish: true });
  const hits = await h.t.db.all("SELECT document_id FROM steps_fts WHERE steps_fts MATCH 'refund'");
  assert.deepEqual(hits.map((r) => r.document_id), [a]);
  await h.call("POST", `/api/documents/${a}/publish`, { publish: false });
  assert.equal(await h.t.db.value("SELECT COUNT(*) FROM steps_fts"), 0);
  await h.call("POST", `/api/documents/${a}/publish`, { publish: true });
  assert.equal((await h.call("DELETE", `/api/documents/${a}`)).status, 204);
  assert.equal(await h.t.db.value("SELECT COUNT(*) FROM steps_fts"), 0);
});

test("step text is stored as plain text and as Tiptap JSON", async () => {
  const h = await handbook();
  const a = await h.doc("Doc", { publish: false });
  const step = await h.t.db.value("SELECT id FROM steps WHERE document_id = ?", a);
  await h.call("PATCH", `/api/steps/${step}`, { content_text: "First line\nsecond line\n\nNew paragraph" });
  const row = await h.t.db.first("SELECT content_json FROM steps WHERE id = ?", step);
  const json = JSON.parse(row.content_json);
  assert.equal(json.content.length, 2);
  assert.deepEqual(json.content[0].content.map((n) => n.type), ["text", "hardBreak", "text"]);
});

test("reordering: admins reorder categories, editors reorder steps, others are refused", async () => {
  const h = await handbook();
  const a = await h.doc("Doc", { steps: ["Two", "Three"], publish: false });
  const steps = (await h.t.db.all("SELECT id FROM steps WHERE document_id = ? ORDER BY position", a)).map((r) => r.id);
  const reversed = [...steps].reverse();
  assert.equal((await h.call("POST", "/api/reorder", { type: "step", ids: reversed })).status, 200);
  assert.deepEqual((await h.t.db.all("SELECT id FROM steps WHERE document_id = ? ORDER BY position", a)).map((r) => r.id), reversed);
  assert.equal((await h.call("POST", "/api/reorder", { type: "step", ids: reversed.slice(1) })).status, 409, "the full list is required");

  const second = (await h.call("POST", "/api/categories", { space_id: h.space.id, name: "Second" })).body.category;
  const sam = await h.member("Sam", []);
  assert.equal((await h.call("POST", "/api/reorder", { type: "category", ids: [second.id, h.category.id] }, sam.token)).status, 403);
  assert.equal((await h.call("POST", "/api/reorder", { type: "category", ids: [second.id, h.category.id] })).status, 200);
});

test("deleting a category deletes its documents and their grants", async () => {
  const h = await handbook();
  const a = await h.doc("Doc");
  await h.grant("document", a, "department", h.dept.Marketing, "view");
  assert.equal((await h.call("DELETE", `/api/categories/${h.category.id}`)).status, 204);
  assert.equal(await h.t.db.value("SELECT COUNT(*) FROM documents"), 0);
  assert.equal(await h.t.db.value("SELECT COUNT(*) FROM grants"), 0);
  assert.equal(await h.t.db.value("SELECT COUNT(*) FROM steps_fts"), 0);
});

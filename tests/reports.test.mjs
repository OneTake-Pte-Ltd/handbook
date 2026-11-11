import { test } from "node:test";
import assert from "node:assert/strict";
import { workspace } from "./helpers.mjs";

const paragraph = (text) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

async function setup() {
  const w = await workspace();
  const call = (method, path, body, token = w.admin) => w.t.call(method, path, { token, body });
  const space = (await call("POST", "/api/spaces", { name: "S" })).body.space;
  const category = (await call("POST", "/api/categories", { space_id: space.id, name: "Onboarding" })).body.category;
  async function doc(title, steps = 1) {
    const id = (await call("POST", "/api/documents", { category_id: category.id, title })).body.document.id;
    const opened = (await call("GET", `/api/documents/${id}/draft`)).body;
    for (let i = 1; i < steps; i++) opened.draft.snapshot.steps.push({ title: `Part ${i + 1}`, content_json: paragraph("Text") });
    await call("PUT", `/api/documents/${id}/draft`, { snapshot: opened.draft.snapshot, base_updated_at: opened.draft.updated_at });
    await call("POST", `/api/documents/${id}/draft/publish`, { revision_type: "minor" });
    return id;
  }
  const stepsOf = async (id) => (await w.t.db.all("SELECT id FROM steps WHERE document_id = ? ORDER BY position", id)).map((r) => r.id);
  const complete = (token, stepId) => call("POST", `/api/steps/${stepId}/complete`, undefined, token);
  return { ...w, call, category, doc, stepsOf, complete };
}

test("overview: one row per member with assigned, completed, rate and last activity", async () => {
  const s = await setup();
  const a = await s.doc("Code of conduct");
  const b = await s.doc("Security", 2);
  await s.call("PUT", "/api/grants", { target_type: "category", target_id: s.category.id, principal_type: "department", principal_id: s.dept.Marketing, level: "view", mandatory: true });
  const mia = await s.member("Mia", [s.dept.Marketing]);
  const pat = await s.member("Pat", [s.dept.Product]);
  await s.complete(mia.token, (await s.stepsOf(a))[0]);
  await s.complete(mia.token, (await s.stepsOf(b))[0]);

  const rows = (await s.call("GET", "/api/reports/overview")).body.rows;
  const miaRow = rows.find((r) => r.user.id === mia.id);
  assert.deepEqual([miaRow.assigned, miaRow.completed, miaRow.rate], [2, 1, 50]);
  assert.ok(miaRow.last_activity);
  assert.deepEqual(miaRow.departments.map((d) => d.name), ["Marketing"]);
  const patRow = rows.find((r) => r.user.id === pat.id);
  assert.deepEqual([patRow.assigned, patRow.rate], [0, null]);

  const filtered = (await s.call("GET", `/api/reports/overview?department=${s.dept.Marketing}`)).body.rows;
  assert.deepEqual(filtered.map((r) => r.user.id), [mia.id]);
});

test("team leaders only see members of the departments they lead", async () => {
  const s = await setup();
  await s.doc("Doc");
  const lea = await s.member("Lea", [{ id: s.dept.Marketing, is_leader: true }]);
  const mia = await s.member("Mia", [s.dept.Marketing]);
  const pat = await s.member("Pat", [s.dept.Product]);
  const rows = (await s.call("GET", "/api/reports/overview", undefined, lea.token)).body.rows;
  assert.deepEqual(rows.map((r) => r.user.first_name).sort(), ["Lea", "Mia"]);
  assert.equal((await s.call("GET", `/api/reports/users/${mia.id}`, undefined, lea.token)).status, 200);
  assert.equal((await s.call("GET", `/api/reports/users/${pat.id}`, undefined, lea.token)).status, 404);
  assert.equal((await s.call("GET", "/api/reports/overview", undefined, mia.token)).status, 403, "plain members have no reports");
});

test("member report: statuses including needs re-reading, and the viewing history", async () => {
  const s = await setup();
  const a = await s.doc("Done", 1);
  const b = await s.doc("Half", 2);
  const c = await s.doc("Revised", 1);
  const d = await s.doc("Untouched", 1);
  await s.call("PUT", "/api/grants", { target_type: "category", target_id: s.category.id, principal_type: "department", principal_id: s.dept.Everyone, level: "view", mandatory: true });
  const mia = await s.member("Mia", []);
  await s.complete(mia.token, (await s.stepsOf(a))[0]);
  await s.complete(mia.token, (await s.stepsOf(b))[0]);
  await s.complete(mia.token, (await s.stepsOf(c))[0]);
  await s.call("POST", `/api/steps/${(await s.stepsOf(b))[0]}/view`, undefined, mia.token);
  await s.call("POST", `/api/steps/${(await s.stepsOf(b))[0]}/view`, undefined, mia.token);
  await new Promise((r) => setTimeout(r, 5));
  await s.call("POST", `/api/documents/${c}/draft/publish`, { revision_type: "major" });

  const report = (await s.call("GET", `/api/reports/users/${mia.id}`)).body;
  const byTitle = Object.fromEntries(report.documents.map((x) => [x.title, x]));
  assert.equal(byTitle.Done.status, "completed");
  assert.ok(byTitle.Done.completed_at);
  assert.deepEqual([byTitle.Half.status, byTitle.Half.done, byTitle.Half.total], ["in_progress", 1, 2]);
  assert.equal(byTitle.Revised.status, "needs_rereading");
  assert.equal(byTitle.Untouched.status, "not_started");
  assert.deepEqual(report.completion, { completed: 1, total: 4, rate: 25 });
  assert.equal(report.history[0].view_count, 2);
  assert.equal(report.history[0].document_title, "Half");
  void d;
});

test("document report lists every member for whom it is mandatory", async () => {
  const s = await setup();
  const a = await s.doc("Policy");
  await s.call("PUT", "/api/grants", { target_type: "document", target_id: a, principal_type: "department", principal_id: s.dept.Marketing, level: "view", mandatory: true });
  const mia = await s.member("Mia", [s.dept.Marketing]);
  const nia = await s.member("Nia", [s.dept.Marketing]);
  await s.member("Pat", [s.dept.Product]);
  await s.complete(mia.token, (await s.stepsOf(a))[0]);
  const report = (await s.call("GET", `/api/reports/documents/${a}`)).body;
  assert.deepEqual(report.summary, { members: 2, completed: 1 });
  assert.deepEqual(
    report.rows.map((r) => [r.user.first_name, r.status]).sort(),
    [
      ["Mia", "completed"],
      ["Nia", "not_started"],
    ],
  );
  void nia;
});

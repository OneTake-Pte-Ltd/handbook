import { test } from "node:test";
import assert from "node:assert/strict";
import { workspace } from "./helpers.mjs";
import { ftsQuery } from "../edge/src/lib/search.js";

const paragraph = (text) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

async function setup() {
  const w = await workspace();
  const call = (method, path, body, token = w.admin) => w.t.call(method, path, { token, body });
  const space = (await call("POST", "/api/spaces", { name: "S" })).body.space;
  const category = (await call("POST", "/api/categories", { space_id: space.id, name: "Policies", emoji: "📋" })).body.category;
  const other = (await call("POST", "/api/categories", { space_id: space.id, name: "Secret" })).body.category;
  async function doc(title, text, { cat = category, publish = true } = {}) {
    const id = (await call("POST", "/api/documents", { category_id: cat.id, title })).body.document.id;
    const opened = (await call("GET", `/api/documents/${id}/draft`)).body;
    opened.draft.snapshot.steps[0].content_json = paragraph(text);
    await call("PUT", `/api/documents/${id}/draft`, { snapshot: opened.draft.snapshot, base_updated_at: opened.draft.updated_at });
    if (publish) await call("POST", `/api/documents/${id}/draft/publish`, { revision_type: "minor" });
    return id;
  }
  await call("PUT", "/api/grants", { target_type: "category", target_id: category.id, principal_type: "department", principal_id: w.dept.Everyone, level: "view" });
  return { ...w, call, category, other, doc };
}

test("FTS queries quote every word and add prefix matching to the last one", () => {
  assert.equal(ftsQuery("refund policy"), '"refund" "policy"*');
  assert.equal(ftsQuery('NOT "x" OR * (y)'), '"NOT" "x" "OR" "y"*');
  assert.equal(ftsQuery("   "), null);
  assert.equal(ftsQuery("l'équipe"), "\"l'équipe\"*");
});

test("search finds published content the member can view, with prefixes, stemming and accents", async () => {
  const s = await setup();
  const refunds = await s.doc("Refund policy", "Customers running a café can ask for a refund within 30 days.");
  await s.doc("Salaries", "The refund of travel costs is private.", { cat: s.other });
  await s.doc("Draft refunds", "Refund draft text.", { publish: false });
  const sam = await s.member("Sam", []);
  const search = async (q, token = sam.token) => (await s.call("GET", `/api/search?q=${encodeURIComponent(q)}`, undefined, token)).body.results;

  assert.deepEqual((await search("refund")).map((r) => r.document_id), [refunds], "other category and drafts are excluded");
  assert.equal((await search("refu")).length, 1, "prefix on the last word");
  assert.equal((await search("run")).length, 1, "porter stemming");
  assert.equal((await search("cafe")).length, 1, "accents removed");
  const [hit] = await search("refund");
  assert.equal(hit.category.name, "Policies");
  assert.ok(hit.snippet.includes("\u0001"), "matches are marked in the snippet");
  assert.equal((await search("refund", s.admin)).length, 2, "the admin sees both published documents");
  assert.deepEqual(await search('" OR *'), []);
});

test("the document title weighs more than the body", async () => {
  const s = await setup();
  const inBody = await s.doc("Expenses", "Onboarding is mentioned here once.");
  const inTitle = await s.doc("Onboarding", "Welcome.");
  const results = (await s.call("GET", "/api/search?q=onboarding")).body.results;
  assert.deepEqual(results.map((r) => r.document_id), [inTitle, inBody]);
});

test("rebuilding the search index restores it (admins only)", async () => {
  const s = await setup();
  await s.doc("Refund policy", "Refunds within 30 days.");
  await s.t.db.run("DELETE FROM steps_fts");
  const sam = await s.member("Sam", []);
  assert.equal((await s.call("POST", "/api/search/rebuild", undefined, sam.token)).status, 403);
  const res = await s.call("POST", "/api/search/rebuild");
  assert.equal(res.body.documents, 1);
  assert.equal((await s.call("GET", "/api/search?q=refund")).body.results.length, 1);
});

test("home: requires completion, completion rate, recently updated, waiting for review", async () => {
  const s = await setup();
  const a = await s.doc("Code of conduct", "Be kind. ".repeat(450));
  const b = await s.doc("Holidays", "Ask two weeks before.");
  await s.call("PUT", "/api/grants", { target_type: "document", target_id: a, principal_type: "department", principal_id: s.dept.Everyone, level: "view", mandatory: true });
  await s.call("PUT", "/api/grants", { target_type: "document", target_id: b, principal_type: "department", principal_id: s.dept.Everyone, level: "view", mandatory: true });
  const sam = await s.member("Sam", []);
  const step = await s.t.db.value("SELECT id FROM steps WHERE document_id = ?", b);
  await s.call("POST", `/api/steps/${step}/complete`, undefined, sam.token);

  const home = (await s.call("GET", "/api/home", undefined, sam.token)).body;
  assert.deepEqual(home.requires_completion.map((d) => d.id), [a]);
  assert.equal(home.requires_completion[0].minutes, 5, "900 words at 200 words per minute");
  assert.deepEqual(home.completion, { completed: 1, total: 2 });
  assert.deepEqual(home.recently_updated.map((d) => d.id).sort(), [a, b].sort());
  assert.deepEqual(home.waiting_for_review, []);

  await s.call("POST", `/api/documents/${b}/draft/publish`, { revision_type: "major" });
  const after = (await s.call("GET", "/api/home", undefined, sam.token)).body;
  assert.equal(after.recently_updated[0].id, b);
  assert.equal(after.recently_updated[0].major_update, true);
  assert.deepEqual(after.completion, { completed: 0, total: 2 });

  // A review request appears for the reviewer.
  const mia = await s.member("Mia", []);
  await s.call("PUT", "/api/grants", { target_type: "document", target_id: a, principal_type: "user", principal_id: mia.id, level: "edit_review" });
  const opened = (await s.call("GET", `/api/documents/${a}/draft`, undefined, mia.token)).body;
  opened.snapshot.title = "Code of conduct v2";
  await s.call("PUT", `/api/documents/${a}/draft`, { snapshot: opened.snapshot, base_updated_at: null }, mia.token);
  await s.call("POST", `/api/documents/${a}/draft/submit`, { revision_type: "minor" }, mia.token);
  const adminHome = (await s.call("GET", "/api/home")).body;
  assert.equal(adminHome.waiting_for_review[0].title, "Code of conduct v2");
  assert.equal(adminHome.waiting_for_review[0].author.name, "Mia Test");
});

test("notifications: list with names and links, count, mark one or all as read, only your own", async () => {
  const s = await setup();
  const a = await s.doc("Security", "Use a password manager.");
  const sam = await s.member("Sam", [s.dept.Marketing]);
  await s.call("PUT", "/api/grants", { target_type: "document", target_id: a, principal_type: "department", principal_id: s.dept.Marketing, level: "view", mandatory: true });
  const list = (await s.call("GET", "/api/notifications", undefined, sam.token)).body;
  assert.equal(list.unread_count, 1);
  assert.equal(list.items[0].type, "mandatory_assigned");
  assert.equal(list.items[0].link, `#/doc/${a}`);
  assert.equal(list.items[0].title, "Security");

  // Someone else can't mark Sam's notifications.
  const pat = await s.member("Pat", []);
  await s.call("POST", "/api/notifications/read", { ids: [list.items[0].id] }, pat.token);
  assert.equal((await s.call("GET", "/api/notifications?count=1", undefined, sam.token)).body.unread_count, 1);

  await s.call("POST", "/api/notifications/read", { ids: [list.items[0].id] }, sam.token);
  assert.equal((await s.call("GET", "/api/notifications?count=1", undefined, sam.token)).body.unread_count, 0);

  await s.call("PUT", `/api/departments/${s.dept.Product}/members/${sam.id}`, { is_leader: true });
  const again = (await s.call("GET", "/api/notifications", undefined, sam.token)).body;
  assert.equal(again.items[0].department, "Product");
  assert.equal(again.items[0].actor, "Ada Admin");
  await s.call("POST", "/api/notifications/read", { all: true }, sam.token);
  assert.equal((await s.call("GET", "/api/notifications?count=1", undefined, sam.token)).body.unread_count, 0);
});

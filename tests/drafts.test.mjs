import { test } from "node:test";
import assert from "node:assert/strict";
import { workspace } from "./helpers.mjs";
import { cleanDoc, docToText } from "../edge/src/lib/richtext.js";

const paragraph = (text) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

async function setup() {
  const w = await workspace();
  const call = (method, path, body, token = w.admin) => w.t.call(method, path, { token, body });
  const space = (await call("POST", "/api/spaces", { name: "S" })).body.space;
  const category = (await call("POST", "/api/categories", { space_id: space.id, name: "C" })).body.category;
  const open = (id, token) => call("GET", `/api/documents/${id}/draft`, undefined, token);
  async function save(id, mutate, token) {
    const d = (await open(id, token)).body.draft;
    mutate(d.snapshot);
    return call("PUT", `/api/documents/${id}/draft`, { snapshot: d.snapshot, base_updated_at: d.updated_at }, token);
  }
  async function newDoc(title, text = "Version one") {
    const id = (await call("POST", "/api/documents", { category_id: category.id, title })).body.document.id;
    await save(id, (s) => (s.steps[0].content_json = paragraph(text)));
    assert.equal((await call("POST", `/api/documents/${id}/draft/publish`, { revision_type: "minor" })).status, 200);
    return id;
  }
  const types = async (userId) => (await w.t.db.all("SELECT type FROM notifications WHERE user_id = ? ORDER BY id", userId)).map((n) => n.type);
  return { ...w, call, category, open, save, newDoc, types };
}

test("readers never see work in progress", async () => {
  const s = await setup();
  const id = await s.newDoc("Policy");
  await s.call("PUT", "/api/grants", { target_type: "category", target_id: s.category.id, principal_type: "department", principal_id: s.dept.Everyone, level: "view" });
  const reader = await s.member("Rita", []);

  assert.equal((await s.save(id, (snap) => {
    snap.title = "Policy v2";
    snap.steps[0].content_json = paragraph("Secret new version");
  })).status, 200);

  const seen = (await s.call("GET", `/api/documents/${id}`, undefined, reader.token)).body;
  assert.equal(seen.document.title, "Policy");
  assert.equal(seen.steps[0].content_text, "Version one");
  assert.equal(seen.draft, null, "readers don't even learn a draft exists");
  assert.equal((await s.open(id, reader.token)).status, 403);
  assert.equal(await s.t.db.value("SELECT COUNT(*) FROM steps_fts WHERE steps_fts MATCH 'secret'"), 0);
});

test("a second editor works on the same draft and sees who started it; stale saves are refused", async () => {
  const s = await setup();
  const id = await s.newDoc("Shared");
  const pat = await s.member("Pat", [], { is_admin: true });
  const first = (await s.open(id)).body;
  assert.equal(first.created, true);
  const second = (await s.open(id, pat.token)).body;
  assert.equal(second.created, false);
  assert.equal(second.draft.author.name, "Ada Admin");

  const ok = await s.call("PUT", `/api/documents/${id}/draft`, { snapshot: first.draft.snapshot, base_updated_at: first.draft.updated_at });
  assert.equal(ok.status, 200);
  await new Promise((r) => setTimeout(r, 2));
  const stale = await s.call("PUT", `/api/documents/${id}/draft`, { snapshot: second.draft.snapshot, base_updated_at: second.draft.updated_at }, pat.token);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "draft_conflict");
});

test("review: submit, read-only, reject with comment, resubmit, approve as major", async () => {
  const s = await setup();
  const id = await s.newDoc("Process");
  const grant = (principal_id, level) => s.call("PUT", "/api/grants", { target_type: "document", target_id: id, principal_type: "user", principal_id, level });
  const mia = await s.member("Mia", []);
  const pat = await s.member("Pat", []);
  await grant(mia.id, "edit_review");
  await grant(pat.id, "edit_publish");
  const admin = (await s.call("GET", "/api/me")).body.user;

  await s.save(id, (snap) => (snap.steps[0].content_json = paragraph("Proposed change")), mia.token);
  assert.equal((await s.call("POST", `/api/documents/${id}/draft/submit`, { revision_type: "minor", note: "Small fix" }, mia.token)).status, 200);
  assert.deepEqual(await s.types(pat.id), ["review_requested"], "the non-admin with Edit and publish reviews");
  assert.ok(!(await s.types(admin.id)).includes("review_requested"), "admins are not asked when another reviewer exists");

  const locked = await s.save(id, (snap) => (snap.title = "x"), mia.token);
  assert.equal(locked.status, 403, "submitted drafts are read-only");
  assert.equal((await s.call("POST", `/api/documents/${id}/draft/approve`, {}, mia.token)).status, 403, "authors can't approve their own work");

  const view = (await s.open(id, pat.token)).body;
  assert.equal(view.permissions.can_review, true);
  assert.equal(view.published.steps[0].content_json.content[0].content[0].text, "Version one", "the published version is returned for comparison");

  assert.equal((await s.call("POST", `/api/documents/${id}/draft/reject`, { comment: "" }, pat.token)).status, 400, "a comment is required");
  assert.equal((await s.call("POST", `/api/documents/${id}/draft/reject`, { comment: "Please add the deadline." }, pat.token)).status, 200);
  assert.ok((await s.types(mia.id)).includes("draft_rejected"));
  assert.equal((await s.open(id, mia.token)).body.draft.review_comment, "Please add the deadline.");

  assert.equal((await s.save(id, (snap) => (snap.steps[0].content_json = paragraph("Proposed change, due Friday")), mia.token)).status, 200);
  await s.call("POST", `/api/documents/${id}/draft/submit`, { revision_type: "minor" }, mia.token);
  assert.equal((await s.call("POST", `/api/documents/${id}/draft/approve`, { revision_type: "major" }, pat.token)).status, 200);
  assert.ok((await s.types(mia.id)).includes("draft_approved"));

  const doc = await s.t.db.first("SELECT last_major_revision_at FROM documents WHERE id = ?", id);
  assert.ok(doc.last_major_revision_at, "the reviewer chose a major revision");
  assert.equal(await s.t.db.value("SELECT content_text FROM steps WHERE document_id = ?", id), "Proposed change, due Friday");
  assert.equal(await s.t.db.value("SELECT COUNT(*) FROM drafts"), 0, "the draft is gone after publishing");
});

test("with no other reviewer, admins review", async () => {
  const s = await setup();
  const id = await s.newDoc("Doc");
  const mia = await s.member("Mia", []);
  await s.call("PUT", "/api/grants", { target_type: "document", target_id: id, principal_type: "user", principal_id: mia.id, level: "edit_review" });
  const admin = (await s.call("GET", "/api/me")).body.user;
  await s.save(id, (snap) => (snap.title = "Doc v2"), mia.token);
  await s.call("POST", `/api/documents/${id}/draft/submit`, { revision_type: "minor" }, mia.token);
  assert.deepEqual(await s.types(admin.id), ["review_requested"]);
});

test("discarding: the author or Edit and publish only", async () => {
  const s = await setup();
  const id = await s.newDoc("Doc");
  const mia = await s.member("Mia", []);
  const nia = await s.member("Nia", []);
  for (const u of [mia, nia]) await s.call("PUT", "/api/grants", { target_type: "document", target_id: id, principal_type: "user", principal_id: u.id, level: "edit_review" });
  await s.open(id, mia.token);
  assert.equal((await s.call("DELETE", `/api/documents/${id}/draft`, undefined, nia.token)).status, 403);
  assert.equal((await s.call("DELETE", `/api/documents/${id}/draft`, undefined, mia.token)).status, 204);
  await s.open(id, nia.token);
  assert.equal((await s.call("DELETE", `/api/documents/${id}/draft`)).status, 204, "Edit and publish can discard anyone's draft");
});

test("publishing applies added, renamed, reordered and removed steps", async () => {
  const s = await setup();
  const id = await s.newDoc("Doc");
  await s.call("PUT", "/api/grants", { target_type: "category", target_id: s.category.id, principal_type: "department", principal_id: s.dept.Everyone, level: "view" });
  const rita = await s.member("Rita", []);
  const firstStep = (await s.t.db.first("SELECT id FROM steps WHERE document_id = ?", id)).id;
  await s.call("POST", `/api/steps/${firstStep}/complete`, undefined, rita.token);

  await s.save(id, (snap) => {
    snap.steps.push({ title: "Second", content_json: paragraph("Two") }, { title: "Third", content_json: paragraph("Three") });
  });
  await s.call("POST", `/api/documents/${id}/draft/publish`, { revision_type: "minor" });
  await s.save(id, (snap) => {
    snap.steps = [snap.steps[2], { ...snap.steps[1], title: "Second, renamed" }];
  });
  await s.call("POST", `/api/documents/${id}/draft/publish`, { revision_type: "minor" });
  const steps = await s.t.db.all("SELECT title, position FROM steps WHERE document_id = ? ORDER BY position", id);
  assert.deepEqual(steps.map((x) => x.title), ["Third", "Second, renamed"]);
  assert.equal(await s.t.db.value("SELECT COUNT(*) FROM step_completions WHERE step_id = ?", firstStep), 0, "a removed step takes its completions with it");
  assert.equal(await s.t.db.value("SELECT COUNT(*) FROM steps_fts WHERE document_id = ?", id), 2);
});

test("new documents start unpublished with a draft", async () => {
  const s = await setup();
  const id = (await s.call("POST", "/api/documents", { category_id: s.category.id, title: "Fresh" })).body.document.id;
  const doc = (await s.call("GET", `/api/documents/${id}`)).body;
  assert.equal(doc.document.is_published, false);
  assert.equal(doc.draft.status, "editing");
  const tree = (await s.call("GET", "/api/tree?mode=edit")).body;
  assert.equal(tree.spaces[0].categories[0].documents[0].draft_status, "editing");
});

test("editor content is cleaned: unknown nodes, unsafe links and non-https players are dropped", () => {
  const dirty = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
      { type: "script", content: [{ type: "text", text: "alert(1)" }] },
      { type: "video", attrs: { kind: "iframe", src: "http://insecure.example.com/embed" } },
      { type: "video", attrs: { kind: "iframe", src: "https://www.youtube.com/embed/x", title: "Demo" } },
      { type: "figure", attrs: { src: "https://files.example.com/a.png", alt: "Chart", caption: "Q3", width: "huge" } },
      { type: "htmlEmbed", attrs: { html: "<script>alert(document.cookie)</script>" } },
    ],
  };
  const clean = cleanDoc(dirty);
  assert.deepEqual(clean.content.map((n) => n.type), ["paragraph", "video", "figure", "htmlEmbed"]);
  assert.equal(clean.content[0].content[0].marks, undefined, "the unsafe link is removed, the text kept");
  assert.equal(clean.content[2].attrs.width, "full");
  assert.equal(clean.content[3].attrs.html, "<script>alert(document.cookie)</script>", "HTML embeds are kept; they only ever run in a sandboxed iframe");
  assert.equal(docToText(clean), "Click\nDemo\nChart Q3");
});

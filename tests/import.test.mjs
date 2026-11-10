import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toCsv } from "../web/js/lib/csv.js";
import { checkHeader, validateAccessRows, validateStructureRows } from "../web/js/lib/import-rules.js";
import { workspace } from "./helpers.mjs";

// The examples from the brief, as written there.
const STRUCTURE = `space,category,category_emoji,document,document_description,step
The Academy,How OneTake works,📚,Company Information,,Company Information
The Academy,How OneTake works,📚,What our product does,,18 neuro-science secrets for awesome videos
The Academy,How OneTake works,📚,ICP: our Ideal Customer Profile,,
The Academy,How we work together,📚,Team communication (Mattermost),,
The Academy,Going deeper,📚,Stock Option Compensation Guidelines,"How stock options work at OneTake AI, and how they vest",Overview
The Academy,Going deeper,📚,Stock Option Compensation Guidelines,,Vesting schedule
SOP Handbook,Everyone,📚,Hotmart N8N Auth Token Refresh,,
`;

const ACCESS = `department,space,category,document,permission,mandatory
Management,The Academy,How OneTake works,,edit_publish,yes
Marketing,The Academy,How OneTake works,,view,yes
Marketing,The Academy,Going deeper,,view,no
Product,SOP Handbook,Everyone,Hotmart N8N Auth Token Refresh,edit_review,no
`;

function rowsOf(text) {
  return parseCsv(text).rows.map((r) => ({ line: r.line, ...r.values }));
}

test("CSV: BOM, quotes, doubled quotes, commas and line breaks inside fields, CRLF", () => {
  const parsed = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n\r\nlast,,\r\n');
  assert.deepEqual(parsed.header, ["a", "b", "c"]);
  assert.deepEqual(parsed.rows[0].values, { a: "x, y", b: 'say "hi"', c: "two\nlines" });
  assert.equal(parsed.rows[1].line, 5, "line numbers count the line breaks inside quoted fields");
  assert.deepEqual(parsed.rows[1].values, { a: "last", b: "", c: "" });
});

test("CSV: errors give a line number", () => {
  assert.throws(() => parseCsv('a,b\n"open,x\n'), (e) => e.line === 2 && /never closed/.test(e.message));
  assert.throws(() => parseCsv('a,b\nab"c,d\n'), (e) => e.line === 2);
  assert.throws(() => parseCsv(""), /empty/);
});

test("CSV: toCsv round-trips through parseCsv", () => {
  const text = toCsv(["a", "b"], [["x, y", 'q"uote'], ["multi\nline", ""]]);
  assert.deepEqual(parseCsv(text).rows.map((r) => r.values), [{ a: "x, y", b: 'q"uote' }, { a: "multi\nline", b: "" }]);
});

test("validation lists errors with line numbers", () => {
  assert.deepEqual(checkHeader(["space", "category", "document", "steps"], "structure.csv").map((e) => e.message), [
    'Unknown column "steps". The columns are: space, category, category_emoji, document, document_description, step.',
  ]);
  const structure = validateStructureRows(parseCsv("space,category,document\nA,,Doc\nA,B,C\n").rows);
  assert.deepEqual(structure.errors, [{ file: "structure.csv", line: 2, message: 'The "category" column is empty; it is required.' }]);
  const access = validateAccessRows(
    parseCsv("department,space,category,document,permission,mandatory\nM,A,B,,none,no\nM,A,B,,read,yes\nM,A,B,,view,maybe\n").rows,
  );
  assert.deepEqual(access.errors.map((e) => e.line), [2, 3, 4]);
  assert.match(access.errors[0].message, /none can only be used on a document row/);
});

test("importing the brief's example creates everything unpublished, and a second import creates nothing", async () => {
  const { t, admin } = await workspace();
  const send = (dry_run) => t.call("POST", "/api/import", { token: admin, body: { structure: rowsOf(STRUCTURE), access: rowsOf(ACCESS), dry_run } });

  const preview = await send(true);
  assert.equal(preview.status, 200, JSON.stringify(preview.body.errors));
  assert.deepEqual(preview.body.counts.spaces, { created: 2, existing: 0 });
  assert.deepEqual(preview.body.counts.documents, { created: 6, existing: 0 });
  assert.equal(await t.db.value("SELECT COUNT(*) FROM documents"), 0, "a dry run changes nothing");

  const first = await send(false);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.counts.categories, { created: 4, existing: 0 });
  assert.deepEqual(first.body.counts.steps, { created: 7, existing: 0 });
  assert.deepEqual(first.body.counts.grants, { created: 4, updated: 0, unchanged: 0 });

  // Order follows the rows, documents are unpublished, steps as described.
  const docs = await t.db.all("SELECT id, title, description, is_published FROM documents ORDER BY id");
  assert.deepEqual(docs.map((d) => d.title), [
    "Company Information",
    "What our product does",
    "ICP: our Ideal Customer Profile",
    "Team communication (Mattermost)",
    "Stock Option Compensation Guidelines",
    "Hotmart N8N Auth Token Refresh",
  ]);
  assert.ok(docs.every((d) => d.is_published === 0));
  assert.equal(docs[4].description, "How stock options work at OneTake AI, and how they vest");
  const stepTitles = async (id) => (await t.db.all("SELECT title FROM steps WHERE document_id = ? ORDER BY position", id)).map((s) => s.title);
  assert.deepEqual(await stepTitles(docs[2].id), ["ICP: our Ideal Customer Profile"], "an empty step gives one step named after the document");
  assert.deepEqual(await stepTitles(docs[4].id), ["Overview", "Vesting schedule"]);
  const categories = await t.db.all("SELECT name, emoji FROM categories ORDER BY id");
  assert.equal(categories[0].emoji, "📚");
  const hotmart = await t.db.first("SELECT level FROM grants WHERE target_type = 'document'");
  assert.equal(hotmart.level, "edit_review");

  const second = await send(false);
  assert.equal(second.status, 200);
  for (const kind of ["spaces", "categories", "documents", "steps"]) assert.equal(second.body.counts[kind].created, 0, kind);
  assert.deepEqual(second.body.counts.steps, { created: 0, existing: 7 });
  assert.equal(second.body.counts.departments.created, 0);
  assert.deepEqual(second.body.counts.grants, { created: 0, updated: 0, unchanged: 4 });
  assert.equal(await t.db.value("SELECT COUNT(*) FROM documents"), 6);
  assert.equal(await t.db.value("SELECT COUNT(*) FROM steps"), 7);
});

test("the import is additive: new rows are added, existing grants are updated, nothing is deleted", async () => {
  const { t, admin } = await workspace();
  const send = (structure, access) => t.call("POST", "/api/import", { token: admin, body: { structure: rowsOf(structure), access: rowsOf(access), dry_run: false } });
  await send(STRUCTURE, ACCESS);

  const more = `space,category,document,step
The Academy,Going deeper,Stock Option Compensation Guidelines,Exercising options
The Academy,Going deeper,Remote work policy,
`;
  const changed = `department,space,category,document,permission,mandatory
Marketing,The Academy,Going deeper,,view,yes
Customer Success,The Academy,Going deeper,Remote work policy,view,no
`;
  const res = await send(more, changed);
  assert.equal(res.status, 200, JSON.stringify(res.body.errors));
  assert.deepEqual(res.body.counts.documents, { created: 1, existing: 1 });
  assert.deepEqual(res.body.counts.steps, { created: 2, existing: 0 });
  assert.deepEqual(res.body.counts.grants, { created: 1, updated: 1, unchanged: 0 });
  assert.deepEqual(res.body.counts.departments, { created: 1, existing: 1 });
  assert.equal(await t.db.value("SELECT COUNT(*) FROM documents"), 7, "nothing deleted");
  assert.equal(await t.db.value("SELECT COUNT(*) FROM grants"), 5);
  const marketing = await t.db.first("SELECT g.mandatory FROM grants g JOIN departments d ON d.id = g.principal_id JOIN categories c ON c.id = g.target_id WHERE d.name = 'Marketing' AND c.name = 'Going deeper'");
  assert.equal(marketing.mandatory, 1);
});

test("import errors: unknown targets, duplicate rows and department name clashes stop everything", async () => {
  const { t, admin } = await workspace();
  const access = `department,space,category,document,permission,mandatory
Marketing,The Academy,How OneTake works,Missing document,view,no
Marketing,The Academy,No such category,,view,no
marketing,The Academy,How OneTake works,,view,no
Product,The Academy,How OneTake works,,view,no
Product,The Academy,How OneTake works,,edit_review,no
`;
  const res = await t.call("POST", "/api/import", { token: admin, body: { structure: rowsOf(STRUCTURE), access: rowsOf(access), dry_run: false } });
  assert.equal(res.status, 422);
  assert.deepEqual(res.body.errors.map((e) => e.line), [2, 3, 4, 6]);
  assert.match(res.body.errors[2].message, /already exists/);
  assert.equal(await t.db.value("SELECT COUNT(*) FROM documents"), 0, "nothing applied");
});

test("only admins can import", async () => {
  const { t, dept, member } = await workspace();
  const lea = await member("Lea", [{ id: dept.Marketing, is_leader: true }]);
  const res = await t.call("POST", "/api/import", { token: lea.token, body: { structure: rowsOf(STRUCTURE), dry_run: true } });
  assert.equal(res.status, 403);
});

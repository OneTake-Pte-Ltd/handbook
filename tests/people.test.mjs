import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, setupAdmin, workspace } from "./helpers.mjs";

test("admin creates a member with a temporary password that must be changed", async () => {
  const { t, admin, dept, create, login } = await workspace();
  const res = await create(admin, {
    first_name: "Gloria",
    last_name: "Social",
    email: "gloria@example.com",
    role_title: "Head of Marketing",
    departments: [{ id: dept.Marketing, is_leader: true }],
  });
  assert.equal(res.status, 201);
  assert.match(res.body.temporary_password, /^[\w]{4}-[\w]{4}-[\w]{4}-[\w]{4}$/);
  assert.equal(res.body.user.departments[0].is_leader, true);

  const token = await login("gloria@example.com", res.body.temporary_password);
  const me = await t.call("GET", "/api/me", { token });
  assert.equal(me.body.user.must_change_password, true);
  assert.equal((await t.call("GET", "/api/departments", { token })).status, 403, "blocked until the password is changed");
});

test("a team leader creates a member in their department only", async () => {
  const { t, dept, create, member } = await workspace();
  const leader = await member("Lea", [{ id: dept.Marketing, is_leader: true }]);

  const ok = await create(leader.token, { first_name: "Nina", last_name: "New", email: "nina@example.com", departments: [dept.Marketing] });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.user.departments.map((d) => d.name), ["Marketing"]);

  const other = await create(leader.token, { first_name: "Oscar", last_name: "Other", email: "oscar@example.com", departments: [dept.Product] });
  assert.equal(other.status, 403);
  const leaderFlag = await create(leader.token, {
    first_name: "Paul",
    last_name: "P",
    email: "paul@example.com",
    departments: [{ id: dept.Marketing, is_leader: true }],
  });
  assert.equal(leaderFlag.status, 403);
  const adminFlag = await create(leader.token, { first_name: "Quinn", last_name: "Q", email: "quinn@example.com", departments: [dept.Marketing], is_admin: true });
  assert.equal(adminFlag.status, 403);

  // The leader sees their department's members only.
  const list = await t.call("GET", "/api/users", { token: leader.token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.users.map((u) => u.first_name).sort(), ["Lea", "Nina"]);
});

test("a leader adding an existing email adds that person to the department", async () => {
  const { t, admin, dept, create, member } = await workspace();
  const leader = await member("Lea", [{ id: dept.Marketing, is_leader: true }]);
  const product = await member("Pat", [dept.Product]);

  const res = await create(leader.token, { first_name: "Ignored", last_name: "Ignored", email: product.email, departments: [dept.Marketing] });
  assert.equal(res.status, 200);
  assert.equal(res.body.existing, true);
  assert.equal(res.body.temporary_password, undefined, "no password for existing accounts");
  assert.deepEqual(res.body.user.departments.map((d) => d.name).sort(), ["Marketing", "Product"]);
  assert.equal(res.body.user.first_name, "Pat", "existing names are not changed");

  const notifications = await t.db.all("SELECT type FROM notifications WHERE user_id = ?", product.id);
  assert.deepEqual(notifications.map((n) => n.type), ["department_added"]);

  // A deactivated account can only be reactivated by an admin.
  await t.call("PATCH", `/api/users/${product.id}`, { token: admin, body: { is_active: false } });
  const blocked = await create(leader.token, { first_name: "x", last_name: "y", email: product.email, departments: [dept.Marketing] });
  assert.equal(blocked.status, 409);
});

test("a team leader cannot change anything in a department they do not lead", async () => {
  const { t, dept, member } = await workspace();
  const leader = await member("Lea", [{ id: dept.Marketing, is_leader: true }]);
  const outsider = await member("Olive", [dept.Product]);

  assert.equal((await t.call("GET", `/api/users/${outsider.id}`, { token: leader.token })).status, 403);
  assert.equal((await t.call("POST", `/api/users/${outsider.id}/reset-password`, { token: leader.token })).status, 403);
  assert.equal((await t.call("PATCH", `/api/users/${outsider.id}`, { token: leader.token, body: { role_title: "x" } })).status, 403);
  assert.equal((await t.call("PUT", `/api/departments/${dept.Product}/members/${leader.id}`, { token: leader.token, body: {} })).status, 403);
  assert.equal((await t.call("DELETE", `/api/departments/${dept.Product}/members/${outsider.id}`, { token: leader.token })).status, 403);
  assert.equal((await t.call("GET", `/api/departments/${dept.Product}`, { token: leader.token })).status, 403);
  assert.equal((await t.call("PATCH", `/api/departments/${dept.Marketing}`, { token: leader.token, body: { name: "Growth" } })).status, 403);
  assert.equal((await t.call("POST", "/api/departments", { token: leader.token, body: { name: "New" } })).status, 403);
});

test("leaders reset passwords and edit details of their members, but never of admins", async () => {
  const { t, dept, member } = await workspace();
  const leader = await member("Lea", [{ id: dept.Marketing, is_leader: true }]);
  const mia = await member("Mia", [dept.Marketing]);
  const boss = await member("Boss", [dept.Marketing], { is_admin: true });

  const reset = await t.call("POST", `/api/users/${mia.id}/reset-password`, { token: leader.token });
  assert.equal(reset.status, 200);
  assert.ok(reset.body.temporary_password);
  assert.equal((await t.call("GET", "/api/me", { token: mia.token })).status, 401, "old sessions end");
  const row = await t.db.first("SELECT must_change_password FROM users WHERE id = ?", mia.id);
  assert.equal(row.must_change_password, 1);

  const edit = await t.call("PATCH", `/api/users/${mia.id}`, { token: leader.token, body: { role_title: "Designer", first_name: "Mia-Rose" } });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.user.role_title, "Designer");
  assert.equal((await t.call("PATCH", `/api/users/${mia.id}`, { token: leader.token, body: { email: "x@example.com" } })).status, 403);

  assert.equal((await t.call("POST", `/api/users/${boss.id}/reset-password`, { token: leader.token })).status, 403);
  assert.equal((await t.call("PATCH", `/api/users/${boss.id}`, { token: leader.token, body: { first_name: "B" } })).status, 403);
});

test("leaders add and remove members but only admins choose leaders", async () => {
  const { t, admin, dept, member } = await workspace();
  const leader = await member("Lea", [{ id: dept.Marketing, is_leader: true }]);
  const pat = await member("Pat", [dept.Product]);

  assert.equal((await t.call("PUT", `/api/departments/${dept.Marketing}/members/${pat.id}`, { token: leader.token, body: { is_leader: true } })).status, 403);
  const add = await t.call("PUT", `/api/departments/${dept.Marketing}/members/${pat.id}`, { token: leader.token, body: {} });
  assert.equal(add.status, 200);
  assert.equal(add.body.added, true);
  assert.equal((await t.call("DELETE", `/api/departments/${dept.Marketing}/members/${pat.id}`, { token: leader.token })).status, 204);

  // Admin makes Pat a leader of Product: Pat is notified.
  const promote = await t.call("PUT", `/api/departments/${dept.Product}/members/${pat.id}`, { token: admin, body: { is_leader: true } });
  assert.equal(promote.status, 200);
  const types = (await t.db.all("SELECT type FROM notifications WHERE user_id = ? ORDER BY id", pat.id)).map((n) => n.type);
  assert.ok(types.includes("made_leader"));

  // A leader cannot remove another leader.
  await t.call("PUT", `/api/departments/${dept.Marketing}/members/${pat.id}`, { token: admin, body: { is_leader: true } });
  assert.equal((await t.call("DELETE", `/api/departments/${dept.Marketing}/members/${pat.id}`, { token: leader.token })).status, 403);
});

test("admins keep at least one active admin and cannot demote or deactivate themselves", async () => {
  const { t, admin, member } = await workspace();
  const me = (await t.call("GET", "/api/me", { token: admin })).body.user;
  assert.equal((await t.call("PATCH", `/api/users/${me.id}`, { token: admin, body: { is_active: false } })).status, 403);
  assert.equal((await t.call("PATCH", `/api/users/${me.id}`, { token: admin, body: { is_admin: false } })).status, 403);

  const second = await member("Second", [], { is_admin: true });
  // The second admin can demote the first, but then not themselves.
  assert.equal((await t.call("PATCH", `/api/users/${me.id}`, { token: second.token, body: { is_admin: false } })).status, 200);
  assert.equal((await t.call("PATCH", `/api/users/${second.id}`, { token: second.token, body: { is_admin: false } })).status, 403);
});

test("deactivating a member ends their sessions; reactivating lets them back in", async () => {
  const { t, admin, member, login } = await workspace();
  const sam = await member("Sam", []);
  assert.equal((await t.call("PATCH", `/api/users/${sam.id}`, { token: admin, body: { is_active: false } })).status, 200);
  assert.equal((await t.call("GET", "/api/me", { token: sam.token })).status, 401);
  assert.equal((await t.call("PATCH", `/api/users/${sam.id}`, { token: admin, body: { is_active: true } })).status, 200);
  await login(sam.email, "member password 1");
});

test("members edit their own names and photo, but not their role title", async () => {
  const { t, member } = await workspace();
  const sam = await member("Sam", []);
  const ok = await t.call("PATCH", `/api/users/${sam.id}`, {
    token: sam.token,
    body: { first_name: "Samuel", last_name: "Smith", avatar_url: "https://files.example.com/a.jpg" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.first_name, "Samuel");
  assert.equal(ok.body.user.avatar_url, "https://files.example.com/a.jpg");
  assert.equal((await t.call("PATCH", `/api/users/${sam.id}`, { token: sam.token, body: { role_title: "CEO" } })).status, 403);
  assert.equal((await t.call("PATCH", `/api/users/${sam.id}`, { token: sam.token, body: { avatar_url: "http://insecure.example.com/a.jpg" } })).status, 400);
  assert.equal((await t.call("GET", "/api/users", { token: sam.token })).status, 403, "plain members don't see the list");
});

test("departments: create, rename, delete; Everyone is protected and counts every active member", async () => {
  const { t, admin, dept, member } = await workspace();
  await member("Ann", [dept.Product]);
  const created = await t.call("POST", "/api/departments", { token: admin, body: { name: "Customer Success" } });
  assert.equal(created.status, 201);
  assert.equal((await t.call("POST", "/api/departments", { token: admin, body: { name: "customer success" } })).status, 409);
  const id = created.body.department.id;
  assert.equal((await t.call("PATCH", `/api/departments/${id}`, { token: admin, body: { name: "Support" } })).status, 200);
  assert.equal((await t.call("DELETE", `/api/departments/${id}`, { token: admin })).status, 204);

  assert.equal((await t.call("PATCH", `/api/departments/${dept.Everyone}`, { token: admin, body: { name: "All" } })).status, 403);
  assert.equal((await t.call("DELETE", `/api/departments/${dept.Everyone}`, { token: admin })).status, 403);
  const list = (await t.call("GET", "/api/departments", { token: admin })).body.departments;
  assert.equal(list.find((d) => d.name === "Everyone").member_count, 2);
  assert.equal(list.find((d) => d.name === "Product").member_count, 1);
});

test("deleting a department removes its memberships and its grants", async () => {
  const { t, admin, dept, member } = await workspace();
  const ann = await member("Ann", [dept.Product]);
  await t.db.run("INSERT INTO spaces (name) VALUES ('S')");
  await t.db.run("INSERT INTO categories (space_id, name) VALUES (1, 'C')");
  await t.db.run(
    "INSERT INTO grants (target_type, target_id, principal_type, principal_id, level, mandatory, created_at) VALUES ('category', 1, 'department', ?, 'view', 0, 'now')",
    dept.Product,
  );
  assert.equal((await t.call("DELETE", `/api/departments/${dept.Product}`, { token: admin })).status, 204);
  assert.equal(await t.db.value("SELECT COUNT(*) FROM department_members WHERE user_id = ?", ann.id), 0);
  assert.equal(await t.db.value("SELECT COUNT(*) FROM grants"), 0);
  assert.equal(await t.db.value("SELECT COUNT(*) FROM users WHERE id = ?", ann.id), 1, "the account stays");
});

test("uploads: images are checked from their bytes and stored under uploads/", async () => {
  const stored = [];
  const t = createTestApp({
    STORAGE_ZONE: "zone",
    STORAGE_KEY: "key",
    STORAGE_REGION_HOST: "sg.storage.bunnycdn.com",
    PUBLIC_FILES_URL: "https://files.example.com",
  });
  const admin = await setupAdmin(t);
  // Swap the storage fetch for a fake one.
  const { createApp } = await import("../edge/src/app.js");
  const app = createApp({
    db: t.db,
    env: t.env,
    fetchImpl: async (url, init) => {
      stored.push({ url, init });
      return new Response(null, { status: 201 });
    },
  });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const upload = (body, name = "My Photo.png") =>
    app.handle(
      new Request("https://edge.example.com/api/files?kind=image", {
        method: "POST",
        headers: { Authorization: `Bearer ${admin}`, "Content-Type": "image/png", "X-File-Name": encodeURIComponent(name), Origin: "https://academy.example.com" },
        body,
      }),
    );
  const ok = await upload(png);
  assert.equal(ok.status, 201);
  const result = await ok.json();
  assert.match(result.url, /^https:\/\/files\.example\.com\/uploads\/\d{4}\/\d{2}\/[0-9a-f-]{36}-My-Photo\.png$/);
  assert.match(stored[0].url, /^https:\/\/sg\.storage\.bunnycdn\.com\/zone\/uploads\//);
  assert.equal(stored[0].init.headers.AccessKey, "key");
  assert.equal(await t.db.value("SELECT COUNT(*) FROM files"), 1);

  const fake = await upload(new TextEncoder().encode("<svg onload=alert(1)>"), "x.svg");
  assert.equal(fake.status, 400);
});

test("uploads explain when storage is not configured", async () => {
  const t = createTestApp();
  const admin = await setupAdmin(t);
  const res = await t.app.handle(
    new Request("https://edge.example.com/api/files?kind=image", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, Origin: "https://academy.example.com" },
      body: new Uint8Array([0xff, 0xd8, 0xff, 0]),
    }),
  );
  assert.equal(res.status, 503);
});

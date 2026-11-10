import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, ORIGIN, SETUP_CODE, createTestApp, setupAdmin } from "./helpers.mjs";
import { lockedUntil } from "../edge/src/lib/auth.js";
import { LATEST_VERSION, migrate } from "../edge/src/lib/migrations.js";
import { temporaryPassword } from "../edge/src/lib/crypto.js";

test("migrations create the schema, the FTS table and the five departments, and are idempotent", async () => {
  const t = createTestApp();
  assert.equal(await migrate(t.db), LATEST_VERSION);
  assert.equal(await migrate(t.db), LATEST_VERSION);
  const departments = await t.db.all("SELECT name, is_system FROM departments ORDER BY position");
  assert.deepEqual(
    departments.map((d) => d.name),
    ["Everyone", "Management", "Product", "Marketing", "Admin"],
  );
  assert.equal(departments[0].is_system, 1);
  const fts = await t.db.first("SELECT name FROM sqlite_master WHERE name = 'steps_fts'");
  assert.ok(fts);
});

test("info reports that setup is needed on an empty workspace", async () => {
  const t = createTestApp();
  const res = await t.call("GET", "/api/info");
  assert.equal(res.status, 200);
  assert.equal(res.body.needs_setup, true);
  assert.equal(res.body.name, "Handbook");
});

test("setup requires the setup code and only works once", async () => {
  const t = createTestApp();
  const wrong = await t.call("POST", "/api/setup", { body: { ...ADMIN, setup_code: "nope" } });
  assert.equal(wrong.status, 403);

  const short = await t.call("POST", "/api/setup", { body: { ...ADMIN, password: "short", setup_code: SETUP_CODE } });
  assert.equal(short.status, 400);

  const token = await setupAdmin(t);
  assert.ok(token);
  const info = await t.call("GET", "/api/info");
  assert.equal(info.body.needs_setup, false);
  assert.equal(info.body.name, "Test Co");

  const again = await t.call("POST", "/api/setup", { body: { ...ADMIN, email: "other@example.com", setup_code: SETUP_CODE } });
  assert.equal(again.status, 409);
});

test("setup is refused when SETUP_CODE is not configured", async () => {
  const t = createTestApp({ SETUP_CODE: "" });
  const res = await t.call("POST", "/api/setup", { body: { ...ADMIN, setup_code: "" } });
  assert.equal(res.status, 503);
});

test("login, me and logout", async () => {
  const t = createTestApp();
  await setupAdmin(t);

  const bad = await t.call("POST", "/api/login", { body: { email: ADMIN.email, password: "wrong password!" } });
  assert.equal(bad.status, 401);
  const unknown = await t.call("POST", "/api/login", { body: { email: "nobody@example.com", password: "whatever123" } });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, bad.body.error, "unknown emails and wrong passwords look the same");

  const ok = await t.call("POST", "/api/login", { body: { email: "ADA@example.com", password: ADMIN.password } });
  assert.equal(ok.status, 200);
  const token = ok.body.token;

  const me = await t.call("GET", "/api/me", { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, ADMIN.email);
  assert.equal(me.body.user.is_admin, true);
  assert.equal(me.body.departments[0].name, "Everyone");

  // Only the hash of the token is stored.
  const stored = await t.db.all("SELECT token_hash FROM sessions");
  assert.ok(stored.every((s) => s.token_hash !== token && s.token_hash.length === 64));

  assert.equal((await t.call("POST", "/api/logout", { token })).status, 204);
  assert.equal((await t.call("GET", "/api/me", { token })).status, 401);
});

test("requests without a valid session are refused", async () => {
  const t = createTestApp();
  await setupAdmin(t);
  assert.equal((await t.call("GET", "/api/me")).status, 401);
  assert.equal((await t.call("GET", "/api/me", { token: "x".repeat(43) })).status, 401);
});

test("expired sessions are refused and deleted", async () => {
  const t = createTestApp();
  const token = await setupAdmin(t);
  await t.db.run("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
  assert.equal((await t.call("GET", "/api/me", { token })).status, 401);
  assert.equal(await t.db.value("SELECT COUNT(*) FROM sessions"), 0);
});

test("five failed logins within 15 minutes lock the email", async () => {
  const t = createTestApp();
  await setupAdmin(t);
  for (let i = 0; i < 5; i++) {
    const res = await t.call("POST", "/api/login", { body: { email: ADMIN.email, password: "wrong password!" } });
    assert.equal(res.status, 401);
  }
  const locked = await t.call("POST", "/api/login", { body: { email: ADMIN.email, password: ADMIN.password } });
  assert.equal(locked.status, 429);
  assert.match(locked.body.error, /Too many failed attempts/);
});

test("the lock lasts 15 minutes from the fifth failure", async () => {
  const t = createTestApp();
  await t.call("GET", "/api/info"); // runs migrations
  const base = Date.parse("2026-01-01T10:00:00.000Z");
  for (const minutes of [0, 2, 4, 6, 8]) {
    await t.db.run(
      "INSERT INTO login_attempts (email, attempted_at, succeeded) VALUES ('a@example.com', ?, 0)",
      new Date(base + minutes * 60000).toISOString(),
    );
  }
  const fifth = base + 8 * 60000;
  assert.equal(await lockedUntil(t.db, "a@example.com", fifth + 60000), fifth + 15 * 60000);
  assert.equal(await lockedUntil(t.db, "a@example.com", fifth + 15 * 60000 + 1), 0);
  // Failures spread over more than 15 minutes do not lock.
  await t.db.run("DELETE FROM login_attempts");
  for (const minutes of [0, 5, 10, 15, 20]) {
    await t.db.run(
      "INSERT INTO login_attempts (email, attempted_at, succeeded) VALUES ('a@example.com', ?, 0)",
      new Date(base + minutes * 60000).toISOString(),
    );
  }
  assert.equal(await lockedUntil(t.db, "a@example.com", base + 21 * 60000), 0);
});

test("deactivated users cannot log in and lose their sessions", async () => {
  const t = createTestApp();
  const token = await setupAdmin(t);
  await t.db.run("UPDATE users SET is_active = 0");
  assert.equal((await t.call("GET", "/api/me", { token })).status, 401);
  const login = await t.call("POST", "/api/login", { body: { email: ADMIN.email, password: ADMIN.password } });
  assert.equal(login.status, 403);
});

test("changing the password closes the other sessions", async () => {
  const t = createTestApp();
  const first = await setupAdmin(t);
  const second = (await t.call("POST", "/api/login", { body: { email: ADMIN.email, password: ADMIN.password } })).body.token;

  const wrong = await t.call("POST", "/api/password", {
    token: first,
    body: { current_password: "not it at all", new_password: "a brand new password" },
  });
  assert.equal(wrong.status, 400);

  const ok = await t.call("POST", "/api/password", {
    token: first,
    body: { current_password: ADMIN.password, new_password: "a brand new password" },
  });
  assert.equal(ok.status, 200);
  assert.equal((await t.call("GET", "/api/me", { token: first })).status, 200);
  assert.equal((await t.call("GET", "/api/me", { token: second })).status, 401);
});

test("a member who must change their password can only reach the password routes", async () => {
  const t = createTestApp();
  const token = await setupAdmin(t);
  await t.db.run("UPDATE users SET must_change_password = 1");
  assert.equal((await t.call("GET", "/api/me", { token })).status, 200);
  const blocked = await t.call("GET", "/api/settings", { token });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "must_change_password");
});

test("CORS: allowed origins get headers, other origins are refused", async () => {
  const t = createTestApp();
  const allowed = await t.call("OPTIONS", "/api/login", { origin: ORIGIN });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(allowed.headers.get("Access-Control-Allow-Headers"), /Authorization/);

  const local = await t.call("GET", "/api/info", { origin: "http://localhost:8080" });
  assert.equal(local.headers.get("Access-Control-Allow-Origin"), "http://localhost:8080");

  const evil = await t.call("GET", "/api/info", { origin: "https://evil.example.com" });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("Access-Control-Allow-Origin"), null);

  assert.equal(allowed.headers.get("Cache-Control"), "no-store");
});

test("settings are admin-only and never return the API key", async () => {
  const t = createTestApp();
  const token = await setupAdmin(t);
  const patch = await t.call("PATCH", "/api/settings", {
    token,
    body: { workspace_name: "OneTake AI", anthropic_api_key: "sk-ant-secret-abcd", logo_url: "https://example.com/logo.png" },
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.anthropic_key_hint, "abcd");
  assert.equal(JSON.stringify(patch.body).includes("sk-ant-secret"), false);

  const badUrl = await t.call("PATCH", "/api/settings", { token, body: { logo_url: "http://example.com/x.png" } });
  assert.equal(badUrl.status, 400);

  // A non-admin is refused.
  await t.db.run("UPDATE users SET is_admin = 0");
  assert.equal((await t.call("GET", "/api/settings", { token })).status, 403);
});

test("temporary passwords are 16 unambiguous characters in groups of four", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const p = temporaryPassword();
    assert.match(p, /^[a-zA-Z2-9]{4}-[a-zA-Z2-9]{4}-[a-zA-Z2-9]{4}-[a-zA-Z2-9]{4}$/);
    assert.doesNotMatch(p, /[01ilIoO]/);
    seen.add(p);
  }
  assert.equal(seen.size, 50);
});

test("unknown routes return 404 and wrong methods 405", async () => {
  const t = createTestApp();
  assert.equal((await t.call("GET", "/api/nothing")).status, 404);
  assert.equal((await t.call("DELETE", "/api/info")).status, 405);
});

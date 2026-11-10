// Test helpers: an in-memory SQLite database and a small API client.

import assert from "node:assert/strict";
import { createApp } from "../edge/src/app.js";
import { createSqliteDb } from "../dev/sqlite-db.mjs";

export function createTestDb() {
  return createSqliteDb(":memory:");
}

export const ORIGIN = "https://academy.example.com";
export const SETUP_CODE = "test-setup-code-123";

export function createTestApp(envOverrides = {}) {
  const db = createTestDb();
  const env = { ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:8080`, SETUP_CODE, ...envOverrides };
  const app = createApp({ db, env });

  async function call(method, path, { body, token, origin = ORIGIN, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (origin) init.headers.Origin = origin;
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await app.handle(new Request(`https://edge.example.com${path}`, init));
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }

  return { db, env, app, call };
}

export const ADMIN = {
  first_name: "Ada",
  last_name: "Admin",
  email: "ada@example.com",
  password: "correct horse battery",
};

// Creates the first admin and returns its session token.
export async function setupAdmin(t) {
  const res = await t.call("POST", "/api/setup", { body: { ...ADMIN, setup_code: SETUP_CODE, workspace_name: "Test Co" } });
  if (res.status !== 201) throw new Error(`setup failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

// Sets up a workspace with an admin, and returns helpers to create members
// and log in as them (temporary password, then a chosen password).
export async function workspace() {
  const t = createTestApp();
  const admin = await setupAdmin(t);
  const departments = (await t.call("GET", "/api/departments", { token: admin })).body.departments;
  const dept = Object.fromEntries(departments.map((d) => [d.name, d.id]));

  async function create(token, body) {
    return t.call("POST", "/api/users", { token, body });
  }
  async function login(email, password) {
    const res = await t.call("POST", "/api/login", { body: { email, password } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.token;
  }
  // Creates a member as admin, sets a real password, returns { id, token }.
  async function member(first, departments, extra = {}) {
    const email = `${first.toLowerCase()}@example.com`;
    const res = await create(admin, { first_name: first, last_name: "Test", email, departments, ...extra });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const token = await login(email, res.body.temporary_password);
    const changed = await t.call("POST", "/api/password", {
      token,
      body: { current_password: res.body.temporary_password, new_password: "member password 1" },
    });
    assert.equal(changed.status, 200);
    return { id: res.body.user.id, email, token };
  }
  return { t, admin, dept, create, login, member };
}


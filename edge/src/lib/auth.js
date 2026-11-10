// Sessions, login throttling and the account endpoints:
// GET /info, POST /setup, POST /login, POST /logout, POST /password, GET /me.

import { nowIso } from "./db.js";
import {
  HttpError,
  badRequest,
  forbidden,
  json,
  noContent,
  normalizeEmail,
  optionalString,
  readJson,
  requireString,
  unauthorized,
} from "./http.js";
import {
  PBKDF2_ITERATIONS,
  checkPasswordStrength,
  hashPassword,
  newSessionToken,
  pbkdf2Hex,
  sha256Hex,
  timingSafeEqual,
  verifyPassword,
} from "./crypto.js";
import { getSettings, setSettings } from "./settings.js";
import { LATEST_VERSION } from "./migrations.js";
import { accessFor } from "./permissions.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_DAYS = 30;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX_FAILURES = 5;
// Used to spend the same time on unknown emails as on real ones.
const DUMMY_SALT = "00112233445566778899aabbccddeeff";
// login_attempts key for setup code attempts, which share the same throttle.
const SETUP_THROTTLE_KEY = "setup-code";

const INVALID_LOGIN = "Email or password is incorrect.";

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    role_title: user.role_title,
    avatar_url: user.avatar_url || "",
    is_admin: Boolean(user.is_admin),
    is_active: Boolean(user.is_active),
    must_change_password: Boolean(user.must_change_password),
  };
}

// Session tokens: the client keeps the token, the database only its hash.
export async function createSession(db, userId) {
  const token = newSessionToken();
  const now = new Date();
  await db.run(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    await sha256Hex(token),
    userId,
    now.toISOString(),
    new Date(now.getTime() + SESSION_DAYS * DAY_MS).toISOString(),
  );
  return token;
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+([A-Za-z0-9_\-]{20,100})$/.exec(header.trim());
  return match ? match[1] : null;
}

// Returns the logged-in user for a request, or throws 401.
export async function authenticate(db, request) {
  const token = bearerToken(request);
  if (!token) throw unauthorized();
  const tokenHash = await sha256Hex(token);
  const row = await db.first(
    `SELECT s.expires_at AS session_expires_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    tokenHash,
  );
  const now = Date.now();
  if (!row || Date.parse(row.session_expires_at) <= now || !row.is_active) {
    if (row) await db.run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
    throw unauthorized("Your session has ended. Please log in again.");
  }
  // Sliding expiry, written at most once a day to keep requests cheap.
  const fresh = new Date(now + SESSION_DAYS * DAY_MS);
  if (fresh.getTime() - Date.parse(row.session_expires_at) > DAY_MS) {
    await db.run("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", fresh.toISOString(), tokenHash);
  }
  const { session_expires_at, ...user } = row;
  user.token_hash = tokenHash;
  return user;
}

// Throttling: 5 failures within 15 minutes lock the email for 15 minutes
// from the fifth failure. A successful login resets the count.
export async function lockedUntil(db, key, now = Date.now()) {
  const since = new Date(now - 2 * THROTTLE_WINDOW_MS).toISOString();
  const lastSuccess = await db.value(
    "SELECT MAX(attempted_at) FROM login_attempts WHERE email = ? AND succeeded = 1 AND attempted_at >= ?",
    key,
    since,
  );
  const failures = await db.all(
    `SELECT attempted_at FROM login_attempts
      WHERE email = ? AND succeeded = 0 AND attempted_at >= ?
      ORDER BY attempted_at`,
    key,
    lastSuccess && lastSuccess > since ? lastSuccess : since,
  );
  const times = failures.map((f) => Date.parse(f.attempted_at));
  let until = 0;
  for (let i = THROTTLE_MAX_FAILURES - 1; i < times.length; i++) {
    if (times[i] - times[i - THROTTLE_MAX_FAILURES + 1] <= THROTTLE_WINDOW_MS) {
      until = Math.max(until, times[i] + THROTTLE_WINDOW_MS);
    }
  }
  return until > now ? until : 0;
}

async function recordAttempt(db, key, succeeded) {
  await db.run(
    "INSERT INTO login_attempts (email, attempted_at, succeeded) VALUES (?, ?, ?)",
    key,
    nowIso(),
    succeeded ? 1 : 0,
  );
}

function tooManyAttempts(until) {
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  return new HttpError(
    429,
    `Too many failed attempts. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`,
  );
}

async function userCount(db) {
  return Number(await db.value("SELECT COUNT(*) FROM users"));
}

// GET /api/info: public, used by the login screen.
export async function handleInfo({ db }) {
  const settings = await getSettings(db);
  return json({
    name: settings.workspace_name,
    logo_url: settings.logo_url,
    needs_setup: (await userCount(db)) === 0,
    schema_version: LATEST_VERSION,
  });
}

// POST /api/setup: creates the first admin, once, with the SETUP_CODE secret.
export async function handleSetup({ db, env, request }) {
  const body = await readJson(request);
  const setupCode = String(env.SETUP_CODE || "");
  if (!setupCode) {
    throw new HttpError(503, "This workspace has no setup code yet. Add the SETUP_CODE secret to the edge script.");
  }
  if ((await userCount(db)) > 0) throw new HttpError(409, "This workspace already has an admin. Please log in.");

  const until = await lockedUntil(db, SETUP_THROTTLE_KEY);
  if (until) throw tooManyAttempts(until);
  if (!timingSafeEqual(String(body.setup_code || ""), setupCode)) {
    await recordAttempt(db, SETUP_THROTTLE_KEY, false);
    throw forbidden("The setup code is incorrect.");
  }

  const firstName = requireString(body, "first_name", "First name", { max: 100 });
  const lastName = requireString(body, "last_name", "Last name", { max: 100 });
  const email = normalizeEmail(body.email);
  const weakness = checkPasswordStrength(body.password);
  if (weakness) throw badRequest(weakness);
  const workspaceName = optionalString(body, "workspace_name", "Workspace name", { max: 80 });

  const { hash, salt, iterations } = await hashPassword(body.password);
  const now = nowIso();
  // The WHERE NOT EXISTS makes this safe if two setups arrive at once.
  const result = await db.run(
    `INSERT INTO users (email, first_name, last_name, role_title, password_hash, password_salt,
                        password_iterations, must_change_password, is_admin, is_active, created_at, last_login_at)
     SELECT ?, ?, ?, '', ?, ?, ?, 0, 1, 1, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM users)`,
    email,
    firstName,
    lastName,
    hash,
    salt,
    iterations,
    now,
    now,
  );
  if (!result.rowsAffected) throw new HttpError(409, "This workspace already has an admin. Please log in.");
  if (workspaceName) await setSettings(db, { workspace_name: workspaceName });
  await recordAttempt(db, SETUP_THROTTLE_KEY, true);

  const user = await db.first("SELECT * FROM users WHERE email = ?", email);
  const token = await createSession(db, user.id);
  return json({ token, user: publicUser(user) }, 201);
}

// POST /api/login
export async function handleLogin({ db, request }) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) throw badRequest("Please enter your password.");

  const until = await lockedUntil(db, email);
  if (until) throw tooManyAttempts(until);

  const user = await db.first("SELECT * FROM users WHERE email = ?", email);
  let valid = false;
  if (user) {
    valid = await verifyPassword(password, user);
  } else {
    await pbkdf2Hex(password, DUMMY_SALT, PBKDF2_ITERATIONS);
  }
  await recordAttempt(db, email, valid);
  // Keep the attempts table small.
  await db.run("DELETE FROM login_attempts WHERE attempted_at < ?", new Date(Date.now() - DAY_MS).toISOString());

  if (!valid) throw unauthorized(INVALID_LOGIN);
  if (!user.is_active) throw forbidden("This account is deactivated. Please contact an admin.");

  await db.run("UPDATE users SET last_login_at = ? WHERE id = ?", nowIso(), user.id);
  // Passwords hashed with an older, lower iteration count are upgraded now,
  // while we have the plain password.
  if (Number(user.password_iterations) < PBKDF2_ITERATIONS) {
    const upgraded = await hashPassword(password);
    await db.run(
      "UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?",
      upgraded.hash,
      upgraded.salt,
      upgraded.iterations,
      user.id,
    );
  }
  const token = await createSession(db, user.id);
  return json({ token, user: publicUser(user) });
}

// POST /api/logout
export async function handleLogout({ db, user }) {
  await db.run("DELETE FROM sessions WHERE token_hash = ?", user.token_hash);
  return noContent();
}

// POST /api/password: change your own password. Other sessions are closed.
export async function handleChangePassword({ db, request, user }) {
  const body = await readJson(request);
  const current = typeof body.current_password === "string" ? body.current_password : "";
  if (!(await verifyPassword(current, user))) throw badRequest("Your current password is incorrect.");
  const weakness = checkPasswordStrength(body.new_password);
  if (weakness) throw badRequest(weakness);
  if (body.new_password === current) throw badRequest("Please choose a password different from the current one.");

  const { hash, salt, iterations } = await hashPassword(body.new_password);
  await db.batch([
    [
      `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 0
        WHERE id = ?`,
      [hash, salt, iterations, user.id],
    ],
    ["DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", [user.id, user.token_hash]],
  ]);
  return json({ ok: true });
}

// The departments of a user, with the automatic Everyone department first.
export async function userDepartments(db, user) {
  const rows = await db.all(
    `SELECT d.id, d.name, d.is_system, COALESCE(m.is_leader, 0) AS is_leader
       FROM departments d
       LEFT JOIN department_members m ON m.department_id = d.id AND m.user_id = ?
      WHERE d.is_system = 1 OR m.user_id IS NOT NULL
      ORDER BY d.is_system DESC, d.position, d.name`,
    user.id,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    is_system: Boolean(r.is_system),
    is_leader: Boolean(r.is_leader) && !r.is_system,
  }));
}

// GET /api/me
export async function handleMe(ctx) {
  const { db, user } = ctx;
  const departments = await userDepartments(db, user);
  const settings = await getSettings(db);
  const access = await accessFor(ctx);
  return json({
    can_edit: access.canEditAnything,
    user: publicUser(user),
    departments,
    leads: departments.filter((d) => d.is_leader).map((d) => d.id),
    workspace: {
      name: settings.workspace_name,
      logo_url: settings.logo_url,
      banner_url: settings.banner_url,
      ai_enabled: Boolean(settings.anthropic_api_key),
    },
  });
}

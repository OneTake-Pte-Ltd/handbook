// The whole API: routing, CORS, migrations and error handling.
// createApp() takes its database and environment as arguments, so the same
// code runs on Bunny (see main.js) and in the Node tests.

import { HttpError, corsHeaders, errorResponse, forbidden, json, notFound, parseAllowedOrigins, readJson, withHeaders } from "./lib/http.js";
import { migrate } from "./lib/migrations.js";
import {
  authenticate,
  handleBench,
  handleChangePassword,
  handleInfo,
  handleLogin,
  handleLogout,
  handleMe,
  handleSetup,
} from "./lib/auth.js";
import { getSettings, parseSettingsPatch, setSettings, settingsForAdmin } from "./lib/settings.js";

function requireAdmin(user) {
  if (!user.is_admin) throw forbidden("Only admins can do this.");
}

async function handleGetSettings({ db, user }) {
  requireAdmin(user);
  return json(settingsForAdmin(await getSettings(db)));
}

async function handlePatchSettings({ db, user, request }) {
  requireAdmin(user);
  const changes = parseSettingsPatch(await readJson(request));
  await setSettings(db, changes);
  return json(settingsForAdmin(await getSettings(db)));
}

// [method, path pattern, handler, options]. `public: true` skips the session check.
// While must_change_password is set, only the routes marked `allowPasswordChange` work.
const ROUTES = [
  ["GET", "/api/info", handleInfo, { public: true }],
  ["POST", "/api/setup", handleSetup, { public: true }],
  ["POST", "/api/login", handleLogin, { public: true }],
  ["POST", "/api/bench", handleBench, { public: true }],
  ["POST", "/api/logout", handleLogout, { allowPasswordChange: true }],
  ["POST", "/api/password", handleChangePassword, { allowPasswordChange: true }],
  ["GET", "/api/me", handleMe, { allowPasswordChange: true }],
  ["GET", "/api/settings", handleGetSettings],
  ["PATCH", "/api/settings", handlePatchSettings],
].map(([method, pattern, handler, options = {}]) => ({
  method,
  handler,
  options,
  regex: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "/?$"),
}));

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const route of ROUTES) {
    const match = route.regex.exec(pathname);
    if (!match) continue;
    pathMatched = true;
    if (route.method === method) return { route, params: match.groups || {} };
  }
  if (pathMatched) throw new HttpError(405, "This method is not allowed here.");
  throw notFound("This API endpoint does not exist.");
}

export function createApp({ db, env }) {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  let migrated = null;

  // Migrations run once per cold start. A failure is retried on the next request.
  function ensureMigrated() {
    if (!migrated) {
      migrated = migrate(db).catch((error) => {
        migrated = null;
        throw error;
      });
    }
    return migrated;
  }

  async function dispatch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (origin && !allowedOrigins.includes(origin.replace(/\/+$/, ""))) {
      // Readable by that website, so the login screen can say what is wrong.
      // It only ever reveals this fixed message.
      return withHeaders(
        json({ error: `This workspace does not accept ${origin} yet. Add it to the ALLOWED_ORIGINS secret of the edge script.`, code: "origin_not_allowed" }, 403),
        { "Access-Control-Allow-Origin": origin, Vary: "Origin" },
      );
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    if (url.pathname === "/" || url.pathname === "/api" || url.pathname === "/api/") {
      return json({ service: "handbook", ok: true });
    }

    const { route, params } = matchRoute(request.method, url.pathname);
    await ensureMigrated();
    const ctx = { db, env, request, url, params, origin, user: null };
    if (!route.options.public) {
      ctx.user = await authenticate(db, request);
      if (ctx.user.must_change_password && !route.options.allowPasswordChange) {
        throw new HttpError(403, "Please choose a new password first.", { code: "must_change_password" });
      }
    }
    return route.handler(ctx);
  }

  return {
    async handle(request) {
      const cors = corsHeaders(request.headers.get("Origin"), allowedOrigins);
      let response;
      try {
        response = await dispatch(request);
      } catch (error) {
        response = errorResponse(error);
      }
      return withHeaders(response, cors);
    },
  };
}

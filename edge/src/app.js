// The whole API: routing, CORS, migrations and error handling.
// createApp() takes its database and environment as arguments, so the same
// code runs on Bunny (see main.js) and in the Node tests.

import { HttpError, corsHeaders, errorResponse, json, notFound, parseAllowedOrigins, readJson, withHeaders } from "./lib/http.js";
import { migrate } from "./lib/migrations.js";
import {
  authenticate,
  handleChangePassword,
  handleInfo,
  handleLogin,
  handleLogout,
  handleMe,
  handleSetup,
} from "./lib/auth.js";
import { getSettings, parseSettingsPatch, setSettings, settingsForAdmin } from "./lib/settings.js";
import {
  handleCreateDepartment,
  handleCreateUser,
  handleDeleteDepartment,
  handleGetDepartment,
  handleGetUser,
  handleListDepartments,
  handleListUsers,
  handlePutMember,
  handleRemoveMember,
  handleResetPassword,
  handleUpdateDepartment,
  handleUpdateUser,
  requireAdmin,
} from "./lib/people.js";
import { handleUpload } from "./lib/storage.js";
import {
  handleCompleteStep,
  handleCreateCategory,
  handleCreateDocument,
  handleCreateSpace,
  handleDeleteCategory,
  handleDeleteDocument,
  handleDeleteSpace,
  handleGetDocument,
  handleMoveDocument,
  handleReorder,
  handleTree,
  handleUncompleteStep,
  handleUnpublishDocument,
  handleUpdateCategory,
  handleUpdateSpace,
  handleViewStep,
} from "./lib/content.js";
import { handleDeleteGrant, handleListGrants, handlePutGrant } from "./lib/grants.js";
import { handleImport } from "./lib/import.js";
import { handleEmbedPreview } from "./lib/embeds.js";
import {
  handleApproveDraft,
  handleDiscardDraft,
  handleGetDraft,
  handlePublishDraft,
  handleRejectDraft,
  handleSaveDraft,
  handleSubmitDraft,
} from "./lib/drafts.js";

async function handleGetSettings({ db, user }) {
  requireAdmin({ user });
  return json(settingsForAdmin(await getSettings(db)));
}

async function handlePatchSettings({ db, user, request }) {
  requireAdmin({ user });
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
  ["POST", "/api/logout", handleLogout, { allowPasswordChange: true }],
  ["POST", "/api/password", handleChangePassword, { allowPasswordChange: true }],
  ["GET", "/api/me", handleMe, { allowPasswordChange: true }],
  ["GET", "/api/settings", handleGetSettings],
  ["PATCH", "/api/settings", handlePatchSettings],
  ["GET", "/api/users", handleListUsers],
  ["POST", "/api/users", handleCreateUser],
  ["GET", "/api/users/:id", handleGetUser],
  ["PATCH", "/api/users/:id", handleUpdateUser],
  ["POST", "/api/users/:id/reset-password", handleResetPassword],
  ["GET", "/api/departments", handleListDepartments],
  ["POST", "/api/departments", handleCreateDepartment],
  ["GET", "/api/departments/:id", handleGetDepartment],
  ["PATCH", "/api/departments/:id", handleUpdateDepartment],
  ["DELETE", "/api/departments/:id", handleDeleteDepartment],
  ["PUT", "/api/departments/:id/members/:userId", handlePutMember],
  ["DELETE", "/api/departments/:id/members/:userId", handleRemoveMember],
  ["POST", "/api/files", handleUpload],
  ["GET", "/api/embed-preview", handleEmbedPreview],
  ["GET", "/api/tree", handleTree],
  ["POST", "/api/documents", handleCreateDocument],
  ["GET", "/api/documents/:id", handleGetDocument],
  ["DELETE", "/api/documents/:id", handleDeleteDocument],
  ["POST", "/api/documents/:id/move", handleMoveDocument],
  ["POST", "/api/documents/:id/unpublish", handleUnpublishDocument],
  ["GET", "/api/documents/:id/draft", handleGetDraft],
  ["PUT", "/api/documents/:id/draft", handleSaveDraft],
  ["DELETE", "/api/documents/:id/draft", handleDiscardDraft],
  ["POST", "/api/documents/:id/draft/submit", handleSubmitDraft],
  ["POST", "/api/documents/:id/draft/publish", handlePublishDraft],
  ["POST", "/api/documents/:id/draft/approve", handleApproveDraft],
  ["POST", "/api/documents/:id/draft/reject", handleRejectDraft],
  ["POST", "/api/steps/:id/view", handleViewStep],
  ["POST", "/api/steps/:id/complete", handleCompleteStep],
  ["DELETE", "/api/steps/:id/complete", handleUncompleteStep],
  ["POST", "/api/spaces", handleCreateSpace],
  ["PATCH", "/api/spaces/:id", handleUpdateSpace],
  ["DELETE", "/api/spaces/:id", handleDeleteSpace],
  ["POST", "/api/categories", handleCreateCategory],
  ["PATCH", "/api/categories/:id", handleUpdateCategory],
  ["DELETE", "/api/categories/:id", handleDeleteCategory],
  ["POST", "/api/reorder", handleReorder],
  ["GET", "/api/grants", handleListGrants],
  ["PUT", "/api/grants", handlePutGrant],
  ["DELETE", "/api/grants/:id", handleDeleteGrant],
  ["POST", "/api/import", handleImport],
].map(([method, pattern, handler, options = {}]) => ({
  method,
  handler,
  options,
  regex: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>\\d+)") + "/?$"),
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

export function createApp({ db, env, fetchImpl = (...args) => fetch(...args) }) {
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
    const ctx = { db, env, request, url, params, origin, fetchImpl, user: null };
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

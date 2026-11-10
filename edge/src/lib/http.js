// HTTP helpers: JSON responses, errors, request bodies and CORS.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const unauthorized = (message = "Please log in again.") => new HttpError(401, message);
export const forbidden = (message = "You don't have permission to do this.") => new HttpError(403, message);
export const notFound = (message = "Not found.") => new HttpError(404, message);

// Every response is private and never cached by the pull zone.
const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function noContent() {
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

export function errorResponse(error) {
  if (error instanceof HttpError) {
    return json({ error: error.message, ...error.extra }, error.status);
  }
  console.error(error && error.stack ? error.stack : error);
  // Errors from @bunny.net/database-client: say so, with its short code only.
  if (error && error.name === "DatabaseError" && error.code) {
    return json({ error: `The workspace can't use its database right now (${error.code}). Please try again, or check the database secrets.` }, 503);
  }
  return json({ error: "Something went wrong on the server. Please try again." }, 500);
}

// Reads a JSON body with a size limit. Returns {} for an empty body.
export async function readJson(request, maxBytes = 1_000_000) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) throw new HttpError(413, "This request is too large.");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "This request is too large.");
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body;
  } catch {
    throw badRequest("The request body must be a JSON object.");
  }
}

// Validation helpers for request bodies.
export function requireString(body, key, label, { max = 500, min = 1 } = {}) {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (value.length < min) throw badRequest(`${label} is required.`);
  if (value.length > max) throw badRequest(`${label} is too long (${max} characters maximum).`);
  return value;
}

export function optionalString(body, key, label, { max = 500 } = {}) {
  if (body[key] === undefined || body[key] === null) return "";
  if (typeof body[key] !== "string") throw badRequest(`${label} must be text.`);
  const value = body[key].trim();
  if (value.length > max) throw badRequest(`${label} is too long (${max} characters maximum).`);
  return value;
}

export function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw badRequest("Please enter a valid email address.");
  }
  return email;
}

// CORS: only origins listed in ALLOWED_ORIGINS get the Access-Control headers.
export function parseAllowedOrigins(value) {
  return String(value || "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function corsHeaders(origin, allowed) {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function withHeaders(response, headers) {
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}

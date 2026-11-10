// API client: remembers workspaces and session tokens, and calls the
// company's edge script with the session token.

const KEY_WORKSPACES = "handbook.workspaces";
const KEY_CURRENT = "handbook.currentWorkspace";
const tokenKey = (url) => `handbook.session:${url}`;

// localStorage can be unavailable (private mode, blocked storage).
function read(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Without storage the session lasts until the page is closed.
  }
}

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Accepts "handbook.example.com", "https://handbook.example.com/", ".../api".
export function normalizeWorkspaceUrl(input) {
  let value = String(input || "").trim();
  if (!value) throw new Error("Please enter your workspace URL.");
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("This doesn't look like a web address.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) throw new Error("The workspace URL must start with https://");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${url.origin}${path}`;
}

export function listWorkspaces() {
  const list = read(KEY_WORKSPACES, []);
  return Array.isArray(list) ? list.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)) : [];
}

export function rememberWorkspace(url, info = {}) {
  const list = listWorkspaces().filter((w) => w.url !== url);
  list.unshift({ url, name: info.name || url, logo_url: info.logo_url || "", lastUsed: Date.now() });
  write(KEY_WORKSPACES, list.slice(0, 10));
}

export function forgetWorkspace(url) {
  write(KEY_WORKSPACES, listWorkspaces().filter((w) => w.url !== url));
  write(tokenKey(url), null);
  if (currentWorkspace() === url) write(KEY_CURRENT, null);
}

export function currentWorkspace() {
  return read(KEY_CURRENT, null);
}

export function setCurrentWorkspace(url) {
  write(KEY_CURRENT, url);
}

export function getToken(url = currentWorkspace()) {
  return url ? read(tokenKey(url), null) : null;
}

export function setToken(url, token) {
  write(tokenKey(url), token);
}

async function send(base, method, path, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "We couldn't reach the workspace. Check your connection and the workspace URL.");
  }
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new ApiError(response.status, (data && data.error) || `The workspace answered with an error (${response.status}).`, data && data.code);
  }
  return data;
}

// Public call used by the login screen before there is a session.
export function fetchInfo(base) {
  return send(base, "GET", "/info");
}

export function publicPost(base, path, body) {
  return send(base, "POST", path, { body });
}

// Authenticated call on the current workspace. A 401 ends the session.
export async function api(method, path, body) {
  const base = currentWorkspace();
  try {
    return await send(base, method, path, { body, token: getToken(base) });
  } catch (error) {
    if (error.status === 401) {
      setToken(base, null);
      window.dispatchEvent(new CustomEvent("handbook:logged-out", { detail: error.message }));
    } else if (error.code === "must_change_password") {
      window.dispatchEvent(new CustomEvent("handbook:must-change-password"));
    }
    throw error;
  }
}

// Uploads a file (Blob) as the raw request body. kind: "image" or "file".
export async function uploadFile(blob, name, kind = "image") {
  const base = currentWorkspace();
  let response;
  try {
    response = await fetch(`${base}/api/files?kind=${kind}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getToken(base)}`,
        "Content-Type": blob.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(name),
      },
      body: blob,
    });
  } catch {
    throw new ApiError(0, "The upload failed. Check your connection and try again.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, (data && data.error) || `The upload failed (${response.status}).`);
  return data;
}

// The link to share with new members: this site, with the workspace pre-filled.
export function loginLink() {
  return `${location.origin}${location.pathname}?workspace=${encodeURIComponent(currentWorkspace())}`;
}

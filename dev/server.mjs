// Local development server: no Bunny account needed.
//
//   node dev/server.mjs
//
// Serves the frontend (web/) on http://localhost:8080 and the API on
// http://localhost:8787, backed by a SQLite file (dev/local.db) through
// node:sqlite, which is built into Node 22. Use http://localhost:8787 as the
// workspace URL and "dev-setup-code" as the setup code.
// Delete dev/local.db to start again from an empty workspace.

import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../edge/src/app.js";
import { createSqliteDb } from "./sqlite-db.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web");
const WEB_PORT = Number(process.env.WEB_PORT || 8080);
const API_PORT = Number(process.env.API_PORT || 8787);

// Uploads go to dev/uploads instead of Bunny Storage, and are served back by
// the API server under /dev-files/.
const uploadsRoot = join(here, "uploads");
const DEV_STORAGE_HOST = "dev-storage.localhost";
async function devFetch(url, init = {}) {
  const target = new URL(url);
  if (target.hostname !== DEV_STORAGE_HOST) return fetch(url, init);
  const path = decodeURIComponent(target.pathname).split("/").slice(2).join("/");
  const file = join(uploadsRoot, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(init.body));
  return new Response(null, { status: 201 });
}

const app = createApp({
  fetchImpl: devFetch,
  db: createSqliteDb(process.env.DB_PATH || join(here, "local.db")),
  env: {
    ALLOWED_ORIGINS: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
    SETUP_CODE: process.env.SETUP_CODE || "dev-setup-code",
    STORAGE_ZONE: "dev",
    STORAGE_KEY: "dev",
    STORAGE_REGION_HOST: DEV_STORAGE_HOST,
    PUBLIC_FILES_URL: `http://localhost:${API_PORT}/dev-files`,
  },
});

createServer(async (req, res) => {
  if (req.url.startsWith("/dev-files/")) {
    const file = join(uploadsRoot, normalize(decodeURIComponent(req.url.slice("/dev-files/".length).split("?")[0])).replace(/^(\.\.[/\\])+/, ""));
    try {
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" }).end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${API_PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const response = await app.handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(API_PORT, () => console.log(`API       http://localhost:${API_PORT}`));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(webRoot, path.endsWith("/") ? path + "index.html" : path);
  if (!file.startsWith(webRoot)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}).listen(WEB_PORT, () => console.log(`Frontend  http://localhost:${WEB_PORT}  (workspace URL: http://localhost:${API_PORT})`));

// File uploads to Bunny Storage, and POST /api/files.
//
// The browser sends the raw file as the request body (not multipart), with
// its name in the X-File-Name header. The edge script checks the type and
// size, stores it under uploads/<yyyy>/<mm>/<uuid>-<safe-name>, and returns
// its public pull-zone URL. Files are public but unguessable.

import { nowIso } from "./db.js";
import { HttpError, badRequest, forbidden, json } from "./http.js";
import { accessFor } from "./permissions.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Images are recognised from their first bytes, not from what the browser claims.
// SVG is deliberately not accepted as an image: it can contain scripts.
const IMAGE_SIGNATURES = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/gif", ext: "gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

export function detectImage(bytes) {
  return IMAGE_SIGNATURES.find((s) => s.test(bytes)) || null;
}

// Keeps letters, digits, dots, dashes and underscores; at most 80 characters.
export function safeFileName(name) {
  const cleaned = String(name || "file")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return (cleaned || "file").slice(-80);
}

export function storageConfig(env) {
  const config = {
    zone: env.STORAGE_ZONE,
    key: env.STORAGE_KEY,
    host: String(env.STORAGE_REGION_HOST || "").replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    publicUrl: String(env.PUBLIC_FILES_URL || "").replace(/\/+$/, ""),
  };
  if (!config.zone || !config.key || !config.host || !config.publicUrl) {
    throw new HttpError(
      503,
      "File storage is not set up yet. Add STORAGE_ZONE, STORAGE_KEY, STORAGE_REGION_HOST and PUBLIC_FILES_URL to the edge script.",
    );
  }
  return config;
}

export async function putFile(env, path, bytes, contentType, fetchImpl = fetch) {
  const config = storageConfig(env);
  let response;
  try {
    response = await fetchImpl(`https://${config.host}/${encodeURIComponent(config.zone)}/${path}`, {
      method: "PUT",
      headers: { AccessKey: config.key, "Content-Type": contentType },
      body: bytes,
    });
  } catch (error) {
    console.error(`Storage upload failed: ${error && error.message}`);
    throw new HttpError(502, `The file could not be stored: Bunny Storage can't be reached at ${config.host}. Check STORAGE_REGION_HOST.`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    console.error(`Storage upload failed: HTTP ${response.status} ${detail}`);
    throw new HttpError(502, storageErrorMessage(response.status, config));
  }
  return `${config.publicUrl}/${path}`;
}

// Explains a refusal from Bunny Storage to the person setting it up. No secret
// is included: the zone name and region host are not secret.
export function storageErrorMessage(status, config) {
  if (status === 401) {
    return `The file could not be stored: Bunny Storage refused the access (HTTP 401). Check STORAGE_KEY (the storage zone's password from FTP & API Access, not the read-only password) and STORAGE_REGION_HOST (it must be the hostname shown on that page, for example sg.storage.bunnycdn.com; now ${config.host}).`;
  }
  if (status === 404) return `The file could not be stored: Bunny Storage has no zone called "${config.zone}" at ${config.host} (HTTP 404). Check STORAGE_ZONE and STORAGE_REGION_HOST.`;
  return `The file could not be stored: Bunny Storage answered HTTP ${status}. Please try again.`;
}

// POST /api/files?kind=image|file
// kind=image accepts JPEG, PNG, GIF and WebP up to 10 MB, for every member
// (profile photos). kind=file accepts any file up to 50 MB, for members who
// can edit at least one document (PDFs and attachments in documents).
export async function handleUpload(ctx) {
  const { db, env, request, url, user, fetchImpl } = ctx;
  const kind = url.searchParams.get("kind") === "file" ? "file" : "image";
  if (kind === "file" && !(await accessFor(ctx)).canEditAnything) throw forbidden("Only editors can upload files.");
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > limit) throw new HttpError(413, `This file is too large (${limit / 1024 / 1024} MB maximum).`);
  storageConfig(env); // fail early, before reading the body

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw badRequest("The file is empty.");
  if (bytes.length > limit) throw new HttpError(413, `This file is too large (${limit / 1024 / 1024} MB maximum).`);

  let originalName = "file";
  try {
    originalName = decodeURIComponent(request.headers.get("X-File-Name") || "file").slice(0, 200);
  } catch {
    originalName = "file";
  }
  let mime = (request.headers.get("Content-Type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
  let name = safeFileName(originalName);
  if (kind === "image") {
    const image = detectImage(bytes);
    if (!image) throw badRequest("Please choose a JPEG, PNG, GIF or WebP image.");
    mime = image.mime;
    if (!name.toLowerCase().endsWith(`.${image.ext}`)) name = `${name.replace(/\.[A-Za-z0-9]+$/, "")}.${image.ext}`;
  } else if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) {
    mime = "application/octet-stream";
  }

  const now = new Date();
  const path = `uploads/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}-${name}`;
  const publicUrl = await putFile(env, path, bytes, mime, fetchImpl);
  const result = await db.run(
    `INSERT INTO files (storage_path, public_url, original_name, mime_type, size_bytes, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    path,
    publicUrl,
    originalName,
    mime,
    bytes.length,
    user.id,
    nowIso(),
  );
  return json({ id: result.lastInsertRowid, url: publicUrl, name: originalName, mime_type: mime, size_bytes: bytes.length }, 201);
}

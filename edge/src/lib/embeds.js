// GET /api/embed-preview?url=...
//
// When an editor pastes a video URL, this fetches the page and looks, in
// order, for an oEmbed discovery link, then og:video:secure_url or
// og:video:url, then twitter:player. It returns either an iframe description
// (only https sources) or, if no player is found, a link card. The result is
// stored in the editor node and never fetched again when viewing.
//
// Safety: only http(s) URLs on public host names; private and local addresses
// are refused (the edge script must not be used to probe internal networks);
// at most 3 redirects, 8 seconds and 1 MB per fetch.

import { badRequest, forbidden, json } from "./http.js";
import { accessFor } from "./permissions.js";

const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 8000;

export function isPublicHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  // IPv4 literals in private, loopback, link-local or reserved ranges.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  // Any IPv6 literal is refused (simplest safe rule).
  if (host.includes(":")) return false;
  return true;
}

async function fetchText(fetchImpl, url, accept) {
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    if (!isPublicHttpUrl(current)) throw badRequest("This address can't be previewed.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: accept, "User-Agent": "HandbookEmbedPreview/1.0" },
      });
    } catch {
      clearTimeout(timer);
      throw badRequest("We couldn't open this address.");
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      clearTimeout(timer);
      current = new URL(response.headers.get("location"), current).toString();
      continue;
    }
    if (!response.ok) {
      clearTimeout(timer);
      throw badRequest(`This address answered with an error (${response.status}).`);
    }
    // Read at most MAX_BYTES.
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (size < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
    } finally {
      clearTimeout(timer);
      reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c.subarray(0, Math.min(c.length, size - offset)), offset);
      offset += c.length;
      if (offset >= size) break;
    }
    return { text: new TextDecoder().decode(bytes), url: current };
  }
  throw badRequest("This address redirects too many times.");
}

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function tags(html, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, "gi");
  for (const match of html.matchAll(re)) {
    const attrs = {};
    for (const a of match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    }
    out.push(attrs);
  }
  return out;
}

function meta(html) {
  const values = {};
  for (const m of tags(html, "meta")) {
    const key = (m.property || m.name || "").toLowerCase();
    if (key && m.content && !(key in values)) values[key] = m.content;
  }
  return values;
}

const size = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 10000 ? Math.round(n) : null;
};
const httpsOrEmpty = (v, base) => {
  try {
    const u = new URL(v, base);
    return u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
};

export async function previewEmbed(fetchImpl, pageUrl) {
  const page = await fetchText(fetchImpl, pageUrl, "text/html,application/xhtml+xml");
  const head = page.text.slice(0, MAX_BYTES);
  const m = meta(head);
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head);
  const pageTitle = m["og:title"] || m["twitter:title"] || (titleTag ? decodeEntities(titleTag[1].trim()) : "");
  const thumbnail = httpsOrEmpty(m["og:image"] || m["twitter:image"] || "", page.url);

  // 1. oEmbed discovery
  const discovery = tags(head, "link").find((l) => /json\+oembed/i.test(l.type || "") && l.href);
  if (discovery) {
    try {
      const oembedUrl = new URL(discovery.href, page.url).toString();
      const data = JSON.parse((await fetchText(fetchImpl, oembedUrl, "application/json")).text);
      const iframe = typeof data.html === "string" ? tags(data.html, "iframe")[0] : null;
      const src = iframe ? httpsOrEmpty(iframe.src || "", oembedUrl) : "";
      if (src) {
        return {
          kind: "iframe",
          url: pageUrl,
          src,
          width: size(data.width || iframe.width) || 16,
          height: size(data.height || iframe.height) || 9,
          title: String(data.title || pageTitle || "").slice(0, 300),
          thumbnail: httpsOrEmpty(data.thumbnail_url || "", oembedUrl) || thumbnail,
        };
      }
    } catch {
      // Fall through to the meta tags.
    }
  }

  // 2. Open Graph video, 3. Twitter player
  const candidates = [
    [m["og:video:secure_url"], m["og:video:width"], m["og:video:height"]],
    [m["og:video:url"], m["og:video:width"], m["og:video:height"]],
    [m["og:video"], m["og:video:width"], m["og:video:height"]],
    [m["twitter:player"], m["twitter:player:width"], m["twitter:player:height"]],
  ];
  for (const [src, w, hgt] of candidates) {
    const secure = src ? httpsOrEmpty(src, page.url) : "";
    if (secure) return { kind: "iframe", url: pageUrl, src: secure, width: size(w) || 16, height: size(hgt) || 9, title: pageTitle.slice(0, 300), thumbnail };
  }

  // 4. No player: a link card.
  return {
    kind: "link",
    url: pageUrl,
    title: (pageTitle || new URL(pageUrl).hostname).slice(0, 300),
    thumbnail,
    description: String(m["og:description"] || m.description || "").slice(0, 1000),
  };
}

export async function handleEmbedPreview(ctx) {
  const access = await accessFor(ctx);
  if (!access.canEditAnything) throw forbidden("Only editors can add videos.");
  const url = (ctx.url.searchParams.get("url") || "").trim();
  if (!isPublicHttpUrl(url)) throw badRequest("Please paste a full web address starting with https://");
  return json(await previewEmbed(ctx.fetchImpl, url));
}

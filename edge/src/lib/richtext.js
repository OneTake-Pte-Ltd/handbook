// Tiptap JSON on the server: cleaning it before it is stored, and deriving
// the plain text used by search and the AI features.
//
// Only known node and mark types are kept. URLs are checked: links accept
// http, https and mailto; images, PDFs and files need https (http://localhost
// is accepted for the local dev server); video players need https.

const BLOCKS = new Set([
  "doc",
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "hardBreak",
  "text",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "columns",
  "column",
  "figure",
  "pdf",
  "video",
  "htmlEmbed",
  "callout",
  "fileAttachment",
  "details",
  "detailsSummary",
  "detailsContent",
  "emoji",
]);
const MARKS = new Set(["bold", "italic", "strike", "code", "underline", "link"]);

const MAX_HTML_EMBED = 100_000;

const isHttps = (url) => typeof url === "string" && /^https:\/\/[^\s]+$/i.test(url);
const isFileUrl = (url) => isHttps(url) || (typeof url === "string" && /^http:\/\/localhost(:\d+)?\//.test(url));
const isLinkUrl = (url) => typeof url === "string" && /^(https?:\/\/|mailto:)[^\s]+$/i.test(url);

function str(value, max = 2000) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function num(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
}

function cleanAttrs(type, attrs = {}) {
  switch (type) {
    case "heading":
      return { level: [2, 3].includes(attrs.level) ? attrs.level : 2 };
    case "orderedList":
      return { start: num(attrs.start, 1, 100000) || 1 };
    case "codeBlock":
      return { language: /^[a-z0-9+#-]{0,30}$/i.test(attrs.language || "") ? attrs.language || null : null };
    case "tableCell":
    case "tableHeader":
      return {
        colspan: num(attrs.colspan, 1, 50) || 1,
        rowspan: num(attrs.rowspan, 1, 50) || 1,
        colwidth: Array.isArray(attrs.colwidth) ? attrs.colwidth.map((w) => num(w, 10, 4000)).filter(Boolean) : null,
      };
    case "columns":
      return { count: attrs.count === 3 ? 3 : 2 };
    case "figure":
      if (!isFileUrl(attrs.src)) return null;
      return { src: attrs.src, alt: str(attrs.alt, 500), caption: str(attrs.caption, 500), width: ["small", "medium", "full"].includes(attrs.width) ? attrs.width : "full" };
    case "pdf":
      if (!isFileUrl(attrs.src)) return null;
      return { src: attrs.src, name: str(attrs.name, 200), size: num(attrs.size, 0, 1e10) };
    case "fileAttachment":
      if (!isFileUrl(attrs.src)) return null;
      return { src: attrs.src, name: str(attrs.name, 200), size: num(attrs.size, 0, 1e10), mime: str(attrs.mime, 100) };
    case "video": {
      const kind = attrs.kind === "link" ? "link" : "iframe";
      if (kind === "iframe" && !isHttps(attrs.src)) return null;
      return {
        kind,
        url: isLinkUrl(attrs.url) ? attrs.url : "",
        src: kind === "iframe" ? attrs.src : "",
        width: num(attrs.width, 1, 10000),
        height: num(attrs.height, 1, 10000),
        title: str(attrs.title, 300),
        thumbnail: isHttps(attrs.thumbnail) ? attrs.thumbnail : "",
        description: str(attrs.description, 1000),
      };
    }
    case "htmlEmbed":
      return { html: str(attrs.html, MAX_HTML_EMBED) };
    case "callout":
      return { variant: ["info", "tip", "warning"].includes(attrs.variant) ? attrs.variant : "info" };
    case "details":
      return { open: Boolean(attrs.open) };
    case "emoji":
      return null;
    default:
      return undefined;
  }
}

function cleanMarks(marks) {
  if (!Array.isArray(marks)) return undefined;
  const out = [];
  for (const mark of marks) {
    if (!mark || !MARKS.has(mark.type)) continue;
    if (mark.type === "link") {
      if (!isLinkUrl(mark.attrs && mark.attrs.href)) continue;
      out.push({ type: "link", attrs: { href: mark.attrs.href, target: "_blank", rel: "noopener noreferrer nofollow" } });
    } else {
      out.push({ type: mark.type });
    }
  }
  return out.length ? out : undefined;
}

function cleanNode(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 60 || !BLOCKS.has(node.type)) return null;
  if (node.type === "text") {
    if (typeof node.text !== "string" || !node.text) return null;
    const marks = cleanMarks(node.marks);
    return marks ? { type: "text", text: node.text.slice(0, 100000), marks } : { type: "text", text: node.text.slice(0, 100000) };
  }
  const attrs = cleanAttrs(node.type, node.attrs || {});
  if (attrs === null) return null;
  const out = { type: node.type };
  if (attrs !== undefined) out.attrs = attrs;
  if (Array.isArray(node.content)) {
    const content = node.content.map((child) => cleanNode(child, depth + 1)).filter(Boolean);
    if (content.length) out.content = content;
  }
  return out;
}

export function cleanDoc(json) {
  const cleaned = cleanNode(json && json.type === "doc" ? json : { type: "doc", content: [] });
  if (!cleaned.content || !cleaned.content.length) cleaned.content = [{ type: "paragraph" }];
  return cleaned;
}

const BLOCK_BREAK = new Set(["paragraph", "heading", "listItem", "blockquote", "codeBlock", "tableRow", "callout", "detailsSummary", "column", "figure", "video", "pdf", "fileAttachment"]);

// Plain text for search and AI: text of every node, blocks on separate lines.
// HTML embeds are left out; media contribute their caption, title or name.
export function docToText(json) {
  const parts = [];
  function walk(node) {
    if (!node) return;
    if (node.type === "text") {
      parts.push(node.text);
      return;
    }
    if (node.type === "hardBreak") parts.push("\n");
    if (node.type === "htmlEmbed") return;
    if (node.type === "tableCell" || node.type === "tableHeader") parts.push(" ");
    const a = node.attrs || {};
    if (node.type === "figure") parts.push([a.alt, a.caption].filter(Boolean).join(" "));
    if (node.type === "video") parts.push([a.title, a.description].filter(Boolean).join(" "));
    if (node.type === "pdf" || node.type === "fileAttachment") parts.push(a.name || "");
    for (const child of node.content || []) walk(child);
    if (BLOCK_BREAK.has(node.type)) parts.push("\n");
  }
  walk(json);
  return parts
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

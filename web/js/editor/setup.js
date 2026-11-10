// Tiptap setup shared by the editor and the read-only viewer, so every block
// looks the same in View mode and Edit mode.

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import DOMPurify from "dompurify";
import { CUSTOM_NODES } from "./nodes.js";

const LINK_PROTOCOLS = /^(https?:|mailto:)/i;

export function extensions({ placeholder } = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      underline: false,
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto"],
        isAllowedUri: (url) => LINK_PROTOCOLS.test(url),
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer nofollow" },
      },
    }),
    TableKit.configure({ table: { resizable: false } }),
    ...CUSTOM_NODES,
    ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
  ];
}

// Pasting from Google Docs or Notion keeps headings, lists, links, bold,
// italic and tables, and drops everything else.
const PASTE_TAGS = ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "b", "em", "i", "a", "table", "thead", "tbody", "tr", "th", "td"];

export function cleanPastedHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Google Docs wraps everything in <b style="font-weight:normal" id="docs-internal-guid-…">.
  for (const el of doc.querySelectorAll('b[id^="docs-internal-guid"]')) el.replaceWith(...el.childNodes);
  // Google Docs marks bold and italic with inline styles on spans.
  for (const span of doc.querySelectorAll("span[style]")) {
    const style = span.getAttribute("style") || "";
    let node = span;
    const bold = /font-weight:\s*(bold|[6-9]00)/i.test(style);
    const italic = /font-style:\s*italic/i.test(style);
    if (bold || italic) {
      let inner = doc.createDocumentFragment();
      inner.append(...span.childNodes);
      if (italic) {
        const em = doc.createElement("em");
        em.append(inner);
        inner = em;
      }
      if (bold) {
        const strong = doc.createElement("strong");
        strong.append(inner);
        inner = strong;
      }
      node.replaceWith(inner);
    }
  }
  // Headings 1 and 4 to 6 become the two levels the handbook uses.
  for (const el of doc.querySelectorAll("h1")) renameTag(doc, el, "h2");
  for (const el of doc.querySelectorAll("h4, h5, h6")) renameTag(doc, el, "h3");
  return DOMPurify.sanitize(doc.body.innerHTML, { ALLOWED_TAGS: PASTE_TAGS, ALLOWED_ATTR: ["href", "colspan", "rowspan"], ALLOWED_URI_REGEXP: /^(https?:|mailto:)/i });
}

function renameTag(doc, el, tag) {
  const next = doc.createElement(tag);
  next.append(...el.childNodes);
  el.replaceWith(next);
}

export function createEditor({ element, content, editable = true, placeholder, onUpdate, onSelectionUpdate }) {
  return new Editor({
    element,
    editable,
    content: content || { type: "doc", content: [{ type: "paragraph" }] },
    extensions: extensions({ placeholder: editable ? placeholder : null }),
    editorProps: {
      attributes: { class: "prose ProseMirror-themed", ...(editable ? { "aria-label": "Step content", role: "textbox", "aria-multiline": "true" } : {}) },
      transformPastedHTML: cleanPastedHtml,
    },
    onUpdate: onUpdate ? ({ editor }) => onUpdate(editor) : undefined,
    onSelectionUpdate: onSelectionUpdate ? ({ editor }) => onSelectionUpdate(editor) : undefined,
  });
}

// Read-only rendering of stored Tiptap JSON (View mode, review mode).
export function renderReadOnly(element, json) {
  return createEditor({ element, content: json, editable: false });
}

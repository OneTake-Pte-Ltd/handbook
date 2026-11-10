// Custom Tiptap nodes. Each node has parseHTML rules (so pasted or generated
// HTML maps onto it), renderHTML (for getHTML), and, where needed, a node view
// used both by the editor and by the read-only viewer, so blocks look the same
// in View mode and Edit mode.

import { Node, mergeAttributes } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { field, h, icon, input, openDialog } from "../lib/dom.js";
import { fileSize } from "../lib/format.js";
import { htmlEmbedFrame } from "./embed-frame.js";

const isHttps = (url) => typeof url === "string" && /^https:\/\//i.test(url);
const isFileUrl = (url) => isHttps(url) || (typeof url === "string" && /^http:\/\/localhost(:\d+)?\//.test(url));

function setAttrs(editor, getPos, attrs) {
  const pos = getPos();
  if (typeof pos !== "number") return;
  editor
    .chain()
    .command(({ tr }) => {
      const node = tr.doc.nodeAt(pos);
      if (!node) return false;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
      return true;
    })
    .run();
}

// Controls shown on a block in the editor only.
function blockControls(editor, buttons) {
  if (!editor.isEditable) return null;
  return h("div", { class: "block-controls", contenteditable: "false" }, buttons);
}

const stopInputs = (event) => Boolean(event.target.closest && event.target.closest("input, textarea, select, button, .block-controls"));

// Columns: 2 or 3 columns of rich content; they stack on phones.
export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  parseHTML: () => [{ tag: "div[data-column]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-column": "", class: "column" }), 0],
});

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column{2,3}",
  defining: true,
  addAttributes: () => ({ count: { default: 2, parseHTML: (el) => Number(el.getAttribute("data-columns")) || 2, renderHTML: (a) => ({ "data-columns": a.count }) } }),
  parseHTML: () => [{ tag: "div[data-columns]" }],
  renderHTML: ({ HTMLAttributes, node }) => ["div", mergeAttributes(HTMLAttributes, { class: `columns columns--${node.attrs.count}` }), 0],
  addCommands() {
    return {
      // Inserts columns and puts the cursor in the first one.
      insertColumns:
        (count = 2) =>
        ({ tr, state, dispatch }) => {
          const { columns, column, paragraph } = state.schema.nodes;
          const node = columns.create({ count }, Array.from({ length: count }, () => column.create(null, paragraph.create())));
          if (dispatch) placeInside(tr, node, 3);
          return true;
        },
    };
  },
});

// Replaces the selection with `node` and puts the cursor `depth` positions
// inside it (for example in its first paragraph).
function placeInside(tr, node, depth) {
  tr.replaceSelectionWith(node);
  let start = null;
  tr.doc.descendants((n, pos) => {
    if (start === null && n === node) start = pos;
    return start === null;
  });
  if (start === null) start = Math.max(0, tr.selection.from - node.nodeSize);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(start + depth, tr.doc.content.size))));
  tr.scrollIntoView();
}

// Image with alt text, optional caption and a width (small, medium, full).
export const Figure = Node.create({
  name: "figure",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: { default: "" }, alt: { default: "" }, caption: { default: "" }, width: { default: "full" } }),
  parseHTML: () => [
    {
      tag: "figure[data-figure]",
      getAttrs: (el) => {
        const img = el.querySelector("img");
        return { src: img ? img.getAttribute("src") : "", alt: img ? img.getAttribute("alt") || "" : "", caption: el.querySelector("figcaption")?.textContent || "", width: el.getAttribute("data-width") || "full" };
      },
    },
  ],
  renderHTML: ({ node }) => ["figure", { "data-figure": "", "data-width": node.attrs.width }, ["img", { src: node.attrs.src, alt: node.attrs.alt }], ["figcaption", {}, node.attrs.caption]],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = h("figure", { class: `figure figure--${node.attrs.width}` });
      const render = (n) => {
        dom.className = `figure figure--${n.attrs.width}`;
        dom.replaceChildren(
          isFileUrl(n.attrs.src) ? h("img", { src: n.attrs.src, alt: n.attrs.alt, loading: "lazy" }) : h("div", { class: "muted small" }, "Image not available"),
          n.attrs.caption ? h("figcaption", {}, n.attrs.caption) : null,
          blockControls(editor, [h("button", { class: "button", type: "button", onclick: () => editFigure(n) }, icon("edit"), "Alt text, caption and size")]),
        );
      };
      const editFigure = (n) => {
        const alt = input({ value: n.attrs.alt, maxlength: 500 });
        const caption = input({ value: n.attrs.caption, maxlength: 500 });
        const width = h("select", { class: "select" }, ["small", "medium", "full"].map((w) => h("option", { value: w, selected: w === n.attrs.width }, w === "full" ? "Full width" : w === "medium" ? "Medium" : "Small")));
        const save = h("button", { class: "button button--primary", type: "submit" }, "Save");
        const form = h("form", { class: "form" }, field({ label: "Alt text", hint: "Describe the image for people who can't see it.", input: alt }), field({ label: "Caption", hint: "Optional.", input: caption }), field({ label: "Size", input: width }), h("div", { class: "dialog__footer" }, save));
        const dialog = openDialog({ title: "Image", content: form });
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          setAttrs(editor, getPos, { alt: alt.value, caption: caption.value, width: width.value });
          dialog.close();
        });
      };
      render(node);
      return {
        dom,
        update: (n) => n.type.name === "figure" && (render(n), true),
        stopEvent: stopInputs,
        ignoreMutation: () => true,
      };
    };
  },
});

// PDF shown with the browser's PDF viewer, plus a download link.
export const Pdf = Node.create({
  name: "pdf",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: { default: "" }, name: { default: "document.pdf" }, size: { default: null } }),
  parseHTML: () => [{ tag: "div[data-pdf]", getAttrs: (el) => ({ src: el.getAttribute("data-src"), name: el.getAttribute("data-name") || "document.pdf" }) }],
  renderHTML: ({ node }) => ["div", { "data-pdf": "", "data-src": node.attrs.src, "data-name": node.attrs.name }, ["a", { href: node.attrs.src }, node.attrs.name]],
  addNodeView() {
    return ({ node }) => {
      const ok = isFileUrl(node.attrs.src);
      const dom = h(
        "div",
        { class: "pdf-block" },
        ok ? h("iframe", { class: "pdf-block__frame", src: node.attrs.src, title: node.attrs.name, loading: "lazy" }) : null,
        h(
          "div",
          { class: "pdf-block__bar" },
          icon("pdf"),
          h("span", { class: "pdf-block__name" }, node.attrs.name, node.attrs.size ? h("span", { class: "muted small" }, ` · ${fileSize(node.attrs.size)}`) : null),
          ok ? h("a", { class: "button", href: node.attrs.src, download: node.attrs.name, target: "_blank", rel: "noopener" }, icon("download"), "Download") : null,
        ),
      );
      return { dom, ignoreMutation: () => true, stopEvent: stopInputs };
    };
  },
});

// File attachment card: name, size and a download button.
export const FileAttachment = Node.create({
  name: "fileAttachment",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: { default: "" }, name: { default: "file" }, size: { default: null }, mime: { default: "" } }),
  parseHTML: () => [{ tag: "div[data-file]", getAttrs: (el) => ({ src: el.getAttribute("data-src"), name: el.getAttribute("data-name") || "file" }) }],
  renderHTML: ({ node }) => ["div", { "data-file": "", "data-src": node.attrs.src, "data-name": node.attrs.name }, ["a", { href: node.attrs.src }, node.attrs.name]],
  addNodeView() {
    return ({ node }) => {
      const ok = isFileUrl(node.attrs.src);
      const dom = h(
        "div",
        { class: "file-card" },
        h("span", { class: "file-card__icon" }, icon("paperclip")),
        h("span", { class: "file-card__text" }, h("strong", {}, node.attrs.name), node.attrs.size ? h("span", { class: "muted small" }, fileSize(node.attrs.size)) : null),
        ok ? h("a", { class: "button", href: node.attrs.src, download: node.attrs.name, target: "_blank", rel: "noopener" }, icon("download"), "Download") : null,
      );
      return { dom, ignoreMutation: () => true, stopEvent: stopInputs };
    };
  },
});

// Video from a URL: an iframe keeping the video's aspect ratio, or a link card.
export const Video = Node.create({
  name: "video",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({
    kind: { default: "iframe" },
    url: { default: "" },
    src: { default: "" },
    width: { default: 16 },
    height: { default: 9 },
    title: { default: "" },
    thumbnail: { default: "" },
    description: { default: "" },
  }),
  parseHTML: () => [{ tag: "div[data-video]", getAttrs: (el) => ({ src: el.getAttribute("data-src"), url: el.getAttribute("data-url") || "", title: el.getAttribute("data-title") || "" }) }],
  renderHTML: ({ node }) => ["div", { "data-video": "", "data-src": node.attrs.src, "data-url": node.attrs.url, "data-title": node.attrs.title }],
  addNodeView() {
    return ({ node }) => {
      const a = node.attrs;
      let dom;
      if (a.kind === "iframe" && isHttps(a.src)) {
        dom = h(
          "div",
          { class: "video-block" },
          h(
            "div",
            { class: "video-block__frame", style: `aspect-ratio:${a.width || 16} / ${a.height || 9}` },
            h("iframe", {
              src: a.src,
              title: a.title || "Video",
              loading: "lazy",
              allow: "autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write",
              allowfullscreen: true,
              referrerpolicy: "strict-origin-when-cross-origin",
            }),
          ),
        );
      } else {
        dom = h(
          "a",
          { class: "link-card", href: a.url || "#", target: "_blank", rel: "noopener noreferrer" },
          a.thumbnail ? h("img", { src: a.thumbnail, alt: "", loading: "lazy" }) : null,
          h("span", { class: "link-card__text" }, h("strong", {}, a.title || a.url), a.description ? h("span", { class: "muted small" }, a.description) : null, h("span", { class: "muted small" }, a.url)),
        );
      }
      return { dom, ignoreMutation: () => true, stopEvent: stopInputs };
    };
  },
});

// HTML embed: raw HTML in a sandboxed iframe. In the editor: a code field and a live preview.
export const HtmlEmbed = Node.create({
  name: "htmlEmbed",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({ html: { default: "" } }),
  parseHTML: () => [{ tag: "div[data-html-embed]", getAttrs: (el) => ({ html: el.getAttribute("data-html") || "" }) }],
  renderHTML: ({ node }) => ["div", { "data-html-embed": "", "data-html": node.attrs.html }],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const preview = h("div", { class: "html-embed__preview" }, htmlEmbedFrame(node.attrs.html));
      const dom = h("div", { class: "html-embed" });
      if (editor.isEditable) {
        const code = h("textarea", { class: "html-embed__code", spellcheck: "false", "aria-label": "HTML code", placeholder: "<iframe src=...></iframe> or any HTML" });
        code.value = node.attrs.html;
        let timer = null;
        code.addEventListener("input", () => {
          clearTimeout(timer);
          timer = setTimeout(() => setAttrs(editor, getPos, { html: code.value }), 600);
        });
        dom.append(h("div", { class: "block-controls block-controls--static", contenteditable: "false" }, h("span", { class: "small muted" }, "HTML embed: runs in a sandbox, without access to the handbook.")), code, h("div", { class: "small muted", style: "margin:8px 0 4px" }, "Preview"));
      }
      dom.append(preview);
      return {
        dom,
        update: (n) => {
          if (n.type.name !== "htmlEmbed") return false;
          if (n.attrs.html !== node.attrs.html) {
            node = n;
            preview.replaceChildren(htmlEmbedFrame(n.attrs.html));
          }
          return true;
        },
        stopEvent: stopInputs,
        ignoreMutation: () => true,
      };
    };
  },
});

// Callout: info, tip or warning, with rich content inside.
const CALLOUT_LABELS = { info: "Info", tip: "Tip", warning: "Warning" };
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({ variant: { default: "info", parseHTML: (el) => (["info", "tip", "warning"].includes(el.getAttribute("data-callout")) ? el.getAttribute("data-callout") : "info") } }),
  parseHTML: () => [{ tag: "aside[data-callout]" }],
  renderHTML: ({ node }) => ["aside", { "data-callout": node.attrs.variant, class: `callout callout--${node.attrs.variant}` }, 0],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const content = h("div", { class: "callout__content" });
      const label = h("span", { class: "callout__label", contenteditable: "false" }, CALLOUT_LABELS[node.attrs.variant]);
      const dom = h("aside", { class: `callout callout--${node.attrs.variant}`, role: "note" }, label, content);
      if (editor.isEditable) {
        const select = h("select", { class: "select callout__variant", "aria-label": "Callout type", contenteditable: "false" }, Object.entries(CALLOUT_LABELS).map(([v, l]) => h("option", { value: v, selected: v === node.attrs.variant }, l)));
        select.addEventListener("change", () => setAttrs(editor, getPos, { variant: select.value }));
        label.replaceChildren(select);
      }
      return {
        dom,
        contentDOM: content,
        update: (n) => {
          if (n.type.name !== "callout") return false;
          dom.className = `callout callout--${n.attrs.variant}`;
          if (!editor.isEditable) label.textContent = CALLOUT_LABELS[n.attrs.variant];
          return true;
        },
        stopEvent: stopInputs,
        ignoreMutation: (m) => !content.contains(m.target),
      };
    };
  },
});

// Collapsible section: a title line and rich content. "open" decides whether
// it starts open in View mode; in the editor it is always expanded.
export const DetailsSummary = Node.create({
  name: "detailsSummary",
  content: "inline*",
  defining: true,
  parseHTML: () => [{ tag: "summary" }],
  renderHTML: () => ["summary", { class: "collapsible__summary" }, 0],
});

export const DetailsContent = Node.create({
  name: "detailsContent",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-details-content]" }],
  renderHTML: () => ["div", { "data-details-content": "", class: "collapsible__content" }, 0],
});

export const Details = Node.create({
  name: "details",
  group: "block",
  content: "detailsSummary detailsContent",
  defining: true,
  addAttributes: () => ({ open: { default: false, parseHTML: (el) => el.hasAttribute("open") || el.getAttribute("data-open") === "true" } }),
  parseHTML: () => [{ tag: "details" }],
  renderHTML: ({ node }) => ["details", { "data-open": String(node.attrs.open), ...(node.attrs.open ? { open: "" } : {}) }, 0],
  addCommands() {
    return {
      // Inserts a closed collapsible section with the cursor in its title line.
      insertCollapsible:
        () =>
        ({ tr, state, dispatch }) => {
          const { details, detailsSummary, detailsContent, paragraph } = state.schema.nodes;
          const node = details.create({ open: false }, [detailsSummary.create(), detailsContent.create(null, paragraph.create())]);
          if (dispatch) placeInside(tr, node, 2);
          return true;
        },
    };
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const content = h("div", { class: "collapsible__body" });
      const dom = h("div", { class: "collapsible" });
      let expanded = editor.isEditable || node.attrs.open;
      const toggle = h("button", { class: "collapsible__toggle", type: "button", contenteditable: "false", "aria-expanded": String(expanded), "aria-label": "Show or hide this section" }, icon("chevronDown"));
      const setExpanded = (value) => {
        expanded = value;
        dom.classList.toggle("is-open", expanded);
        toggle.setAttribute("aria-expanded", String(expanded));
      };
      toggle.addEventListener("click", (e) => {
        e.preventDefault();
        setExpanded(!expanded);
      });
      dom.append(toggle, content);
      if (editor.isEditable) {
        const select = h(
          "select",
          { class: "select collapsible__setting", "aria-label": "In View mode, this section", contenteditable: "false" },
          h("option", { value: "closed", selected: !node.attrs.open }, "Starts closed"),
          h("option", { value: "open", selected: node.attrs.open }, "Starts open"),
        );
        select.addEventListener("change", () => setAttrs(editor, getPos, { open: select.value === "open" }));
        dom.append(h("div", { class: "block-controls collapsible__controls", contenteditable: "false" }, select));
      } else {
        // In View mode, clicking the title line toggles too.
        content.addEventListener("click", (e) => {
          if (e.target.closest(".collapsible__summary")) setExpanded(!expanded);
        });
      }
      setExpanded(expanded);
      return {
        dom,
        contentDOM: content,
        update: (n) => n.type.name === "details",
        stopEvent: stopInputs,
        ignoreMutation: (m) => !content.contains(m.target),
      };
    };
  },
});

export const CUSTOM_NODES = [Columns, Column, Figure, Pdf, FileAttachment, Video, HtmlEmbed, Callout, Details, DetailsSummary, DetailsContent];

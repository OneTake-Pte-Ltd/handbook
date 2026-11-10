// Editor toolbar (in the order of the brief), table controls, the small menu
// shown on a text selection, and the dialogs behind each button.

import { api, uploadFile } from "../api.js";
import { alertBox, busy, field, h, icon, input, openDialog, toast } from "../lib/dom.js";
import { EMOJIS } from "../lib/emoji.js";
import { fitImage } from "../lib/image.js";

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_FILE = 50 * 1024 * 1024;

function pickFile(accept) {
  return new Promise((resolve) => {
    const picker = h("input", { type: "file", accept, style: "display:none" });
    picker.addEventListener("change", () => {
      resolve(picker.files[0] || null);
      picker.remove();
    });
    document.body.append(picker);
    picker.click();
  });
}

async function withUpload(label, action) {
  toast(`${label}…`, { duration: 2500 });
  try {
    await action();
  } catch (e) {
    toast(e.message, { kind: "error", duration: 6000 });
  }
}

async function insertImage(editor) {
  const file = await pickFile("image/jpeg,image/png,image/webp,image/gif");
  if (!file) return;
  await withUpload("Uploading the image", async () => {
    const blob = await fitImage(file);
    if (blob.size > MAX_IMAGE) throw new Error("Images can be 10 MB at most.");
    const uploaded = await uploadFile(blob, file.name, "image");
    editor.chain().focus().insertContent({ type: "figure", attrs: { src: uploaded.url, alt: "", caption: "", width: "full" } }).run();
  });
}

async function insertUpload(editor, type, accept) {
  const file = await pickFile(accept);
  if (!file) return;
  if (file.size > MAX_FILE) return toast("Files can be 50 MB at most.", { kind: "error" });
  if (type === "pdf" && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) return toast("Please choose a PDF file.", { kind: "error" });
  await withUpload(`Uploading ${file.name}`, async () => {
    const uploaded = await uploadFile(file, file.name, "file");
    editor
      .chain()
      .focus()
      .insertContent({ type, attrs: { src: uploaded.url, name: file.name, size: uploaded.size_bytes, ...(type === "fileAttachment" ? { mime: uploaded.mime_type } : {}) } })
      .run();
  });
}

function linkDialog(editor) {
  const current = editor.getAttributes("link").href || "";
  const url = input({ type: "url", value: current, placeholder: "https://", inputmode: "url" });
  const error = alertBox();
  const save = h("button", { class: "button button--primary", type: "submit" }, "Save link");
  const remove = current ? h("button", { class: "button", type: "button" }, "Remove link") : null;
  const form = h("form", { class: "form" }, error.el, field({ label: "Web address", hint: "Links open in a new tab. Use https://, http:// or mailto:", input: url }), h("div", { class: "dialog__footer" }, remove, save));
  const dialog = openDialog({ title: current ? "Edit link" : "Add a link", content: form });
  url.focus();
  remove?.addEventListener("click", () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    dialog.close();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let href = url.value.trim();
    if (href && !/^(https?:|mailto:)/i.test(href)) href = /@/.test(href) && !/\//.test(href) ? `mailto:${href}` : `https://${href}`;
    if (!/^(https?:\/\/\S+|mailto:\S+)$/i.test(href)) return error.show("Please enter a full web address.");
    const chain = editor.chain().focus().extendMarkRange("link");
    if (editor.state.selection.empty && !current) chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    else chain.setLink({ href }).run();
    dialog.close();
  });
}

function videoDialog(editor) {
  const url = input({ type: "url", placeholder: "https://www.youtube.com/watch?v=...", inputmode: "url" });
  const error = alertBox();
  const add = h("button", { class: "button button--primary", type: "submit" }, "Add video");
  const form = h(
    "form",
    { class: "form" },
    error.el,
    field({ label: "Video address", hint: "YouTube, Vimeo, Loom, Wistia and most video pages work. For players that need custom code, use an HTML embed.", input: url }),
    h("div", { class: "dialog__footer" }, add),
  );
  const dialog = openDialog({ title: "Add a video", content: form });
  url.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.show("");
    await busy(add, async () => {
      try {
        const preview = await api("GET", `/embed-preview?url=${encodeURIComponent(url.value.trim())}`);
        editor.chain().focus().insertContent({ type: "video", attrs: preview }).run();
        if (preview.kind === "link") toast("No video player was found on that page, so a link card was added.");
        dialog.close();
      } catch (err) {
        error.show(err.message);
      }
    });
  });
}

function emojiDialog(editor) {
  const grid = h(
    "div",
    { class: "emoji-grid", role: "group", "aria-label": "Emojis" },
    EMOJIS.map((emoji) =>
      h(
        "button",
        {
          type: "button",
          "aria-label": `Insert ${emoji}`,
          onclick: () => {
            dialog.close();
            editor.chain().focus().insertContent(emoji).run();
          },
        },
        emoji,
      ),
    ),
  );
  const dialog = openDialog({ title: "Insert an emoji", content: grid });
}

function columnsDialog(editor) {
  const two = h("button", { class: "button", type: "button", onclick: () => pick(2) }, "2 columns");
  const three = h("button", { class: "button", type: "button", onclick: () => pick(3) }, "3 columns");
  const dialog = openDialog({ title: "Columns", content: h("div", { class: "form-actions" }, two, three) });
  function pick(n) {
    dialog.close();
    editor.chain().focus().insertColumns(n).run();
  }
}

function button(label, iconName, onClick, { isActive, text } = {}) {
  const el = h("button", { class: "toolbar__button", type: "button", title: label, "aria-label": label }, text ? h("span", { class: "toolbar__text" }, text) : icon(iconName));
  el.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor selection
  el.addEventListener("click", onClick);
  el.isActive = isActive;
  return el;
}

// Builds the toolbar for an editor. Returns the element; call update() on selection changes.
export function createToolbar(editor) {
  const c = () => editor.chain().focus();
  const buttons = [
    button("Heading 2", null, () => c().toggleHeading({ level: 2 }).run(), { text: "H2", isActive: () => editor.isActive("heading", { level: 2 }) }),
    button("Heading 3", null, () => c().toggleHeading({ level: 3 }).run(), { text: "H3", isActive: () => editor.isActive("heading", { level: 3 }) }),
    button("Bulleted list", "listBullet", () => c().toggleBulletList().run(), { isActive: () => editor.isActive("bulletList") }),
    button("Numbered list", "listOrdered", () => c().toggleOrderedList().run(), { isActive: () => editor.isActive("orderedList") }),
    button("Emoji", "emoji", () => emojiDialog(editor)),
    button("Table", "table", () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), { isActive: () => editor.isActive("table") }),
    button("Columns", "columns", () => columnsDialog(editor)),
    button("Link", "link", () => linkDialog(editor), { isActive: () => editor.isActive("link") }),
    button("Image", "image", () => insertImage(editor)),
    button("PDF", "pdf", () => insertUpload(editor, "pdf", "application/pdf,.pdf")),
    button("Video", "video", () => videoDialog(editor)),
    button("HTML embed", "embed", () => c().insertContent({ type: "htmlEmbed", attrs: { html: "" } }).run()),
    button("Callout", "callout", () => c().wrapIn("callout").run(), { isActive: () => editor.isActive("callout") }),
    button("File attachment", "paperclip", () => insertUpload(editor, "fileAttachment", "*/*")),
    button("Collapsible section", "collapsible", () => c().insertCollapsible().run()),
    button("Code block", "codeBlock", () => c().toggleCodeBlock().run(), { isActive: () => editor.isActive("codeBlock") }),
    button("Quote", "quote", () => c().toggleBlockquote().run(), { isActive: () => editor.isActive("blockquote") }),
    button("Divider", "divider", () => c().setHorizontalRule().run()),
    button("Undo", "undo", () => c().undo().run()),
    button("Redo", "redo", () => c().redo().run()),
  ];

  const tableBar = h(
    "div",
    { class: "toolbar toolbar--table", role: "toolbar", "aria-label": "Table", hidden: true },
    h("span", { class: "small muted" }, "Table:"),
    button("Add a row below", "rowAdd", () => c().addRowAfter().run()),
    button("Delete this row", "rowDelete", () => c().deleteRow().run()),
    button("Add a column to the right", "colAdd", () => c().addColumnAfter().run()),
    button("Delete this column", "colDelete", () => c().deleteColumn().run()),
    h("button", { class: "button button--ghost", type: "button", onmousedown: (e) => e.preventDefault(), onclick: () => c().deleteTable().run() }, "Delete table"),
  );

  const bar = h("div", { class: "toolbar", role: "toolbar", "aria-label": "Formatting" }, buttons);
  const el = h("div", { class: "toolbar-wrap" }, bar, tableBar);

  // Arrow keys move between toolbar buttons (one tab stop).
  bar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    e.preventDefault();
    buttons[(index + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length].focus();
  });
  buttons.forEach((b, i) => b.setAttribute("tabindex", i === 0 ? "0" : "-1"));

  function update() {
    for (const b of buttons) {
      if (!b.isActive) continue;
      const active = b.isActive();
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", String(active));
    }
    tableBar.hidden = !editor.isActive("table");
  }
  update();
  return { el, update };
}

// Small menu on a text selection: bold, italic, strikethrough, inline code, link.
export function createBubbleMenu(editor, container) {
  const c = () => editor.chain().focus();
  const items = [
    button("Bold (Ctrl+B)", "bold", () => c().toggleBold().run(), { isActive: () => editor.isActive("bold") }),
    button("Italic (Ctrl+I)", "italic", () => c().toggleItalic().run(), { isActive: () => editor.isActive("italic") }),
    button("Strikethrough", "strike", () => c().toggleStrike().run(), { isActive: () => editor.isActive("strike") }),
    button("Inline code", "code", () => c().toggleCode().run(), { isActive: () => editor.isActive("code") }),
    button("Link", "link", () => linkDialog(editor), { isActive: () => editor.isActive("link") }),
  ];
  const menu = h("div", { class: "bubble-menu", role: "toolbar", "aria-label": "Text formatting", hidden: true }, items);
  container.append(menu);

  function update() {
    const { state, view } = editor;
    const { empty, from, to } = state.selection;
    const isText = !empty && state.doc.textBetween(from, to, " ").trim().length > 0 && !state.selection.node;
    if (!isText || !view.hasFocus()) {
      menu.hidden = true;
      return;
    }
    for (const b of items) b.classList.toggle("is-active", b.isActive());
    menu.hidden = false;
    const start = view.coordsAtPos(from);
    const box = container.getBoundingClientRect();
    const left = Math.max(0, Math.min(start.left - box.left, box.width - menu.offsetWidth));
    menu.style.left = `${left}px`;
    menu.style.top = `${start.top - box.top - menu.offsetHeight - 8}px`;
  }
  editor.on("selectionUpdate", update);
  editor.on("blur", () => setTimeout(() => {
    if (!menu.contains(document.activeElement)) menu.hidden = true;
  }, 150));
  return { update };
}

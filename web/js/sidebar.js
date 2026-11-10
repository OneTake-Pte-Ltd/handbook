// Sidebar: the Edit toggle and the tree of spaces, categories and documents.
// In Edit mode, admins also manage spaces and categories here, and editors
// get "New document" and drag handles to reorder.

import { api } from "./api.js";
import { alertBox, busy, clear, confirmDialog, field, h, icon, input, openDialog, popupMenu, switchInput, toast } from "./lib/dom.js";
import { emojiPicker } from "./lib/emoji.js";
import { completionMark } from "./lib/marks.js";
import { moveItem, sortable } from "./lib/sortable.js";
import { contentChanged, isEditMode, session, setEditMode } from "./state.js";
import { openAccessPanel } from "./views/access.js";

const COLLAPSE_KEY = "handbook.collapsed";

function collapsedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveCollapsed(set) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    // Not remembered without storage.
  }
}

// A small form inside a dialog. fields: [{ name, label, value, hint }]
function formDialog({ title, fields, extra, submitLabel, onSubmit }) {
  const error = alertBox();
  const inputs = fields.map((f) => ({ ...f, el: input({ name: f.name, value: f.value || "", maxlength: f.max || 200 }) }));
  const submit = h("button", { class: "button button--primary", type: "submit" }, submitLabel);
  const form = h(
    "form",
    { class: "form", novalidate: true },
    error.el,
    inputs.map((f) => field({ label: f.label, hint: f.hint, input: f.el })),
    extra ? extra.el : null,
    h("div", { class: "dialog__footer" }, submit),
  );
  const dialog = openDialog({ title, content: form });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.show("");
    const values = Object.fromEntries(inputs.map((f) => [f.name, f.el.value]));
    if (extra) values[extra.name] = extra.input.value;
    await busy(submit, async () => {
      try {
        await onSubmit(values);
        dialog.close();
      } catch (e) {
        error.show(e.message);
      }
    });
  });
  inputs[0]?.el.focus();
}

export function newDocumentDialog(category) {
  formDialog({
    title: `New document in ${category.name}`,
    fields: [
      { name: "title", label: "Title" },
      { name: "description", label: "Description", hint: "Optional. One sentence about what this document covers.", max: 1000 },
    ],
    submitLabel: "Create document",
    onSubmit: async (values) => {
      const { document } = await api("POST", "/documents", { category_id: category.id, ...values });
      contentChanged();
      location.hash = `#/doc/${document.id}`;
    },
  });
}

function categoryDialog({ space, category }) {
  const picker = emojiPicker(category ? category.emoji : "📚");
  formDialog({
    title: category ? "Edit category" : `New category in ${space.name}`,
    fields: [{ name: "name", label: "Name", value: category ? category.name : "" }],
    extra: { name: "emoji", el: picker.el, input: picker.input },
    submitLabel: category ? "Save" : "Create category",
    onSubmit: async (values) => {
      if (category) await api("PATCH", `/categories/${category.id}`, values);
      else await api("POST", "/categories", { space_id: space.id, ...values });
      contentChanged();
    },
  });
}

function spaceDialog(space) {
  formDialog({
    title: space ? "Rename space" : "New space",
    fields: [{ name: "name", label: "Name", value: space ? space.name : "" }],
    submitLabel: space ? "Save" : "Create space",
    onSubmit: async (values) => {
      if (space) await api("PATCH", `/spaces/${space.id}`, values);
      else await api("POST", "/spaces", values);
      contentChanged();
    },
  });
}

async function reorder(type, ids) {
  try {
    await api("POST", "/reorder", { type, ids });
  } catch (e) {
    toast(e.message, { kind: "error" });
  }
  contentChanged();
}

export function createSidebar({ toolbar, body }) {
  let tree = null;
  let activeDocId = null;
  const collapsed = collapsedSet();

  function toggleRow(key, label, children) {
    const expanded = !collapsed.has(key);
    const list = h("ul", { hidden: !expanded });
    const button = h(
      "button",
      {
        class: "tree__toggle",
        type: "button",
        "aria-expanded": String(expanded),
        onclick: () => {
          const open = button.getAttribute("aria-expanded") !== "true";
          button.setAttribute("aria-expanded", String(open));
          list.hidden = !open;
          if (open) collapsed.delete(key);
          else collapsed.add(key);
          saveCollapsed(collapsed);
        },
      },
      icon("chevronDown"),
      label,
    );
    return { button, list };
  }

  function documentItem(category, doc, siblings) {
    const edit = isEditMode();
    const tag = !doc.is_published ? h("span", { class: "tree__tag" }, "Draft") : null;
    const link = h(
      "a",
      { class: "tree__doc", href: `#/doc/${doc.id}`, "aria-current": doc.id === activeDocId ? "page" : null, title: doc.title },
      h("span", { class: "tree__label" }, doc.title),
      tag,
      doc.is_published ? completionMark(doc.progress) : null,
    );
    const ids = siblings.map((d) => d.id);
    const canReorder = edit && category.can_create;
    return h(
      "li",
      { dataset: { id: String(doc.id) } },
      h(
        "div",
        { class: "tree__row" },
        link,
        canReorder
          ? popupMenu(
              [
                { label: "Move up", disabled: !moveItem(ids, doc.id, -1), onClick: () => reorder("document", moveItem(ids, doc.id, -1)) },
                { label: "Move down", disabled: !moveItem(ids, doc.id, 1), onClick: () => reorder("document", moveItem(ids, doc.id, 1)) },
              ],
              { label: `Actions for ${doc.title}` },
            )
          : null,
        canReorder ? h("span", { class: "small-icon-button drag-handle", "aria-hidden": "true", title: "Drag to reorder" }, icon("grip")) : null,
      ),
    );
  }

  function categoryItem(space, category, siblings) {
    const edit = isEditMode();
    const admin = tree.can_manage;
    const { button, list } = toggleRow(`c${category.id}`, h("span", { class: "tree__label" }, `${category.emoji ? `${category.emoji} ` : ""}${category.name}`), null);
    const ids = siblings.map((c) => c.id);
    const menuItems = [];
    if (edit && category.can_create) menuItems.push({ label: "New document", onClick: () => newDocumentDialog(category) });
    if (edit && admin) {
      menuItems.push(
        { label: "Edit name and emoji", onClick: () => categoryDialog({ category }) },
        { label: "Access", onClick: () => openAccessPanel({ type: "category", id: category.id, name: category.name }) },
        { label: "Move up", disabled: !moveItem(ids, category.id, -1), onClick: () => reorder("category", moveItem(ids, category.id, -1)) },
        { label: "Move down", disabled: !moveItem(ids, category.id, 1), onClick: () => reorder("category", moveItem(ids, category.id, 1)) },
        {
          label: "Delete category",
          danger: true,
          onClick: async () => {
            const count = category.documents.length;
            const ok = await confirmDialog({
              title: "Delete category",
              text: `Delete ${category.name}${count ? ` and its ${count} document${count === 1 ? "" : "s"}` : ""}? This can't be undone.`,
              confirmLabel: "Delete",
              danger: true,
            });
            if (!ok) return;
            try {
              await api("DELETE", `/categories/${category.id}`);
              contentChanged();
            } catch (e) {
              toast(e.message, { kind: "error" });
            }
          },
        },
      );
    }
    for (const doc of category.documents) list.append(documentItem(category, doc, category.documents));
    if (edit && category.can_create) {
      list.append(h("li", {}, h("button", { class: "tree__add", type: "button", onclick: () => newDocumentDialog(category) }, icon("plus"), "New document")));
    }
    if (edit && category.can_create) sortable(list, { handle: ".drag-handle", item: "li[data-id]", onEnd: (order) => reorder("document", order) });
    return h(
      "li",
      { class: "tree__category", dataset: { id: String(category.id) } },
      h(
        "div",
        { class: "tree__row" },
        button,
        menuItems.length ? popupMenu(menuItems, { label: `Actions for ${category.name}` }) : null,
        edit && admin ? h("span", { class: "small-icon-button drag-handle", "aria-hidden": "true", title: "Drag to reorder" }, icon("grip")) : null,
      ),
      list,
    );
  }

  function spaceItem(space, siblings) {
    const edit = isEditMode();
    const admin = tree.can_manage;
    const { button, list } = toggleRow(`s${space.id}`, h("span", { class: "tree__label" }, space.name));
    const ids = siblings.map((s) => s.id);
    for (const category of space.categories) list.append(categoryItem(space, category, space.categories));
    if (edit && admin) {
      list.append(h("li", {}, h("button", { class: "tree__add", type: "button", onclick: () => categoryDialog({ space }) }, icon("plus"), "New category")));
      sortable(list, { handle: ".drag-handle", item: "li.tree__category", onEnd: (order) => reorder("category", order) });
    }
    return h(
      "li",
      { class: "tree__space", dataset: { id: String(space.id) } },
      h(
        "div",
        { class: "tree__row" },
        button,
        edit && admin
          ? popupMenu(
              [
                { label: "New category", onClick: () => categoryDialog({ space }) },
                { label: "Rename space", onClick: () => spaceDialog(space) },
                { label: "Move up", disabled: !moveItem(ids, space.id, -1), onClick: () => reorder("space", moveItem(ids, space.id, -1)) },
                { label: "Move down", disabled: !moveItem(ids, space.id, 1), onClick: () => reorder("space", moveItem(ids, space.id, 1)) },
                {
                  label: "Delete space",
                  danger: true,
                  onClick: async () => {
                    const docs = space.categories.reduce((n, c) => n + c.documents.length, 0);
                    const ok = await confirmDialog({
                      title: "Delete space",
                      text: `Delete ${space.name}, its ${space.categories.length} categor${space.categories.length === 1 ? "y" : "ies"} and ${docs} document${docs === 1 ? "" : "s"}? This can't be undone.`,
                      confirmLabel: "Delete",
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      await api("DELETE", `/spaces/${space.id}`);
                      contentChanged();
                    } catch (e) {
                      toast(e.message, { kind: "error" });
                    }
                  },
                },
              ],
              { label: `Actions for ${space.name}` },
            )
          : null,
        edit && admin ? h("span", { class: "small-icon-button drag-handle", "aria-hidden": "true", title: "Drag to reorder" }, icon("grip")) : null,
      ),
      list,
    );
  }

  function render() {
    const edit = isEditMode();
    clear(
      toolbar,
      h("strong", { class: "small" }, "Documents"),
      session.me.can_edit
        ? switchInput({ checked: edit, label: "Edit", onchange: (on) => setEditMode(on) })
        : null,
    );
    if (!tree) return;
    if (!tree.spaces.length) {
      clear(
        body,
        h(
          "div",
          { class: "empty-state small" },
          icon("knowledge"),
          h("p", {}, edit && tree.can_manage ? "Start by creating a space, such as The Academy." : "Your handbook is empty for now."),
        ),
      );
    } else {
      const list = h("ul", { class: "tree" }, tree.spaces.map((s) => spaceItem(s, tree.spaces)));
      if (edit && tree.can_manage) sortable(list, { handle: ".drag-handle", item: "li.tree__space", onEnd: (order) => reorder("space", order) });
      clear(body, list);
    }
    if (edit && tree.can_manage) body.append(h("button", { class: "tree__add", type: "button", onclick: () => spaceDialog(null) }, icon("plus"), "New space"));
  }

  async function refresh() {
    try {
      tree = await api("GET", `/tree${isEditMode() ? "?mode=edit" : ""}`);
      if (session.me.can_edit !== tree.can_edit) session.me.can_edit = tree.can_edit;
    } catch (e) {
      if (e.status !== 401) toast(e.message, { kind: "error" });
      return;
    }
    render();
  }

  render();
  refresh();

  return {
    refresh,
    setActive(docId) {
      activeDocId = docId;
      for (const link of body.querySelectorAll(".tree__doc")) {
        if (link.getAttribute("href") === `#/doc/${docId}`) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      }
    },
    // Updates one document's mark without reloading everything.
    get tree() {
      return tree;
    },
  };
}

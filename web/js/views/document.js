// Document page: #/doc/:id and #/doc/:id/step/:stepId
// View mode: steps, content, "Mark as complete" and "Next step".
// Edit mode (if allowed): title, description, steps and their text, publishing.
// Milestone 3 uses a plain text box; the Tiptap editor replaces it in milestone 5.

import { api } from "../api.js";
import { alertBox, busy, clear, confirmDialog, field, h, icon, input, openDialog, popupMenu, setTitle, toast } from "../lib/dom.js";
import { longDateTime, relativeTime } from "../lib/format.js";
import { completionMark, statusLabel, stepMark } from "../lib/marks.js";
import { moveItem, sortable } from "../lib/sortable.js";
import { contentChanged, isEditMode, isLeader, isAdmin } from "../state.js";
import { openAccessPanel } from "./access.js";

// Renders Tiptap JSON. Milestone 3 only produces paragraphs and line breaks.
function renderContent(json) {
  const root = h("div", { class: "prose" });
  for (const block of (json && json.content) || []) {
    if (block.type !== "paragraph") continue;
    const p = h("p");
    for (const node of block.content || []) {
      if (node.type === "text") p.append(node.text);
      else if (node.type === "hardBreak") p.append(h("br"));
    }
    if (p.childNodes.length) root.append(p);
  }
  if (!root.childNodes.length) root.append(h("p", { class: "muted" }, "This step has no content yet."));
  return root;
}

function minutesToRead(steps) {
  const words = steps.reduce((n, s) => n + (s.content_text || "").split(/\s+/).filter(Boolean).length, 0);
  return Math.max(1, Math.round(words / 200));
}

export async function render(main, { path }) {
  const match = /^\/doc\/(\d+)(?:\/step\/(\d+))?$/.exec(path);
  const docId = Number(match[1]);
  const data = await api("GET", `/documents/${docId}`);
  const { document: doc, category, steps, permissions } = data;
  setTitle(doc.title);
  window.dispatchEvent(new CustomEvent("handbook:active-document", { detail: docId }));

  const editing = isEditMode() && permissions.can_edit;
  let stepIndex = Math.max(0, steps.findIndex((s) => s.id === Number(match[2])));
  if (match[2] && steps.findIndex((s) => s.id === Number(match[2])) < 0) stepIndex = 0;
  const step = steps[stepIndex];
  const stepUrl = (s) => `#/doc/${doc.id}/step/${s.id}`;
  const reload = () => {
    clear(main);
    return render(main, { path });
  };

  // Record the view (readers and editors alike), without waiting for it.
  if (step) api("POST", `/steps/${step.id}/view`).catch(() => {});

  // Header
  const badges = h(
    "div",
    { class: "doc-header__badges" },
    data.mandatory ? h("span", { class: "mandatory-label" }, "Mandatory") : null,
    doc.is_published ? h("span", { class: "status-badge" }, completionMark(data.progress), statusLabel(data.progress)) : h("span", { class: "badge" }, "Not published"),
  );
  main.append(
    h(
      "div",
      { class: "page", style: "max-width:1200px" },
      h(
        "header",
        { class: "doc-header" },
        h(
          "div",
          {},
          h("h1", { class: "doc-header__title" }, doc.title),
          h(
            "div",
            { class: "doc-header__meta" },
            h("span", {}, "In category ", h("strong", {}, `${category.emoji ? `${category.emoji} ` : ""}${category.name}`)),
            h("span", {}, `${steps.length} step${steps.length === 1 ? "" : "s"}`),
            h("span", {}, `${minutesToRead(steps)} min read`),
          ),
          doc.description ? h("p", { class: "small", style: "margin:8px 0 0" }, doc.description) : null,
        ),
        badges,
      ),
      editing ? editBar() : null,
      !doc.is_published ? h("div", { class: "alert alert--info", style: "margin-bottom:16px" }, "This document is not published. Readers can't see it yet.") : null,
      h("div", { class: "doc-layout" }, stepList(), editing ? stepEditor() : stepView()),
    ),
  );

  function stepList() {
    const select = h(
      "select",
      { class: "select", style: "width:100%", "aria-label": "Step", onchange: () => (location.hash = `#/doc/${doc.id}/step/${select.value}`) },
      steps.map((s, i) => h("option", { value: String(s.id), selected: i === stepIndex }, `${i + 1}. ${s.title}${s.completed ? " (completed)" : ""}`)),
    );
    const ids = steps.map((s) => s.id);
    const list = h(
      "ol",
      {},
      steps.map((s, i) => {
        const menu = [];
        if (!editing && s.completed && doc.is_published) {
          menu.push({ label: "Mark as not complete", onClick: () => setComplete(s, false) });
        }
        if (editing) {
          menu.push(
            { label: "Move up", disabled: !moveItem(ids, s.id, -1), onClick: () => reorderSteps(moveItem(ids, s.id, -1)) },
            { label: "Move down", disabled: !moveItem(ids, s.id, 1), onClick: () => reorderSteps(moveItem(ids, s.id, 1)) },
            { label: "Add a step after this one", onClick: () => addStep(s.id) },
            { label: "Delete step", danger: true, disabled: steps.length <= 1, onClick: () => deleteStep(s) },
          );
        }
        return h(
          "li",
          { class: "step-item", dataset: { id: String(s.id) } },
          h("a", { href: stepUrl(s), "aria-current": i === stepIndex ? "step" : null }, doc.is_published ? stepMark(s.completed) : null, h("span", { class: "tree__label" }, s.title)),
          menu.length ? popupMenu(menu, { label: `Actions for step ${s.title}` }) : null,
          editing ? h("span", { class: "small-icon-button drag-handle", "aria-hidden": "true", title: "Drag to reorder" }, icon("grip")) : null,
        );
      }),
    );
    if (editing) sortable(list, { handle: ".drag-handle", item: "li[data-id]", onEnd: reorderSteps });
    return h(
      "nav",
      { class: "step-list", "aria-label": "Steps" },
      data.progress.status === "completed" && doc.is_published
        ? h("div", { class: "completed-banner", role: "status" }, icon("check"), `Document completed at ${longDateTime(data.progress.completed_at)}`)
        : null,
      h("div", { class: "step-select" }, select),
      list,
      editing ? h("div", { style: "padding:8px" }, h("button", { class: "tree__add", type: "button", onclick: () => addStep(null) }, icon("plus"), "Add a step")) : null,
    );
  }

  function stepView() {
    const next = steps[stepIndex + 1];
    const completeButton = h(
      "button",
      { class: step.completed ? "button" : "button button--primary", type: "button", disabled: !doc.is_published },
      step.completed ? [icon("check"), "Completed"] : "Mark as complete",
    );
    completeButton.addEventListener("click", () => setComplete(step, !step.completed, next));
    return h(
      "article",
      { class: "step-content", "aria-labelledby": "step-title" },
      h(
        "div",
        { class: "step-content__header" },
        h("h2", { class: "step-content__title", id: "step-title" }, step.title),
        h("span", { class: "muted small" }, `Updated ${relativeTime(step.updated_at)}`),
      ),
      renderContent(step.content_json),
      h(
        "div",
        { class: "step-actions" },
        completeButton,
        next ? h("a", { class: "button", href: stepUrl(next) }, "Next step", icon("arrowRight")) : null,
      ),
    );
  }

  function stepEditor() {
    const error = alertBox();
    const title = input({ value: step.title, maxlength: 200 });
    const text = h("textarea", { class: "editor-textarea", "aria-label": "Step content" });
    text.value = step.content_text || "";
    const save = h("button", { class: "button button--primary", type: "submit" }, "Save step");
    const status = h("span", { class: "muted small", role: "status" });
    let dirty = false;
    text.addEventListener("input", () => {
      dirty = true;
      status.textContent = "Unsaved changes";
    });
    title.addEventListener("input", () => {
      dirty = true;
      status.textContent = "Unsaved changes";
    });
    const form = h(
      "form",
      {
        class: "step-content form",
        onsubmit: async (event) => {
          event.preventDefault();
          error.show("");
          await busy(save, async () => {
            try {
              await api("PATCH", `/steps/${step.id}`, { title: title.value, content_text: text.value });
              dirty = false;
              status.textContent = "Saved";
              step.title = title.value;
              contentChanged();
            } catch (e) {
              error.show(e.message);
            }
          });
        },
      },
      error.el,
      field({ label: "Step title", input: title }),
      h(
        "div",
        { class: "field" },
        h("label", { class: "field__label", for: "step-text" }, "Content"),
        h("div", { class: "field__hint" }, "Plain text for now: leave an empty line between paragraphs. The full editor arrives in milestone 5."),
        text,
      ),
      h("div", { class: "form-actions" }, save, status),
    );
    text.id = "step-text";
    form.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    return form;
  }

  function editBar() {
    const items = [];
    items.push(h("button", { class: "button", type: "button", onclick: editDetails }, icon("edit"), "Title and description"));
    if (permissions.can_publish) {
      items.push(
        doc.is_published
          ? h("button", { class: "button button--primary", type: "button", onclick: publishDialog }, "Publish changes")
          : h("button", { class: "button button--primary", type: "button", onclick: () => publish("minor") }, "Publish"),
      );
    }
    const more = [];
    if (permissions.can_manage_access && (isAdmin() || isLeader())) more.push({ label: "Access", onClick: () => openAccessPanel({ type: "document", id: doc.id, name: doc.title }) });
    if (permissions.can_publish && doc.is_published) more.push({ label: "Unpublish", onClick: unpublish });
    if (permissions.can_delete) more.push({ label: "Delete document", danger: true, onClick: deleteDocument });
    return h(
      "div",
      { class: "edit-bar", role: "toolbar", "aria-label": "Document editing" },
      h("strong", { class: "small" }, "Edit mode"),
      h("span", { class: "edit-bar__spacer" }),
      items,
      more.length ? popupMenu(more, { label: "More document actions", className: "icon-button" }) : null,
    );
  }

  function editDetails() {
    const error = alertBox();
    const title = input({ value: doc.title, maxlength: 200 });
    const description = h("textarea", { class: "input", rows: 3, maxlength: 1000 });
    description.value = doc.description || "";
    const save = h("button", { class: "button button--primary", type: "submit" }, "Save");
    const form = h("form", { class: "form" }, error.el, field({ label: "Title", input: title }), field({ label: "Description", hint: "Optional.", input: description }), h("div", { class: "dialog__footer" }, save));
    const dialog = openDialog({ title: "Title and description", content: form });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await busy(save, async () => {
        try {
          await api("PATCH", `/documents/${doc.id}`, { title: title.value, description: description.value });
          dialog.close();
          contentChanged();
          await reload();
        } catch (e) {
          error.show(e.message);
        }
      });
    });
  }

  function publishDialog() {
    const minor = h("input", { type: "radio", name: "revision", value: "minor", checked: true });
    const major = h("input", { type: "radio", name: "revision", value: "major" });
    const ok = h("button", { class: "button button--primary", type: "submit" }, "Publish");
    const form = h(
      "form",
      { class: "form" },
      h("label", { class: "check" }, minor, h("span", {}, h("strong", {}, "Minor revision"), h("span", { class: "muted small" }, " (no re-reading needed)"))),
      h("label", { class: "check" }, major, h("span", {}, h("strong", {}, "Major revision"), h("span", { class: "muted small" }, " (everyone must complete it again)"))),
      h("div", { class: "dialog__footer" }, ok),
    );
    const dialog = openDialog({ title: "Publish changes", content: form });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      dialog.close();
      await publish(major.checked ? "major" : "minor");
    });
  }

  async function publish(revision) {
    try {
      await api("POST", `/documents/${doc.id}/publish`, { publish: true, revision });
      toast(revision === "major" ? "Published as a major revision. Everyone must complete it again." : "Published.");
      contentChanged();
      await reload();
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }

  async function unpublish() {
    if (!(await confirmDialog({ title: "Unpublish", text: "Readers won't see this document until it is published again.", confirmLabel: "Unpublish" }))) return;
    try {
      await api("POST", `/documents/${doc.id}/publish`, { publish: false });
      contentChanged();
      await reload();
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }

  async function deleteDocument() {
    if (!(await confirmDialog({ title: "Delete document", text: `Delete ${doc.title} and its ${steps.length} step${steps.length === 1 ? "" : "s"}? Reading history for it is deleted too. This can't be undone.`, confirmLabel: "Delete", danger: true }))) return;
    try {
      await api("DELETE", `/documents/${doc.id}`);
      contentChanged();
      location.hash = "#/";
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }

  async function setComplete(target, complete, next) {
    try {
      await api(complete ? "POST" : "DELETE", `/steps/${target.id}/complete`);
      contentChanged();
      if (complete && next) location.hash = stepUrl(next);
      else await reload();
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }

  async function reorderSteps(ids) {
    try {
      await api("POST", "/reorder", { type: "step", ids });
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
    await reload();
  }

  function addStep(afterId) {
    const error = alertBox();
    const title = input({ maxlength: 200 });
    const save = h("button", { class: "button button--primary", type: "submit" }, "Add step");
    const form = h("form", { class: "form" }, error.el, field({ label: "Step title", input: title }), h("div", { class: "dialog__footer" }, save));
    const dialog = openDialog({ title: "New step", content: form });
    title.focus();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await busy(save, async () => {
        try {
          const { step: created } = await api("POST", `/documents/${doc.id}/steps`, { title: title.value, after_step_id: afterId });
          dialog.close();
          location.hash = `#/doc/${doc.id}/step/${created.id}`;
        } catch (e) {
          error.show(e.message);
        }
      });
    });
  }

  async function deleteStep(target) {
    if (!(await confirmDialog({ title: "Delete step", text: `Delete the step "${target.title}"? This can't be undone.`, confirmLabel: "Delete", danger: true }))) return;
    try {
      await api("DELETE", `/steps/${target.id}`);
      if (location.hash === `#/doc/${doc.id}`) await reload();
      else location.hash = `#/doc/${doc.id}`;
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }
}

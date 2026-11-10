// Document page: #/doc/:id and #/doc/:id/step/:stepId
// View mode: steps, content (read-only Tiptap), "Mark as complete", "Next step".
// Edit mode, for members who can edit: see document-edit.js.

import { api } from "../api.js";
import { clear, h, icon, popupMenu, setTitle, toast } from "../lib/dom.js";
import { longDateTime, relativeTime } from "../lib/format.js";
import { completionMark, statusLabel, stepMark } from "../lib/marks.js";
import { contentChanged, isEditMode } from "../state.js";

export function minutesToRead(steps) {
  const words = steps.reduce((n, s) => n + (s.content_text || "").split(/\s+/).filter(Boolean).length, 0);
  return Math.max(1, Math.round(words / 200));
}

export function documentHeader({ title, description, category, steps, badges }) {
  return h(
    "header",
    { class: "doc-header" },
    h(
      "div",
      {},
      h("h1", { class: "doc-header__title" }, title),
      h(
        "div",
        { class: "doc-header__meta" },
        h("span", {}, "In category ", h("strong", {}, `${category.emoji ? `${category.emoji} ` : ""}${category.name}`)),
        steps ? h("span", {}, `${steps.length} step${steps.length === 1 ? "" : "s"}`) : null,
        steps ? h("span", {}, `${minutesToRead(steps)} min read`) : null,
      ),
      description ? h("p", { class: "small", style: "margin:8px 0 0" }, description) : null,
    ),
    badges,
  );
}

export async function render(main, { path }) {
  const match = /^\/doc\/(\d+)(?:\/step\/([\w-]+))?$/.exec(path);
  const docId = Number(match[1]);
  const data = await api("GET", `/documents/${docId}`);
  window.dispatchEvent(new CustomEvent("handbook:active-document", { detail: docId }));

  if (isEditMode() && data.permissions.can_edit) {
    const { renderEditor } = await import("./document-edit.js");
    return renderEditor(main, { data, stepParam: match[2] || null, path });
  }
  return renderView(main, data, match[2] ? Number(match[2]) : null, path);
}

async function renderView(main, data, stepId, path) {
  const { document: doc, category, steps } = data;
  setTitle(doc.title);
  const index = Math.max(0, steps.findIndex((s) => s.id === stepId));
  const step = steps[index];
  const stepUrl = (s) => `#/doc/${doc.id}/step/${s.id}`;
  const reload = () => {
    clear(main);
    return renderView(main, data, stepId, path).catch(() => {});
  };
  if (step) api("POST", `/steps/${step.id}/view`).catch(() => {});

  const badges = h(
    "div",
    { class: "doc-header__badges" },
    data.mandatory ? h("span", { class: "mandatory-label" }, "Mandatory") : null,
    doc.is_published ? h("span", { class: "status-badge" }, completionMark(data.progress), statusLabel(data.progress)) : h("span", { class: "badge" }, "Not published"),
  );

  const content = h("div", { class: "step-content__body" });
  const next = steps[index + 1];
  const completeButton = h(
    "button",
    { class: step.completed ? "button" : "button button--primary", type: "button", disabled: !doc.is_published },
    step.completed ? [icon("check"), "Completed"] : "Mark as complete",
  );
  completeButton.addEventListener("click", () => setComplete(step, !step.completed, next));

  const list = h(
    "ol",
    {},
    steps.map((s, i) =>
      h(
        "li",
        { class: "step-item" },
        h("a", { href: stepUrl(s), "aria-current": i === index ? "step" : null }, doc.is_published ? stepMark(s.completed) : null, h("span", { class: "tree__label" }, s.title)),
        s.completed && doc.is_published ? popupMenu([{ label: "Mark as not complete", onClick: () => setComplete(s, false) }], { label: `Actions for step ${s.title}` }) : null,
      ),
    ),
  );
  const select = h(
    "select",
    { class: "select", style: "width:100%", "aria-label": "Step", onchange: () => (location.hash = `#/doc/${doc.id}/step/${select.value}`) },
    steps.map((s, i) => h("option", { value: String(s.id), selected: i === index }, `${i + 1}. ${s.title}${s.completed ? " (completed)" : ""}`)),
  );

  main.append(
    h(
      "div",
      { class: "page page--document" },
      documentHeader({ title: doc.title, description: doc.description, category, steps, badges }),
      data.draft && data.permissions.can_edit
        ? h("div", { class: "alert alert--info", style: "margin-bottom:16px" }, data.draft.status === "submitted" ? "Changes to this document are waiting for review. Turn on Edit to see them." : "Someone is working on changes to this document. Readers still see this version. Turn on Edit to see the draft.")
        : null,
      !doc.is_published ? h("div", { class: "alert alert--info", style: "margin-bottom:16px" }, "This document is not published. Readers can't see it yet.") : null,
      h(
        "div",
        { class: "doc-layout" },
        h(
          "nav",
          { class: "step-list", "aria-label": "Steps" },
          data.progress.status === "completed" && doc.is_published
            ? h("div", { class: "completed-banner", role: "status" }, icon("check"), `Document completed at ${longDateTime(data.progress.completed_at)}`)
            : null,
          h("div", { class: "step-select" }, select),
          list,
        ),
        h(
          "article",
          { class: "step-content", "aria-labelledby": "step-title" },
          h("div", { class: "step-content__header" }, h("h2", { class: "step-content__title", id: "step-title" }, step.title), h("span", { class: "muted small" }, `Updated ${relativeTime(step.updated_at)}`)),
          content,
          h("div", { class: "step-actions" }, completeButton, next ? h("a", { class: "button", href: stepUrl(next) }, "Next step", icon("arrowRight")) : null),
        ),
      ),
    ),
  );

  // Read-only Tiptap with the same blocks as the editor (loaded on demand).
  const { renderReadOnly } = await import("../editor/setup.js");
  renderReadOnly(content, step.content_json);

  async function setComplete(target, complete, nextStep) {
    try {
      await api(complete ? "POST" : "DELETE", `/steps/${target.id}/complete`);
      contentChanged();
      if (complete && nextStep) {
        location.hash = stepUrl(nextStep);
      } else {
        const fresh = await api("GET", `/documents/${doc.id}`);
        Object.assign(data, fresh);
        reload();
      }
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }
}

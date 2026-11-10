// Edit mode of a document: everything happens in the document's draft.
// - Autosave a moment after each change, with optimistic concurrency.
// - Steps: add, rename, reorder (drag or Move up/down), delete.
// - Publish (Edit and publish) or Submit for review (Edit with review).
// - Review mode for reviewers: compare with the published version, approve or reject.

import { api } from "../api.js";
import { alertBox, busy, clear, confirmDialog, field, h, icon, input, openDialog, popupMenu, setTitle, toast } from "../lib/dom.js";
import { relativeTime } from "../lib/format.js";
import { moveItem, sortable } from "../lib/sortable.js";
import { contentChanged, isAdmin, isLeader } from "../state.js";
import { openAccessPanel } from "./access.js";
import { documentHeader } from "./document.js";

const SAVE_DELAY = 1500;
const emptyDoc = () => ({ type: "doc", content: [{ type: "paragraph" }] });
const newKey = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function rerender() {
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function revisionChoice(defaultValue = "minor") {
  const minor = h("input", { type: "radio", name: "revision", value: "minor", checked: defaultValue !== "major" });
  const major = h("input", { type: "radio", name: "revision", value: "major", checked: defaultValue === "major" });
  return {
    el: h(
      "fieldset",
      { class: "field" },
      h("legend", { class: "field__label" }, "Type of change"),
      h("label", { class: "check" }, minor, h("span", {}, h("strong", {}, "Minor revision"), h("span", { class: "muted small" }, " (no re-reading needed)"))),
      h("label", { class: "check" }, major, h("span", {}, h("strong", {}, "Major revision"), h("span", { class: "muted small" }, " (everyone must complete it again)"))),
    ),
    value: () => (major.checked ? "major" : "minor"),
  };
}

// Compares the draft with the published version, step by step.
function stepFlags(snapshot, published) {
  const before = new Map((published ? published.steps : []).map((s) => [s.id, s]));
  const flags = new Map();
  for (const step of snapshot.steps) {
    const old = step.id ? before.get(step.id) : null;
    if (!old) flags.set(step.key, "added");
    else if (old.title !== step.title || JSON.stringify(old.content_json) !== JSON.stringify(step.content_json)) flags.set(step.key, "changed");
  }
  const kept = new Set(snapshot.steps.map((s) => s.id).filter(Boolean));
  const removed = published ? published.steps.filter((s) => !kept.has(s.id)) : [];
  return { flags, removed };
}

const FLAG_LABELS = { added: "Added", changed: "Changed", removed: "Removed" };

export async function renderEditor(main, { data, stepParam }) {
  const { document: doc, category } = data;
  const state = await api("GET", `/documents/${doc.id}/draft`);
  const draft = state.draft;
  const snapshot = draft ? draft.snapshot : state.snapshot;
  for (const s of snapshot.steps) if (!s.key) s.key = s.id ? `s${s.id}` : newKey();
  setTitle(snapshot.title, "Edit");

  const key = stepParam ? (/^\d+$/.test(stepParam) ? `s${stepParam}` : stepParam) : null;
  const startIndex = Math.max(0, snapshot.steps.findIndex((s) => s.key === key));

  if (draft && draft.status === "submitted") {
    return state.permissions.can_review ? renderReview(main, { data, state, snapshot, startIndex }) : renderWaiting(main, { data, state, snapshot, startIndex });
  }
  return renderEditing(main, { data, state, snapshot, startIndex, category, doc });
}

// Read-only list of steps plus content, used by review and waiting screens.
async function readOnlySteps(container, { snapshot, startIndex, flags, removed = [] }) {
  const { renderReadOnly } = await import("../editor/setup.js");
  let current = null;
  const body = h("div", { class: "step-content__body" });
  const title = h("h2", { class: "step-content__title" });
  const tag = h("span");
  const items = [];
  const all = [...snapshot.steps.map((s) => ({ ...s, flag: flags ? flags.get(s.key) : null })), ...removed.map((s) => ({ ...s, key: `r${s.id}`, flag: "removed" }))];
  function show(i) {
    const step = all[i];
    if (container.querySelector(".step-select select")) container.querySelector(".step-select select").value = String(i);
    items.forEach((el, j) => (j === i ? el.setAttribute("aria-current", "step") : el.removeAttribute("aria-current")));
    title.textContent = step.title;
    tag.replaceChildren(step.flag ? h("span", { class: `change-tag change-tag--${step.flag}` }, FLAG_LABELS[step.flag]) : "");
    if (current) current.destroy();
    clear(body);
    current = renderReadOnly(body, step.content_json);
  }
  const list = h(
    "ol",
    {},
    all.map((s, i) => {
      const a = h("a", { href: "#", onclick: (e) => (e.preventDefault(), show(i)) }, h("span", { class: "tree__label" }, s.title), s.flag ? h("span", { class: `change-tag change-tag--${s.flag}` }, FLAG_LABELS[s.flag]) : null);
      items.push(a);
      return h("li", { class: "step-item" }, a);
    }),
  );
  const select = h(
    "select",
    { class: "select", style: "width:100%", "aria-label": "Step", onchange: () => show(Number(select.value)) },
    all.map((st, i) => h("option", { value: String(i) }, `${i + 1}. ${st.title}${st.flag ? ` (${FLAG_LABELS[st.flag]})` : ""}`)),
  );
  container.append(
    h(
      "div",
      { class: "doc-layout" },
      h("nav", { class: "step-list", "aria-label": "Steps" }, h("div", { class: "step-select" }, select), list),
      h("article", { class: "step-content" }, h("div", { class: "step-content__header" }, title, tag), body),
    ),
  );
  show(Math.min(startIndex, all.length - 1));
}

function renderWaiting(main, { data, state, snapshot, startIndex }) {
  const page = h(
    "div",
    { class: "page page--document" },
    documentHeader({ title: snapshot.title, description: snapshot.description, category: data.category, badges: h("span", { class: "badge" }, "In review") }),
    h(
      "div",
      { class: "alert alert--info", style: "margin-bottom:16px" },
      `${state.draft.author ? state.draft.author.name : "Someone"} submitted these changes for review ${relativeTime(state.draft.submitted_at)}. The draft is read-only until a reviewer approves or rejects it.`,
    ),
  );
  main.append(page);
  return readOnlySteps(page, { snapshot, startIndex });
}

function renderReview(main, { data, state, snapshot, startIndex }) {
  const { flags, removed } = stepFlags(snapshot, state.published);
  const d = state.draft;
  const approve = h("button", { class: "button button--primary", type: "button" }, "Approve and publish");
  const reject = h("button", { class: "button button--danger", type: "button" }, "Reject");
  approve.addEventListener("click", () => {
    const choice = revisionChoice(d.revision_type || "minor");
    const ok = h("button", { class: "button button--primary", type: "submit" }, "Approve and publish");
    const form = h("form", { class: "form" }, h("p", { style: "margin:0" }, `${d.author ? d.author.name : "The author"} proposed a ${d.revision_type || "minor"} revision. You can change it.`), choice.el, h("div", { class: "dialog__footer" }, ok));
    const dialog = openDialog({ title: "Approve these changes", content: form });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await busy(ok, async () => {
        try {
          await api("POST", `/documents/${data.document.id}/draft/approve`, { revision_type: choice.value() });
          dialog.close();
          toast("Approved and published.");
          contentChanged();
          rerender();
        } catch (err) {
          toast(err.message, { kind: "error" });
        }
      });
    });
  });
  reject.addEventListener("click", () => {
    const comment = h("textarea", { class: "input", rows: 4, maxlength: 4000, required: true });
    const error = alertBox();
    const ok = h("button", { class: "button button--danger", type: "submit" }, "Reject");
    const form = h("form", { class: "form" }, error.el, field({ label: "What needs to change?", hint: "The author sees this comment.", input: comment }), h("div", { class: "dialog__footer" }, ok));
    const dialog = openDialog({ title: "Reject these changes", content: form });
    comment.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!comment.value.trim()) return error.show("Please explain what needs to change.");
      await busy(ok, async () => {
        try {
          await api("POST", `/documents/${data.document.id}/draft/reject`, { comment: comment.value });
          dialog.close();
          toast("Sent back to the author.");
          contentChanged();
          rerender();
        } catch (err) {
          error.show(err.message);
        }
      });
    });
  });
  const changes = flags.size + removed.length;
  const page = h(
    "div",
    { class: "page page--document" },
    documentHeader({ title: snapshot.title, description: snapshot.description, category: data.category, badges: h("span", { class: "badge badge--accent" }, "Review") }),
    h(
      "div",
      { class: "edit-bar", role: "toolbar", "aria-label": "Review" },
      h(
        "div",
        { style: "flex:1;min-width:220px" },
        h("strong", { class: "small" }, `Review requested by ${d.author ? d.author.name : "an editor"}, ${relativeTime(d.submitted_at)}`),
        h("div", { class: "small muted" }, `Proposed: ${d.revision_type || "minor"} revision. ${changes} step${changes === 1 ? "" : "s"} changed, added or removed.${snapshot.title !== (state.published && state.published.title) && state.published ? " The title changed." : ""}`),
        d.submit_note ? h("div", { class: "small", style: "margin-top:4px" }, `Note: ${d.submit_note}`) : null,
      ),
      reject,
      approve,
    ),
  );
  main.append(page);
  return readOnlySteps(page, { snapshot, startIndex, flags, removed });
}

async function renderEditing(main, { data, state, snapshot, startIndex, category, doc }) {
  const { createEditor } = await import("../editor/setup.js");
  const { createBubbleMenu, createToolbar } = await import("../editor/toolbar.js");
  const permissions = state.permissions;
  let draft = state.draft;
  let updatedAt = draft ? draft.updated_at : null;
  let index = startIndex;
  let dirty = false;
  let saving = false;
  let again = false;
  let timer = null;
  let editor = null;
  let conflict = false;

  // Save status
  const status = h("span", { class: "save-status", role: "status", "aria-live": "polite" }, draft ? `Draft saved ${relativeTime(draft.updated_at)}` : "No changes yet");
  const setStatus = (text) => (status.textContent = text);
  const resolveButton = h("button", { class: "button button--danger", type: "button", hidden: true, onclick: () => resolveConflict() }, "Resolve");

  function sync() {
    if (editor) snapshot.steps[index].content_json = editor.getJSON();
  }
  function changed() {
    dirty = true;
    clearTimeout(timer);
    if (conflict) return; // waiting for the user to choose which version to keep
    setStatus("Unsaved changes");
    timer = setTimeout(save, SAVE_DELAY);
  }

  // Someone else saved, published or discarded the draft while this person
  // was editing. Their own changes stay in the editor until they choose.
  function resolveConflict() {
    const keep = h("button", { class: "button button--primary", type: "button" }, "Keep my version");
    const theirs = h("button", { class: "button", type: "button" }, "Load the latest version");
    const dialog = openDialog({
      title: "Someone else changed this draft",
      content: [
        h("p", { style: "margin-top:0" }, "Another editor saved, published or discarded this draft while you were editing. Your changes are still here and are not saved yet."),
        h("ul", { class: "small" }, h("li", {}, h("strong", {}, "Keep my version: "), "save your version over theirs. Their changes since you opened the draft are replaced."), h("li", {}, h("strong", {}, "Load the latest version: "), "see their version. Your unsaved changes are lost.")),
        h("div", { class: "dialog__footer" }, theirs, keep),
      ],
    });
    keep.addEventListener("click", () =>
      busy(keep, async () => {
        try {
          const latest = await api("GET", `/documents/${doc.id}/draft`);
          if (latest.draft && latest.draft.status === "submitted") {
            toast("The draft is now waiting for review, so it can't be changed. Copy your text before loading the latest version.", { kind: "error", duration: 8000 });
            return;
          }
          updatedAt = latest.draft ? latest.draft.updated_at : null;
          // Steps that were published in the meantime may have new ids; keep ours as new.
          const known = new Set((latest.draft ? latest.draft.snapshot.steps : latest.snapshot.steps).map((st) => st.id).filter(Boolean));
          for (const st of snapshot.steps) if (st.id && !known.has(st.id)) st.id = null;
          conflict = false;
          resolveButton.hidden = true;
          dialog.close();
          dirty = true;
          await save();
          if (!conflict) toast("Your version is saved.");
        } catch (err) {
          toast(err.message, { kind: "error" });
        }
      }),
    );
    theirs.addEventListener("click", () => {
      dirty = false;
      conflict = false;
      dialog.close();
      rerender();
    });
  }
  async function save() {
    clearTimeout(timer);
    if (saving) {
      again = true;
      return;
    }
    if (!dirty) return;
    saving = true;
    dirty = false;
    sync();
    setStatus("Saving");
    try {
      const result = await api("PUT", `/documents/${doc.id}/draft`, { snapshot, base_updated_at: updatedAt });
      updatedAt = result.updated_at;
      if (result.created) draft = { status: "editing" };
      setStatus("All changes saved");
      if (result.created) contentChanged();
    } catch (e) {
      if (e.code === "draft_conflict") {
        // Never throw away the user's work: keep it and let them choose.
        saving = false;
        dirty = true;
        conflict = true;
        setStatus("Not saved: someone else saved this draft");
        resolveButton.hidden = false;
        resolveConflict();
        return;
      }
      dirty = true;
      setStatus(`Not saved: ${e.message}`);
    }
    saving = false;
    if (again || dirty) {
      again = false;
      timer = setTimeout(save, SAVE_DELAY);
    }
  }
  async function flush() {
    clearTimeout(timer);
    if (conflict) throw new Error("Resolve the conflict with the other editor first.");
    while (saving) await new Promise((r) => setTimeout(r, 100));
    if (dirty) await save();
  }
  const beforeUnload = (e) => {
    if (dirty || saving) e.preventDefault();
  };
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener(
    "hashchange",
    () => {
      flush().catch(() => {});
      window.removeEventListener("beforeunload", beforeUnload);
      if (editor) setTimeout(() => editor.destroy(), 0);
    },
    { once: true },
  );

  // Title and description
  const titleInput = h("input", { class: "doc-title-input", value: snapshot.title, maxlength: 200, "aria-label": "Document title" });
  titleInput.addEventListener("input", () => {
    snapshot.title = titleInput.value;
    changed();
  });
  const descriptionInput = h("textarea", { class: "doc-description-input", rows: 2, maxlength: 1000, placeholder: "Description (optional)", "aria-label": "Document description" });
  descriptionInput.value = snapshot.description || "";
  descriptionInput.addEventListener("input", () => {
    snapshot.description = descriptionInput.value;
    changed();
  });

  // Banners
  const banners = [];
  if (draft && draft.author && !permissions.is_author) banners.push(h("div", { class: "alert alert--info" }, `Draft started by ${draft.author.name}. You are editing the same draft.`));
  if (draft && draft.status === "rejected" && draft.review_comment) {
    banners.push(h("div", { class: "alert alert--error", role: "alert" }, h("div", {}, h("strong", {}, `Changes requested by ${draft.reviewer ? draft.reviewer.name : "a reviewer"}: `), draft.review_comment)));
  }
  if (!doc.is_published) banners.push(h("div", { class: "alert alert--info" }, "This document is not published yet. Readers will see it once it is published."));

  // Actions
  const actions = [];
  if (permissions.can_publish) actions.push(h("button", { class: "button button--primary", type: "button", onclick: publishDialog }, doc.is_published ? "Publish changes" : "Publish"));
  else actions.push(h("button", { class: "button button--primary", type: "button", onclick: submitDialog }, "Submit for review"));
  const more = [];
  if (draft) more.push({ label: "Discard draft", danger: true, onClick: discard });
  if (isAdmin() || isLeader()) more.push({ label: "Access", onClick: () => openAccessPanel({ type: "document", id: doc.id, name: snapshot.title }) });
  if (permissions.level === "edit_publish" && doc.is_published) more.push({ label: "Unpublish", onClick: unpublish });
  if (data.permissions.can_delete) more.push({ label: "Delete document", danger: true, onClick: deleteDocument });

  // Steps
  const stepList = h("ol", {});
  const stepTitle = h("input", { class: "step-title-input", maxlength: 200, "aria-label": "Step title" });
  stepTitle.addEventListener("input", () => {
    snapshot.steps[index].title = stepTitle.value;
    const label = stepList.children[index]?.querySelector(".tree__label");
    if (label) label.textContent = stepTitle.value || "Untitled step";
    changed();
  });

  const stepSelect = h("select", { class: "select", style: "width:100%", "aria-label": "Step" });
  stepSelect.addEventListener("change", () => selectStep(Number(stepSelect.value)));

  function renderStepList() {
    clear(stepSelect, snapshot.steps.map((s, i) => h("option", { value: String(i), selected: i === index }, `${i + 1}. ${s.title || "Untitled step"}`)));
    const keys = snapshot.steps.map((s) => s.key);
    clear(
      stepList,
      snapshot.steps.map((s, i) =>
        h(
          "li",
          { class: "step-item", dataset: { id: s.key } },
          h("a", { href: "#", "aria-current": i === index ? "step" : null, onclick: (e) => (e.preventDefault(), selectStep(i)) }, h("span", { class: "tree__label" }, s.title || "Untitled step")),
          popupMenu(
            [
              { label: "Move up", disabled: !moveItem(keys, s.key, -1), onClick: () => reorder(moveItem(keys, s.key, -1)) },
              { label: "Move down", disabled: !moveItem(keys, s.key, 1), onClick: () => reorder(moveItem(keys, s.key, 1)) },
              { label: "Add a step after this one", onClick: () => addStep(i) },
              { label: "Delete step", danger: true, disabled: snapshot.steps.length <= 1, onClick: () => deleteStep(i) },
            ],
            { label: `Actions for step ${s.title}` },
          ),
          h("span", { class: "small-icon-button drag-handle", "aria-hidden": "true", title: "Drag to reorder" }, icon("grip")),
        ),
      ),
    );
  }
  // Sortable works on data-id; steps use string keys.
  sortable(stepList, { handle: ".drag-handle", item: "li[data-id]", onEnd: () => reorder([...stepList.children].map((li) => li.dataset.id)) });

  function reorder(keys) {
    sync();
    const current = snapshot.steps[index].key;
    const byKey = new Map(snapshot.steps.map((s) => [s.key, s]));
    snapshot.steps = keys.map((k) => byKey.get(k));
    index = snapshot.steps.findIndex((s) => s.key === current);
    renderStepList();
    changed();
  }

  function selectStep(i) {
    sync();
    index = i;
    const step = snapshot.steps[i];
    stepTitle.value = step.title;
    editor.commands.setContent(step.content_json || emptyDoc(), { emitUpdate: false });
    renderStepList();
    history.replaceState(null, "", `#/doc/${doc.id}/step/${step.key}`);
    toolbar.update();
  }

  function addStep(after) {
    const titleField = input({ maxlength: 200 });
    const ok = h("button", { class: "button button--primary", type: "submit" }, "Add step");
    const form = h("form", { class: "form" }, field({ label: "Step title", input: titleField }), h("div", { class: "dialog__footer" }, ok));
    const dialog = openDialog({ title: "New step", content: form });
    titleField.focus();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      sync();
      snapshot.steps.splice(after + 1, 0, { id: null, key: newKey(), title: titleField.value.trim() || "New step", content_json: emptyDoc() });
      dialog.close();
      changed();
      selectStep(after + 1);
      editor.commands.focus();
    });
  }

  async function deleteStep(i) {
    const step = snapshot.steps[i];
    if (!(await confirmDialog({ title: "Delete step", text: `Delete the step "${step.title}"? It disappears from the document when the draft is published.`, confirmLabel: "Delete", danger: true }))) return;
    sync();
    snapshot.steps.splice(i, 1);
    changed();
    selectStep(Math.min(i, snapshot.steps.length - 1));
  }

  async function publishDialog() {
    try {
      await flush();
    } catch (e) {
      return toast(e.message, { kind: "error" });
    }
    const firstTime = !doc.is_published && !data.document.published_at;
    const choice = revisionChoice();
    const ok = h("button", { class: "button button--primary", type: "submit" }, "Publish");
    const form = h(
      "form",
      { class: "form" },
      firstTime ? h("p", { style: "margin:0" }, "Readers will see this document as soon as it is published.") : choice.el,
      h("div", { class: "dialog__footer" }, ok),
    );
    const dialog = openDialog({ title: firstTime ? "Publish this document" : "Publish changes", content: form });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await busy(ok, async () => {
        try {
          await flush();
          const revision = firstTime ? "minor" : choice.value();
          await api("POST", `/documents/${doc.id}/draft/publish`, { revision_type: revision });
          dialog.close();
          toast(revision === "major" ? "Published as a major revision. Everyone must complete it again." : "Published.");
          contentChanged();
          rerender();
        } catch (err) {
          toast(err.message, { kind: "error" });
        }
      });
    });
  }

  async function submitDialog() {
    try {
      await flush();
    } catch (e) {
      return toast(e.message, { kind: "error" });
    }
    if (!draft) return toast("There are no changes to submit yet.", { kind: "error" });
    const choice = revisionChoice();
    const note = h("textarea", { class: "input", rows: 3, maxlength: 2000 });
    const ok = h("button", { class: "button button--primary", type: "submit" }, "Submit for review");
    const form = h("form", { class: "form" }, choice.el, field({ label: "Note for the reviewer", hint: "Optional.", input: note }), h("div", { class: "dialog__footer" }, ok));
    const dialog = openDialog({ title: "Submit for review", content: form });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await busy(ok, async () => {
        try {
          await flush();
          await api("POST", `/documents/${doc.id}/draft/submit`, { revision_type: choice.value(), note: note.value });
          dialog.close();
          toast("Submitted. The reviewers have been notified.");
          contentChanged();
          rerender();
        } catch (err) {
          toast(err.message, { kind: "error" });
        }
      });
    });
  }

  async function discard() {
    if (!(await confirmDialog({ title: "Discard draft", text: "Delete every change in this draft? The published version stays as it is.", confirmLabel: "Discard draft", danger: true }))) return;
    try {
      clearTimeout(timer);
      dirty = false;
      await api("DELETE", `/documents/${doc.id}/draft`);
      toast("Draft discarded.");
      contentChanged();
      rerender();
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }

  async function unpublish() {
    if (!(await confirmDialog({ title: "Unpublish", text: "Readers won't see this document until it is published again.", confirmLabel: "Unpublish" }))) return;
    try {
      await api("POST", `/documents/${doc.id}/unpublish`);
      contentChanged();
      rerender();
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }

  async function deleteDocument() {
    if (!(await confirmDialog({ title: "Delete document", text: `Delete ${snapshot.title}, its steps, its draft and its reading history? This can't be undone.`, confirmLabel: "Delete", danger: true }))) return;
    try {
      clearTimeout(timer);
      dirty = false;
      await api("DELETE", `/documents/${doc.id}`);
      contentChanged();
      location.hash = "#/";
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }

  // Layout
  const editorHost = h("div", { class: "editor-host" });
  const editorArea = h("div", { class: "editor-area" }, editorHost);
  const page = h(
    "div",
    { class: "page page--document" },
    h(
      "header",
      { class: "doc-edit-header" },
      titleInput,
      descriptionInput,
      h("div", { class: "doc-header__meta" }, h("span", {}, "In category ", h("strong", {}, `${category.emoji ? `${category.emoji} ` : ""}${category.name}`))),
    ),
    banners.length ? h("div", { class: "form", style: "margin-bottom:16px" }, banners) : null,
    h("div", { class: "edit-bar", role: "toolbar", "aria-label": "Document editing" }, h("strong", { class: "small" }, draft ? "Draft" : "Edit mode"), status, resolveButton, h("span", { class: "edit-bar__spacer" }), actions, more.length ? popupMenu(more, { label: "More document actions", className: "icon-button" }) : null),
    h(
      "div",
      { class: "doc-layout" },
      h("nav", { class: "step-list", "aria-label": "Steps" }, h("div", { class: "step-select" }, stepSelect), stepList, h("div", { style: "padding:8px" }, h("button", { class: "tree__add", type: "button", onclick: () => addStep(snapshot.steps.length - 1) }, icon("plus"), "Add a step"))),
      h("div", { class: "step-content step-content--editing" }, h("label", { class: "visually-hidden", for: "step-title-input" }, "Step title"), stepTitle, editorArea),
    ),
  );
  stepTitle.id = "step-title-input";
  main.append(page);

  editor = createEditor({
    element: editorHost,
    content: snapshot.steps[index].content_json || emptyDoc(),
    placeholder: "Write here, or paste from Google Docs or Notion. Use the toolbar to add tables, images, videos and more.",
    onUpdate: () => changed(),
    onSelectionUpdate: () => toolbar.update(),
  });
  const toolbar = createToolbar(editor);
  editorArea.prepend(toolbar.el);
  createBubbleMenu(editor, editorArea);
  editor.on("transaction", () => toolbar.update());
  stepTitle.value = snapshot.steps[index].title;
  renderStepList();

  // Ctrl+S saves now.
  page.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      dirty = true;
      save();
    }
  });
}

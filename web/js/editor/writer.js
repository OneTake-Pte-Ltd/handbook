// The AI writer: turns a rough draft into a structured document.
//
// The member picks a type (SOP, policy, meeting recap), pastes a rough draft
// and optional instructions. The edge script streams progress, then returns
// { title, description, steps: [{ title, html }] }. The HTML is sanitised
// with DOMPurify, converted to Tiptap JSON with the editor's own blocks, and
// shown as a preview; "Insert" hands it to the editor (nothing is published).

import { generateJSON } from "@tiptap/core";
import DOMPurify from "dompurify";
import { apiStream } from "../api.js";
import { alertBox, clear, field, h, icon, input, openDialog } from "../lib/dom.js";
import { extensions, renderReadOnly } from "./setup.js";

export const MAX_DRAFT = 100_000;
const TYPES = [
  ["sop", "SOP", "A procedure: purpose, trigger, role, prerequisites, numbered steps, checks and fixes."],
  ["policy", "Policy document", "Rules: who they apply to, responsibilities, exceptions and consequences."],
  ["meeting", "Meeting recap", "Decisions, action items with owners and dates, open questions; the transcript at the end."],
];
const WRITER_TAGS = ["p", "h2", "h3", "ul", "ol", "li", "strong", "em", "a", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "hr", "details", "summary", "aside", "br"];

// Writer HTML to Tiptap JSON, using only the blocks the brief allows.
export function writerHtmlToJson(html) {
  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS: WRITER_TAGS, ALLOWED_ATTR: ["href", "data-callout"], ALLOWED_URI_REGEXP: /^(https?:|mailto:)/i });
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, "text/html");
  for (const aside of doc.querySelectorAll("aside")) {
    if (!["info", "tip", "warning"].includes(aside.getAttribute("data-callout"))) aside.setAttribute("data-callout", "info");
    if (!aside.querySelector("p, ul, ol, h2, h3, table, blockquote")) {
      const p = doc.createElement("p");
      p.append(...aside.childNodes);
      aside.append(p);
    }
  }
  // A collapsible section is a summary line plus a content block.
  for (const details of doc.querySelectorAll("details")) {
    let summary = [...details.children].find((c) => c.tagName === "SUMMARY");
    if (!summary) {
      summary = doc.createElement("summary");
      summary.textContent = "Details";
    }
    const content = doc.createElement("div");
    content.setAttribute("data-details-content", "");
    for (const child of [...details.childNodes]) if (child !== summary) content.append(child);
    if (!content.textContent.trim() && !content.querySelector("table")) content.append(doc.createElement("p"));
    details.replaceChildren(summary, content);
  }
  return generateJSON(doc.body.innerHTML, extensions());
}

// Opens the writer. initialText pre-fills the draft (for "Rewrite").
// onInsert({ title, description, steps: [{ title, content_json }] }).
export function openWriter({ documentId, initialText = "", onInsert }) {
  const { dialog, body, close } = openDialog({ title: "AI writer", content: [] });
  dialog.classList.add("dialog--wide");
  let controller = null;
  dialog.addEventListener("close", () => controller && controller.abort());

  const state = { type: "sop", draft: initialText, instructions: "" };
  const error = alertBox();

  function showForm() {
    const radios = TYPES.map(([value, label, hint]) =>
      h(
        "label",
        { class: "writer-type" },
        h("input", { type: "radio", name: "writer-type", value, checked: state.type === value, onchange: () => (state.type = value) }),
        h("span", {}, h("strong", {}, label), h("span", { class: "small muted" }, hint)),
      ),
    );
    const draft = h("textarea", { class: "input writer-draft", rows: 12, maxlength: MAX_DRAFT, placeholder: "Paste notes, a transcript or bullet points. Any length up to 100,000 characters." });
    draft.value = state.draft;
    const count = h("span", { class: "small muted" });
    const updateCount = () => (count.textContent = `${draft.value.length.toLocaleString("en-US")} / ${MAX_DRAFT.toLocaleString("en-US")} characters`);
    updateCount();
    draft.addEventListener("input", () => {
      state.draft = draft.value;
      updateCount();
    });
    const instructions = input({ maxlength: 2000, value: state.instructions, placeholder: "For example: keep it short, the audience is new support agents" });
    instructions.addEventListener("input", () => (state.instructions = instructions.value));
    const write = h("button", { class: "button button--primary", type: "submit" }, icon("sparkle"), "Write");
    const form = h(
      "form",
      { class: "form" },
      error.el,
      h("fieldset", { class: "field" }, h("legend", { class: "field__label" }, "Type of document"), h("div", { class: "writer-types" }, radios)),
      h("div", { class: "field" }, h("label", { class: "field__label", for: "writer-draft" }, "Rough draft"), draft, count),
      field({ label: "Instructions (optional)", input: instructions }),
      h("div", { class: "dialog__footer" }, write),
    );
    draft.id = "writer-draft";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!draft.value.trim()) return error.show("Paste your rough draft first.");
      run();
    });
    clear(body, form);
    draft.focus();
  }

  async function run() {
    error.show("");
    const status = h("p", { role: "status", style: "margin:0" }, "Reading your draft…");
    const cancel = h("button", { class: "button", type: "button", onclick: () => controller && controller.abort() }, "Cancel");
    clear(body, h("div", { class: "writer-progress" }, h("span", { class: "assistant__dots", "aria-hidden": "true" }), status), h("p", { class: "small muted" }, "Long drafts can take a minute or two."), h("div", { class: "dialog__footer" }, cancel));
    controller = new AbortController();
    let result = null;
    try {
      await apiStream(
        "/ai/write",
        { document_id: documentId, type: state.type, draft: state.draft, instructions: state.instructions },
        (event, data) => {
          if (event === "progress") status.textContent = `Writing… about ${Math.round(data.characters / 6).toLocaleString("en-US")} words so far.`;
          if (event === "result") result = data;
        },
        { signal: controller.signal },
      );
      if (!result) throw new Error("The writer stopped before finishing. Please try again.");
      showPreview(result);
    } catch (e) {
      if (controller.signal.aborted) {
        if (dialog.open) showForm();
      } else {
        showForm();
        error.show(e.message);
      }
    } finally {
      controller = null;
    }
  }

  function showPreview(result) {
    let steps;
    try {
      steps = result.steps.map((s) => ({ title: s.title, content_json: writerHtmlToJson(s.html) }));
    } catch {
      showForm();
      return error.show("The result couldn't be read. Please try again.");
    }
    const list = h("div", { class: "writer-preview" });
    steps.forEach((s, i) => {
      const content = h("div", { class: "prose" });
      list.append(h("section", { class: "writer-preview__step" }, h("h3", { class: "writer-preview__title" }, `${i + 1}. ${s.title}`), content));
      renderReadOnly(content, s.content_json);
    });
    const insert = h("button", { class: "button button--primary", type: "button" }, "Insert");
    const back = h("button", { class: "button", type: "button", onclick: showForm }, "Back to the draft");
    insert.addEventListener("click", () => {
      onInsert({ title: result.title, description: result.description, steps });
      close();
    });
    clear(
      body,
      h("p", { style: "margin-top:0" }, h("strong", {}, result.title), result.description ? h("span", { class: "muted" }, ` · ${result.description}`) : null),
      h("p", { class: "small muted" }, `${steps.length} step${steps.length === 1 ? "" : "s"}. Insert replaces this step with the first one and adds the others after it, in the draft. Nothing is published: review and edit as usual.`),
      list,
      h("div", { class: "dialog__footer" }, back, insert),
    );
  }

  showForm();
}

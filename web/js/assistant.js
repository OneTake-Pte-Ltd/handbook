// The assistant: a panel that slides in from the right (full screen on
// phones) and answers questions from the handbook, with citations.
//
// The conversation lives in this page only: it is cleared by "New
// conversation" or by reloading the page, and never stored on the server.
// Open it with openAssistant() or the "handbook:open-assistant" event.

import { apiStream } from "./api.js";
import { clear, h, icon } from "./lib/dom.js";

const conversation = []; // { role: "user" | "assistant", content, sources? }
let panel = null;

export function openAssistant(question = "") {
  if (!panel) panel = buildPanel();
  panel.open(question);
}

function buildPanel() {
  const log = h("div", { class: "assistant__log", role: "log", "aria-live": "polite" });
  const question = h("textarea", { class: "input assistant__input", rows: 2, maxlength: 2000, placeholder: "Ask a question about the handbook", "aria-label": "Your question" });
  const send = h("button", { class: "button button--primary", type: "submit" }, "Ask");
  const stop = h("button", { class: "button", type: "button", hidden: true }, "Stop");
  const form = h("form", { class: "assistant__form" }, question, h("div", { class: "assistant__form-actions" }, h("span", { class: "small muted" }, "Answers come from the handbook and can contain mistakes."), stop, send));
  const close = h("button", { class: "icon-button", type: "button", "aria-label": "Close the assistant" }, icon("close"));
  const reset = h("button", { class: "button button--ghost", type: "button" }, "New conversation");
  const el = h(
    "aside",
    { class: "assistant", role: "dialog", "aria-modal": "false", "aria-labelledby": "assistant-title", hidden: true },
    h("header", { class: "assistant__header" }, h("h2", { class: "assistant__title", id: "assistant-title" }, icon("sparkle"), "Ask the handbook"), reset, close),
    log,
    form,
  );
  document.body.append(el);
  let controller = null;

  const empty = () =>
    h(
      "div",
      { class: "assistant__empty" },
      h("p", { style: "margin-top:0" }, "Ask a question in your own words, for example:"),
      h("ul", {}, ["How do I request a day off?", "Who approves a refund?", "What should I do before publishing a video?"].map((q) => h("li", {}, h("button", { class: "link-button", type: "button", onclick: () => ask(q) }, q)))),
    );

  function renderLog() {
    clear(log, conversation.length ? conversation.map(renderMessage) : empty());
    log.scrollTop = log.scrollHeight;
  }

  async function ask(text) {
    text = text.trim();
    if (!text || controller) return;
    question.value = "";
    conversation.push({ role: "user", content: text });
    const answer = { role: "assistant", content: "", sources: [], status: "Searching the handbook…", pending: true };
    conversation.push(answer);
    renderLog();
    let current = log.lastElementChild;
    const update = () => {
      const next = renderMessage(answer);
      current.replaceWith(next);
      current = next;
      // Keep the newest text in view unless the member scrolled up.
      if (log.scrollHeight - log.scrollTop - log.clientHeight < 160) log.scrollTop = log.scrollHeight;
    };
    controller = new AbortController();
    send.hidden = true;
    stop.hidden = false;
    const history = conversation.slice(0, -1).filter((m) => !m.failed).map((m) => ({ role: m.role, content: m.content }));
    try {
      await apiStream(
        "/ai/ask",
        { messages: history },
        (event, data) => {
          if (event === "searching") answer.status = data.queries.length ? `Searching for ${data.queries.join(", ")}…` : "Searching the handbook…";
          else if (event === "sources") answer.sources = data;
          else if (event === "text") {
            answer.status = "";
            answer.content += data.text;
          } else if (event === "done" && data.truncated) answer.note = "The answer was cut short.";
          update();
        },
        { signal: controller.signal },
      );
    } catch (error) {
      if (controller.signal.aborted) answer.note = "Stopped.";
      else {
        answer.error = error.message;
        answer.failed = true;
        conversation[conversation.length - 2].failed = true;
      }
    } finally {
      answer.pending = false;
      answer.status = "";
      if (!answer.content && !answer.error) answer.failed = true;
      controller = null;
      send.hidden = false;
      stop.hidden = true;
      update();
      question.focus();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(question.value);
  });
  question.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      ask(question.value);
    }
  });
  stop.addEventListener("click", () => controller && controller.abort());
  reset.addEventListener("click", () => {
    if (controller) controller.abort();
    conversation.length = 0;
    renderLog();
    question.focus();
  });
  const hide = () => {
    el.hidden = true;
    document.body.classList.remove("assistant-open");
  };
  close.addEventListener("click", hide);
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  // Following a citation on a phone shows the step instead of the panel.
  log.addEventListener("click", (event) => {
    if (event.target.closest("a[href^='#/doc/']") && window.matchMedia("(max-width: 639px)").matches) hide();
  });
  window.addEventListener("handbook:logged-out", () => {
    conversation.length = 0;
    hide();
  });

  return {
    open(text) {
      el.hidden = false;
      document.body.classList.add("assistant-open");
      renderLog();
      if (text) ask(text);
      else question.focus();
    },
  };
}

function renderMessage(message) {
  if (message.role === "user") return h("div", { class: "assistant__message assistant__message--user" }, message.content);
  const cited = new Set();
  const body = renderAnswer(message.content, message.sources || [], cited);
  const sources = (message.sources || []).filter((s) => cited.has(s.n));
  return h(
    "div",
    { class: "assistant__message assistant__message--answer", "aria-busy": message.pending ? "true" : "false" },
    message.status ? h("p", { class: "small muted assistant__status" }, h("span", { class: "assistant__dots", "aria-hidden": "true" }), message.status) : null,
    body,
    message.error ? h("div", { class: "alert alert--error", role: "alert" }, message.error) : null,
    message.note ? h("p", { class: "small muted" }, message.note) : null,
    !message.pending && sources.length
      ? h(
          "div",
          { class: "assistant__sources" },
          h("div", { class: "small muted" }, "Sources"),
          sources.map((s) =>
            h(
              "a",
              { class: "assistant__source", href: `#/doc/${s.document_id}/step/${s.step_id}` },
              h("span", { class: "assistant__cite" }, String(s.n)),
              h("span", {}, h("strong", {}, s.document_title), h("span", { class: "small muted" }, ` ${s.emoji ? `${s.emoji} ` : ""}${s.category} · ${s.step_title}`)),
            ),
          ),
        )
      : null,
  );
}

// The answer as DOM (never HTML): paragraphs, "- " and "1. " lists, **bold**,
// and citation markers [n] turned into links to the cited step.
export function renderAnswer(text, sources, cited = new Set()) {
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  const inline = (line) => {
    const parts = [];
    const pattern = /\*\*([^*]+)\*\*|\[(\d{1,2})\]/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(line))) {
      if (match.index > last) parts.push(line.slice(last, match.index));
      if (match[1]) parts.push(h("strong", {}, match[1]));
      else {
        const source = byNumber.get(Number(match[2]));
        if (source) {
          cited.add(source.n);
          parts.push(h("a", { class: "assistant__cite", href: `#/doc/${source.document_id}/step/${source.step_id}`, title: `${source.document_title}: ${source.step_title}` }, match[2]));
        }
      }
      last = pattern.lastIndex;
    }
    if (last < line.length) parts.push(line.slice(last));
    return parts;
  };
  const blocks = [];
  let list = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = h(tag, {});
        blocks.push(list);
      }
      list.append(h("li", {}, inline((bullet || numbered)[1])));
      continue;
    }
    list = null;
    if (line) blocks.push(h("p", {}, inline(line.replace(/^#+\s*/, ""))));
  }
  return h("div", { class: "assistant__answer" }, blocks);
}

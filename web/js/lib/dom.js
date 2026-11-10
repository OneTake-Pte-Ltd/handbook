// DOM helpers. Everything is built with createElement and textContent, never
// innerHTML, so text coming from the API can never inject markup.

import { ICONS } from "./icons.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// h("button", { class: "button", onclick: fn, "aria-label": "Close" }, "Text", childNode)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      el.className = value;
    } else if (key === "dataset") {
      Object.assign(el.dataset, value);
    } else if (key === "value" && "value" in el) {
      el.value = value;
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

// Empties an element, then appends the given children (null and false are skipped,
// unlike the native append, which would print "null").
export function clear(el, ...children) {
  while (el.firstChild) el.firstChild.remove();
  return append(el, children);
}

// Inline SVG icon from the hand-written set in icons.js. Decorative by default.
export function icon(name, { label, className = "icon" } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  for (const shape of ICONS[name] || []) {
    const [tag, attrs] = typeof shape === "string" ? ["path", { d: shape }] : shape;
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}

export function field({ label, hint, input, id }) {
  const inputId = id || input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = inputId;
  const hintId = hint ? `${inputId}-hint` : null;
  if (hintId) input.setAttribute("aria-describedby", hintId);
  return h(
    "div",
    { class: "field" },
    h("label", { class: "field__label", for: inputId }, label),
    input,
    hint ? h("div", { class: "field__hint", id: hintId }, hint) : null,
  );
}

export function input(attrs = {}) {
  return h("input", { class: "input", type: "text", ...attrs });
}

// A live region for form errors; call show("message") or show("").
export function alertBox(kind = "error") {
  const el = h("div", { class: `alert alert--${kind}`, role: kind === "error" ? "alert" : "status" });
  return {
    el,
    show(message) {
      el.textContent = message || "";
    },
  };
}

// Disables a form's submit button while an async action runs.
export async function busy(button, action) {
  const label = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    return await action();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = label;
  }
}

export function loading(text = "Loading") {
  return h("div", { class: "loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), text);
}

let toastRoot = null;

export function toast(message, { kind = "info", duration = 4000 } = {}) {
  if (!toastRoot) {
    toastRoot = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastRoot);
  }
  const el = h("div", { class: `toast${kind === "error" ? " toast--error" : ""}` }, message);
  toastRoot.append(el);
  setTimeout(() => el.remove(), duration);
}

export function initials(user) {
  return `${(user.first_name || "?")[0]}${(user.last_name || "")[0] || ""}`.toUpperCase();
}

export function avatar(user, size = "") {
  const el = h("span", { class: `avatar${size ? ` avatar--${size}` : ""}`, "aria-hidden": "true" });
  if (user.avatar_url) el.append(h("img", { src: user.avatar_url, alt: "" }));
  else el.textContent = initials(user);
  return el;
}

export function setTitle(...parts) {
  document.title = [...parts.filter(Boolean), "Handbook"].join(" · ");
}

// Modal dialog built on <dialog>, which traps focus and closes on Escape.
// Returns { dialog, body, close }. The dialog removes itself when closed.
export function openDialog({ title, content, onClose }) {
  const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;
  const body = h("div", { class: "dialog__body" });
  const dialog = h(
    "dialog",
    { class: "dialog", "aria-labelledby": titleId },
    h(
      "div",
      { class: "dialog__header" },
      h("h2", { class: "dialog__title", id: titleId }, title),
      h("button", { class: "icon-button", type: "button", "aria-label": "Close", onclick: () => dialog.close() }, icon("close")),
    ),
    body,
  );
  if (content) append(body, [content]);
  const opener = document.activeElement;
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (opener && opener.isConnected) opener.focus();
    if (onClose) onClose(dialog.returnValue);
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, close: (value) => dialog.close(value) };
}

// Asks for confirmation. Resolves to true or false.
export function confirmDialog({ title, text, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let confirmed = false;
    const cancel = h("button", { class: "button", type: "button" }, "Cancel");
    const ok = h("button", { class: `button ${danger ? "button--danger" : "button--primary"}`, type: "button" }, confirmLabel);
    const { close } = openDialog({
      title,
      content: [h("p", { style: "margin:0" }, text), h("div", { class: "dialog__footer" }, cancel, ok)],
      onClose: () => resolve(confirmed),
    });
    cancel.addEventListener("click", () => close());
    ok.addEventListener("click", () => {
      confirmed = true;
      close();
    });
    cancel.focus();
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    toast("Copy didn't work here. Select the text and copy it by hand.", { kind: "error" });
  }
}

export function copyButton(getText, label = "Copy") {
  return h("button", { class: "button", type: "button", onclick: () => copyText(getText()) }, icon("copy"), label);
}

export function switchInput({ checked, label, onchange, disabled }) {
  const box = h("input", { type: "checkbox", role: "switch", checked: Boolean(checked), disabled: Boolean(disabled) });
  if (onchange) box.addEventListener("change", () => onchange(box.checked, box));
  return h("label", { class: "switch" }, box, h("span", {}, label));
}

// A "⋯" button that opens a small menu. items: [{ label, onClick, danger, disabled }]
export function popupMenu(items, { label = "More actions", className = "small-icon-button" } = {}) {
  const menu = h("div", { class: "menu", hidden: true, role: "menu" });
  const button = h("button", { class: className, type: "button", "aria-label": label, "aria-haspopup": "true", "aria-expanded": "false" }, icon("more"));
  const wrap = h("div", { class: "menu-wrap" }, button, menu);
  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outside, true);
  };
  const outside = (event) => {
    if (!wrap.contains(event.target)) close();
  };
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!menu.hidden) return close();
    clear(
      menu,
      items
        .filter(Boolean)
        .map((item) =>
          h(
            "button",
            {
              class: "menu__item",
              type: "button",
              role: "menuitem",
              disabled: Boolean(item.disabled),
              style: item.danger ? "color:var(--danger-text)" : null,
              onclick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                close();
                item.onClick();
              },
            },
            item.label,
          ),
        ),
    );
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    menu.querySelector(".menu__item:not([disabled])")?.focus();
    document.addEventListener("click", outside, true);
  });
  menu.addEventListener("keydown", (event) => {
    const options = [...menu.querySelectorAll(".menu__item:not([disabled])")];
    const index = options.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      button.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      options[(index + 1) % options.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      options[(index - 1 + options.length) % options.length]?.focus();
    }
  });
  return wrap;
}

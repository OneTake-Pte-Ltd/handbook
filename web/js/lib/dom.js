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

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
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

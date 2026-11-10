// Category emoji: a text field plus a small grid of common emojis.

import { h } from "./dom.js";

export const EMOJIS = [
  "📚", "📘", "📗", "📙", "📕", "📒", "📝", "📋", "📌", "📎",
  "🗂️", "📁", "💡", "🎯", "🚀", "⭐", "✅", "⚙️", "🛠️", "🔒",
  "💬", "📣", "🎥", "🎓", "🤝", "💼", "💰", "📈", "🌍", "❤️",
];

// Returns { el, input }: a field the user can type into, and the grid.
export function emojiPicker(value = "") {
  const input = h("input", { class: "input", name: "emoji", value, maxlength: 16, autocomplete: "off", style: "width:96px;font-size:20px;text-align:center" });
  const buttons = EMOJIS.map((emoji) =>
    h("button", { type: "button", "aria-label": `Use ${emoji}`, "aria-pressed": String(emoji === value), onclick: () => select(emoji) }, emoji),
  );
  function select(emoji) {
    input.value = emoji;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.textContent === emoji));
  }
  input.addEventListener("input", () => {
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.textContent === input.value));
  });
  const id = `emoji-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  const el = h(
    "div",
    { class: "field" },
    h("label", { class: "field__label", for: id }, "Emoji"),
    h("div", { style: "display:flex;gap:8px;align-items:center" }, input, h("span", { class: "field__hint" }, "Type or paste any emoji, or pick one below.")),
    h("div", { class: "emoji-grid", role: "group", "aria-label": "Common emojis" }, buttons),
  );
  return { el, input };
}

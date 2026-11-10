// Temporary page for sections that arrive in later milestones.

import { h, setTitle } from "../lib/dom.js";

export function render(main, { title, text }) {
  setTitle(title);
  main.append(h("div", { class: "page" }, h("h1", { class: "page-title" }, title), h("div", { class: "card empty-state" }, h("p", { style: "margin:0" }, text))));
}

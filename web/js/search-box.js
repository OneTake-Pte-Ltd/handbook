// Search field with a dropdown of the top 5 results while typing (250 ms
// debounce). Enter opens the highlighted result, or the full results page.
// Used in the top bar and on the home page.

import { api } from "./api.js";
import { clear, h } from "./lib/dom.js";

const START = "\u0001";
const END = "\u0002";

// Turns a snippet with match markers into text and <mark> elements (no HTML).
export function snippetNodes(snippet) {
  const out = [];
  for (const part of String(snippet || "").split(START)) {
    const [marked, rest] = part.includes(END) ? part.split(END) : [null, part];
    if (marked !== null) out.push(h("mark", {}, marked));
    if (rest) out.push(rest);
  }
  return out;
}

export function resultLink(r) {
  return `#/doc/${r.document_id}/step/${r.step_id}`;
}

let counter = 0;

export function attachSearchBox(form, input) {
  const id = `search-results-${++counter}`;
  const list = h("ul", { class: "search-dropdown", id, role: "listbox", hidden: true, "aria-label": "Search results" });
  form.append(list);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", id);
  input.setAttribute("aria-expanded", "false");

  let timer = null;
  let ticket = 0;
  let items = [];
  let active = -1;

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function setActive(i) {
    active = i;
    items.forEach((el, j) => el.setAttribute("aria-selected", String(j === i)));
    if (i >= 0) input.setAttribute("aria-activedescendant", items[i].id);
    else input.removeAttribute("aria-activedescendant");
  }

  function fullPage() {
    const q = input.value.trim();
    close();
    location.hash = `#/search?q=${encodeURIComponent(q)}`;
  }

  async function run() {
    const q = input.value.trim();
    const mine = ++ticket;
    if (q.length < 2) return close();
    let results;
    try {
      ({ results } = await api("GET", `/search?q=${encodeURIComponent(q)}&limit=5`));
    } catch {
      return close();
    }
    if (mine !== ticket) return;
    items = results.map((r, i) =>
      h(
        "li",
        { id: `${id}-${i}`, role: "option", "aria-selected": "false", class: "search-dropdown__item", onmousedown: (e) => e.preventDefault(), onclick: () => open(r) },
        h("span", { class: "search-dropdown__title" }, r.document_title, r.step_title !== r.document_title ? h("span", { class: "muted" }, ` › ${r.step_title}`) : null),
        h("span", { class: "search-dropdown__meta" }, `${r.category.emoji ? `${r.category.emoji} ` : ""}${r.category.name}`),
        h("span", { class: "search-dropdown__snippet" }, snippetNodes(r.snippet)),
      ),
    );
    const footer = h(
      "li",
      { class: "search-dropdown__all", role: "option", id: `${id}-all`, "aria-selected": "false", onmousedown: (e) => e.preventDefault(), onclick: fullPage },
      results.length ? `See all results for "${q}"` : `No results for "${q}"`,
    );
    items.push(footer);
    clear(list, items);
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    setActive(-1);
  }

  function open(r) {
    close();
    input.blur();
    location.hash = resultLink(r);
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && !list.hidden) {
      e.preventDefault();
      setActive(Math.min(items.length - 1, active + 1));
    } else if (e.key === "ArrowUp" && !list.hidden) {
      e.preventDefault();
      setActive(Math.max(-1, active - 1));
    } else if (e.key === "Escape") {
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0 && !list.hidden) items[active].click();
      else fullPage();
    }
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    fullPage();
  });
  return { close };
}

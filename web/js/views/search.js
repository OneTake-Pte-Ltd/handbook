// Full search results, grouped by document: #/search?q=...

import { api } from "../api.js";
import { clear, h, icon, loading, setTitle } from "../lib/dom.js";
import { resultLink, snippetNodes } from "../search-box.js";

export async function render(main, { query }) {
  const q = (query.get("q") || "").trim();
  setTitle(q ? `Search: ${q}` : "Search");
  const input = h("input", { class: "input", type: "search", name: "q", value: q, placeholder: "Search the handbook", "aria-label": "Search the handbook", autocomplete: "off" });
  const results = h("div", { "aria-live": "polite" });
  main.append(
    h(
      "div",
      { class: "page page--narrow" },
      h("h1", { class: "page-title" }, "Search"),
      h(
        "form",
        {
          class: "search-field",
          role: "search",
          style: "margin-bottom:24px",
          onsubmit: (e) => {
            e.preventDefault();
            location.hash = `#/search?q=${encodeURIComponent(input.value.trim())}`;
          },
        },
        icon("search"),
        input,
      ),
      results,
    ),
  );
  if (!q) {
    input.focus();
    results.append(h("p", { class: "muted" }, "Type a few words and press Enter."));
    return;
  }
  results.append(loading("Searching"));
  const data = await api("GET", `/search?q=${encodeURIComponent(q)}&limit=50`);
  if (!data.results.length) {
    clear(results, h("div", { class: "card empty-state" }, h("p", { style: "margin:0" }, `Nothing matches "${q}". Try other words, or fewer of them.`)));
    return;
  }
  // Group by document, keeping the best-ranked document first.
  const groups = new Map();
  for (const r of data.results) {
    if (!groups.has(r.document_id)) groups.set(r.document_id, { ...r, hits: [] });
    groups.get(r.document_id).hits.push(r);
  }
  clear(
    results,
    h("p", { class: "muted small" }, `${data.results.length} result${data.results.length === 1 ? "" : "s"} in ${groups.size} document${groups.size === 1 ? "" : "s"}`),
    [...groups.values()].map((g) =>
      h(
        "section",
        { class: "card search-group" },
        h("div", { class: "muted small" }, `${g.category.emoji ? `${g.category.emoji} ` : ""}${g.category.name}`),
        h("h2", { class: "section-title", style: "margin:4px 0 8px" }, h("a", { href: `#/doc/${g.document_id}` }, g.document_title)),
        h(
          "ul",
          { class: "search-hits" },
          g.hits.map((r) =>
            h(
              "li",
              {},
              r.step_title !== r.document_title ? h("a", { href: resultLink(r) }, r.step_title) : null,
              h("p", { class: "small" }, snippetNodes(r.snippet), " ", r.step_title === r.document_title ? h("a", { href: resultLink(r), class: "small" }, "Read") : null),
            ),
          ),
        ),
      ),
    ),
  );
}

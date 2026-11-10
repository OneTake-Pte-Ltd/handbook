// Home page: greeting and search, documents that require completion, my
// progress, recently updated documents, and drafts waiting for my review.

import { api } from "../api.js";
import { h, icon, setTitle } from "../lib/dom.js";
import { greeting, relativeTime } from "../lib/format.js";
import { completionMark, statusLabel } from "../lib/marks.js";
import { session } from "../state.js";
import { attachSearchBox } from "../search-box.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Ring showing the completion rate. The number and the sentence carry the meaning.
function progressRing({ completed, total }) {
  const rate = total ? Math.round((completed / total) * 100) : 100;
  const r = 52;
  const c = 2 * Math.PI * r;
  const svg = svgEl("svg", { viewBox: "0 0 120 120", class: "progress-ring", "aria-hidden": "true" });
  svg.append(
    svgEl("circle", { cx: "60", cy: "60", r: String(r), fill: "none", stroke: "var(--gold-100)", "stroke-width": "12" }),
    svgEl("circle", {
      cx: "60",
      cy: "60",
      r: String(r),
      fill: "none",
      stroke: "var(--golden-grass)",
      "stroke-width": "12",
      "stroke-linecap": rate > 0 && rate < 100 ? "round" : "butt",
      "stroke-dasharray": `${(rate / 100) * c} ${c}`,
      transform: "rotate(-90 60 60)",
    }),
  );
  return h(
    "div",
    { class: "progress-widget" },
    h("div", { class: "progress-ring-wrap" }, svg, h("span", { class: "progress-ring__value" }, `${rate}%`)),
    h(
      "p",
      { class: "small", style: "margin:0;text-align:center" },
      total ? `${completed} of ${total} required document${total === 1 ? "" : "s"} completed` : "No required reading for you right now.",
    ),
  );
}

function documentCard(d) {
  return h(
    "a",
    { class: "doc-card", href: `#/doc/${d.id}` },
    h("span", { class: "doc-card__category" }, `${d.category.emoji ? `${d.category.emoji} ` : ""}${d.category.name}`),
    h("strong", { class: "doc-card__title" }, d.title),
    h("span", { class: "doc-card__description" }, d.description || "This document has no description."),
    h(
      "span",
      { class: "doc-card__footer" },
      h("span", {}, `${d.steps} step${d.steps === 1 ? "" : "s"}`),
      h("span", {}, `${d.minutes} min`),
      h("span", { class: "doc-card__progress" }, completionMark(d.progress), d.progress.status === "in_progress" ? `${d.progress.done} of ${d.progress.total}` : statusLabel(d.progress)),
    ),
  );
}

function carousel(items) {
  const track = h("div", { class: "carousel__track", tabindex: "0", role: "region", "aria-label": "Documents that require completion" }, items.map(documentCard));
  const scroll = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.9, behavior: "smooth" });
  const prev = h("button", { class: "icon-button", type: "button", "aria-label": "Previous documents", onclick: () => scroll(-1) }, icon("arrowLeft"));
  const next = h("button", { class: "icon-button", type: "button", "aria-label": "Next documents", onclick: () => scroll(1) }, icon("arrowRight"));
  const update = () => {
    prev.disabled = track.scrollLeft <= 2;
    next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
  };
  track.addEventListener("scroll", update, { passive: true });
  setTimeout(update, 0);
  return h("div", { class: "carousel" }, track, items.length > 1 ? h("div", { class: "carousel__controls" }, prev, next) : null);
}

function section(title, count, ...content) {
  const id = `home-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return h(
    "section",
    { class: "card home-card", "aria-labelledby": id },
    h("h2", { class: "section-title", id }, title, count !== null ? h("span", { class: "count-pill" }, String(count)) : null),
    content,
  );
}

export async function render(main) {
  const me = session.me;
  setTitle("Home");
  const searchInput = h("input", { class: "input", type: "search", name: "q", placeholder: "Search the handbook", "aria-label": "Search the handbook", autocomplete: "off" });
  const searchForm = h("form", { class: "search-field home-search", role: "search" }, icon("search"), searchInput);
  attachSearchBox(searchForm, searchInput);

  const banner = h(
    "section",
    { class: `banner${me.workspace.banner_url ? " banner--image" : ""}` },
    h(
      "div",
      { class: "banner__inner" },
      h("h1", { class: "banner__title" }, `${greeting()}, ${me.user.first_name}`),
      h(
        "div",
        { class: "banner__search" },
        searchForm,
        // The assistant arrives in milestone 8; the button only shows once an Anthropic key is set.
        me.workspace.ai_enabled ? h("a", { class: "button", href: "#/assistant" }, icon("sparkle"), "Ask a question") : null,
      ),
    ),
  );
  if (me.workspace.banner_url) banner.style.backgroundImage = `url(${JSON.stringify(me.workspace.banner_url)})`;
  const grid = h("div", { class: "home-grid" });
  main.append(banner, h("div", { class: "page" }, grid));

  const data = await api("GET", "/home");

  grid.append(
    section(
      "Requires completion",
      data.requires_completion.length,
      data.requires_completion.length ? carousel(data.requires_completion) : h("p", { class: "muted small", style: "margin:0" }, "You're all caught up. Nothing required is waiting for you."),
    ),
    section("My progress", null, progressRing(data.completion)),
    section(
      "Recently updated",
      null,
      data.recently_updated.length
        ? h(
            "ul",
            { class: "recent-list" },
            data.recently_updated.map((d) =>
              h(
                "li",
                {},
                h("a", { href: `#/doc/${d.id}` }, d.title),
                h(
                  "span",
                  { class: "muted small" },
                  `${d.category.emoji ? `${d.category.emoji} ` : ""}${d.category.name} · ${relativeTime(d.updated_at)}`,
                ),
                d.major_update ? h("span", { class: "badge badge--accent" }, "Major update") : null,
              ),
            ),
          )
        : h("p", { class: "muted small", style: "margin:0" }, "Nothing has been published yet."),
    ),
  );
  if (data.waiting_for_review.length) {
    grid.append(
      section(
        "Waiting for your review",
        data.waiting_for_review.length,
        h(
          "ul",
          { class: "recent-list" },
          data.waiting_for_review.map((d) =>
            h(
              "li",
              {},
              h("a", { href: `#/doc/${d.document_id}` }, d.title),
              h("span", { class: "muted small" }, `${d.author ? d.author.name : "Someone"} · ${relativeTime(d.submitted_at)}`),
            ),
          ),
        ),
        h("p", { class: "small muted", style: "margin:12px 0 0" }, "Turn on Edit in the sidebar to open the review."),
      ),
    );
  }
}

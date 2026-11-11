// Reporting (admins and team leaders).
//   #/reporting                   overview, one row per member
//   #/reporting/users/:id         a member's mandatory documents and viewing history
//   #/reporting/documents/:id     who must complete a document, and where they are

import { api } from "../api.js";
import { avatar, clear, h, icon, loading, setTitle } from "../lib/dom.js";
import { fullName, relativeTime, shortDateTime } from "../lib/format.js";
import { completionMark } from "../lib/marks.js";
import { isAdmin } from "../state.js";

const STATUS_LABELS = { completed: "Completed", in_progress: "In progress", needs_rereading: "Needs re-reading", not_started: "Not started" };

function statusCell(row) {
  const label = row.status === "in_progress" ? `In progress (${row.done} of ${row.total} steps)` : STATUS_LABELS[row.status];
  if (row.status === "needs_rereading") return h("span", { class: "badge badge--quiet" }, label);
  return h("span", { class: "status-inline" }, completionMark({ status: row.status, done: row.done, total: row.total }), label);
}

function rateBar(rate) {
  if (rate === null) return h("span", { class: "muted small" }, "No required documents");
  return h(
    "span",
    { class: "rate" },
    h("span", { class: "rate__bar", "aria-hidden": "true" }, h("span", { class: "rate__fill", style: `width:${rate}%` })),
    h("span", { class: "rate__value" }, `${rate}%`),
  );
}

// A table whose columns sort when their header is clicked.
// columns: [{ key, label, value: (row) => sortable, cell: (row) => node, numeric }]
function sortableTable(rows, columns, { initial, onRowHref }) {
  let sortKey = initial.key;
  let direction = initial.direction;
  const thead = h("thead");
  const tbody = h("tbody");
  const table = h("table", { class: "table" }, thead, tbody);

  function render() {
    const column = columns.find((c) => c.key === sortKey);
    const sorted = [...rows].sort((a, b) => {
      const x = column.value(a);
      const y = column.value(b);
      const nullish = (v) => v === null || v === undefined || v === "";
      if (nullish(x) && nullish(y)) return 0;
      if (nullish(x)) return 1;
      if (nullish(y)) return -1;
      const result = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return direction === "asc" ? result : -result;
    });
    clear(
      thead,
      h(
        "tr",
        {},
        columns.map((c) =>
          h(
            "th",
            { scope: "col", class: c.numeric ? "numeric" : null, "aria-sort": c.key === sortKey ? (direction === "asc" ? "ascending" : "descending") : "none" },
            h(
              "button",
              {
                class: "sort-button",
                type: "button",
                onclick: () => {
                  if (sortKey === c.key) direction = direction === "asc" ? "desc" : "asc";
                  else {
                    sortKey = c.key;
                    direction = c.numeric ? "desc" : "asc";
                  }
                  render();
                },
              },
              c.label,
              c.key === sortKey ? h("span", { "aria-hidden": "true", class: "sort-arrow" }, direction === "asc" ? "▲" : "▼") : null,
            ),
          ),
        ),
      ),
    );
    clear(
      tbody,
      sorted.map((row) =>
        h(
          "tr",
          onRowHref ? { dataset: { href: onRowHref(row) } } : {},
          columns.map((c, i) => h("td", { class: c.numeric ? "numeric" : null, "data-label": i === 0 ? null : c.label }, c.cell(row))),
        ),
      ),
    );
  }
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-href]");
    if (tr && !e.target.closest("a, button")) location.hash = tr.dataset.href;
  });
  // On narrow screens rows become cards and headers are hidden: sort here instead.
  const sortSelect = h(
    "select",
    { class: "select", "aria-label": "Sort by" },
    columns.flatMap((c) => [
      h("option", { value: `${c.key}:asc`, selected: c.key === sortKey && direction === "asc" }, `${c.label}, ${c.numeric ? "lowest first" : "A to Z"}`),
      h("option", { value: `${c.key}:desc`, selected: c.key === sortKey && direction === "desc" }, `${c.label}, ${c.numeric ? "highest first" : "Z to A"}`),
    ]),
  );
  sortSelect.addEventListener("change", () => {
    [sortKey, direction] = sortSelect.value.split(":");
    render();
  });
  render();
  return h("div", {}, h("label", { class: "sort-select" }, h("span", { class: "small muted" }, "Sort by"), sortSelect), h("div", { class: "table-wrap" }, table));
}

async function overview(container) {
  setTitle("Reporting");
  const { departments } = await api("GET", "/departments");
  // Admins can filter by any department; team leaders by the ones they lead.
  const choices = departments.filter((d) => !d.is_system && (isAdmin() || d.i_lead));
  const filter = h(
    "select",
    { class: "select", "aria-label": "Filter by department" },
    h("option", { value: "" }, "All members"),
    choices.map((d) => h("option", { value: String(d.id) }, d.name)),
  );
  const results = h("div", { "aria-live": "polite" });
  container.append(
    h("div", { class: "page-header" }, h("h1", { class: "page-title" }, "Reporting")),
    h("p", { class: "muted small", style: "margin-top:-12px" }, "Progress on required documents. Click a member to see their documents and viewing history."),
    h("div", { class: "filters" }, filter),
    results,
  );

  async function load() {
    clear(results, loading());
    const { rows } = await api("GET", `/reports/overview${filter.value ? `?department=${filter.value}` : ""}`);
    if (!rows.length) {
      clear(results, h("div", { class: "card empty-state" }, "No members to show."));
      return;
    }
    const assigned = rows.reduce((n, r) => n + r.assigned, 0);
    const completed = rows.reduce((n, r) => n + r.completed, 0);
    clear(
      results,
      h(
        "div",
        { class: "report-summary" },
        h("div", { class: "card stat" }, h("span", { class: "stat__value" }, String(rows.length)), h("span", { class: "stat__label" }, "members")),
        h("div", { class: "card stat" }, h("span", { class: "stat__value" }, assigned ? `${Math.round((completed / assigned) * 100)}%` : "None"), h("span", { class: "stat__label" }, "of required documents completed")),
        h("div", { class: "card stat" }, h("span", { class: "stat__value" }, String(rows.filter((r) => r.rate !== null && r.rate < 100).length)), h("span", { class: "stat__label" }, "members with required reading left")),
      ),
      sortableTable(
        rows,
        [
          { key: "name", label: "Member", value: (r) => fullName(r.user).toLowerCase(), cell: (r) => h("div", { class: "person" }, avatar(r.user), h("div", {}, h("a", { href: `#/reporting/users/${r.user.id}` }, fullName(r.user)), h("div", { class: "muted small" }, r.departments.map((d) => d.name).join(", ")))) },
          { key: "assigned", label: "Required", numeric: true, value: (r) => r.assigned, cell: (r) => String(r.assigned) },
          { key: "completed", label: "Completed", numeric: true, value: (r) => r.completed, cell: (r) => String(r.completed) },
          { key: "rate", label: "Completion rate", numeric: true, value: (r) => r.rate, cell: (r) => rateBar(r.rate) },
          { key: "activity", label: "Last activity", value: (r) => r.last_activity, cell: (r) => (r.last_activity ? h("span", { title: shortDateTime(r.last_activity) }, relativeTime(r.last_activity)) : "Never") },
        ],
        { initial: { key: "name", direction: "asc" }, onRowHref: (r) => `#/reporting/users/${r.user.id}` },
      ),
    );
  }
  filter.addEventListener("change", load);
  await load();
}

async function memberReport(container, id) {
  container.append(loading());
  const report = await api("GET", `/reports/users/${id}`);
  clear(container);
  setTitle(fullName(report.user), "Reporting");
  const c = report.completion;
  container.append(
    h("a", { class: "back-link", href: "#/reporting" }, icon("arrowLeft"), "Reporting"),
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "profile-head" },
        avatar(report.user, "lg"),
        h(
          "div",
          { style: "flex:1;min-width:200px" },
          h("h1", { class: "profile-head__name" }, fullName(report.user)),
          h("div", { class: "muted small" }, report.user.email),
          report.user.role_title ? h("div", { class: "small" }, report.user.role_title) : null,
        ),
        h("div", { class: "stat" }, h("span", { class: "stat__value" }, c.rate === null ? "None" : `${c.rate}%`), h("span", { class: "stat__label" }, c.total ? `${c.completed} of ${c.total} required documents` : "No required documents")),
      ),
      h("p", { class: "small", style: "margin:16px 0 0" }, h("a", { href: `#/organization/members/${report.user.id}` }, "Open the member page")),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "required-title" },
      h("h2", { class: "section-title", id: "required-title" }, "Required documents"),
      report.documents.length
        ? sortableTable(
            report.documents,
            [
              { key: "title", label: "Document", value: (d) => d.title.toLowerCase(), cell: (d) => h("div", {}, h("a", { href: `#/reporting/documents/${d.id}` }, d.title), h("div", { class: "muted small" }, `${d.category.emoji ? `${d.category.emoji} ` : ""}${d.category.name}`)) },
              { key: "status", label: "Status", value: (d) => ["not_started", "needs_rereading", "in_progress", "completed"].indexOf(d.status), cell: statusCell, numeric: false },
              { key: "date", label: "Completed on", value: (d) => d.completed_at, cell: (d) => (d.completed_at ? shortDateTime(d.completed_at) : "") },
            ],
            { initial: { key: "status", direction: "asc" } },
          )
        : h("p", { class: "muted small", style: "margin:0" }, "Nothing is required for this member."),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "history-title" },
      h("h2", { class: "section-title", id: "history-title" }, "Viewing history"),
      h("p", { class: "muted small" }, "Every step this member opened, most recent first."),
      report.history.length
        ? sortableTable(
            report.history,
            [
              { key: "step", label: "Step", value: (v) => v.step_title.toLowerCase(), cell: (v) => h("div", {}, h("a", { href: `#/doc/${v.document_id}/step/${v.step_id}` }, v.step_title), v.step_title !== v.document_title ? h("div", { class: "muted small" }, v.document_title) : null) },
              { key: "first", label: "First viewed", value: (v) => v.first_viewed_at, cell: (v) => shortDateTime(v.first_viewed_at) },
              { key: "last", label: "Last viewed", value: (v) => v.last_viewed_at, cell: (v) => shortDateTime(v.last_viewed_at) },
              { key: "count", label: "Views", numeric: true, value: (v) => v.view_count, cell: (v) => String(v.view_count) },
            ],
            { initial: { key: "last", direction: "desc" } },
          )
        : h("p", { class: "muted small", style: "margin:0" }, "This member hasn't opened any document yet."),
    ),
  );
}

async function documentReport(container, id) {
  container.append(loading());
  const report = await api("GET", `/reports/documents/${id}`);
  clear(container);
  const d = report.document;
  setTitle(d.title, "Reporting");
  container.append(
    h("a", { class: "back-link", href: "#/reporting" }, icon("arrowLeft"), "Reporting"),
    h(
      "div",
      { class: "page-header" },
      h("div", {}, h("h1", { class: "page-title" }, d.title), h("div", { class: "muted small" }, `${d.category.emoji ? `${d.category.emoji} ` : ""}${d.category.name}${d.last_major_revision_at ? ` · last major revision ${shortDateTime(d.last_major_revision_at)}` : ""}`)),
      h("a", { class: "button", href: `#/doc/${d.id}` }, "Open the document"),
    ),
    !d.is_published ? h("div", { class: "alert alert--info", style: "margin-bottom:16px" }, "This document is not published yet, so nobody can complete it.") : null,
    h(
      "div",
      { class: "report-summary" },
      h("div", { class: "card stat" }, h("span", { class: "stat__value" }, String(report.summary.members)), h("span", { class: "stat__label" }, "members must complete it")),
      h("div", { class: "card stat" }, h("span", { class: "stat__value" }, String(report.summary.completed)), h("span", { class: "stat__label" }, "have completed it")),
    ),
    report.rows.length
      ? sortableTable(
          report.rows,
          [
            { key: "name", label: "Member", value: (r) => fullName(r.user).toLowerCase(), cell: (r) => h("div", { class: "person" }, avatar(r.user), h("a", { href: `#/reporting/users/${r.user.id}` }, fullName(r.user))) },
            { key: "status", label: "Status", value: (r) => ["not_started", "needs_rereading", "in_progress", "completed"].indexOf(r.status), cell: statusCell },
            { key: "date", label: "Completed on", value: (r) => r.completed_at, cell: (r) => (r.completed_at ? shortDateTime(r.completed_at) : "") },
          ],
          { initial: { key: "status", direction: "asc" }, onRowHref: (r) => `#/reporting/users/${r.user.id}` },
        )
      : h("div", { class: "card empty-state" }, "This document isn't required for anyone you report on. Make it mandatory in its Access panel."),
  );
}

export async function render(main, { path }) {
  const parts = path.split("/").filter(Boolean);
  const container = h("div", { class: "page" });
  main.append(container);
  if (parts[1] === "users" && Number(parts[2])) return memberReport(container, Number(parts[2]));
  if (parts[1] === "documents" && Number(parts[2])) return documentReport(container, Number(parts[2]));
  return overview(container);
}

// Settings › Import (admins): load the handbook structure from CSV files.
// The browser parses and checks the files, the edge script checks them again
// and returns a preview, and nothing changes until "Import" is clicked.

import { api } from "../api.js";
import { busy, clear, h, icon, setTitle } from "../lib/dom.js";
import { CsvError, parseCsv, toCsv } from "../lib/csv.js";
import { ACCESS_COLUMNS, STRUCTURE_COLUMNS, checkHeader, validateAccessRows, validateStructureRows } from "../lib/import-rules.js";
import { contentChanged } from "../state.js";

const STRUCTURE_EXAMPLE = [
  ["The Academy", "How OneTake works", "📚", "Company Information", "", "Company Information"],
  ["The Academy", "How OneTake works", "📚", "What our product does", "", "18 neuro-science secrets for awesome videos"],
  ["The Academy", "How OneTake works", "📚", "ICP: our Ideal Customer Profile", "", ""],
  ["The Academy", "Going deeper", "📚", "Stock Option Compensation Guidelines", "How stock options work at OneTake AI, and how they vest", "Overview"],
  ["The Academy", "Going deeper", "📚", "Stock Option Compensation Guidelines", "", "Vesting schedule"],
  ["SOP Handbook", "Everyone", "📚", "Hotmart N8N Auth Token Refresh", "", ""],
];
const ACCESS_EXAMPLE = [
  ["Management", "The Academy", "How OneTake works", "", "edit_publish", "yes"],
  ["Marketing", "The Academy", "How OneTake works", "", "view", "yes"],
  ["Marketing", "The Academy", "Going deeper", "", "view", "no"],
  ["Product", "SOP Handbook", "Everyone", "Hotmart N8N Auth Token Refresh", "edit_review", "no"],
];

function download(name, header, rows) {
  const url = URL.createObjectURL(new Blob([toCsv(header, rows)], { type: "text/csv;charset=utf-8" }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function columnsTable(rows) {
  return h(
    "div",
    { class: "table-wrap", style: "margin:8px 0 16px" },
    h(
      "table",
      { class: "table" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Column"), h("th", { scope: "col" }, "Required"), h("th", { scope: "col" }, "Description"))),
      h("tbody", {}, rows.map(([name, required, text]) => h("tr", {}, h("td", {}, h("code", {}, name)), h("td", { "data-label": "Required" }, required), h("td", { "data-label": "Description" }, text)))),
    ),
  );
}

function statusBadge(status) {
  const labels = { new: "New", existing: "Exists", updated: "Updated", unchanged: "Unchanged" };
  return h("span", { class: status === "new" || status === "updated" ? "badge badge--accent" : "badge" }, labels[status] || status);
}

async function readCsv(file, name) {
  const errors = [];
  let parsed = null;
  try {
    parsed = parseCsv(await file.text());
  } catch (e) {
    errors.push({ file: name, line: e instanceof CsvError ? e.line : 1, message: e.message });
    return { errors, rows: [] };
  }
  errors.push(...checkHeader(parsed.header, name));
  for (const row of parsed.rows) {
    if (row.extra) errors.push({ file: name, line: row.line, message: "This row has more fields than the header. Is a comma missing its quotes?" });
  }
  return { errors, parsed };
}

export function render(main) {
  setTitle("Import", "Settings");
  const structureInput = h("input", { type: "file", accept: ".csv,text/csv", id: "structure-file", class: "input" });
  const accessInput = h("input", { type: "file", accept: ".csv,text/csv", id: "access-file", class: "input" });
  const check = h("button", { class: "button button--primary", type: "submit" }, "Check the files");
  const results = h("div", { "aria-live": "polite" });
  let payload = null;

  const form = h(
    "form",
    {
      class: "form",
      onsubmit: async (event) => {
        event.preventDefault();
        await busy(check, checkFiles);
      },
    },
    h("div", { class: "field" }, h("label", { class: "field__label", for: "structure-file" }, "structure.csv (required)"), structureInput),
    h("div", { class: "field" }, h("label", { class: "field__label", for: "access-file" }, "access.csv (optional)"), accessInput),
    h("div", { class: "form-actions" }, check),
  );

  main.append(
    h(
      "div",
      { class: "page page--narrow" },
      h("a", { class: "back-link", href: "#/settings" }, icon("arrowLeft"), "Settings"),
      h("h1", { class: "page-title" }, "Import the handbook structure"),
      h(
        "section",
        { class: "card" },
        h(
          "p",
          { style: "margin-top:0" },
          "Create spaces, categories, documents and steps, and give departments access, from one or two CSV files. Step contents are not imported: you paste them in the editor afterwards.",
        ),
        h(
          "ul",
          { class: "small" },
          h("li", {}, "Nothing changes until you confirm, after a preview."),
          h("li", {}, "Existing items with the same name under the same parent are reused. Nothing is deleted or renamed."),
          h("li", {}, "New documents are created unpublished, so readers don't see empty pages."),
          h("li", {}, "Importing the same files twice creates nothing the second time."),
        ),
        h(
          "div",
          { class: "form-actions" },
          h("button", { class: "button", type: "button", onclick: () => download("structure.csv", STRUCTURE_COLUMNS, STRUCTURE_EXAMPLE) }, "Download an example structure.csv"),
          h("button", { class: "button", type: "button", onclick: () => download("access.csv", ACCESS_COLUMNS, ACCESS_EXAMPLE) }, "Download an example access.csv"),
        ),
        h(
          "details",
          { style: "margin-top:16px" },
          h("summary", { style: "cursor:pointer;font-weight:600;padding:12px 0" }, "File format: columns and rules"),
          h(
            "p",
            { class: "small" },
            "UTF-8, comma-separated, first row is the header. Fields containing commas, quotes or line breaks are wrapped in double quotes, and quotes inside a field are doubled. Names are matched exactly (capital letters count) after trimming spaces. Row order is the display order.",
          ),
          h("h3", { class: "field__label" }, "structure.csv: one row per step"),
          columnsTable([
            ["space", "yes", "Top-level space, for example The Academy"],
            ["category", "yes", "Category within the space"],
            ["category_emoji", "no", "One emoji; only read from the first row of each category"],
            ["document", "yes", "Document title within the category"],
            ["document_description", "no", "Only read from the first row of each document"],
            ["step", "no", "Step title. If empty, the document gets one step with the same title as the document"],
          ]),
          h("h3", { class: "field__label" }, "access.csv: one row per department grant"),
          columnsTable([
            ["department", "yes", "Department name; created if it does not exist"],
            ["space", "yes", "Space of the target"],
            ["category", "yes", "Category of the target"],
            ["document", "no", "If empty, the grant applies to the whole category; if set, it overrides it for that document"],
            ["permission", "yes", "view, edit_review, edit_publish, or none (document rows only)"],
            ["mandatory", "yes", "yes or no"],
          ]),
        ),
      ),
      h("section", { class: "card", "aria-labelledby": "files-title" }, h("h2", { class: "section-title", id: "files-title" }, "Your files"), form),
      results,
    ),
  );

  function showErrors(errors) {
    clear(
      results,
      h(
        "section",
        { class: "card", "aria-labelledby": "errors-title" },
        h("h2", { class: "section-title", id: "errors-title" }, `${errors.length} problem${errors.length === 1 ? "" : "s"} to fix`),
        h("p", { class: "small" }, "Nothing was imported. Fix these lines in your files, then check them again."),
        h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "table" },
            h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "File"), h("th", { scope: "col" }, "Line"), h("th", { scope: "col" }, "Problem"))),
            h("tbody", {}, errors.map((e) => h("tr", {}, h("td", {}, e.file), h("td", { "data-label": "Line" }, String(e.line)), h("td", { "data-label": "Problem" }, e.message)))),
          ),
        ),
      ),
    );
    results.querySelector("h2").setAttribute("tabindex", "-1");
    results.querySelector("h2").focus();
  }

  async function checkFiles() {
    clear(results);
    payload = null;
    const structureFile = structureInput.files[0];
    const accessFile = accessInput.files[0];
    if (!structureFile) {
      showErrors([{ file: "structure.csv", line: 1, message: "Please choose your structure.csv file." }]);
      return;
    }
    const errors = [];
    const structure = await readCsv(structureFile, "structure.csv");
    errors.push(...structure.errors);
    let structureRows = [];
    if (structure.parsed) {
      const checked = validateStructureRows(structure.parsed.rows);
      errors.push(...checked.errors);
      structureRows = checked.rows;
    }
    let accessRows = [];
    if (accessFile) {
      const access = await readCsv(accessFile, "access.csv");
      errors.push(...access.errors);
      if (access.parsed) {
        const checked = validateAccessRows(access.parsed.rows);
        errors.push(...checked.errors);
        accessRows = checked.rows.map((r) => ({ ...r, mandatory: r.mandatory ? "yes" : "no" }));
      }
    }
    if (errors.length) {
      showErrors(errors);
      return;
    }
    payload = { structure: structureRows, access: accessRows };
    try {
      const preview = await api("POST", "/import", { ...payload, dry_run: true });
      showPreview(preview);
    } catch (e) {
      if (e.status === 422 && e.data && e.data.errors) showErrors(e.data.errors);
      else showErrors([{ file: "", line: "", message: e.message }]);
    }
  }

  function showPreview(preview) {
    const c = preview.counts;
    const summary = [
      ["Spaces", c.spaces],
      ["Categories", c.categories],
      ["Documents", c.documents],
      ["Steps", c.steps],
      ["Departments", c.departments],
    ];
    const importButton = h("button", { class: "button button--primary", type: "button" }, "Import");
    importButton.addEventListener("click", () =>
      busy(importButton, async () => {
        try {
          const done = await api("POST", "/import", { ...payload, dry_run: false });
          contentChanged();
          clear(
            results,
            h(
              "section",
              { class: "card", role: "status" },
              h("h2", { class: "section-title" }, "Import complete"),
              h(
                "p",
                {},
                `Created ${done.counts.spaces.created} spaces, ${done.counts.categories.created} categories, ${done.counts.documents.created} documents, ${done.counts.steps.created} steps and ${done.counts.departments.created} departments. ${done.counts.grants.created} access rules were added and ${done.counts.grants.updated} updated.`,
              ),
              h("p", { class: "small" }, "The new documents are unpublished. Turn on Edit in the sidebar to see them, paste their content and publish them."),
            ),
          );
        } catch (e) {
          showErrors(e.status === 422 ? [{ file: "", line: "", message: "The workspace changed since the preview. Check the files again." }] : [{ file: "", line: "", message: e.message }]);
        }
      }),
    );

    const tree = h(
      "ul",
      { class: "tree", style: "margin-bottom:16px" },
      preview.preview.map((space) =>
        h(
          "li",
          {},
          h("div", { class: "tree__row", style: "gap:8px;padding:0 8px" }, h("strong", {}, space.name), statusBadge(space.status)),
          h(
            "ul",
            {},
            space.categories.map((category) =>
              h(
                "li",
                {},
                h("div", { class: "tree__row", style: "gap:8px;padding:0 8px" }, h("span", {}, `${category.emoji ? `${category.emoji} ` : ""}${category.name}`), statusBadge(category.status)),
                h(
                  "ul",
                  {},
                  category.documents.map((doc) =>
                    h(
                      "li",
                      {},
                      h(
                        "div",
                        { class: "tree__row", style: "gap:8px;padding:0 8px;flex-wrap:wrap" },
                        h("span", {}, doc.title),
                        statusBadge(doc.status),
                        h("span", { class: "muted small" }, `${doc.steps.length} step${doc.steps.length === 1 ? "" : "s"}${doc.steps.some((s) => s.status === "new") && doc.status === "existing" ? `, ${doc.steps.filter((s) => s.status === "new").length} new` : ""}`),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    clear(
      results,
      h(
        "section",
        { class: "card", "aria-labelledby": "preview-title" },
        h("h2", { class: "section-title", id: "preview-title", tabindex: "-1" }, "Preview"),
        h(
          "div",
          { class: "tags", style: "margin-bottom:16px" },
          summary.map(([label, n]) => h("span", { class: "badge" }, `${label}: ${n.created} new, ${n.existing} existing`)),
          h("span", { class: "badge" }, `Access rules: ${c.grants.created} new, ${c.grants.updated} updated, ${c.grants.unchanged} unchanged`),
        ),
        tree,
        preview.grants.length
          ? h(
              "div",
              { class: "table-wrap", style: "margin-bottom:16px" },
              h(
                "table",
                { class: "table" },
                h("thead", {}, h("tr", {}, ["Department", "Content", "Permission", "Mandatory", ""].map((t) => h("th", { scope: "col" }, t)))),
                h(
                  "tbody",
                  {},
                  preview.grants.map((g) =>
                    h(
                      "tr",
                      {},
                      h("td", {}, g.department),
                      h("td", { "data-label": "Content" }, g.target),
                      h("td", { "data-label": "Permission" }, g.permission),
                      h("td", { "data-label": "Mandatory" }, g.mandatory ? "yes" : "no"),
                      h("td", { "data-label": "Status" }, statusBadge(g.status)),
                    ),
                  ),
                ),
              ),
            )
          : null,
        h("div", { class: "form-actions" }, importButton, h("span", { class: "muted small" }, "Everything is applied in one go, or not at all.")),
      ),
    );
    results.querySelector("#preview-title").focus();
  }
}

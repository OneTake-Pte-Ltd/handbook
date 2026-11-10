// Access management.
// - openAccessPanel: from a category or document (Edit mode), every grant on it.
// - renderAccessTree: on a member or department page, the grants of that
//   member or department across all content, with the effective access.

import { api } from "../api.js";
import { alertBox, busy, clear, h, loading, openDialog, switchInput, toast } from "../lib/dom.js";
import { fullName } from "../lib/format.js";
import { isAdmin } from "../state.js";

export const LEVELS = ["none", "view", "edit_review", "edit_publish"];
export const LEVEL_LABELS = { none: "None", view: "View", edit_review: "Edit with review", edit_publish: "Edit and publish" };
const rank = (level) => LEVELS.indexOf(level || "none");

function levelSelect({ value, max, allowNone, emptyLabel, label }) {
  const options = [];
  if (emptyLabel) options.push(h("option", { value: "" }, emptyLabel));
  for (const level of LEVELS) {
    if (level === "none" && !allowNone) continue;
    if (rank(level) > rank(max)) continue;
    options.push(h("option", { value: level, selected: level === value }, LEVEL_LABELS[level]));
  }
  // Keep a current value that is above the user's own level visible (read-only).
  if (value && rank(value) > rank(max)) options.push(h("option", { value, selected: true, disabled: true }, LEVEL_LABELS[value]));
  return h("select", { class: "select", "aria-label": label }, options);
}

async function saveGrant(body) {
  return api("PUT", "/grants", body);
}

// Departments and members the current user may give access to.
async function principalChoices() {
  const [{ departments }, { users }] = await Promise.all([api("GET", "/departments"), api("GET", "/users?status=active")]);
  const allowed = isAdmin() ? departments : departments.filter((d) => d.i_lead);
  return {
    departments: allowed.map((d) => ({ type: "department", id: d.id, name: d.name })),
    users: users.map((u) => ({ type: "user", id: u.id, name: `${fullName(u)} (${u.email})` })),
  };
}

// The Access panel of a category or a document. target: { type, id, name }
export function openAccessPanel(target) {
  const content = h("div", {}, loading());
  openDialog({ title: `Access to ${target.name}`, content });
  load();

  async function load() {
    let data;
    let choices;
    try {
      [data, choices] = await Promise.all([api("GET", `/grants?target=${target.type}:${target.id}`), principalChoices()]);
    } catch (e) {
      clear(content, h("div", { class: "alert alert--error" }, e.message));
      return;
    }
    const allowNone = target.type === "document";
    const rows = data.grants.map((g) => {
      const select = levelSelect({ value: g.level, max: data.max_level, allowNone, label: `Permission for ${g.principal_name}` });
      select.addEventListener("change", () => update(g, { level: select.value }));
      return h(
        "li",
        { class: "row" },
        h("span", {}, h("strong", {}, g.principal_name), h("span", { class: "muted small" }, g.principal_type === "department" ? " (department)" : " (member)")),
        h(
          "div",
          { class: "row__actions" },
          select,
          switchInput({ checked: g.mandatory, label: "Mandatory", disabled: g.level === "none", onchange: (checked) => update(g, { mandatory: checked }) }),
          h("button", { class: "button button--ghost", type: "button", onclick: () => remove(g) }, "Remove"),
        ),
      );
    });

    const error = alertBox();
    const who = h(
      "select",
      { class: "select", "aria-label": "Department or member" },
      h("optgroup", { label: "Departments" }, choices.departments.map((p) => h("option", { value: `department:${p.id}` }, p.name))),
      choices.users.length ? h("optgroup", { label: "Members" }, choices.users.map((p) => h("option", { value: `user:${p.id}` }, p.name))) : null,
    );
    const level = levelSelect({ value: "view", max: data.max_level, allowNone, label: "Permission" });
    const mandatory = h("input", { type: "checkbox" });
    const add = h("button", { class: "button button--primary", type: "submit" }, "Add");
    const addForm = h(
      "form",
      {
        class: "form",
        style: "margin-top:16px",
        onsubmit: async (event) => {
          event.preventDefault();
          error.show("");
          const [principal_type, principal_id] = who.value.split(":");
          await busy(add, async () => {
            try {
              await saveGrant({ target_type: target.type, target_id: target.id, principal_type, principal_id: Number(principal_id), level: level.value, mandatory: mandatory.checked });
              await load();
            } catch (e) {
              error.show(e.message);
            }
          });
        },
      },
      h("h3", { class: "field__label", style: "margin:0" }, "Give access"),
      error.el,
      who,
      h("div", { style: "display:flex;gap:12px;flex-wrap:wrap;align-items:center" }, level, h("label", { class: "check" }, mandatory, "Mandatory"), add),
    );

    clear(
      content,
      h(
        "p",
        { class: "muted small", style: "margin-top:0" },
        target.type === "category"
          ? "These grants apply to every document in this category, unless a document has its own grant for the same department or member."
          : "A grant here replaces the category's grant for that department or member. Use None to exclude this document.",
      ),
      rows.length ? h("ul", { class: "rows grant-list", style: "margin:0" }, rows) : h("p", { class: "small" }, "Nobody has access through a grant on this yet. Admins always have access."),
      addForm,
    );
  }

  async function update(grant, change) {
    try {
      await saveGrant({ target_type: grant.target_type, target_id: grant.target_id, principal_type: grant.principal_type, principal_id: grant.principal_id, level: grant.level, mandatory: grant.mandatory, ...change });
      await load();
    } catch (e) {
      toast(e.message, { kind: "error" });
      await load();
    }
  }

  async function remove(grant) {
    try {
      await api("DELETE", `/grants/${grant.id}`);
      await load();
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }
}

// The Access tree of a member (principal.type "user") or a department.
export async function renderAccessTree(container, principal) {
  clear(container, loading());
  let data;
  try {
    data = await api("GET", `/grants?principal=${principal.type}:${principal.id}`);
  } catch (e) {
    clear(container, h("div", { class: "alert alert--error" }, e.message));
    return;
  }
  const reload = () => renderAccessTree(container, principal);

  async function change(target, grant, { level, mandatory }) {
    try {
      if (level === "") {
        if (grant) await api("DELETE", `/grants/${grant.id}`);
      } else {
        await saveGrant({ target_type: target.type, target_id: target.id, principal_type: principal.type, principal_id: principal.id, level, mandatory: Boolean(mandatory) });
      }
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
    await reload();
  }

  function row(kind, target, name, max) {
    const grant = data.grants[`${kind}:${target.id}`];
    const select = levelSelect({
      value: grant ? grant.level : "",
      max,
      allowNone: kind === "document",
      emptyLabel: kind === "document" ? "Same as category" : "No access",
      label: `Permission on ${name}`,
    });
    select.addEventListener("change", () => change({ type: kind, id: target.id }, grant, { level: select.value, mandatory: grant ? grant.mandatory : false }));
    const effective = kind === "document" ? data.effective[`document:${target.id}`] : null;
    const effectiveText = effective
      ? effective.level === "none"
        ? "No access"
        : `${LEVEL_LABELS[effective.level]}${effective.mandatory ? ", mandatory" : ""}${effective.source ? `, ${effective.source}` : ""}`
      : "";
    return h(
      "div",
      { class: `access-row access-row--${kind}` },
      h(
        "div",
        { class: "access-row__name" },
        kind === "category" ? h("strong", {}, `${target.emoji ? `${target.emoji} ` : ""}${name}`) : h("span", {}, name, target.is_published ? null : h("span", { class: "tree__tag", style: "margin-left:6px" }, "Draft")),
        effectiveText ? h("span", { class: "access-row__effective" }, effectiveText) : null,
      ),
      select,
      switchInput({
        checked: Boolean(grant && grant.mandatory),
        label: "Mandatory",
        disabled: !grant || grant.level === "none",
        onchange: (checked) => change({ type: kind, id: target.id }, grant, { level: grant.level, mandatory: checked }),
      }),
      h("span", { class: "differs", title: "This document's settings differ from its category's", "aria-label": target.differs ? "Differs from its category" : null }, target.differs ? "≠" : ""),
    );
  }

  const rows = [];
  for (const space of data.tree) {
    rows.push(h("div", { class: "access-row access-row--space" }, space.name));
    for (const category of space.categories) {
      rows.push(row("category", category, category.name, category.max_level));
      for (const doc of category.documents) rows.push(row("document", doc, doc.title, doc.max_level));
    }
  }
  clear(
    container,
    data.tree.length ? h("div", { class: "rows", style: "margin-bottom:-24px" }, rows) : h("p", { class: "small" }, "There is no content to give access to yet."),
  );
}

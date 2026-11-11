// Members list and member page.

import { api } from "../api.js";
import {
  alertBox,
  avatar,
  busy,
  clear,
  confirmDialog,
  field,
  h,
  icon,
  input,
  loading,
  openDialog,
  setTitle,
  switchInput,
  toast,
} from "../lib/dom.js";
import { fullName, relativeTime } from "../lib/format.js";
import { isAdmin, session } from "../state.js";
import { openAddMemberDialog, temporaryPasswordPanel } from "./member-form.js";
import { renderAccessTree } from "./access.js";

export function completionText(completion) {
  if (!completion || !completion.total) return "No mandatory documents";
  return `${Math.round((completion.completed / completion.total) * 100)}% (${completion.completed} of ${completion.total})`;
}

function departmentTags(departments = []) {
  return h(
    "div",
    { class: "tags" },
    departments.map((d) => h("span", { class: d.is_leader ? "badge badge--accent" : "badge" }, d.is_leader ? `${d.name} · Leader` : d.name)),
  );
}

function statusBadges(user) {
  return [
    user.is_admin ? h("span", { class: "badge badge--accent" }, "Admin") : null,
    user.is_active ? null : h("span", { class: "badge badge--quiet" }, "Deactivated"),
  ];
}

// Rows open the member page on click; the name is also a real link for keyboards.
function clickableRows(tbody) {
  tbody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-href]");
    if (row && !event.target.closest("a, button, input, label")) location.hash = row.dataset.href;
  });
}

export async function renderMembersList(container) {
  setTitle("Members", "Organization");
  const departments = (await api("GET", "/departments")).departments;
  const admin = isAdmin();

  const search = input({ type: "search", placeholder: "Search by name or email", "aria-label": "Search members", autocomplete: "off" });
  const departmentFilter = h(
    "select",
    { class: "select", "aria-label": "Filter by department" },
    h("option", { value: "" }, "All departments"),
    departments.filter((d) => !d.is_system).map((d) => h("option", { value: String(d.id) }, d.name)),
  );
  const statusFilter = h(
    "select",
    { class: "select", "aria-label": "Filter by status" },
    h("option", { value: "active" }, "Active"),
    h("option", { value: "deactivated" }, "Deactivated"),
    h("option", { value: "admins" }, "Admins"),
    h("option", { value: "all" }, "All"),
  );
  const results = h("div", { "aria-live": "polite" });
  const canAdd = admin || departments.some((d) => d.i_lead);

  container.append(
    h(
      "div",
      { class: "page-header" },
      h("h1", { class: "page-title" }, "Members"),
      canAdd
        ? h("button", { class: "button button--primary", type: "button", onclick: () => openAddMemberDialog({ departments, onSaved: () => load() }) }, "Add member")
        : null,
    ),
    h("div", { class: "filters" }, h("div", { class: "search-field" }, icon("search"), search), departmentFilter, statusFilter),
    results,
  );

  let ticket = 0;
  async function load() {
    const mine = ++ticket;
    const params = new URLSearchParams({ q: search.value.trim(), status: statusFilter.value });
    if (departmentFilter.value) params.set("department", departmentFilter.value);
    clear(results, loading());
    const { users } = await api("GET", `/users?${params}`);
    if (mine !== ticket) return;
    if (!users.length) {
      clear(results, h("div", { class: "card empty-state" }, "No members match these filters."));
      return;
    }
    const tbody = h(
      "tbody",
      {},
      users.map((u) =>
        h(
          "tr",
          { dataset: { href: `#/organization/members/${u.id}` } },
          h("td", {}, h("div", { class: "person" }, avatar(u), h("div", {}, h("a", { href: `#/organization/members/${u.id}` }, fullName(u)), h("div", { class: "muted small" }, u.email)))),
          h("td", { "data-label": "Role" }, u.role_title || ""),
          h("td", { "data-label": "Departments" }, departmentTags(u.departments)),
          h("td", { class: "progress-cell", "data-label": "Completion" }, u.completion && u.completion.total ? h("a", { href: `#/reporting/users/${u.id}` }, completionText(u.completion)) : completionText(u.completion)),
          h("td", { class: "nowrap", "data-label": "Last login" }, u.last_login_at ? relativeTime(u.last_login_at) : "Never"),
          h("td", { "data-label": "Status" }, h("div", { class: "tags" }, statusBadges(u), u.is_active && !u.is_admin ? "Active" : null)),
        ),
      ),
    );
    clickableRows(tbody);
    clear(
      results,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "table" },
          h("thead", {}, h("tr", {}, ["Name", "Role", "Departments", "Completion", "Last login", "Status"].map((t) => h("th", { scope: "col" }, t)))),
          tbody,
        ),
      ),
      h("p", { class: "muted small" }, `${users.length} member${users.length === 1 ? "" : "s"}`),
    );
  }

  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  });
  departmentFilter.addEventListener("change", load);
  statusFilter.addEventListener("change", load);
  await load();
}

export async function renderMemberPage(container, id) {
  container.append(loading());
  const [{ user, permissions }, { departments: allDepartments }] = await Promise.all([api("GET", `/users/${id}`), api("GET", "/departments")]);
  clear(container);
  setTitle(fullName(user), "Organization");
  const self = user.id === session.me.user.id;
  const leads = new Set(permissions.leads);
  const reload = () => {
    clear(container);
    return renderMemberPage(container, id);
  };

  // Header
  container.append(
    h("a", { class: "back-link", href: "#/organization" }, icon("arrowLeft"), "Members"),
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "profile-head" },
        avatar(user, "lg"),
        h(
          "div",
          {},
          h("h1", { class: "profile-head__name" }, fullName(user)),
          h("div", { class: "muted small" }, user.email),
          user.role_title ? h("div", { class: "small" }, user.role_title) : null,
          h("div", { class: "tags", style: "margin-top:8px" }, statusBadges(user)),
          h("div", { class: "muted small", style: "margin-top:4px" }, user.last_login_at ? `Last login ${relativeTime(user.last_login_at)}` : "Has not logged in yet"),
        ),
      ),
    ),
  );

  // Details
  if (permissions.can_edit_details) {
    const error = alertBox();
    const firstName = input({ value: user.first_name, required: true });
    const lastName = input({ value: user.last_name, required: true });
    const roleTitle = input({ value: user.role_title });
    const email = input({ type: "email", value: user.email, disabled: !permissions.can_edit_email });
    const save = h("button", { class: "button button--primary", type: "submit" }, "Save");
    const form = h(
      "form",
      {
        class: "form",
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          error.show("");
          const body = { first_name: firstName.value, last_name: lastName.value };
          if (!self || isAdmin()) body.role_title = roleTitle.value;
          if (permissions.can_edit_email && email.value.trim() !== user.email) body.email = email.value;
          await busy(save, async () => {
            try {
              await api("PATCH", `/users/${user.id}`, body);
              toast("Saved.");
              await reload();
            } catch (e) {
              error.show(e.message);
            }
          });
        },
      },
      error.el,
      h("div", { class: "form-row" }, field({ label: "First name", input: firstName }), field({ label: "Last name", input: lastName })),
      h("div", { class: "form-row" }, field({ label: "Role title", input: roleTitle }), field({ label: "Email", hint: permissions.can_edit_email ? null : "Only admins can change it.", input: email })),
      h("div", { class: "form-actions" }, save),
    );
    if (self && !isAdmin()) roleTitle.disabled = true;
    container.append(h("section", { class: "card", "aria-labelledby": "details-title" }, h("h2", { class: "section-title", id: "details-title" }, "Details"), form));
  }

  // Departments
  const memberOf = new Set(user.departments.map((d) => d.id));
  const addable = allDepartments.filter((d) => !d.is_system && !memberOf.has(d.id) && (permissions.can_manage_departments || leads.has(d.id)));
  const rows = h(
    "ul",
    { class: "rows" },
    user.departments.map((d) => {
      const canRemove = permissions.can_manage_departments || (leads.has(d.id) && !d.is_leader);
      return h(
        "li",
        { class: "row" },
        h("span", {}, h("strong", {}, d.name)),
        h(
          "div",
          { class: "row__actions" },
          permissions.can_manage_departments
            ? switchInput({
                checked: d.is_leader,
                label: "Team leader",
                onchange: async (checked, box) => {
                  try {
                    await api("PUT", `/departments/${d.id}/members/${user.id}`, { is_leader: checked });
                    toast(checked ? `${user.first_name} now leads ${d.name}.` : `${user.first_name} no longer leads ${d.name}.`);
                  } catch (e) {
                    box.checked = !checked;
                    toast(e.message, { kind: "error" });
                  }
                },
              })
            : d.is_leader
              ? h("span", { class: "badge badge--accent" }, "Leader")
              : null,
          canRemove
            ? h(
                "button",
                {
                  class: "button button--ghost",
                  type: "button",
                  onclick: async () => {
                    if (!(await confirmDialog({ title: "Remove from department", text: `Remove ${fullName(user)} from ${d.name}? They lose the access this department gives.`, confirmLabel: "Remove", danger: true }))) return;
                    try {
                      await api("DELETE", `/departments/${d.id}/members/${user.id}`);
                      await reload();
                    } catch (e) {
                      toast(e.message, { kind: "error" });
                    }
                  },
                },
                "Remove",
              )
            : null,
        ),
      );
    }),
  );
  const addSelect = h("select", { class: "select", "aria-label": "Department to add" }, addable.map((d) => h("option", { value: String(d.id) }, d.name)));
  const addButton = h("button", { class: "button", type: "submit" }, "Add");
  container.append(
    h(
      "section",
      { class: "card", "aria-labelledby": "departments-title" },
      h("h2", { class: "section-title", id: "departments-title" }, "Departments"),
      h("p", { class: "muted small" }, user.is_active ? "Every active member is also in Everyone." : "Deactivated accounts keep their departments, in case they are reactivated."),
      user.departments.length ? rows : h("p", { class: "small" }, "Not in any department yet."),
      addable.length
        ? h(
            "form",
            {
              class: "inline-form",
              onsubmit: async (event) => {
                event.preventDefault();
                await busy(addButton, async () => {
                  try {
                    await api("PUT", `/departments/${addSelect.value}/members/${user.id}`, {});
                    await reload();
                  } catch (e) {
                    toast(e.message, { kind: "error" });
                  }
                });
              },
            },
            h("div", { class: "field" }, h("label", { class: "field__label" }, "Add to a department"), addSelect),
            addButton,
          )
        : null,
    ),
  );

  // Progress, with a link to the full report.
  if (user.is_active && (isAdmin() || permissions.can_edit_details) && !(self && !isAdmin())) {
    container.append(
      h(
        "section",
        { class: "card", "aria-labelledby": "progress-title" },
        h("h2", { class: "section-title", id: "progress-title" }, "Progress"),
        h("p", { style: "margin:0 0 12px" }, user.completion ? completionText(user.completion) : "See the report for this member's required documents."),
        h("a", { class: "button", href: `#/reporting/users/${user.id}` }, "View the report"),
      ),
    );
  }

  // Access: user-level grants, with the effective access and its source.
  if (user.is_active && (isAdmin() || permissions.can_edit_details) && !(self && !isAdmin())) {
    const tree = h("div");
    container.append(
      h(
        "section",
        { class: "card", "aria-labelledby": "access-title" },
        h("h2", { class: "section-title", id: "access-title" }, "Access"),
        h(
          "p",
          { class: "muted small" },
          user.is_admin
            ? "Admins can edit everything. Grants here only decide what is mandatory for them."
            : "Grants for this member only. They can add access but never remove what a department gives. Muted text shows the effective access and where it comes from.",
        ),
        tree,
      ),
    );
    renderAccessTree(tree, { type: "user", id: user.id });
  }

  // Account actions
  const actions = [];
  if (permissions.can_reset_password && user.is_active) {
    actions.push(
      h(
        "button",
        {
          class: "button",
          type: "button",
          onclick: async () => {
            if (!(await confirmDialog({ title: "Reset password", text: `${fullName(user)} will be logged out everywhere and will need the new temporary password to log in.`, confirmLabel: "Reset password" }))) return;
            try {
              const { temporary_password } = await api("POST", `/users/${user.id}/reset-password`);
              openDialog({ title: "New temporary password", content: temporaryPasswordPanel(user, temporary_password) });
            } catch (e) {
              toast(e.message, { kind: "error" });
            }
          },
        },
        icon("key"),
        "Reset password",
      ),
    );
  }
  if (permissions.can_change_admin) {
    actions.push(
      h(
        "button",
        {
          class: "button",
          type: "button",
          onclick: async () => {
            const make = !user.is_admin;
            if (!(await confirmDialog({ title: make ? "Make admin" : "Remove admin status", text: make ? `${fullName(user)} will be able to do everything, everywhere.` : `${fullName(user)} will only keep the access their departments and grants give.`, confirmLabel: make ? "Make admin" : "Remove admin status", danger: !make }))) return;
            try {
              await api("PATCH", `/users/${user.id}`, { is_admin: make });
              await reload();
            } catch (e) {
              toast(e.message, { kind: "error" });
            }
          },
        },
        user.is_admin ? "Remove admin status" : "Make admin",
      ),
    );
  }
  if (permissions.can_change_status) {
    actions.push(
      h(
        "button",
        {
          class: user.is_active ? "button button--danger" : "button",
          type: "button",
          onclick: async () => {
            const deactivate = user.is_active;
            if (deactivate && !(await confirmDialog({ title: "Deactivate account", text: `${fullName(user)} won't be able to log in, and is logged out now. You can reactivate the account later.`, confirmLabel: "Deactivate", danger: true }))) return;
            try {
              await api("PATCH", `/users/${user.id}`, { is_active: !deactivate });
              toast(deactivate ? "Account deactivated." : "Account reactivated.");
              await reload();
            } catch (e) {
              toast(e.message, { kind: "error" });
            }
          },
        },
        user.is_active ? "Deactivate account" : "Reactivate account",
      ),
    );
  }
  if (actions.length) {
    container.append(h("section", { class: "card", "aria-labelledby": "account-title" }, h("h2", { class: "section-title", id: "account-title" }, "Account"), h("div", { class: "form-actions" }, actions)));
  }
}

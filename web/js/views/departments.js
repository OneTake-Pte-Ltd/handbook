// Departments list and department page.

import { api } from "../api.js";
import { alertBox, avatar, busy, clear, confirmDialog, field, h, icon, input, loading, setTitle, switchInput, toast } from "../lib/dom.js";
import { fullName } from "../lib/format.js";
import { isAdmin } from "../state.js";
import { openAddMemberDialog } from "./member-form.js";

export async function renderDepartmentsList(container) {
  setTitle("Departments", "Organization");
  container.append(loading());
  const { departments } = await api("GET", "/departments");
  clear(container);
  const admin = isAdmin();
  const visible = admin ? departments : departments.filter((d) => d.i_lead);

  const tbody = h(
    "tbody",
    {},
    visible.map((d) =>
      h(
        "tr",
        { dataset: { href: `#/organization/departments/${d.id}` } },
        h(
          "td",
          {},
          h("div", { class: "person" }, icon("organization"), h("a", { href: `#/organization/departments/${d.id}` }, d.name), d.is_system ? h("span", { class: "badge" }, "Automatic") : null),
        ),
        h("td", { class: "numeric", "data-label": "Members" }, String(d.member_count)),
        h("td", { class: "numeric", "data-label": "Leaders" }, d.is_system ? "" : String(d.leader_count)),
      ),
    ),
  );
  tbody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-href]");
    if (row && !event.target.closest("a")) location.hash = row.dataset.href;
  });

  container.append(
    h("div", { class: "page-header" }, h("h1", { class: "page-title" }, "Departments")),
    h(
      "div",
      { class: "table-wrap" },
      h("table", { class: "table" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Department"), h("th", { scope: "col", class: "numeric" }, "Members"), h("th", { scope: "col", class: "numeric" }, "Leaders"))), tbody),
    ),
    h("p", { class: "muted small" }, "Department, team and group all mean the same thing here. Everyone contains every active member automatically."),
  );

  if (admin) {
    const error = alertBox();
    const name = input({ name: "name", maxlength: 80, required: true });
    const submit = h("button", { class: "button button--primary", type: "submit" }, "Create department");
    container.append(
      h(
        "section",
        { class: "card", style: "margin-top:24px" },
        h("h2", { class: "section-title" }, "New department"),
        error.el,
        h(
          "form",
          {
            class: "inline-form",
            style: "margin-top:0",
            novalidate: true,
            onsubmit: async (event) => {
              event.preventDefault();
              error.show("");
              await busy(submit, async () => {
                try {
                  const { department } = await api("POST", "/departments", { name: name.value });
                  location.hash = `#/organization/departments/${department.id}`;
                } catch (e) {
                  error.show(e.message);
                }
              });
            },
          },
          field({ label: "Name", input: name }),
          submit,
        ),
      ),
    );
  }
}

export async function renderDepartmentPage(container, id) {
  container.append(loading());
  const [{ department, members, permissions }, { departments }] = await Promise.all([api("GET", `/departments/${id}`), api("GET", "/departments")]);
  clear(container);
  setTitle(department.name, "Organization");
  const reload = () => {
    clear(container);
    return renderDepartmentPage(container, id);
  };

  container.append(
    h("a", { class: "back-link", href: "#/organization/departments" }, icon("arrowLeft"), "Departments"),
    h(
      "div",
      { class: "page-header" },
      h("h1", { class: "page-title" }, department.name),
      permissions.can_add_members
        ? h("button", { class: "button button--primary", type: "button", onclick: () => openAddMemberDialog({ departments, preset: department.id, onSaved: () => reload() }) }, "Add member")
        : null,
    ),
  );
  if (department.is_system) {
    container.append(h("div", { class: "alert alert--info", style: "margin-bottom:16px" }, "Every active member is in Everyone automatically. Give access to Everyone to share content with the whole team."));
  }

  // Admins can also add someone who already has an account, from a list.
  if (permissions.can_set_leaders) {
    const inDepartment = new Set(members.map((m) => m.id));
    const { users } = await api("GET", "/users?status=active");
    const candidates = users.filter((u) => !inDepartment.has(u.id));
    if (candidates.length) {
      const select = h("select", { class: "select", "aria-label": "Member to add" }, candidates.map((u) => h("option", { value: String(u.id) }, `${fullName(u)} (${u.email})`)));
      const add = h("button", { class: "button", type: "submit" }, "Add");
      container.append(
        h(
          "form",
          {
            class: "inline-form card",
            style: "margin:0 0 24px",
            onsubmit: async (event) => {
              event.preventDefault();
              await busy(add, async () => {
                try {
                  await api("PUT", `/departments/${department.id}/members/${select.value}`, {});
                  await reload();
                } catch (e) {
                  toast(e.message, { kind: "error" });
                }
              });
            },
          },
          h("div", { class: "field" }, h("label", { class: "field__label" }, "Add an existing member"), select),
          add,
        ),
      );
    }
  }

  if (!members.length) {
    container.append(h("div", { class: "card empty-state" }, "No members yet."));
  } else {
    container.append(
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "table" },
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Member"), h("th", { scope: "col" }, "Role"), department.is_system ? null : h("th", { scope: "col" }, "Leader"), h("th", { scope: "col", class: "actions" }, h("span", { class: "visually-hidden" }, "Actions")))),
          h(
            "tbody",
            {},
            members.map((m) =>
              h(
                "tr",
                {},
                h("td", {}, h("div", { class: "person" }, avatar(m), h("div", {}, h("a", { href: `#/organization/members/${m.id}` }, fullName(m)), h("div", { class: "muted small" }, m.email)), m.is_active ? null : h("span", { class: "badge badge--quiet" }, "Deactivated"))),
                h("td", { "data-label": "Role" }, m.role_title || ""),
                department.is_system
                  ? null
                  : h(
                      "td",
                      { "data-label": "Leader" },
                      permissions.can_set_leaders
                        ? switchInput({
                            checked: m.is_leader,
                            label: h("span", { class: "visually-hidden" }, `${fullName(m)} leads ${department.name}`),
                            onchange: async (checked, box) => {
                              try {
                                await api("PUT", `/departments/${department.id}/members/${m.id}`, { is_leader: checked });
                              } catch (e) {
                                box.checked = !checked;
                                toast(e.message, { kind: "error" });
                              }
                            },
                          })
                        : m.is_leader
                          ? h("span", { class: "badge badge--accent" }, "Leader")
                          : "",
                    ),
                h(
                  "td",
                  { class: "actions" },
                  permissions.can_add_members && (permissions.can_set_leaders || !m.is_leader)
                    ? h(
                        "button",
                        {
                          class: "button button--ghost",
                          type: "button",
                          onclick: async () => {
                            if (!(await confirmDialog({ title: "Remove from department", text: `Remove ${fullName(m)} from ${department.name}? They lose the access this department gives.`, confirmLabel: "Remove", danger: true }))) return;
                            try {
                              await api("DELETE", `/departments/${department.id}/members/${m.id}`);
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
              ),
            ),
          ),
        ),
      ),
    );
  }

  if (permissions.can_rename) {
    const error = alertBox();
    const name = input({ value: department.name, maxlength: 80 });
    const save = h("button", { class: "button", type: "submit" }, "Rename");
    container.append(
      h(
        "section",
        { class: "card", style: "margin-top:24px" },
        h("h2", { class: "section-title" }, "Settings"),
        error.el,
        h(
          "form",
          {
            class: "inline-form",
            style: "margin-top:0",
            novalidate: true,
            onsubmit: async (event) => {
              event.preventDefault();
              error.show("");
              await busy(save, async () => {
                try {
                  await api("PATCH", `/departments/${department.id}`, { name: name.value });
                  toast("Department renamed.");
                  await reload();
                } catch (e) {
                  error.show(e.message);
                }
              });
            },
          },
          field({ label: "Department name", input: name }),
          save,
        ),
        h(
          "div",
          { class: "form-actions", style: "margin-top:24px" },
          h(
            "button",
            {
              class: "button button--danger",
              type: "button",
              onclick: async () => {
                if (!(await confirmDialog({ title: "Delete department", text: `Delete ${department.name}? Its members keep their accounts, but lose the access this department gives. This can't be undone.`, confirmLabel: "Delete department", danger: true }))) return;
                try {
                  await api("DELETE", `/departments/${department.id}`);
                  toast("Department deleted.");
                  location.hash = "#/organization/departments";
                } catch (e) {
                  toast(e.message, { kind: "error" });
                }
              },
            },
            "Delete department",
          ),
        ),
      ),
    );
  }
}

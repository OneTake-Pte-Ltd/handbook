// "Add member" dialog, used by admins and team leaders, and the panel that
// shows a temporary password once.

import { api, loginLink } from "../api.js";
import { alertBox, busy, clear, copyButton, field, h, input, openDialog } from "../lib/dom.js";
import { fullName } from "../lib/format.js";
import { isAdmin } from "../state.js";

// Shown after creating a member or resetting a password. The password is
// never stored in the app; once this is closed it is gone.
export function temporaryPasswordPanel(user, password, { intro } = {}) {
  const link = loginLink();
  const message = `Hello ${user.first_name}, here is your access to our handbook.\n\nLog in at: ${link}\nEmail: ${user.email}\nTemporary password: ${password}\n\nYou will choose your own password when you first log in.`;
  return h(
    "div",
    { class: "form" },
    h("div", { class: "alert alert--info", role: "status" }, intro || `Share this temporary password privately with ${fullName(user)}. It is shown only once.`),
    h("div", { class: "field" }, h("span", { class: "field__label" }, "Temporary password"), h("div", { class: "secret-box" }, h("span", { style: "flex:1" }, password), copyButton(() => password))),
    h("div", { class: "field" }, h("span", { class: "field__label" }, "Login link"), h("div", { class: "secret-box", style: "font-size:0.875rem" }, h("span", { style: "flex:1" }, link), copyButton(() => link))),
    h("div", { class: "form-actions" }, copyButton(() => message, "Copy a message with all of this")),
  );
}

// departments: the list from GET /api/departments.
// preset: department id to tick by default (and the only choice for leaders).
export function openAddMemberDialog({ departments, preset, onSaved }) {
  const admin = isAdmin();
  const choices = departments.filter((d) => !d.is_system && (admin || d.i_lead));
  const error = alertBox();
  const firstName = input({ name: "first_name", autocomplete: "off", required: true });
  const lastName = input({ name: "last_name", autocomplete: "off", required: true });
  const email = input({ type: "email", name: "email", autocomplete: "off", required: true });
  const roleTitle = input({ name: "role_title", autocomplete: "off", placeholder: "Head of Marketing" });
  const adminBox = h("input", { type: "checkbox", name: "is_admin" });
  const submit = h("button", { class: "button button--primary", type: "submit" }, "Add member");

  const rows = choices.map((d) => {
    const member = h("input", { type: "checkbox", value: String(d.id), checked: d.id === preset || (!admin && choices.length === 1) });
    const leader = h("input", { type: "checkbox", disabled: !(d.id === preset) });
    member.addEventListener("change", () => {
      leader.disabled = !member.checked;
      if (!member.checked) leader.checked = false;
    });
    leader.disabled = !member.checked;
    return {
      id: d.id,
      member,
      leader,
      el: h(
        "div",
        { class: "check-row" },
        h("label", { class: "check" }, member, d.name),
        admin ? h("label", { class: "check small" }, leader, "Team leader") : null,
      ),
    };
  });

  const form = h(
    "form",
    { class: "form", novalidate: true },
    error.el,
    h("div", { class: "form-row" }, field({ label: "First name", input: firstName }), field({ label: "Last name", input: lastName })),
    field({ label: "Email", hint: "If this person already has an account, they are added to the departments you choose.", input: email }),
    field({ label: "Role title", hint: "Optional.", input: roleTitle }),
    choices.length
      ? h("fieldset", { class: "field" }, h("legend", { class: "field__label" }, "Departments"), h("div", { class: "check-list" }, rows.map((r) => r.el)))
      : null,
    admin ? h("label", { class: "check" }, adminBox, h("span", {}, h("strong", {}, "Admin"), h("span", { class: "muted small" }, " (can do everything, everywhere)"))) : null,
    h("div", { class: "dialog__footer" }, submit),
  );

  const { body } = openDialog({ title: "Add a member", content: form });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.show("");
    const chosen = rows.filter((r) => r.member.checked).map((r) => ({ id: r.id, is_leader: r.leader.checked }));
    if (!email.value.trim()) {
      error.show("Please enter an email address.");
      email.focus();
      return;
    }
    if (!admin && !chosen.length) {
      error.show("Please choose a department.");
      return;
    }
    await busy(submit, async () => {
      try {
        const result = await api("POST", "/users", {
          first_name: firstName.value,
          last_name: lastName.value,
          email: email.value,
          role_title: roleTitle.value,
          departments: chosen,
          is_admin: admin && adminBox.checked,
        });
        onSaved(result);
        if (result.existing) {
          clear(
            body,
            h(
              "div",
              { class: "form" },
              h(
                "div",
                { class: "alert alert--info", role: "status" },
                result.user.is_active
                  ? `${fullName(result.user)} already has an account. ${result.added ? "They were added to the departments you chose." : "They were already in those departments."}`
                  : `${fullName(result.user)} already has an account, but it is deactivated. Reactivate it from their member page.`,
              ),
            ),
          );
        } else {
          clear(body, temporaryPasswordPanel(result.user, result.temporary_password));
        }
      } catch (e) {
        error.show(e.message);
      }
    });
  });
  firstName.focus();
}

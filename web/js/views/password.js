// Change-password form, used on the profile page and for the forced change
// after logging in with a temporary password.

import { api } from "../api.js";
import { alertBox, busy, clear, field, h, input, toast } from "../lib/dom.js";
import { session, workspaceLogo } from "../state.js";

const MIN_PASSWORD = 10;

export function passwordForm({ currentLabel = "Current password", submitLabel = "Change password", onDone }) {
  const error = alertBox();
  const current = input({ type: "password", name: "current_password", autocomplete: "current-password", required: true });
  const next = input({ type: "password", name: "new_password", autocomplete: "new-password", required: true, minlength: MIN_PASSWORD });
  const confirm = input({ type: "password", name: "confirm_password", autocomplete: "new-password", required: true });
  const submit = h("button", { class: "button button--primary", type: "submit" }, submitLabel);

  const form = h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        error.show("");
        if (!current.value) {
          error.show(`Please enter your ${currentLabel.toLowerCase()}.`);
          current.focus();
          return;
        }
        if (next.value.length < MIN_PASSWORD) {
          error.show(`Passwords need at least ${MIN_PASSWORD} characters.`);
          next.focus();
          return;
        }
        if (next.value !== confirm.value) {
          error.show("The two new passwords don't match.");
          confirm.focus();
          return;
        }
        await busy(submit, async () => {
          try {
            await api("POST", "/password", { current_password: current.value, new_password: next.value });
            form.reset();
            onDone();
          } catch (e) {
            error.show(e.message);
          }
        });
      },
    },
    error.el,
    field({ label: currentLabel, input: current }),
    field({ label: "New password", hint: `At least ${MIN_PASSWORD} characters.`, input: next }),
    field({ label: "Confirm the new password", input: confirm }),
    h("div", { class: "form-actions" }, submit),
  );
  return form;
}

// Full-screen step shown when must_change_password is set.
export function renderForcedPasswordChange(root, { onDone, onLogout }) {
  const me = session.me;
  const form = passwordForm({
    currentLabel: "Temporary password",
    submitLabel: "Save my new password",
    onDone: () => {
      toast("Your new password is saved.");
      onDone();
    },
  });
  clear(root,
    h(
      "main",
      { class: "login" },
      h(
        "div",
        { class: "card login__card" },
        h(
          "div",
          { class: "login__brand" },
          h("img", { class: "login__logo", src: workspaceLogo(me.workspace), alt: "" }),
          h("h1", { class: "login__title" }, `Welcome, ${me.user.first_name}`),
          h("p", { class: "muted small", style: "margin:0" }, "Please choose your own password to replace the temporary one you were given."),
        ),
        form,
        h("p", { class: "small", style: "margin:16px 0 0;text-align:center" }, h("button", { class: "link-button", type: "button", onclick: onLogout }, "Log out")),
      ),
    ),
  );
  form.querySelector("input")?.focus();
}

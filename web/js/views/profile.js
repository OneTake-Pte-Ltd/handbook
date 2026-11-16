// My profile: names and photo, password change. The role title and
// departments are shown read-only; admins and team leaders manage them.

import { api } from "../api.js";
import { alertBox, busy, field, h, input, setTitle, toast } from "../lib/dom.js";
import { fullName } from "../lib/format.js";
import { photoEditor } from "../lib/photo-editor.js";
import { session } from "../state.js";
import { passwordForm } from "./password.js";

export function render(main, { refreshBranding }) {
  const me = session.me;
  setTitle("My profile");
  const departments = me.departments.filter((d) => !d.is_system);

  const { photo, controls: photoControls } = photoEditor({ ...me.user }, {
    own: true,
    onSaved: (user) => {
      Object.assign(session.me.user, { avatar_url: user.avatar_url });
      refreshBranding();
    },
  });

  const error = alertBox();
  const firstName = input({ name: "first_name", value: me.user.first_name, autocomplete: "given-name", required: true });
  const lastName = input({ name: "last_name", value: me.user.last_name, autocomplete: "family-name", required: true });
  const save = h("button", { class: "button button--primary", type: "submit" }, "Save");
  const detailsForm = h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        error.show("");
        await busy(save, async () => {
          try {
            const { user } = await api("PATCH", `/users/${me.user.id}`, { first_name: firstName.value, last_name: lastName.value });
            Object.assign(session.me.user, { first_name: user.first_name, last_name: user.last_name });
            refreshBranding();
            heading.textContent = fullName(user);
            toast("Saved.");
          } catch (e) {
            error.show(e.message);
          }
        });
      },
    },
    error.el,
    h("div", { class: "form-row" }, field({ label: "First name", input: firstName }), field({ label: "Last name", input: lastName })),
    h("div", { class: "form-actions" }, save),
  );
  const heading = h("h2", { class: "profile-head__name" }, fullName(me.user));

  main.append(
    h(
      "div",
      { class: "page page--narrow" },
      h("h1", { class: "page-title" }, "My profile"),
      h(
        "section",
        { class: "card", "aria-label": "Profile" },
        h(
          "div",
          { class: "profile-head" },
          photo,
          h(
            "div",
            { style: "flex:1;min-width:200px" },
            heading,
            h("div", { class: "muted small" }, me.user.email),
            me.user.role_title ? h("div", { class: "small" }, me.user.role_title) : null,
            h(
              "div",
              { class: "tags", style: "margin-top:8px" },
              me.user.is_admin ? h("span", { class: "badge badge--accent" }, "Admin") : null,
              departments.map((d) => h("span", { class: d.is_leader ? "badge badge--accent" : "badge" }, d.is_leader ? `${d.name} · Leader` : d.name)),
            ),
          ),
        ),
        photoControls,
        h("p", { class: "muted small" }, "Your role title and departments are managed by your team leader or an admin."),
      ),
      h("section", { class: "card", "aria-labelledby": "details-title" }, h("h2", { class: "section-title", id: "details-title" }, "Your name"), detailsForm),
      h(
        "section",
        { class: "card", "aria-labelledby": "password-title" },
        h("h2", { class: "section-title", id: "password-title" }, "Change password"),
        h("p", { class: "muted small" }, "You will stay logged in here. Your other devices will be logged out."),
        passwordForm({ onDone: () => toast("Your new password is saved.") }),
      ),
    ),
  );
}

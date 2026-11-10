// My profile. Milestone 1: read-only details and password change.
// Editing names and the photo arrives in milestone 2.

import { avatar, h, setTitle, toast } from "../lib/dom.js";
import { fullName } from "../lib/format.js";
import { session } from "../state.js";
import { passwordForm } from "./password.js";

export function render(main) {
  const me = session.me;
  setTitle("My profile");
  const departments = me.departments.filter((d) => !d.is_system);

  main.append(
    h(
      "div",
      { class: "page page--narrow" },
      h("h1", { class: "page-title" }, "My profile"),
      h(
        "section",
        { class: "card" },
        h(
          "div",
          { style: "display:flex;gap:16px;align-items:center;flex-wrap:wrap" },
          avatar(me.user, "lg"),
          h(
            "div",
            {},
            h("h2", { class: "section-title", style: "margin:0" }, fullName(me.user)),
            h("div", { class: "muted small" }, me.user.email),
            me.user.role_title ? h("div", { class: "small" }, me.user.role_title) : null,
            h(
              "div",
              { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:8px" },
              me.user.is_admin ? h("span", { class: "badge badge--accent" }, "Admin") : null,
              departments.map((d) => h("span", { class: "badge" }, d.is_leader ? `${d.name} (Leader)` : d.name)),
            ),
          ),
        ),
      ),
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

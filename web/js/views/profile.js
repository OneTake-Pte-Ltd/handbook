// My profile: names and photo, password change. The role title and
// departments are shown read-only; admins and team leaders manage them.

import { api, uploadFile } from "../api.js";
import { alertBox, avatar, busy, field, h, input, setTitle, toast } from "../lib/dom.js";
import { fullName } from "../lib/format.js";
import { squareImage } from "../lib/image.js";
import { session } from "../state.js";
import { passwordForm } from "./password.js";

export function render(main, { refreshBranding }) {
  const me = session.me;
  setTitle("My profile");
  const departments = me.departments.filter((d) => !d.is_system);

  const photo = h("div", {}, avatar(me.user, "lg"));
  const photoError = alertBox();
  const fileInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", class: "visually-hidden", id: "photo-file" });
  const changePhoto = h("label", { class: "button", for: "photo-file", tabindex: "0", role: "button" }, "Change photo");
  const removePhoto = h("button", { class: "button button--ghost", type: "button", hidden: !me.user.avatar_url }, "Remove photo");

  async function savePhoto(url) {
    const { user } = await api("PATCH", `/users/${me.user.id}`, { avatar_url: url });
    Object.assign(session.me.user, { avatar_url: user.avatar_url });
    photo.replaceChildren(avatar(session.me.user, "lg"));
    removePhoto.hidden = !user.avatar_url;
    refreshBranding();
  }

  changePhoto.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    photoError.show("");
    changePhoto.setAttribute("aria-disabled", "true");
    changePhoto.textContent = "Uploading";
    try {
      const blob = await squareImage(file, 256);
      const uploaded = await uploadFile(blob, "avatar.jpg", "image");
      await savePhoto(uploaded.url);
      toast("Your photo is saved.");
    } catch (e) {
      photoError.show(e.message);
    } finally {
      changePhoto.removeAttribute("aria-disabled");
      changePhoto.textContent = "Change photo";
    }
  });
  removePhoto.addEventListener("click", async () => {
    try {
      await savePhoto("");
      toast("Your photo is removed.");
    } catch (e) {
      photoError.show(e.message);
    }
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
        h("div", { class: "form-actions", style: "margin-top:16px" }, fileInput, changePhoto, removePhoto),
        photoError.el,
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

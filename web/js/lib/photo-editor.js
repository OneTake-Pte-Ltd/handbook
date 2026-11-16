// "Change photo" / "Remove photo" for a member, used on My profile and on a
// member's page (admins and the member's team leaders).
// onSaved(user) runs after the photo is saved, with the updated member.

import { api, uploadFile } from "../api.js";
import { alertBox, avatar, h, toast } from "./dom.js";
import { squareImage } from "./image.js";

let photoInputs = 0;

export function photoEditor(user, { own = false, onSaved = () => {} } = {}) {
  const id = `photo-file-${++photoInputs}`;
  const photo = h("div", {}, avatar(user, "lg"));
  const error = alertBox();
  const fileInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", class: "visually-hidden", id });
  const changePhoto = h("label", { class: "button", for: id, tabindex: "0", role: "button" }, "Change photo");
  const removePhoto = h("button", { class: "button button--ghost", type: "button", hidden: !user.avatar_url }, "Remove photo");

  async function save(url) {
    const result = await api("PATCH", `/users/${user.id}`, { avatar_url: url });
    user.avatar_url = result.user.avatar_url;
    photo.replaceChildren(avatar(user, "lg"));
    removePhoto.hidden = !user.avatar_url;
    onSaved(result.user);
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
    error.show("");
    changePhoto.setAttribute("aria-disabled", "true");
    changePhoto.textContent = "Uploading";
    try {
      const blob = await squareImage(file, 256);
      const uploaded = await uploadFile(blob, "avatar.jpg", "image");
      await save(uploaded.url);
      toast(own ? "Your photo is saved." : "The photo is saved.");
    } catch (e) {
      error.show(e.message);
    } finally {
      changePhoto.removeAttribute("aria-disabled");
      changePhoto.textContent = "Change photo";
    }
  });
  removePhoto.addEventListener("click", async () => {
    try {
      await save("");
      toast(own ? "Your photo is removed." : "The photo is removed.");
    } catch (e) {
      error.show(e.message);
    }
  });

  return {
    photo,
    controls: [h("div", { class: "form-actions", style: "margin-top:16px" }, fileInput, changePhoto, removePhoto), error.el],
  };
}

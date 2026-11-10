// Settings (admins only). Milestone 1: workspace name, logo and banner image.
// The Anthropic key, models, search index and CSV import arrive later.

import { api } from "../api.js";
import { alertBox, busy, field, h, input, loading, setTitle, toast } from "../lib/dom.js";
import { session } from "../state.js";

export async function render(main, { refreshBranding }) {
  setTitle("Settings");
  const page = h("div", { class: "page page--narrow" }, h("h1", { class: "page-title" }, "Settings"), loading());
  main.append(page);
  const settings = await api("GET", "/settings");
  page.lastChild.remove();

  const error = alertBox();
  const name = input({ name: "workspace_name", value: settings.workspace_name, required: true, maxlength: 80 });
  const logo = input({ type: "url", name: "logo_url", value: settings.logo_url, placeholder: "https://", inputmode: "url" });
  const banner = input({ type: "url", name: "banner_url", value: settings.banner_url, placeholder: "https://", inputmode: "url" });
  const submit = h("button", { class: "button button--primary", type: "submit" }, "Save");

  const form = h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        error.show("");
        await busy(submit, async () => {
          try {
            const saved = await api("PATCH", "/settings", {
              workspace_name: name.value,
              logo_url: logo.value,
              banner_url: banner.value,
            });
            Object.assign(session.me.workspace, { name: saved.workspace_name, logo_url: saved.logo_url, banner_url: saved.banner_url });
            refreshBranding();
            toast("Settings saved.");
          } catch (e) {
            error.show(e.message);
          }
        });
      },
    },
    error.el,
    field({ label: "Workspace name", hint: "Shown on the login screen and in the top bar.", input: name }),
    field({ label: "Logo URL", hint: "A square image works best. Leave empty to use the default logo.", input: logo }),
    field({ label: "Home page banner image URL", hint: "Optional. A wide photo shown behind the greeting on the home page.", input: banner }),
    h("div", { class: "form-actions" }, submit),
  );

  page.append(
    h("section", { class: "card", "aria-labelledby": "ws-title" }, h("h2", { class: "section-title", id: "ws-title" }, "Workspace"), form),
    h(
      "section",
      { class: "card", "aria-labelledby": "import-title" },
      h("h2", { class: "section-title", id: "import-title" }, "Import from CSV"),
      h("p", { class: "small" }, "Create spaces, categories, documents and department access from CSV files, for example when moving from another intranet."),
      h("a", { class: "button", href: "#/settings/import" }, "Open the import"),
    ),
  );
}

// Login screen: workspace URL, then email and password, or first-run setup.

import {
  currentWorkspace,
  fetchInfo,
  listWorkspaces,
  normalizeWorkspaceUrl,
  publicPost,
  rememberWorkspace,
  setCurrentWorkspace,
  setToken,
} from "../api.js";
import { alertBox, busy, clear, field, h, input, loading } from "../lib/dom.js";
import { DEFAULT_LOGO, workspaceLogo } from "../state.js";

const MIN_PASSWORD = 10;

// options: { invitedUrl, chooseWorkspace, message, onLoggedIn }
export function renderLogin(root, options) {
  const card = h("div", { class: "card login__card" });
  clear(root, h("main", { class: "login" }, card));

  const startUrl = options.invitedUrl || (options.chooseWorkspace ? null : currentWorkspace() || listWorkspaces()[0]?.url);
  if (startUrl) checkWorkspace(startUrl, options.message);
  else showChooser(options.message);

  function brand(title, logo = DEFAULT_LOGO, subtitle) {
    return h(
      "div",
      { class: "login__brand" },
      h("img", { class: "login__logo", src: logo, alt: "" }),
      h("h1", { class: "login__title" }, title),
      subtitle ? h("p", { class: "muted small", style: "margin:0" }, subtitle) : null,
    );
  }

  // Step 1: choose or type the workspace URL.
  function showChooser(message, prefill = "", isError = false) {
    const error = alertBox();
    const urlInput = input({ type: "url", name: "workspace", autocomplete: "url", inputmode: "url", placeholder: "https://handbook.yourcompany.com", value: prefill, required: true });
    const submit = h("button", { class: "button button--primary button--block", type: "submit" }, "Continue");
    const saved = listWorkspaces();

    const form = h(
      "form",
      {
        class: "form",
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          error.show("");
          let url;
          try {
            url = normalizeWorkspaceUrl(urlInput.value);
          } catch (e) {
            error.show(e.message);
            urlInput.setAttribute("aria-invalid", "true");
            urlInput.focus();
            return;
          }
          await busy(submit, () => checkWorkspace(url));
        },
      },
      error.el,
      field({ label: "Workspace URL", hint: "Your admin gives you this address.", input: urlInput }),
      submit,
    );

    clear(card,
      brand("Log in to your handbook"),
      message ? h("div", { class: `alert alert--${isError ? "error" : "info"}`, role: isError ? "alert" : "status", style: "margin-bottom:16px" }, message) : null,
      saved.length
        ? h(
            "div",
            { class: "form", style: "margin-bottom:24px" },
            h("h2", { class: "field__label", style: "margin:0" }, "Recent workspaces"),
            h(
              "ul",
              { class: "workspace-list" },
              saved.map((w) =>
                h(
                  "li",
                  {},
                  h(
                    "button",
                    { class: "workspace-choice", type: "button", onclick: () => checkWorkspace(w.url) },
                    h("img", { src: w.logo_url || DEFAULT_LOGO, alt: "" }),
                    h("span", { class: "workspace-choice__text" }, h("strong", {}, w.name), h("span", { class: "workspace-choice__url" }, w.url)),
                  ),
                ),
              ),
            ),
            h("div", { class: "divider-label" }, "or"),
          )
        : null,
      form,
    );
    if (!saved.length) urlInput.focus();
  }

  // Calls GET /api/info to check the workspace, then shows login or setup.
  async function checkWorkspace(url, message) {
    clear(card, loading("Connecting to the workspace"));
    let info;
    try {
      info = await fetchInfo(url);
    } catch (error) {
      // Status 0: no answer the browser could read (wrong address, server down,
      // or an error page without CORS headers). Otherwise the server's message.
      showChooser(
        error.status
          ? error.message
          : "We couldn't reach this workspace. Check the address. If it is correct, the workspace's edge script may not be running yet.",
        url,
        true,
      );
      return;
    }
    rememberWorkspace(url, info);
    if (info.needs_setup) showSetup(url, info);
    else showLoginForm(url, info, message);
  }

  function workspaceBar(url) {
    return h(
      "div",
      { class: "login__workspace" },
      h("span", { class: "login__workspace-url" }, url),
      h("button", { class: "link-button small", type: "button", onclick: () => showChooser("", url) }, "Change"),
    );
  }

  function finish(url, info, token) {
    setCurrentWorkspace(url);
    setToken(url, token);
    rememberWorkspace(url, info);
    options.onLoggedIn();
  }

  // Step 2: email and password.
  function showLoginForm(url, info, message) {
    const error = alertBox();
    const email = input({ type: "email", name: "email", autocomplete: "username", required: true });
    const password = input({ type: "password", name: "password", autocomplete: "current-password", required: true });
    const submit = h("button", { class: "button button--primary button--block", type: "submit" }, "Log in");
    const form = h(
      "form",
      {
        class: "form",
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          error.show("");
          if (!email.value.trim() || !password.value) {
            error.show("Please enter your email and password.");
            return;
          }
          await busy(submit, async () => {
            try {
              const result = await publicPost(url, "/login", { email: email.value, password: password.value });
              finish(url, info, result.token);
            } catch (e) {
              error.show(e.message);
              password.value = "";
              password.focus();
            }
          });
        },
      },
      error.el,
      field({ label: "Email", input: email }),
      field({ label: "Password", input: password }),
      submit,
    );
    clear(card,
      brand(info.name, workspaceLogo(info)),
      message ? h("div", { class: "alert alert--info", role: "status", style: "margin-bottom:16px" }, message) : null,
      workspaceBar(url),
      form,
      h("p", { class: "muted small", style: "margin:16px 0 0;text-align:center" }, "Forgot your password? Ask your team leader or an admin to reset it."),
    );
    email.focus();
  }

  // First run: create the first admin with the setup code.
  function showSetup(url, info) {
    const error = alertBox();
    const code = input({ name: "setup_code", autocomplete: "off", required: true });
    const workspaceName = input({ name: "workspace_name", placeholder: "Your company name", autocomplete: "organization" });
    const firstName = input({ name: "first_name", autocomplete: "given-name", required: true });
    const lastName = input({ name: "last_name", autocomplete: "family-name", required: true });
    const email = input({ type: "email", name: "email", autocomplete: "username", required: true });
    const password = input({ type: "password", name: "password", autocomplete: "new-password", required: true, minlength: MIN_PASSWORD });
    const confirm = input({ type: "password", name: "confirm", autocomplete: "new-password", required: true });
    const submit = h("button", { class: "button button--primary button--block", type: "submit" }, "Create the first admin");

    const form = h(
      "form",
      {
        class: "form",
        novalidate: true,
        onsubmit: async (event) => {
          event.preventDefault();
          error.show("");
          if (!code.value.trim() || !firstName.value.trim() || !lastName.value.trim() || !email.value.trim()) {
            error.show("Please fill in every field.");
            return;
          }
          if (password.value.length < MIN_PASSWORD) {
            error.show(`Passwords need at least ${MIN_PASSWORD} characters.`);
            password.focus();
            return;
          }
          if (password.value !== confirm.value) {
            error.show("The two passwords don't match.");
            confirm.focus();
            return;
          }
          await busy(submit, async () => {
            try {
              const result = await publicPost(url, "/setup", {
                setup_code: code.value.trim(),
                workspace_name: workspaceName.value.trim(),
                first_name: firstName.value,
                last_name: lastName.value,
                email: email.value,
                password: password.value,
              });
              const fresh = await fetchInfo(url).catch(() => info);
              finish(url, fresh, result.token);
            } catch (e) {
              error.show(e.message);
            }
          });
        },
      },
      error.el,
      field({ label: "Setup code", hint: "The SETUP_CODE secret set on the edge script.", input: code }),
      field({ label: "Workspace name", hint: "Shown on the login screen and in the top bar. You can change it later.", input: workspaceName }),
      h("div", { class: "form-row" }, field({ label: "First name", input: firstName }), field({ label: "Last name", input: lastName })),
      field({ label: "Email", input: email }),
      field({ label: "Password", hint: `At least ${MIN_PASSWORD} characters.`, input: password }),
      field({ label: "Confirm password", input: confirm }),
      submit,
    );
    clear(card,
      brand("Create the first admin", workspaceLogo(info), "This workspace is new. The first account you create here is an admin."),
      workspaceBar(url),
      form,
    );
    code.focus();
  }
}

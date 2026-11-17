// Settings (admins only): workspace name, logo and banner image; the AI
// endpoint, models and brand rules; CSV import; search index.

import { api } from "../api.js";
import { alertBox, busy, clear, confirmDialog, field, h, input, loading, setTitle, toast } from "../lib/dom.js";
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

  const rebuild = h("button", { class: "button", type: "button" }, "Rebuild search index");
  const aiSection = aiSettings(settings);
  rebuild.addEventListener("click", () =>
    busy(rebuild, async () => {
      try {
        const result = await api("POST", "/search/rebuild");
        toast(`Search index rebuilt: ${result.documents} documents, ${result.steps} steps.`);
      } catch (e) {
        toast(e.message, { kind: "error" });
      }
    }),
  );
  page.append(
    h("section", { class: "card", "aria-labelledby": "ws-title" }, h("h2", { class: "section-title", id: "ws-title" }, "Workspace"), form),
    aiSection,
    h(
      "section",
      { class: "card", "aria-labelledby": "import-title" },
      h("h2", { class: "section-title", id: "import-title" }, "Import from CSV"),
      h("p", { class: "small" }, "Create spaces, categories, documents and department access from CSV files, for example when moving from another intranet."),
      h("a", { class: "button", href: "#/settings/import" }, "Open the import"),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "search-title" },
      h("h2", { class: "section-title", id: "search-title" }, "Search index"),
      h("p", { class: "small" }, "The search index updates on every publication. Rebuild it if search results look wrong or incomplete."),
      rebuild,
    ),
  );
}

const PROVIDERS = {
  anthropic: { label: "Anthropic-compatible (Messages API)", placeholder: "https://api.anthropic.com" },
  openai: { label: "OpenAI-compatible (Chat Completions API)", placeholder: "https://api.openai.com/v1" },
};
const MODEL_FIELDS = [
  ["writer_model", "Writer model", "Writes documents from rough drafts. A capable model works best."],
  ["assistant_model", "Assistant model", "Answers questions from the handbook."],
  ["assistant_query_model", "Search query model", "Turns each question into search keywords. A fast, inexpensive model is enough."],
];

// One AI endpoint for the writer and the assistant: its type, address, key,
// the three models (picked from the list the endpoint returns) and the brand
// rules every generated text follows.
function aiSettings(settings) {
  const error = alertBox();
  const provider = h(
    "select",
    { class: "select", name: "ai_provider" },
    Object.entries(PROVIDERS).map(([value, p]) => h("option", { value, selected: settings.ai_provider === value }, p.label)),
  );
  const baseUrl = input({ type: "url", name: "ai_base_url", value: settings.ai_base_url, inputmode: "url", placeholder: PROVIDERS[settings.ai_provider]?.placeholder });
  provider.addEventListener("change", () => (baseUrl.placeholder = PROVIDERS[provider.value].placeholder));
  const keyHint = () => (settings.ai_key_set ? `A key is saved, ending in …${settings.ai_key_hint}. Leave empty to keep it.` : "Required for the AI writer and the assistant. It is never shown again after saving.");
  const keyHintEl = h("span", {}, keyHint());
  const apiKey = input({ type: "password", name: "ai_api_key", autocomplete: "off", placeholder: settings.ai_key_set ? `…${settings.ai_key_hint}` : "" });
  const list = h("datalist", { id: "ai-models" });
  const models = Object.fromEntries(MODEL_FIELDS.map(([key]) => [key, input({ name: key, value: settings[key], list: "ai-models", autocomplete: "off", spellcheck: "false" })]));
  const modelStatus = h("p", { class: "small muted", role: "status", style: "margin:0" });
  const loadModels = h("button", { class: "button", type: "button" }, "Load the models");
  loadModels.addEventListener("click", () =>
    busy(loadModels, async () => {
      error.show("");
      try {
        const result = await api("POST", "/ai/models", { ai_provider: provider.value, ai_base_url: baseUrl.value.trim(), ai_api_key: apiKey.value.trim() });
        clear(list, result.models.map((m) => h("option", { value: m.id }, m.name !== m.id ? m.name : null)));
        modelStatus.textContent = result.models.length ? `${result.models.length} models available. Click a model field to choose one, or type a name.` : "This endpoint returned no models. Type the model names yourself.";
      } catch (e) {
        error.show(e.message);
      }
    }),
  );
  const brandRules = h("textarea", { class: "input", name: "brand_rules", rows: 8, maxlength: 5000 });
  brandRules.value = settings.brand_rules;
  const save = h("button", { class: "button button--primary", type: "submit" }, "Save");
  const removeKey = h("button", { class: "button button--ghost", type: "button", hidden: !settings.ai_key_set }, "Remove the key");

  async function store(body, message) {
    const saved = await api("PATCH", "/settings", body);
    Object.assign(settings, saved);
    apiKey.value = "";
    apiKey.placeholder = saved.ai_key_set ? `…${saved.ai_key_hint}` : "";
    keyHintEl.textContent = keyHint();
    removeKey.hidden = !saved.ai_key_set;
    session.me.workspace.ai_enabled = Boolean(saved.ai_key_set && saved.writer_model && saved.assistant_model && saved.assistant_query_model);
    window.dispatchEvent(new CustomEvent("handbook:ai-changed"));
    toast(message);
  }
  removeKey.addEventListener("click", async () => {
    if (!(await confirmDialog({ title: "Remove the API key", text: "The AI writer and the assistant will be hidden until a new key is saved.", confirmLabel: "Remove", danger: true }))) return;
    try {
      await store({ ai_api_key: "" }, "Key removed. AI features are off.");
    } catch (e) {
      error.show(e.message);
    }
  });

  const form = h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        error.show("");
        busy(save, async () => {
          try {
            const body = { ai_provider: provider.value, ai_base_url: baseUrl.value.trim(), brand_rules: brandRules.value };
            for (const [key] of MODEL_FIELDS) body[key] = models[key].value.trim();
            if (apiKey.value.trim()) body.ai_api_key = apiKey.value.trim();
            await store(body, "AI settings saved.");
          } catch (e) {
            error.show(e.message);
          }
        });
      },
    },
    error.el,
    field({ label: "Type of endpoint", input: provider }),
    field({ label: "Endpoint URL", hint: "Leave empty for the official API. For another service, paste the base address it documents.", input: baseUrl }),
    field({ label: "API key", hint: keyHintEl, input: apiKey }),
    h("div", { class: "form-actions", style: "justify-content:flex-start" }, loadModels, removeKey),
    modelStatus,
    list,
    MODEL_FIELDS.map(([key, label, hint]) => field({ label, hint, input: models[key] })),
    field({ label: "Brand rules", hint: "Every text the writer and the assistant produce follows these rules. One rule per line.", input: brandRules }),
    h("div", { class: "form-actions" }, save),
  );
  return h(
    "section",
    { class: "card", "aria-labelledby": "ai-title" },
    h("h2", { class: "section-title", id: "ai-title" }, "AI writer and assistant"),
    h("p", { class: "small" }, "One endpoint serves the writer and the assistant. There is no spending limit in the handbook: set one with your AI provider if you need it."),
    form,
  );
}

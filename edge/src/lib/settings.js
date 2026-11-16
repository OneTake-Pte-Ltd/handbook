// Workspace settings, stored as key/value rows in the settings table.

import { badRequest, optionalString } from "./http.js";

// Brand rules every AI text follows; admins edit them in Settings.
export const DEFAULT_BRAND_RULES = `- Never use em dashes; use a semicolon instead.
- The company is "OneTake AI". The product, and the AI agent users talk to, is "OneTake". Never write "the AI" to refer to it.
- OneTake is "an AI agent", never "a tool", "a platform" or "a software".
- No filler such as "To be honest" or "The truth is"; state facts directly.
- Say "your domain or industry", not "your niche".`;

export const SETTING_DEFAULTS = {
  workspace_name: "Handbook",
  logo_url: "",
  banner_url: "",
  // One AI endpoint for the writer, the assistant and its search queries.
  ai_provider: "anthropic", // "anthropic" or "openai" (any compatible endpoint)
  ai_base_url: "", // empty: https://api.anthropic.com or https://api.openai.com/v1
  ai_api_key: "",
  writer_model: "claude-sonnet-5-5",
  assistant_model: "claude-sonnet-5-5",
  assistant_query_model: "claude-haiku-5-5",
  brand_rules: DEFAULT_BRAND_RULES,
};

export function settingsFromRows(rows) {
  const settings = { ...SETTING_DEFAULTS };
  for (const row of rows) if (row.key in SETTING_DEFAULTS) settings[row.key] = row.value;
  return settings;
}

export async function getSettings(db) {
  return settingsFromRows(await db.all("SELECT key, value FROM settings"));
}

// What admins see in Settings: everything except the API key itself.
export function settingsForAdmin(settings) {
  const { ai_api_key, ...rest } = settings;
  return {
    ...rest,
    ai_key_set: Boolean(ai_api_key),
    ai_key_hint: ai_api_key ? ai_api_key.slice(-4) : "",
  };
}

// The AI features show once a key and the three models are set.
export function aiEnabled(settings) {
  return Boolean(settings.ai_api_key && settings.writer_model && settings.assistant_model && settings.assistant_query_model);
}

export async function setSettings(db, values) {
  const statements = Object.entries(values).map(([key, value]) => [
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  ]);
  if (statements.length) await db.batch(statements);
}

function checkUrl(value, label) {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw badRequest(`${label} must be a full web address starting with https://`);
  }
  if (url.protocol !== "https:") throw badRequest(`${label} must start with https://`);
  return url.toString();
}

// Model names from Anthropic, OpenAI and compatible services (for example
// "claude-sonnet-5-5", "gpt-5.1", "meta-llama/Llama-3.3-70B-Instruct:free").
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,119}$/;

// Validates a PATCH /settings body and returns only the keys to change.
export function parseSettingsPatch(body) {
  const changes = {};
  if ("workspace_name" in body) {
    const name = optionalString(body, "workspace_name", "Workspace name", { max: 80 });
    if (!name) throw badRequest("Workspace name is required.");
    changes.workspace_name = name;
  }
  if ("logo_url" in body) changes.logo_url = checkUrl(optionalString(body, "logo_url", "Logo URL", { max: 1000 }), "Logo URL");
  if ("banner_url" in body) changes.banner_url = checkUrl(optionalString(body, "banner_url", "Banner image URL", { max: 1000 }), "Banner image URL");
  if ("ai_provider" in body) {
    if (!["anthropic", "openai"].includes(body.ai_provider)) throw badRequest("Choose an Anthropic-compatible or an OpenAI-compatible endpoint.");
    changes.ai_provider = body.ai_provider;
  }
  if ("ai_base_url" in body) {
    const value = optionalString(body, "ai_base_url", "Endpoint URL", { max: 500 });
    // http://localhost is accepted for local testing with the dev server.
    changes.ai_base_url = (/^http:\/\/localhost[:/]/.test(value) ? value : checkUrl(value, "Endpoint URL")).replace(/\/+$/, "");
  }
  if ("ai_api_key" in body) {
    const key = optionalString(body, "ai_api_key", "API key", { max: 500 });
    if (/\s/.test(key)) throw badRequest("The API key can't contain spaces.");
    changes.ai_api_key = key;
  }
  for (const key of ["writer_model", "assistant_model", "assistant_query_model"]) {
    if (key in body) {
      const value = optionalString(body, key, "Model name", { max: 120 });
      if (value && !MODEL_PATTERN.test(value)) throw badRequest(`"${value}" doesn't look like a model name.`);
      changes[key] = value;
    }
  }
  if ("brand_rules" in body) changes.brand_rules = optionalString(body, "brand_rules", "Brand rules", { max: 5000 });
  return changes;
}

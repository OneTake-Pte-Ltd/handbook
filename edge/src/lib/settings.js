// Workspace settings, stored as key/value rows in the settings table.

import { badRequest, optionalString } from "./http.js";

export const SETTING_DEFAULTS = {
  workspace_name: "Handbook",
  logo_url: "",
  banner_url: "",
  anthropic_api_key: "",
  writer_model: "claude-sonnet-5-5",
  assistant_model: "claude-sonnet-5-5",
  assistant_query_model: "claude-haiku-5-5",
};

export async function getSettings(db) {
  const rows = await db.all("SELECT key, value FROM settings");
  const settings = { ...SETTING_DEFAULTS };
  for (const row of rows) if (row.key in SETTING_DEFAULTS) settings[row.key] = row.value;
  return settings;
}

// What admins see in Settings: everything except the API key itself.
export function settingsForAdmin(settings) {
  const { anthropic_api_key, ...rest } = settings;
  return {
    ...rest,
    anthropic_key_set: Boolean(anthropic_api_key),
    anthropic_key_hint: anthropic_api_key ? anthropic_api_key.slice(-4) : "",
  };
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

const MODEL_PATTERN = /^[a-z0-9][a-z0-9.\-]{1,80}$/;

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
  if ("anthropic_api_key" in body) {
    changes.anthropic_api_key = optionalString(body, "anthropic_api_key", "Anthropic API key", { max: 300 });
  }
  for (const key of ["writer_model", "assistant_model", "assistant_query_model"]) {
    if (key in body) {
      const value = optionalString(body, key, "Model name", { max: 80 });
      if (!MODEL_PATTERN.test(value)) throw badRequest("Model names look like claude-sonnet-5-5.");
      changes[key] = value;
    }
  }
  return changes;
}

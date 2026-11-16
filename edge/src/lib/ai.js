// AI features: the document writer and the assistant.
//
// One endpoint, set by an admin in Settings, serves both: either
// Anthropic-compatible (POST {base}/v1/messages) or OpenAI-compatible
// (POST {base}/chat/completions). Calls use plain fetch (no SDK), stream the
// model's answer, and pass progress to the browser as Server-Sent Events.
//
// Bunny closes a request that sends nothing for 60 seconds, so streamed
// responses are returned at once with a first event, then filled in; a
// comment line every 15 seconds keeps the connection open, and waitUntil keeps
// the script alive until the stream ends.
//
// Prompts are Markdown files in web/prompts/, published with the frontend.
// The edge script fetches them from the website that made the request (it
// must be listed in ALLOWED_ORIGINS), so they can be improved without
// redeploying the edge script.

import { HttpError, badRequest } from "./http.js";

export const ANTHROPIC_VERSION = "2026-10-21";
const HEARTBEAT_MS = 15_000;
const PROMPT_CACHE_MS = 5 * 60_000;

// Endpoint settings, or an error that says what is missing.
export function aiEndpoint(settings, { requireModels = true } = {}) {
  const provider = settings.ai_provider === "openai" ? "openai" : "anthropic";
  if (!settings.ai_api_key) throw new HttpError(400, "AI features aren't set up yet. An admin can add an API key in Settings.", { code: "ai_not_configured" });
  if (requireModels && !(settings.writer_model && settings.assistant_model && settings.assistant_query_model)) {
    throw new HttpError(400, "AI features aren't set up yet. An admin can choose the models in Settings.", { code: "ai_not_configured" });
  }
  return { provider, baseUrl: endpointBase(provider, settings.ai_base_url), apiKey: settings.ai_api_key };
}

// Anthropic: the base has no /v1 (it is added). OpenAI-compatible: the base
// includes the version path, as these services document it (…/v1).
export function endpointBase(provider, url) {
  const clean = String(url || "").replace(/\/+$/, "");
  if (provider === "anthropic") return (clean || "https://api.anthropic.com").replace(/\/v1$/, "");
  return clean || "https://api.openai.com/v1";
}

function endpointHeaders(endpoint) {
  return endpoint.provider === "anthropic"
    ? { "x-api-key": endpoint.apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" }
    : { authorization: `Bearer ${endpoint.apiKey}`, "content-type": "application/json" };
}

async function endpointError(response) {
  let detail = "";
  try {
    const data = await response.json();
    detail = (data && data.error && (data.error.message || data.error)) || data.message || "";
  } catch {
    detail = "";
  }
  if (typeof detail !== "string") detail = JSON.stringify(detail);
  const hint = response.status === 401 || response.status === 403 ? " Check the API key in Settings." : response.status === 404 ? " Check the endpoint URL and the model names in Settings." : "";
  const text = detail ? `: ${detail.slice(0, 300).replace(/[.\s]*$/, "")}.` : ".";
  return new HttpError(502, `The AI endpoint returned an error (${response.status})${text}${hint}`);
}

// GET the list of models the key can use: [{ id, name }], sorted by id.
export async function listModels(fetchImpl, endpoint) {
  const url = endpoint.provider === "anthropic" ? `${endpoint.baseUrl}/v1/models?limit=1000` : `${endpoint.baseUrl}/models`;
  let response;
  try {
    response = await fetchImpl(url, { headers: endpointHeaders(endpoint) });
  } catch {
    throw new HttpError(502, "The AI endpoint can't be reached. Check the endpoint URL.");
  }
  if (!response.ok) throw await endpointError(response);
  const data = await response.json().catch(() => null);
  const list = Array.isArray(data && data.data) ? data.data : Array.isArray(data) ? data : [];
  return list
    .filter((m) => m && typeof m.id === "string")
    .map((m) => ({ id: m.id, name: m.display_name || m.name || m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Reads a text/event-stream body and calls onEvent(eventName, dataText).
async function readSse(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let cut;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
      let event = "message";
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) onEvent(event, data.join("\n"));
    }
    if (done) break;
  }
}

// Calls a model with streaming. onText(delta) receives the text as it comes.
// Returns { text, stop } where stop is "end", "max_tokens" or "refusal".
// `schema` asks Anthropic-compatible endpoints for JSON matching it
// (structured outputs); OpenAI-compatible ones rely on the prompt.
export async function callModel(fetchImpl, endpoint, { model, system, messages, maxTokens = 16000, schema = null, signal, onText = () => {} }) {
  const anthropic = endpoint.provider === "anthropic";
  const body = anthropic
    ? { model, max_tokens: maxTokens, system, messages, stream: true, ...(schema ? { output_config: { format: { type: "json_schema", schema } } } : {}) }
    : { model, stream: true, messages: [{ role: "system", content: system }, ...messages] };
  let response;
  try {
    response = await fetchImpl(anthropic ? `${endpoint.baseUrl}/v1/messages` : `${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: endpointHeaders(endpoint),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal && signal.aborted) throw error;
    throw new HttpError(502, "The AI endpoint can't be reached. Check the endpoint URL in Settings.");
  }
  if (!response.ok) throw await endpointError(response);
  let text = "";
  let stop = "end";
  let failure = null;
  await readSse(response.body, (event, data) => {
    if (data === "[DONE]") return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (anthropic) {
      if (message.type === "content_block_delta" && message.delta && message.delta.type === "text_delta") {
        text += message.delta.text;
        onText(message.delta.text);
      } else if (message.type === "message_delta" && message.delta && message.delta.stop_reason) {
        if (message.delta.stop_reason === "max_tokens") stop = "max_tokens";
        if (message.delta.stop_reason === "refusal") stop = "refusal";
      } else if (message.type === "error") {
        failure = (message.error && message.error.message) || "unknown error";
      }
    } else {
      const choice = message.choices && message.choices[0];
      if (message.error) failure = message.error.message || "unknown error";
      if (!choice) return;
      const delta = choice.delta && choice.delta.content;
      if (typeof delta === "string" && delta) {
        text += delta;
        onText(delta);
      }
      if (choice.finish_reason === "length") stop = "max_tokens";
      if (choice.finish_reason === "content_filter") stop = "refusal";
    }
  });
  if (failure) throw new HttpError(502, `The AI endpoint stopped with an error: ${String(failure).slice(0, 300)}`);
  if (stop === "refusal") throw new HttpError(422, "The model declined this request. Try rephrasing it.");
  return { text, stop };
}

// JSON from a model answer, tolerating code fences or text around it.
export function parseModelJson(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
  }
  throw new HttpError(502, "The model's answer wasn't in the expected format. Please try again.");
}

// A Server-Sent Events response. work(send, signal) runs after the response
// is returned; send(event, data) writes one event. Errors become an "error"
// event with a readable message.
export function eventStream(work) {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let closed = false;
  let finished;
  const done = new Promise((resolve) => (finished = resolve));
  let heartbeat = null;
  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // The browser receives nothing, not even the headers, before the first byte.
      send("ready", {});
      heartbeat = setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS);
      Promise.resolve()
        .then(() => work(send, abort.signal))
        .catch((error) => {
          if (abort.signal.aborted) return;
          if (error instanceof HttpError) send("error", { error: error.message, ...error.extra });
          else {
            console.error(error && error.stack ? error.stack : error);
            send("error", { error: "Something went wrong on the server. Please try again." });
          }
        })
        .finally(() => {
          clearInterval(heartbeat);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
          finished();
        });
    },
    cancel() {
      // The browser went away: stop the model call too.
      closed = true;
      clearInterval(heartbeat);
      abort.abort();
      finished();
    },
  });
  const runtime = globalThis.Bunny && globalThis.Bunny.v1;
  if (runtime && typeof runtime.waitUntil === "function") runtime.waitUntil(done);
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

// Prompt files, cached per isolate for a few minutes.
const promptCache = new Map();

// Where the prompts are: the website that sent the request (the browser
// passes its own address, which must be on that website).
export function promptsBase(origin, siteUrl) {
  if (!origin) throw badRequest("This request must come from the handbook website.");
  let base = `${origin}/`;
  if (typeof siteUrl === "string" && siteUrl) {
    let url;
    try {
      url = new URL(siteUrl);
    } catch {
      throw badRequest("The handbook address is not valid.");
    }
    if (url.origin !== origin) throw badRequest("The handbook address doesn't match this website.");
    base = `${url.origin}${url.pathname.replace(/[^/]*$/, "")}`;
  }
  return `${base}prompts/`;
}

export async function loadPrompt(fetchImpl, base, name) {
  const url = `${base}${name}.md`;
  const cached = promptCache.get(url);
  if (cached && cached.until > Date.now()) return cached.text;
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "text/markdown, text/plain" } });
  } catch {
    throw new HttpError(502, `The prompt ${name}.md couldn't be loaded from the website.`);
  }
  if (!response.ok) throw new HttpError(502, `The prompt ${name}.md couldn't be loaded from the website (${response.status}).`);
  const text = await response.text();
  promptCache.set(url, { text, until: Date.now() + PROMPT_CACHE_MS });
  return text;
}

// Replaces {{name}} placeholders.
export function fillPrompt(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in values ? String(values[key]) : all));
}

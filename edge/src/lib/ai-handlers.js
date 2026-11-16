// HTTP handlers for the AI features:
//   POST /api/ai/models   (admins) list the models an endpoint offers
//   POST /api/ai/write    the document writer, streamed
//   POST /api/ai/ask      the assistant, streamed
// See ai.js for how the endpoint is called and how streaming works.

import { HttpError, badRequest, forbidden, json, notFound, readJson } from "./http.js";
import { accessFor, canEditDocument } from "./permissions.js";
import { requireAdmin } from "./people.js";
import { searchSteps } from "./search.js";
import { getSettings, parseSettingsPatch } from "./settings.js";
import { aiEndpoint, callModel, eventStream, fillPrompt, listModels, loadPrompt, parseModelJson, promptsBase } from "./ai.js";

export const WRITER_TYPES = { sop: "SOP", policy: "Policy document", meeting: "Meeting recap" };
const WRITER_PROMPTS = { sop: "writer-sop", policy: "writer-policy", meeting: "writer-meeting-recap" };
export const MAX_DRAFT_CHARS = 100_000;
const MAX_SOURCES = 8;
const SOURCE_CHARS = 6000;
const HISTORY_MESSAGES = 8; // the last 4 turns

const WRITER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "steps"],
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    steps: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["title", "html"], properties: { title: { type: "string" }, html: { type: "string" } } },
    },
  },
};

const QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: { queries: { type: "array", items: { type: "string" } } },
};

// POST /api/ai/models { ai_provider, ai_base_url, ai_api_key }
// Uses the saved key when ai_api_key is empty, so admins can load the list
// before or after saving.
export async function handleAiModels(ctx) {
  requireAdmin(ctx);
  const body = await readJson(ctx.request);
  const saved = await getSettings(ctx.db);
  const patch = parseSettingsPatch({
    ai_provider: body.ai_provider || saved.ai_provider,
    ai_base_url: typeof body.ai_base_url === "string" ? body.ai_base_url : saved.ai_base_url,
    ...(body.ai_api_key ? { ai_api_key: body.ai_api_key } : {}),
  });
  const endpoint = aiEndpoint({ ...saved, ...patch }, { requireModels: false });
  return json({ models: await listModels(ctx.fetchImpl, endpoint) });
}

export function cleanWriterResult(value) {
  const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const steps = (Array.isArray(value && value.steps) ? value.steps : [])
    .map((s, i) => ({ title: text(s && s.title, 200) || `Step ${i + 1}`, html: text(s && s.html, 300_000) }))
    .filter((s) => s.html)
    .slice(0, 50);
  if (!steps.length) throw new HttpError(502, "The writer didn't return any content. Please try again.");
  return { title: text(value.title, 200), description: text(value.description, 1000), steps };
}

// POST /api/ai/write { document_id, type, draft, instructions, site }
export async function handleWrite(ctx) {
  const body = await readJson(ctx.request, 1_000_000);
  const document = await ctx.db.first("SELECT * FROM documents WHERE id = ?", Number(body.document_id));
  const access = await accessFor(ctx);
  if (!document) throw notFound("This document doesn't exist.");
  if (!canEditDocument(access, document)) throw forbidden("You can't edit this document.");
  const type = body.type in WRITER_TYPES ? body.type : null;
  if (!type) throw badRequest("Choose a type of document.");
  const draft = typeof body.draft === "string" ? body.draft.trim() : "";
  if (!draft) throw badRequest("Paste your rough draft first.");
  if (draft.length > MAX_DRAFT_CHARS) throw badRequest(`The draft can be ${MAX_DRAFT_CHARS.toLocaleString("en-US")} characters at most.`);
  const instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 2000) : "";
  const settings = await getSettings(ctx.db);
  const endpoint = aiEndpoint(settings);
  const base = promptsBase(ctx.origin, body.site);

  return eventStream(async (send, signal) => {
    const [shared, template] = await Promise.all([loadPrompt(ctx.fetchImpl, base, "writer"), loadPrompt(ctx.fetchImpl, base, WRITER_PROMPTS[type])]);
    const system = fillPrompt(shared, { brand_rules: settings.brand_rules.trim() || "(none)", type: WRITER_TYPES[type], template: template.trim() });
    const user = [`Document type: ${WRITER_TYPES[type]}`, instructions ? `Instructions from the author:\n${instructions}` : "", `Rough draft:\n<draft>\n${draft}\n</draft>`].filter(Boolean).join("\n\n");
    let characters = 0;
    let reported = 0;
    const { text, stop } = await callModel(ctx.fetchImpl, endpoint, {
      model: settings.writer_model,
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 64000,
      schema: WRITER_SCHEMA,
      signal,
      onText: (delta) => {
        characters += delta.length;
        if (characters - reported >= 500) {
          reported = characters;
          send("progress", { characters });
        }
      },
    });
    if (stop === "max_tokens") throw new HttpError(422, "The result was too long to finish. Try a shorter draft, or write it in several parts.");
    send("result", cleanWriterResult(parseModelJson(text)));
  });
}

function cleanConversation(messages) {
  if (!Array.isArray(messages) || !messages.length) throw badRequest("Ask a question first.");
  const list = messages.slice(-(HISTORY_MESSAGES + 1)).map((m) => ({
    role: m && m.role === "assistant" ? "assistant" : "user",
    content: typeof (m && m.content) === "string" ? m.content.trim().slice(0, 8000) : "",
  }));
  const question = list[list.length - 1];
  if (question.role !== "user" || !question.content) throw badRequest("Ask a question first.");
  if (question.content.length > 2000) throw badRequest("Questions can be 2,000 characters at most.");
  // The API expects turns to alternate, starting with the member.
  const history = [];
  for (const m of list.slice(0, -1)) {
    if (!m.content) continue;
    if (!history.length && m.role !== "user") continue;
    if (history.length && history[history.length - 1].role === m.role) history[history.length - 1] = m;
    else history.push(m);
  }
  if (history.length && history[history.length - 1].role === "user") history.pop();
  return { history, question: question.content };
}

// The steps that best match any of the queries, among documents the member
// can view (the index only holds published steps). Best first.
export async function retrieveSources(db, access, queries) {
  const best = new Map();
  for (const query of queries) {
    for (const hit of await searchSteps(db, access, query, 20)) {
      const known = best.get(hit.step_id);
      if (!known || hit.rank < known.rank) best.set(hit.step_id, hit);
    }
  }
  const top = [...best.values()].sort((a, b) => a.rank - b.rank).slice(0, MAX_SOURCES);
  if (!top.length) return [];
  const rows = await db.all(
    `SELECT s.id AS step_id, s.title AS step_title, s.content_text, d.id AS document_id, d.title AS document_title, c.name AS category, c.emoji
       FROM steps s JOIN documents d ON d.id = s.document_id JOIN categories c ON c.id = d.category_id
      WHERE s.id IN (${top.map(() => "?").join(", ")}) AND d.is_published = 1`,
    ...top.map((h) => h.step_id),
  );
  const byId = new Map(rows.map((r) => [r.step_id, r]));
  return top.map((h) => byId.get(h.step_id)).filter(Boolean);
}

// POST /api/ai/ask { messages: [{ role, content }], site }
// Events: ready, searching { queries }, sources [ { n, ... } ], text { text }, done.
export async function handleAsk(ctx) {
  const body = await readJson(ctx.request);
  const { history, question } = cleanConversation(body.messages);
  const settings = await getSettings(ctx.db);
  const endpoint = aiEndpoint(settings);
  const base = promptsBase(ctx.origin, body.site);
  const access = await accessFor(ctx);

  return eventStream(async (send, signal) => {
    const [queryPrompt, answerPrompt] = await Promise.all([loadPrompt(ctx.fetchImpl, base, "assistant-queries"), loadPrompt(ctx.fetchImpl, base, "assistant")]);

    // 1. Keyword queries from a fast model.
    const transcript = history.map((m) => `${m.role === "user" ? "Member" : "Assistant"}: ${m.content.slice(0, 1500)}`).join("\n\n");
    const queryCall = await callModel(ctx.fetchImpl, endpoint, {
      model: settings.assistant_query_model,
      system: queryPrompt.trim(),
      messages: [{ role: "user", content: `${transcript ? `Conversation so far:\n${transcript}\n\n` : ""}New question: ${question}` }],
      maxTokens: 4000,
      schema: QUERY_SCHEMA,
      signal,
    });
    let queries = [];
    try {
      const parsed = parseModelJson(queryCall.text);
      queries = (Array.isArray(parsed.queries) ? parsed.queries : []).filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim().slice(0, 200)).slice(0, 5);
    } catch {
      queries = [];
    }
    queries.push(question);
    send("searching", { queries: queries.slice(0, -1) });

    // 2. Retrieval, limited to what the member can view.
    const rows = await retrieveSources(ctx.db, access, queries);
    const sources = rows.map((r, i) => ({ n: i + 1, step_id: r.step_id, step_title: r.step_title, document_id: r.document_id, document_title: r.document_title, category: r.category, emoji: r.emoji || "" }));
    send("sources", sources);

    // 3. The answer, streamed.
    const sourceText = rows.length
      ? rows.map((r, i) => `[${i + 1}] ${r.category} > ${r.document_title} > ${r.step_title}\n${String(r.content_text || "").slice(0, SOURCE_CHARS)}`).join("\n\n")
      : "(No step of the handbook matched this question.)";
    const system = fillPrompt(answerPrompt, { brand_rules: settings.brand_rules.trim() || "(none)" });
    const { stop } = await callModel(ctx.fetchImpl, endpoint, {
      model: settings.assistant_model,
      system,
      messages: [...history, { role: "user", content: `Handbook sources:\n\n${sourceText}\n\nQuestion: ${question}` }],
      maxTokens: 8000,
      signal,
      onText: (text) => send("text", { text }),
    });
    send("done", { truncated: stop === "max_tokens" });
  });
}

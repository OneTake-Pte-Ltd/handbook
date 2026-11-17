import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../edge/src/app.js";
import { ORIGIN, workspace } from "./helpers.mjs";
import { endpointBase, parseModelJson } from "../edge/src/lib/ai.js";

const paragraph = (text) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

// Server-Sent Events body from a list of [event, data] pairs.
function sse(events) {
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
// An Anthropic Messages stream that writes `text` in small pieces.
function anthropicStream(text, stop = "end_turn") {
  const pieces = text.match(/[\s\S]{1,40}/g) || [];
  return sse([
    ["message_start", { type: "message_start", message: { id: "msg_1" } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ...pieces.map((p) => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } }]),
    ["message_delta", { type: "message_delta", delta: { stop_reason: stop } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}
function openaiStream(text) {
  return new Response(`${(text.match(/[\s\S]{1,40}/g) || []).map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join("")}data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}
// Reads an SSE response into [{ event, data }].
async function events(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((b) => {
      const [line, data] = b.split("\n");
      return { event: line.slice(7), data: JSON.parse(data.slice(6)) };
    });
}

async function setup(answer) {
  const w = await workspace();
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.startsWith(`${ORIGIN}/prompts/`)) return new Response(`Prompt ${url.split("/").pop()} {{brand_rules}} {{template}}`);
    return answer(url, init.body ? JSON.parse(init.body) : null, init);
  };
  const app = createApp({ db: w.t.db, env: w.t.env, fetchImpl });
  const call = async (method, path, body, token = w.admin) =>
    app.handle(new Request(`https://edge.example.com${path}`, { method, headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
  const settings = (values) => w.t.call("PATCH", "/api/settings", { token: w.admin, body: values });
  return { ...w, app, call, requests, settings };
}

async function publishedDoc(s, categoryId, title, text) {
  const id = (await s.t.call("POST", "/api/documents", { token: s.admin, body: { category_id: categoryId, title } })).body.document.id;
  const draft = (await s.t.call("GET", `/api/documents/${id}/draft`, { token: s.admin })).body.draft;
  draft.snapshot.steps[0].content_json = paragraph(text);
  await s.t.call("PUT", `/api/documents/${id}/draft`, { token: s.admin, body: { snapshot: draft.snapshot, base_updated_at: draft.updated_at } });
  await s.t.call("POST", `/api/documents/${id}/draft/publish`, { token: s.admin, body: { revision_type: "minor" } });
  return id;
}

test("endpoint addresses and lenient JSON", () => {
  assert.equal(endpointBase("anthropic", ""), "https://api.anthropic.com");
  assert.equal(endpointBase("anthropic", "https://proxy.example.com/v1/"), "https://proxy.example.com");
  assert.equal(endpointBase("openai", ""), "https://api.openai.com/v1");
  assert.deepEqual(parseModelJson('```json\n{"queries":["a"]}\n```'), { queries: ["a"] });
});

test("AI settings: the key is write-only, models are listed from the endpoint, /me says when AI is on", async () => {
  const s = await setup((url, body, init) => {
    if (url === "https://api.anthropic.com/v1/models?limit=1000") {
      assert.equal(init.headers["x-api-key"], "sk-ant-test-1234");
      return Response.json({ data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }, { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] });
    }
    if (url === "https://llm.example.com/v1/models") {
      assert.equal(init.headers.authorization, "Bearer other-key");
      return Response.json({ data: [{ id: "gpt-5.1" }] });
    }
    return new Response("{}", { status: 404 });
  });
  assert.equal((await s.t.call("GET", "/api/me", { token: s.admin })).body.workspace.ai_enabled, false);
  const saved = await s.settings({ ai_api_key: "sk-ant-test-1234" });
  assert.equal(saved.body.ai_key_hint, "1234");
  assert.equal(JSON.stringify(saved.body).includes("sk-ant-test"), false);
  assert.ok(saved.body.brand_rules.includes("OneTake AI"), "brand rules are prefilled");

  const listed = await (await s.call("POST", "/api/ai/models", {})).json();
  assert.deepEqual(listed.models.map((m) => m.id), ["claude-haiku-5-5", "claude-sonnet-5-5"]);
  const other = await (await s.call("POST", "/api/ai/models", { ai_provider: "openai", ai_base_url: "https://llm.example.com/v1", ai_api_key: "other-key" })).json();
  assert.deepEqual(other.models, [{ id: "gpt-5.1", name: "gpt-5.1" }]);
  assert.equal((await s.call("POST", "/api/ai/models", { ai_base_url: "http://evil.example.com" })).status, 400);

  assert.equal((await s.t.call("GET", "/api/me", { token: s.admin })).body.workspace.ai_enabled, true);
  const member = await s.member("Mo", []);
  assert.equal((await s.call("POST", "/api/ai/models", {}, member.token)).status, 403);
});

test("the writer streams progress and returns the structured result; it needs edit rights", async () => {
  const result = { title: "Refund requests", description: "How to handle a refund.", steps: [{ title: "Check the order", html: "<p>Open the order.</p>" }, { title: "Refund", html: "<ol><li>Click Refund.</li></ol>" }] };
  const s = await setup((url, body) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(body.model, "claude-sonnet-5-5");
    assert.equal(body.stream, true);
    assert.equal(body.output_config.format.type, "json_schema");
    assert.ok(body.system.startsWith("Prompt writer.md"));
    assert.ok(body.system.includes("Prompt writer-sop.md"), "the type template is included");
    assert.ok(body.system.includes("semicolon"), "brand rules are included");
    assert.ok(body.messages[0].content.includes("customer wants money back"));
    return anthropicStream(JSON.stringify(result) + " ".repeat(600));
  });
  await s.settings({ ai_api_key: "sk-ant-test-1234" });
  const space = (await s.t.call("POST", "/api/spaces", { token: s.admin, body: { name: "S" } })).body.space;
  const category = (await s.t.call("POST", "/api/categories", { token: s.admin, body: { space_id: space.id, name: "C" } })).body.category;
  const doc = (await s.t.call("POST", "/api/documents", { token: s.admin, body: { category_id: category.id, title: "New" } })).body.document;

  const response = await s.call("POST", "/api/ai/write", { document_id: doc.id, type: "sop", draft: "customer wants money back, check order, refund", site: `${ORIGIN}/index.html` });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const list = await events(response);
  assert.equal(list[0].event, "ready");
  assert.ok(list.some((e) => e.event === "progress"));
  assert.deepEqual(list.at(-1), { event: "result", data: result });

  assert.equal((await s.call("POST", "/api/ai/write", { document_id: doc.id, type: "sop", draft: "" })).status, 400);
  assert.equal((await s.call("POST", "/api/ai/write", { document_id: doc.id, type: "novel", draft: "x" })).status, 400);
  const reader = await s.member("Rita", []);
  assert.equal((await s.call("POST", "/api/ai/write", { document_id: doc.id, type: "sop", draft: "x" }, reader.token)).status, 403);
});

test("the assistant searches only what the member can view, then streams a cited answer", async () => {
  const s = await setup((url, body) => {
    if (body.model === "claude-haiku-5-5") return anthropicStream('{"queries":["holiday leave","vacation"]}');
    const sources = body.messages.at(-1).content;
    assert.ok(sources.includes("Request your holidays two weeks ahead"), "the visible document is a source");
    assert.equal(sources.includes("Secret bonus scheme"), false, "documents the member can't view are never sent");
    assert.ok(body.system.includes("semicolon"));
    return anthropicStream("Ask your leader two weeks ahead [1].");
  });
  await s.settings({ ai_api_key: "sk-ant-test-1234" });
  const space = (await s.t.call("POST", "/api/spaces", { token: s.admin, body: { name: "S" } })).body.space;
  const open = (await s.t.call("POST", "/api/categories", { token: s.admin, body: { space_id: space.id, name: "People" } })).body.category;
  const closed = (await s.t.call("POST", "/api/categories", { token: s.admin, body: { space_id: space.id, name: "Management" } })).body.category;
  await s.t.call("PUT", "/api/grants", { token: s.admin, body: { target_type: "category", target_id: open.id, principal_type: "department", principal_id: s.dept.Everyone, level: "view" } });
  const holidays = await publishedDoc(s, open.id, "Holidays", "Request your holidays two weeks ahead, vacation leave policy.");
  await publishedDoc(s, closed.id, "Bonus", "Secret bonus scheme for holiday leave and vacation.");
  const member = await s.member("Mia", []);

  const response = await s.call("POST", "/api/ai/ask", { messages: [{ role: "user", content: "How do I take vacation?" }], site: `${ORIGIN}/` }, member.token);
  const list = await events(response);
  assert.deepEqual(list.find((e) => e.event === "searching").data.queries, ["holiday leave", "vacation"]);
  const sources = list.find((e) => e.event === "sources").data;
  assert.deepEqual(sources.map((x) => [x.n, x.document_id, x.document_title]), [[1, holidays, "Holidays"]]);
  assert.equal(list.filter((e) => e.event === "text").map((e) => e.data.text).join(""), "Ask your leader two weeks ahead [1].");
  assert.equal(list.at(-1).event, "done");
});

test("OpenAI-compatible endpoints stream too; endpoint errors arrive as readable error events", async () => {
  let fail = false;
  const s = await setup((url, body, init) => {
    if (fail) return Response.json({ error: { message: "invalid api key" } }, { status: 401 });
    assert.equal(url, "https://llm.example.com/v1/chat/completions");
    assert.equal(init.headers.authorization, "Bearer key-2");
    assert.equal(body.messages[0].role, "system");
    return body.model === "small" ? openaiStream('{"queries":["x"]}') : openaiStream("No source covers this.");
  });
  await s.settings({ ai_provider: "openai", ai_base_url: "https://llm.example.com/v1", ai_api_key: "key-2", writer_model: "big", assistant_model: "big", assistant_query_model: "small" });
  const ok = await events(await s.call("POST", "/api/ai/ask", { messages: [{ role: "user", content: "Anything?" }], site: `${ORIGIN}/` }));
  assert.deepEqual(ok.find((e) => e.event === "sources").data, []);
  assert.equal(ok.filter((e) => e.event === "text").map((e) => e.data.text).join(""), "No source covers this.");
  fail = true;
  const failed = await events(await s.call("POST", "/api/ai/ask", { messages: [{ role: "user", content: "Anything?" }], site: `${ORIGIN}/` }));
  assert.match(failed.at(-1).data.error, /returned an error \(401\): invalid api key\. Check the API key/);
  assert.equal((await s.call("POST", "/api/ai/ask", { messages: [{ role: "user", content: "x" }], site: "https://other.example.com/" })).status, 400, "prompts only come from the calling website");
});

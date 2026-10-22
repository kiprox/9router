// Bug #1 (cline adapter), defense in depth: the proxy asked for SSE but the
// upstream answered application/json. Before this guard, streamingHandler piped
// the JSON body through the SSE transform, which forwarded the raw line and
// appended `data: [DONE]` — a body no SSE client can parse (and whose cline
// {"success":true,"data":{…}} envelope hid the choices one level down).
//
// Now a real completion is re-encoded as one valid SSE frame + [DONE], and
// anything else becomes a clean 502 JSON error instead of a broken stream.
//
// Run: node --test --import ./tests/unit/.support/open-sse-alias-loader.mjs \
//        tests/unit/cline-streaming-json-envelope.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { handleStreamingResponse, buildSSEFromCompletion } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "google/gemini-2.5-flash-image",
  choices: [{ index: 0, message: { role: "assistant", content: "hi", images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function baseArgs(providerResponse, provider = "cline") {
  return {
    providerResponse,
    provider,
    model: "google/gemini-2.5-flash-image",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    body: { stream: true },
    stream: true,
    reqTag: "t",
    log: null,
  };
}

async function readBody(result) {
  return { contentType: result.response.headers.get("content-type"), text: await result.response.text() };
}

test("wrapped cline envelope is unwrapped and re-emitted as valid SSE", async () => {
  const result = await handleStreamingResponse(baseArgs(jsonResponse({ success: true, data: COMPLETION })));

  assert.equal(result.success, true);
  const { contentType, text } = await readBody(result);
  assert.match(contentType, /text\/event-stream/);

  const frames = text.split("\n\n").filter(Boolean);
  assert.equal(frames.length, 2, "one completion frame + the terminal frame");
  assert.ok(frames[0].startsWith("data: "), "frame must carry the SSE prefix");
  assert.equal(frames[1], "data: [DONE]");

  const payload = JSON.parse(frames[0].slice("data: ".length));
  assert.deepEqual(payload, COMPLETION, "unwrapped completion, not the envelope");
  assert.equal(payload.success, undefined);
  assert.equal(payload.choices[0].message.images.length, 1);
});

test("bare completion JSON is re-emitted as SSE too (any provider that ignores stream)", async () => {
  for (const provider of ["cline", "openai"]) {
    const result = await handleStreamingResponse(baseArgs(jsonResponse(COMPLETION), provider));
    assert.equal(result.success, true, provider);
    const { text } = await readBody(result);
    assert.deepEqual(JSON.parse(text.split("\n\n")[0].slice("data: ".length)), COMPLETION);
  }
});

test("JSON that is not a completion becomes a clean 502 error body", async () => {
  const result = await handleStreamingResponse(baseArgs(jsonResponse({ success: false, error: "empty response content" })));

  assert.equal(result.success, false);
  assert.equal(result.response.status, 502);
  const { contentType, text } = await readBody(result);
  assert.match(contentType, /application\/json/);

  const body = JSON.parse(text);
  assert.match(body.error.message, /^\[502\]: /);
  assert.match(body.error.message, /no choices: empty response content/);
  assert.doesNotMatch(text, /\[DONE\]/, "an error body must never carry SSE terminal bytes");
});

test("an envelope is only unwrapped for providers that opted in (no cross-provider rewrite)", async () => {
  const envelope = { success: true, data: COMPLETION };
  // openai did not opt into clineEnvelope: the envelope has no top-level
  // `choices`, so it is treated as a broken upstream rather than silently
  // reinterpreted.
  const result = await handleStreamingResponse(baseArgs(jsonResponse(envelope), "openai"));
  assert.equal(result.success, false);
  assert.equal(result.response.status, 502);
});

test("a non-JSON 200 body is still reported as a 502 (unchanged behavior)", async () => {
  const result = await handleStreamingResponse(baseArgs(jsonResponse("not json at all", { headers: { "content-type": "application/json" } })));
  assert.equal(result.success, false);
  assert.equal(result.response.status, 502);
});

test("an upstream error status keeps its own status code in the JSON branch", async () => {
  const result = await handleStreamingResponse(baseArgs(jsonResponse({ error: { message: "rate limited" } }, { status: 429 })));
  assert.equal(result.success, false);
  assert.equal(result.response.status, 502, "the SSE client never saw SSE, so the proxy owns the error");
});

test("buildSSEFromCompletion produces exactly one frame plus [DONE]", () => {
  assert.equal(buildSSEFromCompletion({ choices: [] }), 'data: {"choices":[]}\n\ndata: [DONE]\n\n');
});

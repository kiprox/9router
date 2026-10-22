// Bug #1 (cline adapter), defense in depth: the proxy asked for SSE but the
// upstream answered application/json. Before this guard, streamingHandler piped
// the JSON body through the SSE transform, which forwarded the raw line and
// appended `data: [DONE]` — a body no SSE client can parse (and whose cline
// {"success":true,"data":{…}} envelope hid the choices one level down).
//
// Now a real completion is re-encoded as SSE, and anything else becomes a clean
// 502 JSON error instead of a broken stream. Cline additionally declares
// `quirks.jsonToSseChunks`, so its SSE clients get real `chat.completion.chunk`
// deltas (a delta-based reader ignores a whole-completion frame).
//
// Run: node --test --import ./tests/unit/.support/open-sse-alias-loader.mjs \
//        tests/unit/cline-streaming-json-envelope.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { handleStreamingResponse, buildSSEFromCompletion, buildSSEChunksFromCompletion } from "../../open-sse/handlers/chatCore/streamingHandler.js";
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

test("wrapped cline envelope is unwrapped and re-emitted as valid SSE chunks", async () => {
  const result = await handleStreamingResponse(baseArgs(jsonResponse({ success: true, data: COMPLETION })));

  assert.equal(result.success, true);
  const { contentType, text } = await readBody(result);
  assert.match(contentType, /text\/event-stream/);

  const frames = text.split("\n\n").filter(Boolean);
  assert.ok(frames.length > 2, "a delta sequence, not one whole-completion frame");
  assert.equal(frames.at(-1), "data: [DONE]");
  for (const frame of frames.slice(0, -1)) {
    assert.ok(frame.startsWith("data: "), "every frame must carry the SSE prefix");
    const payload = JSON.parse(frame.slice("data: ".length));
    assert.equal(payload.object, "chat.completion.chunk");
    assert.equal(payload.success, undefined, "the envelope must not leak into a chunk");
  }

  // The picture rides on its own delta — that is what a streaming client reads.
  const deltas = frames.slice(0, -1).map((f) => JSON.parse(f.slice("data: ".length)).choices[0].delta);
  const imageDelta = deltas.find((d) => Array.isArray(d.images) && d.images.length > 0);
  assert.ok(imageDelta, "images[] must survive the JSON→SSE conversion");
  assert.equal(imageDelta.images[0].image_url.url, "data:image/png;base64,AAA");
  assert.ok(deltas.some((d) => d.content === "hi"), "text content is streamed as a delta too");
});

test("bare completion JSON is re-emitted as SSE too (any provider that ignores stream)", async () => {
  // cline opts into chunked frames; a provider that did not keeps the single
  // whole-completion frame this branch has always produced.
  const clineResult = await handleStreamingResponse(baseArgs(jsonResponse(COMPLETION), "cline"));
  assert.equal(clineResult.success, true);
  const clineText = (await readBody(clineResult)).text;
  assert.match(clineText, /chat\.completion\.chunk/);

  const otherResult = await handleStreamingResponse(baseArgs(jsonResponse(COMPLETION), "openai"));
  assert.equal(otherResult.success, true);
  const otherText = (await readBody(otherResult)).text;
  assert.deepEqual(JSON.parse(otherText.split("\n\n")[0].slice("data: ".length)), COMPLETION);
});

test("JSON that is not a completion becomes a clean 502 error body", async () => {
  const result = await handleStreamingResponse(baseArgs(jsonResponse({ success: false, error: "empty response content" })));

  assert.equal(result.success, false);
  assert.equal(result.response.status, 502);
  const { contentType, text } = await readBody(result);
  assert.match(contentType, /application\/json/);

  const body = JSON.parse(text);
  // The upstream that produced the failure is named, not just the status code.
  assert.match(body.error.message, /^\[cline\/google\/gemini-2\.5-flash-image\] \[502\]: /);
  assert.match(body.error.message, /no choices: empty response content/);
  assert.doesNotMatch(text, /\[DONE\]/, "an error body must never carry SSE terminal bytes");
});

test("a 200 with an empty completion is a 502, never a successful no-op stream", async () => {
  const empty = {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "google/gemini-3-pro-image",
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
  };
  const result = await handleStreamingResponse({
    ...baseArgs(jsonResponse(empty)),
    model: "google/gemini-3-pro-image",
  });

  assert.equal(result.success, false);
  assert.equal(result.response.status, 502);
  const body = JSON.parse((await readBody(result)).text);
  assert.match(body.error.message, /cline\/google\/gemini-3-pro-image/);
  assert.match(body.error.message, /empty completion/i);
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

test("buildSSEChunksFromCompletion splits a completion into delta frames", () => {
  const sse = buildSSEChunksFromCompletion(COMPLETION);
  const frames = sse.split("\n\n").filter(Boolean);
  assert.equal(frames.at(-1), "data: [DONE]");

  const chunks = frames.slice(0, -1).map((f) => JSON.parse(f.slice("data: ".length)));
  for (const chunk of chunks) {
    assert.equal(chunk.object, "chat.completion.chunk");
    assert.equal(chunk.id, COMPLETION.id);
    assert.equal(chunk.model, COMPLETION.model);
  }
  // The last chunk carries the finish reason and the usage trailer.
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.deepEqual(chunks.at(-1).usage, COMPLETION.usage);
  // Nothing is invented for a completion with no output at all.
  const bare = buildSSEChunksFromCompletion({ choices: [{ message: {}, finish_reason: "stop" }] });
  assert.equal(bare.split("\n\n").filter(Boolean).length, 3, "role frame + finish frame + [DONE]");
});

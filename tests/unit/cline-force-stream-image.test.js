// Bug #2b (cline adapter): which wire variant a cline image model answers.
//
// The first fix forced these models to STREAM, based on a `stream:false` 500
// "empty response content". Measured live on 2026-10-22 against api.cline.bot
// (gemini-2.5-flash-image and gemini-nano-banana-2.1), that conclusion was
// backwards:
//
//   body (no stream key)          → 200 + message.images[]  (the picture)
//   body {"stream":false}         → 500 empty response content
//   body {"stream":true}          → 200 + text only, images[] empty
//
// So the picture lives on the NON-stream body, and an explicit `stream:false` is
// what breaks it. The registry quirks therefore encode three separate facts, and
// each has to reach the place that acts on it:
//   nonStreamOnlyModels   → never ask upstream to stream (chatCore)
//   omitStreamFlagWhenFalse → drop the key instead of sending false (chatCore)
//   imageModels           → the Images API adapter's image-model test
//
// Run: node --test --import ./tests/unit/.support/open-sse-alias-loader.mjs \
//        tests/unit/cline-force-stream-image.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { shouldStreamUpstream, applyUpstreamStreamFlag } from "../../open-sse/handlers/chatCore.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const quirks = PROVIDERS.cline?.quirks;
const nonStreamOnlyModels = quirks?.nonStreamOnlyModels;
const imageModels = quirks?.imageModels;

function clineNonStreamOnly(model) {
  return nonStreamOnlyModels?.test(model) === true;
}

test("cline declares the variant quirks without losing the envelope quirk", () => {
  assert.equal(quirks?.clineEnvelope, true);
  assert.ok(nonStreamOnlyModels instanceof RegExp);
  assert.ok(imageModels instanceof RegExp);
  assert.equal(nonStreamOnlyModels.flags.includes("g"), false, "a /g regex leaks lastIndex across requests");
  assert.equal(imageModels.flags.includes("g"), false, "a /g regex leaks lastIndex across requests");
  assert.equal(quirks?.omitStreamFlagWhenFalse, true);
  assert.equal(quirks?.rejectEmptyCompletion, true);
});

test("the quirks match image models only, and stay stateless across repeated calls", () => {
  for (const model of ["google/gemini-2.5-flash-image", "google/gemini-3-pro-image", "openai/gpt-image-1"]) {
    assert.equal(clineNonStreamOnly(model), true, model);
  }
  for (const model of ["anthropic/claude-opus-4.7", "openai/gpt-5.4", "google/gemini-3.1-pro-preview"]) {
    assert.equal(clineNonStreamOnly(model), false, model);
  }
  // Without /g, .test() cannot alternate true/false on identical input.
  const results = Array.from({ length: 5 }, () => clineNonStreamOnly("google/gemini-2.5-flash-image"));
  assert.deepEqual(results, [true, true, true, true, true]);
});

// The decision itself is unchanged — an explicit `stream` key and the Accept
// heuristic still win. What changed is that a provider quirk can no longer
// override it: the quirk now says "ask for JSON", which is the opposite.
test("the stream decision keeps honouring the client, with no provider quirk input", () => {
  assert.equal(shouldStreamUpstream({ body: { stream: false }, sourceFormat: FORMATS.OPENAI, acceptHeader: "application/json", jsonOnlyAccept: true }), false);
  assert.equal(shouldStreamUpstream({ body: { stream: true }, sourceFormat: FORMATS.OPENAI, acceptHeader: "application/json", jsonOnlyAccept: true }), true);
  assert.equal(shouldStreamUpstream({ body: {}, sourceFormat: FORMATS.OPENAI, acceptHeader: "text/event-stream" }), true);
  assert.equal(shouldStreamUpstream({ body: {}, sourceFormat: FORMATS.OPENAI, acceptHeader: "*/*" }), false);
});

test("a non-stream-only model is asked for JSON even when the client wants SSE", () => {
  // This mirrors the chatCore expression: stream = clientStreams && !nonStreamOnly.
  for (const model of ["google/gemini-2.5-flash-image", "google/gemini-nano-banana-2.1"]) {
    const clientStreams = shouldStreamUpstream({ body: { stream: true }, sourceFormat: FORMATS.OPENAI });
    assert.equal(clientStreams && !clineNonStreamOnly(model), false, model);
  }
  // A chat model on the same provider keeps streaming.
  const clientStreams = shouldStreamUpstream({ body: { stream: true }, sourceFormat: FORMATS.OPENAI });
  assert.equal(clientStreams && !clineNonStreamOnly("openai/gpt-5.4"), true);
});

test("omitStreamFlagWhenFalse drops the key instead of sending an explicit false", () => {
  const body = { model: "m", messages: [], stream: false };
  applyUpstreamStreamFlag(body, FORMATS.OPENAI, false, true);
  assert.equal("stream" in body, false, "an explicit false is what returns 500 empty response content");

  // Streaming still pins the key, and providers without the quirk are unchanged.
  const streamed = { model: "m", messages: [] };
  applyUpstreamStreamFlag(streamed, FORMATS.OPENAI, true, true);
  assert.equal(streamed.stream, true);

  const explicit = { model: "m", messages: [] };
  applyUpstreamStreamFlag(explicit, FORMATS.OPENAI, false, false);
  assert.equal(explicit.stream, false);
});

test("providers without the quirks are unaffected", () => {
  for (const id of ["openai", "claude", "gemini-cli"]) {
    assert.equal(PROVIDERS[id]?.quirks?.nonStreamOnlyModels, undefined, id);
    assert.equal(PROVIDERS[id]?.quirks?.omitStreamFlagWhenFalse, undefined, id);
    assert.equal(PROVIDERS[id]?.quirks?.rejectEmptyCompletion, undefined, id);
  }
});

test("the forced-SSE path has a usable SSE→JSON conversion for a non-stream client", () => {
  // handleForcedSSEToJson consumes an upstream SSE; its parser is what turns the
  // forced stream back into the JSON body the client asked for.
  const sse = [
    `data: ${JSON.stringify({ id: "c1", model: "google/gemini-2.5-flash-image", choices: [{ index: 0, delta: { role: "assistant", content: "here you go" } }] })}`,
    "",
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const parsed = parseSSEToOpenAIResponse(sse, "google/gemini-2.5-flash-image");
  assert.equal(parsed.object, "chat.completion");
  assert.equal(parsed.choices[0].message.content, "here you go");
  assert.equal(parsed.choices[0].finish_reason, "stop");
  assert.deepEqual(parsed.usage, { prompt_tokens: 3, completion_tokens: 2 });

  // An empty upstream stream is not converted into a fake completion — the
  // request then falls through to the honest error path (Fase 2).
  assert.equal(parseSSEToOpenAIResponse("data: [DONE]\n\n", "m"), null);
});

test("images streamed as delta.images[] survive the SSE→JSON conversion", () => {
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } };
  const sse = [
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant" } }] })}`,
    "",
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { images: [image] } }] })}`,
    "",
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const parsed = parseSSEToOpenAIResponse(sse, "google/gemini-2.5-flash-image");
  assert.equal(parsed.choices[0].message.images.length, 1);
  assert.deepEqual(parsed.choices[0].message.images[0], image);
});

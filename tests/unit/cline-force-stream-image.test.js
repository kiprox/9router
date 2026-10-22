// Bug #2b (cline adapter): cline image models only answer the streaming variant.
// `stream:false` returns a bare 500 "empty response content", so a JSON client
// must be served by streaming upstream anyway and converting the SSE back.
//
// The trigger is a registry quirk (no model names in code):
//   transport.quirks.forceStreamModels = /image/i
// and it has to reach three places — the stream decision, the outbound body, and
// the forced SSE→JSON conversion — or a non-stream client gets an empty result.
//
// Run: node --test --import ./tests/unit/.support/open-sse-alias-loader.mjs \
//        tests/unit/cline-force-stream-image.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { shouldStreamUpstream } from "../../open-sse/handlers/chatCore.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const quirks = PROVIDERS.cline?.quirks;
const forceStreamModels = quirks?.forceStreamModels;

function clineForcesStream(model) {
  return forceStreamModels?.test(model) === true;
}

test("cline opts into the forceStreamModels quirk without breaking the envelope quirk", () => {
  assert.equal(quirks?.clineEnvelope, true);
  assert.ok(forceStreamModels instanceof RegExp);
  assert.equal(forceStreamModels.flags.includes("g"), false, "a /g regex leaks lastIndex across requests");
});

test("quirk matches image models only, and stays stateless across repeated calls", () => {
  for (const model of ["google/gemini-2.5-flash-image", "google/gemini-3-pro-image", "openai/gpt-image-1"]) {
    assert.equal(clineForcesStream(model), true, model);
  }
  for (const model of ["anthropic/claude-opus-4.7", "openai/gpt-5.4", "google/gemini-3.1-pro-preview"]) {
    assert.equal(clineForcesStream(model), false, model);
  }
  // Without /g, .test() cannot alternate true/false on identical input.
  const results = Array.from({ length: 5 }, () => clineForcesStream("google/gemini-2.5-flash-image"));
  assert.deepEqual(results, [true, true, true, true, true]);
});

test("quirk forces upstream streaming even when the client asked for stream:false", () => {
  for (const body of [{ stream: false }, {}, { stream: true }]) {
    assert.equal(
      shouldStreamUpstream({
        body,
        sourceFormat: FORMATS.OPENAI,
        acceptHeader: "application/json",
        jsonOnlyAccept: true,
        forceStreamModels: clineForcesStream("google/gemini-2.5-flash-image"),
      }),
      true,
    );
  }
  // Other cline models keep the client's decision.
  assert.equal(
    shouldStreamUpstream({
      body: { stream: false },
      sourceFormat: FORMATS.OPENAI,
      forceStreamModels: clineForcesStream("openai/gpt-5.4"),
    }),
    false,
  );
});

// A registry quirk that is not on cline itself must still behave: the regex is
// read per provider, so an unknown/absent quirk can never force streaming.
test("providers without the quirk are unaffected", () => {
  for (const id of ["openai", "claude", "gemini-cli"]) {
    assert.equal(PROVIDERS[id]?.quirks?.forceStreamModels, undefined, id);
  }
});

test("the forced-SSE path has a usable SSE→JSON conversion for a non-stream client", () => {
  // handleForcedSSEToJson consumes the upstream SSE; its parser is what turns the
  // forced stream back into the JSON body the client asked for (including images
  // delivered as content markdown, which cline image models emit).
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

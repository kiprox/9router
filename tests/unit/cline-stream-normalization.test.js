// Bug #1 (cline adapter): a plain OpenAI→OpenAI request carried no `stream` key,
// so the upstream answered non-stream with its {"success":true,"data":{…}} envelope
// while the proxy kept treating the request as SSE — the envelope then reached the
// client as a JSON body followed by a stray `data: [DONE]`.
//
// The decision is now explicit: absent `stream` = non-stream (OpenAI spec), an
// explicit key wins, and a client that only accepts SSE can still opt in via the
// Accept header. The decision is also *sent* upstream, so the body can never be
// interpreted differently on the two sides of the proxy.
//
// Bare node test (node --test tests/unit/cline-stream-normalization.test.js) — this
// repo has no wired test runner (AGENTS.md), and no vitest is installed.
import test from "node:test";
import assert from "node:assert/strict";
import { shouldStreamUpstream, applyUpstreamStreamFlag } from "../../open-sse/handlers/chatCore.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function decide(body, { accept = "*/*", sourceFormat = FORMATS.OPENAI, ...rest } = {}) {
  return shouldStreamUpstream({ body, sourceFormat, acceptHeader: accept, ...rest });
}

test("absent stream key = non-stream (OpenAI spec default), even with a permissive Accept", () => {
  assert.equal(decide({ messages: [] }, { accept: "*/*" }), false);
  assert.equal(decide({ messages: [] }, { accept: "" }), false);
  assert.equal(decide({ messages: [] }, { accept: "application/json" }), false);
});

test("explicit stream:true → stream, explicit stream:false → non-stream", () => {
  assert.equal(decide({ stream: true }), true);
  assert.equal(decide({ stream: true }, { accept: "application/json" }), true);
  assert.equal(decide({ stream: false }), false);
  assert.equal(decide({ stream: false }, { accept: "text/event-stream" }), false);
});

test("Accept heuristic: text/event-stream alone opts into SSE, not alongside application/json", () => {
  assert.equal(decide({}, { accept: "text/event-stream" }), true);
  assert.equal(decide({}, { accept: "text/event-stream;q=0.9" }), true);
  assert.equal(decide({}, { accept: "application/json, text/event-stream" }), false);
});

test("Gemini-family wire formats always stream (their agents cannot parse JSON)", () => {
  for (const sourceFormat of [FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY]) {
    assert.equal(decide({}, { sourceFormat }), true, sourceFormat);
  }
});

test("provider forceStream wins; a non-interactive deepseek-tui run still forces JSON", () => {
  assert.equal(decide({}, { providerRequiresStreaming: true }), true);
  assert.equal(decide({}, { forceStreamModels: true }), true);
  // deepseek-tui -p: no explicit stream → JSON, even when Accept claims SSE.
  assert.equal(decide({}, { clientNoStream: true }), false);
  assert.equal(decide({}, { clientNoStream: true, accept: "text/event-stream" }), false);
  assert.equal(decide({}, { clientNoStream: true, sourceFormat: FORMATS.GEMINI_CLI }), false);
  // ... but an explicit stream:true from the interactive TUI panel still streams.
  assert.equal(decide({ stream: true }, { clientNoStream: true }), true);
});

test("jsonOnlyAccept keeps AI SDK-style clients on JSON regardless of format", () => {
  assert.equal(decide({}, { jsonOnlyAccept: true, sourceFormat: FORMATS.GEMINI }), false);
  assert.equal(decide({ stream: true }, { jsonOnlyAccept: true }), true);
});

test("applyUpstreamStreamFlag pins stream onto a chat-completions body in place", () => {
  const body = { model: "m", messages: [] };
  const result = applyUpstreamStreamFlag(body, FORMATS.OPENAI, false);

  assert.equal(result, body, "same object the executor serializes");
  assert.equal(body.stream, false);
  assert.equal(applyUpstreamStreamFlag({}, FORMATS.OPENAI, true).stream, true);
});

test("applyUpstreamStreamFlag leaves non chat-completions bodies untouched", () => {
  const claude = { model: "m", messages: [] };
  assert.equal(applyUpstreamStreamFlag(claude, FORMATS.CLAUDE, true), claude);
  assert.equal("stream" in claude, false, "Claude/Responses translators own their stream flag");

  // Defensive: never throw on shapes the translator may hand back.
  assert.equal(applyUpstreamStreamFlag(null, FORMATS.OPENAI, true), null);
  assert.deepEqual(applyUpstreamStreamFlag([1, 2], FORMATS.OPENAI, true), [1, 2]);
});

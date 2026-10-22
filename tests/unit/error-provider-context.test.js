// DoD 5: an upstream failure must name the provider and model it came from.
//
// `formatProviderError` used to emit a bare "[500]: …", which reads like a bug in
// this gateway and makes two models in one combo indistinguishable. The tag was
// present in an earlier revision and got lost in the config-driven refactor.
//
// The function is used by every modality core (chat, image, embeddings, tts,
// systemone) and by both the fetch-failure and upstream-error branches of
// chatCore, so it is also the one place a double tag could appear — the fallback
// loops re-wrap an error a handler already formatted.
//
// Run: node --test tests/unit/error-provider-context.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { formatProviderError, withProviderContext, buildErrorBody } from "../../open-sse/utils/error.js";

test("an upstream failure names provider and model before the status", () => {
  const message = formatProviderError(new Error("empty response content"), "cline", "google/gemini-3-pro-image", 502);
  assert.equal(message, "[cline/google/gemini-3-pro-image] [502]: empty response content");
});

test("the low-level fetch cause is still appended", () => {
  const error = new Error("fetch failed");
  error.cause = { code: "UND_ERR_SOCKET" };
  assert.equal(
    formatProviderError(error, "cline", "m", 502),
    "[cline/m] [502]: fetch failed (cause: UND_ERR_SOCKET)",
  );
});

test("the tag is never applied twice, whichever half is already present", () => {
  // A handler formatted it, then a fallback loop re-wraps the same message.
  assert.equal(
    formatProviderError(new Error("[cline/m] [502]: boom"), "cline", "m", 502),
    "[cline/m] [502]: boom",
  );
  // Status prefix already present, provider context missing → only the context is added.
  assert.equal(
    formatProviderError(new Error("[502]: boom"), "cline", "m", 502),
    "[cline/m] [502]: boom",
  );
  // Provider context present, status missing → only the status is added.
  assert.equal(
    formatProviderError(new Error("[cline/m] boom"), "cline", "m", 502),
    "[cline/m] [502]: boom",
  );
});

test("a caller with no provider/model context still gets the status prefix", () => {
  assert.equal(formatProviderError(new Error("boom"), null, null, 500), "[500]: boom");
  assert.equal(formatProviderError(new Error("boom"), "cline", undefined, 500), "[500]: boom");
  assert.equal(withProviderContext("plain", null, "m"), "plain");
});

test("the code falls back to the error's own code, then FETCH_FAILED", () => {
  const withCode = new Error("boom");
  withCode.code = "ETIMEDOUT";
  assert.equal(formatProviderError(withCode, "cline", "m"), "[cline/m] [ETIMEDOUT]: boom");
  assert.equal(formatProviderError(new Error("boom"), "cline", "m"), "[cline/m] [FETCH_FAILED]: boom");
});

test("the client-facing body keeps the context and stays a server_error", () => {
  const body = buildErrorBody(502, formatProviderError(new Error("empty completion"), "cline", "google/gemini-3-pro-image", 502));
  assert.equal(body.error.type, "server_error");
  assert.match(body.error.message, /^\[cline\/google\/gemini-3-pro-image\] \[502\]: /);
});

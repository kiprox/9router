// Bug #2 (cline adapter): a model-side failure ("empty response content" from a
// cline image model on `stream:false`) matched no ERROR_RULES entry, so it fell
// through to the 30s transient cooldown. The account was locked per model and the
// next request answered 503 "all 1 accounts locked … (reset after 30s)" — hiding
// an upstream 500 behind a fabricated rate limit, on every following request.
//
// "empty response" is therefore a noFallback rule: another account would fail
// identically, so the caller must receive the real error and nothing may be
// locked. Rate-limit/quota wording must keep its exponential backoff.
//
// Run: node --test tests/unit/cline-empty-response-nofallback.test.js
// (this repo wires no test runner and ships no vitest, per AGENTS.md)
import test from "node:test";
import assert from "node:assert/strict";
import { checkFallbackError, applyErrorState } from "../../open-sse/services/accountFallback.js";
import { ERROR_RULES, TRANSIENT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";
import { buildErrorBody } from "../../open-sse/utils/error.js";

// The exact upstream body cline sends; parseUpstreamError keeps status 500 and
// forwards the raw text, which is what markAccountUnavailable classifies.
const CLINE_EMPTY = '{"error":"empty response content","success":false}';

test('"empty response" is classified as noFallback by rule, not by status', () => {
  const rule = ERROR_RULES.find((r) => r.text === "empty response");
  assert.ok(rule, "rule must exist in ERROR_RULES");
  assert.equal(rule.noFallback, true);

  for (const status of [500, 502, 503]) {
    assert.deepEqual(
      checkFallbackError(status, CLINE_EMPTY),
      { shouldFallback: false, cooldownMs: 0 },
      `status ${status} must not lock the account`,
    );
  }
  // Providers that wrap the message in a nested JSON string still match.
  assert.equal(
    checkFallbackError(500, JSON.stringify({ error: { message: "Upstream: empty response content" } })).shouldFallback,
    false,
  );
});

test("noFallback beats the transient default and any provider-specific rule", () => {
  // Same status without the text still gets the transient cooldown — the rule,
  // not the status code, is what makes this failure account-independent.
  const unmatched = checkFallbackError(500, "upstream exploded");
  assert.equal(unmatched.shouldFallback, true);
  assert.equal(unmatched.cooldownMs, TRANSIENT_COOLDOWN_MS);

  // A provider-scoped rule is skipped for other providers; ours still applies.
  assert.deepEqual(checkFallbackError(500, CLINE_EMPTY, 0, "cline"), { shouldFallback: false, cooldownMs: 0 });
  assert.deepEqual(checkFallbackError(500, CLINE_EMPTY, 0, "openai"), { shouldFallback: false, cooldownMs: 0 });
});

test("regression: rate-limit / quota wording keeps its exponential backoff", () => {
  for (const text of ["rate limit reached", "too many requests", "quota exceeded", "model overloaded"]) {
    const result = checkFallbackError(500, text, 0);
    assert.equal(result.shouldFallback, true, text);
    assert.ok(result.cooldownMs > 0, `${text} must cool the account down`);
    assert.ok(result.newBackoffLevel >= 1, `${text} must advance the backoff level`);
  }
  // 429 without wording stays account-scoped through the status rule.
  const rateLimited = checkFallbackError(429, "nope");
  assert.equal(rateLimited.shouldFallback, true);
  assert.ok(rateLimited.cooldownMs > 0);
});

test("applyErrorState records the error without cooling down a noFallback failure", () => {
  const account = { id: "c1", backoffLevel: 2 };

  const after = applyErrorState(account, 500, CLINE_EMPTY);
  assert.equal(after.rateLimitedUntil, null);
  assert.equal(after.backoffLevel, 2, "no backoff escalation for a model-side failure");
  assert.equal(after.status, "error");

  // Rate-limit failures still lock the account (consistent with the classifier).
  const cooled = applyErrorState(account, 429, "rate limit reached");
  assert.ok(cooled.rateLimitedUntil, "a real rate limit must still cool the account down");
  assert.ok(new Date(cooled.rateLimitedUntil).getTime() > Date.now());
  assert.ok(cooled.backoffLevel > 2);
});

test("client-facing body keeps the real 500 message (no 503 rewrite)", () => {
  const body = buildErrorBody(500, "[500]: " + CLINE_EMPTY);
  assert.equal(body.error.type, "server_error");
  assert.match(body.error.message, /empty response content/);
  assert.doesNotMatch(body.error.message, /reset after/);
});

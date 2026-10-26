/**
 * CodeBuddy 11128 channel-verification error surfacing (intl only).
 *
 * 11128 is an overloaded business code: the same number carries the channel
 * gate ("conversation id missing" — a missing X-Conversation-* header family)
 * and a body-shape fault ("first message is not system prompt"). Only the first
 * is a header problem, so classification must branch on the message.
 *
 * The raw envelope names no cause, so it used to surface as an opaque 400 the
 * operator could not act on. The message now names the header family and the
 * file that supplies it.
 *
 * Scoped to intl on purpose: only that gateway enforces the gate, so CN keeps
 * reporting the upstream text verbatim (see codebuddy-block-backoff.test.js —
 * CN stays request-scoped for both 11128 variants).
 *
 * The two variants must stay on opposite fallback paths:
 *  - channel verification → provider-scoped backoff (the gateway refuses every
 *    request for a while, so re-firing immediately is useless)
 *  - body shape           → request-scoped, cooldownMs 0 (a healthy credential
 *    must not be evicted for one malformed request)
 */

import { describe, expect, it } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const executor = new CodeBuddyIntlExecutor();

const channelBody = JSON.stringify({
  code: 11128,
  msg: "conversation id missing",
  displayTips: { en: "Please use the official client." },
});

const bodyShapeBody = JSON.stringify({
  code: 11128,
  msg: "first message is not system prompt",
});

function response(body, status = 400) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

describe("codebuddy-intl 11128 channel verification", () => {
  it("names the missing header family instead of echoing the raw envelope", async () => {
    const parsed = await executor.parseError(response(channelBody), channelBody);
    expect(parsed.status).toBe(400);
    expect(parsed.message).toMatch(/X-Conversation-\*/);
    expect(parsed.message).toMatch(/codebuddyHeaders\.js/);
    expect(parsed.message).toMatch(/11128/);
  });

  it("passes the upstream tip through when present", async () => {
    const parsed = await executor.parseError(response(channelBody), channelBody);
    expect(parsed.message).toContain("Please use the official client.");
  });

  it("omits the tip clause when upstream gives none", async () => {
    const bare = JSON.stringify({ code: 11128, msg: "conversation id missing" });
    const parsed = await executor.parseError(response(bare), bare);
    expect(parsed.message).not.toContain("Upstream said:");
  });

  it("keeps the provider-scoped backoff after the message is rewritten", () => {
    // The rewritten message still carries "conversation id missing", so the
    // provider-scoped rule matches — the rewrite must not defeat classification.
    const result = checkFallbackError(400, "conversation id missing", 0, "codebuddy-intl");
    expect(result.shouldFallback).toBe(true);
    expect(result.newBackoffLevel).toBe(1);
    expect(result.requestScoped).toBeUndefined();
  });
});

describe("codebuddy-intl 11128 body-shape variant", () => {
  it("stays request-scoped so a healthy credential is not evicted", async () => {
    const parsed = await executor.parseError(response(bodyShapeBody), bodyShapeBody);
    const result = checkFallbackError(parsed.status, parsed.message, 0, "codebuddy-intl");
    expect(result.requestScoped).toBe(true);
    expect(result.cooldownMs).toBe(0);
    expect(result.shouldFallback).toBe(false);
  });

  it("is not rewritten into the channel-verification message", async () => {
    const parsed = await executor.parseError(response(bodyShapeBody), bodyShapeBody);
    expect(parsed.message).not.toMatch(/X-Conversation-\*/);
  });
});

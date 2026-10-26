// CodeBuddy 403 code 11140 "Your account has been restricted due to unusual
// activity" is an ACCOUNT verdict, not a bad request. It must not be handled by
// the provider's generic "request illegal" backoff rule (2s, then 4s, 8s…),
// which re-probes a restricted account every few seconds.
import { describe, expect, it } from "vitest";

import {
  ERROR_RULES,
  ACCOUNT_RESTRICTED_COOLDOWN_MS,
  BACKOFF_CONFIG,
} from "../../open-sse/config/errorConfig.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";

const restrictedBody = JSON.stringify({
  code: 11140,
  msg: "request illegal",
  requestId: "5061b15308f84f189287db0fd9b3be1d",
  displayMsg: { en: "Your account has been restricted due to unusual activity" },
});

function response(body, status = 403) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const executors = [
  ["codebuddy-intl", new CodeBuddyIntlExecutor()],
  ["codebuddy-cn", new CodeBuddyExecutor()],
];

describe("CodeBuddy 11140 account restriction", () => {
  it.each(executors)("%s reports a restriction as 403 with the human message", async (provider, executor) => {
    const parsed = await executor.parseError(response(restrictedBody), restrictedBody);
    expect(parsed.status).toBe(403);
    expect(parsed.message).toMatch(/restricted/i);
  });

  it.each(executors)("%s still parses 6004 as a frequency limit", async (_provider, executor) => {
    const body = JSON.stringify({ code: 6004, msg: "超出频率限制" });
    const parsed = await executor.parseError(response(body, 400), body);
    expect(parsed.status).toBe(429);
  });

  it.each(executors)("%s still treats a plain 11128 as channel verification, not a restriction", async (_provider, executor) => {
    const body = JSON.stringify({ code: 11128, msg: "request illegal" });
    const parsed = await executor.parseError(response(body, 400), body);
    expect(parsed?.status).not.toBe(403);
  });

  it("classifies the restriction with a long cooldown instead of the backoff ladder", () => {
    const result = checkFallbackError(
      403,
      "Your account has been restricted due to unusual activity",
      0,
      "codebuddy-intl",
    );
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(ACCOUNT_RESTRICTED_COOLDOWN_MS);
    // Not the 2s rate-limit ladder that would re-probe the flagged account.
    expect(result.cooldownMs).toBeGreaterThan(BACKOFF_CONFIG.max);
    expect(result.newBackoffLevel).toBeUndefined();
  });

  it("does not escalate into a shorter cooldown at higher backoff levels", () => {
    const lvl5 = checkFallbackError(403, "account has been restricted", 5, "codebuddy-intl");
    expect(lvl5.cooldownMs).toBe(ACCOUNT_RESTRICTED_COOLDOWN_MS);
  });

  it("keeps the restriction rule above the generic 'request illegal' rule", () => {
    const order = ERROR_RULES.map((r) => r.text || "").filter(Boolean);
    const restriction = order.findIndex((t) => t.includes("account has been restricted"));
    const illegal = order.findIndex((t) => t === "request illegal");
    expect(restriction).toBeGreaterThanOrEqual(0);
    expect(illegal).toBeGreaterThanOrEqual(0);
    expect(restriction).toBeLessThan(illegal);
  });

  it("does not hijack 11128 channel-verification failures", () => {
    // 11128 has no restriction wording, so it keeps the short backoff.
    const result = checkFallbackError(400, "request illegal", 0, "codebuddy-intl");
    expect(result.cooldownMs).toBe(BACKOFF_CONFIG.base);
    expect(result.newBackoffLevel).toBe(1);
  });
});
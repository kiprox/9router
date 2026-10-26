/**
 * CodeBuddy token refresh — parity with Codex/Kiro.
 *
 * Before this, CodeBuddy executors inherited DefaultExecutor's refresher map,
 * which has no CodeBuddy entry: a 401/403 could never be recovered, and the
 * OAuth response does not carry expires_in, so proactive refresh was guessing
 * (24h) or never firing at all.
 *
 * Covered here:
 *  - executor.refreshCredentials() hits the plugin refresh endpoint with the
 *    refresh token in the X-Refresh-Token header (CN + intl)
 *  - expiresIn is derived from the refreshed JWT `exp` when the API omits it
 *  - mapTokens derives the initial lifetime from the access-token JWT
 *  - needsRefresh() honours the stored expiry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { refreshCodebuddyToken } from "../../open-sse/services/tokenRefresh.js";
import codebuddyCn from "../../src/lib/oauth/providers/codebuddy-cn.js";
import codebuddyIntl from "../../src/lib/oauth/providers/codebuddy-intl.js";

/** Build an unsigned JWT whose payload says it expires `expiresInSec` from now. */
function makeJwt(expiresInSec, claims = {}) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const payload = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
  };
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CodeBuddy executor refreshCredentials", () => {
  it("refreshes codebuddy-cn via the plugin refresh endpoint (X-Refresh-Token header)", async () => {
    const accessToken = makeJwt(3600);
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          code: 0,
          data: { accessToken, refreshToken: "rt-new-cn" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const executor = new CodeBuddyExecutor();
    const result = await executor.refreshCredentials({ refreshToken: "rt-old-cn" }, {});

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://copilot.tencent.com/v2/plugin/auth/token/refresh");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["X-Refresh-Token"]).toBe("rt-old-cn");
    expect(calls[0].init.headers["X-Auth-Refresh-Source"]).toBe("plugin");

    expect(result.accessToken).toBe(accessToken);
    expect(result.refreshToken).toBe("rt-new-cn");
    // Server omitted expiresIn — derived from the JWT exp (~1h), not the 24h guess.
    expect(result.expiresIn).toBeGreaterThan(3500);
    expect(result.expiresIn).toBeLessThanOrEqual(3600);
  });

  it("refreshes codebuddy-intl against the .ai domain", async () => {
    const accessToken = makeJwt(7200);
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ code: 0, data: { accessToken } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const executor = new CodeBuddyIntlExecutor();
    const result = await executor.refreshCredentials({ refreshToken: "rt-old-intl" }, {});

    expect(calls[0].url).toBe("https://www.codebuddy.ai/v2/plugin/auth/token/refresh");
    expect(calls[0].init.headers["X-Domain"]).toBe("www.codebuddy.ai");
    expect(result.accessToken).toBe(accessToken);
    // No new refresh token in the response — the old one is kept.
    expect(result.refreshToken).toBe("rt-old-intl");
    expect(result.expiresIn).toBeGreaterThan(7100);
  });

  it("returns null when the connection has no refresh token", async () => {
    globalThis.fetch = vi.fn();
    const executor = new CodeBuddyExecutor();
    await expect(executor.refreshCredentials({ accessToken: "a" }, {})).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns null when the gateway answers code !== 0", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: 40132, msg: "refresh token expired" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(refreshCodebuddyToken("rt-bad", {})).resolves.toBeNull();
  });
});

describe("CodeBuddy needsRefresh", () => {
  it("is false without a stored expiry and true inside the refresh lead window", () => {
    const executor = new CodeBuddyExecutor();
    expect(executor.needsRefresh({ refreshToken: "rt" })).toBe(false);
    expect(
      executor.needsRefresh({ refreshToken: "rt", expiresAt: new Date(Date.now() - 1000).toISOString() })
    ).toBe(true);
  });
});

describe("CodeBuddy mapTokens expiry", () => {
  it("derives expiresIn from the access-token JWT instead of a fixed 24h", () => {
    const token = makeJwt(60 * 60 * 24 * 30); // 30 days
    for (const provider of [codebuddyCn, codebuddyIntl]) {
      const mapped = provider.mapTokens({
        access_token: token,
        refresh_token: "rt",
      });
      expect(mapped.accessToken).toBe(token);
      expect(mapped.expiresIn).toBeGreaterThan(60 * 60 * 24 * 29);
    }
  });

  it("prefers the server-provided expires_in and falls back to 24h for opaque tokens", () => {
    expect(codebuddyCn.mapTokens({ access_token: "opaque", expires_in: 120 }).expiresIn).toBe(120);
    expect(codebuddyCn.mapTokens({ access_token: "opaque" }).expiresIn).toBe(86400);
  });
});

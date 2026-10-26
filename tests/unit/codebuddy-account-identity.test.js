/**
 * CodeBuddy account identity + tokenType persistence.
 *
 * The polling endpoint returns only { accessToken, refreshToken, tokenType }
 * — no userinfo call exists on that path — so the access-token JWT is the sole
 * identity source at login time. Two consequences when it was ignored:
 *
 *  - `createProviderConnection` dedups OAuth rows by email, so an empty email
 *    made every re-login append a new "Account N" row instead of rotating the
 *    tokens of the existing one.
 *  - `tokenType` from the grant was dropped, so the stored row never carried it
 *    (and a refresh could not preserve it either).
 *
 * Covered here:
 *  - extractCodeBuddyAccountInfo reads email / nickname / sub from the JWT
 *  - `sub` is never used as an email (it is a user id, not an address)
 *  - a synthetic stable email is derived when the JWT has no address
 *  - tokenType is persisted from the grant and survives a refresh
 *  - accessToken stays the raw JWT (no "Bearer " prefix)
 */

import { describe, it, expect } from "vitest";
import { extractCodeBuddyAccountInfo } from "../../src/lib/oauth/providerHelpers.js";
import codebuddyCn from "../../src/lib/oauth/providers/codebuddy-cn.js";
import codebuddyIntl from "../../src/lib/oauth/providers/codebuddy-intl.js";
import { mergeRefreshedCredentials } from "../../open-sse/services/oauthCredentialManager.js";

/** Build an unsigned JWT carrying `claims` plus a 1h `exp`. */
function makeJwt(claims = {}) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  })}.sig`;
}

describe("extractCodeBuddyAccountInfo", () => {
  it("reads the email claim from an intl token", () => {
    const info = extractCodeBuddyAccountInfo(
      makeJwt({ sub: "uid-42", email: "dev@example.com", iss: "https://www.codebuddy.ai" })
    );
    expect(info.email).toBe("dev@example.com");
    expect(info.userId).toBe("uid-42");
  });

  it("falls back to nickname for the CN phone-only account shape", () => {
    const info = extractCodeBuddyAccountInfo(makeJwt({ sub: "13800138000", nickname: "13800138000" }));
    expect(info.displayName).toBe("13800138000");
    expect(info.userId).toBe("13800138000");
    // A phone number is a display name, never an email.
    expect(info.email).toBeUndefined();
  });

  it("accepts preferred_username only when it looks like an address", () => {
    expect(extractCodeBuddyAccountInfo(makeJwt({ preferred_username: "a@b.c" })).email).toBe("a@b.c");
    const handle = extractCodeBuddyAccountInfo(makeJwt({ preferred_username: "coolhandle" }));
    expect(handle.email).toBeUndefined();
    expect(handle.displayName).toBe("coolhandle");
  });

  it("returns an empty object for a non-JWT (opaque) token", () => {
    expect(extractCodeBuddyAccountInfo("ck_opaque")).toEqual({});
    expect(extractCodeBuddyAccountInfo(undefined)).toEqual({});
  });
});

describe.each([
  ["codebuddy-intl", codebuddyIntl],
  ["codebuddy-cn", codebuddyCn],
])("%s mapTokens identity", (_id, provider) => {
  it("persists the JWT email so createProviderConnection can dedup", () => {
    const token = makeJwt({ sub: "uid-7", email: "user@corp.io" });
    const mapped = provider.mapTokens({ access_token: token, refresh_token: "rt" });
    expect(mapped.email).toBe("user@corp.io");
    expect(mapped.providerSpecificData.userId).toBe("uid-7");
  });

  it("derives a stable synthetic email when the JWT has no address", () => {
    const token = makeJwt({ sub: "uid-7" });
    const mapped = provider.mapTokens({ access_token: token, refresh_token: "rt" });
    // Stable across re-logins → the row is updated instead of duplicated.
    expect(mapped.email).toBe("codebuddy-user-uid-7");
    expect(provider.mapTokens({ access_token: token }).email).toBe(mapped.email);
  });

  it("never stores the raw sub claim as an email", () => {
    const mapped = provider.mapTokens({ access_token: makeJwt({ sub: "uid-7" }) });
    expect(mapped.email).not.toBe("uid-7");
  });

  it("omits identity fields for an opaque token instead of storing blanks", () => {
    const mapped = provider.mapTokens({ access_token: "ck_opaque", refresh_token: "rt" });
    expect(mapped.email).toBeUndefined();
    expect(mapped.displayName).toBeUndefined();
    expect(mapped.providerSpecificData).toBeUndefined();
  });
});

describe.each([
  ["codebuddy-intl", codebuddyIntl],
  ["codebuddy-cn", codebuddyCn],
])("%s mapTokens tokenType", (_id, provider) => {
  it("persists the upstream token type", () => {
    expect(provider.mapTokens({ access_token: "t", token_type: "MAC" }).tokenType).toBe("MAC");
  });

  it("defaults to Bearer when the grant omits it", () => {
    expect(provider.mapTokens({ access_token: "t" }).tokenType).toBe("Bearer");
  });

  it("keeps accessToken raw (the executor adds the single Bearer prefix)", () => {
    const token = makeJwt({ sub: "uid-1" });
    const mapped = provider.mapTokens({ access_token: token });
    expect(mapped.accessToken).toBe(token);
    expect(mapped.accessToken).not.toMatch(/^Bearer /i);
  });
});

describe("mergeRefreshedCredentials tokenType", () => {
  it("carries a refreshed token type onto the stored credential", () => {
    const merged = mergeRefreshedCredentials(
      "codebuddy-intl",
      { accessToken: "old", refreshToken: "rt", tokenType: "Bearer" },
      { accessToken: "new", expiresIn: 3600, tokenType: "MAC" }
    );
    expect(merged.tokenType).toBe("MAC");
  });

  it("omits tokenType from the patch when the refresher does not report one", () => {
    // The patch is applied as a partial update, so an absent key leaves the
    // stored value untouched instead of clobbering it with undefined.
    const merged = mergeRefreshedCredentials(
      "codebuddy-intl",
      { accessToken: "old", refreshToken: "rt", tokenType: "MAC" },
      { accessToken: "new", expiresIn: 3600 }
    );
    expect(merged).not.toHaveProperty("tokenType");
  });
});

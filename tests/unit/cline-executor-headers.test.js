// Regression: cline/clinepass requests 401'd with
// {"error":"Unauthorized: Please make sure you're using the latest version of
// Cline and re-authenticate your Cline account."}
//
// The `clineHeaders` hook used to build the full Authorization header
// (`Bearer workos:<jwt>`), but hooks run BEFORE applyAuth, which then overwrote
// it with the raw stored credential (`Bearer <jwt>`). Cline rejects a bare WorkOS
// JWT — the `workos:` prefix is mandatory — so every OAuth request 401'd.
//
// These tests pin the executor output, not just the helper: the helper was
// already correct, which is why the unit tests on it passed while requests failed.

import { describe, it, expect } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig";

function authFor(provider, credentials) {
  return new DefaultExecutor(provider)
    .buildHeaders(credentials, true, "https://api.cline.bot", "cline-pass/glm-5.3", {})
    .Authorization;
}

describe.each(["cline", "clinepass"])("%s executor auth headers", (provider) => {
  it("sends an OAuth access token as Bearer workos:<jwt>", () => {
    expect(authFor(provider, { accessToken: JWT })).toBe(`Bearer workos:${JWT}`);
  });

  it("does not double-prefix an already prefixed token", () => {
    expect(authFor(provider, { accessToken: `workos:${JWT}` })).toBe(`Bearer workos:${JWT}`);
  });

  it("sends ClinePass API keys verbatim (no workos: prefix)", () => {
    expect(authFor(provider, { apiKey: "clp_abc123" })).toBe("Bearer clp_abc123");
  });

  it("prefers the API key when a connection carries both", () => {
    expect(authFor(provider, { apiKey: "clp_abc123", accessToken: JWT })).toBe("Bearer clp_abc123");
  });

  it("carries the client fingerprint headers", () => {
    const headers = new DefaultExecutor(provider)
      .buildHeaders({ accessToken: JWT }, true, "https://api.cline.bot", "cline-pass/glm-5.3", {});
    expect(headers["X-CLIENT-TYPE"]).toBe("9router");
    expect(headers["HTTP-Referer"]).toBe("https://cline.bot");
    expect(headers["X-Title"]).toBe("Cline");
  });
});

describe("cline token normalizer scoping", () => {
  it("leaves other providers untouched", () => {
    // A provider whose token happens to look like a JWT must not gain `workos:`.
    const headers = new DefaultExecutor("openai")
      .buildHeaders({ apiKey: JWT }, true, "https://api.openai.com/v1", "gpt-5.4", {});
    expect(headers.Authorization).toBe(`Bearer ${JWT}`);
  });
});

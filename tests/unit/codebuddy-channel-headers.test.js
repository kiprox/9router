// CodeBuddy channel verification (code 11128 "request illegal"): the gateway
// cross-checks X-IDE-Version against the User-Agent and expects a conversation
// id that is stable across the turns of one session. Both used to be wrong, so
// legitimate requests were rejected as if they came from an abusive client.
import { describe, expect, it } from "vitest";
import { buildCodeBuddyHeaders } from "../../open-sse/executors/codebuddyHeaders.js";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

const UA_CN = "CLI/2.108.1 CodeBuddy/2.108.1";
const UA_INTL = "IDE/2.108.1 CodeBuddy/2.108.1";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const build = (overrides = {}) =>
  buildCodeBuddyHeaders({
    domain: "copilot.tencent.com",
    credentials: { connectionId: "conn-1" },
    body: { messages: [{ role: "user", content: "hi" }] },
    headers: { "User-Agent": UA_CN },
    ...overrides,
  });

describe("CodeBuddy headers: X-IDE-Version", () => {
  it("mirrors the version in the User-Agent", () => {
    expect(build()["X-IDE-Version"]).toBe("2.108.1");
  });

  it("tracks the UA instead of a stale hardcoded version", () => {
    const headers = build({ headers: { "User-Agent": "IDE/2.99.7 CodeBuddy/2.99.7" } });
    expect(headers["X-IDE-Version"]).toBe("2.99.7");
  });

  it("omits the header when no UA is available rather than guessing", () => {
    expect(build({ headers: {} })["X-IDE-Version"]).toBeUndefined();
  });
});

describe("CodeBuddy headers: conversation affinity", () => {
  it("keeps one conversation id across the turns of a session", () => {
    expect(build()["X-Conversation-ID"]).toBe(build()["X-Conversation-ID"]);
  });

  it("gives different sessions different ids", () => {
    const a = build({ credentials: { connectionId: "conn-1" } });
    const b = build({ credentials: { connectionId: "conn-2" } });
    expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
  });

  it("prefers the caller's own conversation id", () => {
    const headers = build({
      credentials: { connectionId: "conn-1", rawHeaders: { "x-conversation-id": "client-conv" } },
    });
    expect(headers["X-Conversation-ID"]).toBe("client-conv");
  });

  it("prefers body.conversation_id over the derived id", () => {
    const headers = build({ body: { conversation_id: "body-conv", messages: [] } });
    expect(headers["X-Conversation-ID"]).toBe("body-conv");
  });

  it("mints a UUID-shaped id", () => {
    expect(build()["X-Conversation-ID"]).toMatch(UUID_RE);
  });

  it("still mints a fresh per-request id for the request/message headers", () => {
    const a = build();
    const b = build();
    expect(a["X-Request-ID"]).not.toBe(b["X-Request-ID"]);
    expect(a["X-Conversation-Request-ID"]).not.toBe(b["X-Conversation-Request-ID"]);
  });
});

describe("CodeBuddy executors wire the UA into the version header", () => {
  it.each([
    ["CN", new CodeBuddyExecutor(), UA_CN],
    ["Intl", new CodeBuddyIntlExecutor(), UA_INTL],
  ])("%s sends an X-IDE-Version matching its own registry UA", (_label, executor, ua) => {
    const headers = executor.buildHeaders({ accessToken: "ck_test", connectionId: "conn-1" }, true, "https://example.test", "glm-5.2", { messages: [] });
    expect(headers["User-Agent"]).toBe(ua);
    expect(headers["X-IDE-Version"]).toBe("2.108.1");
  });
});

describe("CodeBuddy headers: caller header spelling", () => {
  // HTTP header names are case-insensitive. An exact-key lookup missed every
  // spelling but two, so the caller's conversation affinity was replaced by a
  // derived id — a new conversation every turn, and a cold prompt cache.
  it.each([
    "x-conversation-id",
    "X-Conversation-ID",
    "X-Conversation-Id",
    "x-Conversation-ID",
    "X-CONVERSATION-ID",
  ])("keeps the caller's id when sent as %s", (name) => {
    const headers = build({ credentials: { connectionId: "conn-1", rawHeaders: { [name]: "client-conv" } } });
    expect(headers["X-Conversation-ID"]).toBe("client-conv");
  });

  it.each(["   ", "", "\t\n"])("treats a blank caller id (%j) as absent", (blank) => {
    const headers = build({ credentials: { connectionId: "conn-1", rawHeaders: { "x-conversation-id": blank } } });
    // Falls back to the derived id rather than forwarding whitespace upstream.
    expect(headers["X-Conversation-ID"]).not.toBe(blank);
    expect(headers["X-Conversation-ID"]).toMatch(UUID_RE);
  });

  it("reads the UA case-insensitively too", () => {
    const headers = buildCodeBuddyHeaders({
      domain: "www.codebuddy.ai",
      credentials: { connectionId: "conn-1" },
      body: { messages: [] },
      headers: { "user-agent": "IDE/3.4.5 CodeBuddy/3.4.5" },
    });
    expect(headers["X-IDE-Version"]).toBe("3.4.5");
  });
});

describe("CodeBuddy headers: derived conversation id shape", () => {
  // The id is a UUID per RFC 4122, so the version nibble must be 5 and the
  // variant nibble one of 8/9/a/b. Slicing 32 raw hash chars left both random.
  it("sets the RFC-4122 v5 version nibble", () => {
    for (let i = 0; i < 50; i++) {
      const id = build({ credentials: { connectionId: `conn-${i}` } })["X-Conversation-ID"];
      expect(id[14]).toBe("5");
    }
  });

  it("sets the RFC-4122 variant nibble", () => {
    for (let i = 0; i < 50; i++) {
      const id = build({ credentials: { connectionId: `conn-${i}` } })["X-Conversation-ID"];
      expect("89ab").toContain(id[19]);
    }
  });

  it("stays deterministic for the same session", () => {
    const first = build({ credentials: { connectionId: "stable" } })["X-Conversation-ID"];
    const second = build({ credentials: { connectionId: "stable" } })["X-Conversation-ID"];
    expect(first).toBe(second);
  });
});

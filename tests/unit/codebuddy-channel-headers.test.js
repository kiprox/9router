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
    expect(build()["X-Conversation-ID"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
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

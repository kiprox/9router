// A caller that sends `stream:false` must get a JSON completion back — even when
// the provider only answers SSE (registry `forceStream`, e.g. codebuddy / codex /
// opencode). chatCore keeps those two decisions apart: `clientStreams` is what the
// caller asked for, `stream` is what the upstream needs, and the gap between them
// is bridged by handleForcedSSEToJson(). When forceStream was folded into
// `clientStreams`, that bridge never ran, so the caller received a raw SSE body.
// A fusion panel hit exactly that: `.json()` on `data: {...}` threw
// `Unexpected token 'd'` and the panel answer was dropped.
import { describe, expect, it, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
  pipeWithDisconnect: vi.fn((response) => response.body),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: vi.fn(), proxyAwareFetch: vi.fn() }));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
  anchorClaudeCache: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));
vi.mock("../../open-sse/rtk/pxpipe.js", () => ({
  compressWithPxpipe: vi.fn(async () => ({ body: null, summary: null })),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
  saveUsageStats: vi.fn(),
  formatDoneLine: vi.fn(() => ""),
  extractUsageFromResponse: vi.fn(() => ({})),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveUsageStats: vi.fn(),
}));

const SSE_BODY = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"glm-5.2","choices":[{"index":0,"delta":{"content":"panel answer"}}]}',
  "",
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"glm-5.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  "",
].join("\n");

function options(body) {
  return {
    body,
    modelInfo: { provider: "codebuddy-cn", model: "glm-5.2" },
    credentials: { accessToken: "ck_test", connectionId: "test-connection" },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: "application/json" },
    },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("JSON client behind a forceStream provider", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it("streams upstream but returns a JSON completion to the caller", async () => {
    executeMock.mockResolvedValue({
      response: new Response(SSE_BODY, { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: "https://copilot.tencent.com/v2/chat/completions",
      headers: {},
      transformedBody: {},
    });

    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const result = await handleChatCore(options({
      model: "codebuddy-cn/glm-5.2",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }));

    // The upstream request must still be the streaming variant.
    expect(executeMock.mock.calls[0][0].body.stream).toBe(true);

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("application/json");
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("panel answer");
    expect(json.choices[0].finish_reason).toBe("stop");
  }, 20000);

  it("keeps SSE for a caller that asked for it", async () => {
    executeMock.mockResolvedValue({
      response: new Response(SSE_BODY, { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: "https://copilot.tencent.com/v2/chat/completions",
      headers: {},
      transformedBody: {},
    });

    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const result = await handleChatCore(options({
      model: "codebuddy-cn/glm-5.2",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
  }, 20000);
});
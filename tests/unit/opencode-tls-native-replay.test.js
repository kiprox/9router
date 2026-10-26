// The free-tier adapter must not turn a missing optional dependency into a
// hard provider error: `OpenCodeExecutor` documents that path as fail-open, and
// `proxyAwareFetch` delegates the direct path to the adapter. Replaying on
// native fetch is the only way to honour that, but the replay goes through the
// *patched* global fetch, so it must not re-enter the adapter.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";

const { loadRuntimeDepMock } = vi.hoisted(() => ({ loadRuntimeDepMock: vi.fn() }));

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: loadRuntimeDepMock,
}));

// Import the real proxyFetch so globalThis.fetch is the patched wrapper, which
// is what production has in place when the executor runs.
await import("../../open-sse/utils/proxyFetch.js");

describe("opencodeTlsFetch native replay", () => {
  let server;
  let baseUrl;
  let hits;

  beforeEach(async () => {
    hits = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        hits.push({ method: req.method, url: req.url, body, headers: req.headers });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("native-ok");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    vi.resetModules();
    loadRuntimeDepMock.mockReset();
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("replays the request exactly once when wreq-js is missing", async () => {
    loadRuntimeDepMock.mockRejectedValue(new Error("MODULE_NOT_FOUND"));
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");

    const res = await opencodeTlsFetch(`${baseUrl}/inference/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-probe": "1" },
      body: '{"model":"oc/test"}',
    });

    // A stack-overflowing replay would never reach here; a recursing one would
    // record many hits instead of one.
    expect(await res.text()).toBe("native-ok");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: "POST", url: "/inference/v1/chat/completions", body: '{"model":"oc/test"}' });
    expect(hits[0].headers["x-probe"]).toBe("1");
  });

  it("forwards the abort signal to the replay", async () => {
    loadRuntimeDepMock.mockRejectedValue(new Error("MODULE_NOT_FOUND"));
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");

    const controller = new AbortController();
    controller.abort();
    await expect(
      opencodeTlsFetch(`${baseUrl}/x`, { method: "POST", body: "{}" }, { signal: controller.signal })
    ).rejects.toThrow();
    expect(hits).toHaveLength(0);
  });
});

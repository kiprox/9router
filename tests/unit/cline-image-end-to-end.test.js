// Bug #5 (cline adapter), end to end through the real core handler.
//
// `handleImageGenerationCore` is the function behind `/v1/images/generations`.
// Before the adapter, cline hit its provider guard and answered
// `400 Provider 'cline' does not support image generation`. These tests drive
// the whole seam — adapter selection, request build, upstream call, image
// extraction, OpenAI Images response — with a faked upstream, so the guard can
// never come back unnoticed and a failure can never turn into a fake 200.
//
// The upstream fake sits on `proxyAwareFetch.__setTestFetch`: the adapter posts
// through the real DefaultExecutor, which captured `globalThis.fetch` at module
// load, so replacing the global after import would not reach it. That seam is
// only consulted on the direct path, hence the cleared proxy environment.
//
// Run: node --test --import ./tests/unit/.support/cline-image-loader.mjs \
//        tests/unit/cline-image-end-to-end.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { PROVIDER_MEDIA } from "../../open-sse/providers/index.js";

const DEFAULT_MODEL = PROVIDER_MEDIA.cline?.imageConfig?.chatModel;

let proxyFetchModule = null;
const savedEnv = {};

test.before(async () => {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  proxyFetchModule = await import("../../open-sse/utils/proxyFetch.js");
});

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
});

test.beforeEach(() => {
  proxyFetchModule.__clearTestFetch();
});

test.afterEach(() => {
  proxyFetchModule.__clearTestFetch();
});

function fakeUpstream(handler) {
  const calls = [];
  proxyFetchModule.__setTestFetch(async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    return handler({ url: String(url), body: options.body ? JSON.parse(options.body) : null }, calls.length);
  });
  return calls;
}

function sseImageResponse(b64) {
  const chunk = {
    id: "chatcmpl-1",
    choices: [{ index: 0, delta: { images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }] } }],
  };
  const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function generate(body, model = DEFAULT_MODEL) {
  return handleImageGenerationCore({
    body,
    modelInfo: { provider: "cline", model },
    credentials: { accessToken: "eyJhbGciOi.abc.def" },
    log: null,
  });
}

test("cline no longer answers 'does not support image generation'", async () => {
  fakeUpstream(() => sseImageResponse("QUJD"));

  const result = await generate({ prompt: "a lighthouse" });

  assert.equal(result.success, true);
  assert.doesNotMatch(result.error || "", /does not support image generation/);
});

test("the generated picture reaches the client as data[].b64_json", async () => {
  fakeUpstream(() => sseImageResponse("QUJD"));

  const result = await generate({ prompt: "a lighthouse" });
  const payload = await result.response.json();

  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0].b64_json, "QUJD");
  assert.equal(typeof payload.created, "number");
  assert.match(result.response.headers.get("content-type"), /application\/json/);
});

test("the Images API request becomes one chat completion on the configured model", async () => {
  const calls = fakeUpstream(() => sseImageResponse("QUJD"));

  await generate({ prompt: "a lighthouse", n: 1, size: "1024x1024" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.cline.bot/api/v1/chat/completions");
  assert.equal(calls[0].body.model, DEFAULT_MODEL);
  assert.equal("stream" in calls[0].body, false, "no stream key: the JSON body is the one that carries the picture");
  assert.deepEqual(calls[0].body.messages, [
    { role: "user", content: [{ type: "text", text: "a lighthouse" }] },
  ]);
});

test("an upstream failure stays a failure and keeps its message", async () => {
  fakeUpstream(() => new Response(
    JSON.stringify({ error: "empty response content", success: false }),
    { status: 500, headers: { "content-type": "application/json" } },
  ));

  const result = await generate({ prompt: "a lighthouse" });

  // imageGenerationCore reports adapter/executor failures as 502 by design
  // (formatProviderError); what must never happen is a fabricated 200.
  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.match(result.error, /empty response content/);
  const body = await result.response.json();
  assert.match(body.error.message, /empty response content/);
});

test("a completion without images is an error, not an empty 200", async () => {
  fakeUpstream(() => new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "no picture" } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ));

  const result = await generate({ prompt: "a lighthouse" });

  assert.equal(result.success, false);
  assert.notEqual(result.status, 200);
  assert.match(result.error, /no images/);
});

test("binaryOutput decodes the first returned image into raw bytes", async () => {
  fakeUpstream(() => sseImageResponse("QUJD"));

  const result = await handleImageGenerationCore({
    body: { prompt: "a lighthouse" },
    modelInfo: { provider: "cline", model: DEFAULT_MODEL },
    credentials: { accessToken: "eyJhbGciOi.abc.def" },
    binaryOutput: true,
    log: null,
  });

  assert.equal(result.success, true);
  const bytes = Buffer.from(await result.response.arrayBuffer());
  assert.equal(bytes.toString("utf8"), "ABC");
});

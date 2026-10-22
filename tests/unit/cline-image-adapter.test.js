// Bug #5 (cline adapter): `/v1/images/generations` answered
// `Provider 'cline' does not support image generation` (400) because
// handlers/imageProviders/ had no cline adapter. Cline has no images endpoint —
// its image models are chat models that return the picture in
// `choices[].message.images[]` and only answer the streaming variant — so the
// adapter has to translate in both directions and must never fake a success.
//
// Covered here:
//   - request → chat body: model resolution (prefix, image model, fallback to
//     imageConfig.chatModel), prompt part, explicit stream for image models, `n`
//   - response `message.images[]` → `data[].b64_json`, including the
//     two-identical-pixels case (one entry, never two)
//   - response_format default / "url"
//   - upstream errors stay errors (status + message, no empty 200)
//
// Stubbing the upstream: the adapter posts through the real DefaultExecutor →
// `proxyAwareFetch`, which captures `globalThis.fetch` at module load. Replacing
// the global after import cannot reach it, so the tests use its `__setTestFetch`
// seam. That seam is only consulted on the direct fetch path (a configured
// proxy or the MITM DNS bypass fetches around it), so the tests run with a
// cleared proxy environment — the same clean shape a self-hosted gateway has.
//
// Run: node --test --import ./tests/unit/.support/cline-image-loader.mjs \
//        tests/unit/cline-image-adapter.test.js
// (the loader maps the jsconfig `@/…` alias, stubs usageDb, and stubs `@/lib/db`
//  so importing the real DefaultExecutor never opens the local database)
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import clineAdapter, { clineErrorStatus } from "../../open-sse/handlers/imageProviders/cline.js";
import { getImageAdapter, isImageProvider } from "../../open-sse/handlers/imageProviders/index.js";
import { PROVIDERS, PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import clineRegistry from "../../open-sse/providers/registry/cline.js";

const IMG_CFG = PROVIDER_MEDIA.cline?.imageConfig || {};
const DEFAULT_MODEL = IMG_CFG.chatModel;
const CHAT_URL = PROVIDERS.cline?.baseUrl;

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"];
const savedEnv = {};

let proxyFetchModule = null;

const loadProxyFetch = async () => {
  proxyFetchModule ||= await import("../../open-sse/utils/proxyFetch.js");
  return proxyFetchModule;
};

test.before(async () => {
  for (const key of PROXY_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  await loadProxyFetch();
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

// ── PNG fixtures (same encoder shape as image-dedupe.test.js) ───────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// 8-bit RGB PNG from raw rows. `filterTypes`/`text` let two files carry the same
// pixels in different bytes — exactly the duplicate cline image models emit.
function encodePng({ rows, filterTypes = [], text = null }) {
  const height = rows.length;
  const width = rows[0].length / 3;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB

  const raw = [];
  rows.forEach((row, y) => {
    const filter = filterTypes[y] ?? 0;
    const filtered = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) {
      const a = i >= 3 ? row[i - 3] : 0;
      const b = y > 0 ? rows[y - 1][i] : 0;
      const c = y > 0 && i >= 3 ? rows[y - 1][i - 3] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      const value = row[i] - predictor;
      filtered[i] = filter === 0 ? row[i] : value & 0xff;
    }
    raw.push(Buffer.concat([Buffer.from([filter]), filtered]));
  });

  const parts = [PNG_SIGNATURE, pngChunk("IHDR", ihdr)];
  if (text) parts.push(pngChunk("tEXt", Buffer.from(text, "latin1")));
  parts.push(pngChunk("IDAT", zlib.deflateSync(Buffer.concat(raw))), pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const PIXELS = [
  [255, 0, 0, 0, 255, 0],
  [0, 0, 255, 255, 255, 0],
];
const PNG_A = encodePng({ rows: PIXELS });
const PNG_A_RENCODED = encodePng({ rows: PIXELS, filterTypes: [1, 2], text: "Software: a different encoder" });
const PNG_B = encodePng({ rows: [[0, 0, 0, 255, 255, 255], [255, 255, 255, 0, 0, 0]] });

const B64_A = PNG_A.toString("base64");
const B64_A_RENCODED = PNG_A_RENCODED.toString("base64");
const B64_B = PNG_B.toString("base64");

// ── upstream fixtures ───────────────────────────────────────────────────────

function imageBlock(b64) {
  return { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } };
}

function sseResponse(chunks) {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function imageChunk(...images) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: DEFAULT_MODEL,
    choices: [{ index: 0, delta: { images } }],
  };
}

function doneChunk() {
  return { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
}

function jsonResponse(body, { status = 200, contentType = "application/json" } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

// ── harness ────────────────────────────────────────────────────────────────

function stubFetch(handler) {
  const calls = [];
  proxyFetchModule.__setTestFetch(async (url, options = {}) => {
    const parsedBody = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
    calls.push({ url: String(url), headers: options.headers || {}, body: parsedBody });
    return handler({ url: String(url), headers: options.headers || {}, body: parsedBody }, calls.length);
  });
  return calls;
}

function generate(body, { model = DEFAULT_MODEL, credentials = { accessToken: "eyJhbGciOi.abc.def" } } = {}) {
  return clineAdapter.executeViaExecutor(model, body, credentials, null);
}

// ── registry / wiring ──────────────────────────────────────────────────────

test("cline is registered as an image provider and exposes the chat endpoint", () => {
  assert.equal(getImageAdapter("cline"), clineAdapter);
  assert.equal(isImageProvider("cline"), true);
  assert.equal(CHAT_URL, "https://api.cline.bot/api/v1/chat/completions");
});

test("the default image model is config-driven, not hardcoded in the adapter", () => {
  assert.equal(typeof DEFAULT_MODEL, "string");
  assert.ok(DEFAULT_MODEL.length > 0, "imageConfig.chatModel must be set in registry/cline.js");
  assert.ok(IMG_CFG.maxN >= 1, "imageConfig.maxN bounds `n`");
  // Declared as an image model so the dashboard offers it for the Images API.
  const model = (clineRegistry.models || []).find((m) => m.id === DEFAULT_MODEL) || {};
  assert.equal(model.kind, "image", `${DEFAULT_MODEL} must be registered with kind:"image"`);
});

// ── request mapping ────────────────────────────────────────────────────────

test("buildBody maps a prompt to one user message on the configured image model", () => {
  const body = clineAdapter.buildBody(DEFAULT_MODEL, { prompt: "a lighthouse at dusk" });
  assert.equal(body.model, DEFAULT_MODEL);
  // No `stream` key at all: the picture rides on the JSON body, and an explicit
  // `stream:false` is what makes cline answer 500 "empty response content".
  assert.equal("stream" in body, false, "neither stream:true nor stream:false");
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "a lighthouse at dusk" }] },
  ]);
});

test("a `cl/`-prefixed image model is sent upstream as its bare id", () => {
  const body = clineAdapter.buildBody(`cl/${DEFAULT_MODEL}`, { prompt: "x" });
  assert.equal(body.model, DEFAULT_MODEL);
});

test("an unnamed model or a chat model falls back to imageConfig.chatModel", () => {
  for (const requested of [undefined, null, "", "anthropic/claude-opus-4.7", "cl/openai/gpt-5.4", "google/gemini-3.1-pro-preview"]) {
    assert.equal(clineAdapter.buildBody(requested, { prompt: "x" }).model, DEFAULT_MODEL, String(requested));
  }
});

test("an explicitly requested image model is used instead of the default", () => {
  const body = clineAdapter.buildBody("google/gemini-3-pro-image", { prompt: "x" });
  assert.equal(body.model, "google/gemini-3-pro-image");
});

test("a source image for editing rides along as an image_url part before the prompt", () => {
  const body = clineAdapter.buildBody(DEFAULT_MODEL, {
    prompt: "make it snow",
    image: `data:image/png;base64,${B64_A}`,
  });
  assert.deepEqual(body.messages[0].content, [
    { type: "image_url", image_url: { url: `data:image/png;base64,${B64_A}` } },
    { type: "text", text: "make it snow" },
  ]);
});

test("`n` becomes one sequential chat completion per image, capped by config", () => {
  const { resolveCount } = clineAdapter.__internal;
  assert.equal(resolveCount(undefined), 1);
  assert.equal(resolveCount(0), 1);
  assert.equal(resolveCount(-3), 1);
  assert.equal(resolveCount("abc"), 1);
  assert.equal(resolveCount(2), 2);
  assert.equal(resolveCount(999), IMG_CFG.maxN);
});

test("`n: 2` posts two chat completions and joins both images", async () => {
  const calls = stubFetch(({ body }, index) => {
    assert.equal(body.prompt, undefined, "the chat body carries messages, not the Images fields");
    return sseResponse([
      imageChunk(imageBlock(index === 1 ? B64_A : B64_B)),
      doneChunk(),
    ]);
  });

  const result = await generate({ prompt: "two cats", n: 2 });

  assert.equal(calls.length, 2);
  assert.equal(result.data.length, 2);
  assert.deepEqual(result.data.map((d) => d.b64_json).sort(), [B64_A, B64_B].sort());
});

// ── response mapping ───────────────────────────────────────────────────────

test("message.images[] → data[].b64_json with created", async () => {
  stubFetch(() => sseResponse([imageChunk(imageBlock(B64_A)), doneChunk()]));

  const result = await generate({ prompt: "a lighthouse" });

  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].b64_json, B64_A);
  assert.equal(typeof result.created, "number");
  assert.ok(result.created > 0);
});

test("two pixel-identical images (different bytes) collapse to one entry", async () => {
  assert.notEqual(B64_A, B64_A_RENCODED, "fixtures must differ at the byte level");
  stubFetch(() => sseResponse([imageChunk(imageBlock(B64_A), imageBlock(B64_A_RENCODED)), doneChunk()]));

  const result = await generate({ prompt: "a lighthouse" });

  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].b64_json, B64_A, "the first payload is kept");
});

test("two different images are both kept", async () => {
  stubFetch(() => sseResponse([imageChunk(imageBlock(B64_A), imageBlock(B64_B)), doneChunk()]));

  const result = await generate({ prompt: "a lighthouse" });

  assert.deepEqual(result.data.map((d) => d.b64_json), [B64_A, B64_B]);
});

test("the same picture returned by two `n` calls collapses too", async () => {
  stubFetch(() => sseResponse([imageChunk(imageBlock(B64_A)), doneChunk()]));

  const result = await generate({ prompt: "a lighthouse", n: 2 });

  assert.equal(result.data.length, 1);
});

test("duplicate images on one completion are deduped before mapping", () => {
  const deduped = clineAdapter.__internal.collectImages({
    choices: [{ message: { images: [imageBlock(B64_A), imageBlock(B64_A)] } }],
  });
  assert.equal(deduped.length, 1);
});

// ── response_format ───────────────────────────────────────────────────────

test("response_format defaults to b64_json", async () => {
  stubFetch(() => sseResponse([imageChunk(imageBlock(B64_A)), doneChunk()]));

  const result = await generate({ prompt: "x" });

  assert.equal(result.data[0].b64_json, B64_A);
  assert.equal(result.data[0].url, undefined);
});

test("response_format: url returns a data URI (upstream only has base64)", async () => {
  stubFetch(() => sseResponse([imageChunk(imageBlock(B64_A)), doneChunk()]));

  const result = await generate({ prompt: "x", response_format: "url" });

  assert.equal(result.data[0].url, `data:image/png;base64,${B64_A}`);
  assert.equal(result.data[0].b64_json, undefined);
});

// ── upstream behavior / errors ─────────────────────────────────────────────

test("the request hits the executor's cline transport with fingerprint headers", async () => {
  const calls = stubFetch(() => sseResponse([imageChunk(imageBlock(B64_A)), doneChunk()]));

  await generate({ prompt: "x" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CHAT_URL);
  assert.match(calls[0].headers.Authorization, /^Bearer workos:eyJhbGciOi/, "OAuth token keeps its workos: shape");
  assert.equal(calls[0].headers["X-CLIENT-TYPE"], "9router");
  assert.equal("stream" in calls[0].body, false, "no stream key — the JSON body carries the picture");
});

test("an upstream 500 'empty response content' stays an error with its status and message", async () => {
  stubFetch(() => jsonResponse({ error: "empty response content", success: false }, { status: 500 }));

  await assert.rejects(
    () => generate({ prompt: "x" }),
    (error) => {
      assert.match(error.message, /empty response content/);
      assert.equal(error.upstreamStatus, 500);
      return true;
    },
  );
});

test("an in-stream error frame is surfaced, not turned into an empty success", async () => {
  stubFetch(() => sseResponse([{ error: { message: "upstream exploded", status: 502 } }]));

  await assert.rejects(() => generate({ prompt: "x" }), /upstream exploded/);
});

test("a completion with no images is an error, never an empty 200 body", async () => {
  stubFetch(() => sseResponse([{ id: "c", choices: [{ index: 0, delta: { content: "I cannot draw that" } }] }, doneChunk()]));

  await assert.rejects(() => generate({ prompt: "x" }), /no images/);
});

test("a non-stream JSON envelope is unwrapped when upstream ignores stream:true", async () => {
  stubFetch(() => jsonResponse({
    success: true,
    data: { choices: [{ index: 0, message: { role: "assistant", content: "", images: [imageBlock(B64_A)] } }] },
  }));

  const result = await generate({ prompt: "x" });

  assert.equal(result.data[0].b64_json, B64_A);
});

test("an error envelope is not reported as a success", async () => {
  stubFetch(() => jsonResponse({ error: "empty response content", success: false }, { status: 200 }));

  await assert.rejects(() => generate({ prompt: "x" }), /empty response content/);
});

test("a 429 from upstream keeps its status for the caller that owns it", async () => {
  stubFetch(() => jsonResponse({ error: { message: "rate limited" } }, { status: 429 }));

  await assert.rejects(() => generate({ prompt: "x" }), (error) => {
    assert.equal(error.upstreamStatus, 429);
    assert.equal(clineErrorStatus(error), 429, "status-aware callers can keep the upstream code");
    return true;
  });
});

test("clineErrorStatus ignores a local (status-less) failure", () => {
  assert.equal(clineErrorStatus(new Error("boom")), null);
  assert.equal(clineErrorStatus({ upstreamStatus: 200 }), null);
  assert.equal(clineErrorStatus({ upstreamStatus: 503 }), 503);
});

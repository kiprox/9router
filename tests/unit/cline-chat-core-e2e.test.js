// End-to-end regression: the four `stream` request shapes a cline image model
// can receive, driven through the REAL chatCore handler (request build → stream
// decision → executor → response normalization), with only the network faked.
//
// This is the seam the two earlier rounds of fixes kept getting wrong: each fix
// looked correct in isolation and broke the next stage. The properties pinned
// here are the ones the consumer (`agentix` / nanobot-ai's generate_image tool)
// actually depends on:
//
//   1. no `stream` key         → JSON with message.images[] and no SSE sentinel
//   2. "stream": false         → same (and the outbound body must NOT carry
//                                `stream:false`: that is what cline 500s on)
//   3. "stream": true          → SSE whose deltas carry the picture
//   4. modalities + stream:false (nanobot's exact shape) → JSON with images[]
//   5. a model that answers 200 with nothing → honest 502 naming provider+model
//
// Run: node --test --import ./tests/unit/.support/cline-image-loader.mjs \
//        tests/unit/cline-chat-core-e2e.test.js
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

const IMAGE_MODEL = "google/gemini-2.5-flash-image";
const BROKEN_MODEL = "google/gemini-3-pro-image";

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

test.beforeEach(() => proxyFetchModule.__clearTestFetch());
test.afterEach(() => proxyFetchModule.__clearTestFetch());

// ── PNG fixture ────────────────────────────────────────────────────────────

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

function encodePng(rows) {
  const height = rows.length;
  const width = rows[0].length / 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = rows.map((row) => Buffer.concat([Buffer.from([0]), Buffer.from(row)]));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(raw))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = encodePng([[255, 0, 0, 0, 255, 0], [0, 0, 255, 255, 255, 0]]);
const DATA_URI = `data:image/png;base64,${PNG.toString("base64")}`;
const IMAGE_BLOCK = { type: "image_url", image_url: { url: DATA_URI } };

// ── upstream fake ──────────────────────────────────────────────────────────

function fakeUpstream(handler) {
  const calls = [];
  proxyFetchModule.__setTestFetch(async (url, options = {}) => {
    const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
    calls.push({ url: String(url), body, headers: options.headers || {} });
    return handler({ url: String(url), body }, calls.length);
  });
  return calls;
}

function jsonCompletion({ model = IMAGE_MODEL, images = [IMAGE_BLOCK], content = "Here is your coffee icon." } = {}) {
  return new Response(JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1700000000,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content, ...(images.length ? { images } : {}) },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function run(body, model = IMAGE_MODEL) {
  return handleChatCore({
    body: { model: `cl/${model}`, messages: [{ role: "user", content: "ikon kopi" }], ...body },
    modelInfo: { provider: "cline", model },
    credentials: { accessToken: "eyJhbGciOi.abc.def" },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    connectionId: "conn-1",
    apiKey: "key-1",
    log: null,
  });
}

async function bodyOf(result) {
  return { text: await result.response.text(), contentType: result.response.headers.get("content-type") || "" };
}

function assertJsonImages(text) {
  assert.doesNotMatch(text, /\[DONE\]/, "a JSON body must never carry the SSE sentinel");
  const body = JSON.parse(text);
  assert.equal(body.success, undefined, "no cline envelope on the client body");
  assert.equal(body.object, "chat.completion");
  const message = body.choices[0].message;
  assert.equal(message.images.length, 1, "the picture must survive normalization");
  assert.equal(message.images[0].image_url.url, DATA_URI);
  return body;
}

// ── DoD 1: no `stream` key ─────────────────────────────────────────────────

test("a request with no stream key returns JSON with message.images[]", async () => {
  const calls = fakeUpstream(() => jsonCompletion());

  const result = await run({});
  assert.equal(result.success, true);
  const { text, contentType } = await bodyOf(result);
  assert.match(contentType, /application\/json/);
  assertJsonImages(text);

  assert.equal(calls.length, 1, "exactly one upstream call");
  assert.equal("stream" in calls[0].body, false, "no stream key is what returns the picture");
});

// ── DoD 1b: explicit "stream": false ───────────────────────────────────────

test('"stream": false returns JSON with images and never sends stream:false upstream', async () => {
  const calls = fakeUpstream(() => jsonCompletion());

  const result = await run({ stream: false });
  assert.equal(result.success, true);
  const { text } = await bodyOf(result);
  assertJsonImages(text);

  // This is the regression the first fix introduced: forwarding stream:false is
  // exactly what makes cline answer 500 "empty response content".
  assert.equal("stream" in calls[0].body, false, "an explicit false must be omitted, not forwarded");
});

// ── DoD 2: "stream": true ──────────────────────────────────────────────────

test('"stream": true forwards the picture as SSE deltas', async () => {
  fakeUpstream(() => jsonCompletion());

  const result = await run({ stream: true });
  assert.equal(result.success, true);
  const { text, contentType } = await bodyOf(result);
  assert.match(contentType, /text\/event-stream/);

  const frames = text.split("\n\n").filter(Boolean);
  assert.equal(frames.at(-1), "data: [DONE]");

  const chunks = frames.slice(0, -1).map((f) => JSON.parse(f.slice("data: ".length)));
  for (const chunk of chunks) {
    assert.equal(chunk.object, "chat.completion.chunk", "a delta-based client reads chunks, not a whole completion");
  }
  const imageDelta = chunks.map((c) => c.choices[0].delta).find((d) => Array.isArray(d.images) && d.images.length > 0);
  assert.ok(imageDelta, "the image must reach an SSE client");
  assert.equal(imageDelta.images[0].image_url.url, DATA_URI);
});

// ── DoD 3: nanobot's exact request shape ───────────────────────────────────

test("modalities:['image','text'] + stream:false (nanobot) returns 200 with images[]", async () => {
  const calls = fakeUpstream(() => jsonCompletion());

  const result = await run({ modalities: ["image", "text"], stream: false });
  assert.equal(result.success, true);
  assert.equal(result.response.status, 200);
  const { text } = await bodyOf(result);
  assertJsonImages(text);

  // The upstream is asked for JSON (no stream key), not for the variant that 500s.
  assert.equal("stream" in calls[0].body, false);
});

// ── DoD 4: an empty 200 is a failure ───────────────────────────────────────

test("a model that answers 200 with nothing becomes a 502 naming provider+model", async () => {
  fakeUpstream(() => jsonCompletion({ model: BROKEN_MODEL, images: [], content: "" }));

  const result = await run({}, BROKEN_MODEL);
  assert.equal(result.success, false);
  assert.equal(result.response.status, 502);
  const body = JSON.parse((await bodyOf(result)).text);
  assert.match(body.error.message, /cline\/google\/gemini-3-pro-image/);
  assert.match(body.error.message, /empty completion/i);
});

// ── envelope defense (no regression on the original bug) ───────────────────

test("an enveloped upstream body is unwrapped and still carries the picture", async () => {
  fakeUpstream(() => new Response(JSON.stringify({
    success: true,
    data: {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: IMAGE_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "hi", images: [IMAGE_BLOCK] }, finish_reason: "stop" }],
    },
  }), { status: 200, headers: { "content-type": "application/json" } }));

  const result = await run({});
  const { text } = await bodyOf(result);
  assertJsonImages(text);
});

// ── a chat model on the same provider keeps its normal behaviour ───────────

test("a cline chat model still streams when the client asks for it", async () => {
  const calls = fakeUpstream(() => new Response(
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] })}\n\ndata: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ));

  const result = await run({ stream: true }, "anthropic/claude-opus-4.7");
  assert.equal(result.success, true);
  assert.equal(calls[0].body.stream, true, "chat models keep the explicit stream flag");
  const { text } = await bodyOf(result);
  assert.match(text, /data: \[DONE\]/);
});

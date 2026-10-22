// Regression suite for the second round of cline image-model fixes (2026-10-22).
//
// The first round fixed two real bugs — the {"success":true,"data":…} envelope
// leaking into the client body and the upstream "empty response content" being
// rewritten into a 503 account lock — but the way it fixed the second one broke
// the feature: `message.images[]` was normalized away, so every image model
// answered 200 with empty content and no picture, on both the JSON and the SSE
// path. This file pins the properties that must hold from now on:
//
//   1. a completion carrying `message.images[]` keeps them through normalization
//      (and through SSE→JSON and JSON→SSE conversion);
//   2. a non-stream body never carries SSE terminal bytes;
//   3. an empty 200 is reported as an upstream failure, naming provider+model;
//   4. image models are catalogued with imageOutput:true;
//   5. duplicate pictures collapse by pixels, not by bytes.
//
// Run: node --test --import ./tests/unit/.support/open-sse-alias-loader.mjs \
//        tests/unit/cline-image-regressions.test.js
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildSSEChunksFromCompletion } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { isEmptyCompletion } from "../../open-sse/utils/completionGuard.js";

const IMAGE_MODEL = "google/gemini-2.5-flash-image";
const BROKEN_MODEL = "google/gemini-3-pro-image";

// ── PNG fixtures: same pixels, different bytes (filter types + tEXt chunk) ──

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

function encodePng({ rows, filterTypes = [], text = null }) {
  const height = rows.length;
  const width = rows[0].length / 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const raw = [];
  rows.forEach((row, y) => {
    const filter = filterTypes[y] ?? 0;
    const filtered = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) {
      const a = i >= 3 ? row[i - 3] : 0;
      const b = y > 0 ? rows[y - 1][i] : 0;
      const predictor = filter === 1 ? a : filter === 2 ? b : 0;
      filtered[i] = filter === 0 ? row[i] : (row[i] - predictor) & 0xff;
    }
    raw.push(Buffer.concat([Buffer.from([filter]), filtered]));
  });

  const parts = [PNG_SIGNATURE, pngChunk("IHDR", ihdr)];
  if (text) parts.push(pngChunk("tEXt", Buffer.from(text, "latin1")));
  parts.push(pngChunk("IDAT", zlib.deflateSync(Buffer.concat(raw))), pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const PIXELS = [[255, 0, 0, 0, 255, 0], [0, 0, 255, 255, 255, 0]];
const PNG_A = encodePng({ rows: PIXELS });
const PNG_A_RENCODED = encodePng({ rows: PIXELS, filterTypes: [1, 2], text: "Software: another encoder" });
const PNG_B = encodePng({ rows: [[0, 0, 0, 255, 255, 255], [255, 255, 255, 0, 0, 0]] });

const imageBlock = (png) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } });

function completion({ images = [], content = "", model = IMAGE_MODEL, usage } = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1700000000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content, ...(images.length ? { images } : {}) }, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function nonStreamArgs(providerResponse, model = IMAGE_MODEL) {
  return {
    providerResponse,
    provider: "cline",
    model,
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    body: { stream: false },
    stream: false,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "c1",
    apiKey: "k",
    clientRawRequest: null,
    onRequestSuccess: () => {},
    reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
    toolNameMap: null,
    customToolNames: null,
    trackDone: () => {},
    appendLog: () => {},
    pxpipe: null,
    reqTag: "t",
    log: null,
  };
}

function streamArgs(providerResponse, model = IMAGE_MODEL) {
  return {
    providerResponse,
    provider: "cline",
    model,
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    body: { stream: true },
    stream: true,
    reqTag: "t",
    log: null,
  };
}

// ── DoD 1: the picture survives normalization on the JSON path ─────────────

test("a non-stream completion keeps message.images[] and returns valid OpenAI JSON", async () => {
  const upstream = completion({
    images: [imageBlock(PNG_A)],
    content: "Here is your coffee icon.",
    usage: { prompt_tokens: 5, completion_tokens: 10 },
  });
  const result = await handleNonStreamingResponse(nonStreamArgs(jsonResponse(upstream)));

  assert.equal(result.success, true);
  const text = await result.response.text();
  // A JSON client must be able to parse the whole body: no envelope, no sentinel.
  assert.doesNotMatch(text, /\[DONE\]/, "a non-stream body must never carry an SSE sentinel");
  assert.equal(text.trim().startsWith("{"), true, "the body must be one JSON document");

  const body = JSON.parse(text);
  assert.equal(body.success, undefined, "no cline envelope on the client body");
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "Here is your coffee icon.");
  assert.equal(body.choices[0].message.images.length, 1);
  assert.match(body.choices[0].message.images[0].image_url.url, /^data:image\/png;base64,/);
});

test("an enveloped upstream body is unwrapped AND keeps its images", async () => {
  const upstream = { success: true, data: completion({ images: [imageBlock(PNG_A)] }) };
  const result = await handleNonStreamingResponse(nonStreamArgs(jsonResponse(upstream)));

  const body = await result.response.json();
  assert.equal(body.success, undefined);
  assert.equal(body.choices[0].message.images.length, 1);
});

// ── DoD 2: the picture survives the SSE path ──────────────────────────────

test("delta.images[] survives SSE→JSON conversion for a JSON client behind a stream", () => {
  const sse = [
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant" } }] })}`,
    "",
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { images: [imageBlock(PNG_A)] } }] })}`,
    "",
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const parsed = parseSSEToOpenAIResponse(sse, IMAGE_MODEL);
  assert.equal(parsed.choices[0].message.images.length, 1);
  assert.match(parsed.choices[0].message.images[0].image_url.url, /^data:image\/png;base64,/);
});

test("an SSE client behind a JSON-only model still receives the image delta", async () => {
  const result = await handleStreamingResponse(streamArgs(jsonResponse(completion({ images: [imageBlock(PNG_A)] }))));
  assert.equal(result.success, true);

  const text = await result.response.text();
  const deltas = text.split("\n\n").filter(Boolean).filter((f) => f !== "data: [DONE]")
    .map((f) => JSON.parse(f.slice("data: ".length)).choices[0].delta);
  const withImages = deltas.filter((d) => Array.isArray(d.images) && d.images.length > 0);
  assert.equal(withImages.length, 1);
  assert.match(withImages[0].images[0].image_url.url, /^data:image\/png;base64,/);
});

test("buildSSEChunksFromCompletion never fabricates content for an empty message", () => {
  const sse = buildSSEChunksFromCompletion({ choices: [{ message: {}, finish_reason: "stop" }] });
  const frames = sse.split("\n\n").filter(Boolean);
  assert.equal(frames.at(-1), "data: [DONE]");
  for (const frame of frames.slice(0, -1)) {
    const delta = JSON.parse(frame.slice("data: ".length)).choices[0].delta;
    // The opening role frame carries an empty content string by convention;
    // nothing beyond it may appear when the message had no output.
    if (delta.role) {
      assert.equal(delta.content, "");
      continue;
    }
    assert.equal(delta.content, undefined, "no invented content");
    assert.equal(delta.images, undefined, "no invented images");
  }
});

// ── DoD 3: an empty 200 is a failure, not a success ───────────────────────

test("isEmptyCompletion recognises a 200 with no text, images or tool calls", () => {
  assert.equal(isEmptyCompletion(completion({ content: "" })), true);
  assert.equal(isEmptyCompletion(completion({ content: "hi" })), false);
  assert.equal(isEmptyCompletion(completion({ images: [imageBlock(PNG_A)] })), false);
  assert.equal(isEmptyCompletion({ choices: [{ message: { tool_calls: [{ id: "t" }] } }] }), false);
  // A thinking-only completion is real output, not an empty one.
  assert.equal(isEmptyCompletion({ choices: [{ message: { content: "", reasoning_content: "hmm" } }] }), false);
  // Not our shape to judge.
  assert.equal(isEmptyCompletion({ error: "boom" }), false);
  assert.equal(isEmptyCompletion({ choices: [] }), false);
});

test("a broken image model answers 502 naming provider+model instead of an empty 200", async () => {
  const result = await handleNonStreamingResponse(nonStreamArgs(jsonResponse(completion({ model: BROKEN_MODEL })), BROKEN_MODEL));

  assert.equal(result.success, false);
  assert.equal(result.response.status, 502);
  const body = await result.response.json();
  assert.match(body.error.message, /cline\/google\/gemini-3-pro-image/);
  assert.match(body.error.message, /empty completion/i);
});

test("the same guard does not fire for a provider that did not opt in", async () => {
  const args = { ...nonStreamArgs(jsonResponse(completion())), provider: "openai" };
  const result = await handleNonStreamingResponse(args);
  assert.equal(result.success, true);
  const body = await result.response.json();
  assert.equal(body.choices[0].message.content, "");
});

// ── DoD 5/6: the catalog tells the truth ─────────────────────────────────

test("every cline image model that was proven to draw is catalogued with imageOutput:true", () => {
  const proven = [
    "google/gemini-2.5-flash-image",
    "google/gemini-nano-banana-2.1",
  ];
  for (const id of proven) {
    assert.equal(getCapabilitiesForModel("cline", id).imageOutput, true, id);
  }
});

test("a cline image model never observed producing a picture is not advertised as one", () => {
  // DoD 4/6: these answer `content:""` with zero images for every prompt, so the
  // catalog must not promise a picture. The quirk guard turns the empty 200 into
  // a 502 either way; this is about what /v1/models claims.
  for (const id of ["google/gemini-3-pro-image", "google/gemini-3.1-flash-image"]) {
    assert.equal(getCapabilitiesForModel("cline", id).imageOutput, false, id);
  }
});

test("a chat model on the same provider is not advertised as an image model", () => {
  for (const id of ["anthropic/claude-opus-4.7", "openai/gpt-5.4", "google/gemini-3.1-pro-preview"]) {
    assert.equal(getCapabilitiesForModel("cline", id).imageOutput, false, id);
  }
});

test("the registry's image quirks agree with the capabilities table", () => {
  const quirks = PROVIDERS.cline.quirks;
  for (const id of ["google/gemini-2.5-flash-image", "google/gemini-nano-banana-2.1"]) {
    assert.equal(quirks.imageModels.test(id), true, `${id} must be treated as an image model`);
    assert.equal(quirks.nonStreamOnlyModels.test(id), true, `${id} must be asked for JSON`);
  }
});

// ── DoD 7: duplicate pictures collapse by pixels ─────────────────────────

test("byte-different, pixel-identical images collapse to one entry on the JSON path", async () => {
  assert.notEqual(PNG_A.toString("base64"), PNG_A_RENCODED.toString("base64"), "fixtures must differ at the byte level");
  const upstream = completion({ images: [imageBlock(PNG_A), imageBlock(PNG_A_RENCODED)] });
  const result = await handleNonStreamingResponse(nonStreamArgs(jsonResponse(upstream)));

  const body = await result.response.json();
  assert.equal(body.choices[0].message.images.length, 1);
  assert.equal(body.choices[0].message.images[0].image_url.url, imageBlock(PNG_A).image_url.url, "the first payload is kept");
});

test("two genuinely different pictures are both kept", async () => {
  const upstream = completion({ images: [imageBlock(PNG_A), imageBlock(PNG_B)] });
  const result = await handleNonStreamingResponse(nonStreamArgs(jsonResponse(upstream)));

  const body = await result.response.json();
  assert.equal(body.choices[0].message.images.length, 2);
});

test("pixel-identical images streamed as separate deltas collapse too", () => {
  const sse = [
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { images: [imageBlock(PNG_A), imageBlock(PNG_A_RENCODED)] } }] })}`,
    "",
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const parsed = parseSSEToOpenAIResponse(sse, IMAGE_MODEL);
  assert.equal(parsed.choices[0].message.images.length, 1);
});

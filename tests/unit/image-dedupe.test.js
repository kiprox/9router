// Bug #4 (cline adapter): image models can return the same picture twice —
// different bytes (re-encoded container, different metadata), identical pixels —
// so a byte-level signature misses it. The utility hashes decoded pixels instead,
// and must stay fail-open: an image it cannot verify is never dropped.
//
// Run: node --test tests/unit/image-dedupe.test.js
// (this repo wires no test runner and ships no vitest, per AGENTS.md)
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { dedupeImages, dedupeImageArray, hashPngPixels } from "../../open-sse/utils/imageDedupe.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode an 8-bit RGB PNG from raw pixel rows (one Buffer per row, 3 bytes/pixel).
 * `filterTypes` picks the PNG scanline filter per row so two files can carry the
 * same pixels in different bytes; a `tEXt` chunk is optional extra metadata.
 */
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
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      filtered[i] = (row[i] - predictor) & 0xff;
    }
    raw.push(Buffer.from([filter]), filtered);
  });

  const parts = [PNG_SIGNATURE, chunk("IHDR", ihdr)];
  if (text) parts.push(chunk("tEXt", Buffer.from(text, "latin1")));
  parts.push(chunk("IDAT", zlib.deflateSync(Buffer.concat(raw))), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const RED_ROW = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
const BLUE_ROW = Buffer.from([0, 0, 255, 255, 255, 0, 0, 255, 255]);

const PNG_A = encodePng({ rows: [RED_ROW, BLUE_ROW], filterTypes: [0, 0] });
// Same pixels, different bytes: different scanline filters + an extra tEXt chunk.
const PNG_B = encodePng({ rows: [RED_ROW, BLUE_ROW], filterTypes: [1, 2], text: "Software\0reencoder" });
const PNG_DIFFERENT = encodePng({ rows: [BLUE_ROW, RED_ROW], filterTypes: [0, 0] });

function dataUri(buf) {
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function messageWith(images) {
  return { object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "", images } }] };
}

test("fixtures: byte-different files decode to the same pixel hash", () => {
  assert.notDeepEqual(PNG_A, PNG_B, "fixtures must differ at byte level");
  assert.equal(hashPngPixels(PNG_A), hashPngPixels(PNG_B));
  assert.notEqual(hashPngPixels(PNG_A), hashPngPixels(PNG_DIFFERENT));
});

test("pixel-identical images collapse to one entry", () => {
  const images = [
    { type: "image_url", image_url: { url: dataUri(PNG_A) } },
    { type: "image_url", image_url: { url: dataUri(PNG_B) } },
  ];
  const kept = dedupeImageArray(images);

  assert.equal(kept.length, 1);
  assert.equal(kept[0], images[0], "the first occurrence is the one kept");
});

test("different pixels keep both entries", () => {
  const kept = dedupeImageArray([
    { type: "image_url", image_url: { url: dataUri(PNG_A) } },
    { type: "image_url", image_url: { url: dataUri(PNG_DIFFERENT) } },
  ]);
  assert.equal(kept.length, 2);
});

test("exact duplicates are removed even when the payload cannot be decoded", () => {
  const url = "https://example.com/generated/a.webp";
  const kept = dedupeImageArray([
    { type: "image_url", image_url: { url } },
    { type: "image_url", image_url: { url } },
    { type: "image_url", image_url: { url: "https://example.com/generated/b.webp" } },
  ]);
  assert.equal(kept.length, 2);
});

test("non-PNG and undecodable entries pass through untouched (fail-open)", () => {
  // Distinct bytes, no decodable pixels: dropped only if they hash equal on the raw
  // payload, which they do not — so all three survive.
  const jpegs = [1, 2, 3].map((n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpeg-body-${n}`)]));
  const images = jpegs.map((buf) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` } }));
  images.push(
    { b64_json: Buffer.from("definitely not an image").toString("base64") },
    { b64_json: Buffer.from("also not an image").toString("base64") },
    { note: "no payload at all" },
    { note: "no payload at all" },
  );

  const kept = dedupeImageArray(images);

  assert.equal(kept.length, images.length);
  assert.deepEqual(kept, images, "entries without verifiable pixels are never removed");
});

test("corrupt/truncated PNG is kept rather than guessed away", () => {
  const truncated = PNG_A.subarray(0, PNG_A.length - 12);
  const kept = dedupeImageArray([
    { type: "image_url", image_url: { url: dataUri(truncated) } },
    { type: "image_url", image_url: { url: dataUri(truncated.subarray(0, truncated.length - 1)) } },
  ]);
  assert.equal(hashPngPixels(truncated), null);
  assert.equal(kept.length, 2);
});

test("palette PNGs (colour type 3) are not pixel-deduped", () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 3; // palette
  const palettePng = Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("PLTE", Buffer.from([255, 0, 0])),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  assert.equal(hashPngPixels(palettePng), null);
});

test("dedupeImages mutates only images[] and keeps every other field", () => {
  const body = messageWith([
    { type: "image_url", image_url: { url: dataUri(PNG_A) } },
    { type: "image_url", image_url: { url: dataUri(PNG_B) } },
  ]);
  body.usage = { prompt_tokens: 1 };
  const message = body.choices[0].message;
  message.content = "two cats, honestly";
  message.tool_calls = [{ id: "t1" }];

  const result = dedupeImages(body);

  assert.equal(result, body);
  assert.equal(message.images.length, 1);
  assert.deepEqual(
    [message.content, message.tool_calls, body.usage],
    ["two cats, honestly", [{ id: "t1" }], { prompt_tokens: 1 }],
  );
});

test("dedupeImages handles every choice, bare messages, and bodies without images", () => {
  const body = {
    choices: [
      { message: { images: [{ b64_json: PNG_A.toString("base64") }, { b64_json: PNG_B.toString("base64") }] } },
      { message: { content: "no images" } },
      { message: { images: [{ b64_json: PNG_A.toString("base64") }, { b64_json: PNG_DIFFERENT.toString("base64") }] } },
    ],
  };
  dedupeImages(body);
  assert.equal(body.choices[0].message.images.length, 1);
  assert.equal(body.choices[2].message.images.length, 2);

  // A bare message (no choices) is deduped too, and odd shapes never throw.
  const bare = { images: [{ b64_json: PNG_A.toString("base64") }, { b64_json: PNG_B.toString("base64") }] };
  assert.equal(dedupeImages(bare).images.length, 1);

  const noImages = { choices: null, messages: [] };
  assert.equal(dedupeImages(noImages), noImages);
  assert.equal(dedupeImages(null), null);
  assert.deepEqual(dedupeImageArray([]), []);
});

// Pixel-level de-duplication for `choices[].message.images[]`.
//
// Upstreams (observed with cline image models) can return the same generated
// image twice with different bytes — different container metadata, same pixels —
// so a byte-level signature misses it. This module hashes the decoded pixel
// data instead, and is deliberately fail-open: any image it cannot verify
// (non-PNG, corrupt, unsupported colour type) is kept, never dropped.
import { createHash } from "node:crypto";
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = "IHDR";
const PNG_IDAT = "IDAT";
const PNG_IEND = "IEND";
const PNG_BIT_DEPTH_8 = 8;
// Colour type → samples per pixel (PNG spec §11.2.2). Palette (3) and 16-bit
// images are not decoded here: their pixels need a PLTE lookup / down-sampling,
// and failing open is cheaper than a wrong duplicate judgement.
const PNG_SAMPLES_PER_PIXEL = { 0: 1, 2: 3, 4: 2, 6: 4 };
const DATA_URI_PREFIX = /^data:[^;,]*;base64,/i;

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Read a PNG's IHDR + concatenated IDAT without decoding pixels.
 * @param {Buffer} buf
 * @returns {{width: number, height: number, bitDepth: number, colorType: number, idat: Buffer}|null} null when not a decodable PNG
 */
export function readPngChunks(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < PNG_SIGNATURE.length + 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  let offset = PNG_SIGNATURE.length;
  let ihdr = null;
  const idatParts = [];
  let sawIend = false;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) return null; // truncated chunk (CRC included)
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataEnd + 4; // skip CRC (not verified; a corrupt image fails inflation below)

    if (type === PNG_IHDR) {
      if (data.length < 13) return null;
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
      };
    } else if (type === PNG_IDAT) {
      idatParts.push(data);
    } else if (type === PNG_IEND) {
      sawIend = true;
      break;
    }
  }

  if (!ihdr || !sawIend || idatParts.length === 0) return null;
  if (!ihdr.width || !ihdr.height) return null;
  return { ...ihdr, idat: Buffer.concat(idatParts) };
}

/**
 * Undo PNG row filters (types 0–4) on 8-bit, non-palette images.
 * @param {Buffer} raw - Inflated scanlines, filter byte first
 * @param {number} width
 * @param {number} height
 * @param {number} samplesPerPixel
 * @returns {Buffer|null} Unfiltered pixel bytes, or null on malformed data
 */
export function unfilterPngRows(raw, width, height, samplesPerPixel) {
  const bpp = samplesPerPixel; // bytes per pixel == samples per pixel at bit depth 8
  const stride = width * bpp;
  const expected = (stride + 1) * height;
  if (!Buffer.isBuffer(raw) || raw.length < expected) return null;

  const out = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const filterType = raw[row * (stride + 1)];
    const src = row * (stride + 1) + 1;
    const dst = row * stride;
    const prev = dst - stride; // negative on the first row → treated as zero bytes

    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = row > 0 ? out[prev + i] : 0;
      const c = row > 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let value;
      switch (filterType) {
        case 0: value = x; break; // None
        case 1: value = x + a; break; // Sub
        case 2: value = x + b; break; // Up
        case 3: value = x + ((a + b) >> 1); break; // Average
        case 4: value = x + paeth(a, b, c); break; // Paeth
        default: return null;
      }
      out[dst + i] = value & 0xff;
    }
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a PNG to a hash of its pixels (dimensions + unfiltered RGBA-ish bytes).
 * @param {Buffer} buf
 * @returns {string|null} sha256 of the pixels, or null when the image cannot be verified
 */
export function hashPngPixels(buf) {
  let png;
  try {
    png = readPngChunks(buf);
  } catch {
    return null;
  }
  if (!png || png.bitDepth !== PNG_BIT_DEPTH_8) return null;
  const samplesPerPixel = PNG_SAMPLES_PER_PIXEL[png.colorType];
  if (!samplesPerPixel) return null;

  let raw;
  try {
    raw = zlib.inflateSync(png.idat);
  } catch {
    return null;
  }
  const pixels = unfilterPngRows(raw, png.width, png.height, samplesPerPixel);
  if (!pixels) return null;

  // Dimensions are part of the identity: identical scanline bytes at different
  // sizes are different images.
  return sha256(Buffer.concat([
    Buffer.from(`${png.width}x${png.height}x${png.colorType};`),
    pixels,
  ]));
}

/**
 * Return the image's URL string or base64 payload, wherever the upstream put it.
 * Shapes seen in the wild: {type:"image_url", image_url:{url}}, {url},
 * {b64_json}, and the OpenAI image_url string form.
 */
function imageSource(image) {
  if (!image || typeof image !== "object") return null;
  if (isNonEmptyString(image.url)) return image.url;
  const nested = image.image_url;
  if (isNonEmptyString(nested)) return nested;
  if (nested && typeof nested === "object" && isNonEmptyString(nested.url)) return nested.url;
  if (isNonEmptyString(image.b64_json)) return `data:image/png;base64,${image.b64_json}`;
  if (isNonEmptyString(image.data)) return image.data;
  return null;
}

/**
 * Identify an image entry by its exact payload and, when possible, its pixels.
 * @returns {{exact: string|null, pixels: string|null}}
 */
function imageKeys(image) {
  const source = imageSource(image);
  if (!source) return { exact: null, pixels: null };
  return { exact: sha256(source), pixels: hashPngPixels(decodeBase64(source)) };
}

function decodeBase64(source) {
  const base64 = source.replace(DATA_URI_PREFIX, "");
  // A remote URL (or any non-base64 payload) is not decodable here; Buffer would
  // silently accept random ASCII, so gate on the data-URI prefix / base64 shape.
  if (!DATA_URI_PREFIX.test(source) && !/^[A-Za-z0-9+/=\s]+$/.test(base64)) return null;
  try {
    const buf = Buffer.from(base64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Drop duplicate images from an `images[]` array.
 *
 * Two passes: an exact-payload hash (cheap, covers byte-identical repeats) and
 * a pixel hash for PNGs (covers re-encoded repeats). Entries with neither a
 * readable payload nor decodable pixels are always kept — a duplicate we cannot
 * prove is a distinct image, and silently losing one is worse than showing two.
 *
 * @param {Array} images - `choices[].message.images`
 * @returns {Array} New array with duplicates removed (input not mutated)
 */
export function dedupeImageArray(images) {
  if (!Array.isArray(images) || images.length < 2) return images;

  const seenExact = new Set();
  const seenPixels = new Set();
  const kept = [];

  for (const image of images) {
    let keys;
    try {
      keys = imageKeys(image);
    } catch {
      kept.push(image); // fail-open
      continue;
    }
    if (keys.exact && seenExact.has(keys.exact)) continue;
    if (keys.pixels && seenPixels.has(keys.pixels)) continue;
    if (keys.exact) seenExact.add(keys.exact);
    if (keys.pixels) seenPixels.add(keys.pixels);
    kept.push(image);
  }
  return kept;
}

/**
 * De-duplicate `images[]` on every choice of a chat-completion response.
 *
 * Mutates the body in place (choices[].message.images is replaced only when a
 * duplicate was actually found) and returns it, so callers can chain it. Any
 * shape that is not a chat completion is returned untouched.
 *
 * @param {object} body - Chat-completion response body or a bare message
 * @returns {object} The same body
 */
export function dedupeImages(body) {
  if (!body || typeof body !== "object") return body;

  const messages = Array.isArray(body.choices)
    ? body.choices.map((choice) => choice?.message)
    : [body];

  for (const message of messages) {
    if (!message || !Array.isArray(message.images)) continue;
    const deduped = dedupeImageArray(message.images);
    if (deduped.length !== message.images.length) message.images = deduped;
  }
  return body;
}

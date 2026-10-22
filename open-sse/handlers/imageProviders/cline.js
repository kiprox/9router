// Cline image adapter — the Images API on top of Cline's chat-completions endpoint.
//
// Cline exposes no `/images/generations`: its image models are chat models that
// answer the prompt with the picture in `choices[].message.images[]`. The
// picture lives on the NON-stream body — `stream:true` returns text only, and an
// explicit `stream:false` returns 500 "empty response content" — so the adapter
// posts one chat completion per requested image with no `stream` key at all and
// maps the images back to the OpenAI Images shape.
//
// Transport goes through the executor (`executeViaExecutor`) — the path every
// chat request takes (executor → transport → auth hooks → proxy). That is also
// the only path that carries an OAuth connection, because the `workos:` token
// shape and the client fingerprint headers live there. The executor's URL,
// status handling and creds stay canonical; this adapter owns the body
// transformation and the response mapping. `buildUrl`/`buildHeaders`/`buildBody`
// stay available for static callers that dispatch on the adapter interface.
//
// Model, default and limits come from `imageConfig` in
// open-sse/providers/registry/cline.js — nothing about a model is hardcoded here.
import { nowSec } from "./_base.js";
import { PROVIDER_MEDIA, PROVIDERS } from "../../providers/index.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { ROLE, OPENAI_BLOCK, DEFAULT_IMAGE_MIME } from "../../translator/schema/index.js";
import { encodeDataUri, parseDataUri } from "../../translator/concerns/image.js";
import { dedupeImageArray } from "../../utils/imageDedupe.js";
import { parseUpstreamError } from "../../utils/error.js";
import { unwrapClineEnvelope } from "../../shared/clineEnvelope.js";
import { buildClineFingerprintHeaders, getClineAccessToken } from "../../shared/clineAuth.js";
import { getExecutor } from "../../executors/index.js";

const PROVIDER_ID = "cline";
const DEFAULT_RESPONSE_FORMAT = "b64_json";
const DEFAULT_MAX_N = 1;
const PROVIDER_PREFIX = /^cl\//;
// Content types that mean "this body is one JSON document", not a frame stream.
const JSON_CONTENT_TYPES = ["application/json", "text/json"];

const imageConfig = () => PROVIDER_MEDIA[PROVIDER_ID]?.imageConfig || {};
const chatModel = () => imageConfig().chatModel;

// `cl/` is cline's model alias; the upstream only knows the bare id.
const stripProviderPrefix = (model) => String(model).replace(PROVIDER_PREFIX, "");

function isClineImageModel(model) {
  const pattern = PROVIDERS[PROVIDER_ID]?.quirks?.imageModels;
  return pattern instanceof RegExp && pattern.test(model);
}

/**
 * The image model a request asked for, or the registry default when it named a
 * non-image chat model (a client routing `cl/claude-…` at the Images API wants a
 * picture, not a chat completion).
 */
function resolveModel(requested) {
  if (typeof requested === "string" && requested.trim()) {
    const model = stripProviderPrefix(requested.trim());
    if (isClineImageModel(model)) return model;
  }
  const fallback = chatModel();
  if (fallback) return fallback;
  throw new Error(
    "Cline: no image model configured. Add imageConfig.chatModel to " +
      "open-sse/providers/registry/cline.js, or request an image model such as " +
      '"google/gemini-2.5-flash-image".',
  );
}

// Images API `n` → how many chat completions to run. Cline has no multi-image
// parameter, so it is iteration, bounded by the registry limit.
function resolveCount(requested) {
  const { maxN = DEFAULT_MAX_N } = imageConfig();
  const n = Number(requested);
  if (!Number.isSafeInteger(n) || n < 1) return 1;
  return Math.min(n, maxN);
}

function resolveResponseFormat(requested) {
  return requested === "url" ? "url" : DEFAULT_RESPONSE_FORMAT;
}

// A source image for edit prompts. Accepts the OpenAI data-URI block (and its
// `image_url` string form) plus the plain URL the dashboard sends; the prompt
// stays a text part so every chat format can read it.
function buildContent(prompt, body) {
  const sources = Array.isArray(body?.images) ? [...body.images] : [];
  if (body?.image) sources.push(body.image);

  const content = [];
  for (const source of sources) {
    const url = typeof source === "string" ? source : source?.image_url?.url ?? source?.url;
    if (typeof url !== "string" || !url.trim()) continue;
    const value = url.trim();
    // Claude encodes image blocks by media type, so a bare base64 payload is
    // declared as PNG rather than left untyped.
    const resolved = /^(data:|https?:\/\/)/i.test(value) ? value : encodeDataUri(DEFAULT_IMAGE_MIME, value);
    content.push({ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url: resolved } });
  }
  content.push({ type: OPENAI_BLOCK.TEXT, text: prompt });
  return content;
}

function buildChatBody(model, body) {
  return {
    model,
    messages: [{ role: ROLE.USER, content: buildContent(body?.prompt, body) }],
    // Image models carry the picture on the NON-stream body only
    // (transport.quirks.nonStreamOnlyModels): asking for SSE drops it entirely,
    // and an explicit `stream:false` returns 500 "empty response content", so
    // the key is omitted and the OpenAI default (non-stream) applies.
  };
}

function buildChatHeaders(credentials) {
  const headers = {
    "Content-Type": "application/json",
    ...(PROVIDERS[PROVIDER_ID]?.headers || {}),
    ...buildClineFingerprintHeaders(),
  };
  const token = getClineAccessToken(credentials?.apiKey || credentials?.accessToken);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Collect `message.images[]` from a chat completion — enveloped or bare.
 * @returns {Array} image entries, de-duplicated, in order
 */
function collectImages(chatBody) {
  const images = [];
  for (const choice of chatBody?.choices || []) {
    for (const image of choice?.message?.images || []) {
      if (image) images.push(image);
    }
  }
  return dedupeImageArray(images);
}

/**
 * Map chat-completion images to the OpenAI Images shape.
 * `response_format: "url"` is honoured with a data URI built from the base64
 * payload Cline returns — the same approach cloudflareAi.js uses; no remote URL
 * is invented and nothing is fetched.
 *
 * @param {Array} images - `message.images[]` entries
 * @param {"b64_json"|"url"} responseFormat
 * @param {{skipRemote?: boolean}} [options] - `skipRemote` keeps http(s) entries
 *   out instead of fetching them (the core owns that fetch, see _base.urlToBase64)
 */
function toImagesResponse(images, responseFormat, options = {}) {
  const data = [];
  for (const image of images) {
    // Cline sends `{type:"image_url", image_url:{url}}`; a bare `{url}`/`{b64_json}`
    // is accepted too so a hand-parsed body maps the same way.
    const source = typeof image?.url === "string" && image.url
      ? image.url
      : typeof image?.image_url?.url === "string" && image.image_url.url
        ? image.image_url.url
        : null;
    if (source) {
      const parsed = parseDataUri(source);
      if (parsed) {
        data.push(responseFormat === "url" ? { url: source } : { b64_json: parsed.base64 });
      } else if (!options.skipRemote) {
        data.push({ url: source });
      }
      continue;
    }
    if (typeof image.b64_json === "string" && image.b64_json) {
      data.push(responseFormat === "url"
        ? { url: encodeDataUri(DEFAULT_IMAGE_MIME, image.b64_json) }
        : { b64_json: image.b64_json });
    }
  }
  return { created: nowSec(), data };
}

// Every failure reaches the client as the upstream's own status and message: a
// made-up 200 with no images is the bug this adapter exists to fix.
function upstreamError(status, message) {
  const error = new Error(message);
  error.upstreamStatus = status;
  throw error;
}

async function throwUpstream(response) {
  const parsed = await parseUpstreamError(response).catch(() => null);
  const status = parsed?.statusCode || response.status || HTTP_STATUS.BAD_GATEWAY;
  upstreamError(status, parsed?.message || `HTTP ${status}`);
}

function completionFromPayload(payload) {
  const body = unwrapClineEnvelope(payload, PROVIDER_ID);
  if (Array.isArray(body?.choices)) return body;
  if (body?.success === false || body?.error) {
    const detail = body.error?.message || body.error || "upstream error";
    upstreamError(Number(body.status) || HTTP_STATUS.SERVER_ERROR, String(detail));
  }
  upstreamError(HTTP_STATUS.BAD_GATEWAY, "Cline returned no completion choices");
}

// Forced-SSE path: the picture arrives as `delta.images[]` on content chunks.
// There is no tool-call accumulation to do here — only images and the error
// frame matter, and an empty stream is an error, never an empty success.
function completionFromSse(rawSse) {
  const images = [];
  let streamError = null;
  let sawFrame = false;
  const text = String(rawSse || "");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try {
      chunk = unwrapClineEnvelope(JSON.parse(payload), PROVIDER_ID);
    } catch {
      continue; // malformed line
    }
    sawFrame = true;
    if (chunk?.error) {
      streamError = chunk.error;
      continue;
    }
    for (const choice of chunk?.choices || []) {
      for (const image of choice?.delta?.images || []) {
        if (image) images.push(image);
      }
    }
  }
  if (streamError) {
    const status = Number(streamError.status);
    upstreamError(status >= 400 && status <= 599 ? status : HTTP_STATUS.SERVER_ERROR,
      streamError.message || "Upstream SSE stream failed");
  }
  if (!sawFrame) {
    // No SSE frame at all: the upstream ignored `stream:true` and answered with
    // one JSON document — read it in that shape rather than call it empty.
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      upstreamError(HTTP_STATUS.BAD_GATEWAY, "Cline returned a body that is neither SSE nor JSON");
    }
    return completionFromPayload(payload);
  }
  if (images.length === 0) {
    upstreamError(HTTP_STATUS.BAD_GATEWAY, "Cline streamed a completion with no images");
  }
  return { choices: [{ index: 0, message: { role: ROLE.ASSISTANT, content: "", images } }] };
}

// The adapter's own `stream` decision is not always the one the executor sends
// (chatCore forces SSE for image models), so the executor path runs through
// this fetch — which records the outbound request and reads the response in the
// shape that was actually asked for.
async function executeChat({ model, body, credentials, log }) {
  const executor = getExecutor(PROVIDER_ID);
  const sent = { stream: body.stream === true, body };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    try {
      sent.body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    } catch { /* keep the body we asked for */ }
    sent.stream = sent.body?.stream === true;
    return originalFetch(url, init);
  };

  let result;
  try {
    result = await executor.execute({ model, body, stream: sent.stream, credentials, log });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const response = result?.response;
  if (!response?.ok) await throwUpstream(response);

  const contentType = response.headers?.get?.("content-type") || "";
  // Our own decision to stream is not enough: an upstream may answer JSON anyway,
  // so the body decides — a JSON document is read as JSON even on the stream path.
  const isJson = JSON_CONTENT_TYPES.some((type) => contentType.includes(type));
  if (isJson || (!sent.stream && !contentType.includes("text/event-stream"))) {
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      upstreamError(HTTP_STATUS.BAD_GATEWAY, "Cline returned a body that is not JSON");
    }
    return completionFromPayload(payload);
  }
  return completionFromSse(await response.text());
}

async function generateImages(model, body, credentials, log) {
  const count = resolveCount(body?.n);
  const chatBody = buildChatBody(model, body);
  const images = [];
  // Sequential: each image is its own billed request against the same account.
  for (let i = 0; i < count; i++) {
    const completion = await executeChat({ model, body: chatBody, credentials, log });
    images.push(...collectImages(completion));
  }
  // Identical pictures across the `n` calls collapse here, exactly like the
  // duplicate `images[]` a single upstream completion can carry.
  const deduped = dedupeImageArray(images);
  if (deduped.length === 0) {
    upstreamError(HTTP_STATUS.BAD_GATEWAY, "Cline returned a completion with no images");
  }
  return deduped;
}

/**
 * Generate through the chat path and return a complete OpenAI Images body
 * (`created` + `data`), so `imageGenerationCore` re-normalizes nothing.
 */
export async function generateClineImages({ model, body, credentials, log }) {
  const targetModel = resolveModel(model);
  const images = await generateImages(targetModel, body, credentials, log);
  // A remote http(s) image would have to be downloaded to answer b64_json; the
  // core already does exactly that for `data[].url` when a client asks for bytes.
  return toImagesResponse(images, resolveResponseFormat(body?.response_format), {
    skipRemote: resolveResponseFormat(body?.response_format) === DEFAULT_RESPONSE_FORMAT,
  });
}

/**
 * The HTTP status a failed generation should surface. `imageGenerationCore`
 * reports adapter errors as 502 through formatProviderError, so a caller that
 * owns the status reads the upstream code off the error rather than reporting a
 * generic gateway failure for a 429 or a 402.
 */
export function clineErrorStatus(error) {
  const status = Number(error?.upstreamStatus);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

// The adapter object is named so `import/no-anonymous-default-export` stays quiet
// and a stack trace points at a real identifier.
const clineImageAdapter = {
  // Declarative hint for imageGenerationCore: this adapter posts a chat
  // completion through the transport, so URL/headers/body are the chat endpoint's.
  useExecutor: true,

  buildUrl: () => PROVIDERS[PROVIDER_ID]?.baseUrl,
  buildHeaders: (credentials) => buildChatHeaders(credentials),
  buildBody: (model, body) => buildChatBody(resolveModel(model), body),

  // Core maps any throw from here to 502 (formatProviderError); the upstream
  // status rides on `upstreamStatus` so a status-aware caller can keep it.
  async executeViaExecutor(model, body, credentials, log) {
    return generateClineImages({ model, body, credentials, log });
  },

  // Render shape: the executor path already produced a full Images body, so this
  // is only reached for a raw chat completion a caller parsed itself.
  normalize: (parsed, prompt) => {
    if (parsed?.created && Array.isArray(parsed?.data)) return parsed;
    const images = collectImages(unwrapClineEnvelope(parsed, PROVIDER_ID));
    const data = toImagesResponse(images, DEFAULT_RESPONSE_FORMAT).data;
    // Same convention as the gemini/antigravity adapters: an empty result is
    // surfaced as an empty b64_json rather than a silently successful array.
    return { created: nowSec(), data: data.length > 0 ? data : [{ b64_json: "", revised_prompt: prompt }] };
  },

  // Exposed for tests: the pure transformation layer.
  __internal: {
    resolveModel,
    resolveCount,
    resolveResponseFormat,
    buildContent,
    buildChatBody,
    buildChatHeaders,
    collectImages,
    toImagesResponse,
    completionFromPayload,
    completionFromSse,
  },
};

export default clineImageAdapter;

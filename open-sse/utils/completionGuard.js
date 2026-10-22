// Honest-success guard for provider quirks.
//
// Some upstreams answer HTTP 200 with a structurally valid chat completion that
// carries nothing: no text, no images, no tool calls. Measured 2026-10-22 with
// cline's `google/gemini-3-pro-image` — `{"content":"","finish_reason":"stop"}`,
// 0 images — for every prompt. A client cannot tell that apart from a model that
// genuinely replied with an empty string, so it renders nothing and reports
// success: the request silently did no work and was still billed.
//
// Providers opt in via `transport.quirks.rejectEmptyCompletion`; the guard is a
// no-op everywhere else, so a provider that legitimately returns empty content
// (thinking models that spent the whole budget on reasoning) is untouched.
import { PROVIDERS } from "../config/providers.js";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * True when every choice of a chat-completion body carries no usable output.
 * A body with no `choices` at all is NOT reported here — that is a different
 * failure (a non-completion payload) and each caller already handles it.
 *
 * @param {object} body - Chat-completion response body
 * @returns {boolean}
 */
export function isEmptyCompletion(body) {
  const choices = body?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  return choices.every((choice) => {
    const message = choice?.message || {};
    if (nonEmptyString(message.content)) return false;
    if (nonEmptyString(message.reasoning_content) || nonEmptyString(message.reasoning)) return false;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
    if (Array.isArray(message.images) && message.images.length > 0) return false;
    return true;
  });
}

/**
 * The message an empty completion must surface as, or null when the provider
 * did not opt in / the body carries real output.
 *
 * @param {object} body - Chat-completion response body
 * @param {{provider: string, model: string}} ctx
 * @returns {string|null}
 */
export function emptyCompletionError(body, { provider, model } = {}) {
  if (!provider || !PROVIDERS[provider]?.quirks?.rejectEmptyCompletion) return null;
  if (!isEmptyCompletion(body)) return null;
  return `Provider returned an empty completion (no content, no images, no tool calls) for ${model}`;
}

import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { HTTP_STATUS, STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildStreamErrorBytes } from "../../utils/streamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS, SSE_DONE } from "../../utils/sseConstants.js";
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.js";
import { unwrapClineEnvelope } from "../../shared/clineEnvelope.js";
import { dedupeImages } from "../../utils/imageDedupe.js";
import { emptyCompletionError } from "../../utils/completionGuard.js";
import { withProviderContext } from "../../utils/error.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

/**
 * Re-encode a JSON chat-completion body as a valid SSE stream.
 *
 * One `data:` frame holding the completion, then the terminal `[DONE]` — the
 * same shape a streaming provider would have produced, so every downstream
 * SSE transform in stream.js treats it identically.
 *
 * @param {object} completion - Body with a `choices` array
 * @returns {string} SSE bytes
 */
export function buildSSEFromCompletion(completion) {
  return `data: ${JSON.stringify(completion)}\n\n${SSE_DONE}`;
}

/**
 * Re-encode a JSON completion as a real `chat.completion.chunk` sequence.
 *
 * A single frame carrying a whole `chat.completion` is legal SSE but not what a
 * streaming client reads: the OpenAI SDK and every `delta`-based reader look at
 * `choices[0].delta`, so text and `images[]` were invisible to them even though
 * the bytes were on the wire. This splits the completion the way an upstream
 * would have streamed it — role, content, images, then finish_reason + usage.
 *
 * @param {object} completion - Body with a `choices` array
 * @returns {string} SSE bytes ending in `[DONE]`
 */
export function buildSSEChunksFromCompletion(completion) {
  const choice = completion?.choices?.[0] || {};
  const message = choice.message || {};
  const base = {
    id: completion?.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: completion?.created || Math.floor(Date.now() / 1000),
    model: completion?.model,
  };
  const chunk = (delta, finishReason = null, extra = {}) => `data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  })}\n\n`;

  const frames = [chunk({ role: "assistant", content: "" })];
  if (typeof message.content === "string" && message.content.length > 0) {
    frames.push(chunk({ content: message.content }));
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    frames.push(chunk({ reasoning_content: message.reasoning_content }));
  }
  if (Array.isArray(message.images) && message.images.length > 0) {
    frames.push(chunk({ images: message.images }));
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    frames.push(chunk({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }));
  }
  frames.push(chunk({}, choice.finish_reason || "stop", completion?.usage ? { usage: completion.usage } : {}));
  frames.push(SSE_DONE);
  return frames.join("");
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, reqTag, log, credentials }) {
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: withProviderContext(`[${status}]: ${shortMsg}`, provider, model) } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  // Defense-in-depth: we asked for SSE but the upstream answered application/json.
  // Cline does exactly this for a plain OpenAI→OpenAI request whose body carried
  // no `stream` key — its {"success":true,"data":{…choices…}} envelope used to be
  // piped through the SSE transform, which forwarded raw lines verbatim and
  // appended a [DONE], handing the client an unparseable JSON body. Re-encode a
  // real completion as one SSE frame; anything else is a broken upstream → 502.
  //
  // This branch is also how a `nonStreamOnlyModels` provider serves an SSE
  // client (cline image models only carry the picture on the JSON body), so the
  // completion is normalized exactly like the JSON path: deduped, and an empty
  // one rejected instead of being streamed as a successful no-op.
  if (upstreamContentType.includes('application/json')) {
    const rawText = await providerResponse.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch { /* not JSON after all → broken path below */ }
    const completion = parsed ? unwrapClineEnvelope(parsed, provider) : null;
    if (Array.isArray(completion?.choices)) {
      dedupeImages(completion);
      const emptyCompletion = emptyCompletionError(completion, { provider, model });
      if (emptyCompletion) {
        const status = HTTP_STATUS.BAD_GATEWAY;
        const message = withProviderContext(`[${status}]: ${emptyCompletion}`, provider, model);
        if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · empty completion\n    ${emptyCompletion}`);
        streamController?.handleError?.(new Error("upstream returned an empty completion"));
        return {
          success: false,
          response: new Response(JSON.stringify({ error: { message } }), {
            status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          }),
        };
      }
      if (log?.debug) log.debug("STREAM", `${provider}/${model} | upstream JSON despite stream → re-encoded as SSE`);
      // Providers that declare `jsonToSseChunks` get a real chunk sequence, so a
      // delta-based client sees the content and images; everyone else keeps the
      // single-frame encoding this branch has always produced.
      const body = PROVIDERS[provider]?.quirks?.jsonToSseChunks
        ? buildSSEChunksFromCompletion(completion)
        : buildSSEFromCompletion(completion);
      return {
        success: true,
        response: new Response(body, {
          headers: { ...SSE_HEADERS, ...upstreamResponseHeaders(providerResponse.headers) },
        }),
      };
    }
    const status = HTTP_STATUS.BAD_GATEWAY;
    const shortMsg = (parsed
      ? `Upstream returned JSON instead of an SSE stream (no choices${completion?.error ? `: ${completion.error.message || completion.error}` : ""})`
      : "Upstream returned a body that is not an SSE stream").slice(0, 200);
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · JSON for a stream request\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | ${shortMsg}`);
    streamController?.handleError?.(new Error("upstream returned JSON for a stream request"));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: withProviderContext(`[${status}]: ${shortMsg}`, provider, model) } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials });

  // Terminal bytes when the stream aborts after HTTP 200 was already sent, so the
  // client sees a real error instead of a silently truncated stream.
  // Responses passthrough keeps its own response.failed shape; every other client
  // format gets the OpenAI error frame + [DONE], or `event: error` for Claude.
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough
    ? buildAbortedResponsesTerminalBytes
    : (message) => buildStreamErrorBytes(HTTP_STATUS.GATEWAY_TIMEOUT, message, sourceFormat);
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs);

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: { ...SSE_HEADERS, ...upstreamResponseHeaders(providerResponse.headers) } })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      pxpipe,
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    // Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));
  };

  return { onStreamComplete, streamDetailId };
}

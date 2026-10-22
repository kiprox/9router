export default {
  id: "cline",
  priority: 80,
  alias: "cl",
  uiAlias: "cl",
  display: {
    name: "Cline",
    icon: "smart_toy",
    color: "#5B9BD5",
    textIcon: "CL",
    website: "https://cline.bot",
    notice: {
      signupUrl: "https://cline.bot",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://api.cline.bot/api/v1/chat/completions",
    headers: {
      "HTTP-Referer": "https://cline.bot",
      "X-Title": "Cline",
    },
    // Non-stream chat completions come back wrapped in {"success":true,"data":{...}}.
    //
    // Image models are chat models whose picture rides in
    // `choices[].message.images[]` (data URI PNG). Measured 2026-10-22 through
    // this gateway against api.cline.bot:
    //   body with no stream key   → 200 + message.images[]   (the picture)
    //   body {"stream":false}     → 500 "empty response content"
    //   body {"stream":true}      → 200, delta.content only, images[] empty
    // So the picture lives on the NON-stream body and an explicit `stream:false`
    // is what breaks it. Hence:
    //   • nonStreamOnlyModels — never ask these models to stream; an SSE client
    //     still gets SSE, re-encoded from the JSON completion by
    //     handleStreamingResponse.
    //   • imageModels — the Images API adapter's "is this an image model" test.
    //   • omitStreamFlagWhenFalse — send no key at all rather than `false`, which
    //     is what returns 500 (the OpenAI spec default is already non-stream).
    //   • rejectEmptyCompletion — a 200 with no text, no images and no tool calls
    //     is an upstream failure, not a success (gemini-3-pro-image answers
    //     exactly that for every prompt), so it becomes an honest 502 naming
    //     provider+model instead of an empty 200.
    // No /g flag on any regex — a stateful .test() would skip every other request.
    // The pattern covers cline's image ids by BOTH spellings: the
    // `gemini-*-image` family and the `gemini-nano-banana-*` alias (the same
    // model under a name that never contains "image").
    quirks: {
      clineEnvelope: true,
      imageModels: /image|nano-?banana/i,
      nonStreamOnlyModels: /image|nano-?banana/i,
      omitStreamFlagWhenFalse: true,
      rejectEmptyCompletion: true,
      // An SSE client served from the JSON body must receive real
      // `chat.completion.chunk` frames — a delta-based reader (OpenAI SDK,
      // nanobot-ai) looks only at `choices[0].delta`, so a single whole-completion
      // frame carried the picture on the wire but left the client with nothing.
      jsonToSseChunks: true,
    },
    tokenUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      hooks: [
        "clineHeaders",
      ],
    },
  },
  models: [
    { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "openai/gpt-5.4", name: "GPT-5.4" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
    { id: "google/gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview" },
    { id: "kwaipilot/kat-coder-pro", name: "KAT Coder Pro" },
    // Image models answer as chat completions with the picture in
    // `message.images[]`; the Images API reaches them through
    // handlers/imageProviders/cline.js. No `size` param — the endpoint takes the
    // prompt only, so advertising a size would be a lie to the dashboard.
    { id: "google/gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image (Nano Banana)", kind: "image", params: ["n"] },
  ],
  serviceKinds: ["llm", "image"],
  // Images-API surface for this provider (no `/images/generations` upstream — the
  // adapter posts chat completions to transport.baseUrl instead).
  //   chatModel: model used when the request names none (or names a chat model)
  //   maxN:      cap on `n`, each value is one billed chat completion
  imageConfig: {
    chatModel: "google/gemini-2.5-flash-image",
    maxN: 4,
  },
  oauth: {
    appBaseUrl: "https://app.cline.bot",
    apiBaseUrl: "https://api.cline.bot",
    authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
    tokenExchangeUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
  },
};

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
    // Non-stream chat completions come back wrapped in {"success":true,"data":{...}}
    // Image models only answer the streaming variant: `stream:false` yields an
    // "empty response content" 500, so the stream decision must be forced to SSE
    // and converted back for JSON clients (chatCore handleForcedSSEToJson).
    // No /g flag — a stateful .test() would skip every other request.
    quirks: { clineEnvelope: true, forceStreamModels: /image/i },
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

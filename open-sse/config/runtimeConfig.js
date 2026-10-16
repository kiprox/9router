// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

function envStr(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// on | off | auto — anything else falls back to the default.
function envMode(name, def) {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "on" || raw === "off" || raw === "auto" ? raw : def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// OpenCode free-tier delegation: spawn the official `opencode serve` (v2 API)
// locally and route free-model requests through it. The upstream gate
// (FreeTierError 403) rejects every non-OpenCode client at the TLS/stack
// level, so the only working free-tier path is the official binary itself.
//   mode: on   — always delegate; infrastructure failures surface as errors
//   mode: auto — delegate when the local service is usable, else direct path
//   mode: off  — direct upstream path only (legacy behavior)
// Env: OPENCODE_DELEGATE (on|off|auto, default auto; Docker image sets on),
//      CLI_OPENCODE_BIN (default "opencode").
export const OPENCODE_DELEGATE_CONFIG = {
  mode: envMode("OPENCODE_DELEGATE", "auto"),
  bin: envStr("CLI_OPENCODE_BIN", "opencode"),
  startTimeoutMs: envMs("OPENCODE_DELEGATE_START_TIMEOUT_MS", 45 * 1000),
  idleKillMs: envMs("OPENCODE_DELEGATE_IDLE_KILL_MS", 10 * 60 * 1000),
  runTimeoutMs: envMs("OPENCODE_DELEGATE_RUN_TIMEOUT_MS", 15 * 60 * 1000),
  pollIntervalMs: envMs("OPENCODE_DELEGATE_POLL_MS", 400),
  modelCacheTtlMs: envMs("OPENCODE_DELEGATE_MODEL_TTL_MS", 10 * 60 * 1000),
  maxConversations: envMs("OPENCODE_DELEGATE_MAX_CONVERSATIONS", 500),
  maxReplayTurns: envMs("OPENCODE_DELEGATE_MAX_REPLAY_TURNS", 40),
  // Session-level deny rules (last-match-wins over the base allow policy).
  // deny-all strips every tool from the provider request and the free-tier
  // gate then answers 403 FreeTierError (it fingerprints the tool list), so
  // only side-effecting actions are denied — read/glob/grep stay listed and
  // the gate stays green. Denied tools are removed from the model's tool
  // list up front, so no permission pump is needed either. Proof (POC
  // v2.0.29): deny-all → 403; these denies → 200 + outcome succeeded.
  denyActions: [
    "shell",
    "edit",
    "webfetch",
    "websearch",
    "subagent",
    "execute",
    "question",
    "skill",
    "external_directory",
  ],
};

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

export const TOKEN_SAVER_HEADER = "x-9router-token-saver";

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];

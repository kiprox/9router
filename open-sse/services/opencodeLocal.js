// OpenCode free-tier delegation — spawns the official `opencode serve` (v2 API)
// locally and replays gateway requests through it.
//
// Why: the upstream free-tier gate (FreeTierError 403) fingerprints the client
// transport at the TLS/h2-stack level; every hand-crafted client (Node, Bun,
// curl, byte-identical captures) is rejected while the official binary passes
// with cost $0. Verified against opencode v2.0.29 in POC:
//   - Basic auth `opencode:$OPENCODE_PASSWORD`, /api/* routes (see /v2/openapi.json)
//   - session prompt is an async inbox (POST /api/session/{id}/prompt → 200/409),
//     completion verdict arrives as an `idle` message with outcome+error
//   - session-level `permissions` ruleset: deny-all strips every tool from the
//     provider request and the gate then 403s; denying only the side-effecting
//     actions keeps read/glob/grep listed and the gate green (see
//     OPENCODE_DELEGATE_CONFIG.denyActions) — no permission pump needed
//   - assistant.content = ordered parts: reasoning | text | tool
//
// Output contract: we synthesize an OpenAI chat.completion.chunk SSE stream and
// declare responseFormat = FORMATS.OPENAI, so chatCore's translator renders any
// client format (openai/claude/responses/...).

import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import { OPENCODE_DELEGATE_CONFIG, MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { FORMATS } from "../translator/formats.js";
import { DATA_DIR } from "@/lib/dataDir.js";
import { dbg } from "../utils/debugLog.js";

const TAG = "OCDELEGATE";
const PROVIDER_ID = "opencode";
const VARIANTS = new Set(["default", "none", "minimal", "low", "medium", "high", "xhigh"]);

const DENY_RULESET = OPENCODE_DELEGATE_CONFIG.denyActions.map((action) => ({
  action,
  resource: "*",
  effect: "deny",
}));

// Service singleton state.
const svc = {
  proc: null,
  port: 0,
  password: "",
  baseUrl: "",
  ready: false,
  starting: null,
  lastUsedAt: 0,
  lastCheckAt: 0,
  failures: 0,
  nextAttemptAt: 0,
  activeRuns: 0,
};
let idleTimer = null;
let conversationTimer = null;
let modelCache = { at: 0, ids: null };

// sessionKey → { sessionId, turns: string[], variant, lastUsed }
// `turns` mirrors the client-visible conversation (role + text + image uris),
// which is exactly what the next request's history must prefix-match against.
const conversations = new Map();

export class DelegateError extends Error {
  constructor(message, { cause, fallback = true } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DelegateError";
    // fallback=true → auto mode may fall back to the direct upstream path.
    this.delegateFallback = fallback;
  }
}

export function delegateMode() {
  return OPENCODE_DELEGATE_CONFIG.mode;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function abortError() {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function trunc(value, max) {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function cleanModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function resolveBin() {
  const name = OPENCODE_DELEGATE_CONFIG.bin;
  if (name.includes("/") || name.includes("\\")) {
    return fs.existsSync(name) ? name : null;
  }
  const isWin = process.platform === "win32";
  const exts = isWin ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, isWin && !name.toUpperCase().endsWith(ext.toUpperCase()) ? `${name}${ext}` : name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* next */ }
    }
  }
  return null;
}

function delegateRoot() {
  return path.join(DATA_DIR, "runtime", "opencode-free");
}

function serviceEnv(password) {
  const root = delegateRoot();
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("OPENCODE_")) env[key] = value;
  }
  env.HOME = path.join(root, "home");
  env.XDG_CONFIG_HOME = path.join(root, "config");
  env.XDG_DATA_HOME = path.join(root, "data");
  env.XDG_STATE_HOME = path.join(root, "state");
  env.XDG_CACHE_HOME = path.join(root, "cache");
  env.OPENCODE_PASSWORD = password;
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  env.OPENCODE_DISABLE_FILEWATCHER = "1";
  env.OPENCODE_LOG_LEVEL = "warn";
  return env;
}

function authHeader() {
  return `Basic ${Buffer.from(`opencode:${svc.password}`).toString("base64")}`;
}

async function ocFetch(pathname, { method = "GET", body, timeoutMs = 20000 } = {}) {
  if (!svc.ready || !svc.baseUrl) throw new DelegateError("opencode serve not ready");
  let res;
  try {
    res = await fetch(svc.baseUrl + pathname, {
      method,
      headers: {
        authorization: authHeader(),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new DelegateError(`opencode serve unreachable: ${err.message}`, { cause: err });
  }
  if (res.status === 401) {
    throw new DelegateError("opencode serve rejected auth (password mismatch)", { fallback: false });
  }
  const raw = res.status === 204 ? "" : await res.text().catch(() => "");
  let json = null;
  if (raw) {
    try { json = JSON.parse(raw); } catch { /* keep raw */ }
  }
  return { status: res.status, json, raw };
}

function markBroken(reason, proc = null) {
  dbg(TAG, `service broken: ${reason}`);
  svc.ready = false;
  if (proc && proc === svc.proc) svc.proc = null;
  else if (svc.proc && !reason?.toString().startsWith("idle")) {
    try { svc.proc.kill("SIGKILL"); } catch { /* already dead */ }
    svc.proc = null;
  }
  svc.failures = Math.min(svc.failures + 1, 8);
  const backoff = Math.min(30000 * 2 ** (svc.failures - 1), 5 * 60 * 1000);
  svc.nextAttemptAt = Date.now() + backoff;
}

function stopService(reason) {
  if (!svc.proc) {
    svc.ready = false;
    return;
  }
  dbg(TAG, `stopping serve (${reason})`);
  const proc = svc.proc;
  svc.proc = null;
  svc.ready = false;
  try { proc.kill("SIGTERM"); } catch { /* gone */ }
  const killer = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
  }, 5000);
  if (killer.unref) killer.unref();
}

function startIdleWatcher() {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    if (!svc.ready || svc.activeRuns > 0) return;
    if (Date.now() - svc.lastUsedAt > OPENCODE_DELEGATE_CONFIG.idleKillMs) {
      stopService("idle timeout");
    }
  }, 30000);
  if (idleTimer.unref) idleTimer.unref();
}

function startConversationCleanup() {
  if (conversationTimer) return;
  conversationTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, conv] of conversations) {
      if (now - conv.lastUsed > MEMORY_CONFIG.sessionTtlMs) conversations.delete(key);
    }
    while (conversations.size > OPENCODE_DELEGATE_CONFIG.maxConversations) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, conv] of conversations) {
        if (conv.lastUsed < oldestAt) {
          oldestAt = conv.lastUsed;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      const retired = conversations.get(oldestKey);
      conversations.delete(oldestKey);
      retireSession(retired?.sessionId);
    }
  }, MEMORY_CONFIG.sessionCleanupIntervalMs);
  if (conversationTimer.unref) conversationTimer.unref();
}

async function startService() {
  const bin = resolveBin();
  if (!bin) {
    throw new DelegateError(`opencode binary not found (CLI_OPENCODE_BIN="${OPENCODE_DELEGATE_CONFIG.bin}")`);
  }
  const root = delegateRoot();
  for (const sub of ["home", "config", "data", "state", "cache", "work", "logs"]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  svc.password = crypto.randomBytes(18).toString("base64url");
  svc.port = await freePort();
  svc.baseUrl = `http://127.0.0.1:${svc.port}`;

  let proc;
  try {
    proc = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(svc.port)], {
      cwd: path.join(root, "work"),
      env: serviceEnv(svc.password),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new DelegateError(`failed to spawn opencode serve: ${err.message}`, { cause: err });
  }
  svc.proc = proc;
  svc.ready = false;
  let logLines = 0;
  const onLine = (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      if (logLines < 40) {
        logLines++;
        dbg(TAG, `serve: ${line.slice(0, 240)}`);
      }
    }
  };
  proc.stdout?.on("data", onLine);
  proc.stderr?.on("data", onLine);
  proc.on("error", (err) => markBroken(`spawn error: ${err.message}`, proc));
  proc.on("exit", (code, sig) => {
    if (svc.proc !== proc) return;
    svc.ready = false;
    svc.proc = null;
    markBroken(`serve exited code=${code} sig=${sig}`);
  });

  const deadline = Date.now() + OPENCODE_DELEGATE_CONFIG.startTimeoutMs;
  while (Date.now() < deadline) {
    if (svc.proc !== proc) {
      throw new DelegateError("opencode serve exited during startup");
    }
    try {
      const res = await fetch(`${svc.baseUrl}/api/info`, {
        headers: { authorization: authHeader() },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        svc.ready = true;
        svc.failures = 0;
        svc.nextAttemptAt = 0;
        svc.lastUsedAt = Date.now();
        svc.lastCheckAt = Date.now();
        startIdleWatcher();
        startConversationCleanup();
        dbg(TAG, `serve ready on ${svc.baseUrl} (pid ${proc.pid})`);
        return;
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  stopService("start timeout");
  throw new DelegateError(`opencode serve not ready within ${OPENCODE_DELEGATE_CONFIG.startTimeoutMs}ms`);
}

async function ensureService() {
  if (svc.ready) {
    if (Date.now() - svc.lastCheckAt > 15000) {
      svc.lastCheckAt = Date.now();
      try {
        const res = await fetch(`${svc.baseUrl}/api/info`, {
          headers: { authorization: authHeader() },
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) markBroken(`health ${res.status}`);
      } catch (err) {
        markBroken(`health: ${err.message}`);
      }
    }
    if (svc.ready) return;
  }
  if (Date.now() < svc.nextAttemptAt) {
    throw new DelegateError(`opencode serve backoff (${Math.round((svc.nextAttemptAt - Date.now()) / 1000)}s left)`);
  }
  if (!svc.starting) {
    svc.starting = startService().finally(() => { svc.starting = null; });
  }
  await svc.starting;
}

function touch() {
  svc.lastUsedAt = Date.now();
}

async function getModelIds() {
  if (modelCache.ids && Date.now() - modelCache.at < OPENCODE_DELEGATE_CONFIG.modelCacheTtlMs) {
    return modelCache.ids;
  }
  const { status, json } = await ocFetch("/api/model");
  if (status !== 200 || !Array.isArray(json?.data)) {
    throw new DelegateError(`model list failed: HTTP ${status}`);
  }
  modelCache = { at: Date.now(), ids: new Set(json.data.map((m) => m?.id).filter(Boolean)) };
  return modelCache.ids;
}

async function createSession(modelId, variant) {
  const { status, json, raw } = await ocFetch("/api/session", {
    method: "POST",
    body: {
      model: { id: modelId, providerID: PROVIDER_ID, variant },
      permissions: DENY_RULESET,
    },
  });
  const sessionId = json?.data?.id;
  if (status !== 200 || !sessionId) {
    throw new DelegateError(`session create failed: HTTP ${status} ${trunc(raw, 200)}`);
  }
  return sessionId;
}

async function switchVariant(sessionId, modelId, variant) {
  try {
    await ocFetch(`/api/session/${sessionId}/model`, {
      method: "POST",
      body: { model: { id: modelId, providerID: PROVIDER_ID, variant } },
      timeoutMs: 8000,
    });
  } catch (err) {
    dbg(TAG, `variant switch failed (ignored): ${err.message}`);
  }
}

async function retireSession(sessionId) {
  if (!sessionId) return;
  try {
    await ocFetch(`/api/session/${sessionId}`, { method: "DELETE", timeoutMs: 5000 });
  } catch { /* best-effort */ }
}

async function getMessages(sessionId) {
  const { status, json, raw } = await ocFetch(`/api/session/${sessionId}/message`);
  if (status !== 200 || !Array.isArray(json?.data)) {
    throw new DelegateError(`message list failed: HTTP ${status} ${trunc(raw, 160)}`);
  }
  return json.data;
}

async function getSessionInfo(sessionId) {
  const { status, json } = await ocFetch(`/api/session/${sessionId}`);
  if (status !== 200) throw new DelegateError(`session get failed: HTTP ${status}`);
  return json?.data || null;
}

async function interruptSession(sessionId) {
  try {
    await ocFetch(`/api/session/${sessionId}/interrupt`, { method: "POST", timeoutMs: 4000 });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Request body → ordered conversation turns
// ---------------------------------------------------------------------------

function textFromContent(content, images) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return typeof content === "object" ? content.text || "" : String(content);
  let out = "";
  for (const part of content) {
    if (part == null) continue;
    if (typeof part === "string") { out += part; continue; }
    if (typeof part !== "object") continue;
    switch (part.type) {
      case "text":
      case "input_text":
      case "output_text":
        out += part.text || "";
        break;
      case "image_url": {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (url) images.push(url);
        break;
      }
      case "input_image": {
        const url = part.image_url || part.url;
        if (url) images.push(url);
        break;
      }
      case "image": {
        const src = part.source || {};
        const url = src.type === "base64" && src.data
          ? `data:${src.media_type || "image/png"};base64,${src.data}`
          : src.url;
        if (url) images.push(url);
        break;
      }
      case "tool_use":
        out += `\n[tool ${part.name} ${trunc(part.input, 400)}]`;
        break;
      case "tool_result":
        out += `\n[tool_result ${trunc(typeof part.content === "string" ? part.content : part.content, 600)}]`;
        break;
      case "function_call":
        out += `\n[tool ${part.name} ${trunc(part.arguments, 400)}]`;
        break;
      case "function_call_output":
        out += `\n[tool_result ${trunc(part.output, 600)}]`;
        break;
      case "reasoning":
      case "thinking":
        break;
      default:
        if (typeof part.text === "string") out += part.text;
    }
  }
  return out;
}

// Returns ordered turns [{ role, text, images[] }] or null when the body is
// not a chat-shaped payload (systemone / image-gen / …) → caller runs direct.
export function extractTurns(body) {
  if (!body || typeof body !== "object") return null;
  const turns = [];
  if (Array.isArray(body.messages) && body.messages.length) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== "object") continue;
      const images = [];
      const text = textFromContent(msg.content, images);
      turns.push({ role: typeof msg.role === "string" ? msg.role : "user", text, images });
    }
  } else if (Array.isArray(body.input) && body.input.length) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "message") {
        const images = [];
        const text = textFromContent(item.content, images);
        turns.push({ role: item.role || "user", text, images });
      } else if (item.type === "function_call") {
        turns.push({ role: "assistant", text: `[tool ${item.name} ${trunc(item.arguments, 400)}]`, images: [] });
      } else if (item.type === "function_call_output") {
        turns.push({ role: "tool", text: `[tool_result ${trunc(item.output, 600)}]`, images: [] });
      }
    }
  }
  if (!turns.length) return null;
  if (!turns.some((t) => t.text.trim() || t.images.length)) return null;

  const lead = [];
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  if (instructions) lead.push({ role: "system", text: instructions, images: [] });
  const system = typeof body.system === "string"
    ? body.system.trim()
    : Array.isArray(body.system) ? textFromContent(body.system, []).trim() : "";
  if (system) lead.push({ role: "system", text: system, images: [] });
  return lead.length ? [...lead, ...turns] : turns;
}

function extractVariant(body) {
  const raw = typeof body?.reasoning_effort === "string"
    ? body.reasoning_effort
    : typeof body?.reasoning?.effort === "string"
      ? body.reasoning.effort
      : body?.thinking?.type === "enabled"
        ? "high"
        : "";
  const variant = String(raw || "").toLowerCase().trim();
  if (!variant) return "default";
  if (variant === "max" || variant === "ultra") return "xhigh";
  return VARIANTS.has(variant) ? variant : "default";
}

function turnKey(turn) {
  return JSON.stringify([turn.role, turn.text || "", turn.images || []]);
}

function commonPrefixLen(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function foldFreshPrompt(turns) {
  const systemText = turns
    .filter((t) => t.role === "system")
    .map((t) => t.text)
    .join("\n\n")
    .trim();
  const last = turns[turns.length - 1];
  let text = last.text || "";
  if (systemText) text = `System instructions:\n${systemText}\n\n${text}`;
  return { text, images: [...(last.images || [])] };
}

function foldReplayPrompt(turns) {
  const max = OPENCODE_DELEGATE_CONFIG.maxReplayTurns;
  const slice = turns.length > max ? turns.slice(-max) : turns;
  const lines = [];
  slice.forEach((turn, index) => {
    const label = turn.role === "system"
      ? "System"
      : turn.role === "assistant"
        ? "Assistant"
        : turn.role === "tool"
          ? "Tool result"
          : "User";
    let block = `${label}:\n${turn.text || ""}`;
    const isLast = index === slice.length - 1;
    if (turn.images?.length) {
      block += isLast
        ? "\n(images attached)"
        : `\n[${turn.images.length} image(s) omitted in replay]`;
    }
    lines.push(block);
  });
  const lastTurn = slice[slice.length - 1];
  return {
    text: lines.join("\n\n"),
    images: lastTurn?.images?.length && lastTurn.role !== "system" ? [...lastTurn.images] : [],
  };
}

function buildFiles(uris) {
  if (!uris?.length) return undefined;
  const unique = [...new Set(uris)].slice(0, 8);
  return unique.map((uri, index) => ({ uri, name: `image-${index + 1}.png` }));
}

function stablePromptId(sessionId, requestId) {
  const digest = crypto
    .createHash("sha256")
    .update(`oc-delegate-prompt\0${sessionId}\0${requestId || ""}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let randomPart = "";
  for (let i = 6; i < 20; i++) randomPart += base62[digest[i] % 62];
  return `msg_${timeHex}${randomPart}`;
}

// ---------------------------------------------------------------------------
// Pump: poll session messages → OpenAI chunk SSE
// ---------------------------------------------------------------------------

function calcUsage(base, end) {
  const tokens = end?.tokens;
  if (!tokens || !base?.tokens) return null;
  const prompt = (tokens.input || 0) + (tokens.cache?.read || 0)
    - ((base.tokens.input || 0) + (base.tokens.cache?.read || 0));
  const completion = (tokens.output || 0) + (tokens.reasoning || 0)
    - ((base.tokens.output || 0) + (base.tokens.reasoning || 0));
  const promptTokens = Math.max(0, prompt);
  const completionTokens = Math.max(0, completion);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function buildPumpStream({ sessionId, promptId, promptAt, model, tokenBase, signal, key, promptTurns }) {
  const encoder = new TextEncoder();
  const chunkId = `chatcmpl-${promptId.replace(/^msg_/, "")}`;
  const created = Math.floor(Date.now() / 1000);
  const runDeadline = Date.now() + OPENCODE_DELEGATE_CONFIG.runTimeoutMs;
  const emitted = new Map();
  let closed = false;
  let roleSent = false;

  const makeChunk = (delta, finish = null, usage = null) => JSON.stringify({
    id: chunkId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });

  const frame = (payload) => `data: ${payload}\n\n`;

  return new ReadableStream({
    async start(controller) {
      svc.activeRuns++;
      touch();
      const enqueue = (payload) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(frame(payload))); } catch { closed = true; }
      };
      const closeQuiet = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };
      const fail = (err) => {
        if (closed) return;
        closed = true;
        try { controller.error(err); } catch { /* already closed */ }
      };
      let pollFailures = 0;
      let assistantText = "";
      try {
        if (signal?.aborted) throw abortError();
        if (!roleSent) {
          enqueue(makeChunk({ role: "assistant", content: "" }));
          roleSent = true;
        }
        for (;;) {
          if (signal?.aborted) throw abortError();
          if (Date.now() > runDeadline) {
            throw new DelegateError(`delegate run exceeded ${OPENCODE_DELEGATE_CONFIG.runTimeoutMs}ms`, { fallback: false });
          }
          await sleep(OPENCODE_DELEGATE_CONFIG.pollIntervalMs, signal);

          let chrono;
          try {
            const msgs = await getMessages(sessionId);
            pollFailures = 0;
            chrono = [...msgs].reverse(); // newest-first → chronological
          } catch (err) {
            pollFailures++;
            if (pollFailures >= 5) throw err;
            continue;
          }

          const anchor = chrono.findIndex((m) => m.id === promptId);
          const scope = anchor >= 0
            ? chrono.slice(anchor + 1)
            : chrono.filter((m) => (m.time?.created || 0) >= promptAt - 1500);
          const runMsgs = [];
          for (const msg of scope) {
            if (msg.type === "user") break;
            runMsgs.push(msg);
          }

          for (const msg of runMsgs) {
            if (msg.type !== "assistant" || !Array.isArray(msg.content)) continue;
            msg.content.forEach((part, index) => {
              if (!part || typeof part !== "object") return;
              const isReasoning = part.type === "reasoning" && typeof part.text === "string" && part.text;
              const isText = part.type === "text" && typeof part.text === "string" && part.text;
              if (!isReasoning && !isText) return;
              const partKey = `${msg.id}:${index}:${isReasoning ? "r" : "t"}`;
              const prevLen = emitted.get(partKey) || 0;
              if (part.text.length <= prevLen) return;
              const delta = part.text.slice(prevLen);
              emitted.set(partKey, part.text.length);
              enqueue(makeChunk(isReasoning ? { reasoning_content: delta } : { content: delta }));
              if (isText) assistantText += delta;
            });
          }

          const terminal = chrono.find(
            (m) => m.type === "idle" && (m.time?.created || 0) >= promptAt - 1500,
          );
          if (terminal) {
            if (terminal.outcome === "failed") {
              const error = terminal.error || {};
              throw new DelegateError(
                `opencode run failed: ${error.type || "unknown"} — ${error.message || "no detail"}`,
                { fallback: false },
              );
            }
            // Final sync for anything that landed between polls, then finish.
            try {
              const msgs = await getMessages(sessionId);
              const chronoFinal = [...msgs].reverse();
              const anchorFinal = chronoFinal.findIndex((m) => m.id === promptId);
              const scopeFinal = anchorFinal >= 0 ? chronoFinal.slice(anchorFinal + 1) : chronoFinal;
              for (const msg of scopeFinal) {
                if (msg.type === "user") break;
                if (msg.type !== "assistant" || !Array.isArray(msg.content)) continue;
                msg.content.forEach((part, index) => {
                  if (!part || typeof part !== "object") return;
                  const isReasoning = part.type === "reasoning" && typeof part.text === "string" && part.text;
                  const isText = part.type === "text" && typeof part.text === "string" && part.text;
                  if (!isReasoning && !isText) return;
                  const partKey = `${msg.id}:${index}:${isReasoning ? "r" : "t"}`;
                  const prevLen = emitted.get(partKey) || 0;
                  if (part.text.length <= prevLen) return;
                  const delta = part.text.slice(prevLen);
                  emitted.set(partKey, part.text.length);
                  enqueue(makeChunk(isReasoning ? { reasoning_content: delta } : { content: delta }));
                  if (isText) assistantText += delta;
                });
              }
            } catch (err) {
              dbg(TAG, `final sync failed: ${err.message}`);
            }

            let usage = null;
            try {
              const end = await getSessionInfo(sessionId);
              usage = calcUsage(tokenBase, end);
            } catch (err) {
              dbg(TAG, `usage fetch failed: ${err.message}`);
            }
            enqueue(makeChunk({}, "stop", usage));
            if (!closed) {
              try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); } catch { closed = true; }
            }
            recordConversation(key, sessionId, promptTurns, assistantText);
            closeQuiet();
            return;
          }
        }
      } catch (err) {
        if (err?.name === "AbortError") {
          // Client went away (or stall watchdog fired): stop the agent loop and
          // drop the conversation — the session may hold a partial turn the
          // client never saw, so the next request must cold-replay.
          interruptSession(sessionId);
          if (key) conversations.delete(key);
          closeQuiet();
        } else {
          dbg(TAG, `run error: ${err?.message}`);
          fail(err instanceof DelegateError ? err : new DelegateError(err?.message || String(err), { cause: err, fallback: false }));
        }
      } finally {
        svc.activeRuns--;
        touch();
      }
    },
    cancel() {
      // pipeWithDisconnect cancels on client disconnect; the pump notices via signal.
    },
  });
}

function recordConversation(key, sessionId, promptTurns, assistantText) {
  if (!key || !sessionId) return;
  const assistantTurn = turnKey({ role: "assistant", text: assistantText, images: [] });
  const incoming = (promptTurns || []).map(turnKey);
  const existing = conversations.get(key);
  let turns;
  if (existing && existing.sessionId === sessionId) {
    turns = [...existing.turns, ...incoming, assistantTurn];
  } else {
    turns = [...incoming, assistantTurn];
  }
  conversations.set(key, {
    sessionId,
    turns,
    variant: existing?.sessionId === sessionId ? existing.variant : undefined,
    lastUsed: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Try to serve a gateway request through the local OpenCode service.
 * @returns {Promise<object|null>} executor result, or null when the request
 *   is not delegatable (caller falls back to the direct path).
 * @throws {DelegateError} on infrastructure failures (auto mode may catch
 *   those and fall back — see executor).
 */
export async function executeDelegated({ model, body, credentials, signal, log, requestId, sessionKey }) {
  if (delegateMode() === "off") return null;
  const turns = extractTurns(body);
  if (!turns) return null;
  const modelId = cleanModelId(model);
  if (!modelId) return null;

  try {
    await ensureService();
    const ids = await getModelIds();
    if (!ids.has(modelId)) {
      dbg(TAG, `model ${modelId} not served by local opencode → direct path`);
      return null;
    }
  } catch (err) {
    if (err instanceof DelegateError) throw err;
    throw new DelegateError(err?.message || String(err), { cause: err });
  }
  touch();

  const variant = extractVariant(body);
  const key = sessionKey || "opencode:default";
  let conv = conversations.get(key) || null;
  let sessionId;
  let promptText;
  let promptImages;
  let promptTurns;

  if (conv?.sessionId) {
    const prefix = commonPrefixLen(conv.turns, turns.map(turnKey));
    if (prefix === conv.turns.length) {
      // Stored conversation is a prefix of the incoming history → delta prompt.
      const remaining = turns.slice(prefix);
      sessionId = conv.sessionId;
      if (variant !== (conv.variant || "default")) {
        await switchVariant(sessionId, modelId, variant);
        conv.variant = variant;
      }
      if (remaining.length) {
        const texts = [];
        promptImages = [];
        for (const turn of remaining) {
          if (turn.role === "system") continue; // delivered when the session started
          if (turn.role === "assistant") texts.push(`Assistant:\n${turn.text}`);
          else if (turn.role === "tool") texts.push(`Tool result:\n${turn.text}`);
          else texts.push(turn.text);
          promptImages.push(...(turn.images || []));
        }
        promptText = texts.join("\n\n");
        promptTurns = remaining.filter((t) => t.role !== "system");
      } else {
        // Identical replay of the stored history (client retry) → resend last turn.
        const lastUser = [...turns].reverse().find((t) => t.role !== "system") || turns[turns.length - 1];
        promptText = lastUser.text;
        promptImages = [...(lastUser.images || [])];
        promptTurns = [];
      }
    } else {
      // History diverged (edit/rewind/new client) → cold-replay in a fresh session.
      dbg(TAG, `history mismatch at turn ${prefix}/${conv.turns.length} → replay`);
      retireSession(conv.sessionId);
      conversations.delete(key);
      conv = null;
    }
  }

  if (!conv) {
    sessionId = await createSession(modelId, variant);
    const folded = turns.length <= 2 ? foldFreshPrompt(turns) : foldReplayPrompt(turns);
    promptText = folded.text;
    promptImages = folded.images;
    promptTurns = turns;
  }

  if (!promptText || !promptText.trim()) promptText = "(empty)";

  const promptId = stablePromptId(sessionId, requestId);
  let tokenBase = null;
  try { tokenBase = await getSessionInfo(sessionId); } catch { /* usage optional */ }
  const promptAt = Date.now();

  const { status, raw } = await ocFetch(`/api/session/${sessionId}/prompt`, {
    method: "POST",
    body: {
      id: promptId,
      text: promptText,
      ...(promptImages.length ? { files: buildFiles(promptImages) } : {}),
    },
  });
  if (status !== 200 && status !== 409) {
    throw new DelegateError(`prompt rejected: HTTP ${status} ${trunc(raw, 200)}`);
  }
  touch();

  log?.debug?.("DELEGATE", `opencode serve | model=${modelId} | session=${sessionId} | prompt=${status}`);

  const stream = buildPumpStream({
    sessionId,
    promptId,
    promptAt,
    model,
    tokenBase,
    signal,
    key,
    promptTurns,
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-opencode-delegate": "local",
      },
    }),
    url: `${svc.baseUrl}/api/session/${sessionId}`,
    headers: { "content-type": "text/event-stream", "x-opencode-delegate": "local" },
    transformedBody: body,
    responseFormat: FORMATS.OPENAI,
  };
}

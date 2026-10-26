import { randomUUID, createHash } from "node:crypto";
import { resolveSessionId } from "../utils/sessionManager.js";

/**
 * Deterministic UUID-shaped id for a stable string key.
 *
 * The gateway expects the conversation id to look like a UUID; deriving it from
 * the session key keeps it identical across turns without any server-side state.
 *
 * The version/variant nibbles are set explicitly (RFC 4122 v5 shape): slicing 32
 * raw hex chars leaves them random, so the result was not a valid UUID — roughly
 * 15/16 of ids carried a bogus version and 3/4 a bogus variant. Anything that
 * validates the id shape (a stricter gateway, a proxy, a log parser) would reject
 * those, so stamp them instead of relying on the hash.
 */
function uuidV5Like(key) {
  const hex = createHash("sha256").update(key).digest("hex");
  const version = ((parseInt(hex.slice(12, 16), 16) & 0x0fff) | 0x5000).toString(16).padStart(4, "0");
  const variant = ((parseInt(hex.slice(16, 20), 16) & 0x3fff) | 0x8000).toString(16).padStart(4, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    version,
    variant,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Read a header case-insensitively.
 *
 * HTTP header names are case-insensitive, but a plain-object lookup is not: the
 * previous `headers["x-conversation-id"] || headers["X-Conversation-ID"]` check
 * missed every other spelling (`X-Conversation-Id`, `x-Conversation-ID`), so a
 * client that sent one of those had its conversation affinity silently replaced
 * by a derived id — new conversation every turn, cold prompt cache.
 *
 * Also accepts a fetch `Headers` instance (its get() is already
 * case-insensitive), and treats a blank/whitespace value as absent: an empty
 * header is not a conversation id, and forwarding "   " upstream is worse than
 * deriving one.
 */
function readHeader(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return null;
  const value = headers[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * CodeBuddy channel-verification headers.
 *
 * Tencent's gateway recently started enforcing `code 11128 "conversation id
 * missing"` + "This call failed channel verification, possibly because it was
 * not sent from an official client" on /v2/chat/completions. The official
 * CLI/IDE sends a conversation family + identity headers that 9router was not
 * forwarding (we only sent UA / X-Product / X-IDE-Type / X-IDE-Name /
 * x-codebuddy-request). Reference impls: codebuddy2api's
 * generate_codebuddy_headers, orangeboyChen/codebuddy2api buildUpstreamHeaders,
 * minglo/opencode-codebuddy-oauth src/headers.ts (22 headers).
 *
 * Minimal set that satisfies the check without mimicking SDK fingerprints
 * (x-stainless-* belong to the OpenAI JS SDK, not the official CLI, so we
 * deliberately do NOT send them):
 *   X-Domain, X-User-Id (+ X-Tenant-Id / X-Enterprise-Id when the JWT carries
 *   them), X-Conversation-ID, X-Conversation-Request-ID,
 *   X-Conversation-Message-ID, X-Request-ID, X-Agent-Intent: craft,
 *   X-IDE-Version (matches the registry User-Agent version).
 *
 * API-key mode (ck_xxx, opaque — no JWT to decode): skip the identity headers,
 * same as the minglo plugin.
 */

function decodeJwtPayload(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function hex16() {
  try {
    // Node 20+: crypto.getRandomValues available; fallback to randomUUID.
    const buf = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
    return buf.toString("hex").slice(0, 32);
  } catch {
    return randomUUID().replace(/-/g, "");
  }
}

function pickFirst(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Derive the client version from the User-Agent the request actually sends
 * (`CLI/2.108.1 CodeBuddy/2.108.1` → `2.108.1`).
 *
 * X-IDE-Version must agree with the UA: the gateway cross-checks the two, so a
 * hardcoded copy silently goes stale the moment the registry UA is bumped and
 * every request then fails channel verification (11128 "request illegal").
 */
function versionFromUserAgent(userAgent) {
  if (typeof userAgent !== "string") return null;
  const match = userAgent.match(/CodeBuddy\/([0-9][0-9.]*)/) || userAgent.match(/\/([0-9][0-9.]*)/);
  return match ? match[1] : null;
}

/**
 * Build the official-client headers for one chat request.
 * @param {object} opts
 * @param {string} opts.domain - "copilot.tencent.com" (CN) or "www.codebuddy.ai" (intl)
 * @param {object} opts.credentials - executor credentials ({ accessToken, apiKey, rawHeaders, providerSpecificData })
 * @param {object} [opts.body] - transformed OpenAI body (for conversation affinity via body.conversation_id)
 * @param {object} [opts.headers] - headers already built by the executor (source of UA + X-Conversation-ID)
 */
export function buildCodeBuddyHeaders({ domain, credentials, body, headers: builtHeaders = null }) {
  const headers = {};

  if (domain) headers["X-Domain"] = domain;
  headers["X-Agent-Intent"] = "craft";

  // Mirror the UA version instead of hardcoding it (see versionFromUserAgent).
  const userAgent =
    readHeader(builtHeaders, "User-Agent") || readHeader(credentials?.rawHeaders, "User-Agent");
  const version = versionFromUserAgent(userAgent);
  if (version) headers["X-IDE-Version"] = version;

  // Conversation family: reuse the caller's affinity when present so prompt
  // cache stays warm across turns; otherwise derive a stable id for this
  // conversation (fixes 11128). Both header bags are read case-insensitively —
  // see readHeader.
  const incoming = credentials?.rawHeaders || {};
  const incomingConv =
    readHeader(incoming, "X-Conversation-ID") || readHeader(builtHeaders, "X-Conversation-ID");
  const bodyConv =
    body && typeof body === "object" && typeof body.conversation_id === "string" && body.conversation_id.trim()
      ? body.conversation_id.trim()
      : null;
  // A fresh UUID per request makes every turn look like a brand-new conversation,
  // which is exactly the pattern the gateway's abuse heuristic keys on. Reuse one
  // id for the whole session instead; fall back to a random id only when no
  // session signal exists at all.
  let sessionConv = null;
  if (!incomingConv && !bodyConv) {
    try {
      const sessionId = resolveSessionId({ headers: incoming, body, connectionId: credentials?.connectionId, scope: "codebuddy" });
      sessionConv = sessionId ? uuidV5Like(`codebuddy:${sessionId}`) : null;
    } catch {
      sessionConv = null;
    }
  }
  headers["X-Conversation-ID"] = incomingConv || bodyConv || sessionConv || randomUUID();
  headers["X-Conversation-Request-ID"] = hex16();
  headers["X-Conversation-Message-ID"] = randomUUID().replace(/-/g, "");
  headers["X-Request-ID"] = randomUUID().replace(/-/g, "");

  // Identity headers from the OAuth JWT (OAuth mode only). API-key mode has no
  // JWT to decode, so these are skipped — matching the official plugin.
  const token = credentials?.accessToken || credentials?.apiKey || "";
  const payload = decodeJwtPayload(token);
  if (payload) {
    const userId = pickFirst(
      payload.sub,
      payload.user_id,
      payload.userId,
      payload.uid,
      payload.id,
      credentials?.providerSpecificData?.userId
    );
    if (userId) headers["X-User-Id"] = userId;
    const tenant = pickFirst(
      payload.tenant_id,
      payload.tenantId,
      typeof payload.iss === "string" ? payload.iss : null,
      credentials?.providerSpecificData?.tenantId
    );
    if (tenant) headers["X-Tenant-Id"] = tenant;
    const enterprise = pickFirst(
      payload.enterprise_id,
      payload.enterpriseId,
      credentials?.providerSpecificData?.enterpriseId
    );
    if (enterprise) headers["X-Enterprise-Id"] = enterprise;
  } else if (credentials?.providerSpecificData?.userId) {
    headers["X-User-Id"] = credentials.providerSpecificData.userId;
  }

  return headers;
}

/**
 * Human-readable message for the 11128 "conversation id missing" variant.
 *
 * The raw gateway envelope names no cause, so this used to surface as an opaque
 * 400 nobody could act on. 11128 is overloaded (it also carries "first message is
 * not system prompt", a body-shape fault), so callers must match the message —
 * never the code alone — before using this.
 *
 * @param {object} data - parsed upstream envelope ({ displayTips, displayMsg })
 */
export function codeBuddyChannelVerificationMessage(data) {
  const tip = data?.displayTips?.en || data?.displayMsg?.en || "";
  return (
    'CodeBuddy channel verification failed (11128 "conversation id missing"): the upstream gateway '
    + "requires the X-Conversation-* header family the official IDE sends. "
    + "buildCodeBuddyHeaders() supplies it — if this appears, the gate likely changed shape "
    + "(e.g. a newly required header) and that family in "
    + "open-sse/executors/codebuddyHeaders.js needs re-measuring against the live gateway."
    + (tip ? ` Upstream said: ${tip}` : "")
  );
}

export default buildCodeBuddyHeaders;

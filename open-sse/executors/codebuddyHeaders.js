import { randomUUID, createHash } from "node:crypto";
import { resolveSessionId } from "../utils/sessionManager.js";

/**
 * Deterministic UUID-shaped id for a stable string key.
 *
 * The gateway expects the conversation id to look like a UUID; deriving it from
 * the session key keeps it identical across turns without any server-side state.
 */
function uuidV5Like(key) {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
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
  const userAgent = builtHeaders?.["User-Agent"] || builtHeaders?.["user-agent"] || credentials?.rawHeaders?.["user-agent"];
  const version = versionFromUserAgent(userAgent);
  if (version) headers["X-IDE-Version"] = version;

  // Conversation family: reuse the caller's affinity when present so prompt
  // cache stays warm across turns; otherwise derive a stable id for this
  // conversation (fixes 11128).
  const incoming = credentials?.rawHeaders || {};
  const incomingConv =
    incoming["x-conversation-id"] || incoming["X-Conversation-ID"] ||
    builtHeaders?.["X-Conversation-ID"] || builtHeaders?.["x-conversation-id"] || null;
  const bodyConv =
    body && typeof body === "object" && typeof body.conversation_id === "string"
      ? body.conversation_id
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

export default buildCodeBuddyHeaders;

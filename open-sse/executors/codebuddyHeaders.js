import { randomUUID } from "node:crypto";

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
 * Build the official-client headers for one chat request.
 * @param {object} opts
 * @param {string} opts.domain - "copilot.tencent.com" (CN) or "www.codebuddy.ai" (intl)
 * @param {object} opts.credentials - executor credentials ({ accessToken, apiKey, rawHeaders, providerSpecificData })
 * @param {object} [opts.body] - transformed OpenAI body (for conversation affinity via body.conversation_id)
 */
export function buildCodeBuddyHeaders({ domain, credentials, body }) {
  const headers = {};

  if (domain) headers["X-Domain"] = domain;
  headers["X-Agent-Intent"] = "craft";

  // X-IDE-Version must match the registry User-Agent (<Product>/<Version>).
  // CN sends "CLI/2.108.1", intl sends "IDE/2.108.1" — both are 2.108.1.
  headers["X-IDE-Version"] = "2.108.1";

  // Conversation family: reuse the caller's affinity when present so prompt
  // cache stays warm across turns; otherwise mint fresh ids (fixes 11128).
  const incoming = credentials?.rawHeaders || {};
  const incomingConv =
    incoming["x-conversation-id"] || incoming["X-Conversation-ID"] || null;
  const bodyConv =
    body && typeof body === "object" && typeof body.conversation_id === "string"
      ? body.conversation_id
      : null;
  headers["X-Conversation-ID"] = incomingConv || bodyConv || randomUUID();
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

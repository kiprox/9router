import { getProxyPoolById } from "@/models";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

// ─── Proxy pool rate-limit cooldown (in-memory) ────────────────────
// Upstream free tiers rate-limit per egress IP (e.g. opencode FreeUsageLimitError:
// `Rate limit exceeded. Please try again later.` with no reset timestamp).
// markPoolRateLimited() parks that pool until cooldownMs elapses so later
// requests skip it instead of burning the per-request rotation on a dead IP.
// `ponytail:` opencode resets its free windows at 6/12/24h, so a fixed short
// cooldown just re-probes a dead IP forever. Strategy:
//   1. Honor upstream `retry-after` when present (clamped 5m..24h).
//   2. Otherwise escalate per consecutive 429: 5m → 10m → 20m → ... → 6h cap
//      (earliest reset window; probes after that are cheap 429s).
//   3. clearPoolRateLimit() on a successful request resets the pool.
const poolCooldowns = new Map(); // poolId → cooldownUntilMs
const poolFailCounts = new Map(); // poolId → consecutive 429 count (escalation)

export const POOL_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;          // base / minimum
export const POOL_RATE_LIMIT_MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000; // escalation cap
const POOL_RATE_LIMIT_EXPLICIT_MAX_MS = 24 * 60 * 60 * 1000;       // clamp for upstream retry-after

/**
 * Park a pool after an upstream rate limit (429).
 * @param {string} poolId
 * @param {number|null} cooldownMs - explicit duration (e.g. parsed retry-after); null → escalate
 * @returns {number} parked milliseconds actually applied
 */
export function markPoolRateLimited(poolId, cooldownMs = null) {
  if (!poolId) return 0;
  const n = (poolFailCounts.get(poolId) || 0) + 1;
  poolFailCounts.set(poolId, n);
  let ms;
  if (typeof cooldownMs === "number" && Number.isFinite(cooldownMs) && cooldownMs > 0) {
    ms = Math.min(Math.max(cooldownMs, POOL_RATE_LIMIT_COOLDOWN_MS), POOL_RATE_LIMIT_EXPLICIT_MAX_MS);
  } else {
    ms = Math.min(POOL_RATE_LIMIT_COOLDOWN_MS * 2 ** (n - 1), POOL_RATE_LIMIT_MAX_COOLDOWN_MS);
  }
  poolCooldowns.set(poolId, Date.now() + ms);
  return ms;
}

/** A successful request through this pool proves it works again — reset escalation. */
export function clearPoolRateLimit(poolId) {
  if (!poolId) return;
  poolCooldowns.delete(poolId);
  poolFailCounts.delete(poolId);
}

/** @returns {number|null} absolute ms epoch until the pool is released, or null if not parked */
export function getPoolCooldownUntil(poolId) {
  if (!poolId) return null;
  const until = poolCooldowns.get(poolId);
  if (!until) return null;
  if (until <= Date.now()) {
    poolCooldowns.delete(poolId);
    return null;
  }
  return until;
}

export function isPoolCoolingDown(poolId) {
  return getPoolCooldownUntil(poolId) !== null;
}

/** Parse a `retry-after` header (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(headerValue) {
  const raw = headerValue === null || headerValue === undefined ? "" : String(headerValue).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return dateMs - Date.now();
  return null;
}

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "round-robin") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % poolIds.length;
    rotateState.set(providerId, state);
    return poolIds[state.index];
  }

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  return poolIds[0]; // "none" or unknown
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    // A strict pool must keep its guarantee even when the pool itself is not
    // usable (inactive, or saved without a url). Otherwise the unusable-pool
    // path below reports strictProxy:false and the request silently leaves
    // over the direct IP — the leak strict mode exists to prevent (#4333).
    let poolStrictProxy = false;

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      poolStrictProxy = proxyPool?.strictProxy === true;

      if (isValidPool) {
        /**
         * Vercel/Cloudflare/Deno/Netlify relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify") {
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            strictProxy: proxyPool.strictProxy === true,

            vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
          };
        }

        /**
         * Standard proxy pool
         */
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,

          strictProxy: proxyPool.strictProxy === true,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        strictProxy: poolStrictProxy,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      strictProxy: poolStrictProxy,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}

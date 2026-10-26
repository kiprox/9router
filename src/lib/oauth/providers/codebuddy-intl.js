import { CODEBUDDY_INTL_CONFIG } from "../constants/oauth.js";
import { getJwtExpiresInSeconds, extractCodeBuddyAccountInfo } from "../providerHelpers.js";

// CodeBuddy International — mirrors codebuddy-cn flow against the .ai domain.
const codebuddyIntl = {
  config: CODEBUDDY_INTL_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(`${config.stateUrl}?platform=${config.platform}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-Product": "SaaS",
      },
      body: "{}",
    });
    if (!response.ok) throw new Error(`CodeBuddy Intl state request failed: ${await response.text()}`);
    const data = await response.json();
    if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
      throw new Error(`CodeBuddy Intl state error: ${data.msg || "missing state/authUrl"}`);
    }
    return {
      device_code: data.data.state,
      verification_uri: data.data.authUrl,
      user_code: "",
      interval: config.pollInterval / 1000,
      _isCodeBuddy: true,
    };
  },
  pollToken: async (config, deviceCode) => {
    const response = await fetch(`${config.tokenUrl}?state=${encodeURIComponent(deviceCode)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
        "X-Product": "SaaS",
      },
    });
    if (!response.ok) return { ok: false, data: { error: "request_failed" } };
    const data = await response.json();
    if (data.code === 0 && data.data?.accessToken) {
      return {
        ok: true,
        data: {
          access_token: data.data.accessToken,
          refresh_token: data.data.refreshToken || "",
          token_type: data.data.tokenType || "Bearer",
          expires_in: data.data.expiresIn,
        },
      };
    }
    if (data.code === 11217) return { ok: true, data: { error: "authorization_pending" } };
    return { ok: false, data: { error: data.msg || "unknown_error" } };
  },
  mapTokens: (tokens) => {
    // The .ai gateway exposes no userinfo endpoint on the polling path, so the
    // access-token JWT is the only identity source at login time. Without the
    // email, createProviderConnection's email-based dedup cannot fire and every
    // re-login appends a new "Account N" row instead of rotating tokens.
    const account = extractCodeBuddyAccountInfo(tokens.access_token);
    // Dedup requires a non-empty email. When the JWT carries no email claim
    // (enterprise SSO realms, CN phone-only accounts) fall back to a stable
    // synthetic key derived from the user id, so re-logins still update the
    // existing row — same approach as qoder/kimchi. `sub` is the CodeBuddy user
    // id, NOT an email, so it must never be used as the email directly.
    const email = account.email || (account.userId ? `codebuddy-user-${account.userId}` : undefined);
    const mapped = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      // Same JWT-`exp` derivation as codebuddy-cn: the .ai gateway also omits
      // expires_in, so a fixed 24h guess would either churn the refresh token or
      // miss the real expiry.
      expiresIn: tokens.expires_in || getJwtExpiresInSeconds(tokens.access_token) || 86400,
      // Persist the upstream token type: the refresh path can hand back a
      // different value than the initial grant, and the dashboard surfaces it.
      tokenType: tokens.token_type || "Bearer",
    };
    // Only persist identity when the JWT actually carried it — an empty
    // providerSpecificData would just add noise to the stored row.
    if (account.userId) mapped.providerSpecificData = { userId: account.userId };
    if (email) mapped.email = email;
    if (account.displayName) mapped.displayName = account.displayName;
    return mapped;
  },
};

export default codebuddyIntl;

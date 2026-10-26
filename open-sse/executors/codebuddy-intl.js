import { DefaultExecutor } from "./default.js";
import { buildCodeBuddyHeaders, codeBuddyChannelVerificationMessage } from "./codebuddyHeaders.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    return transformed;
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    // Same 11128 channel-verification enforcement as CN (see codebuddy-cn.js).
    Object.assign(
      headers,
      buildCodeBuddyHeaders({ domain: "www.codebuddy.ai", credentials, body, headers })
    );
    return headers;
  }

  // Reactive refresh: same gap/behaviour as codebuddy-cn (see that file) — the
  // inherited DefaultExecutor refresher map has no CodeBuddy entry, so 401/403
  // must be handled here or the connection never recovers after token expiry.
  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("codebuddy-intl", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("codebuddy-intl", credentials);
  }

  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        // 11140 = the ACCOUNT is flagged ("Your account has been restricted due
        // to unusual activity"), unlike 11128 which is a per-request channel
        // check. Surface the human-readable displayMsg so error classification
        // can park the connection for hours instead of re-probing it every few
        // seconds, and report it as 403 so clients see an auth-style refusal
        // rather than a malformed request.
        const restrictedText = data?.displayMsg?.en || data?.displayMsg?.id || "";
        if (data?.code === 11140 || /account has been restricted|account restricted/i.test(restrictedText)) {
          return {
            status: 403,
            message: restrictedText || msg || "Account restricted",
          };
        }
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }
        // 11128 is overloaded: it carries both channel verification
        // ("conversation id missing") and a body-shape fault ("first message is
        // not system prompt"). Only the former is a header-family problem, so
        // branch on the message — never on the code alone.
        if (data?.code === 11128 && /conversation id missing/i.test(msg)) {
          return {
            status: 400,
            message: codeBuddyChannelVerificationMessage(data),
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;

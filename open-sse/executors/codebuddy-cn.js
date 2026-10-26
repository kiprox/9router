import { DefaultExecutor } from "./default.js";
import { buildCodeBuddyHeaders } from "./codebuddyHeaders.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";

/**
 * CodeBuddyExecutor — talks to https://copilot.tencent.com/v2/chat/completions
 *
 * CodeBuddy is OpenAI-compatible but rejects non-stream chat requests
 * (HTTP 400, code 11101 "Non-stream chat request is currently not supported").
 * The same-format (openai→openai) translator path leaves body.stream as the
 * client sent it, so we force it true here — 9router still re-aggregates the
 * SSE into a JSON response for non-streaming clients.
 */
export class CodeBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-cn");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    // Tencent's content filter flags CLI agent system prompts ("You are Claude
    // Code, Anthropic's official CLI...") as prompt injection / sensitive content
    // and rejects the whole request. Detect agent system prompts (length catch-all
    // + identity-marker regex) and replace them with a neutral one, while leaving
    // legitimate user system prompts untouched. content may be a string or typed
    // blocks ([{type:"text",text}]) depending on the incoming client format, so
    // flatten before matching and preserve the original shape on replacement.
    const NEUTRAL_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";
    const AGENT_PATTERN = /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i;
    const flatten = (content) =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
          : "";
    if (Array.isArray(transformed.messages)) {
      transformed.messages = transformed.messages.map((message) => {
        if (!message || message.role !== "system") return message;
        const text = flatten(message.content);
        if (!text) return message;
        if (text.length > 2000 || AGENT_PATTERN.test(text)) {
          return typeof message.content === "string"
            ? { ...message, content: NEUTRAL_PROMPT }
            : { ...message, content: [{ type: "text", text: NEUTRAL_PROMPT }] };
        }
        return message;
      });
    }

    // CodeBuddy only surfaces model reasoning when the request carries the CLI's
    // OpenAI-style params: reasoning_effort + reasoning_summary:"auto". 9router's
    // thinking pipeline sets reasoning_effort only when the client asks, and never
    // sets reasoning_summary — so reasoning never shows. Mirror the CLI here.
    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort; // gateway has no "none" — just omit
    } else if (eff) {
      // Client explicitly asked for reasoning — mirror the CLI's reasoning_summary
      // so CodeBuddy surfaces the model's reasoning.
      transformed.reasoning_summary = "auto";
    }
    // No reasoning requested: leave both unset. Forcing reasoning_effort:"medium"
    // + reasoning_summary on plain requests makes CodeBuddy trip its content
    // filter and return an error (#2071).
    return transformed;
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    // Gateway now enforces code 11128 "conversation id missing" + channel
    // verification ("not sent from an official client"). Mirror the CLI's
    // conversation family + identity headers (see codebuddyHeaders.js).
    Object.assign(
      headers,
      buildCodeBuddyHeaders({ domain: "copilot.tencent.com", credentials, body, headers })
    );
    return headers;
  }

  // Reactive refresh: chatCore calls this on 401/403 and replays the request.
  // Without the override CodeBuddy inherited DefaultExecutor's refresher map,
  // which has no CodeBuddy entry — so an expired/revoked access token could
  // never be recovered and the connection stayed dead until a manual re-login.
  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("codebuddy-cn", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("codebuddy-cn", credentials);
  }

  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        // 11140 = account-level restriction (see codebuddy-intl.js). Surface the
        // human-readable text so classification can park the connection instead
        // of retrying a flagged account on the short backoff ladder.
        const restrictedText = data?.displayMsg?.en || data?.displayMsg?.id || "";
        if (data?.code === 11140 || /account has been restricted|account restricted|账号.*限制/i.test(restrictedText)) {
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
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyExecutor;

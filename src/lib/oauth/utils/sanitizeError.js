/**
 * Sanitize sensitive information from OAuth error responses
 * Prevents tokens, secrets, and PII from leaking in error messages
 */

const SENSITIVE_KEYWORDS = [
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "secret",
  "client_secret",
  "code",
  "auth",
  "authorization",
  "bearer",
  "password",
  "credential",
];

const SENSITIVE_PATTERNS = [
  /"refresh_token"\s*[:=]\s*"[^"]*"/gi,
  /"access_token"\s*[:=]\s*"[^"]*"/gi,
  /"id_token"\s*[:=]\s*"[^"]*"/gi,
  /"client_secret"\s*[:=]\s*"[^"]*"/gi,
  /"code"\s*[:=]\s*"[^"]*"/gi,
  /authorization\s*[:=]\s*Bearer\s+[^\s]+/gi,
  /"token_type"\s*[:=]\s*"[^"]*"/gi,
];

/**
 * Redact sensitive tokens from a string
 * @param {string} text - Raw text that may contain sensitive data
 * @returns {string} - Text with tokens replaced with [REDACTED]
 */
export function sanitizeErrorMessage(text) {
  if (!text) return text;
  if (typeof text !== "string") return String(text);

  let sanitized = text;

  // Apply pattern-based redaction
  // eslint-disable-next-line no-unused-vars
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      // Try to preserve the key name but hide the value
      const keyMatch = match.match(/([^:=\s]+)(\s*[:=]\s*)/);
      if (keyMatch) {
        return `${keyMatch[1]}${keyMatch[2]}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }

  return sanitized;
}

/**
 * Extract a safe error message from a response, redacting any sensitive data.
 * Reads response body as text and sanitizes it.
 * @param {Response} response - Fetch Response object
 * @returns {Promise<string>} - Sanitized error text
 */
export async function safeErrorText(response) {
  if (!response) return "Unknown error";

  try {
    const contentType = response.headers?.get("content-type") || "";
    let errorText;

    if (contentType.includes("application/json")) {
      // Clone to avoid consuming the body
      const cloned = response.clone();
      try {
        const json = await cloned.json();
        // Sanitize JSON values that might contain sensitive data
        const safeObj = {};
        for (const [key, value] of Object.entries(json)) {
          const lowerKey = key.toLowerCase();
          const isSensitive = SENSITIVE_KEYWORDS.some((kw) => lowerKey.includes(kw));
          if (isSensitive && typeof value === "string" && value.length > 0) {
            safeObj[key] = "[REDACTED]";
          } else {
            safeObj[key] = value;
          }
        }
        errorText = JSON.stringify(safeObj, null, 2);
      } catch {
        // Fallback to text if JSON parsing fails
        const text = await cloned.text();
        errorText = sanitizeErrorMessage(text.substring(0, 2000));
      }
    } else {
      const text = await response.clone().text();
      errorText = sanitizeErrorMessage(text.substring(0, 2000));
    }

    return errorText || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * Create a safe error message for throwing.
 * Wraps the original message in a sanitized form.
 * @param {string} prefix - Error prefix (e.g., "Token exchange failed")
 * @param {string|Error} rawError - Raw error or text that might contain sensitive data
 * @returns {Error} - Error with sanitized message
 */
export function createSafeError(prefix, rawError) {
  let message;
  if (rawError instanceof Error) {
    message = rawError.message;
  } else {
    message = String(rawError);
  }

  const sanitized = sanitizeErrorMessage(message);
  return new Error(`${prefix}: ${sanitized}`);
}

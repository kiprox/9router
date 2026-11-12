// The Intl gateway wants exactly one system message at index 0 and rejects the
// request (11128 "first message is not system prompt") when it is missing. This
// fork anchors that message with the identity proven against the live gate and
// folds the caller's own prompts in behind it, so neither is dropped. Agent
// identity strings (Claude Code, Cursor, …) are separately neutralized: Tencent's
// WAF treats them as unauthorized tooling and bans the account.
import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

const ANCHOR = "You are CodeBuddy Code.";

describe("CodeBuddyIntlExecutor system prompt & agent sanitization", () => {
  const exec = new CodeBuddyIntlExecutor();

  it("forwards user custom system prompt when provided", () => {
    const out = exec.transformRequest(
      "deepseek-v4.1-flash",
      {
        messages: [
          { role: "system", content: "You are a professional translator." },
          { role: "user", content: "Translate this text." },
        ],
      },
      false,
      {}
    );

    expect(out.messages[0]).toEqual({
      role: "system",
      content: `${ANCHOR}\n\nYou are a professional translator.`,
    });
    expect(out.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Translate this text." }],
    });
  });

  it("folds several client system/developer messages into the one leading prompt", () => {
    const out = exec.transformRequest(
      "deepseek-v4.1-flash",
      {
        messages: [
          { role: "system", content: "Rule one." },
          { role: "developer", content: [{ type: "text", text: "Rule two." }] },
          { role: "user", content: "Hello" },
        ],
      },
      false,
      {}
    );

    expect(out.messages[0]).toEqual({
      role: "system",
      content: `${ANCHOR}\n\nRule one.\n\nRule two.`,
    });
    expect(out.messages).toHaveLength(2);
  });

  it("falls back to default system prompt when omitted by client", () => {
    const out = exec.transformRequest(
      "deepseek-v4.1-flash",
      {
        messages: [{ role: "user", content: "Hello" }],
      },
      false,
      {}
    );

    expect(out.messages[0]).toEqual({
      role: "system",
      content: ANCHOR,
    });
    expect(out.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    });
  });

  it("neutralizes sensitive third-party agent identity to prevent WAF rejection", () => {
    const out = exec.transformRequest(
      "deepseek-v4.1-flash",
      {
        messages: [
          {
            role: "system",
            content: "You are Claude Code, Anthropic's official CLI for coding.",
          },
          { role: "user", content: "Fix this bug" },
        ],
      },
      false,
      {}
    );

    expect(out.messages[0]).toEqual({
      role: "system",
      content: `${ANCHOR}\n\nYou are a helpful AI assistant that helps with software engineering tasks.`,
    });
    expect(out.messages[0].content).not.toMatch(/claude code/i);
    expect(out.messages[0].content).not.toMatch(/anthropic/i);
  });
});

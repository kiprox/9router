// codebuddy-intl parity with codebuddy-cn.
//
// Both lanes sit on the same gateway (identical /v2/chat/completions contract,
// same catalog, same reasoning_effort shape — only the domain and the
// CLI-vs-IDE identity headers differ). Three things had drifted apart, each
// silent at runtime:
//
//  1. transformRequest REPLACED the message array with a fixed system prompt, so
//     every instruction the client sent (language, tone, output format) was
//     dropped before the request left 9router.
//  2. PROVIDER_CAPABILITIES had no "codebuddy-intl" entry, so capabilities fell
//     through to the VENDOR patterns (*glm-5.2* -> zai, *deepseek* -> deepseek).
//     That reported vision:false for models the gateway serves images on — and
//     chatCore strips what it thinks a model cannot see, so images vanished —
//     and gave the picker the binary none|thinking set, where "thinking" emitted
//     no reasoning_effort at all.
//  3. The registry model list was never re-synced with CN's 2026-09-30 catalog.
import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel, PROVIDER_CAPABILITIES } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

const CREDS = { accessToken: "x", connectionId: "conn-intl" };
const executor = new CodeBuddyIntlExecutor();

const transform = (messages) =>
  executor.transformRequest("glm-5.2", { model: "glm-5.2", stream: true, messages }, true, CREDS);

// Runs the real pipeline: translate (which applies thinking) then the executor.
const wire = (model) => {
  const req = { model, messages: [{ role: "user", content: "hi" }], stream: true };
  const translated = translateRequest("openai", "openai", model, req, true, CREDS, "codebuddy-intl");
  return executor.transformRequest(model, translated, true, CREDS);
};

const CN_MODELS = PROVIDER_MODELS.cbcn.map((m) => m.id);

describe("codebuddy-intl: caller system prompt survives", () => {
  it("folds the caller's prompt into the required leading system message", () => {
    const out = transform([
      { role: "system", content: "Always answer in Bahasa Indonesia. Be terse." },
      { role: "user", content: "halo" },
    ]);
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toContain("Always answer in Bahasa Indonesia");
    // The gateway demands exactly one system message, at index 0.
    expect(out.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("still opens with the official identity the gate was verified against", () => {
    const out = transform([{ role: "user", content: "hi" }]);
    expect(out.messages[0]).toEqual({ role: "system", content: "You are CodeBuddy Code." });
  });

  it("merges typed-block system content too", () => {
    const out = transform([
      { role: "system", content: [{ type: "text", text: "Rule A" }, { type: "text", text: "Rule B" }] },
      { role: "user", content: "hi" },
    ]);
    expect(out.messages[0].content).toContain("Rule A");
    expect(out.messages[0].content).toContain("Rule B");
  });

  it("folds developer messages in instead of dropping them", () => {
    const out = transform([
      { role: "developer", content: "dev rule" },
      { role: "user", content: "hi" },
    ]);
    expect(out.messages[0].content).toContain("dev rule");
    expect(out.messages.some((m) => m.role === "developer")).toBe(false);
  });

  it("keeps user content as typed blocks (11101 shape requirement)", () => {
    const out = transform([{ role: "user", content: "hi" }]);
    expect(out.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
  });

  it("forces stream (the gateway rejects non-stream requests)", () => {
    const out = executor.transformRequest("glm-5.2", { model: "glm-5.2", stream: false, messages: [] }, false, CREDS);
    expect(out.stream).toBe(true);
  });
});

describe("codebuddy-intl: capabilities match the CN gateway", () => {
  it("shares every CN model's capability entry verbatim", () => {
    for (const model of CN_MODELS) {
      expect(getCapabilitiesForModel("codebuddy-intl", model), model)
        .toEqual(getCapabilitiesForModel("codebuddy-cn", model));
    }
  });

  it("does not share the CN table by reference (intl-only ids must not leak)", () => {
    expect(PROVIDER_CAPABILITIES["codebuddy-intl"]).not.toBe(PROVIDER_CAPABILITIES["codebuddy-cn"]);
    expect(PROVIDER_CAPABILITIES["codebuddy-intl"]["glm-5.0-turbo"]).toBeDefined();
    expect(PROVIDER_CAPABILITIES["codebuddy-cn"]["glm-5.0-turbo"]).toBeUndefined();
  });

  it("keeps images for vision models instead of stripping them", () => {
    const withImage = () => ({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      }],
    });
    const body = withImage();
    stripUnsupportedModalities(body, "openai", getCapabilitiesForModel("codebuddy-intl", "glm-5.2"));
    expect(body.messages[0].content.map((b) => b.type)).toContain("image_url");
  });

  it("advertises OpenAI-style effort levels, not the vendor's binary toggle", () => {
    for (const model of CN_MODELS) {
      const levels = getThinkingLevels("codebuddy-intl", model);
      expect(levels, model).toEqual(getThinkingLevels("codebuddy-cn", model));
      // "thinking" is the zai on/off token — never a valid effort here.
      expect(levels, model).not.toContain("thinking");
    }
  });

  it("sends the picked effort upstream", () => {
    const out = wire("glm-5.2(high)");
    expect(out.reasoning_effort).toBe("high");
    expect(out.reasoning_summary).toBe("auto");
  });

  it("emits no reasoning fields when the client asks for none (#2071)", () => {
    const out = wire("glm-5.2");
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning_summary).toBeUndefined();
  });
});

describe("codebuddy-intl: catalog covers the CN list", () => {
  it("exposes every model CN publishes", () => {
    const intl = PROVIDER_MODELS.cbai.map((m) => m.id);
    expect(CN_MODELS.filter((m) => !intl.includes(m))).toEqual([]);
  });
});

// Cline's /api/v1/models stopped listing `cline-pass/*` ids entirely (verified:
// 0 matches in a 468-entry catalog), so resolveClinepassModels() always fell back
// to the static registry list — which still held ids Cline retired on 2026-09-21
// (glm-5.2, kimi-k2.6, kimi-k2.7-code, deepseek-v4-flash) and which therefore 404.
//
// The live source is the recommended-models feed's `clinePass[]` tier.

import { describe, it, expect, vi, afterEach } from "vitest";

const MODELS_URL = "https://api.cline.bot/api/v1/models";
const FEED_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";

const jsonResponse = (obj, ok = true) => ({
  ok,
  status: ok ? 200 : 503,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

async function resolveWith(routes) {
  vi.stubGlobal("fetch", vi.fn(async (url) => routes[String(url)] ?? jsonResponse({}, false)));
  const { resolveClinepassModels } = await import("../../open-sse/services/clinepassModels.js");
  return resolveClinepassModels({ accessToken: "test-token" });
}

afterEach(() => vi.unstubAllGlobals());

describe("resolveClinepassModels live catalog", () => {
  it("reads the feed's clinePass tier", async () => {
    const result = await resolveWith({
      [FEED_URL]: jsonResponse({
        free: [{ id: "cline-free/gemini-3.8-flash" }],
        clinePass: [
          { id: "cline-pass/glm-5.3", name: "GLM-5.3" },
          { id: "cline-pass/kimi-k3", name: "Kimi K3" },
        ],
      }),
      [MODELS_URL]: jsonResponse([{ id: "z-ai/glm-5.3" }]),
    });

    expect(result.models).toEqual([
      { id: "cline-pass/glm-5.3", name: "GLM-5.3" },
      { id: "cline-pass/kimi-k3", name: "Kimi K3" },
    ]);
  });

  it("ignores non cline-pass ids in the tier", async () => {
    const result = await resolveWith({
      [FEED_URL]: jsonResponse({
        clinePass: [{ id: "cline-pass/glm-5.3" }, { id: "z-ai/glm-5.3" }],
      }),
      [MODELS_URL]: jsonResponse([]),
    });

    expect(result.models.map((m) => m.id)).toEqual(["cline-pass/glm-5.3"]);
  });

  it("falls back to /models when the feed is down", async () => {
    const result = await resolveWith({
      [MODELS_URL]: jsonResponse([
        { id: "cline-pass/glm-5.3", name: "GLM-5.3" },
        { id: "z-ai/glm-5.3" },
      ]),
    });

    expect(result.models.map((m) => m.id)).toEqual(["cline-pass/glm-5.3"]);
  });

  it("returns null when neither source has a cline-pass model", async () => {
    const result = await resolveWith({
      [FEED_URL]: jsonResponse({ clinePass: [] }),
      [MODELS_URL]: jsonResponse([{ id: "z-ai/glm-5.3" }]),
    });

    expect(result).toBeNull();
  });
});

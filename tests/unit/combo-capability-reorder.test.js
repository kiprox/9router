// reorderByCapabilities() must float a capability-capable member to the front
// without dropping anyone. It reads the HARD_CAPS set (input modalities); a
// trimmed merge once deleted that declaration while keeping its uses, so every
// combo that needed a capability died with
// `ReferenceError: HARD_CAPS is not defined` on the production chunk — a path no
// existing test exercised, because they all passed an empty requirement set.
import { describe, expect, it } from "vitest";
import { reorderByCapabilities } from "../../open-sse/services/combo.js";

const MODELS = ["anthropic/claude-sonnet-4-5", "google/gemini-2.5-pro", "deepseek/deepseek-chat"];

describe("reorderByCapabilities", () => {
  it("returns the input untouched when nothing is required", () => {
    expect(reorderByCapabilities(MODELS, new Set())).toBe(MODELS);
  });

  it("evaluates hard capabilities instead of throwing", () => {
    // Would throw ReferenceError before the HARD_CAPS declaration was restored.
    expect(() => reorderByCapabilities(MODELS, new Set(["vision"]))).not.toThrow();
  });

  it("never drops a member, whatever the requirement", () => {
    for (const required of [new Set(["vision"]), new Set(["pdf"]), new Set(["vision", "pdf", "search"])]) {
      const reordered = reorderByCapabilities(MODELS, required);
      expect([...reordered].sort()).toEqual([...MODELS].sort());
    }
  });

  it("classifies a soft-only requirement as tier-1 rather than no-fit", () => {
    // "search" is not a hard capability, so a model that lacks it still lands in
    // tier 1 (usable) instead of tier 2 — the tiers must stay distinguishable.
    const reordered = reorderByCapabilities(MODELS, new Set(["search"]));
    expect(reordered).toHaveLength(MODELS.length);
    expect(reordered[0]).toBe(MODELS[0]);
  });
});
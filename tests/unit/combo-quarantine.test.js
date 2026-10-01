// Combo-member quarantine: a combo model that fails is skipped on subsequent
// requests until its cooldown expires (half-open probe); success clears it and
// consecutive failures escalate the cooldown.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleComboChat,
  resetComboQuarantine,
  getComboQuarantineState,
} from "../../open-sse/services/combo.js";
import { QUARANTINE_CONFIG } from "../../open-sse/config/comboConfig.js";

const COMBO = "quarantine-test-combo";
const log = { info: () => {}, warn: () => {}, debug: () => {} };

const originalConfig = { ...QUARANTINE_CONFIG };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function okResponse() {
  return new Response(JSON.stringify({ choices: [] }), { status: 200 });
}

function makeHarness({ a, b }) {
  const calls = [];
  const handleSingleModel = async (_body, model) => {
    calls.push(model);
    const fn = model === "A" ? a : b;
    return fn();
  };
  return { calls, handleSingleModel };
}

function run(harness, quarantine = true) {
  return handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models: ["A", "B"],
    handleSingleModel: harness.handleSingleModel,
    log,
    comboName: COMBO,
    comboStrategy: "fallback",
    quarantine,
  });
}

beforeEach(() => {
  resetComboQuarantine();
  Object.assign(QUARANTINE_CONFIG, { baseCooldownMs: 30, maxCooldownMs: 10_000, maxLevel: 3 });
});

afterEach(() => {
  resetComboQuarantine();
  Object.assign(QUARANTINE_CONFIG, originalConfig);
});

describe("combo quarantine", () => {
  it("skips the failing model on the next request", async () => {
    Object.assign(QUARANTINE_CONFIG, { baseCooldownMs: 5000 });
    const harness = makeHarness({
      a: () => { throw new Error("upstream down"); },
      b: () => okResponse(),
    });

    const res1 = await run(harness);
    expect(res1.ok).toBe(true);
    expect(harness.calls).toEqual(["A", "B"]);

    harness.calls.length = 0;
    const res2 = await run(harness);
    expect(res2.ok).toBe(true);
    expect(harness.calls).toEqual(["B"]);
    expect(getComboQuarantineState()[COMBO]).toHaveProperty("A");
  });

  it("clears quarantine after a successful probe", async () => {
    let aFails = true;
    const harness = makeHarness({
      a: () => { if (aFails) throw new Error("down"); return okResponse(); },
      b: () => okResponse(),
    });

    await run(harness); // A fails → B serves
    await sleep(40);    // cooldown (30ms) expires → A eligible again

    harness.calls.length = 0;
    aFails = false;
    const res = await run(harness); // probe A → success
    expect(res.ok).toBe(true);
    expect(harness.calls).toEqual(["A"]);
    expect(getComboQuarantineState()[COMBO]).toBeUndefined();

    harness.calls.length = 0;
    await run(harness);
    expect(harness.calls).toEqual(["A"]); // healthy A leads again
  });

  it("escalates the cooldown while failures are consecutive", async () => {
    const harness = makeHarness({
      a: () => { throw new Error("down"); },
      b: () => okResponse(),
    });

    await run(harness); // level 1 → 30ms
    await sleep(40);    // expired → probe
    harness.calls.length = 0;
    await run(harness); // A probed first, fails again → level 2 → 60ms
    expect(harness.calls[0]).toBe("A");

    await sleep(20);    // 20ms < 60ms → still cooling
    harness.calls.length = 0;
    await run(harness);
    expect(harness.calls).toEqual(["B"]);
  });

  it("probes the earliest-expiring member when every model is cooling", async () => {
    Object.assign(QUARANTINE_CONFIG, { baseCooldownMs: 5000 });
    const harness = makeHarness({
      a: () => { throw new Error("down"); },
      b: () => { throw new Error("down too"); },
    });

    const res1 = await run(harness);
    expect(res1.ok).toBe(false); // 503-ish: nothing served

    harness.calls.length = 0;
    const res2 = await run(harness); // must probe, not fail without trying
    expect(harness.calls.length).toBeGreaterThan(0);
    expect(res2.ok).toBe(false);
    expect(harness.calls[0]).toBe("A"); // A expired first
  });

  it("does not quarantine for a request-scoped 400", async () => {
    const harness = makeHarness({
      a: () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }),
      b: () => okResponse(),
    });

    const res1 = await run(harness);
    expect(res1.status).toBe(400); // no fallback for request-scoped errors

    harness.calls.length = 0;
    await run(harness);
    expect(harness.calls).toEqual(["A"]); // not skipped next time
    expect(getComboQuarantineState()[COMBO]).toBeUndefined();
  });

  it("keeps the old behavior when quarantine is disabled", async () => {
    const harness = makeHarness({
      a: () => { throw new Error("down"); },
      b: () => okResponse(),
    });

    await run(harness, false);
    harness.calls.length = 0;
    await run(harness, false);
    expect(harness.calls).toEqual(["A", "B"]);
    expect(getComboQuarantineState()[COMBO]).toBeUndefined();
  });

  it("resetComboQuarantine clears the combo's entries", async () => {
    Object.assign(QUARANTINE_CONFIG, { baseCooldownMs: 5000 });
    const harness = makeHarness({
      a: () => { throw new Error("down"); },
      b: () => okResponse(),
    });
    await run(harness);
    expect(getComboQuarantineState()[COMBO]).toHaveProperty("A");

    resetComboQuarantine(COMBO);
    expect(getComboQuarantineState()[COMBO]).toBeUndefined();
  });
});

// Combo-level model quarantine (auto-skip a combo member that keeps failing
// until its cooldown expires; a success clears it). Scope: "fallback" and
// "round-robin" strategies — fusion panels drop failures per-request already.
export const QUARANTINE_CONFIG = {
  // First cooldown after a fallback-worthy failure (ms).
  baseCooldownMs: 30 * 1000,
  // Hard cap for escalated cooldowns (ms).
  maxCooldownMs: 15 * 60 * 1000,
  // Escalation cap: consecutive-failure level is clamped here.
  maxLevel: 5,
};

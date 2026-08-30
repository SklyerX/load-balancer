import type { BackendConfig } from "./config.ts";

/**
 * mulberry32 — small, fast, seedable. Deterministic seeding matters here:
 * a failing balancer run can be replayed exactly with the same SEED.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential sample, used for time-to-failure. */
export function expSample(rng: () => number, meanMs: number): number {
  return -Math.log(1 - rng()) * meanMs;
}

export type Outcome =
  | { kind: "ok"; delayMs: number }
  | { kind: "error"; delayMs: number }
  | { kind: "timeout" }
  | { kind: "reset"; delayMs: number };

export type ChaosLevel = "off" | "normal" | "storm";

/** Failure rates are multiplied by this, latency is not. */
const LEVEL_MULTIPLIER: Record<ChaosLevel, number> = {
  off: 0,
  normal: 1,
  storm: 4,
};

/**
 * Decides what happens to a single request. `inFlight` is the number of
 * requests already being served, including this one.
 */
export function rollOutcome(
  cfg: BackendConfig,
  rng: () => number,
  inFlight: number,
  level: ChaosLevel,
): Outcome {
  const mult = LEVEL_MULTIPLIER[level];

  let delayMs =
    cfg.baseLatencyMs +
    rng() * cfg.jitterMs +
    Math.max(0, inFlight - 1) * cfg.queuePenaltyMs;

  if (rng() < cfg.slowTailRate * Math.max(mult, 1)) {
    delayMs *= cfg.slowTailFactor;
  }

  if (mult > 0) {
    if (rng() < cfg.timeoutRate * mult) return { kind: "timeout" };
    if (rng() < cfg.resetRate * mult) {
      // Reset partway through, so the client sees a truncated response.
      return { kind: "reset", delayMs: delayMs * rng() };
    }
    if (rng() < cfg.errorRate * mult) return { kind: "error", delayMs };
  }

  return { kind: "ok", delayMs: Math.round(delayMs) };
}

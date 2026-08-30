export type BackendConfig = {
  /** Stable identity reported to the load balancer. */
  id: string;
  port: number;
  region: string;
  /** Concurrent in-flight requests the backend accepts before shedding load. */
  maxConcurrency: number;
  /** Floor of the service-time distribution, in ms. */
  baseLatencyMs: number;
  /** Uniform jitter added on top of the base latency, in ms. */
  jitterMs: number;
  /**
   * Extra ms of latency per in-flight request. This is what makes a
   * least-connections balancer observable: a backend that is handed too much
   * work visibly slows down instead of silently absorbing it.
   */
  queuePenaltyMs: number;
  /** Probability a served request fails outright (500). */
  errorRate: number;
  /** Probability a served request hangs until the client gives up. */
  timeoutRate: number;
  /** Probability the socket is destroyed mid-flight (ECONNRESET). */
  resetRate: number;
  /** Probability a request lands in the slow tail (p99-style spike). */
  slowTailRate: number;
  /** Multiplier applied to latency when a request hits the slow tail. */
  slowTailFactor: number;
  /** Mean seconds of uptime before the process-level crash roll succeeds. */
  meanTimeToFailureSec: number;
  /** How long a crashed backend stays down before it revives, in seconds. */
  downtimeSec: number;
};

export type HarnessConfig = {
  lbUrl: string;
  jwtSecret: string;
  controlPort: number;
  heartbeatMs: number;
  /** Master switch: with chaos off, backends only vary in latency. */
  chaos: boolean;
  /** Seed for the PRNG. Same seed => same failure sequence. */
  seed: number;
  backends: BackendConfig[];
};

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

const REGION = process.env.REGION ?? "NAE";

/**
 * Four backends with deliberately different personalities, so a
 * least-connections balancer has something to actually distinguish:
 *
 *   3001 workhorse  fast, roomy, boring
 *   3002 tiny       fast but sheds load almost immediately
 *   3003 sluggish   plenty of capacity, terrible latency
 *   3004 flaky      good on paper, dies constantly
 */
export const config: HarnessConfig = {
  lbUrl: process.env.LB_URL ?? "http://localhost:8888",
  jwtSecret: process.env.JWT_SECRET ?? "test",
  controlPort: envNum("CONTROL_PORT", 9999),
  heartbeatMs: envNum("HEARTBEAT_MS", 2000),
  chaos: envBool("CHAOS", true),
  seed: envNum("SEED", 1337),
  backends: [
    {
      id: `${REGION}-1`,
      port: 3001,
      region: REGION,
      maxConcurrency: 5,
      baseLatencyMs: 40,
      jitterMs: 60,
      queuePenaltyMs: 25,
      errorRate: 0.02,
      timeoutRate: 0.01,
      resetRate: 0.005,
      slowTailRate: 0.03,
      slowTailFactor: 8,
      meanTimeToFailureSec: 180,
      downtimeSec: 12,
    },
    {
      id: `${REGION}-2`,
      port: 3002,
      region: REGION,
      maxConcurrency: 2,
      baseLatencyMs: 30,
      jitterMs: 40,
      queuePenaltyMs: 60,
      errorRate: 0.03,
      timeoutRate: 0.01,
      resetRate: 0.01,
      slowTailRate: 0.05,
      slowTailFactor: 10,
      meanTimeToFailureSec: 120,
      downtimeSec: 8,
    },
    {
      id: `${REGION}-3`,
      port: 3003,
      region: REGION,
      maxConcurrency: 8,
      baseLatencyMs: 400,
      jitterMs: 300,
      queuePenaltyMs: 120,
      errorRate: 0.05,
      timeoutRate: 0.03,
      resetRate: 0.01,
      slowTailRate: 0.08,
      slowTailFactor: 6,
      meanTimeToFailureSec: 240,
      downtimeSec: 20,
    },
    {
      id: `${REGION}-4`,
      port: 3004,
      region: REGION,
      maxConcurrency: 10,
      baseLatencyMs: 80,
      jitterMs: 120,
      queuePenaltyMs: 15,
      errorRate: 0.12,
      timeoutRate: 0.06,
      resetRate: 0.04,
      slowTailRate: 0.1,
      slowTailFactor: 12,
      meanTimeToFailureSec: 45,
      downtimeSec: 15,
    },
  ],
};

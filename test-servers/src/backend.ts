import http from "http";
import type { Socket } from "net";
import { sign } from "jsonwebtoken";
import type { BackendConfig, HarnessConfig } from "./config.ts";
import { createRng, expSample, rollOutcome, type ChaosLevel } from "./chaos.ts";

export type BackendState = "up" | "draining" | "down";

export type BackendSnapshot = {
  id: string;
  port: number;
  state: BackendState;
  inFlight: number;
  peakInFlight: number;
  maxConcurrency: number;
  served: number;
  errors: number;
  timeouts: number;
  resets: number;
  rejected: number;
  crashes: number;
  avgLatencyMs: number;
};

const now = () => Date.now();

export class Backend {
  readonly cfg: BackendConfig;
  private readonly harness: HarnessConfig;
  private readonly rng: () => number;

  private server: http.Server | null = null;
  private sockets = new Set<Socket>();
  private timers = new Set<NodeJS.Timeout>();
  private crashTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  state: BackendState = "down";
  private inFlight = 0;
  private peakInFlight = 0;
  private served = 0;
  private errors = 0;
  private timeouts = 0;
  private resets = 0;
  private rejected = 0;
  private crashes = 0;
  private latencyTotalMs = 0;

  /** Set by the control plane; `off` disables failures for every backend. */
  chaosLevel: ChaosLevel;

  constructor(cfg: BackendConfig, harness: HarnessConfig) {
    this.cfg = cfg;
    this.harness = harness;
    this.chaosLevel = harness.chaos ? "normal" : "off";
    // Per-backend stream so one backend's traffic doesn't shift another's rolls.
    this.rng = createRng(harness.seed + cfg.port);
  }

  get url(): string {
    return `http://localhost:${this.cfg.port}`;
  }

  snapshot(): BackendSnapshot {
    return {
      id: this.cfg.id,
      port: this.cfg.port,
      state: this.state,
      inFlight: this.inFlight,
      peakInFlight: this.peakInFlight,
      maxConcurrency: this.cfg.maxConcurrency,
      served: this.served,
      errors: this.errors,
      timeouts: this.timeouts,
      resets: this.resets,
      rejected: this.rejected,
      crashes: this.crashes,
      avgLatencyMs: this.served ? Math.round(this.latencyTotalMs / this.served) : 0,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.server) return;

    const server = http.createServer((req, res) => this.handle(req, res));
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.cfg.port, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.state = "up";
    this.log(`up (max ${this.cfg.maxConcurrency} concurrent)`);

    await this.register();
    this.startHeartbeat();
    this.scheduleCrash();
  }

  /**
   * Simulates a hard process failure: deregister, cut every live socket, stop
   * listening. Requests already in flight are lost, which is the point.
   */
  async crash(reason = "chaos"): Promise<void> {
    if (this.state === "down") return;
    this.crashes++;
    this.log(`CRASH (${reason}) with ${this.inFlight} in flight`);
    await this.teardown();
    this.state = "down";

    const downtimeMs = this.cfg.downtimeSec * 1000;
    this.track(
      setTimeout(() => {
        void this.start().catch((err) =>
          this.log(`revive failed: ${(err as Error).message}`),
        );
      }, downtimeMs),
    );
  }

  /** Stop accepting new work but let in-flight requests finish. */
  async drain(): Promise<void> {
    if (this.state !== "up") return;
    this.state = "draining";
    this.log(`draining (${this.inFlight} in flight)`);
    await this.deregister();
  }

  async stop(): Promise<void> {
    await this.teardown();
    this.state = "down";
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private async teardown(): Promise<void> {
    await this.deregister();

    if (this.crashTimer) clearTimeout(this.crashTimer);
    this.crashTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;

    const server = this.server;
    this.server = null;
    if (!server) return;

    // Destroying the sockets fires `close` on every in-flight response, and
    // those handlers do the decrementing — zeroing the counter here as well
    // would double-count and drive it negative.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private scheduleCrash(): void {
    if (this.chaosLevel === "off") return;
    const mean = this.cfg.meanTimeToFailureSec * 1000;
    const scale = this.chaosLevel === "storm" ? 0.25 : 1;
    const delay = expSample(this.rng, mean * scale);
    this.crashTimer = setTimeout(() => void this.crash(), delay);
    this.crashTimer.unref?.();
  }

  private track(t: NodeJS.Timeout): void {
    this.timers.add(t);
  }

  // ----------------------------------------------------------------- requests

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? "/";

    // Health and stats are control-plane traffic: never delayed, never failed,
    // never counted against capacity. A balancer polling health should not be
    // the thing that pushes a backend over its limit.
    if (url.startsWith("/health")) return this.respondHealth(res);
    if (url.startsWith("/stats")) return this.respondStats(res);

    if (this.state !== "up") {
      this.rejected++;
      return this.respondJson(res, 503, { error: "draining" }, { "Retry-After": "5" });
    }

    // Load shedding. Deterministic, not chaos: this is the backend telling the
    // balancer it was handed more than it agreed to take.
    if (this.inFlight >= this.cfg.maxConcurrency) {
      this.rejected++;
      this.log(`shed load (${this.inFlight}/${this.cfg.maxConcurrency})`);
      return this.respondJson(
        res,
        503,
        {
          error: "over_capacity",
          in_flight: this.inFlight,
          max_concurrency: this.cfg.maxConcurrency,
        },
        { "Retry-After": "1" },
      );
    }

    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    const startedAt = now();
    let settled = false;

    const finish = (recordLatency = false) => {
      if (settled) return;
      settled = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      // Only requests that actually got a response contribute to the latency
      // average. A black-holed or crash-killed request would otherwise record
      // the client's give-up time and swamp the number.
      if (recordLatency) this.latencyTotalMs += now() - startedAt;
    };

    // Covers the client hanging up mid-request, which the timeout case relies on.
    res.on("close", finish);

    const outcome = rollOutcome(this.cfg, this.rng, this.inFlight, this.chaosLevel);

    if (outcome.kind === "timeout") {
      this.timeouts++;
      this.log(`black-holing request (timeout sim)`);
      // Deliberately never respond. The socket stays open until the balancer's
      // own timeout fires — that is what is being tested.
      return;
    }

    const timer: NodeJS.Timeout = setTimeout(() => {
      this.timers.delete(timer);
      if (res.writableEnded || res.destroyed) return;

      if (outcome.kind === "reset") {
        this.resets++;
        this.log(`resetting connection mid-flight`);
        res.socket?.destroy();
        finish();
        return;
      }

      if (outcome.kind === "error") {
        this.errors++;
        this.served++;
        this.respondJson(res, 500, { error: "internal_error", id: this.cfg.id });
        finish(true);
        return;
      }

      this.served++;
      this.respondJson(res, 200, {
        id: this.cfg.id,
        port: this.cfg.port,
        region: this.cfg.region,
        path: url,
        latency_ms: Math.round(outcome.delayMs),
        in_flight: this.inFlight,
      });
      finish(true);
    }, Math.round(outcome.delayMs));

    this.track(timer);
  }

  private respondHealth(res: http.ServerResponse): void {
    const healthy = this.state === "up";
    const saturated = this.inFlight >= this.cfg.maxConcurrency;
    this.respondJson(res, healthy && !saturated ? 200 : 503, {
      status: !healthy ? this.state : saturated ? "saturated" : "ok",
      id: this.cfg.id,
      in_flight: this.inFlight,
      max_concurrency: this.cfg.maxConcurrency,
    });
  }

  private respondStats(res: http.ServerResponse): void {
    this.respondJson(res, 200, this.snapshot());
  }

  private respondJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): void {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, {
      "Content-Type": "application/json",
      // Surfaced on every response so the balancer's view of load can be
      // diffed against the backend's own count.
      "X-Backend-Id": this.cfg.id,
      "X-Backend-Port": String(this.cfg.port),
      "X-In-Flight": String(this.inFlight),
      ...extraHeaders,
    });
    res.end(JSON.stringify(body));
  }

  // -------------------------------------------------------------- lb protocol

  private token(): string {
    return sign(
      {
        id: this.cfg.id,
        url: this.url,
        region: this.cfg.region,
        capabilities: {
          maximum_threshold: this.cfg.maxConcurrency,
        },
      },
      this.harness.jwtSecret,
    );
  }

  /** Retries with backoff, because the balancer may not be up yet. */
  private async register(attempt = 0): Promise<void> {
    const ok = await this.callLb("/register", "POST", {
      id: this.cfg.id,
      url: this.url,
      region: this.cfg.region,
      max_concurrency: this.cfg.maxConcurrency,
    });

    if (ok) {
      this.log(`registered with ${this.harness.lbUrl}`);
      return;
    }

    if (this.state === "down" || attempt >= 5) {
      this.log(`registration failed, giving up after ${attempt + 1} attempts`);
      return;
    }

    const backoff = Math.min(500 * 2 ** attempt, 8000);
    this.track(setTimeout(() => void this.register(attempt + 1), backoff));
  }

  private async deregister(): Promise<void> {
    await this.callLb("/deregister", "POST", { id: this.cfg.id, url: this.url });
  }

  private startHeartbeat(): void {
    if (this.harness.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      void this.callLb("/heartbeat", "POST", {
        id: this.cfg.id,
        url: this.url,
        in_flight: this.inFlight,
        max_concurrency: this.cfg.maxConcurrency,
        state: this.state,
      });
    }, this.harness.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  /**
   * Every call is best-effort: an absent or unhappy balancer must not take the
   * backends down with it.
   */
  private async callLb(
    path: string,
    method: string,
    body: unknown,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${this.harness.lbUrl}${path}`, {
        method,
        headers: {
          Authorization: this.token(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private log(msg: string): void {
    console.log(`[${this.cfg.id}:${this.cfg.port}] ${msg}`);
  }
}

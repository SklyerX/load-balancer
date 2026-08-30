export type RegistrationDTO = {
  id: string;
  url: string;
  region: string;
  capabilities: {
    maximum_threshold: number;
    tags?: string[];
  };
};

type BackendStatus = "flagged" | "evicted" | "healthy";

export type Backend = RegistrationDTO & {
  activeConnections: number;
  consecutiveFailures: number;
  status: BackendStatus;
  registeredAt: number;
  lastFailureAt: number | null;
  lastBackpressureAt: number | null;
  lastHeartbeatAt: number | null;
};

const FAILURE_THRESHOLD = 3;
const REQUEST_TIMEOUT_MS = 5000;
const HEALTH_PROBE_INTERVAL_MS = 5000;
const HEALTH_PROBE_TIMEOUT_MS = 2000;

export class Registry {
  private pool = new Map<string, Backend>();

  register(
    input: RegistrationDTO,
  ): { backend: Backend } | { error: "duplicated_id"; existing: Backend } {
    const existing = this.pool.get(input.id);

    if (existing && existing.status === "healthy")
      return { error: "duplicated_id", existing };

    const backend: Backend = {
      ...input,
      activeConnections: 0,
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastBackpressureAt: null,
      lastHeartbeatAt: null,
      registeredAt: Date.now(),
      status: "healthy",
    };

    this.pool.set(input.id, backend);

    return { backend };
  }

  deregister(id: string): Backend | null {
    const existing = this.pool.get(id);

    if (!existing) return null;

    this.pool.delete(id);

    return existing;
  }

  heartbeat(id: string): Backend | null {
    const backend = this.pool.get(id);

    if (!backend) return null;

    backend.lastHeartbeatAt = Date.now();

    return backend;
  }

  pick(required_tag?: string): Backend | null {
    let best: Backend | null = null;
    let best_ratio = Infinity;

    for (const backend of this.pool.values()) {
      if (backend.status !== "healthy") continue;
      if (required_tag && !backend.capabilities.tags?.includes(required_tag))
        continue;

      const ratio =
        backend.activeConnections / backend.capabilities.maximum_threshold;
      if (ratio >= 1) continue;

      if (ratio < best_ratio) {
        best_ratio = ratio;
        best = backend;
      }
    }

    if (best) {
      best.activeConnections++;
    }

    return best;
  }

  release(backend: Backend): void {
    backend.activeConnections = Math.max(0, backend.activeConnections - 1);
  }

  onRequestSuccess(backend: Backend): void {
    backend.consecutiveFailures = 0;
    if (backend.status === "flagged") {
      backend.status = "healthy";
    }
  }

  onRequestBackpressure(backend: Backend): void {
    backend.lastBackpressureAt = Date.now();
  }

  onRequestFailure(backend: Backend): void {
    backend.consecutiveFailures++;
    backend.lastFailureAt = Date.now();

    if (backend.consecutiveFailures >= FAILURE_THRESHOLD) {
      backend.status = "evicted";
    } else {
      backend.status = "flagged";
    }
  }

  onProbeSuccess(backend: Backend): void {
    if (backend.status === "evicted") {
      backend.activeConnections = 0;
    }

    backend.consecutiveFailures = 0;
    backend.status = "healthy";
  }

  getAll(): Backend[] {
    return Array.from(this.pool.values());
  }
}

export const registry = new Registry();
export {
  FAILURE_THRESHOLD,
  REQUEST_TIMEOUT_MS,
  HEALTH_PROBE_INTERVAL_MS,
  HEALTH_PROBE_TIMEOUT_MS,
};

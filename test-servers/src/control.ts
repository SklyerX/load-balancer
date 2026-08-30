import http from "http";
import type { Backend } from "./backend.ts";
import type { ChaosLevel } from "./chaos.ts";

const LEVELS: ChaosLevel[] = ["off", "normal", "storm"];

/**
 * Out-of-band control plane. Lets a test drive the fleet — kill a backend at a
 * known moment, crank up failures, read the fleet's own view of load — without
 * going through the balancer.
 */
export function startControlPlane(backends: Backend[], port: number): http.Server {
  const byPort = (raw: string | undefined) =>
    backends.find((b) => String(b.cfg.port) === raw);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const [section, arg] = url.pathname.split("/").filter(Boolean);

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
    };

    switch (section) {
      case undefined:
      case "stats": {
        const snapshots = backends.map((b) => b.snapshot());
        return json(200, {
          total_in_flight: snapshots.reduce((n, s) => n + s.inFlight, 0),
          total_served: snapshots.reduce((n, s) => n + s.served, 0),
          total_rejected: snapshots.reduce((n, s) => n + s.rejected, 0),
          backends: snapshots,
        });
      }

      case "chaos": {
        const level = url.searchParams.get("level") as ChaosLevel | null;
        if (!level || !LEVELS.includes(level)) {
          return json(400, { error: "level must be one of", levels: LEVELS });
        }
        for (const b of backends) b.chaosLevel = level;
        console.log(`[control] chaos level -> ${level}`);
        return json(200, { chaos: level });
      }

      case "kill": {
        const backend = byPort(arg);
        if (!backend) return json(404, { error: "unknown port", port: arg });
        void backend.crash("control");
        return json(202, { killed: backend.cfg.id, revives_in_sec: backend.cfg.downtimeSec });
      }

      case "drain": {
        const backend = byPort(arg);
        if (!backend) return json(404, { error: "unknown port", port: arg });
        void backend.drain();
        return json(202, { draining: backend.cfg.id });
      }

      case "revive": {
        const backend = byPort(arg);
        if (!backend) return json(404, { error: "unknown port", port: arg });
        void backend.start();
        return json(202, { reviving: backend.cfg.id });
      }

      default:
        return json(404, {
          error: "not found",
          routes: [
            "GET  /stats",
            "POST /chaos?level=off|normal|storm",
            "POST /kill/:port",
            "POST /drain/:port",
            "POST /revive/:port",
          ],
        });
    }
  });

  server.listen(port, () =>
    console.log(`[control] control plane on http://localhost:${port}`),
  );

  return server;
}

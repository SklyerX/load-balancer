import { Backend } from "./src/backend.ts";
import { config } from "./src/config.ts";
import { startControlPlane } from "./src/control.ts";

const backends = config.backends.map((cfg) => new Backend(cfg, config));

for (const backend of backends) {
  await backend.start().catch((err) =>
    console.error(`[${backend.cfg.id}] failed to start: ${(err as Error).message}`),
  );
}

const control = startControlPlane(backends, config.controlPort);

console.log(
  `\nfleet up — lb=${config.lbUrl} chaos=${config.chaos ? "on" : "off"} seed=${config.seed}`,
);
for (const b of backends) {
  console.log(
    `  ${b.cfg.id.padEnd(6)} ${b.url}  max=${b.cfg.maxConcurrency}` +
      `  latency~${b.cfg.baseLatencyMs}-${b.cfg.baseLatencyMs + b.cfg.jitterMs}ms` +
      `  mttf=${b.cfg.meanTimeToFailureSec}s`,
  );
}
console.log("");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[fleet] ${signal} — deregistering and stopping`);
  control.close();
  await Promise.all(backends.map((b) => b.stop()));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

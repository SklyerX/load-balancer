/**
 * Load generator. Points at the balancer (not the backends) and reports how
 * requests actually landed, which is the thing a least-connections claim has to
 * survive: with mixed backend speeds, distribution should track capacity and
 * service time, not be flat round-robin.
 *
 *   bun run loadgen.ts --target http://localhost:8888 --concurrency 20 --requests 500
 */
import { config } from "./src/config.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const target = arg("target", config.lbUrl);
const concurrency = Number(arg("concurrency", "20"));
const total = Number(arg("requests", "500"));
const timeoutMs = Number(arg("timeout", "5000"));

type Result = {
  backend: string;
  status: number | string;
  ms: number;
};

const results: Result[] = [];
let issued = 0;

async function worker(): Promise<void> {
  while (issued < total) {
    issued++;
    const startedAt = performance.now();
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
      await res.arrayBuffer();
      results.push({
        backend: res.headers.get("x-backend-id") ?? "unknown",
        status: res.status,
        ms: performance.now() - startedAt,
      });
    } catch (err) {
      const name = (err as Error).name;
      results.push({
        backend: "none",
        status: name === "TimeoutError" ? "timeout" : "network_error",
        ms: performance.now() - startedAt,
      });
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]!);
}

function tally<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return new Map([...out].sort((a, b) => b[1] - a[1]));
}

console.log(`firing ${total} requests at ${target} (concurrency ${concurrency})\n`);
const startedAt = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsed = (performance.now() - startedAt) / 1000;

const ok = results.filter((r) => r.status === 200);
const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);

console.log(`done in ${elapsed.toFixed(1)}s — ${(total / elapsed).toFixed(1)} req/s\n`);

console.log("distribution across backends");
for (const [backend, n] of tally(results, (r) => r.backend)) {
  const share = ((n / results.length) * 100).toFixed(1);
  console.log(`  ${backend.padEnd(10)} ${String(n).padStart(5)}  ${share.padStart(5)}%`);
}

console.log("\nstatus codes");
for (const [status, n] of tally(results, (r) => String(r.status))) {
  console.log(`  ${status.padEnd(14)} ${String(n).padStart(5)}`);
}

console.log("\nlatency of successful requests (ms)");
console.log(
  `  p50 ${percentile(latencies, 50)}   p90 ${percentile(latencies, 90)}` +
    `   p99 ${percentile(latencies, 99)}   max ${percentile(latencies, 100)}`,
);
console.log(
  `  success rate ${((ok.length / results.length) * 100).toFixed(1)}%` +
    ` (${ok.length}/${results.length})\n`,
);

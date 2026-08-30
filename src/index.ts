import http from "http";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { deploymentSchema, type DeploymentConfig } from "./types/config";
import { verify } from "jsonwebtoken";
import type { RegistrationDTO, Backend } from "./helpers/registry";
import {
  registry,
  REQUEST_TIMEOUT_MS,
  HEALTH_PROBE_INTERVAL_MS,
  HEALTH_PROBE_TIMEOUT_MS,
} from "./helpers/registry";
import http_proxy from "http-proxy";
import { createStream } from "rotating-file-stream";

const deploymentPath = join(process.cwd(), "deployment.yaml");
const rawConfigs = readFileSync(deploymentPath, "utf-8");

const parsedConfigs = parse(rawConfigs) as DeploymentConfig;

deploymentSchema.parse(parsedConfigs);

const MAX_PROXY_ATTEMPTS = 3;

const backendMap = new WeakMap<http.IncomingMessage, Backend>();
const attemptMap = new WeakMap<http.IncomingMessage, number>();

const proxy = http_proxy.createProxyServer();

const stream = createStream(parsedConfigs.deployment.log_file, {
  size: "10M",
  interval: "1d",
  compress: "gzip",
  maxFiles: 14,
});

function releaseBackend(req: http.IncomingMessage) {
  const backend = backendMap.get(req);

  if (!backend) return;

  backendMap.delete(req);
  registry.release(backend);
}

proxy.on("proxyRes", (proxyRes, req) => {
  const backend = backendMap.get(req);

  proxyRes.on("end", () => releaseBackend(req));
  proxyRes.on("close", () => releaseBackend(req));

  if (!backend) {
    stream.write(
      JSON.stringify({
        date: Date.now(),
        log_level: "error",
        title: "No backend found",
        location: "proxyRes backend within req",
      }),
    );
    return;
  }

  if (proxyRes.statusCode === 503) {
    registry.onRequestBackpressure(backend);
    stream.write(
      JSON.stringify({
        date: Date.now(),
        log_level: "warn",
        title: "Backend applied backpressure",
        backend,
        req: { status: proxyRes.statusCode, method: req.method, url: req.url },
      }),
    );
    return;
  }

  if (proxyRes.statusCode && proxyRes.statusCode >= 500) {
    registry.onRequestFailure(backend);
    stream.write(
      JSON.stringify({
        date: Date.now(),
        log_level: "error",
        title: "Proxy response error",
        backend,
        req: { status: proxyRes.statusCode, method: req.method, url: req.url },
      }),
    );
  } else {
    registry.onRequestSuccess(backend);
    stream.write(
      JSON.stringify({
        date: Date.now(),
        level: "info",
        title: "Load balancer resolved successfully",
        backend,
        req: { status: proxyRes.statusCode, method: req.method, url: req.url },
      }),
    );
  }
});

proxy.on("error", (err, req, res) => {
  const backend = backendMap.get(req);
  const response = res as http.ServerResponse;

  if (!backend) {
    stream.write(
      JSON.stringify({
        date: Date.now(),
        log_level: "error",
        title: "Proxy failed",
        message: "No backend found",
        req: { status: req.statusCode, method: req.method, url: req.url },
      }),
    );
    return;
  }

  registry.onRequestFailure(backend);
  releaseBackend(req);

  stream.write(
    JSON.stringify({
      date: Date.now(),
      log_level: "error",
      title: "Proxy failed",
      backend,
      req: { status: req.statusCode, method: req.method, url: req.url },
    }),
  );

  if (response.writableEnded || response.destroyed) return;

  if (response.headersSent) {
    response.end();
    return;
  }

  const attempts = (attemptMap.get(req) ?? 1) + 1;

  if (attempts > MAX_PROXY_ATTEMPTS) {
    stream.write(
      JSON.stringify({
        date: Date.now(),
        log_level: "error",
        title: "Retry limit reached",
        message: `Gave up after ${MAX_PROXY_ATTEMPTS} attempts`,
        req: { status: req.statusCode, method: req.method, url: req.url },
      }),
    );
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "backend error" }));
    return;
  }

  const n_backend = registry.pick();

  if (!n_backend) {
    stream.write(
      JSON.stringify({
        date: Date.now(),
        log_level: "error",
        title: "Failed to fetch a backend for failure state",
        message: "No backend was found to proxy the request to",
        req: { status: req.statusCode, method: req.method, url: req.url },
      }),
    );
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "no healthy backends available" }));
    return;
  }

  attemptMap.set(req, attempts);
  backendMap.set(req, n_backend);

  stream.write(
    JSON.stringify({
      date: Date.now(),
      log_level: "info",
      title: "Attempting a new backend",
      backend: n_backend,
      req: { status: req.statusCode, method: req.method, url: req.url },
    }),
  );

  proxy.web(req, response, {
    target: n_backend.url,
    timeout: REQUEST_TIMEOUT_MS,
    proxyTimeout: REQUEST_TIMEOUT_MS,
  });
});

const server = http.createServer((req, res) => {
  if (req.url === "/register" && req.method === "POST") {
    const registrationData = req.headers["authorization"];

    if (!registrationData || Array.isArray(registrationData)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registration not accepted - 1" }));
      return;
    }

    try {
      const decoded = verify(
        registrationData,
        process.env.BACKEND_JWT_SECRET as string,
      ) as RegistrationDTO;

      const result = registry.register(decoded);
      const isError = "error" in result;

      res.writeHead(isError ? 400 : 200, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(result));

      stream.write(
        JSON.stringify({
          date: Date.now(),
          log_level: isError ? "warn" : "info",
          title: isError ? "Server registrations failed" : "Server registered",
          backend: isError ? null : result.backend,
        }),
      );
    } catch (e) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registration not accepted - 2" }));
      stream.write(
        JSON.stringify({
          date: Date.now(),
          log_level: "warn",
          title: "Registration not accepted",
          message: "JWT Decoding failed.",
          req: { status: req.statusCode, method: req.method, url: req.url },
        }),
      );
    }

    return;
  }

  if (
    (req.url === "/deregister" || req.url === "/heartbeat") &&
    req.method === "POST"
  ) {
    const registrationData = req.headers["authorization"];

    if (!registrationData || Array.isArray(registrationData)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registration not accepted - 1" }));
      return;
    }

    try {
      const decoded = verify(
        registrationData,
        process.env.BACKEND_JWT_SECRET as string,
      ) as RegistrationDTO;

      if (req.url === "/deregister") {
        const removed = registry.deregister(decoded.id);

        res.writeHead(removed ? 200 : 404, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify(
            removed ? { deregistered: decoded.id } : { error: "unknown_id" },
          ),
        );

        stream.write(
          JSON.stringify({
            date: Date.now(),
            log_level: removed ? "info" : "warn",
            title: removed
              ? "Server deregistered"
              : "Deregistration for unknown server",
            backend: removed,
          }),
        );
        return;
      }

      const backend = registry.heartbeat(decoded.id);

      if (!backend) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unknown_id" }));
        stream.write(
          JSON.stringify({
            date: Date.now(),
            log_level: "warn",
            title: "Heartbeat from unknown server",
            message: decoded.id,
          }),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: backend.id,
          status: backend.status,
          activeConnections: backend.activeConnections,
        }),
      );
    } catch (e) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Registration not accepted - 2" }));
      stream.write(
        JSON.stringify({
          date: Date.now(),
          log_level: "warn",
          title: "Registration not accepted",
          message: "JWT Decoding failed.",
          req: { status: req.statusCode, method: req.method, url: req.url },
        }),
      );
    }

    return;
  }

  const backend = registry.pick();

  if (!backend) {
    stream.write(
      JSON.stringify({
        date: Date.now(),
        log_level: "error",
        title: "Failed to fetch a backend",
        message: "No backend was found to proxy the request to",
        req: { status: req.statusCode, method: req.method, url: req.url },
      }),
    );
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no healthy backends available" }));
    return;
  }

  stream.write(
    JSON.stringify({
      date: Date.now(),
      log_level: "info",
      title: "Routing request",
      backend,
      req: { status: req.statusCode, method: req.method, url: req.url },
    }),
  );

  backendMap.set(req, backend);
  attemptMap.set(req, 1);

  res.on("close", () => releaseBackend(req));

  proxy.web(req, res, {
    target: backend.url,
    timeout: REQUEST_TIMEOUT_MS,
    proxyTimeout: REQUEST_TIMEOUT_MS,
  });
});

let probing = false;

async function probeBackends() {
  if (probing) return;

  probing = true;

  await Promise.all(
    registry.getAll().map(async (backend) => {
      const previous_status = backend.status;

      try {
        const probe = await fetch(`${backend.url}/health`, {
          signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
        });

        if (probe.status === 503) return;

        if (probe.ok) {
          registry.onProbeSuccess(backend);
        } else {
          registry.onRequestFailure(backend);
        }
      } catch (e) {
        registry.onRequestFailure(backend);
      }

      if (backend.status !== previous_status) {
        stream.write(
          JSON.stringify({
            date: Date.now(),
            log_level: backend.status === "healthy" ? "info" : "warn",
            title: "Backend health changed",
            message: `${previous_status} -> ${backend.status}`,
            backend,
          }),
        );
      }
    }),
  );

  probing = false;
}

const healthProbe = setInterval(probeBackends, HEALTH_PROBE_INTERVAL_MS);

server.listen(parsedConfigs.deployment.port, () =>
  console.log(
    `Load balancer running at: http://localhost:${parsedConfigs.deployment.port}`,
  ),
);

process.on("SIGINT", () => {
  clearInterval(healthProbe);
  server.close(() => process.exit(0));
});

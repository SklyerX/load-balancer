# load-balancer

An HTTP load balancer that routes requests to backends by weighted least connections, and a fleet of deliberately unreliable backends built to prove it works.

Backends register themselves with a signed token, report a concurrency limit, and get pulled out of rotation when they start failing. A health probe puts them back once they recover. The test fleet registers against that same contract, then gets slower under load, sheds traffic past its limit, and crashes on a seeded schedule so the balancer's failure handling is exercised rather than assumed.

Written in TypeScript, runs on Bun, proxies with http-proxy.

Most of the design here is the second or third answer rather than the first. The [design decisions](#design-decisions) section keeps the rejected version alongside the reason it broke, since the final shape is the easy part to copy and the reasoning behind it is not.

## Why I built this

I wanted to know how a load balancer actually decides where a request goes. Not the diagram version, the version where you have to answer what happens when a backend accepts a TCP connection and then never replies. So I started writing one. Almost everything in here arrived by being wrong first, and the wrong version is usually the more interesting half of the story.

The first design was a single load balancer. All traffic hits it, it works out which region the request belongs to, it routes onward. The flaw took a while to see and then would not go away: that balancer is physically somewhere. A user connects from Tokyo, and the one thing sitting in front of all traffic is in North America. Their request crosses the Pacific so a machine in Toronto can tell them they should have been talking to Tokyo, then sends them back across it. Every request pays for a decision that adds nothing, and no amount of careful backend selection behind that hop recovers the time already spent. I was optimizing the small term while the large one sat untouched in front of it. Whatever that design is, it is not a regional system.

The obvious fix is one deployment per region, each instance knowing only its own backends, which is what I landed on. But that just relocates the question: how does the Tokyo user's request reach the Tokyo instance in the first place, without something global in front deciding it? The honest answer is that it does not happen at this layer at all. It happens in DNS resolving to a different IP depending on where the query came from, in BGP-level anycast routing, in actually having a presence in that region. To do region-based routing properly I would have had to build a replacement for anycast, which is a network-layer project, considerably harder than this one, and a re-solving of something DNS has solved for decades.

So I cut it, and I want to be precise about what got cut, because it was more than anycast. Region-based routing as a feature of this application went with it. There is no correct app-layer version of it, only the wrong version I had already rejected. What is left is a balancer that assumes the request has already arrived at the right regional instance and starts from there. That is why `region` is recorded at registration and never read: it is the seam where the network layer hands off, not an unfinished feature. The cut also deleted cross-region overflow on its own, since an instance with no visibility into other regions cannot route into them, which turns "all of NAE is full" from a routing decision into a capacity-planning one. Scoping down here made the project smaller and more correct at the same time, which is not the usual trade.

The second thing I got wrong was failure detection. My instinct was to skip health checks entirely and track an in-memory connection counter, reasoning that if the balancer itself dies none of that state survives anyway. But a counter tells you how much work a backend is holding, not whether you can reach it. Those look like one idea and are two. A backend that completes the TCP handshake and then hangs forever will sit at a perfectly plausible connection count while serving nothing. Something has to actively notice. What I landed on is a hybrid: failures are detected reactively, from real traffic that failed, and a probe runs on a timer to catch hangs and to find backends that have recovered, since a dead process cannot announce its own return.

At that point I stopped trusting my own reasoning about failure, because I was designing against failures I had imagined rather than ones I had seen. So I built the second half of this repo: four fake backends with deliberately different capacities and speeds, which get slower as they get busier, shed load past their declared limit, return 500s, black-hole requests until the client gives up, destroy sockets mid-response, and hard-crash on a seeded schedule. Then I pointed the balancer at them and watched where requests actually landed. That is where the smaller decisions came from. Splitting 503 from the other 5xx codes, for instance, only matters once you have a backend that sheds load correctly, because counting a deliberate shed as a fault evicts your smallest backend first, which is precisely backwards. Under 80 requests at concurrency 15 against the fleet with faults on, no backend was ever pushed past the limit it declared, and the slowest backend received the fewest requests despite having the second-largest capacity, because slow responses hold connections open and keep its ratio high.

What is deliberately not here is as considered as what is. WebSocket proxying is out of scope because a WebSocket routing decision is made once at the upgrade and then locked in for the life of the connection, which is a second routing mode rather than an extension of this one. Routing a user to their region is not deferred either, it simply is not this program's job, for the reasons above. Pinning an instance to a region, IP-based region inference, and multi-core workers are designed below and genuinely not built yet, and the recovery path has a known flaw: a backend coming back from eviction is immediately eligible for every request, which is the cold-server slam that [graceful failback](#graceful-failback-not-a-hard-cutover) exists to prevent. It is documented rather than hidden because the gap between the design and the code is the honest state of the project, and closing it is the next thing I would do.

## What is built, and what is only designed

The design work below runs ahead of the implementation on purpose. This table is the line between them.

| Decision                                            | State                                                       |
| --------------------------------------------------- | ----------------------------------------------------------- |
| Self-registering backends, dynamic in-memory registry | Built                                                      |
| Least-connections weighted by declared capacity     | Built                                                        |
| Capacity ceiling per backend, 503 when all are full | Built                                                        |
| Reactive failure detection plus recovery probe      | Built                                                        |
| `http-proxy` for the relay layer                    | Built                                                        |
| Backpressure distinguished from failure             | Built                                                        |
| Registration JWT                                    | Built                                                        |
| One deployment per region, region-scoped registry   | Designed. An instance is not pinned to a region yet, and `region` is recorded but never read |
| Routing a user to the right regional instance       | Out of scope by decision. Belongs to GeoDNS and anycast, in front of this program |
| IP-to-region inference and geo-fencing              | Designed only                                                |
| Separate session secret for client auth             | Designed only. There is no client-facing auth yet            |
| Graceful failback on recovery                       | Designed only, and current behavior is the opposite          |
| Multi-core workers over shared state                | Designed only. Runs as a single process                      |
| WebSocket proxying                                  | Out of scope by decision, not missing by accident            |


## The two halves

| Component      | Path            | Role                                                           |
| -------------- | --------------- | -------------------------------------------------------------- |
| The balancer   | `src/`          | Registry, selection, health probe, proxy, logging               |
| The test fleet | `test-servers/` | Four fake backends, a chaos control plane, and a load generator |

They talk over one contract: a backend POSTs a signed JWT to `/register`, heartbeats while it lives, and deregisters when it goes away. Nothing else is shared, so either side can be swapped for a real implementation.

## Running it

Two package roots, installed separately. Start the balancer:

```bash
pnpm install
bun run src/index.ts       # listens on deployment.yaml's port, default 8888
```

Then the fleet, in a second terminal:

```bash
cd test-servers
pnpm install
pnpm dev                   # fleet + control plane, hot reload
pnpm start                 # same, no watcher
pnpm calm                  # CHAOS=0 — latency only, no failures
```

Then push traffic through the balancer, in a third:

```bash
cd test-servers
bun run loadgen.ts --target http://localhost:8888 --concurrency 20 --requests 500
```

Two files configure the balancer. `deployment.yaml` is read at startup and validated with zod, so a malformed file fails immediately instead of at the first request:

| Field                 | Type   | Purpose                        |
| --------------------- | ------ | ------------------------------ |
| `deployment.port`     | number | Port the balancer listens on   |
| `deployment.log_file` | string | Path for the rotating JSON log |

`.env` holds one value, `BACKEND_JWT_SECRET`, the key backends sign their registration tokens with. It has to match the fleet's `JWT_SECRET`.

---

# Design decisions

Most of these started as a different, more naive idea that broke under a specific question. The rejected version and the reason it broke are more useful than the final shape, so both are here.

## Regional deployments, not one global balancer

**Rejected:** a single balancer that all traffic reaches and that then routes to the correct region.

**Why:** one instance is physically in one place. A user in Japan hitting a Toronto balancer to be forwarded to Tokyo has already paid the latency this was supposed to save. Optimizing backend selection while ignoring the cost of reaching the selector is optimizing the wrong term.

**Landed on:** one codebase deployed N times, once per region, configured by region at startup. A NAE deployment only ever knows about NAE backends. Any balancer-to-balancer awareness is static config rather than runtime discovery, because balancer instances are few and non-elastic, unlike backends, so self-registration between them buys nothing and adds spoofing surface.

**Explicitly out of scope:** getting the request to the right regional instance in the first place. That is GeoDNS and anycast, solved at the DNS and BGP layer, and building it would mean building a second and harder project instead of this one.

**Which means region routing itself is out of scope, not deferred.** The only correct place to choose a region is in front of the balancer, at the network layer. The app-layer version, one global instance that receives everything and forwards it onward, is the design rejected above. There is no third option to build later, so `region` is stored at registration and never read: it marks where the handoff happens rather than a feature left half-finished.

**Consequence:** no cross-region overflow. A NAE balancer cannot see JP backends, so a saturated region is an ops problem rather than a routing decision. That shrank the scope in a useful direction.

## Region from IP, not from the JWT

**Rejected:** encoding a home region in the user's token at account creation.

**Why:** location is a property of where someone is connecting from right now, not a property of their account. A JWT carries identity, not geography. Pinning an account created in Toronto to NAE forever means it still routes to NAE when that person is sitting in Tokyo, which is backwards.

**Landed on:** infer region from source IP through a local lookup table, standing in for a downloaded GeoIP database rather than a third-party API call in the hot path. Nobody puts a live geo-lookup on the critical path of every request. The shape allows a real GeoIP database to drop in later.

**Effect:** the two auth concerns separate cleanly instead of one token doing two jobs. The JWT is identity, the IP is geography.

**Second use:** each regional instance can reject traffic that does not belong to its region. A JP deployment receiving an IP that resolves to NAE returns 403 rather than helpfully proxying it. Silently serving cross-region traffic because it happened to arrive is how leaked regional endpoints get used to route around geography.

## Least-connections within region, not sticky sessions

**Rejected:** pinning each user to the same backend, derived from their auth.

**Why:** stickiness solves a problem that exists only when the server itself holds state a rebalance would lose, such as an in-process session, a local cache, or a pinned connection. These backends are stateless and any shared state lives externally. Pinning a user to one box then hurts distribution and buys nothing. Stateless app servers are the norm for exactly this reason, which is what makes horizontal scaling work without caring which box handled the previous request.

**Landed on:** least-connections within the region. Region routing is not stickiness, it is geography, and a Toronto user's request should not cross the Pacific. Within the correct region any backend can serve any request, so least-connections distributes better than pinning ever would.

## Self-registering backends, not static config

**Rejected:** a hardcoded map of backend to region.

**Landed on:** backends register themselves on boot with id, region, and declared capacity, and the balancer keeps a dynamic in-memory registry. This is the right call specifically because backends are numerous and elastic, which is the opposite of the balancer-to-balancer case above, where static config is correct for the same reason inverted.

**What it enables:** a failed backend is marked unavailable and routed around, then rechecked on a timer so it can be restored automatically. A dead backend cannot report its own recovery, so the recheck is not optional.

## Reactive failure detection, not polling alone

**Rejected:** tracking a connection counter and skipping health checks entirely, on the grounds that the balancer's state does not outlive the balancer anyway.

**Why:** a connection count and liveness look like one idea and are two. A counter never self-corrects when a backend hangs after the handshake or dies mid-request.

**Landed on:** a hybrid. Real traffic failures mark a backend down immediately, and a probe runs on a timer to catch hangs and to detect recovery. It is still a health check, it is just mostly driven by actual usage rather than by a polling loop running in isolation from it.

## Graceful failback, not a hard cutover

**The scenario:** backend A dies, backend B absorbs its traffic, A comes back.

**Rejected:** snapping every request back to A the moment it is marked healthy. That recreates the overload that may have killed A, except now against a cold process, and it can strand B if B was scaled only to carry the overflow temporarily.

**Intended:** new requests move to the recovered backend while in-flight work on B drains naturally. Same shape as the capacity decision below, which is one mental model applied twice rather than two special cases.

**Actual current behavior:** not implemented. `onProbeSuccess` restores an evicted backend to healthy and zeroes its connection count, which gives it a ratio of 0, so `pick()` sends it every request until it fills. This is the hard cutover this decision rejects, and it is the largest gap between the design and the code.

## Capacity-aware routing from self-reported thresholds

**Landed on:** backends declare a capacity at registration rather than only identity and region, and the balancer refuses to exceed it. Not full weighted balancing, but putting the field in the registration payload now avoids a schema change later, and it matters because not every deployment is a datacenter that scales evenly. Self-hosted and manually provisioned boxes have real and uneven limits.

**When a backend is full:** try another backend in the same region. Deliberately the same shape as failback, which is not letting one server exhaust itself just because it is the default choice. There is no cross-region overflow, because a regional instance has no cross-region visibility to overflow into.

## Two JWT secrets, not one reused

**Landed on:** a registration secret for backend-to-balancer identity, and a separate session secret for user sessions.

**Why:** these are different trust boundaries with different lifetimes, rotation needs, and blast radii. Collapsing them into one secret conflates two concerns for no benefit. Only the registration secret exists today, since there is no client-facing auth yet.

## A proxy library, not hand-rolled relaying

**Landed on:** `http-proxy` for the byte piping and header rewriting.

**Why:** hand-rolling the wire-level relay is a separate project, the equivalent of writing an HTTP framework before writing the service that sits on it. The differentiating part here is the routing logic, meaning registration, capacity checks, failure detection, and recovery. Using a library for the plumbing is scoping effort toward the part that is actually the point.

## Multi-core workers over one source of truth

**The apparent conflict:** the balancer needs a single source of truth, and it also wants a process per core for throughput. Give each worker its own registry and the workers diverge and answer inconsistently.

**Landed on, not yet built:** separate who decides from what does the work. Workers accept and relay connections in parallel, while the registry, health status, and connection counts live in one shared place they all read and write, whether a coordinator process or IPC to a primary that owns the state. Concurrency and consistency are then separate problems rather than a tradeoff. The current implementation is a single process.

## WebSockets, out of scope on purpose

**Why:** an HTTP routing decision is made per request and every request can independently go anywhere. A WebSocket routing decision is made once at the upgrade and is then fixed for the life of the connection, possibly hours, because there is no routing an individual message once the connection is a raw bidirectional stream. Supporting it properly means a second routing mode of connection-level stickiness alongside this one, plus upgrade detection, plus holding long-lived connections stable across backend failures. That roughly doubles the surface area for a mode that is not what this project is about.

---

# The balancer

## How a backend gets picked

Every candidate is scored by how full it is rather than by raw connection count:

```
ratio = activeConnections / capabilities.maximum_threshold
```

The lowest ratio wins. Backends that are not healthy are skipped, and so is anything already at or above its declared limit, which is what produces a 503 when the whole pool is saturated. Scoring by ratio means a backend that advertised room for 10 absorbs more traffic than one that advertised room for 2, instead of both receiving an even split.

Ties are resolved by registration order, since the comparison is a strict less-than. Under light traffic, when every backend sits at a ratio of zero, the earliest registrant takes most of the requests. The imbalance disappears as soon as concurrency rises and the ratios separate.

`pick()` also accepts an optional tag filter that matches against `capabilities.tags`, though no route passes one yet.

## Registering a backend

A backend POSTs to `/register` with a JWT in the `Authorization` header. The payload it decodes to:

| Field                            | Type     | Notes                                                     |
| -------------------------------- | -------- | --------------------------------------------------------- |
| `id`                             | string   | Unique. A second registration under a live id is rejected |
| `url`                            | string   | Where the balancer proxies to                             |
| `region`                         | string   | Recorded, not used for routing yet                        |
| `capabilities.maximum_threshold` | number   | Concurrent requests the backend accepts                   |
| `capabilities.tags`              | string[] | Optional, for tag filtering                               |

Tokens carry no expiry claim, so one stays valid for as long as the secret does.

Three routes are handled directly. Everything else is proxied to a backend:

| Route         | Method | Effect                                                                    |
| ------------- | ------ | ------------------------------------------------------------------------- |
| `/register`   | POST   | Adds the backend to the pool. Returns 400 if the id is already healthy     |
| `/deregister` | POST   | Removes it. Returns 404 for an unknown id                                 |
| `/heartbeat`  | POST   | Records `lastHeartbeatAt` and returns current status and connection count |

Heartbeats are liveness reporting only. Nothing sweeps backends that stop sending them, because the health probe already covers that case.

The pool lives in memory, so restarting the balancer empties it and every backend has to register again.

## Health and failure accounting

A backend is in one of three states:

| Status    | In rotation | Meaning                         |
| --------- | ----------- | ------------------------------- |
| `healthy` | yes         | Normal                          |
| `flagged` | no          | One or two consecutive failures |
| `evicted` | no          | Three consecutive failures      |

What the balancer does with a backend response depends on its status code:

| Response from backend  | Treated as   | Effect on the backend                            |
| ---------------------- | ------------ | ------------------------------------------------ |
| 503                    | backpressure | Records `lastBackpressureAt`. No failure counted |
| Other 5xx              | failure      | Increments the consecutive failure count         |
| Everything else        | success      | Resets the count, returns `flagged` to `healthy` |
| Proxy error or timeout | failure      | Increments the count, releases the connection    |

Separating 503 from the other 5xx codes matters when backends shed load deliberately. A backend answering 503 because it hit its own concurrency limit is behaving correctly, and counting that as a fault would evict the smallest backend in the pool first.

Every five seconds the balancer GETs `/health` on each backend with a two second timeout:

| Probe result                 | Effect                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| 200                          | Marks healthy, clears the failure count. An evicted backend also has its connection count zeroed |
| 503                          | Read as alive but saturated. No state change                                                    |
| Other status, or no response | Counted as a failure, same threshold as request failures                                        |

This is the only path back from `evicted`, and it runs against healthy backends too, so a process that dies without deregistering leaves rotation on its own.

Zeroing the connection count on recovery has a consequence worth stating plainly: a backend returning from eviction has a ratio of 0, which makes it the winner of every comparison until it fills up. A cold process gets the full arrival rate the instant it is marked healthy. See [graceful failback](#graceful-failback-not-a-hard-cutover) for why that is the wrong behavior and what should replace it.

## Connections, retries, and timeouts

`pick()` increments a backend's connection count, and the count is released when the proxied response ends, when the client response closes, or when the proxy errors. Releasing on response completion rather than on response headers keeps the number accurate for streaming responses, and releasing on error covers clients that hang up early. The release is idempotent, so the three paths can overlap without double counting.

Proxy timeouts are 5000ms in both directions. On a proxy error, if nothing has been written to the client yet, the balancer picks another backend and tries again, up to three attempts, then answers 502. A retry does not replay the request body, so a retried POST can stall until the proxy timeout rather than succeeding on the second backend.

When no backend is available, either because the pool is empty or because everything is saturated or out of rotation, the client gets a 503.

## Logging

Log entries are JSON objects written through rotating-file-stream: 10MB per file, daily rotation, gzip, 14 files kept. Each entry carries a `date`, a `log_level`, a `title`, and usually a snapshot of the backend involved, which makes it possible to replay how a backend's connection count and status moved over time.

Objects are written back to back without newline separators, so a streaming JSON decoder reads the file more easily than a line based tool does.

## Constants

Tunables live in `src/helpers/registry.ts`:

| Constant                   | Value | Controls                             |
| -------------------------- | ----- | ------------------------------------ |
| `FAILURE_THRESHOLD`        | 3     | Consecutive failures before eviction |
| `REQUEST_TIMEOUT_MS`       | 5000  | Proxy timeout in both directions     |
| `HEALTH_PROBE_INTERVAL_MS` | 5000  | Time between probe sweeps            |
| `HEALTH_PROBE_TIMEOUT_MS`  | 2000  | Per probe timeout                    |

`MAX_PROXY_ATTEMPTS`, which caps retries at 3, is in `src/index.ts`.

---

# The test fleet

Four fake backends that register with the balancer, track their own in-flight connections, get slower as they get busier, shed load past their limit, and fail the ways real servers fail: 500s, connection resets, black-holed requests, and hard crashes with downtime.

## The fleet

Deliberately different personalities, so a least-connections balancer has something to actually distinguish:

| Port | Max concurrent | Latency   | Character                                 |
| ---- | -------------- | --------- | ----------------------------------------- |
| 3001 | 5              | 40–100ms  | workhorse — fast, roomy, boring           |
| 3002 | 2              | 30–70ms   | tiny — fast but sheds load almost at once |
| 3003 | 8              | 400–700ms | sluggish — lots of capacity, bad latency  |
| 3004 | 10             | 80–200ms  | flaky — good on paper, dies constantly    |

Every backend adds `queuePenaltyMs` of latency per in-flight request. That is what makes balancing observable: a backend handed too much work visibly slows down instead of silently absorbing it.

## Backend endpoints

- `GET /*` — does simulated work, returns JSON with the serving backend's id and its in-flight count.
- `GET /health` — `200` when healthy, `503` when saturated or draining.
- `GET /stats` — that backend's counters.

Health and stats are never delayed, failed, or counted against capacity — a balancer polling health should not be the thing that pushes a backend over its limit.

Every response carries `X-Backend-Id`, `X-Backend-Port`, and `X-In-Flight`, so the balancer's idea of load can be diffed against the backend's own count.

## Failure modes

Rolled per request against the backend's configured rates:

| Mode          | What the client sees                                                 |
| ------------- | -------------------------------------------------------------------- |
| error         | `500` after the normal delay                                          |
| timeout       | nothing, ever — black-holed until the client gives up                 |
| reset         | socket destroyed mid-flight (`ECONNRESET`)                            |
| slow tail     | a normal `200`, just many times slower (p99 spike)                    |
| over capacity | `503` with `Retry-After` once in-flight hits the limit                |

Separately, each backend rolls an exponential time-to-failure and hard-crashes: deregisters, cuts every live socket, stops listening, then revives after its downtime. In-flight requests are lost, which is the point.

Failures are driven by a seeded PRNG, so the same `SEED` replays the same run and a fix can be verified against the exact traffic that broke it.

## Control plane (`:9999`)

Drive the fleet from a test without going through the balancer:

```bash
curl localhost:9999/stats                       # fleet-wide counters
curl -X POST localhost:9999/kill/3001           # crash a backend now
curl -X POST localhost:9999/revive/3001         # bring it back early
curl -X POST localhost:9999/drain/3001          # deregister, finish in-flight work
curl -X POST "localhost:9999/chaos?level=storm" # off | normal | storm
```

`storm` multiplies every failure rate by 4 and shortens time-to-failure to a quarter. `off` disables failures fleet-wide, leaving only latency.

## Load generator

Points at the balancer, not the backends, and reports how requests actually landed:

```bash
bun run loadgen.ts --target http://localhost:8888 --concurrency 20 --requests 500
```

```
distribution across backends
  NAE-1    45   75.0%
  NAE-3    14   23.3%
  none      1    1.7%

latency of successful requests (ms)
  p50 152   p90 1283   p99 1417   max 1417
  success rate 98.3% (59/60)
```

A backend showing 0% is worth a look: either it was down at the time, or the balancer never picked it.

## Registration, from the backend side

On startup each backend POSTs to `LB_URL/register` with a JWT in the `Authorization` header, signed with `JWT_SECRET`:

```json
{
  "id": "NAE-1",
  "url": "http://localhost:3001",
  "region": "NAE",
  "capabilities": { "maximum_threshold": 5 }
}
```

Registration retries with backoff, so the fleet can start before the balancer does. Two further calls are best-effort — if the balancer doesn't implement them, nothing breaks:

- `POST /heartbeat` every `HEARTBEAT_MS` with current `in_flight` and `state`
- `POST /deregister` on crash, drain, and shutdown

## Environment

| Var            | Default                 | Notes                                  |
| -------------- | ----------------------- | -------------------------------------- |
| `LB_URL`       | `http://localhost:8888` | Where backends register                |
| `JWT_SECRET`   | `test`                  | Signing key for the registration token |
| `REGION`       | `NAE`                   | Region reported to the balancer        |
| `CHAOS`        | `1`                     | `0` disables all failures              |
| `SEED`         | `1337`                  | Same seed replays the same failure run |
| `HEARTBEAT_MS` | `2000`                  | `0` disables heartbeats                |
| `CONTROL_PORT` | `9999`                  | Control plane port                     |

---

# Measured behavior

80 requests at concurrency 15, against the four backends above, with fault injection turned on:

| Backend | Max concurrent | Service time | Requests | Share |
| ------- | -------------- | ------------ | -------- | ----- |
| NAE-2   | 2              | 30 to 70ms   | 26       | 32.5% |
| NAE-4   | 10             | 80 to 200ms  | 24       | 30.0% |
| NAE-1   | 5              | 40 to 100ms  | 18       | 22.5% |
| NAE-3   | 8              | 400 to 700ms | 10       | 12.5% |
| none    |                |              | 2        | 2.5%  |

The slowest backend received the fewest requests despite having the second largest capacity, because slow responses hold connections open and keep its ratio high. Fast backends cycle their connections and come back to the front of the queue.

| Metric                  | Value              |
| ----------------------- | ------------------ |
| Success rate            | 93.8% (75 of 80)   |
| Latency p50 / p90 / p99 | 141 / 927 / 1842ms |
| Throughput              | 18.8 req/s         |

The five non-200 results were three 500s and two timeouts produced by fault injection at the backends, not by the balancer.

No backend was pushed past the limit it declared:

| Backend | Peak connections | Declared limit |
| ------- | ---------------- | -------------- |
| NAE-1   | 4                | 5              |
| NAE-2   | 2                | 2              |
| NAE-3   | 5                | 8              |
| NAE-4   | 5                | 10             |

# Layout

Balancer:

| Path                      | Contents                                                     |
| ------------------------- | ------------------------------------------------------------ |
| `src/index.ts`            | HTTP server, registration routes, proxy wiring, health probe |
| `src/helpers/registry.ts` | Backend pool, selection, status transitions                  |
| `src/types/config.ts`     | zod schema for `deployment.yaml`                             |
| `deployment.yaml`         | Port and log path                                            |

Test fleet, under `test-servers/`:

| Path             | What it does                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `index.ts`       | Boots the fleet, wires up graceful shutdown                        |
| `src/config.ts`  | Backend personalities and env knobs                                |
| `src/chaos.ts`   | Seeded PRNG and the per-request outcome roll                       |
| `src/backend.ts` | One backend: serving, load shedding, crash/revive, LB registration |
| `src/control.ts` | Out-of-band control plane on `:9999`                               |
| `loadgen.ts`     | Fires traffic at the balancer and reports where it landed          |
